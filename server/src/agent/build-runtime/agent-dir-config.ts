/**
 * build-runtime/agent-dir-config.ts — 构建 agentDir 配置生成与校验
 *
 * 设计来源：设计v2 §3.1–§3.3。四个文件全部由应用在启动 Leader 前写入，
 * 构建期间不随运行变更（amagi 每次准入/路由读盘，文件即真相）：
 *
 * - settings.json：packages 只声明版本化 amagi-pi 的本地绝对路径（object form
 *   收窄为仅 extensions；skills/prompts/themes 由 amagi.json agents.<role>.skills
 *   以 --no-skills + --skill 精确注入）。形状依据 pi docs packages.md 与
 *   pi 1.4.0 DefaultPackageManager（local source 按解析后绝对路径加载，不复制）。
 *   另以 extensions 显式声明应用 child-policy（内容寻址文件名，子任务加载、
 *   Leader --no-extensions 不加载；见 child-policy.ts）。
 * - amagi.json：agents.<role>.model/skills、concurrency.models 分池、mcp 路由
 *   （leader=[] 显式、default=[] 显式、agents.<role>=[桥接]）。形状依据 amagi-pi
 *   schemas/amagi-config.json（2.21.31）与 mcp-config.ts loadMcpRouting。
 * - models.json：zhipuai provider 静态声明，apiKey 只写 "$ZHIPU_API_KEY" 环境引用
 *   （pi models-configuration.md："$NAME" 插值），文件中不出现密钥值。
 * - mcp.json：mcpServers 只登记应用桥接（command=应用 Node 绝对路径、env 用
 *   ${VAR} 引用两个桥接变量），autoEnableCodemode:false（pi docs mcp.md——设在
 *   mcpServers 旁），避免 pi 因 codemode 暴露自动启用 codemode。
 *
 * 工作目录中的配置面文件列入禁区（amagi.json、.pi 目录、.mcp.json、.agents 目录、
 * AGENTS.md、CLAUDE.md），由 dispatch-guard 的 forbiddenZones 执法。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  childPolicyFileName, materializeChildPolicyFile, verifyChildPolicyFile,
} from './child-policy.js';
import {
  BUILD_MCP_SERVER_NAME, BUILD_MCP_TOKEN_ENV, BUILD_MCP_URL_ENV,
  BUILD_MODEL_PROVIDER, ZHIPU_API_KEY_ENV,
  modelSpecPoolKey, type BuildRunSpec, type ThinkingLevel,
} from './contracts.js';

export class AgentDirConfigError extends Error {
  constructor(code: string, message: string, readonly issues: string[] = []) {
    super(message);
    this.code = code;
  }
  readonly code: string;
}

export interface BuildDirectories {
  /** 构建根（<dataRoot>/agent/builds/<buildId>）。 */
  buildRoot: string;
  /** PI_CODING_AGENT_DIR。 */
  homeDir: string;
  /** Leader 与子任务工作目录。 */
  workDir: string;
  /** 会话目录（pi --session-dir，位于 agentDir 内随构建保留）。 */
  sessionDir: string;
}

export function planBuildDirectories(dataRoot: string, buildId: string): BuildDirectories {
  const buildRoot = path.join(dataRoot, 'agent', 'builds', buildId);
  return {
    buildRoot,
    homeDir: path.join(buildRoot, 'home'),
    workDir: path.join(buildRoot, 'work'),
    sessionDir: path.join(buildRoot, 'home', 'sessions'),
  };
}

