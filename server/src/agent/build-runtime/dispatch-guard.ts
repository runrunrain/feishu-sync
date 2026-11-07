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

/** 守卫配置 schema 版本；形状变更时递增并保持旧字段兼容或显式拒绝。
 * v3：新增可选 dispatch 段（A2 应用侧确定性派发准入：在途快照路径 +
 * 池容量映射）。旧 v2 信封无 dispatch，被显式拒绝（信封由宿主逐次启动
 * 生成，无跨版本持久化面）。 */
export const DISPATCH_GUARD_SCHEMA_VERSION = 3;

/** 在途快照（host 原子写；扩展读后经 options.inflight 传入守卫）。
 *
 * fail-open 约定：文件缺失/损坏/buildId·generation 不匹配/更新时间过旧
 * → 扩展不传 inflight，守卫完全跳过在途准入。在途准入是吞吐优化而非
 * 安全边界（安全边界是 amagi 池容量与本守卫的权限参数冻结），fail-open
 * 只退化为现状（amagi 排队），不会放宽任何权限。 */
export interface DispatchInflightSnapshot {
  schemaVersion: 1;
  buildId: string;
  generation: number;
  /** 单调递增序号（host 每次更新 +1；守卫据此重置本地未入账计数）。 */
  seq: number;
  updatedAt: string;
  /** 在途任务（running/queued/pending/blocked/未知态；host 与空闲判定同口径）：
 * amagi 角色名（luban/diting/baize；'unknown' = 创建事件未到达的过渡态）。 */
  inflight: Array<{ role: string; state: string }>;
  /** 待审/待修订文档计数（槽保留信号；BuildActorStore.dispatchBacklogSignal）。 */
  pendingReview: number;
  pendingRevision: number;
}

/** A2 派发准入冻结参数（可选；缺失 → 在途准入禁用）。 */
export interface FrozenDispatchAdmission {
  /** 在途快照文件绝对路径（<epochRoot>/dispatch-inflight.json；host 写、扩展读）。 */
  inflightStatePath: string;
  /** roleKey（writer/reviewer/research）→ amagi 池键（与 amagi.json concurrency.models 键同源）。 */
  rolePoolKeys: Record<string, string>;
  /** 池键 → 容量（与 amagi.json concurrency.models 值一致）。 */
  poolCapacities: Record<string, number>;
  /** 快照最大年龄 ms（超过 → fail-open；防 host 停更导致永久误拒）。 */
  staleMs?: number;
}

/** 在途快照默认最大年龄（与子任务长轮次同量级；host 正常时秒级更新）。 */
export const DISPATCH_INFLIGHT_STALE_MS = 15 * 60_000;

