/**
 * AuthSettingsCard - 认证卡片（引导式，新用户引导需求 §4）
 *
 * 从「终端命令文案展示」升级为应用内闭环：
 * - 未安装 lark-cli：「一键安装 lark-cli」；npm 不可用时引导安装 Node.js
 * - 已装未认证/缺 scope：「开始飞书认证」→ Device Flow（自动开浏览器，
 *   卡片内展示可点击/可复制的授权 URL + 等待态 + 完成后自动刷新）
 * - 已就绪：原有 scope/版本展示 + 「更新 lark-cli」次要按钮（已安装即可见，
 *   与认证状态解耦——认证未就绪时往往是用户最需要更新 CLI 的时刻）
 * 依赖 useAuthStatus（就绪态 + scope 列表）与 useLarkCliSetup（引导状态机）。
 */

import { useState } from 'react';
import {
  RefreshCw,
  CheckCircle,
  AlertCircle,
  XCircle,
  KeyRound,
  Download,
  ExternalLink,
  Globe,
  Copy,
  RotateCcw,
} from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { useLarkCliSetup } from '../hooks/useLarkCliSetup';

const NODEJS_DOWNLOAD_URL = 'https://nodejs.org';

/** desktop bridge 优先（主进程 http/https 白名单），缺席时 window.open。 */
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

