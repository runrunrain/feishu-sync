import { useEffect, useState } from 'react';
import { Copy, RefreshCw, Server } from 'lucide-react';
import { getKbMcpInfo, getKbMcpInstallStatus, installKbMcp, removeKbMcp } from '../api/client';
import type { KbMcpInfoDto } from '../types/agent';
import type { McpClientTarget, McpInstallState, McpInstallStatus } from '../types/kb-mcp-install';
import { writeClipboardText } from '../utils/clipboard';
import { Button } from './common/Button';
import { StatusBadge } from './common/StatusBadge';

const STATE_LABELS: Record<McpInstallState, string> = {
  not_installed: '未安装', installed: '已安装', needs_update: '需要更新',
  conflict: '存在同名配置', modified: '配置已被修改', invalid: '配置不可用',
};

/** Immediate local installation is separate from the general settings draft. */
export function KbMcpLocalSettingsCard() {
  const [info, setInfo] = useState<KbMcpInfoDto | null>(null);
  const [targets, setTargets] = useState<McpInstallStatus[]>([]);
  const [target, setTarget] = useState<McpClientTarget>('agents');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [nextInfo, nextStatus] = await Promise.all([getKbMcpInfo(), getKbMcpInstallStatus()]);
      setInfo(nextInfo); setTargets(nextStatus.targets);
    } catch (error) {
      setTargets([]);
      setFeedback({ error: true, text: error instanceof Error ? error.message : '读取 MCP 配置失败，请重试。' });
    } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const selected = targets.find((item) => item.target === target);
  const manageable = selected?.state === 'installed' || selected?.state === 'needs_update';
  const canInstall = selected && ['not_installed', 'installed', 'needs_update'].includes(selected.state) && info?.available;
  const apply = async (action: 'install' | 'remove') => {
    setBusy(true); setFeedback(null);
    try {
      const result = await (action === 'install' ? installKbMcp(target) : removeKbMcp(target));
      setTargets((current) => current.map((item) => item.target === target ? result : item));
      setFeedback({ error: false, text: action === 'install' ? '安装完成，重启对应客户端后生效。' : '已清理本应用安装的 MCP 配置。' });
    } catch (error) {
      setFeedback({ error: true, text: error instanceof Error ? error.message : '操作失败，请刷新后重试。' });
      try { setTargets((await getKbMcpInstallStatus()).targets); } catch { /* Preserve the operation error. */ }
    } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!info) return;
    try { await writeClipboardText(info.snippet); setFeedback({ error: false, text: '本地 MCP 配置已复制。' }); }
    catch { setFeedback({ error: true, text: '复制失败，请手动选择配置文本。' }); }
  };
  return (
    <section aria-label="本机 MCP 安装" className="rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
      <header className="px-4 py-3 border-b border-line/60 flex items-start gap-3">
        <Server className="w-4 h-4 mt-0.5 shrink-0 text-ink-soft" />
        <div><h3 className="text-sm font-kai font-medium text-ink">本机 MCP 安装</h3>
          <p className="mt-1 text-xs text-ink-soft">让本机 Agent 通过只读 MCP 访问标准库与已同步的原始文档。</p>
        </div>
      </header>
      <div className="p-4 space-y-3 text-xs text-ink-soft">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-44 space-y-1">
            <span>安装目标</span>
            <select aria-label="MCP 安装目标" value={target} disabled={busy} onChange={(event) => { setTarget(event.target.value as McpClientTarget); setFeedback(null); }} className="w-full rounded border border-line bg-paper px-2 py-2 text-sm text-ink">
              <option value="agents">.agents（兼容客户端）</option>
              <option value="claude">Claude Code（用户级）</option>
            </select>
          </label>
          <Button size="sm" disabled={loading || busy || !canInstall} onClick={() => void apply('install')}>
            {selected?.state === 'needs_update' ? '更新配置' : selected?.state === 'installed' ? '重新安装' : '一键安装'}
          </Button>
          <Button size="sm" variant="secondary" disabled={loading || busy || !manageable} onClick={() => void apply('remove')}>清理</Button>
          <Button size="sm" variant="secondary" disabled={busy || loading} onClick={() => { setFeedback(null); void refresh(); }}><RefreshCw className="w-3.5 h-3.5" />刷新</Button>
        </div>
        {loading ? <p role="status">正在读取安装状态…</p> : selected ? <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={selected.state === 'installed' ? 'success' : selected.state === 'not_installed' ? 'neutral' : 'warning'}>{STATE_LABELS[selected.state]}</StatusBadge>
            <span className="break-all font-mono select-text">{selected.path}</span>
          </div>
          {selected.message ? <p role="note" className="text-seal">{selected.message}</p> : null}
          {info && !info.available ? <p role="note" className="text-seal">本地 MCP 程序未就绪，无法安装；已安装的配置仍可清理。</p> : null}
        </div> : null}
        <p>操作立即生效。只管理本应用安装且未被外部修改的 <code>feishu-kb</code> 条目；其它配置会保留。</p>
        <p>Amagi Pi 等兼容客户端读取 <code>~/.agents/.mcp.json</code>；Claude Code 的用户级 MCP 配置实际位于 <code>~/.claude.json</code>。安装或清理后请重启相应客户端。</p>
        {feedback ? <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'text-seal-2' : 'text-jade'}>{feedback.text}</p> : null}
        {info ? <details className="border-t border-line/60 pt-3">
          <summary className="cursor-pointer font-medium text-ink">手动配置</summary>
          <div className="relative mt-2">
            <pre aria-label="本地 MCP 配置" className="max-h-48 overflow-auto scrollbar-thin rounded border border-line bg-paper/50 p-3 text-[11px] leading-relaxed select-text">{info.snippet}</pre>
            <Button size="sm" variant="secondary" className="absolute right-2 top-2" onClick={() => void copy()}><Copy className="w-3.5 h-3.5" />复制</Button>
          </div>
          <p className="mt-2">原始库不需要先构建标准库。应用运行时约每 10 秒刷新源清单；关闭后沿用最后清单读取本地文件。升级启动应用后，旧安装可自动识别同一应用的源清单；自定义配置可点击更新并重启客户端。</p>
        </details> : null}
      </div>
    </section>
  );
}