/** 守卫冻结配置（应用在启动 Leader 前生成，注入扩展环境）。 */
export interface FrozenDispatchConfig {
  schemaVersion: number;
  /** 历史信封缺省按严格模式处理。 */
  strictGates?: boolean;
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
  /** A2 派发准入（可选）：在途快照路径 + 池容量映射；缺失 → 在途准入禁用。 */
  dispatch?: FrozenDispatchAdmission;
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
  if (config.strictGates !== undefined && typeof config.strictGates !== 'boolean') issues.push('strictGates 非法');
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
  // A2 派发准入形状（可选；存在时必须完整：每个角色键都有池映射与容量）。
  if (config.dispatch !== undefined) {
    const dispatch = config.dispatch;
    if (!dispatch.inflightStatePath || !isAbsolute(dispatch.inflightStatePath)) {
      issues.push('dispatch.inflightStatePath 须为绝对路径');
    }
    if (dispatch.staleMs !== undefined && (!Number.isInteger(dispatch.staleMs) || dispatch.staleMs < 1_000)) {
      issues.push('dispatch.staleMs 须为 ≥1000 整数');
    }
    const roleKeySet = new Set<string>();
    for (const name of roleNames) roleKeySet.add(config.roles[name]?.key ?? '');
    roleKeySet.delete('');
    for (const [poolKey, capacity] of Object.entries(dispatch.poolCapacities ?? {})) {
      if (!Number.isInteger(capacity) || capacity < 1) issues.push(`dispatch.poolCapacities.${poolKey} 须为 ≥1 整数`);
    }
    for (const roleKey of roleKeySet) {
      const poolKey = dispatch.rolePoolKeys?.[roleKey];
      if (!poolKey || !Object.hasOwn(dispatch.poolCapacities ?? {}, poolKey)) {
        issues.push(`dispatch 缺少角色键 ${roleKey} 的池映射/容量（rolePoolKeys.poolCapacities）`);
      }
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
  // Leader briefs use either L123-456 or sourceShape's “输出 123–456”
  // coordinate label. Both denote the same assigned output-line span.
  const ranges = [...assignment.matchAll(/(?:\bL|输出\s*(?:行(?:坐标)?)?\s*[:：]?\s*)(\d+)\s*[-–—~～]\s*(?:L)?(\d+)\b/g)]
    .map((match) => [Number(match[1]), Number(match[2])] as const)
    .filter(([start, end]) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start)
    .sort(([a], [b]) => a - b);
  let coveredLines = 0;
  let coveredEnd = 0;
  for (const [start, end] of ranges) {
    coveredLines += Math.max(0, end - Math.max(start, coveredEnd + 1) + 1);
    coveredEnd = Math.max(coveredEnd, end);
  }
  // A conditional "can use csvTableImports" is not an actual offload. The
  // task must explicitly direct the server to import the table.
  const explicitTableImport = /(?:必须|直接|使用)\s*(?:kb_write_doc\.)?csvTableImports\b/.test(assignment);
  const singleImportedTable = ranges.length === 1 && explicitTableImport;
  const nonEmptyCells = [...assignment.matchAll(/(\d{3,5})\s*个非空单元格/g)]
    .map((match) => Number(match[1]));
  if (nonEmptyCells.some((count) => count > 400) && !singleImportedTable) {
    return `写作任务含 ${Math.max(...nonEmptyCells)} 个非空 CSV 单元格，单篇规则阅读与声明载荷过大；请按独立规则拆成更窄的完整文档，纯明细则明确要求 csvTableImports 服务端导入`;
  }
  if (coveredLines > 220 && /#csv:|CSV\s*附件|\.csv/.test(assignment) && !singleImportedTable) {
    return `写作任务分配了 ${coveredLines} 行 CSV 规则范围，单篇阅读过宽；请按独立主题拆至约 100–150 行，纯明细则明确要求 csvTableImports 服务端导入`;
  }
  if (coveredLines > 350 && !singleImportedTable) {
    return `写作任务明确分配了 ${coveredLines} 行来源区间，单轮读写范围过宽；请按主题拆成多篇约 100–150 行的完整文档。纯明细表由 csvTableImports 服务端导入`;
  }
  const anchors = [...new Set([...assignment.matchAll(/\bL(\d+)\b/g)].map((match) => Number(match[1])))]
    .filter((line) => Number.isSafeInteger(line) && line > 0);
  const span = anchors.length > 0 ? Math.max(...anchors) - Math.min(...anchors) : 0;
  if (anchors.length > 12 || (anchors.length >= 10 && span > 160)) {
    return `写作任务包含 ${anchors.length} 个章节定位、跨度 ${span} 行，单轮范围过宽；请按独立主题拆为更窄的单篇任务（每篇约 100–150 行，至多 12 个规则章节），只列本篇需要读取的坐标`;
  }
  const sourceLines = /(?:来源|源文档|正文)[^\n]{0,100}?(\d{3,5})\s*行/.exec(assignment)
    ?? /(?:整篇|全文)[^\n]{0,120}?(?:约|共)?\s*(\d{3,5})\s*行/.exec(assignment)
    ?? /(?:约|共)\s*(\d{3,5})\s*行/.exec(assignment);
  if (sourceLines && Number(sourceLines[1]) > 250
    && /通读全文|阅读全文|覆盖全文|从头到尾|读完全部|整篇读完|全文读完/.test(assignment)) {
    return `写作任务要求通读 ${sourceLines[1]} 行长源；请先按独立主题拆分，任务书只指定本篇约 100–150 行的目标区段`;
  }
  return null;
}

/**
 * 审查回执按文档独立发布。任务书必须给出唯一、字面可核对的目标路径，
 * 不能让一个审查任务等待同一来源的其他草稿并把它们锁在同一回执里。
 * 只检查构建审查任务（普通通用派发不受此工作流约束）。
 */
function reviewerScopeIssue(task: string): string | null {
  const assignment = task.split('[当前任务书]').at(-1) ?? task;
  if (!/【独立审查】|审查对象|kb_submit_review/.test(assignment)) return null;
  // Task briefs often describe the literal value as "coverage.docPaths 字面 = [...]".
  // Parse that wording as a declaration; the JSON path check below still enforces one doc.
  const declaration = /coverage\.docPaths(?:\s*(?:字面|字段|应为|为))?\s*(?:=|：|:)\s*(\[[^\]\n]*\])/.exec(assignment);
  if (!declaration) {
    return '审查任务书须明确写入 coverage.docPaths=["唯一目标路径.md"]；每篇文档单独派发和审查，不得以“上述多篇”代替精确范围';
  }
  let paths: unknown;
  try { paths = JSON.parse(declaration[1]); } catch { /* Invalid or illustrative list. */ }
  if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== 'string'
    || !paths[0].endsWith('.md') || paths[0].startsWith('/') || paths[0].includes('..')) {
    return 'coverage.docPaths 必须是仅含一个相对 .md 路径的 JSON 数组；多篇请分别派发审查任务';
  }
  const targetMarker = assignment.indexOf('审查对象');
  if (targetMarker >= 0) {
    const afterMarker = assignment.slice(targetMarker + '审查对象'.length);
    const sectionEnd = afterMarker.search(/\n(?:来源|背景|审查要点|提交|kb_submit_review)[:：]/);
    const reviewTargets = sectionEnd >= 0 ? afterMarker.slice(0, sectionEnd) : afterMarker.split('\n').slice(0, 6).join('\n');
    const listedCount = [...reviewTargets.matchAll(/\.md\b/g)].length;
    if (listedCount > 1 || (listedCount === 1 && !reviewTargets.includes(paths[0]))) {
      return '审查对象与 coverage.docPaths 必须指向同一篇文档；多篇目标请分别派发';
    }
  }
  return null;
}
// ── A2 在途派发准入（R2：新写作不拖后修订/复审；判定与预留分离）──

