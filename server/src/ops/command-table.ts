/**
 * OPS 命令表（设计 kb-agent-upgrade §6.3）— 纯数据模块，无 IO。
 *
 * CLI 客户端（S9，`POST /api/cli/:command`）与内部 Agent 的 app_command
 * （S10）共用本表；首批只登记**既有路由已存在**的命令（逐条对照
 * server/src/routes/*.ts 真实端点，不发明不存在的 API）。source.* 系列
 * 依赖 S11/S12 的新路由，待 S13 追加登记。
 *
 * 约定：
 *  - `request(args)` 是纯函数：由命令参数构造进程内转发的 HTTP 调用描述
 *    （method/path/query/body）；路径参数用 `{param}` 占位替换。
 *  - `confirm` 登记需要调用方在确认后注入的 body 字段；执行层
 *    （routes/cli.ts）对「最终请求非 GET 且 def.confirm 存在」强制校验，
 *    destructive/remote_write 命令在表定义层必须有 confirm（测试锚定）。
 *  - `fillDefaults` 纯函数：执行层传入当前配置快照，命令补默认参数
 *    （如 kb.sources.* 自动注入当前原始库 root），不做任何 IO。
 */

import type { Config } from '../types/index.js';

export type OpsRisk = 'read' | 'mutate' | 'destructive' | 'remote_write';

/** JSON Schema 子集（本表只用 object + 基础类型，供 S9/S10 展示与轻校验）。 */
export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number' | 'boolean' | 'object' | 'array'; description?: string; default?: unknown }>;
  required?: string[];
}

export interface OpsRequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 目标路由路径；`{param}` 由 request(args) 内替换。 */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** 多步聚合键（单步命令可省略）。 */
  key?: string;
}

export interface OpsFillContext {
  config: Config | null;
}

export interface OpsCommandDef {
  /** 命令名（CLI 子命令点号分层，如 `kb.build`）。 */
  name: string;
  summary: string;
  risk: OpsRisk;
  params: JsonSchemaObject;
  request(args: Record<string, unknown>): OpsRequestSpec[];
  /** 需要确认后注入的 body 字段（destructive/remote_write 必填）。 */
  confirm?: { field: string; value: string };
  /** 是否对内部 Agent（app_command，S10）暴露。 */
  agentExposed: boolean;
  stream?: 'sse' | 'long-poll';
  fillDefaults?(args: Record<string, unknown>, ctx: OpsFillContext): Record<string, unknown>;
}

/** 命令参数构造错误（禁止路径 / 参数形态非法）；执行层转 400。 */
export class OpsArgumentError extends Error {
  code: string;
  constructor(code: 'invalid_args' | 'forbidden_path', message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 辅助纯函数
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpsArgumentError('invalid_args', `参数 ${field} 必须是非空字符串`);
  }
  return value;
}

/**
 * config.set 的禁止路径（设计 §6.3）：CLI 主体不能改写 CLI 自身开关
 * （自我提权）、明文密钥面（llm/providers）、Workspace 登记（专用路由
 * 才有路径校验），以及飞书写回开关（T3b-02：设计 §7.6 限定只接受
 * desktop 链路修改，CLI 通道永不开启/关闭云端写入权限门）。PUT
 * /api/config 对 actor='cli' 同语义。
 */
const CONFIG_SET_FORBIDDEN: Array<{ prefix: string; reason: string }> = [
  { prefix: 'cli', reason: 'CLI 主体不能改写命令行访问开关（请在应用设置中操作）' },
  { prefix: 'llm', reason: 'LLM 整段与密钥面不接受 CLI 直写（含明文 apiKey 风险）' },
  { prefix: 'llm.apiKey', reason: 'apiKey 只能经应用设置或 stdin 通道写入' },
  { prefix: 'llm.providers', reason: 'providers 含明文 apiKey，不接受 CLI 直写' },
  { prefix: 'agent.workspaces', reason: 'Workspace 增删只走专用路由（路径校验）' },
  { prefix: 'feishuWrite', reason: '飞书写回开关只接受应用设置（desktop）修改；CLI 通道不可变更云端写入权限门' },
];

function assertConfigSetPathAllowed(path: string): void {
  for (const rule of CONFIG_SET_FORBIDDEN) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) {
      throw new OpsArgumentError('forbidden_path', `config.set 禁止路径 ${path}：${rule.reason}`);
    }
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// 命令登记（首批：仅既有路由）
// ---------------------------------------------------------------------------

