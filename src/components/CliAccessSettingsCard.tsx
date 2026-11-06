/**
 * CliAccessSettingsCard —— 设置页「命令行访问」卡（S9，设计 §6.1/§6.4）
 *
 * 最小 UI：开启/关闭（POST /api/cli/enable）、令牌轮换（rotate）、
 * shim 一键安装（install-shim）、endpoint/shim 信息展示与路径复制。
 *
 * 秘密边界：CLI 令牌只存在于 0600 的 endpoint.json 与请求头，本卡
 * 永不展示/持有令牌（设计 §9.1 不变量 5）。
 */

import { useState } from 'react';
import { writeClipboardText } from '../utils/clipboard';
import { Check, Copy, Loader2, RefreshCw, Terminal, TerminalSquare } from 'lucide-react';
import { Button } from './common/Button';
import { StatusBadge } from './common/StatusBadge';
import { useToast } from './common/Toast';
import { useCliInfo } from '../hooks/useCliInfo';
import { useSettingsDraft } from '../hooks/settingsDraft';
import type { CliInstallStatus, CliSkillTarget } from '../types/cli';
import {
  APIError,
  installCliShim,
  removeCliShim,
  rotateCliToken,
  setCliEnabled,
  updateCliSkill,
} from '../api/client';

const INSTALL_LABELS: Record<CliInstallStatus['state'], string> = {
  not_installed: '未安装',
  installed: '已安装',
  needs_update: '需要更新',
  conflict: '存在同名文件或外部修改',
  invalid: '安装路径不可用',
};
type Action = 'toggle' | 'rotate' | 'shim' | 'removeShim' | 'installSkill' | 'removeSkill';

