/**
 * AuthSettingsCard - 认证卡片（T8，04 §4.3 / §7.2）
 *
 * 重构自 AuthStatus：迁入设置区，文案中文化，保留 lark-cli 状态展示 +
 * scope 列表（已授权/缺失）+ 缺失提示 + 重新检测。
 */

import { RefreshCw, CheckCircle, AlertCircle, XCircle, KeyRound } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { useAuthStatus } from '../hooks/useAuthStatus';

export function AuthSettingsCard() {
  const { authStatus, loading, ready, error, refresh } = useAuthStatus();

  const StatusIcon = loading
    ? null
    : ready
      ? <CheckCircle className="w-5 h-5 text-jade" />
      : error
        ? <XCircle className="w-5 h-5 text-seal-2" />
        : <AlertCircle className="w-5 h-5 text-seal" />;

  const helpText = (() => {
    if (loading) return '正在检测认证状态…';
    if (ready) return `已通过 lark-cli ${authStatus?.larkCliVersion || '未知版本'} 认证`;
    if (!authStatus) return '无法检查认证状态';

    const msg = error || authStatus.error || '';
    if (msg.includes('not installed') || msg.includes('not found')) {
      return 'lark-cli 未安装。请在终端执行：npm install -g lark-cli';
    }
    if (msg.includes('not authenticated') || msg.includes('not logged in')) {
      return '尚未登录飞书。请在终端执行：lark-cli auth login --scope';
    }
    if (msg.includes('scope') || msg.includes('permission')) {
      return `缺失必需权限：${authStatus.missingScopes?.join('、') || '未知'}。请执行：lark-cli auth login --scope`;
    }
    if (msg.includes('expired') || msg.includes('token')) {
      return '认证已过期。请执行：lark-cli auth login --scope';
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
        <Button variant="ghost" size="sm" onClick={refresh} loading={loading}>
          <RefreshCw className="w-3.5 h-3.5" />
          重新检测
        </Button>
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

        {authStatus?.larkCliVersion && ready && (
          <div className="flex items-center justify-between py-1.5 border-b border-line">
            <span className="text-sm text-ink-soft">lark-cli 版本</span>
            <span className="text-sm font-mono text-seal bg-seal/10 px-2 py-0.5 rounded">
              {authStatus.larkCliVersion}
            </span>
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
