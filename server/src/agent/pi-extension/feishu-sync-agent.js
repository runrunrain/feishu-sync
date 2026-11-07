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
 * 构建模式（设计 v2 §3.4，宿主显式传入 FEISHU_SYNC_AGENT_BUILD_SPEC_JSON +
 * FEISHU_SYNC_BUILD_GUARD_MODULE 才激活；普通会话零行为变化，不挂守卫）：
 *   - 白名单收窄：session_start 激活集合与 tool_call 放行集合同为 spec.tools
 *     （amagi 任务/资源工具 + 应用构建 Leader 工具）；绝不沿用
 *     FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS 的外部插件全量放行开关。
 *   - 应用 task 工具族（task_submit/task_query/task_resume/task_cancel，见
 *     tool-specs.ts TASK_TOOL_NAMES）不再由本扩展注册——构建 Leader 由 amagi-core
 *     提供同名任务工具，双方同时注册 pi 以 error 诊断退出（设计 §1.2 工具重名）。
 *   - task_submit/task_resume 派发参数守卫：策略全部委托运行时底座的
 *     build-runtime/dispatch-guard 模块（唯一权限引擎，不在本扩展内复制）：
 *     宿主注入模块绝对路径，扩展 dynamic import（jiti 支持源码 .ts；生产为编译 JS），
 *     按 Pi tool_call 契约把守卫产物【原地写回 event.input】（mutate in place，
 *     修改后不重校验，执行时参数即修改后参数），非法角色/越界模型覆盖直接 block。
 *     守卫审计（DispatchGuardAudit）以单行 JSON 写 stderr。
 *   - F12 派发前运行期完整性重核验：每次 task_submit/task_resume 先经
 *     guardApi.verifyRuntimeIntegrity（磁盘冻结面 vs 信封冻结引用：四配置/
 *     child-policy/包全量哈希）+ Leader agentDir 一致性核对，不 ok 即 block——
 *     防 Leader 启动后 policy 缺失/settings 资源注入被静默跳过（Pi 对
 *     settings 缺失扩展静默 skip 已实测复现）。
 *
 * 构建环境契约（两个 env 都必填；字段由集成方与 build-runtime 配置契约对齐）：
 *   FEISHU_SYNC_BUILD_GUARD_MODULE = <dispatch-guard 模块绝对路径>
 *     （生产 server/dist/agent/build-runtime/dispatch-guard.js；开发/测试源码 .ts 由 jiti 加载）
 *   FEISHU_SYNC_AGENT_BUILD_SPEC_JSON = {
 *     "tools": string[],                // Leader 白名单；必含 task_submit（守卫锚点）
 *     "guard": FrozenDispatchConfig     // 原样交 dispatch-guard validateGuardConfig 校验
 *   }
 *   （FrozenDispatchConfig 形状见 build-runtime/dispatch-guard.ts：schemaVersion/buildId/
 *     generation/workDir/reportRoot/forbiddenZones/roles{amagiAgent→{key,models[],mcpTools[]}}；
 *     角色模型为精确名单：覆盖值必须逐字命中本角色 models，含 thinking 档位）
 *
 * Bearer 模式按需复用已安装 Pi 的 Anthropic 适配器；server 的 tsc
 * 不需要安装 Pi。
 */

'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { registerConfiguredModels } from './configured-models.js';

/** @typedef {{ registerTool(tool: any): void; registerProvider(name: string, config: any): void; on(event: string, handler: (event: any, ctx: any) => any): void; getAllTools(): any[]; }} ExtensionAPI */