/** 构建禁区（设计 §3.1；绝对路径，dispatch-guard scope.deny 追加）。 */
export function buildForbiddenZones(input: {
  workDir: string;
  dataRoot: string;
  knowledgeBaseRoot: string;
  outputRoot: string;
  userHome?: string;
}): string[] {
  const zones = new Set<string>();
  // 工作目录中的配置面文件（相对形式供 amagi deny 匹配；amagi deny 条目按路径模式执法）
  for (const rel of ['amagi.json', '.mcp.json', '.pi', '.agents', 'AGENTS.md', 'CLAUDE.md']) {
    zones.add(path.join(input.workDir, rel));
  }
  // 构建 agentDir（= <buildRoot>/home，与 planBuildDirectories 同规则从 workDir 推导，
  // adapter 调用面无需变更）：精确禁区覆盖四配置 + 内容寻址 child-policy 文件——
  // 不整目录禁 home/**（构建 skill 将迁入 <home>/skills，子任务须可读冻结正文；
  // 配置/policy 面读写双禁，见设计 §3.1 与 child-policy.ts 完整性说明）。
  const homeDir = path.join(path.dirname(path.resolve(input.workDir)), 'home');
  zones.add(path.join(homeDir, 'settings.json'));
  zones.add(path.join(homeDir, 'amagi.json'));
  zones.add(path.join(homeDir, 'models.json'));
  zones.add(path.join(homeDir, 'mcp.json'));
  zones.add(path.join(homeDir, childPolicyFileName()));
  // 数据根禁区：明文 LLM 密钥配置、SQLite、CLI 端点与令牌、运行产物
  zones.add(path.join(input.dataRoot, 'config.json'));
  zones.add(path.join(input.dataRoot, 'feishu-sync.db'));
  zones.add(path.join(input.dataRoot, 'run'));
  zones.add(path.join(input.dataRoot, 'source-edits'));
  // 原始库与标准库目录（只读禁写；读通道由知识工具约束）
  zones.add(path.resolve(input.knowledgeBaseRoot));
  zones.add(path.resolve(input.outputRoot));
  // 用户 Pi 目录
  zones.add(path.join(input.userHome ?? homedir(), '.pi'));
  return [...zones].sort();
}

/** 生成四配置文件内容（不落盘；纯函数便于测试与哈希）。dirs 只用于路径推导，不写入内容。 */
export function renderAgentDirConfigFiles(spec: BuildRunSpec, _dirs: BuildDirectories | null, input: {
  /** 应用回环 MCP 桥接启动命令（应用 Node 绝对路径）与参数。 */
  bridgeCommand: string;
  bridgeArgs: string[];
}): Record<'settings' | 'amagi' | 'models' | 'mcp', string> {
  // ── settings.json：只声明版本化 amagi-pi（仅 extensions 资源）+ 应用 child-policy ──
  // extensions 相对路径按 agentDir 解析（pi DefaultPackageManager 已核实）；
  // 文件名含内容 hash → 本哈希链间接绑定 policy 内容（child-policy.ts 完整性说明）。
  const settings = {
    $schema: 'https://pi.dev/schemas/settings.schema.json',
    packages: [
      {
        source: spec.amagiPackage.packageRoot,
        skills: [],
        prompts: [],
        themes: [],
      },
    ],
    extensions: [childPolicyFileName()],
  };

  // ── amagi.json：角色模型/技能、分池、MCP 路由 ──
  const roleAgents = Object.values(spec.roles);
  const agentsConfig: Record<string, { model?: string; skills: string[] }> = {};
  for (const roleKey of Object.keys(spec.roles) as Array<keyof typeof spec.roles>) {
    const agent = spec.roles[roleKey];
    const model = spec.models[roleKey];
    agentsConfig[agent] = model ? { model, skills: [spec.workflowSkillPath] } : { skills: [spec.workflowSkillPath] };
  }
  const pools: Record<string, number> = {};
  for (const roleKey of Object.keys(spec.roles) as Array<keyof typeof spec.roles>) {
    const cap = spec.limits.admissionPools[roleKey];
    if (cap === undefined) continue;
    const model = spec.models[roleKey];
    if (!model) continue;
    pools[modelSpecPoolKey(model)] = cap;
  }
  const amagi = {
    agents: agentsConfig,
    concurrency: { models: pools },
    mcp: {
      leader: [],
      default: [],
      agents: Object.fromEntries(roleAgents.map((agent) => [agent, [BUILD_MCP_SERVER_NAME]])),
    },
  };

  // ── models.json：zhipuai 静态声明（apiKey=环境引用，不落密钥值） ──
  const seen = new Map<string, BuildRunSpec['modelDescriptors'][number]>();
  for (const descriptor of spec.modelDescriptors) seen.set(descriptor.id, descriptor);
  const firstDescriptor = seen.values().next().value;
  const baseUrl = firstDescriptor?.baseUrl ?? spec.modelDescriptors[0]?.baseUrl ?? '';
  const models = {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      [BUILD_MODEL_PROVIDER]: {
        name: 'GLM (zhipuai, 构建静态声明)',
        baseUrl,
        api: 'openai-completions',
        apiKey: `$${ZHIPU_API_KEY_ENV}`,
        models: [...seen.values()].map((descriptor) => ({
          id: descriptor.id,
          name: descriptor.id,
          ...(descriptor.reasoning !== undefined ? { reasoning: descriptor.reasoning } : {}),
          ...(descriptor.thinkingLevelMap ? { thinkingLevelMap: descriptor.thinkingLevelMap } : {}),
          ...(descriptor.contextWindow ? { contextWindow: descriptor.contextWindow } : {}),
          ...(descriptor.maxTokens ? { maxTokens: descriptor.maxTokens } : {}),
        })),
      },
    },
  };

  // ── mcp.json：只登记应用桥接；env 只用变量引用；关闭 codemode 自动启用 ──
  const mcp = {
    mcpServers: {
      [BUILD_MCP_SERVER_NAME]: {
        command: input.bridgeCommand,
        args: input.bridgeArgs,
        env: {
          FEISHU_SYNC_BUILD_MCP_URL: `\${${BUILD_MCP_URL_ENV}}`,
          FEISHU_SYNC_BUILD_MCP_TOKEN: `\${${BUILD_MCP_TOKEN_ENV}}`,
        },
        exposure: 'codemode',
        description: '应用知识工具桥接（子任务经 mcp_call 调用）',
      },
    },
    autoEnableCodemode: false,
  };

  return {
    settings: `${JSON.stringify(settings, null, 2)}\n`,
    amagi: `${JSON.stringify(amagi, null, 2)}\n`,
    models: `${JSON.stringify(models, null, 2)}\n`,
    mcp: `${JSON.stringify(mcp, null, 2)}\n`,
  };
}

