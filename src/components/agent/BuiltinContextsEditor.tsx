import { useEffect, useState } from 'react';
import { Plus, Puzzle, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../common/Button';
import { useToast } from '../common/Toast';
import { getAgentPlugins, createAgentPlugin, updateAgentPlugin, deleteAgentPlugin, resetAgentPlugin } from '../../api/client';
import type { AgentContextPlugin, AgentPluginsDto, AgentPluginScope } from '../../types/agent-plugin';

const SCOPES: Record<AgentPluginScope, string> = { discuss: '对话', work: 'Work', build: '知识库构建' };
const fresh = (): AgentContextPlugin => ({ id: 'new', kind: 'context', builtin: false, name: '新上下文配置', description: '',
  enabled: true, scopes: ['discuss'], content: '' });

export function BuiltinContextsEditor() {
  const toast = useToast();
  const [registry, setRegistry] = useState<AgentPluginsDto | null>(null);
  const [draft, setDraft] = useState<AgentContextPlugin | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saved = registry?.plugins.find((plugin) => plugin.id === draft?.id);
  const dirty = !!draft && JSON.stringify(saved) !== JSON.stringify(draft);
  const accept = (data: AgentPluginsDto, id?: string) => {
    setRegistry(data); setDraft(data.plugins.find((plugin) => plugin.id === id) ?? data.plugins[0] ?? null); setError('');
  };
  useEffect(() => {
    let alive = true;
    getAgentPlugins().then((data) => { if (alive) accept(data); }).catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, []);
  const canLeave = () => !dirty || window.confirm('有未保存的插件修改，是否放弃这些修改？');
  const reload = async () => {
    if (!canLeave()) return;
    setBusy(true);
    try { accept(await getAgentPlugins(), draft?.id); } catch (err) { setError(String(err instanceof Error ? err.message : err)); }
    finally { setBusy(false); }
  };
  const mutate = async (action: 'save' | 'delete' | 'reset') => {
    if (!registry || !draft) return;
    if (action !== 'save' && !window.confirm(action === 'delete' ? '删除此自定义上下文插件？' : '恢复内置插件的默认内容和启用状态？')) return;
    setBusy(true); setError('');
    try {
      let result: AgentPluginsDto;
      if (action === 'delete') result = await deleteAgentPlugin(draft.id, registry.revision);
      else if (action === 'reset') result = await resetAgentPlugin(draft.id, registry.revision);
      else {
        const input = draft.builtin ? { content: draft.content, enabled: draft.enabled }
          : { name: draft.name, description: draft.description, content: draft.content, enabled: draft.enabled, scopes: draft.scopes };
        result = draft.id === 'new' ? await createAgentPlugin(registry.revision, input) : await updateAgentPlugin(draft.id, registry.revision, input);
      }
      const id = draft.id === 'new' ? result.plugins.at(-1)?.id : draft.id;
      accept(result, id);
      toast.push({ type: 'success', message: action === 'save' ? '插件已保存，下次对话或构建生效' : action === 'reset' ? '已恢复默认插件' : '插件已删除' });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const select = (plugin: AgentContextPlugin) => { if (canLeave()) setDraft({ ...plugin, scopes: [...plugin.scopes] }); };
  return <section className="rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
    <header className="px-5 py-4 border-b border-line/70 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Puzzle className="w-5 h-5 text-seal" /><h2 className="text-lg font-kai text-ink flex-1">知识库工作台 · 上下文配置</h2>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void reload()}><RefreshCw className="w-3.5 h-3.5" />刷新</Button>
        <Button size="sm" disabled={busy || !registry} onClick={() => { if (canLeave()) setDraft(fresh()); }}><Plus className="w-3.5 h-3.5" />新增配置项</Button>
      </div>
      <p className="text-xs text-ink-faint leading-relaxed">这里管理知识库工作台插件的对话、Work、构建规则与文风配置。可调整内容与适用范围，保存后下次对话或构建生效。</p>
    </header>
    <div className="mx-5 mt-4 rounded border border-line bg-paper/50 px-3 py-2 text-xs text-ink-soft flex items-start gap-2">
      <ShieldCheck className="w-4 h-4 shrink-0 text-jade" /><span>配置内容按Markdown文本读取。停用配置项只停止该项上下文注入，工具桥接与应用校验仍由应用维护。</span>
    </div>
    {error ? <div role="alert" className="mx-5 mt-4 rounded border border-seal/30 px-3 py-2 text-sm text-seal">{error}</div> : null}
    {!registry && !error ? <p className="p-5 text-sm text-ink-faint">正在加载插件…</p> : null}
    {registry ? <div className="flex flex-col xl:flex-row gap-4 p-5">
      <nav aria-label="内置插件配置项" className="xl:w-56 xl:shrink-0 flex xl:flex-col gap-2 overflow-auto max-h-[520px]">
        {registry.plugins.map((plugin) => <button key={plugin.id} type="button" disabled={busy} onClick={() => select(plugin)}
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
          <Button size="sm" disabled={busy || !dirty || !draft.name.trim() || !draft.scopes.length} loading={busy} onClick={() => void mutate('save')}><Save className="w-3.5 h-3.5" />保存配置</Button>
          {draft.builtin ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void mutate('reset')}><RotateCcw className="w-3.5 h-3.5" />恢复默认</Button>
            : draft.id !== 'new' ? <Button size="sm" variant="danger" disabled={busy} onClick={() => void mutate('delete')}><Trash2 className="w-3.5 h-3.5" />删除配置项</Button> : null}
          <span className="text-xs text-ink-faint">{dirty ? '有未保存的修改' : '已保存'}</span>
        </div>
      </div> : null}
    </div> : null}
  </section>;
}