/**
 * 同一轮连发补偿记账（R3 修复：准入只判定不记账，拒绝路径不占额度）：
 * - 只在**全部守卫校验通过、即将放行**时预留（reserveUnackedSlot）；
 *   角色白名单/模型冻结/taskFile/范围等任何拒绝都不占额度。
 * - 派发后到 host 把它登记进在途快照之间（事件流异步，通常亚秒），快照
 *   滞后于真实在途：按 buildId×池记「自上次见到快照 seq 后的预留数」，
 *   快照 seq 前进即 host 已追上（至少部分），重置为 0。
 * - 原生派发后续可能失败（dryRun、参数被 amagi 拒绝等）——这类结果守卫
 *   不可观测：预留带 TTL（自该池最后一次预留起算，默认 60s）自动过期，
 *   使误扣不会持续到快照 staleMs；TTL 早于事件流时只低估不高估，偶发
 *   超放由 amagi 队列兜底，不破坏任何权限面。
 */
const unacknowledgedSubmits = new Map<string, {
  seq: number;
  byPool: Map<string, { count: number; reservedAt: number }>;
}>();

/** 未入账预留 TTL（ms）：覆盖「派发→host 登记」窗口；超时视为未发生。 */
export const DISPATCH_UNACKED_TTL_MS = 60_000;

