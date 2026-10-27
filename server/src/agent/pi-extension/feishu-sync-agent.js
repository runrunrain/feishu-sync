/**
 * feishu-sync-agent — pi 纯转发扩展（设计 §9.7）
 *
 * 加载于外部 Node ≥22.19 的 pi 进程内。职责严格限定为转发：
 *   1. 启动时 GET /api/agent-internal/tools 取本运行允许的工具规格并
 *      registerTool（参数用 server 下发的纯 JSON Schema）。
 *   2. app-llm 模式下解析 FEISHU_SYNC_AGENT_PROVIDER_JSON 并
 *      registerProvider（apiKey 只经 $FEISHU_SYNC_AGENT_API_KEY 环境变量
 *      插值，不落日志）。
 *   3. tool_call 钩子对非本扩展注册的工具一律 block（fail closed）。
 *   4. 工具 execute → POST /api/agent-internal/tools/:name。
 *
 * 只用 Node 内置模块与全局 fetch；对 pi 只做类型层面依赖（本地最小
 * ExtensionAPI 接口声明），保证 server 的 tsc 无需安装 pi。
 */

'use strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{ registerTool(tool: any): void; registerProvider(name: string, config: any): void; on(event: 'tool_call', handler: (event: any) => any): void; getAllTools(): any[]; }} ExtensionAPI */

const AGENT_URL = process.env.FEISHU_SYNC_AGENT_URL || '';
const RUN_TOKEN = process.env.FEISHU_SYNC_AGENT_RUN_TOKEN || '';
const API_KEY_ENV = 'FEISHU_SYNC_AGENT_API_KEY';
const PROVIDER_JSON = process.env.FEISHU_SYNC_AGENT_PROVIDER_JSON || '';

function log(...args) {
  // stderr：pi 保留 stdout 给 JSONL 协议
  console.error('[feishu-sync-agent]', ...args);
}

async function apiGet(path) {
  const response = await fetch(`${AGENT_URL}${path}`, {
    headers: { 'X-Agent-Run-Token': RUN_TOKEN },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET ${path} -> ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function apiPost(path, payload) {
  const response = await fetch(`${AGENT_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Run-Token': RUN_TOKEN,
    },
    body: JSON.stringify(payload),
  });
  // body 只读一次（text 后再调 json() 会报 Body already read）
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    let code = `http_${response.status}`;
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      code = parsed.error || code;
      message = parsed.message || message;
    } catch {
      /* 非 JSON 错误体 */
    }
    const error = new Error(`${code}: ${message}`);
    error.toolCode = code;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`tool_response_invalid: 响应不是 JSON（${text.slice(0, 200)}）`);
  }
}

export default async function feishuSyncAgentExtension(/** @type {ExtensionAPI} */ pi) {
  if (!AGENT_URL || !RUN_TOKEN) {
    throw new Error('缺少 FEISHU_SYNC_AGENT_URL / FEISHU_SYNC_AGENT_RUN_TOKEN 环境变量（宿主未注入）');
  }

  // 借助Pi原生模型运行时只读复用认证与models.json，不复制密钥，不写通用Pi。
  const sharedHome = process.env.FEISHU_SYNC_AGENT_SHARED_PI_HOME;
  const piRoot = process.env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT;
  if (sharedHome && piRoot) {
    const load = (name) => import(pathToFileURL(path.join(piRoot, 'dist/core', name + '.js')).href);
    const { ModelRuntime } = await load('model-runtime');
    const { ReadOnlyAuthStorage } = await load('auth-storage');
    const models = await ModelRuntime.create({
      credentials: new ReadOnlyAuthStorage(path.join(sharedHome, 'auth.json')),
      modelsPath: path.join(sharedHome, 'models.json'),
      modelsStorePath: path.join(process.env.PI_CODING_AGENT_DIR, 'shared-models-store.json'),
      allowModelNetwork: false,
    });
    for (const provider of models.getProviders()) pi.registerProvider(provider);
  }

  // app-llm：注册 OpenAI 兼容 provider（key 只经环境变量插值）
  if (PROVIDER_JSON) {
    const descriptor = JSON.parse(PROVIDER_JSON);
    pi.registerProvider('feishu-sync-llm', {
      name: 'feishu-sync LLM',
      baseUrl: descriptor.baseUrl,
      apiKey: `$${API_KEY_ENV}`,
      api: 'openai-completions',
      models: (descriptor.models || []).map((model) => ({
        type: 'chat',
        id: model.id,
        name: model.name || model.id,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow || 128000,
        maxTokens: model.maxTokens || 8192,
      })),
    });
    log(`provider feishu-sync-llm registered (${(descriptor.models || []).length} model(s), baseUrl=${descriptor.baseUrl})`);
  }

  // 拉取本运行的工具规格并注册
  const specs = await apiGet('/api/agent-internal/tools');
  if (!Array.isArray(specs) || specs.length === 0) {
    log('no tools registered for this run (probe run expected)');
  }
  const selfTools = new Set();
  for (const spec of specs) {
    selfTools.add(spec.name);
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      // pi 工具 execute 签名：execute(toolCallId, args, signal, onUpdate, ctx)
      //（与内置 read 工具一致：首个参数是 toolCallId，第二才是参数对象）
      execute: async (toolCallId, args) => {
        const result = await apiPost(`/api/agent-internal/tools/${encodeURIComponent(spec.name)}`, {
          toolCallId: typeof toolCallId === 'string' ? toolCallId : '',
          args: args && typeof args === 'object' ? args : {},
        });
        return result;
      },
    });
  }
  log(`registered ${selfTools.size} tool(s): ${[...selfTools].join(', ') || '(none)'}`);

  // 仅显式安装并启用的扩展可提供额外工具。Pi内置shell/文件工具仍不开放。
  const external = () => new Set(process.env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS === '1'
    ? pi.getAllTools().filter((tool) => tool.sourceInfo?.path && !tool.sourceInfo.path.startsWith('builtin:')).map((tool) => tool.name)
    : []);
  pi.on('session_start', () => {
    if (process.env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS === '1') pi.setActiveTools([...new Set([...selfTools, ...external()])]);
  });
  pi.on('tool_call', (event) => {
    const name = event && event.toolName;
    if (typeof name === 'string' && (selfTools.has(name) || external().has(name))) return undefined;
    return { block: true, reason: `工具 ${name} 未由应用或已启用插件提供` };
  });
}
