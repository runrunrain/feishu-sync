/**
 * build-runtime/dispatch-guard.ts — task_submit/task_resume 派发参数守卫（纯函数）
 *
 * 设计来源：设计v2 §3.4「派发参数守卫」。守卫由应用转发扩展在 Leader 进程内
 * 的 tool_call 钩子调用（执行前修改参数或阻止调用），模型无法绕开。
 *
 * 消费方式（重要——并行切片契约）：
 * 1. server 侧：`import { freezeGuardConfig, guardTaskSubmit, guardTaskResume } from './build-runtime/dispatch-guard.js'`
 * 2. pi-extension（feishu-sync-agent.js，纯 JS）：宿主经环境变量传入编译产物绝对路径
 *    `server/dist/agent/build-runtime/dispatch-guard.js`，扩展内
 *    `const guard = await import(process.env.FEISHU_SYNC_BUILD_GUARD_MODULE)` 即得同名导出。
 *    本模块因此【零第三方依赖、仅 node:crypto】，且所有输入输出可 JSON 序列化。
 *
 * 守卫只修正权限参数，不选择任务、不决定先后（设计 §3.4）。
 */

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
// F12：仅类型引入（编译后擦除，不产生运行时相对 import——本模块保持零运行时
// 依赖，可被 pi/jiti 单文件加载；运行时核验模块由扩展按同目录路径另行装载）。
import type { RuntimeIntegrityRefs } from './runtime-integrity.js';

/** 守卫配置 schema 版本；形状变更时递增并保持旧字段兼容或显式拒绝。 */
export const DISPATCH_GUARD_SCHEMA_VERSION = 2;

/** 守卫冻结配置（应用在启动 Leader 前生成，注入扩展环境）。 */
export interface FrozenDispatchConfig {
  schemaVersion: number;
  buildId: string;
  generation: number;
  /** 固定工作目录（workspace.cwd 强制值，绝对路径）。 */
  workDir: string;
  /** 唯一报告写面（scope.write / reportFiles / outputPaths 强制前缀）。 */
  reportRoot: string;
  /** 禁区（绝对路径前缀；追加进 scope.deny，禁止读写）。 */
  forbiddenZones: string[];
  /** amagi agent 名 → 该角色的冻结约束。 */
  roles: Record<string, {
    /** 应用侧角色键（writer/reviewer/research）。 */
    key: string;
    /** 允许的模型 spec（含冻结 thinking 档位；空数组 = 禁止任何覆盖）。 */
    models: string[];
    /** 该角色 scope.mcp 的精确知识工具名（空数组 = 不授予 MCP 工具）。 */
    mcpTools: string[];
  }>;
  /**
   * F12（审核修复）：派发前重核验的冻结引用（settings/policy/包/四配置）。
   * 必填——旧代次信封（schemaVersion 1 无 integrity）会被 fail-closed 拒绝；
   * 扩展在每次 task_submit/task_resume 前调 verifyRuntimeIntegrity，不 ok 即阻断。
   */
  integrity: RuntimeIntegrityRefs;
}

/** 守卫审计记录（作为运行事件上报；不含任务正文，只含哈希）。 */
export interface DispatchGuardAudit {
  buildId: string;
  generation: number;
  tool: 'task_submit' | 'task_resume';
  agent: string | null;
  roleKey: string | null;
  /** 任务书正文哈希（taskFile 派发时为文件路径的哈希标记）。 */
  taskSha256: string | null;
  model: string | null;
  /** 生效后的权限参数快照（scope/workspace）。 */
  effective: {
    scope: Record<string, unknown> | null;
    workspace: Record<string, unknown> | null;
  };
  /** 守卫做出的全部修改（人可读，供事件流与诊断）。 */
  changes: string[];
  guardedAt: string;
}

export type GuardDecision =
  | { decision: 'allow'; args: Record<string, unknown>; audit: DispatchGuardAudit }
  | { decision: 'block'; code: string; message: string; audit: DispatchGuardAudit };

// ── 校验冻结配置 ───────────────────────────────────────────────

