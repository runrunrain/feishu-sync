/**
 * useAgentOrchestration —— 「任务编排」插件开关（S7，设计 kb-agent-upgrade §5.1）
 *
 * AppPluginStore 的 orchestration 条目（S6 新增，默认停用）经既有插件上下文
 * API 读写：GET /api/agent/plugin-contexts 读取 enabled + registry revision；
 * PUT /api/agent/plugin-contexts/orchestration（expectedRevision 乐观锁）切换。
 * 开关变更 → 快照 revision 变化 → 下一 run 自动换进程/换令牌（S6
 * SessionService 求值），前端无需额外失效动作。
 *
 * enabled === null 表示加载中（调用方不渲染任务区，避免开关闪烁）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { APIError, getAgentPlugins, updateAgentPlugin } from '../api/client';
import type { AgentPluginsDto } from '../types/agent-plugin';

export const ORCHESTRATION_PLUGIN_ID = 'orchestration';

/** 从插件列表提取编排开关（纯函数，供单测与 hook 共用）。未注册条目视为停用。 */
export function extractOrchestrationEnabled(
  plugins: Array<{ id: string; enabled: boolean }>,
): boolean {
  return plugins.find((p) => p.id === ORCHESTRATION_PLUGIN_ID)?.enabled === true;
}

export interface UseAgentOrchestrationResult {
  /** null = 加载中；false = 停用（任务区隐藏，仅显示启用入口）。 */
  enabled: boolean | null;
  /** 开关提交中（防双击）。 */
  busy: boolean;
  /** 加载/切换失败的信息（面板内呈现）。 */
  error: string | null;
  /** 切换开关；乐观锁冲突等失败返回 false 并置 error。 */
  toggle: (next: boolean) => Promise<boolean>;
}

export function useAgentOrchestration(active: boolean): UseAgentOrchestrationResult {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    getAgentPlugins()
      .then((data: AgentPluginsDto) => {
        if (disposed) return;
        revisionRef.current = data.revision;
        setEnabled(extractOrchestrationEnabled(data.plugins));
        setError(null);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof APIError ? err.message : '任务编排配置加载失败');
      });
    return () => {
      disposed = true;
    };
  }, [active]);

  const toggle = useCallback(async (next: boolean): Promise<boolean> => {
    const revision = revisionRef.current;
    if (!revision) return false;
    setBusy(true);
    try {
      const data = await updateAgentPlugin(ORCHESTRATION_PLUGIN_ID, revision, { enabled: next });
      revisionRef.current = data.revision;
      setEnabled(extractOrchestrationEnabled(data.plugins));
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof APIError ? err.message : '任务编排开关更新失败，请重试');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { enabled, busy, error, toggle };
}