export function AuthSettingsCard() {
  const { authStatus, loading, ready, error, refresh } = useAuthStatus();
  const setup = useLarkCliSetup({ onStatusChanged: refresh });
  const [urlCopied, setUrlCopied] = useState(false);

  const toolStatus = setup.toolStatus;
  const larkCliMissing = toolStatus != null && !toolStatus.larkCliInstalled;
  const npmMissing =
    setup.installResult?.reason === 'npm_not_found'
    || (toolStatus != null && !toolStatus.npmAvailable);
  const authActive = ['starting', 'waiting', 'completing'].includes(setup.authPhase);

  const StatusIcon = loading
    ? null
    : ready
      ? <CheckCircle className="w-5 h-5 text-jade" />
      : error
        ? <XCircle className="w-5 h-5 text-seal-2" />
        : <AlertCircle className="w-5 h-5 text-seal" />;

  const handleRecheck = () => {
    void refresh();
    void setup.refreshStatus();
  };

  const handleInstall = () => {
    void setup.install();
  };

  const handleUpdate = () => {
    if (window.confirm('确认更新 lark-cli 到最新版本？更新期间同步将短暂不可用。')) {
      void setup.install();
    }
  };

  const handleStartAuth = () => {
    void setup.startAuth();
  };

  const handleCopyUrl = async () => {
    if (!setup.authSession) return;
    try {
      await navigator.clipboard.writeText(setup.authSession.verificationUrl);
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    } catch {
      // 剪贴板不可用时忽略：URL 本身仍是可点击链接。
    }
  };

  const helpText = (() => {
    if (loading) return '正在检测认证状态…';
    if (ready) return `已通过 lark-cli ${authStatus?.larkCliVersion || '未知版本'} 认证`;
    if (!authStatus) return '无法检查认证状态';

    const msg = error || authStatus.error || '';
    if (msg.includes('not installed') || msg.includes('not found')) {
      return 'lark-cli 未安装。可点击上方按钮一键安装，或在终端执行：npm install -g lark-cli';
    }
    if (msg.includes('not authenticated') || msg.includes('not logged in')) {
      return '尚未登录飞书。可点击上方按钮开始认证，或在终端执行：lark-cli auth login --scope';
    }
    if (msg.includes('scope') || msg.includes('permission')) {
      return `缺失必需权限：${authStatus.missingScopes?.join('、') || '未知'}。可重新发起认证补齐授权`;
    }
    if (msg.includes('expired') || msg.includes('token')) {
      return '认证已过期。可点击上方按钮重新认证';
    }
    return msg || '认证检查失败';
  })();

  return (
    <Card variant="elevated">
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <KeyRound className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">飞书认证</h2>
        </div>
        <div className="flex items-center gap-2">
          {setup.toolStatus?.larkCliInstalled && (
            <Button variant="secondary" size="sm" onClick={handleUpdate} loading={setup.installing}>
              <RotateCcw className="w-3.5 h-3.5" />
              更新 lark-cli
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handleRecheck} loading={loading}>
            <RefreshCw className="w-3.5 h-3.5" />
            重新检测
          </Button>
        </div>
      </CardHeader>

      <CardBody className="space-y-4">
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="text-sm text-ink-soft">状态</span>
          <div className="flex items-center gap-2">
            {StatusIcon}
            <StatusBadge status={loading ? 'loading' : ready ? 'success' : 'error'} size="sm">
              {loading ? '检测中…' : ready ? '已就绪' : '未就绪'}
            </StatusBadge>
          </div>
        </div>

        {authStatus?.larkCliVersion && (
          <div className="flex items-center justify-between py-1.5 border-b border-line">
            <span className="text-sm text-ink-soft">lark-cli 版本</span>
            {(() => {
              // 版本对比着色（2026-09）：最新=绿 / 落后=琥珀+可更新 / 无最新信息=中性。
              const current = authStatus.larkCliVersion!.replace(/^lark-cli version\s*/i, '').replace(/^v/, '');
              const latest = setup.toolStatus?.latestLarkCliVersion?.replace(/^v/, '');
              const upToDate = latest != null && current === latest;
              const outdated = latest != null && current !== latest;
              const colorCls = upToDate
                ? 'text-jade bg-jade/10'
                : outdated
                  ? 'text-amber-700 bg-amber-500/10'
                  : 'text-ink-soft bg-paper-2';
              return (
                <span className={`text-sm font-mono px-2 py-0.5 rounded ${colorCls}`}>
                  {current}
                  {upToDate && <span className="ml-1.5 text-[11px]">已最新</span>}
                  {outdated && (
                    <span className="ml-1.5 text-[11px]">可更新至 {latest}</span>
                  )}
                </span>
              );
            })()}
          </div>
        )}

        {/* ── 引导面板：Device Flow 等待态 ─────────────────────────── */}
        {authActive && (
          <div className="p-3 rounded-md border border-seal/30 bg-seal/5 space-y-3">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-seal animate-spin" />
              <p className="text-sm text-ink font-medium">
                {setup.authPhase === 'starting' && '正在发起飞书认证…'}
                {setup.authPhase === 'waiting' && '等待浏览器授权确认…（约 10 分钟内有效）'}
                {setup.authPhase === 'completing' && '正在确认授权结果…'}
              </p>
            </div>
            {setup.authSession && (
              <>
            <div className="flex items-center gap-2">
              <a
                href={setup.authSession.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-0 text-xs font-mono text-seal underline break-all"
              >
                {setup.authSession.verificationUrl}
              </a>
              <Button variant="ghost" size="sm" onClick={() => void handleCopyUrl()}>
                <Copy className="w-3.5 h-3.5" />
                {urlCopied ? '已复制' : '复制'}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openUrlInBrowser(setup.authSession!.verificationUrl)}
              >
                <Globe className="w-3.5 h-3.5" />
                重新打开授权页
              </Button>
              <Button variant="ghost" size="sm" onClick={setup.cancelAuth}>
                取消等待
              </Button>
            </div>
              </>
            )}
          </div>
        )}

        {/* ── 引导面板：Device Flow 失败/成功态 ───────────────────── */}
        {!authActive && setup.authPhase === 'failed' && (
          <div className="p-3 rounded-md border border-seal-2/30 bg-seal-2/5 space-y-2">
            <p className="text-sm text-seal-2">{setup.authError || '认证未完成'}</p>
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={handleStartAuth}>
                <RefreshCw className="w-3.5 h-3.5" />
                重试认证
              </Button>
              <Button variant="ghost" size="sm" onClick={setup.resetAuth}>
                返回
              </Button>
            </div>
          </div>
        )}
        {!authActive && setup.authPhase === 'success' && (
          <div className="p-3 rounded-md border border-jade/30 bg-jade/5">
            <p className="text-sm text-jade">认证成功，已自动刷新就绪状态。</p>
          </div>
        )}

        {/* ── 引导面板：未安装 lark-cli ───────────────────────────── */}
        {!authActive && larkCliMissing && (
          <div className="p-3 rounded-md border border-line bg-paper-2/60 space-y-3">
            {npmMissing ? (
              <>
                <p className="text-sm text-ink leading-relaxed">
                  需要 Node.js 环境：未检测到可用的 npm。请先安装 Node.js（内含 npm），
                  安装完成后回到此处一键安装 lark-cli。
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => openUrlInBrowser(NODEJS_DOWNLOAD_URL)}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  前往下载 Node.js
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-ink leading-relaxed">
                  {setup.installing
                    ? '正在通过 npm 安装 lark-cli，可能需要数分钟，请勿关闭应用…'
                    : 'lark-cli 尚未安装。点击下方按钮通过 npm 一键安装（已安装则更新到最新版）。'}
                </p>
                <Button variant="primary" size="sm" onClick={handleInstall} loading={setup.installing}>
                  <Download className="w-3.5 h-3.5" />
                  一键安装 lark-cli
                </Button>
              </>
            )}
            {setup.installResult && !setup.installResult.ok
              && setup.installResult.reason !== 'npm_not_found' && (
              <pre className="max-h-32 overflow-auto text-[11px] font-mono text-ink-faint bg-paper border border-line rounded p-2 whitespace-pre-wrap">
                {setup.installResult.output || setup.installResult.error || '安装失败'}
              </pre>
            )}
          </div>
        )}

        {/* ── 引导面板：已安装未认证/缺 scope ─────────────────────── */}
        {!authActive
          && setup.authPhase !== 'failed'
          && setup.authPhase !== 'success'
          && !larkCliMissing
          && toolStatus != null
          && !toolStatus.authReady && (
          <div className="p-3 rounded-md border border-line bg-paper-2/60 space-y-3">
            <p className="text-sm text-ink leading-relaxed">
              {toolStatus.missingScopes && toolStatus.missingScopes.length > 0
                ? `已安装 lark-cli 但缺少必需权限：${toolStatus.missingScopes.join('、')}。点击开始认证并在浏览器确认即可补齐。`
                : '已安装 lark-cli，尚未完成飞书认证。点击开始认证，在浏览器中确认授权后自动完成。'}
            </p>
            <Button variant="primary" size="sm" onClick={handleStartAuth}>
              <KeyRound className="w-3.5 h-3.5" />
              开始飞书认证
            </Button>
          </div>
        )}

        {/* ── 更新结果反馈（已就绪态的「更新 lark-cli」） ──────────── */}
        {ready && setup.installResult && !setup.installing && (
          <div
            className={`p-3 rounded-md border space-y-2 ${
              setup.installResult.ok
                ? 'border-jade/30 bg-jade/5 text-jade'
                : 'border-seal-2/30 bg-seal-2/5 text-seal-2'
            }`}
          >
            <p className="text-sm font-medium">
              {setup.installResult.ok
                ? `lark-cli 已更新到 ${setup.installResult.version || '最新版本'}`
                : `更新失败（${setup.installResult.reason ?? '未知原因'}），可稍后重试`}
            </p>
            {!setup.installResult.ok && (setup.installResult.error || setup.installResult.output) && (
              <pre className="max-h-32 overflow-auto text-[11px] font-mono text-ink-faint bg-paper border border-line rounded p-2 whitespace-pre-wrap">
                {setup.installResult.error ? `${setup.installResult.error}\n` : ''}
                {setup.installResult.output}
              </pre>
            )}
          </div>
        )}

        <div className="p-3 rounded-md border border-line bg-paper-2/60">
          <p className="text-sm text-ink leading-relaxed">{helpText}</p>
        </div>

        {authStatus?.currentScopes && authStatus.currentScopes.length > 0 && (
          <div>
            <p className="text-xs text-ink-faint mb-1.5 uppercase tracking-wide font-sans-ui">
              已授权权限
            </p>
            <div className="flex flex-wrap gap-1.5">
              {authStatus.currentScopes.map((s) => (
                <span
                  key={s}
                  className="px-2 py-0.5 text-[11px] bg-jade/10 text-jade border border-jade/20 rounded font-mono"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {authStatus?.missingScopes && authStatus.missingScopes.length > 0 && (
          <div>
            <p className="text-xs text-seal-2 mb-1.5 uppercase tracking-wide font-sans-ui">
              缺失必需权限
            </p>
            <div className="flex flex-wrap gap-1.5">
              {authStatus.missingScopes.map((s) => (
                <span
                  key={s}
                  className="px-2 py-0.5 text-[11px] bg-seal-2/10 text-seal-2 border border-seal-2/20 rounded font-mono"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
