/**
 * 运行时模型探测（设计 §3.2）
 *
 * 启动一次短命 pi RPC 进程（--no-session --no-tools --offline），发
 * get_state + get_available_models，确认目标模型在列表内即 ready。
 * 不发 prompt、不消耗额度。端点可达性只能在真实调用时得知。
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildPiProcessEnv, PiRpcProcess } from './pi-rpc-process.js';
import { piExtensionPath } from './agent-assets.js';
import { buildAppLlmRunConfig } from './provider-descriptor.js';
import type { ResolvedRuntime } from './runtime-resolver.js';
import type { Config } from '../types/index.js';

export interface ProbeInput {
  runtime: ResolvedRuntime;
  config: Config;
  dataRoot: string;
  internalBaseUrl: string;
  /** 登记探测运行令牌（app-llm 需要扩展拉取 /tools 与注册 provider）。 */
  registerProbeContext?: () => string;
  revokeProbeContext?: (token: string) => void;
}

export interface ProbeResult {
  ok: boolean;
  stderr?: string;
  available: string[];
}

/**
 * 探测可用模型列表。app-llm 模式注入 provider 环境（key 只进子进程环境）；
 * pi-agent-dir 模式继承宿主环境（剔除 FEISHU_SYNC_AGENT_* / NODE_OPTIONS）
 * 并使用本机 ~/.pi/agent 凭据。
 */
export async function probeAvailableModels(input: ProbeInput): Promise<ProbeResult> {
  const { runtime, config, dataRoot, internalBaseUrl } = input;
  if (!runtime.nodePath || !runtime.piCliPath) {
    return { ok: false, available: [] };
  }
  // 探测运行令牌：经 registerProbeContext 正规登记（probe 运行：0 工具）。
  // app-llm 模式扩展需要有效令牌 GET /tools 后注册 provider；pi-agent-dir
  // 模式不需要扩展（直接读本机凭据目录的模型列表）。
  const registeredToken = input.registerProbeContext?.();
  const probeToken = registeredToken ?? `probe_invalid_${Math.random().toString(36).slice(2)}`;
  const loadExtension = Boolean(input.registerProbeContext);
  let providerJson: string | undefined;
  let apiKey: string | undefined;
  if (config.agent.model.source === 'app-llm') {
    const runConfig = buildAppLlmRunConfig(config.llm, config.agent);
    apiKey = runConfig?.apiKey;
    providerJson = runConfig?.providerJson;
  }
  const env = buildPiProcessEnv({
    mode: config.agent.model.source,
    parentEnv: process.env,
    dataRoot,
    agentUrl: internalBaseUrl,
    runToken: probeToken,
    apiKey,
  });
  if (providerJson) {
    env.FEISHU_SYNC_AGENT_PROVIDER_JSON = providerJson;
  }

  env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot ?? '';
  const rpc = new PiRpcProcess({
    nodePath: runtime.nodePath,
    piCliPath: runtime.piCliPath,
    ...(loadExtension && piExtensionPath() ? { extensionPath: piExtensionPath()! } : {}),
    tools: [],
    noSession: true,
    noTools: true,
    cwd: (() => {
      const dir = path.join(dataRoot, 'agent', 'empty-cwd');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    })(),
    env,
    promptTimeoutMs: 30_000,
  });
  const stderrChunks: string[] = [];
  rpc.on('stderr', (chunk: string) => stderrChunks.push(chunk));
  try {
    await rpc.start(20_000);
    const { models } = await rpc.probeState();
    return { ok: true, available: models, stderr: stderrChunks.join('').slice(-2000) };
  } catch (error) {
    return {
      ok: false,
      available: [],
      stderr: `${String(error)}\n${stderrChunks.join('').slice(-2000)}`,
    };
  } finally {
    await rpc.terminate();
    if (registeredToken) input.revokeProbeContext?.(registeredToken);
  }
}
