import { providerModelParameters } from '../modules/model-selection.js';
/**
 * app-llm 运行注入描述符（F3-R03）——单一实现。
 *
 * probe / 会话 / 构建三条链路必须注入同一形态的 provider descriptor：
 * 此前三处各写一份（字段漂移风险：probe 漏 model id、构建漏 key 语义）。
 * key 只进子进程 env（FEISHU_SYNC_AGENT_API_KEY），永不进 argv/日志/DTO。
 */

import { resolveAppLlmModel } from './runtime-resolver.js';
import type { AgentConfig } from '../types/agent-knowledge.js';
import type { LlmConfig } from '../types/index.js';
export interface AppLlmRunConfig {
  /** pi 内使用的模型 id（扩展注册 provider 后可用） */
  model: string;
  /** 协议、baseUrl 与模型预设等 provider 描述（JSON 字符串） */
  providerJson?: string;
  /** 只进子进程环境变量，不落 argv/日志 */
  apiKey?: string;
}

/**
 * 解析 app-llm 运行注入。返回 null 表示 provider/model 未解析成功
 * （调用方自行决定 agent_not_ready 错误）；resolved 但缺 key 时返回
 * 带 model 无 providerJson 的对象——probe 场景 key 缺失仍可拉模型列表。
 */
export function buildAppLlmRunConfig(
  llm: LlmConfig,
  agent: AgentConfig,
): AppLlmRunConfig | null {
  const resolution = resolveAppLlmModel(llm, agent);
  if (!resolution) return null;
  const model = `feishu-sync-llm/${resolution.openAiModel}`;
  if (!resolution.apiKey) {
    return { model };
  }
  return {
    model,
    apiKey: resolution.apiKey,
    providerJson: JSON.stringify({
      baseUrl: resolution.baseUrl,
      api: resolution.protocol,
      models: [{
        id: resolution.openAiModel,
        ...providerModelParameters(resolution, agent.model),
      }],
    }),
  };
}
