import { useEffect, useRef, useState } from 'react';
import { Plus, Puzzle, RefreshCw, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../common/Button';
import { useToast } from '../common/Toast';
import { getAgentPlugins, createAgentPlugin, updateAgentPlugin, deleteAgentPlugin, resetAgentPlugin } from '../../api/client';
import type { AgentContextPlugin, AgentPluginsDto, AgentPluginScope } from '../../types/agent-plugin';
import { useSettingsDraft, useSettingsForm } from '../../hooks/settingsDraft';

const SCOPES: Record<AgentPluginScope, string> = { discuss: '对话', work: 'Work', build: '知识库构建' };
const fresh = (): AgentContextPlugin => ({ id: 'new', kind: 'context', builtin: false, name: '新上下文配置', description: '',
  enabled: true, scopes: ['discuss'], content: '' });

export function BuiltinContextsEditor() {
  const toast = useToast();
  const [registry, setRegistry] = useState<AgentPluginsDto | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, AgentContextPlugin>>({});
  const registryRef = useRef<AgentPluginsDto | null>(null);
  const draftsRef = useRef<Record<string, AgentContextPlugin>>({});
  const settings = useSettingsDraft();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const draft = drafts[selectedId] ?? registry?.plugins.find((plugin) => plugin.id === selectedId) ?? null;
  const dirty = Object.keys(drafts).length > 0;
  const setDraft = (next: AgentContextPlugin) => {
    const original = registryRef.current?.plugins.find((plugin) => plugin.id === next.id);
    const changes = { ...draftsRef.current };
    if (original && JSON.stringify(original) === JSON.stringify(next)) delete changes[next.id];
    else changes[next.id] = next;
    draftsRef.current = changes; setDrafts(changes);
  };
  const accept = (data: AgentPluginsDto, id?: string) => {
    registryRef.current = data; setRegistry(data); setSelectedId(id && data.plugins.some((plugin) => plugin.id === id) ? id : data.plugins[0]?.id ?? ''); setError('');
  };
  useEffect(() => {
    let alive = true;
    getAgentPlugins().then((data) => { if (alive) accept(data); }).catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, []);
  const stageAction = settings?.stageAction;
  useSettingsForm('agent-plugins', () => {
    for (const entry of Object.values(draftsRef.current)) {
      if (!entry.name.trim() || !entry.scopes.length) throw new Error('上下文配置：名称与适用范围不能为空');
    }
    return null;
  });
  useEffect(() => {
    if (!stageAction) return;
    stageAction('插件上下文配置', dirty ? async () => {
      for (const [id, plugin] of Object.entries(draftsRef.current)) {
        const current = registryRef.current;
        if (!current) throw new Error('插件配置尚未加载');
        const input = plugin.builtin ? { content: plugin.content, enabled: plugin.enabled }
          : { name: plugin.name, description: plugin.description, content: plugin.content, enabled: plugin.enabled, scopes: plugin.scopes };
        const result = id === 'new' ? await createAgentPlugin(current.revision, input) : await updateAgentPlugin(id, current.revision, input);
        registryRef.current = result; setRegistry(result);
        const remaining = { ...draftsRef.current }; delete remaining[id]; draftsRef.current = remaining; setDrafts(remaining);
        if (id === 'new') setSelectedId(result.plugins.at(-1)?.id ?? '');
      }
    } : null);
  }, [dirty, stageAction]);
  const reload = async () => {
    if (dirty) return;
    setBusy(true);
    try { accept(await getAgentPlugins(), draft?.id); } catch (err) { setError(String(err instanceof Error ? err.message : err)); }
    finally { setBusy(false); }
  };
  const mutate = async (action: 'delete' | 'reset') => {
    if (!registry || !draft) return;
    if (!window.confirm(action === 'delete' ? '删除此自定义上下文插件？' : '恢复内置插件的默认内容和启用状态？')) return;
    setBusy(true); setError('');
    try {
      let result: AgentPluginsDto;
      if (action === 'delete') result = await deleteAgentPlugin(draft.id, registry.revision);
      else result = await resetAgentPlugin(draft.id, registry.revision);
      const remaining = { ...draftsRef.current }; delete remaining[draft.id]; draftsRef.current = remaining; setDrafts(remaining);
      accept(result, draft.id);
      toast.push({ type: 'success', message: action === 'reset' ? '已恢复默认插件' : '插件已删除' });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const select = (plugin: AgentContextPlugin) => setSelectedId(plugin.id);
  return <section className="rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
    <header className="px-4 py-3 border-b border-line/70 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Puzzle className="w-5 h-5 text-seal" /><h2 className="text-base font-kai text-ink flex-1 basis-48">知识库工作台 · 上下文配置</h2>
        <Button size="sm" variant="secondary" disabled={busy || dirty} onClick={() => void reload()}><RefreshCw className="w-3.5 h-3.5" />刷新</Button>
        <Button size="sm" disabled={busy || !registry || Boolean(drafts.new)} onClick={() => { setDraft(fresh()); setSelectedId('new'); }}><Plus className="w-3.5 h-3.5" />新增配置项</Button>
      </div>
      <p className="text-xs text-ink-faint leading-relaxed">这里管理知识库工作台插件的对话、Work、构建规则与文风配置。可调整内容与适用范围，保存后下次对话或构建生效。</p>
    </header>
    <div className="mx-4 mt-3 rounded border border-line bg-paper/50 px-3 py-2 text-xs text-ink-soft flex items-start gap-2">
      <ShieldCheck className="w-4 h-4 shrink-0 text-jade" /><span>配置内容按Markdown文本读取。停用配置项只停止该项上下文注入，工具桥接与应用校验仍由应用维护。</span>
    </div>
    {error ? <div role="alert" className="mx-4 mt-3 rounded border border-seal/30 px-3 py-2 text-sm text-seal">{error}</div> : null}
    {!registry && !error ? <p className="p-4 text-sm text-ink-faint">正在加载插件…</p> : null}
    {registry ? <div className="flex flex-col xl:flex-row gap-4 p-4">
      <nav aria-label="内置插件配置项" className="xl:w-48 xl:shrink-0 grid grid-cols-1 sm:grid-cols-2 xl:flex xl:flex-col gap-2 max-h-[520px] overflow-y-auto">
        {[...registry.plugins, ...(drafts.new ? [drafts.new] : [])].map((plugin) => <button key={plugin.id} type="button" disabled={busy} onClick={() => select(plugin)}
          aria-pressed={draft?.id === plugin.id} className={`shrink-0 text-left rounded border px-3 py-2.5 ${draft?.id === plugin.id ? 'border-jade bg-jade/5' : 'border-line hover:bg-paper'}`}>
          <span className="block text-sm text-ink">{plugin.name}</span>
          <span className="mt-1 block text-[11px] text-ink-faint">{plugin.enabled ? '已启用' : '已停用'} · {plugin.builtin ? '内置' : '自定义'} · {plugin.scopes.map((scope) => SCOPES[scope]).join(' / ')}</span>
        </button>)}
      </nav>
      {draft ? <div className="flex-1 min-w-0 space-y-3">
        <div className="flex justify-between items-center gap-3">
          <h3 className="font-kai text-base text-ink">{draft.id === 'new' ? '新增配置项' : draft.name}</h3>
          <label className="text-sm text-ink-soft flex items-center gap-2"><input type="checkbox" checked={draft.enabled} disabled={busy} className="accent-jade"
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用配置项</label>
        </div>
        {!draft.builtin ? <>
          <label className="block text-xs text-ink-soft">配置名称<input className="mt-1 w-full rounded border border-line bg-card-bg p-2 text-sm" value={draft.name} disabled={busy}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label className="block text-xs text-ink-soft">说明<input className="mt-1 w-full rounded border border-line bg-card-bg p-2 text-sm" value={draft.description} disabled={busy}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        </> : <p className="text-xs text-ink-faint">{draft.description}</p>}
        <fieldset className="flex gap-4 text-xs text-ink-soft flex-wrap"><legend className="mb-1">适用范围</legend>
          {(Object.keys(SCOPES) as AgentPluginScope[]).map((scope) => <label key={scope} className="flex items-center gap-1.5"><input type="checkbox" className="accent-jade"
            checked={draft.scopes.includes(scope)} disabled={busy || draft.builtin}
            onChange={(event) => setDraft({ ...draft, scopes: event.target.checked ? [...draft.scopes, scope] : draft.scopes.filter((value) => value !== scope) })} />{SCOPES[scope]}</label>)}
        </fieldset>
        <label className="block text-xs text-ink-soft">上下文内容（Markdown）
          <textarea aria-label="插件上下文内容" spellCheck={false} disabled={busy} value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            className="mt-2 w-full min-h-[340px] resize-y rounded border border-line bg-paper/30 p-3 text-sm font-mono leading-relaxed focus:outline-jade" />
        </label>
        <div className="flex gap-2 items-center flex-wrap">
          {draft.builtin ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void mutate('reset')}><RotateCcw className="w-3.5 h-3.5" />恢复默认</Button>
            : draft.id !== 'new' ? <Button size="sm" variant="danger" disabled={busy} onClick={() => void mutate('delete')}><Trash2 className="w-3.5 h-3.5" />删除配置项</Button> : null}
          <span className="text-xs text-ink-faint">{dirty ? '有未保存的修改' : '已保存'}</span>
        </div>
      </div> : null}
    </div> : null}
  </section>;
}
