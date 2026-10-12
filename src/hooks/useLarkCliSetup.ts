/**
 * Hook for the lark-cli onboarding state machine
 *
 * 新用户引导（需求 §4）：组合 lark-cli 状态查询、一键安装、Device Flow
 * 认证三段流程，驱动 AuthSettingsCard 的引导式 UI。
 *
 * Device Flow 时序：
 *   startDeviceAuth → 拿 verificationUrl → openExternal 自动开浏览器 →
 *   卡片展示可点击 URL（复制备用）+「等待浏览器授权确认…」→ 同时挂起
 *   completeDeviceAuth（AbortController 12 分钟兜底）→ 成功刷新为已就绪。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelConfigInitRemote,
  cancelDeviceAuthRemote,
  completeConfigInit,
  completeDeviceAuth,
  getLarkCliStatus,
  installLarkCli,
  startConfigInit,
  startDeviceAuth,
  type DeviceAuthStartResult,
  type DeviceAuthMode,
  type DeviceAuthCompleteResult,
  type LarkCliInstallResult,
  type LarkCliToolStatus,
} from '../api/client';

export type DeviceAuthPhase =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'completing'
  | 'cancelling'
  | 'success'
  | 'failed';

export type ConfigInitPhase =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'completing'
  | 'success'
  | 'failed';

export interface ActiveDeviceAuthSession extends DeviceAuthStartResult {
  /** 本地计算的过期时刻（ms epoch），等待 UI 据此展示剩余时间。 */
  expiresAt: number;
}

/** 前端等待 complete 的兜底超时：服务端 11 分钟 + 网络余量。 */
const COMPLETE_TIMEOUT_MS = 12 * 60 * 1000;

/** 前端等待 config init complete 的兑底超时：服务端 12 分钟 + 网络余量。 */
const CONFIG_INIT_COMPLETE_TIMEOUT_MS = 13 * 60 * 1000;

/** checkAuthReady 对「已安装但未配置」的文案前缀（服务端规范文案）。 */
const CONFIG_NEEDED_MARK = '尚未完成初始配置';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** desktop bridge 优先（经主进程 http/https 白名单校验），缺席时 window.open。 */
function openInBrowser(url: string): void {
  const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
  if (desktop?.openExternal) {
    void desktop
      .openExternal(url)
      .then((result) => {
        // DesktopActionResult 存在两代形状（electron {ok} / 旧 {success}），
        // 任一成功标志命中即可；失败回退 window.open。
        const ok =
          (result as { ok?: boolean } | null)?.ok === true
          || (result as { success?: boolean } | null)?.success === true;
        if (!ok) window.open(url, '_blank', 'noopener');
      })
      .catch(() => window.open(url, '_blank', 'noopener'));
    return;
  }
  window.open(url, '_blank', 'noopener');
}

export interface UseLarkCliSetupResult {
  toolStatus: LarkCliToolStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  refreshStatus: () => Promise<void>;

  installing: boolean;
  installResult: LarkCliInstallResult | null;
  install: () => Promise<void>;

  /** 已安装但 not_configured：需先走 config init（安装→认证闭环的中间环）。 */
  configInitNeeded: boolean;
  configInitPhase: ConfigInitPhase;
  configInitUrl: string | null;
  configInitError: string | null;
  startConfigInit: () => Promise<void>;
  cancelConfigInit: () => void;
  resetConfigInit: () => void;

  authPhase: DeviceAuthPhase;
  authSession: ActiveDeviceAuthSession | null;
  authError: string | null;
  authMode: DeviceAuthMode;
  authAccount: DeviceAuthCompleteResult['account'] | null;
  startAuth: (mode?: DeviceAuthMode) => Promise<void>;
  /** 服务端停止授权进程后才允许重试。 */
  cancelAuth: () => Promise<void>;
  /** failed → idle，供「重试」前的状态复位。 */
  resetAuth: () => void;
}