/** 测试隔离用：清空进程内未入账记账。 */
export function resetDispatchGuardAdmissionState(): void {
  unacknowledgedSubmits.clear();
}

/** 快照有效性（buildId/generation/新鲜度）；无效 → 调用方 fail-open 跳过准入。 */
function inflightSnapshotUsable(config: FrozenDispatchConfig, snapshot: DispatchInflightSnapshot | null, now: string): boolean {
  if (!config.dispatch || !snapshot) return false;
  if (snapshot.buildId !== config.buildId || snapshot.generation !== config.generation) return false;
  const staleMs = config.dispatch.staleMs ?? DISPATCH_INFLIGHT_STALE_MS;
  const at = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(at) || Date.parse(now) - at > staleMs) return false;
  return true;
}

/** 池在途计数：role → roleKey → 池；未登记角色（含 'unknown'）保守计入全部池。 */
function poolInflightCounts(config: FrozenDispatchConfig, snapshot: DispatchInflightSnapshot): Map<string, number> {
  const pools = Object.keys(config.dispatch!.poolCapacities);
  const counts = new Map<string, number>();
  const bump = (poolKey: string): void => { counts.set(poolKey, (counts.get(poolKey) ?? 0) + 1); };
  for (const entry of snapshot.inflight) {
    if (!entry || typeof entry !== 'object' || typeof entry.role !== 'string') continue;
    const roleKey = config.roles[entry.role]?.key;
    const poolKey = roleKey ? config.dispatch!.rolePoolKeys[roleKey] : undefined;
    if (poolKey) bump(poolKey);
    else for (const key of pools) bump(key);
  }
  return counts;
}

/** 在途准入判定结果（null = 不适用：无 dispatch 段或快照不可用 → fail-open）。 */
interface AdmissionDecision {
  allowed: boolean;
  code?: 'dispatch_inflight_write_exhausted' | 'dispatch_inflight_pool_saturated';
  message?: string;
  /** 进 audit.changes 的人可读摘要（不含任务正文）。 */
  detail?: string;
  /** submit 放行时需预留的池键（guardTaskSubmit 全部校验通过后经
 * reserveUnackedSlot 记账；resume 恒无：原任务模型未知，记错池会误伤
 * 审查/修订优先级，过渡期由 amagi 队列兑底）。 */
  admitPool?: string;
}

/**
 * 确定性派发准入（R2；amagi 队列在外部包内不可重排，只能控制派发）：
 * - 新写作（task_submit writer/research）：池在途 +1 ≤ 池容量；且当存在
 *   待审/待修订文档时最多占容量 −1（为审查/修订保留至少 1 槽；无积压
 *   可占满）。
 * - 独立审查（task_submit reviewer）与修订/续接（task_resume 一切）：
 *   优先类，只要池未满即放行，不受保留槽限制。
 * - 无死锁：准入只影响「派发时机」——任务终态后 host 快照释放槽；快照
 *   过旧/缺失时 fail-open（退化为准入前行为），不会永久拒绝。
 */