export const OPS_COMMANDS: readonly OpsCommandDef[] = [
  // ---- read ---------------------------------------------------------------
  {
    name: 'status',
    summary: '应用总览：健康、lark-cli、Agent 运行时与标准库状态',
    risk: 'read',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => ([
      { method: 'GET', path: '/api/health', key: 'health' },
      { method: 'GET', path: '/api/feishu/lark-cli/status', key: 'larkCli' },
      { method: 'GET', path: '/api/agent/status', key: 'agent' },
      { method: 'GET', path: '/api/kb/status', key: 'kb' },
    ]),
  },
  {
    name: 'auth.status',
    summary: '飞书认证就绪状态（lark-cli 版本 / scope / 身份）',
    risk: 'read',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'GET', path: '/api/feishu/auth-status' }],
  },
  {
    name: 'config.get',
    summary: '读取应用配置（已脱敏；path 供输出裁剪提示）',
    risk: 'read',
    agentExposed: true,
    params: {
      type: 'object',
      properties: { path: { type: 'string', description: '配置子路径（如 pollIntervalMinutes），仅提示 CLI 裁剪输出' } },
    },
    request: () => [{ method: 'GET', path: '/api/config' }],
  },
  {
    name: 'kb.status',
    summary: '标准知识库当前发布与待构建状态',
    risk: 'read',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'GET', path: '/api/kb/status' }],
  },
  {
    name: 'kb.changes',
    summary: '相对当前 release 的源变更列表',
    risk: 'read',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'GET', path: '/api/kb/changes' }],
  },
  {
    name: 'kb.builds',
    summary: '构建历史',
    risk: 'read',
    agentExposed: true,
    params: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数 1-100，默认 20' } },
    },
    request: (args) => [{
      method: 'GET',
      path: '/api/kb/builds',
      query: numberOrNull(args.limit) !== null ? { limit: String(args.limit) } : undefined,
    }],
  },
  {
    name: 'kb.versions',
    summary: '标准库发布版本列表',
    risk: 'read',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'GET', path: '/api/kb/versions' }],
  },
  // T3b-01：参数面收窄为「引用已保存配置」——不接受可覆盖 baseUrl/
  // apiKey 的完整 llm 对象（Agent 通道下等于把已存密钥发往模型指定端
  // 点的代理）。端点/密钥一律由 server 从 ConfigManager 解析。
  {
    name: 'llm.test',
    summary: '对已保存的 LLM 提供商发起一次连通性测试（只能引用已保存配置，不能覆盖端点/密钥）',
    risk: 'read',
    agentExposed: true,
    params: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: '已保存提供商 id（缺省用当前激活配置）' },
        modelId: { type: 'string', description: '该提供商下的模型预设 id（缺省用提供商默认项）' },
        timeoutMs: { type: 'number', description: '单次测试超时毫秒（500..900000）' },
      },
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/llm/test-channel',
      body: {
        channel: 'direct',
        ...(str(args.providerId) !== undefined ? { providerId: str(args.providerId) } : {}),
        ...(str(args.modelId) !== undefined ? { modelId: str(args.modelId) } : {}),
        ...(numberOrNull(args.timeoutMs) !== null ? { timeoutMs: args.timeoutMs as number } : {}),
      },
    }],
  },
  {
    name: 'clean.trash.list',
    summary: '回收站文档列表',
    risk: 'read',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'GET', path: '/api/trash' }],
  },

  // ---- mutate -------------------------------------------------------------
  {
    name: 'config.set',
    summary: '窄 patch 写入单个配置路径（禁 cli.*/llm 密钥面/agent.workspaces/feishuWrite）',
    risk: 'mutate',
    agentExposed: true,
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '顶层配置键（如 pollIntervalMinutes、enableNotifications）' },
        value: { type: 'object', description: '该键的新值（JSON）' },
      },
      required: ['path', 'value'],
    },
    request: (args) => {
      const path = requireString(args, 'path');
      if (!Object.prototype.hasOwnProperty.call(args, 'value')) {
        throw new OpsArgumentError('invalid_args', '参数 value 是必需的');
      }
      assertConfigSetPathAllowed(path);
      return [{ method: 'PUT', path: '/api/config', body: { [path]: args.value } }];
    },
  },
  {
    name: 'auth.login.start',
    summary: '发起设备授权登录，返回 verificationUrl 与 deviceCode',
    risk: 'mutate',
    agentExposed: true,
    params: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'reauthorize（默认）或 switch_account' },
      },
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/feishu/auth/device/start',
      body: { mode: str(args.mode) ?? 'reauthorize' },
    }],
  },
  {
    name: 'auth.login.complete',
    summary: '阻塞等待浏览器授权完成（最长约 11 分钟）',
    risk: 'mutate',
    agentExposed: true,
    stream: 'long-poll',
    params: {
      type: 'object',
      properties: { deviceCode: { type: 'string', description: 'start 返回的 deviceCode' } },
      required: ['deviceCode'],
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/feishu/auth/device/complete',
      body: { deviceCode: requireString(args, 'deviceCode') },
    }],
  },
  {
    name: 'auth.login.cancel',
    summary: '取消进行中的设备授权流程',
    risk: 'mutate',
    agentExposed: true,
    params: {
      type: 'object',
      properties: { deviceCode: { type: 'string' } },
      required: ['deviceCode'],
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/feishu/auth/device/cancel',
      body: { deviceCode: requireString(args, 'deviceCode') },
    }],
  },
  {
    name: 'lark.install',
    summary: '安装/更新应用内 lark-cli',
    risk: 'mutate',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'POST', path: '/api/feishu/lark-cli/install' }],
  },
  {
    name: 'lark.config-init.start',
    summary: '发起 lark-cli 初始化配置（全新安装后的必经步骤）',
    risk: 'mutate',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'POST', path: '/api/feishu/lark-cli/config-init/start' }],
  },
  {
    name: 'lark.config-init.complete',
    summary: '阻塞等待初始化配置完成（最长约 12 分钟）',
    risk: 'mutate',
    agentExposed: true,
    stream: 'long-poll',
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'POST', path: '/api/feishu/lark-cli/config-init/complete' }],
  },
  {
    name: 'lark.config-init.cancel',
    summary: '取消进行中的初始化配置',
    risk: 'mutate',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'POST', path: '/api/feishu/lark-cli/config-init/cancel' }],
  },
  {
    name: 'kb.build',
    summary: '发起标准库构建（incremental/full）',
    risk: 'mutate',
    agentExposed: true,
    confirm: { field: 'confirm', value: 'BUILD' },
    params: {
      type: 'object',
      properties: { mode: { type: 'string', description: 'incremental（默认）或 full' } },
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/kb/builds',
      body: {
        mode: str(args.mode) ?? 'incremental',
        confirm: 'BUILD',
      },
    }],
  },
  {
    name: 'kb.cancel',
    summary: '取消进行中的构建',
    risk: 'mutate',
    agentExposed: true,
    params: {
      type: 'object',
      properties: { buildId: { type: 'string' } },
      required: ['buildId'],
    },
    request: (args) => [{
      method: 'POST',
      path: `/api/kb/builds/${encodeURIComponent(requireString(args, 'buildId'))}/cancel`,
    }],
  },
  {
    name: 'kb.sources.include',
    summary: '把源文档纳入标准库构建',
    risk: 'mutate',
    agentExposed: true,
    params: {
      type: 'object',
      properties: { tokens: { type: 'array', description: 'objToken 数组（1-50000）' } },
      required: ['tokens'],
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/kb/sources/selection',
      body: { action: 'include', tokens: args.tokens, root: str(args.root) },
    }],
    fillDefaults: (args, ctx) => (
      args.root === undefined ? { ...args, root: ctx.config?.knowledgeBaseRoot ?? '' } : args
    ),
  },
  {
    name: 'kb.sources.exclude',
    summary: '把源文档排除出标准库构建',
    risk: 'mutate',
    agentExposed: true,
    params: {
      type: 'object',
      properties: { tokens: { type: 'array', description: 'objToken 数组（1-50000）' } },
      required: ['tokens'],
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/kb/sources/selection',
      body: { action: 'exclude', tokens: args.tokens, root: str(args.root) },
    }],
    fillDefaults: (args, ctx) => (
      args.root === undefined ? { ...args, root: ctx.config?.knowledgeBaseRoot ?? '' } : args
    ),
  },
  {
    name: 'clean.trash.restore',
    summary: '从回收站恢复一篇文档',
    risk: 'mutate',
    agentExposed: true,
    params: {
      type: 'object',
      properties: { objToken: { type: 'string' } },
      required: ['objToken'],
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/trash/restore',
      body: { obj_token: requireString(args, 'objToken') },
    }],
  },

  // ---- destructive --------------------------------------------------------
  {
    name: 'clean.orphans',
    summary: '孤立文件清理：默认预览（dry-run），apply=true 执行清理',
    risk: 'destructive',
    agentExposed: true,
    confirm: { field: 'confirmation', value: 'APPLY' },
    params: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', description: 'false/缺省=预览；true=执行（需 confirmation APPLY）' },
        items: { type: 'array', description: '可选目标清单 [{relPath,type}]；缺省=全部当前孤立项' },
      },
    },
    request: (args) => {
      if (args.apply === true) {
        return [{
          method: 'POST',
          path: '/api/orphan-files/cleanup',
          body: {
            ...(Array.isArray(args.items) ? { items: args.items } : {}),
            confirmation: 'APPLY',
          },
        }];
      }
      return [{ method: 'GET', path: '/api/orphan-files' }];
    },
  },
  {
    name: 'clean.trash.purge',
    summary: '彻底清除回收站条目（按 objToken 或 all）',
    risk: 'destructive',
    agentExposed: true,
    confirm: { field: 'confirm', value: 'PURGE' },
    params: {
      type: 'object',
      properties: {
        objToken: { type: 'string', description: '指定文档（与 all 互斥）' },
        all: { type: 'boolean', description: '清空整个回收站（与 objToken 互斥）' },
      },
    },
    request: (args): OpsRequestSpec[] => {
      const objToken = str(args.objToken);
      if (!objToken && args.all !== true) {
        throw new OpsArgumentError('invalid_args', '需要 objToken 或 all=true 之一');
      }
      if (objToken && args.all === true) {
        throw new OpsArgumentError('invalid_args', 'objToken 与 all 互斥，只能二选一');
      }
      const query: Record<string, string> = objToken ? { obj_token: objToken } : { all: '1' };
      return [{ method: 'DELETE', path: '/api/trash/purge', query }];
    },
  },
  {
    name: 'kb.sources.cleanup',
    summary: '从标准库移除源文档登记（本地文件移入回收区，需 CLEANUP 确认）',
    risk: 'destructive',
    agentExposed: true,
    confirm: { field: 'confirm', value: 'CLEANUP' },
    params: {
      type: 'object',
      properties: {
        sources: { type: 'array', description: '[{objToken, relPath}] 清单' },
      },
      required: ['sources'],
    },
    request: (args) => {
      if (!Array.isArray(args.sources) || args.sources.length === 0) {
        throw new OpsArgumentError('invalid_args', '参数 sources 必须是非空数组');
      }
      return [{
        method: 'POST',
        path: '/api/kb/sources/cleanup',
        body: { confirm: 'CLEANUP', sources: args.sources, root: str(args.root) },
      }];
    },
    fillDefaults: (args, ctx) => (
      args.root === undefined ? { ...args, root: ctx.config?.knowledgeBaseRoot ?? '' } : args
    ),
  },

  // ---- source.*（S13 登记；路由由 S11/S12 交付）--------------------------
  // 设计 §6.3 source show/state 两命令不在本批任务书登记面内，未收录。
  {
    name: 'source.edit-status',
    summary: '读取源文档编辑状态与正文 hash（编辑 OCC baseHash 入口）',
    risk: 'read',
    agentExposed: true,
    params: {
      type: 'object',
      properties: { objToken: { type: 'string', description: '文档 objToken（位置参数）' } },
      required: ['objToken'],
    },
    request: (args) => [{
      method: 'GET',
      path: `/api/sources/${encodeURIComponent(requireString(args, 'objToken'))}/edit-status`,
    }],
  },
  {
    name: 'source.edit',
    summary: '编辑源文档正文（op/newText 二选一；baseHash 冲突 409）',
    risk: 'mutate',
    agentExposed: true,
    confirm: { field: 'confirm', value: 'EDIT' },
    params: {
      type: 'object',
      properties: {
        objToken: { type: 'string', description: '文档 objToken（位置参数）' },
        newText: { type: 'string', description: '新正文全文（不含 feishu_sync 头；与 op 二选一）' },
        op: { type: 'object', description: '编辑操作 JSON，如 {"mode":"replace_body","body":"…"} 或 {"mode":"str_replace","old":"…","new":"…"}（与 newText 二选一）' },
        baseHash: { type: 'string', description: '编辑前正文 sha256（source.edit-status 取得，OCC 乐观锁）' },
      },
      required: ['objToken', 'baseHash'],
    },
    request: (args) => {
      const objToken = requireString(args, 'objToken');
      const baseHash = requireString(args, 'baseHash');
      const hasOp = args.op !== undefined;
      const hasNewText = args.newText !== undefined;
      if (hasOp === hasNewText) {
        throw new OpsArgumentError('invalid_args', 'op 与 newText 必须提供且只提供一个');
      }
      if (hasOp && (typeof args.op !== 'object' || Array.isArray(args.op))) {
        throw new OpsArgumentError('invalid_args', 'op 必须是编辑操作对象（JSON）');
      }
      if (hasNewText && typeof args.newText !== 'string') {
        throw new OpsArgumentError('invalid_args', 'newText 必须是字符串');
      }
      return [{
        method: 'POST',
        path: `/api/sources/${encodeURIComponent(objToken)}/edit`,
        body: {
          ...(hasOp ? { op: args.op } : { newText: args.newText as string }),
          baseHash,
          confirm: 'EDIT',
          actor: 'cli',
        },
      }];
    },
  },
  {
    name: 'source.revert',
    summary: '放弃本地修改（恢复上次同步正文并清除脏状态，需 REVERT 确认）',
    risk: 'mutate',
    agentExposed: true,
    confirm: { field: 'confirm', value: 'REVERT' },
    params: {
      type: 'object',
      properties: { objToken: { type: 'string', description: '文档 objToken（位置参数）' } },
      required: ['objToken'],
    },
    request: (args) => [{
      method: 'POST',
      path: `/api/sources/${encodeURIComponent(requireString(args, 'objToken'))}/revert`,
      body: { confirm: 'REVERT', actor: 'cli' },
    }],
  },
  {
    name: 'source.push-preview',
    summary: '预览写回飞书计划（追加/覆盖/阻止原因/云端冲突与字节数）',
    risk: 'read',
    agentExposed: true,
    params: {
      type: 'object',
      properties: { objToken: { type: 'string', description: '文档 objToken（位置参数）' } },
      required: ['objToken'],
    },
    request: (args) => [{
      method: 'POST',
      path: `/api/sources/${encodeURIComponent(requireString(args, 'objToken'))}/push/preview`,
    }],
  },
  {
    name: 'source.push',
    summary: '写回飞书（追加 → PUSH；覆盖/强制 → 自动升级为 OVERWRITE_CLOUD）',
    risk: 'remote_write',
    agentExposed: true,
    // 表内 confirm 值是 CLI --yes 门与 /api/cli/:command 确认门的基线值；
    // 实际请求体的 confirm 由 request() 按 allowOverwrite/force 派生
    // （PUSH 或 OVERWRITE_CLOUD），两个值都满足「显式确认后才执行」语义。
    confirm: { field: 'confirm', value: 'PUSH' },
    params: {
      type: 'object',
      properties: {
        objToken: { type: 'string', description: '文档 objToken（位置参数）' },
        allowOverwrite: { type: 'boolean', description: '允许覆盖模式（confirm 自动升级为 OVERWRITE_CLOUD）' },
        force: { type: 'boolean', description: '越过云端冲突强推（confirm 自动升级为 OVERWRITE_CLOUD）' },
      },
      required: ['objToken'],
    },
    request: (args) => {
      const objToken = requireString(args, 'objToken');
      const allowOverwrite = args.allowOverwrite === true;
      const force = args.force === true;
      return [{
        method: 'POST',
        path: `/api/sources/${encodeURIComponent(objToken)}/push`,
        body: {
          allowOverwrite,
          force,
          confirm: allowOverwrite || force ? 'OVERWRITE_CLOUD' : 'PUSH',
          actor: 'cli',
        },
      }];
    },
  },
];

/** 按名称查命令（S9/S10 与 /api/cli/:command 执行层共用）。 */
export function findOpsCommand(name: string): OpsCommandDef | undefined {
  return OPS_COMMANDS.find((command) => command.name === name);
}

/** 命令元数据（GET /api/cli/commands；不含 request 函数体）。 */
export function opsCommandMetadata(): Array<Omit<OpsCommandDef, 'request' | 'fillDefaults'>> {
  return OPS_COMMANDS.map(({ request: _request, fillDefaults: _fillDefaults, ...rest }) => rest);
}