const AGENT_URL = process.env.FEISHU_SYNC_AGENT_URL || '';
const RUN_TOKEN = process.env.FEISHU_SYNC_AGENT_RUN_TOKEN || '';
const API_KEY_ENV = 'FEISHU_SYNC_AGENT_API_KEY';
const PROVIDER_JSON = process.env.FEISHU_SYNC_AGENT_PROVIDER_JSON || '';
const BUILD_SPEC_JSON = process.env.FEISHU_SYNC_AGENT_BUILD_SPEC_JSON || '';
const BUILD_GUARD_MODULE = process.env.FEISHU_SYNC_BUILD_GUARD_MODULE || '';
// F12：Leader agentDir 在模块装载时快照（真实 pi 进程 env 装载前已定且全程稳定；
// 与 BUILD_SPEC_JSON 等其他 env 同一读取时机，避免工厂调用时点差异）。
const AGENT_DIR_AT_LOAD = process.env.PI_CODING_AGENT_DIR || '';

/** 应用 task 工具族（tool-specs.ts TASK_TOOL_NAMES）：构建模式绝不由本扩展注册。 */
const APP_TASK_TOOL_FAMILY = new Set(['task_submit', 'task_query', 'task_resume', 'task_cancel']);
const NATIVE_WORK = process.env.FEISHU_SYNC_AGENT_WORK_MODE === 'native';

function withoutImageBlocks(messages) {
  let changed = false;
  const filtered = messages.map((message) => {
    if (!Array.isArray(message.content) || !message.content.some((block) => block.type === 'image')) return message;
    changed = true;
    return { ...message, content: [
      ...message.content.filter((block) => block.type !== 'image'),
      { type: 'text', text: '[当前模型仅接收文本，本条消息中的图片未发送给模型。]' },
    ] };
  });
  return changed ? filtered : messages;
}

function rejectsImageInput(message) {
  return /(?:does not support|unsupported|not supported)[^\n.]{0,80}(?:image|vision)|(?:image|vision)[^\n.]{0,80}(?:not supported|unsupported)|不支持[^\n。]{0,40}(?:图片|图像)|content(?:\[\d+\])?\.type[^\n]{0,120}\[\s*['"]text['"]\s*\]/i.test(message ?? '');
}

async function appProviderStream(piRoot, api, bearerAuth) {
  const resolver = createRequire(path.join(piRoot, 'package.json'));
  const dist = (resolver.resolve.paths('@earendil-works/pi-ai') ?? [])
    .map((dir) => path.join(dir, '@earendil-works', 'pi-ai', 'dist'))
    .find((dir) => fs.existsSync(path.join(dir, 'api', `${api}.js`)));
  if (!dist) throw new Error('Pi 运行时缺少应用模型适配器');
  const [{ streamSimple }, { createAssistantMessageEventStream }] = await Promise.all([
    import(pathToFileURL(path.join(dist, 'api', `${api}.js`)).href),
    import(pathToFileURL(path.join(dist, 'utils', 'event-stream.js')).href),
  ]);
  const textOnly = new Set();
  return (model, context, options) => {
    // Anthropic Bearer auth already has Authorization from Pi's authHeader.
    const requestOptions = bearerAuth ? { ...options, apiKey: undefined } : options;
    const messages = withoutImageBlocks(context.messages);
    if (messages === context.messages) return streamSimple(model, context, requestOptions);
    const textContext = { ...context, messages };
    if (textOnly.has(model.id)) return streamSimple(model, textContext, requestOptions);
    const initial = streamSimple(model, context, requestOptions);
    const output = createAssistantMessageEventStream();
    void (async () => {
      let started = false;
      for await (const event of initial) {
        if (event.type === 'error' && !started && !options?.signal?.aborted && rejectsImageInput(event.error.errorMessage)) {
          textOnly.add(model.id);
          let retry;
          try { retry = streamSimple(model, textContext, requestOptions); }
          catch { output.push(event); return; }
          for await (const retryEvent of retry) output.push(retryEvent);
          output.end(await retry.result());
          return;
        }
        if (event.type === 'start') started = true;
        output.push(event);
      }
      output.end(await initial.result());
    })();
    return output;
  };
}

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

// ── 构建模式接线（策略唯一来源：运行时底座 build-runtime/dispatch-guard；本扩展只做装载与事件接线）──

/** 运行时 dispatch-guard 模块需要的导出面（guardTaskSubmit/guardTaskResume/validateGuardConfig）。 */
const REQUIRED_GUARD_EXPORTS = ['guardTaskSubmit', 'guardTaskResume', 'validateGuardConfig'];

/** F12 运行期完整性核验模块需要的导出面（与 guard 模块同目录装载，独立单文件依赖约束）。 */
const REQUIRED_INTEGRITY_EXPORTS = ['verifyRuntimeIntegrity', 'validateRuntimeIntegrityRefs'];

/** amagi-package 需要的导出面（全量包哈希 walker，注入 verifyRuntimeIntegrity）。 */
const REQUIRED_AMAGI_EXPORTS = ['computePackageContentHash'];

/** 由 FEISHU_SYNC_BUILD_GUARD_MODULE 推导同目录姊妹模块路径（保持 .ts/.js 后缀）。 */
function deriveSiblingModulePath(guardModulePath, sibling) {
  return guardModulePath.replace(/dispatch-guard(\.[cm]?js|\.ts)$/, `${sibling}$1`);
}

async function loadModuleAtPath(modulePath, label, requiredExports) {
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new Error(`${label} 模块加载失败（${modulePath}）：${error instanceof Error ? error.message : String(error)}`);
  }
  const missing = requiredExports.filter((name) => typeof mod[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`${label} 模块缺少导出：${missing.join(', ')}（${modulePath}）`);
  }
  return mod;
}

/**
 * 解析构建 spec 信封：{ tools, guard }。只校验扩展自身的白名单字段；
 * guard 的全部语义校验委托运行时 validateGuardConfig（不在本文件复制权限逻辑）。
 * @returns {{ tools: string[]; guard: object }}
 * @throws Error（fail closed：任何字段不合法拒绝启动）
 */
export function parseBuildSpecEnvelope(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('spec 必须是 JSON 对象（{ tools, guard }）');
  }
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    throw new Error('tools 必须是非空字符串数组（Leader 白名单）');
  }
  const seen = new Set();
  for (const name of parsed.tools) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('tools 条目必须是非空字符串');
    if (seen.has(name)) throw new Error(`tools 含重复项 ${name}`);
    seen.add(name);
  }
  if (!parsed.tools.includes('task_submit')) {
    throw new Error('tools 必须包含 task_submit（派发守卫锚点；缺它 Leader 无法派发）');
  }
  if (!parsed.guard || typeof parsed.guard !== 'object' || Array.isArray(parsed.guard)) {
    throw new Error('guard 必须是对象（FrozenDispatchConfig，交运行时 dispatch-guard 校验）');
  }
  return { tools: [...parsed.tools], guard: parsed.guard };
}