function checkDispatchAdmission(input: {
  config: FrozenDispatchConfig;
  snapshot: DispatchInflightSnapshot | null;
  tool: 'task_submit' | 'task_resume';
  /** submit：白名单后的角色键；resume：null（池归属由 amagi 按原任务模型路由）。 */
  roleKey: string | null;
  now: string;
}): AdmissionDecision | null {
  const { config, snapshot, tool, roleKey, now } = input;
  if (!config.dispatch || !inflightSnapshotUsable(config, snapshot, now)) return null;
  const dispatch = config.dispatch;
  const counts = poolInflightCounts(config, snapshot!);
  const entry = unacknowledgedSubmits.get(config.buildId);
  const nowMs = Date.parse(now);
  const unackedFor = (poolKey: string): number => {
    if (!entry || entry.seq !== snapshot!.seq) return 0;
    const reserved = entry.byPool.get(poolKey);
    if (!reserved || nowMs - reserved.reservedAt > DISPATCH_UNACKED_TTL_MS) return 0; // TTL 过期
    return reserved.count;
  };
  const effectiveFor = (poolKey: string): number => (counts.get(poolKey) ?? 0) + unackedFor(poolKey);
  const capacityOf = (poolKey: string): number => dispatch.poolCapacities[poolKey];
  const backlog = (snapshot!.pendingReview ?? 0) + (snapshot!.pendingRevision ?? 0) > 0;
  if (tool === 'task_resume') {
    // resume 池归属派发侧不可知：任一池有空槽即放行，全池满才拒。
    // 放行不记未入账（原任务模型未知，记错池会误伤审查/修订优先级；
    // 过渡期由 amagi 队列兜底，host 登记后快照即精确）。
    const freePool = Object.keys(dispatch.poolCapacities)
      .find((poolKey) => effectiveFor(poolKey) + 1 <= capacityOf(poolKey));
    if (freePool) return { allowed: true, detail: `admission: resume 优先（空槽池 ${freePool}）` };
    const summary = Object.keys(dispatch.poolCapacities)
      .map((poolKey) => `${poolKey}=${effectiveFor(poolKey)}/${capacityOf(poolKey)}`).join('，');
    return {
      allowed: false,
      code: 'dispatch_inflight_pool_saturated',
      message: `全部准入池均已满（${summary}）。请等已有任务的完成通知后再派发；修订与审查在池内出现空槽后立即放行。`,
    };
  }
  // task_submit：roleKey 必在（角色白名单先行拒绝）。
  const poolKey = dispatch.rolePoolKeys[roleKey ?? ''];
  const capacity = poolKey !== undefined ? capacityOf(poolKey) : undefined;
  if (poolKey === undefined || capacity === undefined) return null; // 池映射不全：fail-open
  const priority = roleKey === 'reviewer';
  const effective = effectiveFor(poolKey);
  const limit = priority ? capacity : backlog ? capacity - 1 : capacity;
  const detail = `admission: pool=${poolKey} effective=${effective}/${capacity}${backlog ? '（待审/待修订积压，新写作上限 −1）' : ''}${priority ? '（审查优先）' : ''}`;
  if (effective + 1 > limit) {
    const reason = priority
      ? `本池在途任务已达容量（${effective}/${capacity}）。请等已有任务的完成通知后再派发审查。`
      : `本模型池在途任务已达派发上限（${effective}/${capacity}${backlog ? '，且存在待审/待修订文档，已为审查与修订保留槽位' : ''}）。请等已有任务的完成通知再派发新写作；修订（task_resume 续接作者）与独立审查派发不受此限。`;
    return {
      allowed: false,
      code: priority ? 'dispatch_inflight_pool_saturated' : 'dispatch_inflight_write_exhausted',
      message: reason,
      detail,
    };
  }
  // 判定与记账分离（R3）：这里只判定不记账；admitPool 由 guardTaskSubmit
  // 在**全部校验通过、即将放行**时经 reserveUnackedSlot 预留，任何拒绝
  // 路径（模型/taskFile/范围等）都不占额度。
  return { allowed: true, detail, admitPool: poolKey };
}