export function validateGuardConfig(config: FrozenDispatchConfig): string[] {
  const issues: string[] = [];
  if (config.schemaVersion !== DISPATCH_GUARD_SCHEMA_VERSION) issues.push(`schemaVersion 不支持（期望 ${DISPATCH_GUARD_SCHEMA_VERSION}）`);
  if (!config.buildId) issues.push('buildId 缺失');
  if (!Number.isInteger(config.generation) || config.generation < 1) issues.push('generation 非法');
  if (!config.workDir || !isAbsolute(config.workDir)) issues.push(`workDir 须为绝对路径（与宿主平台一致：${process.platform === 'win32' ? '盘符/UNC' : 'POSIX /…'}）`);
  if (!config.reportRoot || config.reportRoot.includes('..')) issues.push('reportRoot 非法');
  if (!Array.isArray(config.forbiddenZones)) issues.push('forbiddenZones 须为数组');
  const roleNames = Object.keys(config.roles ?? {});
  if (roleNames.length === 0) issues.push('roles 为空（无任何可派发角色）');
  for (const name of roleNames) {
    const role = config.roles[name];
    if (!role || typeof role !== 'object') { issues.push(`roles.${name} 非法`); continue; }
    if (!Array.isArray(role.models)) issues.push(`roles.${name}.models 须为数组`);
    if (!Array.isArray(role.mcpTools)) issues.push(`roles.${name}.mcpTools 须为数组`);
    if (!role.key) issues.push(`roles.${name}.key 缺失`);
  }
  // F12：完整性引用必填（缺失/形状非法 → 信封整体非法，扩展装载即 fail-closed）。
  // 形状检查为信封装载子集（与 runtime-integrity.validateRuntimeIntegrityRefs 同文案；
  // 权威逐次触盘核验在 verifyRuntimeIntegrity，派发前由扩展强制执行）。
  if (!config.integrity || typeof config.integrity !== 'object') {
    issues.push('integrity 缺失（F12 运行期完整性重核验引用必须随信封冻结）');
  } else {
    const refs = config.integrity as RuntimeIntegrityRefs;
    if (refs.schemaVersion !== 1) issues.push(`integrity.schemaVersion 不支持（期望 1）`);
    if (!refs.homeDir || !isAbsolute(refs.homeDir)) issues.push('integrity.homeDir 须为绝对路径');
    const files = refs.expectedFiles as Record<string, unknown> | undefined;
    for (const key of ['settings', 'amagi', 'models', 'mcp']) {
      if (typeof files?.[key] !== 'string' || (files[key] as string).length === 0) {
        issues.push(`integrity.expectedFiles.${key} 缺失`);
      }
    }
    if (!/^child-policy-[0-9a-f]{12}\.js$/.test(refs.childPolicy?.fileName ?? '')) {
      issues.push('integrity.childPolicy.fileName 须为内容寻址 child-policy-<hash12>.js');
    }
    if (!/^[0-9a-f]{64}$/.test(refs.childPolicy?.sha256 ?? '')) issues.push('integrity.childPolicy.sha256 须为 hex64');
    if (!refs.amagiPackage?.packageRoot || !isAbsolute(refs.amagiPackage.packageRoot)) {
      issues.push('integrity.amagiPackage.packageRoot 须为绝对路径');
    }
    if (!refs.amagiPackage?.contentHash) issues.push('integrity.amagiPackage.contentHash 缺失');
    if (!refs.workflowSkill?.path || !isAbsolute(refs.workflowSkill?.path ?? '')) {
      issues.push('integrity.workflowSkill.path 须为绝对路径');
    }
    if (!/^[0-9a-f]{64}$/.test(refs.workflowSkill?.sha256 ?? '')) {
      issues.push('integrity.workflowSkill.sha256 须为 hex64（= spec.workflowRevision）');
    }
  }
  return issues;
}

// ── 内部纯工具 ────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** 比较用规范化：统一分隔符为 / 并去尾部重复斜杠（Windows 盘符/UNC 与 POSIX 条目同口径比较）。 */
function normPathForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isInsideDir(target: string, dir: string): boolean {
  const t = normPathForCompare(target);
  const d = normPathForCompare(dir);
  if (t === d) return true;
  return t.startsWith(d.endsWith('/') ? d : `${d}/`);
}