export function useLarkCliSetup(
  options: { onStatusChanged?: () => void } = {},
): UseLarkCliSetupResult {
  const [toolStatus, setToolStatus] = useState<LarkCliToolStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<LarkCliInstallResult | null>(null);

  const [configInitPhase, setConfigInitPhase] = useState<ConfigInitPhase>('idle');
  const [configInitUrl, setConfigInitUrl] = useState<string | null>(null);
  const [configInitError, setConfigInitError] = useState<string | null>(null);
  const configInitAbortRef = useRef<AbortController | null>(null);
  const configInitCancelledRef = useRef(false);

  const [authPhase, setAuthPhase] = useState<DeviceAuthPhase>('idle');
  const [authSession, setAuthSession] = useState<ActiveDeviceAuthSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<DeviceAuthMode>('reauthorize');
  const [authAccount, setAuthAccount] = useState<DeviceAuthCompleteResult['account'] | null>(null);
  const authGenerationRef = useRef(0);
  const authStartingRef = useRef(false);
  const authSessionRef = useRef<ActiveDeviceAuthSession | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const onStatusChangedRef = useRef(options.onStatusChanged);
  onStatusChangedRef.current = options.onStatusChanged;

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const status = await getLarkCliStatus();
      setToolStatus(status);
      setStatusError(null);
    } catch (err) {
      setStatusError(errorMessage(err, '检查 lark-cli 状态失败'));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const install = useCallback(async () => {
    setInstalling(true);
    setInstallResult(null);
    try {
      const result = await installLarkCli();
      setInstallResult(result);
      await refreshStatus();
      onStatusChangedRef.current?.();
    } catch (err) {
      setInstallResult({
        ok: false,
        output: errorMessage(err, '安装 lark-cli 失败'),
      });
    } finally {
      setInstalling(false);
    }
  }, [refreshStatus]);

  const waitForConfigInitCompletion = useCallback(async () => {
    setConfigInitPhase('completing');
    configInitCancelledRef.current = false;
    const controller = new AbortController();
    configInitAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), CONFIG_INIT_COMPLETE_TIMEOUT_MS);
    try {
      const result = await completeConfigInit({ signal: controller.signal });
      if (result.ok) {
        setConfigInitPhase('success');
        setConfigInitUrl(null);
        setConfigInitError(null);
        // 刷新后 not_configured 消失 → 状态变为「未认证」→ 自动引导链的
        // auth 分支接手（见下方 auto-bootstrap effect），安装→配置→认证
        // 全链路连续衔接。
        await refreshStatus();
        onStatusChangedRef.current?.();
      } else {
        setConfigInitPhase('failed');
        setConfigInitError(result.error || result.output || '初始化配置失败，请重试');
      }
    } catch (err) {
      // 【diting B-7 修复】APIError 携带服务端结构化 message（如 409
      // config_init_in_progress）时优先展示，不再统一归为「超时或中断」。
      const message = err instanceof Error ? err.message : '';
      const userCancelled = configInitCancelledRef.current;
      setConfigInitPhase(userCancelled ? 'idle' : 'failed');
      setConfigInitError(
        userCancelled
          ? null
          : message || '等待浏览器完成配置超时或中断，请重试',
      );
    } finally {
      clearTimeout(timer);
      if (configInitAbortRef.current === controller) configInitAbortRef.current = null;
    }
  }, [refreshStatus]);

  const handleStartConfigInit = useCallback(async () => {
    setConfigInitPhase('starting');
    setConfigInitError(null);
    setConfigInitUrl(null);
    try {
      const session = await startConfigInit();
      setConfigInitUrl(session.verificationUrl);
      setConfigInitPhase('waiting');
      // 自动打开浏览器；卡片内同时展示可点击 URL 备用（与 device flow 一致）。
      openInBrowser(session.verificationUrl);
      void waitForConfigInitCompletion();
    } catch (err) {
      setConfigInitPhase('failed');
      setConfigInitError(errorMessage(err, '发起 lark-cli 初始化配置失败'));
    }
  }, [waitForConfigInitCompletion]);

  const cancelConfigInit = useCallback(() => {
    configInitCancelledRef.current = true;
    configInitAbortRef.current?.abort();
    configInitAbortRef.current = null;
    // 【diting B-1 修复】仅 abort 本地请求不解除服务端占位：重试会被
    // 409 锁死最长约 12 分钟。同步通知服务端 kill 子进程 + 回收（幂等，
    // 失败静默——服务端已自行超时回收/重启属正常时序）。
    void cancelConfigInitRemote();
    setConfigInitUrl(null);
    setConfigInitError(null);
    setConfigInitPhase('idle');
  }, []);

  const resetConfigInit = useCallback(() => {
    setConfigInitPhase('idle');
    setConfigInitError(null);
  }, []);

  const waitForCompletion = useCallback(async (session: ActiveDeviceAuthSession, generation: number) => {
    setAuthPhase('completing');
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), COMPLETE_TIMEOUT_MS);
    try {
      const result = await completeDeviceAuth(session.deviceCode, { signal: controller.signal });
      if (authGenerationRef.current !== generation) return;
      const accountConfirmed = result.account?.id
        && (session.mode !== 'switch_account' || result.account.id !== session.previousAccount?.id);
      if (result.ok && result.ready && result.verified && accountConfirmed) {
        setAuthPhase('success');
        setAuthAccount(result.account ?? null);
        setAuthSession(null);
        authSessionRef.current = null;
        setAuthError(null);
      } else {
        setAuthPhase('failed');
        setAuthError(result.error || '本次授权未通过账号和权限验证，请重试；若权限被管理员收回，请联系管理员。');
      }
      await refreshStatus();
      onStatusChangedRef.current?.();
    } catch (err) {
      if (authGenerationRef.current !== generation) return;
      if (controller.signal.aborted) {
        try { await cancelDeviceAuthRemote(session.deviceCode); } catch { /* 保留会话供再次取消 */ }
      }
      setAuthPhase('failed');
      setAuthError(controller.signal.aborted ? '等待授权超时，请重试认证' : errorMessage(err, '等待授权确认失败'));
    } finally {
      clearTimeout(timer);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [refreshStatus]);

  const startAuth = useCallback(async (mode: DeviceAuthMode = 'reauthorize') => {
    if (authStartingRef.current) return;
    authStartingRef.current = true;
    const generation = ++authGenerationRef.current;
    abortRef.current?.abort();
    setAuthPhase('starting');
    setAuthMode(mode);
    setAuthAccount(null);
    setAuthError(null);
    try {
      // 超时/请求断开后先结束旧服务端流程，不留下阻止换号的挂起会话。
      if (authSessionRef.current) await cancelDeviceAuthRemote(authSessionRef.current.deviceCode);
      const result = await startDeviceAuth(mode);
      if (authGenerationRef.current !== generation) {
        await cancelDeviceAuthRemote(result.deviceCode);
        return;
      }
      const session = { ...result, expiresAt: Date.now() + result.expiresIn * 1000 };
      authSessionRef.current = session;
      setAuthSession(session);
      setAuthPhase('waiting');
      openInBrowser(session.verificationUrl);
      void waitForCompletion(session, generation);
    } catch (err) {
      if (authGenerationRef.current !== generation) return;
      setAuthPhase('failed');
      setAuthError(errorMessage(err, '发起飞书认证失败'));
    } finally {
      authStartingRef.current = false;
    }
  }, [waitForCompletion]);

  const cancelAuth = useCallback(async () => {
    const session = authSessionRef.current;
    if (!session) return;
    ++authGenerationRef.current;
    setAuthPhase('cancelling');
    abortRef.current?.abort();
    try {
      await cancelDeviceAuthRemote(session.deviceCode);
      authSessionRef.current = null;
      setAuthSession(null);
      setAuthError(null);
      setAuthPhase('idle');
      await refreshStatus();
      onStatusChangedRef.current?.();
    } catch (err) {
      setAuthPhase('failed');
      setAuthError(errorMessage(err, '取消授权失败，请重试'));
    }
  }, [refreshStatus]);

  const resetAuth = useCallback(() => {
    setAuthPhase('idle');
    setAuthError(null);
  }, []);

  // 让用户先选择重新授权或换号，失效状态下不再自动拉起旧账号授权。
  const configInitNeeded = toolStatus?.error?.includes(CONFIG_NEEDED_MARK) ?? false;
  // 「已安装 + 未配置」时自动发起 config init（同样每会话一次）。安装
  // 完成后由用户选择账号并发起认证。
  const autoConfigInitStartedRef = useRef(false);
  useEffect(() => {
    if (
      statusLoading
      || autoConfigInitStartedRef.current
      || configInitPhase !== 'idle'
      || authPhase !== 'idle'
      || !toolStatus
      || toolStatus.larkCliInstalled !== true
      || !configInitNeeded
    ) {
      return;
    }
    autoConfigInitStartedRef.current = true;
    void handleStartConfigInit();
  }, [statusLoading, toolStatus, configInitPhase, authPhase, configInitNeeded, handleStartConfigInit]);

  return {
    toolStatus,
    statusLoading,
    statusError,
    refreshStatus,
    installing,
    installResult,
    install,
    configInitNeeded,
    configInitPhase,
    configInitUrl,
    configInitError,
    startConfigInit: handleStartConfigInit,
    cancelConfigInit,
    resetConfigInit,
    authPhase,
    authSession,
    authError,
    authMode,
    authAccount,
    startAuth,
    cancelAuth,
    resetAuth,
  };
}