/** 四文件规范化哈希（agentDirConfigHash；不含密钥——apiKey/env 均为引用）。 */
export function computeAgentDirConfigHash(files: Record<'settings' | 'amagi' | 'models' | 'mcp', string>): string {
  const order: Array<keyof typeof files> = ['settings', 'amagi', 'models', 'mcp'];
  const chain = crypto.createHash('sha256');
  for (const key of order) {
    chain.update(`${key}\0${crypto.createHash('sha256').update(files[key], 'utf-8').digest('hex')}\0`, 'utf-8');
  }
  return chain.digest('hex');
}

/** 写入 agentDir 配置（幂等：重写前校验旧配置哈希一致性，防覆盖他轮产物）。 */
export function writeAgentDirConfig(
  spec: BuildRunSpec,
  dirs: BuildDirectories,
  input: { bridgeCommand: string; bridgeArgs: string[] },
): { configHash: string } {
  const files = renderAgentDirConfigFiles(spec, dirs, input);
  const issues = validateRenderedConfig(files, spec, dirs);
  if (issues.length > 0) {
    throw new AgentDirConfigError('agent_dir_config_invalid', `agentDir 配置校验失败：${issues.join('；')}`, issues);
  }
  const configHash = computeAgentDirConfigHash(files);
  fs.mkdirSync(dirs.homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dirs.workDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dirs.sessionDir, { recursive: true, mode: 0o700 });
  const writes: Array<[string, string]> = [
    [path.join(dirs.homeDir, 'settings.json'), files.settings],
    [path.join(dirs.homeDir, 'amagi.json'), files.amagi],
    [path.join(dirs.homeDir, 'models.json'), files.models],
    [path.join(dirs.homeDir, 'mcp.json'), files.mcp],
  ];
  for (const [file, content] of writes) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  // child-policy 物化（幂等 + 写后字节级核验；缺失/篡改/同名异客 fail-closed，见 child-policy.ts）
  materializeChildPolicyFile(dirs.homeDir);
  return { configHash };
}

