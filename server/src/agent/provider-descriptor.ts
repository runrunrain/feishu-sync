import { providerModelParameters } from '../modules/model-selection.js';
/**
 * app-llm 运行注入描述符（F3-R03）——单一实现。
 *
 * probe / 会话 / 构建三条链路必须注入同一形态的 provider descriptor：
 * 此前三处各写一份（字段漂移风险：probe 漏 model id、构建漏 key 语义）。
 * key 只进子进程 env（FEISHU_SYNC_AGENT_API_KEY），永不进 argv/日志/DTO。
 */

import { resolveAppLlmModel } from './runtime-resolver.js';
import { resolveProviderModel, type ResolvedProviderModel } from '../modules/model-selection.js';
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
  return appLlmRunConfigFromResolution(resolution, agent.model.thinkingLevel);
}

/**
 * T2b（B 案 §3/§8）：按冻结角色配置解析运行注入——modelPresetId/providerId
 * 引用 llm 注册表预设，thinking 取角色覆盖（缺省回落 agent 模型档位）。
 * 密钥仍只进子进程 env，不入构建记录。预设不可解析（已被删除/停用）返回
 * null，调用方按「原模型不可用，进入待处理」处理（B 案 §8）。
 */
export function buildRoleLlmRunConfig(
  llm: LlmConfig,
  agent: AgentConfig,
  role: { modelPresetId: string; providerId?: string; thinking?: string },
): AppLlmRunConfig | null {
  const hasPreset = role.modelPresetId.trim() !== '' || (role.providerId ?? '').trim() !== '';
  if (!hasPreset) return null;
  const resolution = resolveProviderModel(llm, {
    providerId: role.providerId,
    modelId: role.modelPresetId || undefined,
  });
  if (!resolution) return null;
  const thinking = role.thinking && role.thinking !== '' ? role.thinking : agent.model.thinkingLevel;
  return appLlmRunConfigFromResolution(resolution, thinking);
}

/** 由已解析预设构造运行注入（活跃预设与角色预设共用单一实现，F3-R03）。 */
function appLlmRunConfigFromResolution(
  resolution: NonNullable<ReturnType<typeof resolveProviderModel>>,
  thinking: string,
): AppLlmRunConfig {
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
      ...(resolution.protocol === 'anthropic-messages' && resolution.anthropicAuthType === 'auth-token' ? { authHeader: true } : {}),
      models: [providerModelJsonEntry(resolution, thinking)],
    }),
  };
}

/** provider descriptor 的 models[0] 条目（冻结/实时共用同一构造，
 * diting F05-R：派发用冻结值重建时不与实时解析产生形态漂移）。 */
function providerModelJsonEntry(
  preset: Pick<ResolvedProviderModel, 'openAiModel' | 'contextWindow' | 'maxTokens' | 'reasoning' | 'thinkingLevels'>,
  thinking: string,
): Record<string, unknown> {
  return {
    id: preset.openAiModel,
    ...providerModelParameters(preset, { thinkingLevel: thinking as AgentConfig['model']['thinkingLevel'] }),
    ...(preset.thinkingLevels ? { thinkingLevelMap: Object.fromEntries(
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => [level, preset.thinkingLevels!.includes(level as typeof preset.thinkingLevels[number]) ? level : null]),
    ) } : {}),
  };
}

/** diting F05-R：由冻结非密钥有效参数（ResolvedRoleModel）构造运行注入。
 * 派发时不再从实时 config 重建 providerJson——冻结面已含完整有效参数，
 * 凭据由调用方动态注入（apiKey 只进子进程 env）。冻结条目缺 baseUrl/
 * protocol（pi-agent-dir 或密钥不可用）时仅返回 model 身份。 */
export function buildFrozenRoleRunConfig(
  frozen: {
    modelId: string;
    baseUrl?: string;
    protocol?: string;
    thinking: string;
    maxTokens?: number;
    contextWindow?: number;
    reasoning?: boolean;
    thinkingLevels?: string[];
    authHeader?: boolean;
  },
  apiKey: string | undefined,
): AppLlmRunConfig {
  const model = `feishu-sync-llm/${frozen.modelId}`;
  if (!frozen.baseUrl || !frozen.protocol || !apiKey) {
    return { model };
  }
  return {
    model,
    apiKey,
    providerJson: JSON.stringify({
      baseUrl: frozen.baseUrl,
      api: frozen.protocol,
      ...(frozen.authHeader ? { authHeader: true } : {}),
      models: [providerModelJsonEntry({
        openAiModel: frozen.modelId,
        ...(frozen.contextWindow !== undefined ? { contextWindow: frozen.contextWindow } : {}),
        ...(frozen.maxTokens !== undefined ? { maxTokens: frozen.maxTokens } : {}),
        ...(frozen.reasoning !== undefined ? { reasoning: frozen.reasoning } : {}),
        ...(frozen.thinkingLevels ? { thinkingLevels: frozen.thinkingLevels as AgentConfig['model']['thinkingLevel'][] } : {}),
      }, frozen.thinking)],
    }),
  };
}
