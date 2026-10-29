import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getConfig, saveConfig, type ConfigUpdate } from '../api/client';
import type { Config } from '../types';

type DraftForm = () => ConfigUpdate | null;
export interface SettingsDraft {
  config: Config | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  saveError: string | null;
  saveMessage: string | null;
  conflict: 'watchedRoots' | 'providers' | null;
  dirty: boolean;
  updateConfig: (patch: ConfigUpdate) => Promise<Config | undefined>;
  refresh: () => Promise<void>;
  loadConfig: () => Promise<void>;
  register: (id: string, form: DraftForm) => () => void;
  markFormDirty: (id: string, dirty: boolean) => void;
  stageAction: (id: string, action: (() => Promise<void>) | null) => void;
  stageForm: (id: string) => void;
  save: () => Promise<void>;
  allowConflictOverwrite: () => Promise<void>;
}

export const SettingsDraftContext = createContext<SettingsDraft | null>(null);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Arrays are authoritative lists; object fields merge independently. */
export function mergeDraft<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return patch as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isObject(value) && isObject(result[key]) ? mergeDraft(result[key], value) : value;
  }
  return result as T;
}

const UNCHANGED = Symbol('unchanged');
function changedFields(base: unknown, next: unknown): unknown {
  if (Object.is(base, next)) return UNCHANGED;
  if (isObject(base) && isObject(next)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      const difference = changedFields(base[key], value);
      if (difference !== UNCHANGED) result[key] = difference;
    }
    return Object.keys(result).length ? result : UNCHANGED;
  }
  if (Array.isArray(base) && Array.isArray(next) && JSON.stringify(base) === JSON.stringify(next)) return UNCHANGED;
  return next;
}

/** Register a pure snapshot/validation callback; it never writes to the server. */
export function useSettingsForm(id: string, form: DraftForm): boolean {
  const context = useContext(SettingsDraftContext);
  const formRef = useRef(form);
  formRef.current = form;
  const register = context?.register;
  const markFormDirty = context?.markFormDirty;
  useEffect(() => register?.(id, () => formRef.current()), [id, register]);
  useEffect(() => {
    if (!markFormDirty) return;
    try { markFormDirty(id, form() !== null); } catch { markFormDirty(id, true); }
  });
  return Boolean(context);
}

export function useSettingsDraft(): SettingsDraft | null {
  return useContext(SettingsDraftContext);
}

