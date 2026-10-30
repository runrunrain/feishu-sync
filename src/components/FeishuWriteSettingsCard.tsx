/**
 * FeishuWriteSettingsCard —— 设置页「飞书写入」卡（S13，设计 §7.6）
 *
 *   - feishuWrite.enabled 开关（PUT /api/config，服务端严格校验）
 *   - writeScopesGranted 状态展示（GET /api/feishu/auth-status 增补字段）
 *   - 「授权写入权限」：发起 scopeSet='write' 的 Device Flow（增量申请
 *     docx:document:write_only；复用既有认证 UI 模式——卡片内展示授权
 *     URL + 复制/重新打开 + 等待态 + 取消，授权页需勾选全部权限项）
 *
 * 注意：write 授权是整单重新授权（lark-cli device flow 语义），勾全
 * 全部权限项后既有读权限不受影响。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { writeClipboardText } from '../utils/clipboard';
import {
  CheckCircle,
  Copy,
  Globe,
  KeyRound,
  PenLine,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { Toggle } from './common/Input';
import { useToast } from './common/Toast';
import { useConfig } from '../hooks/useConfig';
import { useSettingsDraft } from '../hooks/settingsDraft';
import { useAuthStatus } from '../hooks/useAuthStatus';
import {
  APIError,
  cancelDeviceAuthRemote,
  completeDeviceAuth,
  startDeviceAuth,
  type DeviceAuthStartResult,
} from '../api/client';

type AuthPhase = 'idle' | 'starting' | 'waiting' | 'completing' | 'cancelling' | 'success' | 'failed';

/** desktop bridge 优先（与 AuthSettingsCard 同法）。 */
function openUrlInBrowser(url: string): void {
  const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
  if (desktop?.openExternal) {
    void desktop
      .openExternal(url)
      .then((result) => {
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

export function FeishuWriteSettingsCard() {
  const toast = useToast();
  const { config, updateConfig } = useConfig();
  const draft = useSettingsDraft();
  const { authStatus, loading: authLoading, refresh } = useAuthStatus(0);

  const [savingToggle, setSavingToggle] = useState(false);
  const [phase, setPhase] = useState<AuthPhase>('idle');
  const [session, setSession] = useState<DeviceAuthStartResult | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const enabled = config?.feishuWrite?.enabled === true;
  const writeGranted = authStatus?.writeScopesGranted === true;
  const authActive = phase === 'starting' || phase === 'waiting' || phase === 'completing' || phase === 'cancelling';

  const handleToggle = async (next: boolean) => {
    setSavingToggle(true);
    try {
      await updateConfig({ feishuWrite: { enabled: next } });
      if (!draft) toast.push({ type: 'success', message: next ? '已开启写回飞书' : '已关闭写回飞书' });
    } catch (err) {
      const message = err instanceof APIError ? err.message : '设置保存失败';
      toast.push({ type: 'error', message });
    } finally {
      setSavingToggle(false);
    }
  };

  const startWriteAuth = useCallback(async () => {
    setPhase('starting');
    setSession(null);
    setAuthError(null);
    try {
      const result = await startDeviceAuth('reauthorize', { scopeSet: 'write', includeOptionalScopes: true });
      if (!result.deviceCode || !result.verificationUrl) throw new Error('授权会话创建失败');
      setSession(result);
      setPhase('waiting');
      openUrlInBrowser(result.verificationUrl);

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setPhase('completing');
      const final = await completeDeviceAuth(result.deviceCode, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (final.ok && final.ready) {
        setPhase('success');
        await refresh();
      } else {
        setPhase('failed');
        setAuthError(final.error || '授权未完成（请确认授权页全部权限项已勾选并点击同意）');
      }
    } catch (error) {
      if (abortRef.current?.signal.aborted) return;
      setPhase('failed');
      setAuthError(error instanceof Error ? error.message : '授权流程失败');
    }
  }, [refresh]);

  const cancelWriteAuth = useCallback(async () => {
    setPhase('cancelling');
    abortRef.current?.abort();
    if (session?.deviceCode) {
      await cancelDeviceAuthRemote(session.deviceCode).catch(() => undefined);
    }
    setPhase('idle');
    setSession(null);
  }, [session]);

  const handleCopyUrl = async () => {
    if (!session) return;
    try {
      await writeClipboardText(session.verificationUrl);
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    } catch {
      // 剪贴板不可用时忽略：URL 本身仍可点击。
    }
  };

  return (
    <Card variant="elevated">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <PenLine className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">飞书写入</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} loading={authLoading}>
          <RefreshCw className="w-3.5 h-3.5" />
          重新检测
        </Button>
      </CardHeader>

      <CardBody className="space-y-4">
        <p className="text-xs text-ink-soft leading-relaxed">
          开启后可在文档预览面板把本地修改写回飞书云端文档（追加或经确认的覆盖）。
          写回不会推进同步基线，成功后自动回拉云端内容收敛本地状态。
        </p>

        <Toggle
          label="允许写回飞书"
          checked={enabled}
          disabled={savingToggle}
          onChange={(v) => void handleToggle(v)}
          helperText="关闭后已产生的本地修改仍会保留并阻断同步覆盖，需写回或放弃修改后解除"
        />

        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="text-sm text-ink-soft">写入权限（docx:document:write_only）</span>
          <div className="flex items-center gap-2">
            {writeGranted ? (
              <CheckCircle className="w-4 h-4 text-jade" />
            ) : (
              <XCircle className="w-4 h-4 text-seal-2/70" />
            )}
            <StatusBadge status={authLoading ? 'loading' : writeGranted ? 'success' : 'warning'} size="sm">
              {authLoading ? '检测中…' : writeGranted ? '已授权' : '未授权'}
            </StatusBadge>
          </div>
        </div>

        {/* 授权入口（未授权时主按钮；已授权时保留用于重新授权） */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={writeGranted ? 'secondary' : 'primary'}
            size="sm"
            disabled={authActive}
            onClick={() => void startWriteAuth()}
          >
            <KeyRound className="w-3.5 h-3.5" />
            {writeGranted ? '重新授权写入权限' : '授权写入权限'}
          </Button>
          {!writeGranted && (
            <p className="w-full text-xs text-ink-soft leading-relaxed">
              未授权写权限时「写回飞书」会被云端拒绝；点击授权后在浏览器勾选全部权限项。
            </p>
          )}
        </div>

        {/* Device Flow 等待态（复用认证卡视觉模式） */}
        {authActive && (
          <div className="p-3 rounded-md border border-seal/30 bg-seal/5 space-y-3">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-seal animate-spin" />
              <p className="text-sm text-ink font-medium">
                {phase === 'starting' && '正在发起写入权限授权…'}
                {phase === 'waiting' && '已在浏览器打开授权页，等待确认…（约 10 分钟内有效）'}
                {phase === 'completing' && '正在确认授权结果…'}
                {phase === 'cancelling' && '正在取消授权…'}
              </p>
            </div>
            {session && (
              <>
                <div className="flex items-center gap-2">
                  <a
                    href={session.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 min-w-0 text-xs font-mono text-seal underline break-all"
                  >
                    {session.verificationUrl}
                  </a>
                  <Button variant="ghost" size="sm" onClick={() => void handleCopyUrl()}>
                    <Copy className="w-3.5 h-3.5" />
                    {urlCopied ? '已复制' : '复制'}
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => openUrlInBrowser(session.verificationUrl)}>
                    <Globe className="w-3.5 h-3.5" />
                    重新打开授权页
                  </Button>
                  <Button variant="ghost" size="sm" disabled={phase === 'cancelling'} onClick={() => void cancelWriteAuth()}>
                    取消授权
                  </Button>
                </div>
                <p className="text-xs text-ink-soft leading-relaxed border-t border-seal/20 pt-2">
                  ⚠ 本次申请
                  {session.requestedScopes?.length ? ` ${session.requestedScopes.length} 项权限` : '读写全部权限'}
                  （含既有同步读权限 + 文档写入）——请确认授权页全部权限项已勾选后再点「同意授权」，未勾选的权限会被静默丢弃。
                </p>
              </>
            )}
          </div>
        )}

        {!authActive && phase === 'success' && (
          <div className="p-3 rounded-md border border-jade/30 bg-jade/5">
            <p className="text-sm text-jade">写入权限授权成功，现在可以在预览面板使用「写回飞书」。</p>
          </div>
        )}
        {!authActive && phase === 'failed' && (
          <div className="p-3 rounded-md border border-seal-2/30 bg-seal-2/5 space-y-2">
            <p className="text-sm text-seal-2 font-medium">本次授权未完成</p>
            <p className="text-sm text-seal-2">{authError || '授权未完成'}</p>
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={() => void startWriteAuth()}>
                <RefreshCw className="w-3.5 h-3.5" />
                重试授权
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPhase('idle')}>
                返回
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
