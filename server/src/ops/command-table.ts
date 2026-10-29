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

/**
 * T3d-05R：server 权威确认值派生计划（source.push 专用）。表静态
 * confirm 值按参数猜测（allowOverwrite||force），与真实服务按实际
 * diff 形态（plan.mode）派生的要求不一致——append+allowOverwrite 会被
 * 猜成 OVERWRITE_CLOUD 而实际需要 PUSH。挂本计划的命令在批准前经
 * 内部 preview 请求取得权威 push plan，按 plan.mode+force 统一派生确认
 * 值（批准卡展示与执行注入同一派生值），执行前复核计划未变（批准期间
 * plan 变化 → 拒执行重新批准）。
 */
export interface OpsConfirmPlan {
  /** 内部预检请求（单步；进程内 app.request 执行，目标路由须只读副作用）。 */
  previewSpecs(args: Record<string, unknown>): OpsRequestSpec[];
  /** 由 preview 响应派生确认值；计划不可执行（blocked 等）抛 OpsArgumentError。 */
  deriveConfirm(previewJson: unknown, args: Record<string, unknown>): string;
  /** 计划指纹：批准时与执行时分别求值，不一致 → 计划过期重新批准。 */
  planKey(previewJson: unknown): string;
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
  /** T3d-05R：server 权威确认值派生（挂载时覆盖 confirm.value 的静态猜测）。 */
  confirmPlan?: OpsConfirmPlan;
  /** 是否对内部 Agent（app_command，S10）暴露。 */
  agentExposed: boolean;
  stream?: 'sse' | 'long-poll';
  fillDefaults?(args: Record<string, unknown>, ctx: OpsFillContext): Record<string, unknown>;
}