export function SettingsDraftProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<'watchedRoots' | 'providers' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [dirtyForms, setDirtyForms] = useState<Record<string, boolean>>({});
  const dirtyFormsRef = useRef<Record<string, boolean>>({});
  const [actionCount, setActionCount] = useState(0);
  const configRef = useRef<Config | null>(null);
  const baselineRef = useRef<Config | null>(null);
  const patchRef = useRef<ConfigUpdate>({});
  const forms = useRef(new Map<string, DraftForm>());
  const actions = useRef(new Map<string, () => Promise<void>>());
  const saveLock = useRef(false);
  const hasUnsaved = useCallback(() => Boolean(Object.keys(patchRef.current).length || Object.values(dirtyFormsRef.current).some(Boolean) || actions.current.size), []);

  const loadConfig = useCallback(async () => {
    // Refreshes from other cards must never reset an unsaved local form.
    // The latest server state is merged again at commit time.
    if (configRef.current && hasUnsaved()) return;
    setLoading(true);
    try {
      const fresh = await getConfig();
      if (configRef.current && hasUnsaved()) return;
      const next = mergeDraft(fresh, patchRef.current);
      baselineRef.current = fresh; configRef.current = next; setConfig(next); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : '读取配置失败'); }
    finally { setLoading(false); }
  }, [hasUnsaved]);
  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => {
    const onUpdated = () => { void loadConfig(); };
    window.addEventListener('feishu-sync:config-updated', onUpdated);
    return () => window.removeEventListener('feishu-sync:config-updated', onUpdated);
  }, [loadConfig]);

  const apply = useCallback((patch: ConfigUpdate) => {
    if (!configRef.current) return undefined;
    const changed = changedFields(configRef.current, patch);
    if (changed === UNCHANGED) return configRef.current;
    patchRef.current = mergeDraft(patchRef.current, changed);
    const next = mergeDraft(configRef.current, patch);
    configRef.current = next; setConfig(next); setDirty(true); setSaveError(null); setSaveMessage(null);
    return next;
  }, []);
  const updateConfig = useCallback(async (patch: ConfigUpdate) => apply(patch), [apply]);
  const register = useCallback((id: string, form: DraftForm) => {
    forms.current.set(id, form);
    return () => { if (forms.current.get(id) === form) forms.current.delete(id); delete dirtyFormsRef.current[id]; setDirtyForms((prev) => { if (!prev[id]) return prev; const next = { ...prev }; delete next[id]; return next; }); };
  }, []);
  const markFormDirty = useCallback((id: string, value: boolean) => {
    const wasDirty = Boolean(dirtyFormsRef.current[id]);
    dirtyFormsRef.current[id] = value;
    setDirtyForms((prev) => Boolean(prev[id]) === value ? prev : { ...prev, [id]: value });
    if (value && !wasDirty) setSaveMessage(null);
  }, []);
  const stageAction = useCallback((id: string, action: (() => Promise<void>) | null) => {
    if (action) actions.current.set(id, action); else actions.current.delete(id);
    setActionCount(actions.current.size);
    if (action) setSaveMessage(null);
  }, []);
  const stageForm = useCallback((id: string) => {
    try { const patch = forms.current.get(id)?.(); if (patch) apply(patch); }
    catch { /* Keep invalid form state; validation is shown on Save. */ }
  }, [apply]);
  const allowConflictOverwrite = useCallback(async () => {
    if (saveLock.current || !conflict) return;
    saveLock.current = true; setSaving(true);
    try {
      const latest = await getConfig();
      const baseline = baselineRef.current;
      if (!baseline) throw new Error('缺少原始配置，请重新加载设置');
      baselineRef.current = conflict === 'providers'
        ? { ...baseline, llm: { ...baseline.llm, providers: latest.llm.providers } }
        : { ...baseline, watchedRoots: latest.watchedRoots };
      setConflict(null); setSaveError(null);
      setSaveMessage('已允许覆盖该类设置；再次点击保存后生效');
    } catch (err) { setSaveError(err instanceof Error ? err.message : '无法读取最新设置'); }
    finally { saveLock.current = false; setSaving(false); }
  }, [conflict]);

  const save = useCallback(async () => {
    if (!configRef.current || saveLock.current) return;
    saveLock.current = true; setSaving(true); setSaveError(null); setSaveMessage(null); setConflict(null);
    try {
      let patch = patchRef.current;
      // Collect and validate all visited forms before committing anything.
      for (const form of forms.current.values()) {
        const value = form();
        if (value) {
          const changed = changedFields(configRef.current, value);
          if (changed !== UNCHANGED) patch = mergeDraft(patch, changed);
        }
      }
      if (Object.keys(patch).length) {
        patchRef.current = patch; setDirty(true);
        // Merge touched sections over fresh server state. Agent's nested
        // sections are replaced on the server, so send their complete values.
        const latest = await getConfig();
        const baseline = baselineRef.current;
        if (baseline && patch.watchedRoots && JSON.stringify(latest.watchedRoots) !== JSON.stringify(baseline.watchedRoots)) {
          setConflict('watchedRoots');
          throw new Error('同步根目录已被其他操作更改；保存草稿会替换对方对该列表的修改');
        }
        if (baseline && patch.llm?.providers && JSON.stringify(latest.llm.providers) !== JSON.stringify(baseline.llm.providers)) {
          setConflict('providers');
          throw new Error('模型提供商已被其他操作更改；保存草稿会替换对方对该列表的修改');
        }
        const merged = mergeDraft(latest, patch);
        const outbound = { ...patch } as ConfigUpdate;
        if (patch.agent) outbound.agent = merged.agent;
        if (patch.standardKb) outbound.standardKb = merged.standardKb;
        const saved = await saveConfig(outbound);
        patchRef.current = {}; baselineRef.current = saved; configRef.current = saved; setConfig(saved); setDirty(false);
        window.dispatchEvent(new CustomEvent('feishu-sync:config-updated'));
      }
      for (const [id, action] of actions.current) {
        try { await action(); actions.current.delete(id); setActionCount(actions.current.size); }
        catch (err) { throw new Error(`其他配置可能已保存；${id}失败：${err instanceof Error ? err.message : '请重试'}`); }
      }
      setSaveMessage('设置已保存');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存设置失败');
    } finally { saveLock.current = false; setSaving(false); }
  }, []);

  const value = useMemo<SettingsDraft>(() => ({ config, loading, error, saving, saveError, saveMessage, conflict, dirty: dirty || actionCount > 0 || Object.values(dirtyForms).some(Boolean), updateConfig, refresh: loadConfig, loadConfig, register, markFormDirty, stageAction, stageForm, save, allowConflictOverwrite }),
    [config, loading, error, saving, saveError, saveMessage, conflict, dirty, actionCount, dirtyForms, updateConfig, loadConfig, register, markFormDirty, stageAction, stageForm, save, allowConflictOverwrite]);
  return <SettingsDraftContext.Provider value={value}>{children}</SettingsDraftContext.Provider>;
}
