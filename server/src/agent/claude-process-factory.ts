import path from 'node:path';
import { ClaudeCodeProcess } from './claude-code-process.js';
import { claudeBridgePath } from './agent-assets.js';
import { resolveClaudeCodePath, resolveClaudeProvider } from './claude-runtime.js';
import { ToolError, type AgentToolService } from './agent-tool-service.js';
import { providerModelParameters } from '../modules/model-selection.js';
import type { Config } from '../types/index.js';
import type { AppPluginSnapshot } from './app-plugin-store.js';

export function createClaudeProcess(options: {
  config: Config; nodePath: string; token: string; sessionId: string; dataRoot: string;
  internalBaseUrl: string; toolService: AgentToolService; pluginSnapshot?: AppPluginSnapshot;
  sessionDir?: string; timeoutMs?: number;
  ephemeral?: boolean;
}): ClaudeCodeProcess {
  const provider = resolveClaudeProvider(options.config.llm, options.config.agent);
  const executable = resolveClaudeCodePath(options.config.agent.runtime.claudeCliPath);
  const bridgePath = claudeBridgePath();
  if (!provider?.apiKey || provider.protocol !== 'anthropic-messages' || !executable || !bridgePath) {
    throw new ToolError('agent_not_ready', 'Claude Code 需要可执行文件以及已配置密钥的 Anthropic 兼容模型', 503);
  }
  if (provider.reasoning && options.config.agent.model.thinkingLevel === 'minimal') {
    throw new ToolError('agent_not_ready', 'Claude Code 不支持最低思考档位，请选择该模型支持的档位', 400);
  }
  const specs = options.toolService.getToolSpecsForToken(options.token);
  if (!specs) throw new ToolError('agent_not_ready', 'Agent 工具运行上下文已失效', 503);
  return new ClaudeCodeProcess({ executable, nodePath: options.nodePath, bridgePath,
    cwd: path.join(options.dataRoot, 'agent', 'empty-cwd'),
    sessionDir: options.sessionDir ?? path.join(options.dataRoot, 'agent', 'sessions'), sessionId: options.sessionId,
    tools: specs.map((spec) => spec.name), model: provider.openAiModel, baseUrl: provider.baseUrl, apiKey: provider.apiKey,
    thinking: provider.reasoning ? options.config.agent.model.thinkingLevel : 'off',
    contextWindow: providerModelParameters(provider, options.config.agent.model).contextWindow,
    maxTokens: providerModelParameters(provider, options.config.agent.model).maxTokens,
    agentUrl: options.internalBaseUrl, runToken: options.token, parentEnv: process.env, pluginSnapshot: options.pluginSnapshot,
    promptTimeoutMs: options.timeoutMs ?? options.config.standardKb.promptTimeoutMinutes * 60_000, ephemeral: options.ephemeral });
}