/**
 * 装载运行时 dispatch-guard 模块（宿主注入绝对路径；jiti 支持源码 .ts，生产为编译 JS）。
 * @throws Error（缺路径/加载失败/缺导出 → fail closed）
 */
async function loadDispatchGuard(modulePath) {
  if (!modulePath || !path.isAbsolute(modulePath)) {
    throw new Error('构建模式缺少 FEISHU_SYNC_BUILD_GUARD_MODULE（运行时 dispatch-guard 模块绝对路径）');
  }
  return loadModuleAtPath(modulePath, 'dispatch-guard', REQUIRED_GUARD_EXPORTS);
}

/** 把守卫产物原地写回 event.input（Pi tool_call 契约：原地修改才进入执行；对象身份不变）。 */
function writeBackInPlace(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

/**
 * A2 在途快照读取（host 原子写 <epochRoot>/dispatch-inflight.json；扩展
 * 每次派发前读后交守卫准入）。fail-open：文件缺失/损坏/大小异常/
 * buildId·generation 与冻结信封不一致 → 返回 null，守卫跳过在途准入
 * （在途准入是吞吐优化而非安全边界；权限冻结与完整性重核验不受影响）。
 */
function readDispatchInflightSnapshot(guard) {
  const statePath = guard && guard.dispatch && guard.dispatch.inflightStatePath;
  if (typeof statePath !== 'string' || !path.isAbsolute(statePath)) return null;
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    if (raw.length > 256 * 1024) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) return null;
    if (parsed.buildId !== guard.buildId || parsed.generation !== guard.generation) return null;
    if (!Array.isArray(parsed.inflight)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 运行事件：单行 JSON 写 stderr（宿主采集）；审计体为运行时 DispatchGuardAudit，不含任务正文。 */
function logBuildGuardEvent(event, payload) {
  console.error(`[feishu-sync-agent][build-guard] ${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}`);
}

export default async function feishuSyncAgentExtension(/** @type {ExtensionAPI} */ pi) {
  if (!AGENT_URL || !RUN_TOKEN) {
    throw new Error('缺少 FEISHU_SYNC_AGENT_URL / FEISHU_SYNC_AGENT_RUN_TOKEN 环境变量（宿主未注入）');
  }

  // 构建模式（设计 §3.4）：宿主显式传入 spec 信封 + 运行时 dispatch-guard 模块路径才激活；
  // 任何解析/装载/校验失败 fail closed，拒绝以未冻结配置启动 Leader。普通会话（无 env）零行为变化。
  let buildSpec = null;
  if (BUILD_SPEC_JSON || BUILD_GUARD_MODULE) {
    if (!BUILD_SPEC_JSON || !BUILD_GUARD_MODULE) {
      throw new Error('构建模式需同时提供 FEISHU_SYNC_AGENT_BUILD_SPEC_JSON 与 FEISHU_SYNC_BUILD_GUARD_MODULE（宿主未注入完整构建环境）');
    }
    const envelope = parseBuildSpecEnvelope(BUILD_SPEC_JSON);
    const guardApi = await loadDispatchGuard(BUILD_GUARD_MODULE);
    const integrityApi = await loadModuleAtPath(deriveSiblingModulePath(BUILD_GUARD_MODULE, 'runtime-integrity'), 'runtime-integrity', REQUIRED_INTEGRITY_EXPORTS);
    const amagiApi = await loadModuleAtPath(deriveSiblingModulePath(BUILD_GUARD_MODULE, 'amagi-package'), 'amagi-package', REQUIRED_AMAGI_EXPORTS);
    const verifyIntegrity = (refs) => integrityApi.verifyRuntimeIntegrity(refs, { computePackageContentHash: amagiApi.computePackageContentHash });
    const issues = guardApi.validateGuardConfig(envelope.guard);
    if (issues.length > 0) {
      throw new Error(`FEISHU_SYNC_AGENT_BUILD_SPEC_JSON.guard 无效（dispatch-guard validateGuardConfig）：${issues.join('；')}`);
    }
    // F12 启动面：完整性引用权威形状校验 + 磁盘冻结面全量核验 + Leader agentDir
    // 一致性（启动即 fail-closed；逐次派发前还会重核——防启动后篡改）。
    const integrityRefs = envelope.guard.integrity;
    const shapeIssues = integrityApi.validateRuntimeIntegrityRefs(integrityRefs);
    if (shapeIssues.length > 0) {
      throw new Error(`FEISHU_SYNC_AGENT_BUILD_SPEC_JSON.guard.integrity 无效（runtime-integrity）：${shapeIssues.join('；')}`);
    }
    const agentDirEnv = AGENT_DIR_AT_LOAD;
    if (agentDirEnv !== integrityRefs.homeDir) {
      throw new Error(`Leader PI_CODING_AGENT_DIR（${agentDirEnv || '(未设置)'}）与冻结 agentDir（${integrityRefs.homeDir}）不一致，拒绝以未冻结 agentDir 启动构建 Leader`);
    }
    const startupVerdict = verifyIntegrity(integrityRefs);
    if (!startupVerdict.ok) {
      throw new Error(`构建 agentDir 运行期完整性核验失败，拒绝启动 Leader：${startupVerdict.issues.join('；')}`);
    }
    buildSpec = { tools: envelope.tools, guard: envelope.guard, guardApi, integrityApi, verifyIntegrity };
    if (process.env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS === '1') {
      log('build mode: 忽略 FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS 开关（构建只认冻结白名单，不放行外部插件全部工具）');
    }
    log(`build mode active: buildId=${envelope.guard.buildId} generation=${envelope.guard.generation} tools=[${envelope.tools.join(',')}] roles=[${Object.keys(envelope.guard.roles ?? {}).join(',')}] workDir=${envelope.guard.workDir}`);
  }

  // 借助Pi原生模型运行时只读复用认证与models.json，不复制密钥，不写通用Pi。
  const sharedHome = process.env.FEISHU_SYNC_AGENT_SHARED_PI_HOME;
  const piRoot = process.env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT;
  if (sharedHome && piRoot) {
    await registerConfiguredModels(pi, {
      piRoot, sharedHome, appHome: process.env.PI_CODING_AGENT_DIR,
    });
  }

  // app-llm：按所选协议注册 provider（key 只经环境变量插值）
  if (PROVIDER_JSON) {
    const descriptor = JSON.parse(PROVIDER_JSON);
    const api = descriptor.api ?? 'openai-completions';
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api)) throw new Error('不支持的应用模型协议');
    const bearerAuth = api === 'anthropic-messages' && descriptor.authHeader === true;
    if (bearerAuth && !piRoot) throw new Error('无法定位 Pi 运行时，不能使用 Anthropic Bearer 认证');
    const streamSimple = piRoot ? await appProviderStream(piRoot, api, bearerAuth) : undefined;
    pi.registerProvider('feishu-sync-llm', {
      name: 'feishu-sync LLM',
      baseUrl: descriptor.baseUrl,
      apiKey: `$${API_KEY_ENV}`,
      ...(descriptor.authHeader === true ? { authHeader: true } : {}),
      ...(streamSimple ? { streamSimple } : {}),
      api,
      models: (descriptor.models || []).map((model) => ({
        type: 'chat',
        id: model.id,
        name: model.name || model.id,
        reasoning: model.reasoning === true,
        ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
        input: model.supportsImages === false ? ['text'] : ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow || 128000,
        maxTokens: model.maxTokens || 32768,
      })),
    });
    log(`provider feishu-sync-llm registered (${(descriptor.models || []).length} model(s), baseUrl=${descriptor.baseUrl})`);
  }

  // Pi's context hook changes only this model request. Keep the original image
  // blocks in the session so switching back to a vision model restores them.
  pi.on('context', ({ messages }, ctx) => {
    const input = ctx.model?.input;
    if (!Array.isArray(input) || input.includes('image')) return;
    const filtered = withoutImageBlocks(messages);
    if (filtered !== messages) return { messages: filtered };
  });

  // 拉取本运行的工具规格并注册
  const specs = await apiGet('/api/agent-internal/tools');
  if (!Array.isArray(specs) || specs.length === 0) {
    log('no tools registered for this run (probe run expected)');
  }
  const selfTools = new Set();
  for (const spec of specs) {
    // 构建模式剔除应用 task 工具族：构建 Leader 由 amagi-core 注册同名任务工具，
    // 双方同时注册 pi 以 error 诊断退出（设计 §1.2 工具重名）。
    if ((buildSpec || NATIVE_WORK) && APP_TASK_TOOL_FAMILY.has(spec.name)) {
      log(`build mode: 跳过应用 task 工具 ${spec.name}（同名任务工具由 amagi-core 提供）`);
      continue;
    }
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
  pi.on('session_start', async (_event, ctx) => {
    if (sharedHome) await ctx.modelRegistry.refresh({ allowNetwork: false });
    if (buildSpec) {
      // 构建模式：激活集合=冻结白名单（未注册名被 pi 忽略）；
      // 与 tool_call 放行集合同源，绝不沿用外部插件全量放行。
      pi.setActiveTools(buildSpec.tools);
    } else if (!NATIVE_WORK && process.env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS === '1') {
      pi.setActiveTools([...new Set([...selfTools, ...external()])]);
    }
  });
  pi.on('tool_call', (event) => {
    const name = event && event.toolName;
    if (buildSpec) {
      if (typeof name !== 'string' || !buildSpec.tools.includes(name)) {
        return { block: true, reason: `构建模式工具白名单未包含 ${name ?? '(未知工具)'}——只允许冻结白名单内的 amagi 任务/资源与应用构建工具` };
      }
      if (name === 'task_submit' || name === 'task_resume') {
        // Pi tool_call 事件契约：event.input 原地可变，修改后不重校验，
        // 执行时参数即修改后参数。策略唯一来源：运行时 dispatch-guard（不在本扩展复制）；
        // 守卫返回新 args 对象，此处原地写回 event.input（对象身份不变）才真正生效。
        //
        // F12（审核修复）：纯参数守卫不等于运行期校验——每次真实派发/续接前
        // 重核冻结 settings/policy/包/四配置（verifyRuntimeIntegrity 读盘），
        // 缺失/篡改/资源注入 → 阻断 child 模型请求（Pi 对 settings 缺失扩展会
        // 静默跳过，缺失 policy 的子任务仍会请求模型——已实测复现）。
        // 另核 Leader 实际 agentDir 与冻结引用一致（子任务从同一目录加载配置面）。
        const integrityRefs = buildSpec.guard.integrity;
        if (!integrityRefs) {
          logBuildGuardEvent('integrity_blocked', {
            tool: name,
            issues: ['guard 信封缺少冻结完整性引用（runtime_integrity_refs_missing，schemaVersion<2 旧代次信封）'],
          });
          return { block: true, reason: '构建派发守卫：guard 信封缺少 F12 冻结完整性引用（runtime_integrity_refs_missing），拒绝派发' };
        }
        const agentDirEnv = AGENT_DIR_AT_LOAD;
        if (agentDirEnv !== integrityRefs.homeDir) {
          logBuildGuardEvent('integrity_blocked', {
            tool: name,
            issues: [`Leader PI_CODING_AGENT_DIR（${agentDirEnv || '(未设置)'}）与冻结 agentDir（${integrityRefs.homeDir}）不一致`],
          });
          return { block: true, reason: `构建派发守卫：Leader agentDir 与冻结引用不一致（${agentDirEnv || '(未设置)'} ≠ ${integrityRefs.homeDir}），拒绝派发` };
        }
        const verdict = buildSpec.verifyIntegrity(integrityRefs);
        if (!verdict.ok) {
          logBuildGuardEvent('integrity_blocked', { tool: name, issues: verdict.issues });
          return { block: true, reason: `运行期完整性核验失败，拒绝派发（runtime_integrity_violation）：${verdict.issues.join('；')}` };
        }
        const input = event.input;
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return { block: true, reason: `构建派发守卫：${name} 参数必须是对象` };
        }
        const decision = name === 'task_submit'
          ? buildSpec.guardApi.guardTaskSubmit(buildSpec.guard, input, {
            inflight: readDispatchInflightSnapshot(buildSpec.guard),
          })
          : buildSpec.guardApi.guardTaskResume(buildSpec.guard, input, {
            inflight: readDispatchInflightSnapshot(buildSpec.guard),
          });
        if (decision.decision === 'block') {
          logBuildGuardEvent('guard_blocked', { tool: name, code: decision.code, reason: decision.message, audit: decision.audit });
          return { block: true, reason: `${decision.message}（${decision.code}）` };
        }
        writeBackInPlace(input, decision.args);
        logBuildGuardEvent('guard_amended', { tool: name, audit: decision.audit });
      }
      return undefined;
    }
    // Work adds application tools to Pi; Pi owns its native/plugin/MCP tools.
    // Do not freeze their names here, so newer Pi/plugin versions keep working.
    if (NATIVE_WORK) return undefined;
    if (typeof name === 'string' && (selfTools.has(name) || external().has(name))) return undefined;
    return { block: true, reason: `工具 ${name} 未由应用或已启用插件提供` };
  });
}
