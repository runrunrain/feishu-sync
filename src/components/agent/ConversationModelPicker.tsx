import { useEffect, useRef, useState } from 'react';
import { ChevronDown, RotateCcw, Zap } from 'lucide-react';
import { listConversationModels, saveConversationModel, type AgentModelOption } from '../../api/client';
import { useConfig } from '../../hooks/useConfig';
import { useToast } from '../common/Toast';
import type { AgentSessionDto, SessionModelConfig } from '../../types/agent';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high'] as const;
const LABELS = ['关闭', '最低', '低', '中', '高'];
const key = (m: Partial<AgentModelOption>) => m.source === 'pi-agent-dir' ? `pi:${m.piModel}` : `app:${m.providerId}:${m.modelId}`;
export function ConversationModelPicker({ session, busy, onChanged }: { session: AgentSessionDto | null; busy: boolean; onChanged: () => void }) {
  const { config } = useConfig(); const toast = useToast(); const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<'models' | 'effort' | null>(null);
  const [source, setSource] = useState<'app-llm' | 'pi-agent-dir'>('app-llm');
  const [items, setItems] = useState<AgentModelOption[]>([]); const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false); const [message, setMessage] = useState('');
  const current = session?.model ?? (session?.backend === 'claude-code' && config?.agent?.model
    ? { ...config.agent.model, source: 'app-llm' as const } : config?.agent?.model);
  const currentProvider = current?.providerId || config?.llm.activeProviderId;
  const currentPreset = current?.modelId || (currentProvider === config?.llm.activeProviderId ? config?.llm.activeModelId : config?.llm.providers?.find((p) => p.id === currentProvider)?.defaultModelId);
  const provider = config?.llm.providers?.find((p) => p.id === currentProvider);
  const preset = provider?.models.find((m) => m.id === currentPreset);
  const label = current?.source === 'pi-agent-dir' ? current.piModel?.split('/').slice(1).join('/') || '选择模型' : preset?.name || '选择模型';
  const thinking = current?.thinkingLevel ?? 'off';
  const reasoning = current?.source === 'pi-agent-dir' || preset?.reasoning === true;
  const disabled = !session || busy || saving;
  useEffect(() => { setOpen(null); }, [session?.id, busy]);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('pointerdown', click); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', click); window.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => {
    if (open !== 'models') return;
    let cancelled = false; setLoading(true); setItems([]); setMessage('');
    void listConversationModels(source, false, session?.backend).then((data) => { if (!cancelled) { setItems(data.items); setMessage(data.message); } }).catch(() => { if (!cancelled) setMessage('读取模型失败，请重试'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, source, session?.backend]);
  const save = async (model: SessionModelConfig | null) => {
    if (!session || disabled) return; setSaving(true);
    try { await saveConversationModel(session.id, model); setOpen(null); onChanged(); }
    catch (e) { toast.push({ type: 'error', message: e instanceof Error ? e.message : '切换模型失败' }); }
    finally { setSaving(false); }
  };
  const activeChoice = (): SessionModelConfig | null => current?.source === 'pi-agent-dir'
    ? current.piModel ? { source: 'pi-agent-dir', piModel: current.piModel, thinkingLevel: thinking } : null
    : currentProvider && currentPreset ? { source: 'app-llm', providerId: currentProvider, modelId: currentPreset, thinkingLevel: thinking } : null;
  return <div ref={root} className="relative flex items-center gap-1 min-w-0" data-testid="conversation-model-picker">
    <button type="button" aria-label="切换会话模型" aria-expanded={open === 'models'} disabled={disabled} title={busy ? '运行结束后可切换' : '仅当前会话生效，保留历史'}
      className="inline-flex min-w-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-45"
      onClick={() => { setSource(session?.backend === 'claude-code' ? 'app-llm' : current?.source ?? 'app-llm'); setOpen(open === 'models' ? null : 'models'); }}><span className="max-w-[180px] truncate">{label}</span><ChevronDown className="h-3 w-3 shrink-0" /></button>
    <button type="button" aria-label="调整模型思考强度" aria-expanded={open === 'effort'} disabled={disabled || !activeChoice() || !reasoning} title={reasoning ? '调整当前会话的思考强度' : '该模型预设未启用思考能力'}
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-seal hover:bg-paper-2 disabled:opacity-45"
      onClick={() => setOpen(open === 'effort' ? null : 'effort')}>{LABELS[LEVELS.indexOf(thinking)]}思考<ChevronDown className="h-3 w-3" /></button>
    {open ? <div className="absolute z-50 bottom-full left-0 mb-2 w-[min(320px,70vw)] max-h-[min(400px,60vh)] overflow-y-auto rounded-xl border border-line bg-card-bg p-3 shadow-xl" role="dialog" aria-label={open === 'models' ? '选择会话模型' : '模型思考强度'}>
      {open === 'models' ? <>
        <div className="flex gap-2 mb-2 text-xs"><button className={`px-2 py-1 rounded ${source === 'app-llm' ? 'bg-seal/10 text-seal' : 'text-ink-soft'}`} onClick={() => setSource('app-llm')}>应用提供商</button>{session?.backend !== 'claude-code' && <button className={`px-2 py-1 rounded ${source === 'pi-agent-dir' ? 'bg-seal/10 text-seal' : 'text-ink-soft'}`} onClick={() => setSource('pi-agent-dir')}>本地 Pi</button>}</div>
        <div className="max-h-60 overflow-y-auto scrollbar-thin space-y-1">
          {loading ? <p className="p-2 text-xs text-ink-faint">正在加载模型…</p> : !items.length ? <p className="p-2 text-xs text-ink-faint">{message || '尚无可用模型'}</p> : items.map((m) => <button key={key(m)} type="button" aria-label={`使用模型 ${m.label}`} disabled={saving}
            className="block w-full text-left px-2 py-2 rounded-md text-xs text-ink hover:bg-seal/10 break-words" onClick={() => void save({ source: m.source, providerId: m.providerId, modelId: m.modelId, piModel: m.piModel, thinkingLevel: m.reasoning ? thinking : 'off' })}>{m.label}</button>)}
        </div>
        <button className="mt-2 text-xs text-ink-faint hover:text-seal" onClick={() => void save(null)}><RotateCcw className="inline w-3 h-3 mr-1" />跟随应用默认</button>
      </> : <>
        <div className="flex justify-between items-center"><Zap className="w-4 h-4 text-seal" /><strong className="text-seal text-sm">{LABELS[LEVELS.indexOf(thinking)]}</strong><button aria-label="恢复默认思考强度" onClick={() => { const choice = activeChoice(); if (choice) void save({ ...choice, thinkingLevel: config?.agent?.model.thinkingLevel ?? 'off' }); }}><RotateCcw className="w-4 h-4 text-ink-faint" /></button></div>
        <p className="my-2 text-xs text-center text-ink-soft truncate">{label}</p>
        <div className="grid grid-cols-5 gap-1 rounded-full bg-paper-2 p-1" role="group" aria-label="选择思考强度">
          {LEVELS.map((level, index) => <button key={level} aria-pressed={thinking === level} aria-label={`${LABELS[index]}思考`} className={`rounded-full py-2 text-[11px] ${thinking === level ? 'bg-seal text-white' : 'text-ink-soft hover:bg-seal/10'}`} onClick={() => { const choice = activeChoice(); if (choice) void save({ ...choice, thinkingLevel: level }); }}>{LABELS[index]}</button>)}
        </div><p className="mt-2 text-[10px] text-ink-faint">仅当前会话生效；下一次发送使用所选强度。</p>
      </>}
    </div> : null}
  </div>;
}
