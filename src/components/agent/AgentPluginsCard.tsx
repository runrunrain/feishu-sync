import { useCallback, useEffect, useRef, useState } from 'react';
import { Puzzle, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../common/Button';
import { BuiltinContextsEditor } from './BuiltinContextsEditor';
import { listPiPlugins, managePiPlugin } from '../../api/client';
import type { PiPluginsDto } from '../../types/pi-plugin';
import { useSettingsDraft } from '../../hooks/settingsDraft';

export function AgentPluginsCard() {
  const [data, setData] = useState<PiPluginsDto | null>(null);
  const [selected, setSelected] = useState('');
  const [source, setSource] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  const dataRef = useRef<PiPluginsDto | null>(null);
  const pendingRef = useRef<Record<string, boolean>>({});
  const stageAction = useSettingsDraft()?.stageAction;
  const acceptData = useCallback((value: PiPluginsDto) => { dataRef.current = value; setData(value); }, []);
  const acceptPending = useCallback((value: Record<string, boolean>) => { pendingRef.current = value; setPendingEnabled(value); }, []);
  const current = data?.packages.find((pkg) => pkg.id === selected) ?? data?.packages[0];
  const currentEnabled = current ? pendingEnabled[current.id] ?? current.enabled : false;
  useEffect(() => {
    let alive = true;
    listPiPlugins().then((value) => { if (alive) acceptData(value); }).catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [acceptData]);
  useEffect(() => {
    if (!stageAction) return;
    stageAction('Pi 插件启停', Object.keys(pendingEnabled).length ? async () => {
      for (const [id, enabled] of Object.entries(pendingRef.current)) {
        const latest = dataRef.current;
        if (!latest?.packages.some((pkg) => pkg.id === id)) throw new Error('插件已不存在，请刷新后重试');
        const next = await managePiPlugin('toggle', latest.revision, { id, enabled });
        acceptData(next);
        const remaining = { ...pendingRef.current }; delete remaining[id]; acceptPending(remaining);
      }
    } : null);
  }, [pendingEnabled, stageAction, acceptData, acceptPending]);
  const refresh = async () => {
    setBusy(true); setError('');
    try { acceptData(await listPiPlugins()); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const act = async (action: 'install' | 'update' | 'remove' | 'toggle') => {
    if (!data) return;
    if (action === 'toggle' && current && stageAction) {
      const nextEnabled = !currentEnabled;
      const next = { ...pendingRef.current };
      if (nextEnabled === current.enabled) delete next[current.id]; else next[current.id] = nextEnabled;
      acceptPending(next);
      return;
    }
    if (action === 'remove' && !window.confirm('从本应用移除此Pi插件？本地源文件不由应用删除。')) return;
    setBusy(true); setError('');
    try {
      const next = await managePiPlugin(action, data.revision, action === 'install' ? { source }
        : { id: current?.id, ...(action === 'toggle' ? { enabled: !current?.enabled } : {}) });
      acceptData(next);
      if (action === 'remove' && current) {
        const remaining = { ...pendingRef.current }; delete remaining[current.id]; acceptPending(remaining);
      }
      if (action === 'install') { setAdding(false); setSource(''); setSelected(next.packages.at(-1)?.id ?? ''); }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4" aria-label="Pi插件管理">
    <div className="rounded-md border border-line bg-card-bg p-4 space-y-3">
      <div className="flex gap-2 items-center flex-wrap"><Puzzle className="w-5 h-5 text-seal" /><h2 className="font-kai text-lg flex-1">Pi 插件</h2>
        <Button size="sm" variant="secondary" disabled={busy || Object.keys(pendingEnabled).length > 0} onClick={() => void refresh()}><RefreshCw className="w-3.5 h-3.5" />刷新</Button>
        <Button size="sm" disabled={busy || !data} onClick={() => setAdding(!adding)}><Plus className="w-3.5 h-3.5" />添加 Pi 插件</Button>
      </div>
      <p className="text-sm text-ink-soft leading-relaxed">按Pi原生package管理，支持npm、git、本地包目录或扩展脚本。配置与安装缓存仅保存在本应用的Pi目录，通用Pi不受影响。</p>
      <p className="text-xs text-ink-faint leading-relaxed">Pi插件会执行本机代码，可能访问文件和网络，请只添加可信来源。第三方插件以当前用户权限运行；应用目录隔离限定配置与加载范围。新增/更新/启停将在下次运行加载；有任务运行时请先完成或停止。</p>
      {stageAction ? <p className="text-xs text-ink-faint">插件启停需点击顶部保存；安装、更新和移除会立即执行。</p> : null}
      {data ? <p className="text-[11px] font-mono text-ink-faint break-all">{data.agentDir}</p> : null}
      {adding ? <div className="border-t border-line pt-3 space-y-3">
        <label className="block text-sm text-ink">插件来源<input aria-label="Pi插件来源" className="block mt-2 w-full rounded border border-line p-2 text-sm bg-paper/30" value={source} disabled={busy}
          onChange={(event) => setSource(event.target.value)} placeholder="npm:@scope/package · git:github.com/user/repo · /绝对路径/plugin" /></label>
        <Button size="sm" loading={busy} disabled={busy || !source.trim()} onClick={() => void act('install')}>添加到本应用</Button>
      </div> : null}
      {error ? <p role="alert" className="text-sm text-seal whitespace-pre-wrap break-words">{error}</p> : null}
    </div>
    {!data && !error ? <p className="p-4 text-ink-faint">正在加载Pi插件…</p> : null}
    {data ? <>
      <nav aria-label="Pi插件列表" className="flex flex-wrap gap-2">{data.packages.map((pkg) => <button key={pkg.id} type="button" disabled={busy}
        onClick={() => setSelected(pkg.id)} aria-pressed={current?.id === pkg.id}
        className={`shrink-0 rounded border bg-card-bg px-3 py-2 text-left ${current?.id === pkg.id ? 'border-jade' : 'border-line'}`}>
        <span className="block text-sm text-ink">{pkg.name}</span><span className="block mt-1 text-xs text-ink-faint">{pkg.sourceType === 'builtin' ? '内置' : pkg.sourceType} · {pendingEnabled[pkg.id] !== undefined ? (pendingEnabled[pkg.id] ? '待启用' : '待停用') : pkg.enabled ? '已启用' : '已停用'}{pkg.version ? ` · v${pkg.version}` : ''}</span>
      </button>)}</nav>
      {current ? <div className="rounded border border-line bg-card-bg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap"><h3 className="text-base font-kai text-ink flex-1">{current.name}</h3>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('toggle')}>{currentEnabled ? '停用插件' : '启用插件'}</Button>
          {current.sourceType !== 'builtin' ? <>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('update')}>{current.sourceType === 'local' ? '重新加载' : '更新插件'}</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void act('remove')}>移除插件</Button>
          </> : null}
        </div>
        <p className="text-sm text-ink-soft">{current.description}</p>
        <p className="text-xs font-mono text-ink-faint break-all">{current.source}</p>
        <details className="text-xs text-ink-soft"><summary className="cursor-pointer">包资源（{current.resources.length}）</summary>
          <ul className="mt-2 space-y-1">{current.resources.map((resource) => <li key={`${resource.type}:${resource.path}`} className="break-all font-mono">{resource.type} · {resource.path}</li>)}</ul>
        </details>
      </div> : null}
      {data.packages.some((pkg) => pkg.sourceType === 'builtin') ? <div hidden={current?.sourceType !== 'builtin'}><BuiltinContextsEditor /></div> : null}
    </> : null}
  </section>;
}
