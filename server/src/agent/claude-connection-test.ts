import type { Config } from '../types/index.js';
import type { AgentProcessPool } from './agent-process-pool.js';
import { ToolError, type AgentToolService } from './agent-tool-service.js';
import type { PiRuntimeResolver } from './runtime-resolver.js';
import { createClaudeProcess } from './claude-process-factory.js';
import { resolveClaudeProvider } from './claude-runtime.js';

export interface ClaudeConnectionTestResult {
  ok: boolean;
  providerName: string;
  model: string;
  latencyMs: number;
  errorMessage?: string;
}

/** Exercise the production adapter with a fixed prompt, no tools or user documents. */
export async function testClaudeConnection(input: {
  config: Config;
  dataRoot: string;
  internalBaseUrl: string;
  resolver: PiRuntimeResolver;
  pool: AgentProcessPool;
  toolService: AgentToolService;
}): Promise<ClaudeConnectionTestResult> {
  const { config, resolver, toolService } = input;
  const probeConfig: Config = { ...config, agent: { ...config.agent,
    runtime: { ...config.agent.runtime, backend: 'claude-code' },
    model: { ...config.agent.model, source: 'app-llm' },
  } };
  const provider = resolveClaudeProvider(probeConfig.llm, probeConfig.agent);
  const slot = input.pool.reserveSlot('probe');
  if (!slot) throw new ToolError('agent_busy', 'Agent 并发已达上限，请稍后测试', 409);
  const started = Date.now();
  let token: string | null = null;
  let rpc: ReturnType<typeof createClaudeProcess> | null = null;
  const result = { providerName: provider?.providerName ?? '', model: provider?.openAiModel ?? '' };
  const redact = (value: string) => {
    let safe = value;
    for (const secret of [provider?.apiKey, token]) if (secret) safe = safe.replaceAll(secret, '[redacted]');
    return safe.slice(0, 500);
  };
  try {
    const runtime = await resolver.resolveRuntime(probeConfig.agent);
    if (!runtime.nodePath) throw new Error('Claude Code 工具桥需要 Node ≥22.19');
    token = toolService.createRunContext({ runKind: 'probe', outputRoot: config.standardKb.outputRoot, knowledgeBaseRoot: config.knowledgeBaseRoot }).token;
    rpc = createClaudeProcess({ config: probeConfig, nodePath: runtime.nodePath, token, sessionId: `connection-test-${Date.now()}`,
      dataRoot: input.dataRoot, internalBaseUrl: input.internalBaseUrl, toolService, ephemeral: true, timeoutMs: 30_000 });
    await rpc.start();
    const outcome = await rpc.prompt('Reply with exactly OK. Do not use tools.', { timeoutMs: 30_000 });
    const ok = outcome.outcome === 'completed' && Boolean(outcome.lastAssistantText?.trim());
    return { ...result, ok, latencyMs: Date.now() - started,
      ...(!ok ? { errorMessage: redact(outcome.error?.message ?? 'Claude Code 未返回有效回复') } : {}) };
  } catch (error) {
    return { ...result, ok: false, latencyMs: Date.now() - started, errorMessage: redact(error instanceof Error ? error.message : String(error)) };
  } finally {
    try { await rpc?.terminate(); }
    finally { if (token) toolService.revokeToken(token); slot.release(); }
  }
}