/** 命令参数构造错误（禁止路径 / 参数形态非法）；执行层转 400。 */
export class OpsArgumentError extends Error {
  code: string;
  constructor(code: 'invalid_args' | 'forbidden_path' | string, message: string) {
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
  { prefix: 'feishuPublish', reason: '反向发布段（含发布根）只接受应用设置（desktop）修改；CLI 通道不可变更云端写入权限门' },
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
  // ---- P1-S8 反向发布（设计 P1 §4.6）-------------------------------------
  {
    name: 'kb.publish-preview',
    summary: '预览标准库发布计划（create/update/skip/blocked、警告与确认值派生）',
    risk: 'read',
    agentExposed: true,
    params: {
      type: 'object',
      properties: {
        releaseId: { type: 'string', description: '发布国定的 release；缺省 = CURRENT' },
        kbPaths: { type: 'array', description: '标准库文档路径数组；缺省 = 整个 release' },
        force: { type: 'boolean', description: '与实际执行同参：解除冲突并升级确认值' },
      },
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/kb/publish/preview',
      body: {
        ...(str(args.releaseId) !== undefined ? { releaseId: str(args.releaseId) } : {}),
        ...(Array.isArray(args.kbPaths) ? { kbPaths: args.kbPaths } : {}),
        ...(args.force === true ? { force: true } : {}),
      },
    }],
  },
  {
    name: 'kb.publications',
    summary: '已发布云文档映射与状态（kb_publications）',
    risk: 'read',
    agentExposed: true,
    params: { type: 'object', properties: {} },
    request: () => [{ method: 'GET', path: '/api/kb/publications' }],
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

  // ---- P1-S8 反向发布：remote_write（发布创建/覆盖云文档）----------------
  {
    name: 'kb.publish',
    summary: '发布标准库到飞书（新建云文档 / 更新已有发布；云端冲突需 force 并升级 OVERWRITE_PUBLISHED）',
    risk: 'remote_write',
    agentExposed: true,
    // 表内 confirm 值是 CLI --yes 门与 /api/cli/:command 确认门的基线值；
    // app_command 通道由 confirmPlan 在批准前经真实 preview 派生（与
    // source.push 同一 T3d-05R 机制），不再按参数静态猜测。
    confirm: { field: 'confirm', value: 'PUBLISH' },
    confirmPlan: {
      previewSpecs: (args) => [{
        method: 'POST',
        path: '/api/kb/publish/preview',
        // preview 与实际执行同参：force 解除冲突时计划动作与确认值同步升级
        body: {
          ...(str(args.releaseId) !== undefined ? { releaseId: str(args.releaseId) } : {}),
          ...(Array.isArray(args.kbPaths) ? { kbPaths: args.kbPaths } : {}),
          ...(args.force === true ? { force: true } : {}),
        },
      }],
      deriveConfirm: (previewJson, args) => {
        const plan = (previewJson ?? {}) as {
          items?: Array<{ action?: string; cloudEdited?: boolean }>;
        };
        const items = Array.isArray(plan.items) ? plan.items : [];
        if (!items.some((item) => item.action === 'create' || item.action === 'update')) {
          throw new OpsArgumentError(
            'publish_plan_not_executable',
            '当前发布计划无可执行项（全部被阻断），不会发起发布',
          );
        }
        // 与 KbPublishService 同一契约：force 且计划含被 force 解除的
        // 冲突（publish_cloud_edited）→ OVERWRITE_PUBLISHED；否则 PUBLISH。
        return args.force === true && items.some((item) => item.cloudEdited === true)
          ? 'OVERWRITE_PUBLISHED'
          : 'PUBLISH';
      },
      planKey: (previewJson) => String((previewJson as { planKey?: unknown } | null)?.planKey ?? ''),
    },
    params: {
      type: 'object',
      properties: {
        releaseId: { type: 'string', description: '发布国定的 release；缺省 = CURRENT' },
        kbPaths: { type: 'array', description: '标准库文档路径数组；缺省 = 整个 release' },
        force: { type: 'boolean', description: '越过云端冲突覆盖已发布文档（确认值升级 OVERWRITE_PUBLISHED）' },
      },
    },
    request: (args) => [{
      method: 'POST',
      path: '/api/kb/publish',
      body: {
        ...(str(args.releaseId) !== undefined ? { releaseId: str(args.releaseId) } : {}),
        ...(Array.isArray(args.kbPaths) ? { kbPaths: args.kbPaths } : {}),
        ...(args.force === true ? { force: true } : {}),
        // 静态猜测（与 source.push 同一限制）：force 但计划无冲突时服务端
        // 实际要求 PUBLISH，会以 confirmation_required 提示具体值。
        confirm: args.force === true ? 'OVERWRITE_PUBLISHED' : 'PUBLISH',
        actor: 'cli',
      },
    }],
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
    // app_command 通道由 confirmPlan 在批准前经真实 preview 派生（见
    // OpsConfirmPlan 注释），不再按参数静态猜测。
    confirm: { field: 'confirm', value: 'PUSH' },
    confirmPlan: {
      previewSpecs: (args) => [{
        method: 'POST',
        path: `/api/sources/${encodeURIComponent(requireString(args, 'objToken'))}/push/preview`,
        // T3e-R3-01：preview 与实际执行同参——force 时时间门
        //（cloud_time_unreadable）降为 warning，计划照常派生 OVERWRITE_CLOUD
        // 批准卡；权限/内容类 blocker 仍 blocked（deriveConfirm 统一拒绝）。
        ...(args.force === true ? { body: { force: true } } : {}),
      }],
      deriveConfirm: (previewJson, args) => {
        const plan = (previewJson ?? {}) as { mode?: unknown; blockedReason?: unknown };
        if (plan.mode !== 'append' && plan.mode !== 'overwrite') {
          throw new OpsArgumentError(
            'source_push_blocked',
            `当前修改不可推送（${typeof plan.blockedReason === 'string' ? plan.blockedReason : String(plan.mode ?? '未知')}），不会发起写回`,
          );
        }
        // 与 FeishuWriteService.pushLocked 同一契约：overwrite 或 force →
        // OVERWRITE_CLOUD；否则 PUSH（append+allowOverwrite 仍是 PUSH）。
        return plan.mode === 'overwrite' || args.force === true ? 'OVERWRITE_CLOUD' : 'PUSH';
      },
      planKey: (previewJson) => {
        // P0-S3 §4.2：锚点可用性纳入计划指纹——批准期间锚点从有到无
        //（或反向）→ 计划过期重新批准，防止锚点变化后复用旧确认
        //（overwrite 无锚在执行时 422，批准与执行必须同锚点可用性）。
        const plan = (previewJson ?? null) as { mode?: unknown; rollbackAnchor?: unknown } | null;
        const anchorAvailable = plan?.rollbackAnchor != null ? 'anchor' : 'noanchor';
        return `${String(plan?.mode ?? '')}|${anchorAvailable}`;
      },
    },
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
  // ---- cloud.*（P0-S4 登记；路由由本切片交付）------------------------------
  // 任务书命名：cloud.history_list / cloud.revert（对应设计 §4.6 的
  // source.history / source.history-revert 面）。
  {
    name: 'cloud.history_list',
    summary: '云端历史版本列表（分页聚合；type=3 为回滚产生的快照）',
    risk: 'read',
    agentExposed: true,
    params: {
      type: 'object',
      properties: {
        objToken: { type: 'string', description: '文档 objToken（位置参数）' },
        pageToken: { type: 'string', description: '分页令牌（缺省从第一页聚合，上限 3 页；透传单页）' },
      },
      required: ['objToken'],
    },
    request: (args) => [{
      method: 'GET',
      path: `/api/sources/${encodeURIComponent(requireString(args, 'objToken'))}/history`,
      ...(str(args.pageToken) !== undefined ? { query: { pageToken: str(args.pageToken) as string } } : {}),
    }],
  },
  {
    name: 'cloud.revert',
    summary: '回滚云端文档到指定历史版本（destructive；确认值必须含目标 historyVersionId）',
    risk: 'destructive',
    agentExposed: true,
    // 表内基线值（CLI --yes 门与 /api/cli/:command 确认门）；实际确认值由
    // confirmPlan 按权威 preview 派生为 REVERT_CLOUD:<historyVersionId>（任务书：
    // 锚点 historyVersionId 必须出现在确认值中），CLI 通道 request() 同源构造。
    confirm: { field: 'confirm', value: 'REVERT_CLOUD' },
    confirmPlan: {
      previewSpecs: (args) => [{
        method: 'POST',
        path: `/api/sources/${encodeURIComponent(requireString(args, 'objToken'))}/history-revert/preview`,
        body: { historyVersionId: requireString(args, 'historyVersionId') },
      }],
      deriveConfirm: (previewJson) => {
        const plan = (previewJson ?? {}) as {
          blockedReason?: unknown;
          target?: { historyVersionId?: unknown } | null;
        };
        if (plan.blockedReason) {
          throw new OpsArgumentError(
            'history_revert_blocked',
            `当前不可回滚（${String(plan.blockedReason)}），不会发起云端回滚`,
          );
        }
        const targetId = plan.target && typeof plan.target.historyVersionId === 'string'
          && plan.target.historyVersionId !== '' ? plan.target.historyVersionId : null;
        if (!targetId) {
          throw new OpsArgumentError(
            'history_revert_blocked',
            '回滚计划缺少目标版本，不会发起云端回滚',
          );
        }
        return `REVERT_CLOUD:${targetId}`;
      },
      planKey: (previewJson) => {
        // §4.6：planKey = 目标版本 + 警告集（排序）；批准期间任一变化 →
        // 计划过期重新批准。
        const plan = (previewJson ?? {}) as {
          target?: { historyVersionId?: unknown } | null;
          warnings?: unknown;
        };
        const targetId = plan.target && typeof plan.target.historyVersionId === 'string'
          ? plan.target.historyVersionId : '';
        const warnings = Array.isArray(plan.warnings)
          ? (plan.warnings as unknown[]).map((item) => String(item)).sort().join(',') : '';
        return `${targetId}|${warnings}`;
      },
    },
    params: {
      type: 'object',
      properties: {
        objToken: { type: 'string', description: '文档 objToken（位置参数）' },
        historyVersionId: { type: 'string', description: '目标历史版本 id（cloud.history_list 查询；最新条目不可作目标）' },
      },
      required: ['objToken', 'historyVersionId'],
    },
    request: (args) => {
      const objToken = requireString(args, 'objToken');
      const historyVersionId = requireString(args, 'historyVersionId');
      return [{
        method: 'POST',
        path: `/api/sources/${encodeURIComponent(objToken)}/history-revert`,
        body: {
          historyVersionId,
          confirm: `REVERT_CLOUD:${historyVersionId}`,
          actor: 'cli',
        },
      }];
    },
  },
  // ---- sync.*（P0-S8 登记；设计 §5.8 存量补齐）---------------------------
  // 任务书命名 sync.whiteboard_backfill（对应设计 §5.8 命令面；风险级与
  // 确认值按设计：mutate + BACKFILL；agentExposed 按任务书双通道要求开
  // 放，超出设计 §5.8 的 agentExposed=false 登记面，报告已记偏差）。
  {
    name: 'sync.whiteboard_backfill',
    summary: '存量补齐白板旁路文件（svg 主 + raw 降级；只新增 .wb.svg/.wb.raw.json，不改 md 与同步基线；脏文档跳过）',
    risk: 'mutate',
    agentExposed: true,
    confirm: { field: 'confirm', value: 'BACKFILL' },
    params: {
      type: 'object',
      properties: {
        docTokens: { type: 'array', description: '文档 objToken 清单（位置参数可重复；缺省全量 synced 文档）' },
      },
    },
    request: (args) => {
      const docTokens = Array.isArray(args.docTokens)
        ? (args.docTokens as unknown[]).filter(
            (token): token is string => typeof token === 'string' && token.length > 0,
          )
        : [];
      return [{
        method: 'POST',
        path: '/api/sync/whiteboard-backfill',
        body: {
          confirm: 'BACKFILL',
          ...(docTokens.length > 0 ? { docTokens } : {}),
        },
      }];
    },
  },
  // ---- cloud.rename_title（P0-S9 登记；设计 §6.3 source.rename 面，任务书命名）
  {
    name: 'cloud.rename_title',
    summary: '在飞书重命名文档标题（wiki 成员传 node token；本地文件名不变；确认值 RENAME）',
    risk: 'remote_write',
    agentExposed: true,
    // 设计 §6.3 定级 remote_write（非 destructive），确认值不含新标题；
    // 新标题由 planKey（target.type|to）约束——批准期间目标或标题变化 →
    // 计划过期重新批准。
    confirm: { field: 'confirm', value: 'RENAME' },
    confirmPlan: {
      previewSpecs: (args) => [{
        method: 'POST',
        path: `/api/sources/${encodeURIComponent(requireString(args, 'objToken'))}/title/preview`,
        body: { title: requireString(args, 'title') },
      }],
      deriveConfirm: (previewJson) => {
        const plan = (previewJson ?? {}) as { blockedReason?: unknown };
        if (plan.blockedReason) {
          throw new OpsArgumentError(
            'rename_blocked',
            `当前不可改名（${String(plan.blockedReason)}），不会发起云端改名`,
          );
        }
        return 'RENAME';
      },
      planKey: (previewJson) => {
        // §6.3：planKey = `${target.type}|${to}`（批准期间换标题/换目标 → 重新批准）。
        const plan = (previewJson ?? {}) as { target?: { type?: unknown } | null; to?: unknown };
        return `${String(plan.target?.type ?? '')}|${String(plan.to ?? '')}`;
      },
    },
    params: {
      type: 'object',
      properties: {
        objToken: { type: 'string', description: '文档 objToken（位置参数）' },
        title: { type: 'string', description: '新标题（非空、无换行、≤800 字节；位置参数）' },
      },
      required: ['objToken', 'title'],
    },
    request: (args) => [{
      method: 'POST',
      path: `/api/sources/${encodeURIComponent(requireString(args, 'objToken'))}/title`,
      body: { title: requireString(args, 'title'), confirm: 'RENAME', actor: 'cli' },
    }],
  },
  // ---- P1-S3 引用图（设计 P1 §2.2）----------------------------------------
  // agentExposed=false（设计 §2.2）：只读本地 md 纯重算 body 边、零云端
  // 调用，但会全量替换引用边索引，属用户显式维护动作，不进 Agent 工具面。
  {
    name: 'sources.references-rebuild',
    summary: '全量重建引用边索引（只读本地 md 重抽 body 边，零云端调用；refmap 边随下次同步补齐，脏文档跳过）',
    risk: 'mutate',
    agentExposed: false,
    confirm: { field: 'confirm', value: 'REBUILD' },
    params: { type: 'object', properties: {} },
    request: () => [{
      method: 'POST',
      path: '/api/sources/references-rebuild',
      body: { confirm: 'REBUILD' },
    }],
  },
  // 历史移出记录只读查询。
  {
    name: 'cloud.move_status',
    summary: '查询单次移出记录状态（不触发远端调用；轮询由 server 负责）',
    risk: 'read',
    agentExposed: false,
    params: {
      type: 'object',
      properties: {
        moveId: { type: 'string', description: '移出记录 id（mv_…；位置参数）' },
      },
      required: ['moveId'],
    },
    request: (args) => [{
      method: 'GET',
      path: `/api/sources/moves/${encodeURIComponent(requireString(args, 'moveId'))}`,
    }],
  },
  {
    name: 'cloud.moves',
    summary: '移出记录列表（created_at 倒序；可按文档过滤）',
    risk: 'read',
    agentExposed: false,
    params: {
      type: 'object',
      properties: {
        objToken: { type: 'string', description: '文档 objToken（缺省全量）' },
        limit: { type: 'number', description: '返回上限（缺省 50）' },
      },
    },
    request: (args) => [{
      method: 'GET',
      path: '/api/sources/moves',
      query: {
        ...(str(args.objToken) !== undefined ? { objToken: str(args.objToken) as string } : {}),
        ...(numberOrNull(args.limit) != null ? { limit: String(numberOrNull(args.limit)) } : {}),
      },
    }],
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