/** 路径条目是否落在报告写面内（支持 `agent-outputs/**`、`agent-outputs`、`agent-outputs/x.md`）。 */
function withinReportSurface(entry: string, reportRoot: string): boolean {
  const normalized = normPathForCompare(entry).replace(/^\.\//, '');
  const root = normPathForCompare(reportRoot);
  if (normalized === root || normalized === `${root}/**`) return true;
  return isInsideDir(normalized, root);
}

function isAbsoluteLike(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** 路径条目（绝对或相对）是否越出固定工作目录（workDir 与条目同口径规范化后比较；
 * 任意位置含 .. 段即拒绝——前缀内嵌 .. 同样是逃逸，F13 规范化收口）。 */
function escapesWorkDir(entry: string, workDir: string): boolean {
  const normalized = normPathForCompare(entry);
  if (normalized.split('/').includes('..')) return true;
  if (isAbsoluteLike(normalized)) return !isInsideDir(normalized, workDir);
  return false;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * 写作任务的章节坐标是应用 build_manifest 给出的机械索引。长源若把大量章节
 * 塞进同一轮 high 思考，模型可能在调用 kb_write_doc 前耗尽输出额度。这里仅
 * 拒绝可确定过宽的任务书；稀疏的跨段引用和明细表不按首末坐标跨度误判。
 */
function writerScopeIssue(task: string): string | null {
  const assignment = task.split('[当前任务书]').at(-1) ?? task;
  const anchors = [...new Set([...assignment.matchAll(/\bL(\d+)\b/g)].map((match) => Number(match[1])))]
    .filter((line) => Number.isSafeInteger(line) && line > 0);
  const span = anchors.length > 0 ? Math.max(...anchors) - Math.min(...anchors) : 0;
  if (anchors.length > 12 || (anchors.length >= 10 && span > 160)) {
    return `写作任务包含 ${anchors.length} 个章节定位、跨度 ${span} 行，单轮范围过宽；请按独立主题拆为更窄的单篇任务（每篇约 100–150 行，至多 12 个规则章节），只列本篇需要读取的坐标`;
  }
  const sourceLines = /(?:来源|源文档|正文)[^\n]{0,100}?(\d{3,5})\s*行/.exec(assignment);
  if (sourceLines && Number(sourceLines[1]) > 250
    && /通读全文|阅读全文|覆盖全文|从头到尾|读完全部/.test(assignment)) {
    return `写作任务要求通读 ${sourceLines[1]} 行长源；请先按独立主题拆分，任务书只指定本篇约 100–150 行的目标区段`;
  }
  return null;
}

// ── task_submit 守卫 ───────────────────────────────────────────

/**
 * 校验并冻结一次 task_submit 派发。参数形状对齐 amagi SubmitParams
 * （extensions/amagi-core/task-facets.ts，2.21.31 实测）：
 * { agent, task|taskFile, delivery, scope{read,write,deny,reportFiles,shell,mcp,lsp,codemode,advisor},
 *   workspace{cwd,mode,worktreeName,...}, profile, model, inputs/outputs/inputPaths/outputPaths, dryRun }
 */
export function guardTaskSubmit(
  config: FrozenDispatchConfig,
  rawArgs: Record<string, unknown>,
  options: { now?: () => string } = {},
): GuardDecision {
  const now = options.now?.() ?? new Date().toISOString();
  const args: Record<string, unknown> = { ...rawArgs };
  const changes: string[] = [];
  const baseAudit: {
    buildId: string;
    generation: number;
    tool: 'task_submit' | 'task_resume';
    agent: string | null;
    roleKey: string | null;
    taskSha256: string | null;
    model: string | null;
    effective: { scope: Record<string, unknown> | null; workspace: Record<string, unknown> | null };
    changes: string[];
    guardedAt: string;
  } = {
    buildId: config.buildId,
    generation: config.generation,
    tool: 'task_submit',
    agent: typeof args.agent === 'string' ? args.agent : null,
    roleKey: null,
    taskSha256: null,
    model: typeof args.model === 'string' ? args.model : null,
    effective: { scope: null, workspace: null },
    changes,
    guardedAt: now,
  };

  // 1. 角色白名单
  const agent = typeof args.agent === 'string' ? args.agent : '';
  const role = config.roles[agent];
  if (!agent || !role) {
    return {
      decision: 'block',
      code: 'dispatch_role_not_allowed',
      message: `角色 "${agent || '(缺失)'}" 不在本次构建的角色表内（允许：${Object.keys(config.roles).join(', ')}）`,
      audit: baseAudit,
    };
  }
  baseAudit.roleKey = role.key;

  // 2. 模型覆盖冻结
  if (args.model !== undefined) {
    const requested = String(args.model);
    if (!role.models.includes(requested)) {
      return {
        decision: 'block',
        code: 'dispatch_model_not_frozen',
        message: `模型覆盖 "${requested}" 不在角色 ${agent} 的冻结模型内（允许：${role.models.join(', ') || '（无——禁止覆盖）'}）`,
        audit: { ...baseAudit, model: requested },
      };
    }
  }

  // 3. 任务书位置约束（taskFile 不得越出工作目录）
  if (typeof args.taskFile === 'string' && escapesWorkDir(args.taskFile, config.workDir)) {
    return {
      decision: 'block',
      code: 'dispatch_task_file_outside_workdir',
      message: `taskFile "${args.taskFile}" 越出固定工作目录`,
      audit: baseAudit,
    };
  }
  baseAudit.taskSha256 = typeof args.task === 'string' && args.task
    ? sha256(args.task)
    : typeof args.taskFile === 'string' ? sha256(`taskFile:${args.taskFile}`) : null;

  if (role.key === 'writer' && typeof args.task === 'string') {
    const issue = writerScopeIssue(args.task);
    if (issue) {
      return { decision: 'block', code: 'dispatch_writer_scope_too_broad', message: issue, audit: baseAudit };
    }
  }

  // 创建回执携带原生 taskId；wait 模式直到子任务终态才返回，期间身份始终
  // pending，应用只能下发只读 MCP 面。构建必须先拿句柄并确认身份。
  if (args.delivery !== 'handle') {
    changes.push(`delivery ${String(args.delivery ?? '(缺省)')} → handle（先登记任务身份）`);
    args.delivery = 'handle';
  }

  // 4. workspace 固定
  const workspace = (args.workspace && typeof args.workspace === 'object' ? { ...(args.workspace as Record<string, unknown>) } : {});
  if (workspace.cwd !== undefined && workspace.cwd !== config.workDir) changes.push(`workspace.cwd ${String(workspace.cwd)} → ${config.workDir}`);
  if (workspace.mode !== undefined && workspace.mode !== 'existing') changes.push(`workspace.mode ${String(workspace.mode)} → existing`);
  if (workspace.worktreeName !== undefined) { delete workspace.worktreeName; changes.push('删除 workspace.worktreeName（构建不使用 worktree）'); }
  if (workspace.base !== undefined) { delete workspace.base; changes.push('删除 workspace.base'); }
  if (workspace.dependencyVisibility !== undefined) { delete workspace.dependencyVisibility; changes.push('删除 workspace.dependencyVisibility'); }
  args.workspace = { cwd: config.workDir, mode: 'existing' };

  // 5. scope 冻结
  const scope = (args.scope && typeof args.scope === 'object' ? { ...(args.scope as Record<string, unknown>) } : {});
  if (scope.shell !== 'deny') { changes.push(`scope.shell ${scope.shell === undefined ? '(缺省)' : String(scope.shell)} → deny`); }
  scope.shell = 'deny';
  for (const field of ['lsp', 'advisor', 'codemode'] as const) {
    if (scope[field] !== undefined) { delete scope[field]; changes.push(`删除 scope.${field}`); }
  }
  // 写面：只保留报告目录
  const originalWrite = Array.isArray(scope.write) ? (scope.write as unknown[]).map(String) : [];
  const keptWrite = originalWrite.filter((entry) => withinReportSurface(entry, config.reportRoot));
  if (keptWrite.length !== originalWrite.length) changes.push(`scope.write 移除报告目录外条目 ${originalWrite.length - keptWrite.length} 项`);
  scope.write = sortedUnique([...keptWrite, `${config.reportRoot}/**`]);
  // 报告写面：同样只留报告目录内
  if (Array.isArray(scope.reportFiles)) {
    const original = (scope.reportFiles as unknown[]).map(String);
    const kept = original.filter((entry) => withinReportSurface(entry, config.reportRoot) && !escapesWorkDir(entry, config.workDir));
    if (kept.length !== original.length) changes.push(`scope.reportFiles 移除越界条目 ${original.length - kept.length} 项`);
    scope.reportFiles = sortedUnique(kept);
  }
  // 禁区：冻结覆写（与扩展侧统一策略：denyPaths 替换而非合并——确定性强，
  // 且 deny 是我们保护面的权威声明；模型自加 deny 属自限制非授权面）
  const originalDeny = Array.isArray(scope.deny) ? (scope.deny as unknown[]).map(String) : [];
  const frozenDeny = sortedUnique(config.forbiddenZones);
  scope.deny = frozenDeny;
  if (originalDeny.join(',') !== frozenDeny.join(',')) {
    changes.push(`scope.deny 覆写为 ${frozenDeny.length} 项构建禁区（模型自报 ${originalDeny.length} 项被替换）`);
  }
  // MCP 工具名单：按角色精确写入
  const originalMcp = Array.isArray(scope.mcp) ? (scope.mcp as unknown[]).map(String) : [];
  const frozenMcp = sortedUnique(role.mcpTools);
  scope.mcp = frozenMcp;
  if (originalMcp.join(',') !== frozenMcp.join(',')) {
    changes.push(`scope.mcp 冻结为角色 ${agent} 的 ${frozenMcp.length} 项知识工具`);
  }
  args.scope = scope;

  // 6. outputs/outputPaths 收敛到报告目录
  for (const field of ['outputPaths', 'outputs'] as const) {
    if (Array.isArray(args[field])) {
      const original = (args[field] as unknown[]).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
      const kept = original.filter((entry) => withinReportSurface(entry, config.reportRoot));
      if (kept.length !== original.length) changes.push(`${field} 移除报告目录外条目 ${original.length - kept.length} 项`);
      if (kept.length > 0) args[field] = kept; else delete args[field];
    }
  }

  // 7. profile 会改变模型解析链，删除
  if (args.profile !== undefined) { delete args.profile; changes.push('删除 profile（模型解析冻结）'); }

  baseAudit.effective = { scope: scope as Record<string, unknown>, workspace: args.workspace as Record<string, unknown> };
  return { decision: 'allow', args, audit: baseAudit };
}

// ── task_resume 守卫 ───────────────────────────────────────────

/**
 * task_resume 继承原任务范围、不接受权限字段（amagi ResumeParams =
 * { handle, message, delivery?, model? }），守卫只校验模型覆盖。
 * 防御性：若模型面塞入 scope/workspace 等字段，直接删除（amagi schema
 * 本会拒绝，守卫提前剥离保证 dry-run 预检口径一致）。
 */
export function guardTaskResume(
  config: FrozenDispatchConfig,
  rawArgs: Record<string, unknown>,
  options: { now?: () => string } = {},
): GuardDecision {
  const now = options.now?.() ?? new Date().toISOString();
  const args: Record<string, unknown> = { ...rawArgs };
  const changes: string[] = [];
  const allModels = sortedUnique(Object.values(config.roles).flatMap((role) => role.models));
  const audit: DispatchGuardAudit = {
    buildId: config.buildId,
    generation: config.generation,
    tool: 'task_resume',
    agent: null,
    roleKey: null,
    taskSha256: typeof args.message === 'string' && args.message ? sha256(args.message) : null,
    model: typeof args.model === 'string' ? args.model : null,
    effective: { scope: null, workspace: null },
    changes,
    guardedAt: now,
  };
  if (typeof args.handle !== 'string' || !args.handle) {
    return { decision: 'block', code: 'dispatch_resume_handle_missing', message: 'task_resume 缺少 handle', audit };
  }
  if (args.delivery !== 'handle') {
    changes.push(`delivery ${String(args.delivery ?? '(缺省)')} → handle（先登记续接身份）`);
    args.delivery = 'handle';
  }
  if (args.model !== undefined) {
    const requested = String(args.model);
    if (!allModels.includes(requested)) {
      return {
        decision: 'block',
        code: 'dispatch_model_not_frozen',
        message: `续接模型覆盖 "${requested}" 不在冻结模型集内（允许：${allModels.join(', ')}）`,
        audit: { ...audit, model: requested },
      };
    }
  }
  for (const field of ['scope', 'workspace', 'profile'] as const) {
    if (args[field] !== undefined) { delete args[field]; changes.push(`删除 ${field}（resume 不接受权限字段）`); }
  }
  return { decision: 'allow', args, audit };
}

// ── 冻结配置构造（server 侧便捷入口；扩展侧只消费 JSON） ──────────────

/** 由 BuildRunSpec 形状生成守卫冻结配置（角色模型/工具名单与完整性引用由调用方补齐）。 */
export function freezeGuardConfig(input: {
  buildId: string;
  generation: number;
  workDir: string;
  reportRoot?: string;
  forbiddenZones: string[];
  roles: Record<string, { key: string; models: string[]; mcpTools: string[] }>;
  integrity: RuntimeIntegrityRefs;
}): FrozenDispatchConfig {
  const config: FrozenDispatchConfig = {
    schemaVersion: DISPATCH_GUARD_SCHEMA_VERSION,
    buildId: input.buildId,
    generation: input.generation,
    workDir: input.workDir,
    reportRoot: input.reportRoot ?? 'agent-outputs',
    forbiddenZones: sortedUnique(input.forbiddenZones),
    roles: input.roles,
    integrity: input.integrity,
  };
  const issues = validateGuardConfig(config);
  if (issues.length > 0) {
    throw new Error(`派发守卫冻结配置非法：${issues.join('；')}`);
  }
  return config;
}