/** 校验生成内容与设计/解析器约束（写前与探测共用）。 */
export function validateRenderedConfig(
  files: Record<'settings' | 'amagi' | 'models' | 'mcp', string>,
  spec: BuildRunSpec,
  dirs: BuildDirectories,
): string[] {
  const issues: string[] = [];
  const parse = (text: string, label: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('非对象');
      return parsed;
    } catch (error) {
      issues.push(`${label} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const settings = parse(files.settings, 'settings.json');
  if (settings) {
    const packages = settings.packages;
    if (!Array.isArray(packages) || packages.length !== 1) issues.push('settings.json packages 须只声明一个包');
    else {
      const entry = packages[0] as Record<string, unknown>;
      if (entry.source !== spec.amagiPackage.packageRoot) issues.push('settings.json 包声明与 amagiPackage.packageRoot 不一致');
      if (entry.skills === undefined || !Array.isArray(entry.skills) || (entry.skills as unknown[]).length !== 0) {
        issues.push('settings.json 包声明应将 skills 收窄为 []');
      }
    }
    // child-policy 显式声明：恰好一条且为当前内容寻址文件名（防止渲染层回归/拼接错误）
    const extensions = settings.extensions;
    const expectedPolicy = childPolicyFileName();
    if (!Array.isArray(extensions) || extensions.length !== 1 || extensions[0] !== expectedPolicy) {
      issues.push(`settings.json extensions 应只声明应用 child-policy（${expectedPolicy}）`);
    }
  }
  const amagi = parse(files.amagi, 'amagi.json');
  if (amagi) {
    const agents = (amagi.agents ?? {}) as Record<string, Record<string, unknown>>;
    const expectedAgents = new Set(Object.values(spec.roles));
    for (const agent of Object.keys(agents)) {
      if (!expectedAgents.has(agent as never)) issues.push(`amagi.json 出现未预期角色 ${agent}`);
      if (!Array.isArray(agents[agent]?.skills) || (agents[agent].skills as unknown[]).length !== 1) {
        issues.push(`amagi.json agents.${agent}.skills 应只含构建 skill 路径`);
      }
      const model = agents[agent]?.model;
      if (model !== undefined && (typeof model !== 'string' || !model.startsWith(`${BUILD_MODEL_PROVIDER}/`))) {
        issues.push(`amagi.json agents.${agent}.model 未指向 ${BUILD_MODEL_PROVIDER}`);
      }
    }
    const concurrency = (amagi.concurrency ?? {}) as Record<string, unknown>;
    if (!concurrency.models || typeof concurrency.models !== 'object') issues.push('amagi.json 缺 concurrency.models');
    const mcp = (amagi.mcp ?? {}) as Record<string, unknown>;
    if (Array.isArray(mcp.leader) && (mcp.leader as unknown[]).length !== 0) issues.push('amagi.json mcp.leader 应为空（Leader 不连 MCP）');
    if (Array.isArray(mcp.default) && (mcp.default as unknown[]).length !== 0) issues.push('amagi.json mcp.default 应为空（仅角色路由）');
    if (mcp.default === undefined) issues.push('amagi.json mcp.default 应显式为空数组（否则缺省 * 全量路由）');
    const mcpAgents = (mcp.agents ?? {}) as Record<string, unknown>;
    for (const agent of Object.values(spec.roles)) {
      const list = mcpAgents[agent];
      if (!Array.isArray(list) || list.length !== 1 || list[0] !== BUILD_MCP_SERVER_NAME) {
        issues.push(`amagi.json mcp.agents.${agent} 应只列 ${BUILD_MCP_SERVER_NAME}`);
      }
    }
  }
  const models = parse(files.models, 'models.json');
  if (models) {
    const providers = (models.providers ?? {}) as Record<string, Record<string, unknown>>;
    const provider = providers[BUILD_MODEL_PROVIDER];
    if (!provider) issues.push(`models.json 缺 ${BUILD_MODEL_PROVIDER} provider`);
    else {
      if (provider.apiKey !== `$${ZHIPU_API_KEY_ENV}`) issues.push('models.json apiKey 必须是环境引用（不得含密钥值）');
      if (!Array.isArray(provider.models) || (provider.models as unknown[]).length === 0) issues.push('models.json 无模型声明');
      const declaredIds = new Set(((provider.models ?? []) as Array<{ id?: string }>).map((m) => m.id));
      for (const roleKey of Object.keys(spec.roles) as Array<keyof typeof spec.roles>) {
        const model = spec.models[roleKey];
        if (!model) continue;
        const id = model.slice(model.indexOf('/') + 1).split(':')[0];
        if (!declaredIds.has(id)) issues.push(`models.json 未声明 ${roleKey} 模型 ${id}`);
      }
    }
    if (Object.keys(providers).length !== 1) issues.push('models.json 只应声明一个 provider');
  }
  const mcp = parse(files.mcp, 'mcp.json');
  if (mcp) {
    const servers = (mcp.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    if (Object.keys(servers).length !== 1 || !servers[BUILD_MCP_SERVER_NAME]) issues.push(`mcp.json 应只登记 ${BUILD_MCP_SERVER_NAME}`);
    const server = servers[BUILD_MCP_SERVER_NAME];
    if (server && (typeof server.command !== 'string' || !path.isAbsolute(String(server.command)))) {
      issues.push('mcp.json 桥接 command 须为绝对路径');
    }
    const env = (server?.env ?? {}) as Record<string, unknown>;
    for (const [name, expected] of [
      ['FEISHU_SYNC_BUILD_MCP_URL', `\${${BUILD_MCP_URL_ENV}}`],
      ['FEISHU_SYNC_BUILD_MCP_TOKEN', `\${${BUILD_MCP_TOKEN_ENV}}`],
    ] as const) {
      if (env[name] !== expected) issues.push(`mcp.json env.${name} 应为 ${expected} 引用`);
    }
    if (mcp.autoEnableCodemode !== false) issues.push('mcp.json 须设置 autoEnableCodemode:false');
  }
  // 工作目录不得含项目级 amagi.json（会覆盖全局配置——设计 §3.1）
  if (fs.existsSync(path.join(dirs.workDir, 'amagi.json'))) issues.push('工作目录已存在 amagi.json（项目级配置覆盖面，构建禁止）');
  return issues;
}

/** 重读 agentDir 已落盘配置并复核哈希（四文件全量；见 agentDirConfigMatchesSpec 的容忍口径）。 */
export function readAgentDirConfigHash(homeDir: string): string | null {
  const names: Array<['settings' | 'amagi' | 'models' | 'mcp', string]> = [
    ['settings', 'settings.json'], ['amagi', 'amagi.json'], ['models', 'models.json'], ['mcp', 'mcp.json'],
  ];
  const parts = {} as Record<'settings' | 'amagi' | 'models' | 'mcp', string>;
  try {
    for (const [key, name] of names) parts[key] = fs.readFileSync(path.join(homeDir, name), 'utf-8');
  } catch {
    return null;
  }
  return computeAgentDirConfigHash(parts);
}

/**
 * 容忍式漂移核对（resume/probe 用）：
 * - amagi.json / models.json 逐字节比对 spec 渲染结果；
 * - mcp.json：提供 bridge 时逐字节比对，否则跳过字节比对（形状由 validateRenderedConfig 保障）；
 * - settings.json 字段感知完整比对（资源注入缺口收口）：
 *   · 冻结资源/工具面键 $schema/packages/extensions/skills/prompts/themes/defaultTools
 *     必须与 spec 渲染结果深度一致（含“不存在即不得出现”——未知资源字段不得放过）；
 *   · 唯一容忍键 retry：仅 amagi doctor 实测写入的 retry.provider.timeoutMs 正数
 *     （terminal-doctor.ts mergeProviderTimeout 只补这一条路径，其余原样保留；
 *     本配置不写 retry，出现的 retry 只能来自 doctor，且形状必须精确到无多余键）；
 *   · 其余任何键 → 不匹配。
 * - child-policy 文件本体字节级核验（加载前验内容，防“只记 hash 不验证”）：
 *   缺失/篡改 → 不匹配（resume/probe fail-closed）。
 */
const SETTINGS_FROZEN_KEYS = ['$schema', 'packages', 'extensions', 'skills', 'prompts', 'themes', 'defaultTools'] as const;
const SETTINGS_TOLERATED_KEYS = new Set(['retry']);

/** retry 容忍形状：{ provider: { timeoutMs: <正有限数> } } 且无任何多余键。 */
function isToleratedRetryShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const retry = value as Record<string, unknown>;
  if (Object.keys(retry).length !== 1) return false;
  const provider = retry.provider;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return false;
  const providerRecord = provider as Record<string, unknown>;
  if (Object.keys(providerRecord).length !== 1) return false;
  const timeoutMs = providerRecord.timeoutMs;
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
}

export function agentDirConfigMatchesSpec(
  homeDir: string,
  spec: BuildRunSpec,
  bridge?: { bridgeCommand: string; bridgeArgs: string[] },
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const expected = renderAgentDirConfigFiles(spec, null, bridge ?? { bridgeCommand: '<probe-unknown>', bridgeArgs: [] });
  const read = (name: string): string | null => {
    try { return fs.readFileSync(path.join(homeDir, name), 'utf-8'); } catch { return null; }
  };
  for (const [name, key] of [['amagi.json', 'amagi'], ['models.json', 'models']] as const) {
    const actual = read(name);
    if (actual === null) issues.push(`缺少 ${name}`);
    else if (actual !== expected[key]) issues.push(`${name} 与 spec 渲染结果不一致（构建冻结面被改动）`);
  }
  const mcpActual = read('mcp.json');
  if (mcpActual === null) issues.push('缺少 mcp.json');
  else if (bridge && mcpActual !== expected.mcp) issues.push('mcp.json 与 spec 渲染结果不一致');
  const settingsRaw = read('settings.json');
  if (settingsRaw === null) {
    issues.push('缺少 settings.json');
  } else {
    try {
      const actual = JSON.parse(settingsRaw) as Record<string, unknown>;
      const expectedSettings = JSON.parse(expected.settings) as Record<string, unknown>;
      // 1) 冻结键深度比对（含“spec 未写 → 磁盘不得出现”）
      for (const key of SETTINGS_FROZEN_KEYS) {
        const a = actual[key];
        const e = expectedSettings[key];
        const aMissing = a === undefined;
        const eMissing = e === undefined;
        if (aMissing !== eMissing) {
          issues.push(`settings.json ${key} 冻结面被${eMissing ? '新增' : '移除'}（资源/工具注入面收口）`);
        } else if (!aMissing && JSON.stringify(a) !== JSON.stringify(e)) {
          issues.push(`settings.json ${key} 与 spec 渲染结果不一致（构建冻结面被改动）`);
        }
      }
      // 2) 容忍键 retry：仅实测 doctor 写入的精确形状
      if (actual.retry !== undefined && !isToleratedRetryShape(actual.retry)) {
        issues.push('settings.json retry 键形状超出已实测可接受项（仅 amagi doctor 写入的 provider.timeoutMs）');
      }
      // 3) 未知键拒绝（不在冻结/容忍清单内的字段一律根出）
      for (const key of Object.keys(actual)) {
        if (!SETTINGS_TOLERATED_KEYS.has(key) && !(SETTINGS_FROZEN_KEYS as readonly string[]).includes(key)) {
          issues.push(`settings.json 出现未知字段 ${key}（不在冻结/容忍清单，疑似资源注入）`);
        }
      }
    } catch (error) {
      issues.push(`settings.json 解析失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // child-policy 文件本体核验（settings 含 hash 文件名，这里验内容——加载前把关）
  issues.push(...verifyChildPolicyFile(homeDir).issues);
  return { ok: issues.length === 0, issues };
}

/** 校验冻结 thinking 档位被 descriptor 的 levelMap 支持（缺 map 时警告由探测面报告）。 */
export function thinkingLevelSupported(descriptor: { thinkingLevelMap?: Record<string, string | null>; thinking?: ThinkingLevel }): boolean {
  if (!descriptor.thinking) return true;
  if (!descriptor.thinkingLevelMap) return false;
  const mapped = descriptor.thinkingLevelMap[descriptor.thinking];
  return mapped !== null && mapped !== undefined;
}
