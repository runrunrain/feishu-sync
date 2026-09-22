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
  completeConfigInit,
  completeDeviceAuth,
  getLarkCliStatus,
  installLarkCli,
  startConfigInit,
  startDeviceAuth,
  type DeviceAuthStartResult,
  type LarkCliInstallResult,
  type LarkCliToolStatus,
} from '../api/client';

export type DeviceAuthPhase =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'completing'
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
  startAuth: () => Promise<void>;
  /** 取消等待（abort 挂起的 complete 请求，回到 idle；服务端流程自然过期）。 */
  cancelAuth: () => void;
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

  const abortRef = useRef<AbortController | null>(null);
  /** 区分「用户主动取消」与「12 分钟兑底超时」：abort 前置位。 */
  const userCancelledRef = useRef(false);
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
      const userCancelled = configInitCancelledRef.current;
      setConfigInitPhase(userCancelled ? 'idle' : 'failed');
      setConfigInitError(userCancelled ? null : '等待浏览器完成配置超时或中断，请重试');
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
    setConfigInitUrl(null);
    setConfigInitError(null);
    setConfigInitPhase('idle');
  }, []);

  const resetConfigInit = useCallback(() => {
    setConfigInitPhase('idle');
    setConfigInitError(null);
  }, []);

  const waitForCompletion = useCallback(async (deviceCode: string) => {
    setAuthPhase('completing');
    userCancelledRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), COMPLETE_TIMEOUT_MS);
    try {
      const result = await completeDeviceAuth(deviceCode, { signal: controller.signal });
      if (result.ready) {
        setAuthPhase('success');
        setAuthSession(null);
        setAuthError(null);
        await refreshStatus();
        onStatusChangedRef.current?.();
      } else {
        setAuthPhase('failed');
        const missingScopes = result.missingScopes ?? [];
        if (result.ok && missingScopes.length > 0) {
          // 授权流程已完成（用户点了同意、token 已写入）且携带缺失清单——
          // 仅此场景才是「授权页勾选列表未勾全被服务端静默丢弃」（2026-10
          // 实测）。missingScopes 为空的 ready:false（未认证/identity 非 user/
          // 认证检查异常等，见 checkAuthReady 的其它 4 个分支）必须回退
          // result.error，否则「0 项权限未被授予」误导且吞掉真实原因
          // （diting 审查 F1）。
          setAuthError(
            `授权已完成，但本次申请的 ${missingScopes.length} 项权限未被授予（${missingScopes.join('、')}）。`
              + '最常见原因：授权页的权限勾选列表未全部勾选。请点击「重试认证」，'
              + '在打开的授权页中确认所有权限项均已勾选后再点「同意授权」；'
              + '若勾选后仍缺失，多为 lark-cli 应用凭据未发布该权限，可先「更新 lark-cli」再重试。',
          );
        } else {
          setAuthError(
            result.error
              || `授权后仍缺少权限：${missingScopes.join('、') || '未知'}，可重试授权`,
          );
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // 用户取消：回到 idle，不作为失败；兑底超时：给出可重试提示。
        const userCancelled = userCancelledRef.current;
        setAuthPhase(userCancelled ? 'idle' : 'failed');
        setAuthError(userCancelled ? null : '等待浏览器授权超时，请重试');
        setAuthSession(null);
      } else {
        setAuthPhase('failed');
        setAuthError(errorMessage(err, '等待授权确认失败'));
      }
    } finally {
      clearTimeout(timer);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [refreshStatus]);

  const startAuth = useCallback(async () => {
    setAuthPhase('starting');
    setAuthError(null);
    setAuthSession(null);
    try {
      const session = await startDeviceAuth();
      setAuthSession({ ...session, expiresAt: Date.now() + session.expiresIn * 1000 });
      setAuthPhase('waiting');
      // 自动打开浏览器让用户确认；卡片内同时展示可点击 URL 备用。
      openInBrowser(session.verificationUrl);
      void waitForCompletion(session.deviceCode);
    } catch (err) {
      setAuthPhase('failed');
      setAuthError(errorMessage(err, '发起飞书认证失败'));
    }
  }, [waitForCompletion]);

  const cancelAuth = useCallback(() => {
    userCancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setAuthSession(null);
    setAuthError(null);
    setAuthPhase('idle');
  }, []);

  const resetAuth = useCallback(() => {
    setAuthPhase('idle');
    setAuthError(null);
  }, []);

  // 需求「未认证则自动认证」：状态就绪且检测到「已安装 + 未认证」时自动发起
  // device flow（安装完成后的刷新也会走到这里，形成安装→认证连续引导）。
  // 每会话只自动发起一次，失败后转手动重试，避免循环拉起浏览器。
  // 【闭环关键 gate】未配置（not_configured）时不得自动发起 auth login——
  // auth login 在未配置态会被上游拒绝；此时由 configInit 自动引导接手，
  // 配置成功→刷新→本 effect 再接续认证，形成 安装→配置→认证 全链路。
  // 置于 startAuth 声明之后（deps 引用，避免 TDZ）。
  const configInitNeeded = toolStatus?.error?.includes(CONFIG_NEEDED_MARK) ?? false;
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (
      statusLoading
      || autoStartedRef.current
      || authPhase !== 'idle'
      || configInitPhase !== 'idle'
      || !toolStatus
      || toolStatus.larkCliInstalled !== true
      || toolStatus.authReady === true
      || configInitNeeded
    ) {
      return;
    }
    autoStartedRef.current = true;
    void startAuth();
  }, [statusLoading, toolStatus, authPhase, configInitPhase, configInitNeeded, startAuth]);

  // 「已安装 + 未配置」时自动发起 config init（同样每会话一次）。安装
  // 完成后的首次刷新即触发，与 auto-auth 串成连续引导链。
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
    startAuth,
    cancelAuth,
    resetAuth,
  };
}