function manageable(status?: CliInstallStatus) {
  return status?.state === 'installed' || status?.state === 'needs_update';
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="shrink-0 text-xs text-ink-faint w-24">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-xs ${mono ? 'font-mono' : ''} text-ink-soft`} title={value}>
        {value}
      </span>
      <button
        type="button"
        className="p-1 rounded text-ink-faint hover:text-ink hover:bg-paper disabled:opacity-40"
        onClick={() => {
          void writeClipboardText(value).then(() => {
            setCopyFailed(false);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }).catch(() => setCopyFailed(true));
        }}
        aria-label={`复制${label}`}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-jade" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
      {copyFailed && <span role="alert" className="text-xs text-seal">复制失败</span>}
    </div>
  );
}

export function CliAccessSettingsCard() {
  const toast = useToast();
  const { info, loading, reload } = useCliInfo();
  const draft = useSettingsDraft();
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [skillTarget, setSkillTarget] = useState<CliSkillTarget>('agents');

  const runAction = async (
    kind: Action,
    action: () => Promise<unknown>,
    successMessage: string,
  ) => {
    setBusy(kind);
    try {
      await action();
      toast.push({ type: 'success', message: successMessage });
      await reload();
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '操作失败' });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const enabled = pendingEnabled ?? info?.enabled === true;
  const shim = info?.shim;
  const skill = info?.skillTargets?.find(item => item.target === skillTarget);
  const setEnabled = (next: boolean) => {
    if (!draft) { void runAction('toggle', () => setCliEnabled(next), next ? '命令行访问已开启' : '命令行访问已关闭，令牌立即失效'); return; }
    setPendingEnabled(next === (info?.enabled === true) ? null : next);
    draft.stageAction('命令行访问设置', next === (info?.enabled === true) ? null : async () => { await setCliEnabled(next); await reload(); setPendingEnabled(null); });
  };

  return (
    <section className="rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
      <header className="px-4 py-3 border-b border-line/60 flex items-start gap-3">
        <div className="mt-0.5 text-ink-faint"><Terminal className="w-4 h-4" /></div>
        <div className="min-w-0">
          <h3 className="text-sm font-kai font-medium text-ink">命令行访问</h3>
        </div>
      </header>

      <div className="p-4 space-y-3">
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-ink-faint">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 读取状态…
          </p>
        ) : !info ? (
          <div className="flex items-center gap-3">
            <StatusBadge status="error">状态不可用</StatusBadge>
            <Button size="sm" variant="secondary" onClick={() => void reload()}>
              <RefreshCw className="w-3.5 h-3.5" /> 重试
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              {enabled ? (
                <StatusBadge status={pendingEnabled !== null ? 'warning' : 'success'}>{pendingEnabled !== null ? '待开启' : '已开启'}</StatusBadge>
              ) : (
                <StatusBadge status={pendingEnabled !== null ? 'warning' : 'neutral'}>{pendingEnabled !== null ? '待关闭' : '未开启'}</StatusBadge>
              )}
              {pendingEnabled !== null ? <span className="text-xs text-seal">待顶部保存后生效</span> : null}
              {enabled && info.endpointPublished ? null : enabled ? (
                <span className="text-[11px] text-ink-faint">端点未发布（应用重启后生效）</span>
              ) : null}
              <Button
                size="sm"
                variant={enabled ? 'secondary' : 'primary'}
                loading={busy === 'toggle'}
                disabled={busy !== null}
                onClick={() =>
                  setEnabled(!enabled)
                }
                aria-label={enabled ? '关闭命令行访问' : '开启命令行访问'}
              >
                {enabled ? '关闭' : '开启'}
              </Button>
              {enabled ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'rotate'}
                  disabled={busy !== null || pendingEnabled !== null}
                  onClick={() => void runAction('rotate', () => rotateCliToken(), 'CLI 令牌已轮换（旧令牌立即失效）')}
                >
                  <RefreshCw className="w-3.5 h-3.5" /> 轮换令牌
                </Button>
              ) : null}
            </div>

            {enabled ? (
              <div className="space-y-1.5 px-3 py-2.5 rounded-md border border-line bg-paper/40">
                <InfoRow label="端点文件" value={info.endpointFile} mono />
                <InfoRow label="CLI 产物" value={info.cliScript} mono />
                <p className="text-[11px] text-ink-faint leading-relaxed pt-1">
                  端点文件含令牌，请勿分享。轮换或关闭后旧令牌立即失效。
                  {!info.cliAvailable ? ' CLI 打包产物缺失，请更新应用版本。' : ''}
                </p>
              </div>
            ) : (
              <p className="text-xs text-ink-faint leading-relaxed">
                关闭时本机命令无法连接应用，令牌立即失效。
              </p>
            )}

            <div className="space-y-1.5 px-3 py-2.5 rounded-md border border-line bg-paper/40">
              <div className="flex items-center gap-3 flex-wrap">
                {shim && <StatusBadge status={shim.state === 'installed' ? 'success' : shim.state === 'not_installed' ? 'neutral' : 'warning'}>
                  <TerminalSquare className="w-3 h-3 mr-1 inline" />shim {INSTALL_LABELS[shim.state]}
                </StatusBadge>}
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'shim'}
                  disabled={busy !== null || !enabled || pendingEnabled !== null || !info.cliAvailable || shim?.state === 'conflict' || shim?.state === 'invalid'}
                  onClick={() => void runAction('shim', installCliShim, 'shim 已生成')}
                >
                  {manageable(shim) ? '重新生成 shim' : '生成 feishu-sync 命令'}
                </Button>
                <Button size="sm" variant="secondary" loading={busy === 'removeShim'} disabled={busy !== null || !manageable(shim)}
                  onClick={() => void runAction('removeShim', removeCliShim, '已清理 shim')}>
                  清理 shim
                </Button>
              </div>
              {shim ? <InfoRow label="shim 路径" value={shim.path} mono /> : null}
              {shim?.message ? <p role="note" className="text-xs text-seal">{shim.message}</p> : null}
              <p className="text-[11px] text-ink-faint leading-relaxed">
                {manageable(shim)
                  ? info.pathHint
                  : '清理后，重启时不会自动重装。'}
              </p>
            </div>

            <section aria-label="Agent CLI Skill" className="space-y-2 px-3 py-2.5 rounded-md border border-line bg-paper/40">
              <h4 className="text-xs font-medium text-ink">Agent CLI Skill</h4>
              <p className="text-xs text-ink-faint">默认目标为 .agents。安装或清理后，请重新打开 Agent 会话。</p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="block min-w-44 space-y-1 text-xs text-ink-soft">
                  <span>安装目标</span>
                  <select aria-label="Skill 安装目标" value={skillTarget} disabled={busy !== null}
                    onChange={event => setSkillTarget(event.target.value as CliSkillTarget)}
                    className="w-full rounded border border-line bg-paper px-2 py-2 text-sm text-ink">
                    <option value="agents">.agents（兼容客户端）</option>
                    <option value="claude">Claude Code（用户级）</option>
                    <option value="codex">Codex（用户级）</option>
                  </select>
                </label>
                <Button size="sm" loading={busy === 'installSkill'}
                  disabled={busy !== null || !info.skillAvailable || !skill || skill.state === 'conflict' || skill.state === 'invalid'}
                  onClick={() => void runAction('installSkill', () => updateCliSkill(skillTarget, true), 'Skill 已安装，请重新打开对应的 Agent 会话')}>
                  {skill?.state === 'needs_update' ? '更新 Skill' : manageable(skill) ? '重新安装' : '安装'}
                </Button>
                <Button size="sm" variant="secondary" loading={busy === 'removeSkill'} disabled={busy !== null || !manageable(skill)}
                  onClick={() => void runAction('removeSkill', () => updateCliSkill(skillTarget, false), '已清理所选目标的 Skill')}>
                  清理
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void reload()}>
                  <RefreshCw className="w-3.5 h-3.5" /> 刷新
                </Button>
              </div>
              {skill && <>
                <StatusBadge status={skill.state === 'installed' ? 'success' : skill.state === 'not_installed' ? 'neutral' : 'warning'}>{INSTALL_LABELS[skill.state]}</StatusBadge>
                <InfoRow label="Skill 路径" value={skill.path} mono />
                {skill.message ? <p role="note" className="text-xs text-seal">{skill.message}</p> : null}
              </>}
              {!info.skillAvailable ? <p role="note" className="text-xs text-seal">内置 Skill 文件缺失，请更新应用版本。</p> : null}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