/** 最终放行前预留一个未入账槽（仅 submit 全部校验通过后调用；TTL 见 unacknowledgedSubmits）。 */
function reserveUnackedSlot(config: FrozenDispatchConfig, snapshot: DispatchInflightSnapshot, poolKey: string, now: string): void {
  const entry = unacknowledgedSubmits.get(config.buildId);
  if (!entry || entry.seq !== snapshot.seq) {
    unacknowledgedSubmits.set(config.buildId, { seq: snapshot.seq, byPool: new Map() });
  }
  const current = unacknowledgedSubmits.get(config.buildId)!;
  const reserved = current.byPool.get(poolKey);
  const at = Date.parse(now);
  if (reserved && at - reserved.reservedAt <= DISPATCH_UNACKED_TTL_MS) {
    reserved.count += 1;
    reserved.reservedAt = at;
  } else {
    current.byPool.set(poolKey, { count: 1, reservedAt: at });
  }
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
  options: { now?: () => string; inflight?: DispatchInflightSnapshot | null } = {},
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

  // 1b. A2 在途派发准入（快照缺失/陈旧 → fail-open，仅退化为无准入）。
  const admission = checkDispatchAdmission({
    config,
    snapshot: options.inflight ?? null,
    tool: 'task_submit',
    roleKey: role.key,
    now,
  });
  if (admission && !admission.allowed) {
    return {
      decision: 'block',
      code: admission.code!,
      message: admission.message!,
      audit: { ...baseAudit, changes: [...changes, admission.detail ?? 'admission 拒绝'] },
    };
  }
  if (admission?.detail) changes.push(admission.detail);

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
      if (config.strictGates !== false) return { decision: 'block', code: 'dispatch_writer_scope_too_broad', message: issue, audit: baseAudit };
      changes.push(`advisory: ${issue}`);
    }
  }
  if (role.key === 'reviewer' && typeof args.task === 'string') {
    const issue = reviewerScopeIssue(args.task);
    if (issue) {
      if (config.strictGates !== false) return { decision: 'block', code: 'dispatch_reviewer_scope_too_broad', message: issue, audit: baseAudit };
      changes.push(`advisory: ${issue}`);
    }
  }
  if (role.key === 'reviewer' && typeof args.task !== 'string') {
    const message = '审查任务须在 task 正文中给出唯一目标和 coverage.docPaths；不可用不可核对的 taskFile 派发';
    if (config.strictGates !== false) return { decision: 'block', code: 'dispatch_reviewer_scope_too_broad', message, audit: baseAudit };
    changes.push(`advisory: ${message}`);
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

  // R3：准入判定与记账分离——全部校验通过、即将放行时才预留未入账槽；
  // 任何拒绝路径（模型/taskFile/范围/审查范围等）不占额度。
  if (admission?.admitPool && options.inflight) {
    reserveUnackedSlot(config, options.inflight, admission.admitPool, now);
  }

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
  options: { now?: () => string; inflight?: DispatchInflightSnapshot | null } = {},
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
  // A2 在途准入：修订/续接为优先类（只受池容量硬上限约束，见 checkDispatchAdmission）。
  const admission = checkDispatchAdmission({
    config,
    snapshot: options.inflight ?? null,
    tool: 'task_resume',
    roleKey: null,
    now,
  });
  if (admission && !admission.allowed) {
    return {
      decision: 'block',
      code: admission.code!,
      message: admission.message!,
      audit: { ...audit, changes: [...changes, admission.detail ?? 'admission 拒绝'] },
    };
  }
  if (admission?.detail) changes.push(admission.detail);
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
  strictGates?: boolean;
  generation: number;
  workDir: string;
  reportRoot?: string;
  forbiddenZones: string[];
  roles: Record<string, { key: string; models: string[]; mcpTools: string[] }>;
  integrity: RuntimeIntegrityRefs;
  /** A2 派发准入（可选；形状非法同样抛错）。 */
  dispatch?: FrozenDispatchAdmission;
}): FrozenDispatchConfig {
  const config: FrozenDispatchConfig = {
    schemaVersion: DISPATCH_GUARD_SCHEMA_VERSION,
    strictGates: input.strictGates,
    buildId: input.buildId,
    generation: input.generation,
    workDir: input.workDir,
    reportRoot: input.reportRoot ?? 'agent-outputs',
    forbiddenZones: sortedUnique(input.forbiddenZones),
    roles: input.roles,
    integrity: input.integrity,
    ...(input.dispatch ? { dispatch: input.dispatch } : {}),
  };
  const issues = validateGuardConfig(config);
  if (issues.length > 0) {
    throw new Error(`派发守卫冻结配置非法：${issues.join('；')}`);
  }
  return config;
}
