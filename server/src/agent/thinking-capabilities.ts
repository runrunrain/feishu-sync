import type { AgentThinkingLevel } from '../types/agent-knowledge.js';

export const THINKING_LEVELS: AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const STANDARD = new Set<AgentThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high']);

/** Pi's model registry declares standard levels implicitly and extended levels explicitly. */
export function piThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }): AgentThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  const map = model.thinkingLevelMap ?? {};
  return THINKING_LEVELS.filter((level) => Object.hasOwn(map, level) ? map[level] !== null && map[level] !== undefined : STANDARD.has(level));
}

export function configuredThinkingLevels(levels: AgentThinkingLevel[] | undefined, reasoning: boolean | undefined, backend: 'pi' | 'claude-code'): AgentThinkingLevel[] | null {
  if (!reasoning) return ['off'];
  if (!levels) return null;
  const allowed = backend === 'claude-code' ? THINKING_LEVELS.filter((level) => level !== 'minimal') : THINKING_LEVELS;
  return allowed.filter((level) => level === 'off' || levels.includes(level));
}
