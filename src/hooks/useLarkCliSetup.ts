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
  completeDeviceAuth,
  getLarkCliStatus,
  installLarkCli,
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

export interface ActiveDeviceAuthSession extends DeviceAuthStartResult {
  /** 本地计算的过期时刻（ms epoch），等待 UI 据此展示剩余时间。 */
  expiresAt: number;
}

/** 前端等待 complete 的兜底超时：服务端 11 分钟 + 网络余量。 */
const COMPLETE_TIMEOUT_MS = 12 * 60 * 1000;

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
        setAuthError(
          result.error
            || `授权后仍缺少权限：${result.missingScopes?.join('、') ?? '未知'}，可重试授权`,
        );
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
  // 置于 startAuth 声明之后（deps 引用，避免 TDZ）。
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (
      statusLoading
      || autoStartedRef.current
      || authPhase !== 'idle'
      || !toolStatus
      || toolStatus.larkCliInstalled !== true
      || toolStatus.authReady === true
    ) {
      return;
    }
    autoStartedRef.current = true;
    void startAuth();
  }, [statusLoading, toolStatus, authPhase, startAuth]);

  return {
    toolStatus,
    statusLoading,
    statusError,
    refreshStatus,
    installing,
    installResult,
    install,
    authPhase,
    authSession,
    authError,
    startAuth,
    cancelAuth,
    resetAuth,
  };
}
