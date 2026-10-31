/**
 * BuildOrchestration —— 多模型构建编排任务状态机（B 案《多模型构建编排
 * 方案（讨论稿）》§5/§7/§8 + 附录 A/B）的调度骨架。
 *
 * T2a 范围：可测试的任务集合管理、三轴状态机、依赖解锁、修订预算、
 * 接口失败计数、迟到回执与快照恢复。审查/修订/整合的实际执行流水属
 * T2b（后续任务）；本模块是纯逻辑 + 可注入持久化，不发起任何模型调用，
 * 不持有进程或文件句柄。
 *
 * 核心不变量（条文以「B 案 §x」标注）：
 * 1. 三轴分离：exec/artifact/acceptance 独立推进，模型回复“完成”不等
 *    于质量通过（B 案 §7）；
 * 2. 修订预算按逻辑审查对象累计，同一对象换稿不重置；预算耗尽进
 *    pending_decision，不由总控一句“接受”抹掉阻断问题（B 案 §5）；
 * 3. 接口失败与内容不通过分开计数：接口重试 ≤ maxInterfaceRetries，
 *    内容修订轮 ≤ maxAutoRevisions（B 案 §5）；
 * 4. 任务已取消/构建已结束后，迟到回执记录原因并拒绝推进；相同提交
 *    幂等（B 案 §8 + 附录 B「提交产物或报告」）；
 * 5. 依赖解锁：artifact_available 解锁审查、acceptance_passed 解锁整合；
 *    审查任务执行结束但报告（产物）缺失不能解锁下游（B 案 §7）；
 * 6. BuildSpec 构造即冻结（specHash），后续修订产生新任务，不悄悄改
 *    已派发的规格（B 案 §8）。
 */

import { createHash } from 'node:crypto';
import {
  BUILD_EXEC_TERMINAL_STATES,
  BUILD_ROLES,
  revisionBudgetExhausted,
  type BuildExecState,
  type BuildRole,
  type BuildSpec,
  type BuildTask,
  type BuildTaskDependency,
  type BuildTaskUnlockCondition,
  type BuildRevisionBudget,
  type BuildArtifactState,
  type BuildAcceptanceState,
  type BuildPublishMode,
  type RoleModelResolver,
  computeBuildSpecHash,
} from './orchestration-contracts.js';
import type {
  KbBuildRoleConfig,
  KbBuildRolesConfig,
  RawSourceSnapshotEntry,
  StandardKbConfig,
} from '../types/agent-knowledge.js';
import { resolveBuildConcurrency } from '../types/agent-knowledge.js';

// ============================================================================
// 错误
// ============================================================================

/** 状态机/编排层违规（调用方程序错误或恢复数据不一致）。 */
export class OrchestrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OrchestrationError';
  }
}

// ============================================================================
// 三轴转移表（B 案 §7 状态维度表）
// ============================================================================

/** exec：queued→{running,cancelled}；running→{done,failed,cancelled}；
 * 终态（done/failed/cancelled）不可变——「exec 已终态再改 exec」抛错。 */
const EXEC_TRANSITIONS: Record<BuildExecState, ReadonlySet<BuildExecState>> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['done', 'failed', 'cancelled']),
  done: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

/** artifact：pending→{available,missing,incomplete}；非 pending 只能回
 * pending（新一轮尝试重新生成产物），不得在终态间横跳。 */
const ARTIFACT_TRANSITIONS: Record<BuildArtifactState, ReadonlySet<BuildArtifactState>> = {
  pending: new Set(['available', 'missing', 'incomplete']),
  available: new Set(['pending']),
  missing: new Set(['pending']),
  incomplete: new Set(['pending']),
};

/** acceptance：needs_revision 换稿后回 unreviewed（新版本待审）；passed
 * 可被内容变化失效回 unreviewed 或人工改判 pending_decision（B 案 §7
 * 「内容修改使相关接受记录失效」）。 */
const ACCEPTANCE_TRANSITIONS: Record<BuildAcceptanceState, ReadonlySet<BuildAcceptanceState>> = {
  unreviewed: new Set(['needs_revision', 'passed', 'pending_decision']),
  needs_revision: new Set(['unreviewed', 'passed', 'pending_decision']),
  pending_decision: new Set(['unreviewed', 'needs_revision', 'passed']),
  passed: new Set(['unreviewed', 'pending_decision']),
};

// ============================================================================
// 快照哈希与 BuildSpec 构造（B 案 §8：开始时冻结）
// ============================================================================

/**
 * 源快照整体哈希：对条目的身份+完整性字段（objToken/relPath/contentHash/
 * mediaHash/whiteboardTextHash）按 objToken 排序后规范化 JSON sha256。
 * 用于 BuildSpec.sourceSnapshotHash——恢复时核对快照未变（B 案 §8）。
 */
export function computeSnapshotHash(entries: RawSourceSnapshotEntry[]): string {
  const rows: string[][] = entries
    .map((entry) => [
      entry.objToken,
      entry.relPath,
      entry.contentHash,
      entry.mediaHash ?? '',
      entry.whiteboardTextHash ?? '',
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

function toRoleModelConfig(role: KbBuildRoleConfig | undefined): { modelPresetId: string; providerId?: string; thinking?: string } {
  if (!role) return { modelPresetId: '' };
  const result: { modelPresetId: string; providerId?: string; thinking?: string } = {
    modelPresetId: typeof role.modelPresetId === 'string' ? role.modelPresetId : '',
  };
  if (role.providerId) result.providerId = role.providerId;
  if (role.thinking) result.thinking = role.thinking;
  return result;
}

/**
 * 从 StandardKbConfig 构造冻结 BuildSpec（B 案 §8：开始时固定模型标识/
 * 参数、规范版本、并发与预算、发布方式；角色引用 llm 注册表预设，密钥
 * 不入记录）。resolveBuildConcurrency 语义：buildConcurrency 优先回落
 * buildParallelism，钳制 1..8（T1 已冻结，不在此重复）。
 * diting F05：提供 resolveRoleModel 时，把各角色解析后的实际非密钥参数
 * （provider/modelId/baseUrl/protocol/thinking/角色规范版本）冻结进
 * resolvedRoles——specHash 覆盖；后续任务按冻结身份派发、凭据动态取。
 * diting F05-R：冻结面扩展为完整有效参数（maxTokens/contextWindow/
 * reasoning/thinkingLevels/authHeader）；integrator 未显式配置时冻结
 * writer 冻结结果的显式副本（origin='follows_writer'），三角色全部冻结
 * 不留空——缺省整合者跟随撰写，撰写漂移同样阻断整合派发。
 * diting N01：同时冻结流水模式标记 pipelineMode（T7 启用门：任一角色
 * 显式或 publishMode='confirm' → 'orchestrated'，否则 'legacy'）；
 * 无标记的旧快照由 reviewPipelineActive 按旧门控语义恢复。
 */
export function buildSpecFromConfig(input: {
  buildId: string;
  snapshotEntries: RawSourceSnapshotEntry[];
  baseReleaseId: string | null;
  standardKb: Pick<StandardKbConfig, 'buildRoles' | 'reviewPolicy' | 'publishMode' | 'buildConcurrency' | 'buildParallelism'>;
  /** 规范指纹（角色提示词/审查规范内容哈希）；缺省 'v1' */
  specVersion?: string;
  /** diting F05：角色实际模型解析器（非密钥）；缺省不冻结 resolvedRoles */
  resolveRoleModel?: RoleModelResolver;
}): BuildSpec {
  const roles: KbBuildRolesConfig | undefined = input.standardKb.buildRoles;
  const concurrency = resolveBuildConcurrency(input.standardKb);
  const writerConfig = toRoleModelConfig(roles?.writer);
  const reviewerConfig = toRoleModelConfig(roles?.reviewer);
  const integratorConfig = roles?.integrator ? toRoleModelConfig(roles.integrator) : undefined;
  const resolve = input.resolveRoleModel;
  const publishMode: BuildPublishMode = input.standardKb.publishMode === 'confirm' ? 'confirm' : 'auto';
  const anyExplicit = explicitRoleConfigured(writerConfig) || explicitRoleConfigured(reviewerConfig)
    || (integratorConfig ? explicitRoleConfigured(integratorConfig) : false);
  let resolvedRoles: BuildSpec['resolvedRoles'] | undefined;
  if (resolve) {
    const writerResolved = resolve({ role: 'writer', config: writerConfig });
    const reviewerResolved = resolve({ role: 'reviewer', config: reviewerConfig });
    const integratorResolved = integratorConfig
      ? resolve({ role: 'integrator', config: integratorConfig })
      // diting F05-R：缺省整合者跟随撰写——冻结 writer 结果的显式副本，
      // 不留空；派发/恢复校验与 writer 同面比对。
      : (writerResolved ? { ...writerResolved, origin: 'follows_writer' as const } : undefined);
    resolvedRoles = {
      ...(writerResolved ? { writer: writerResolved } : {}),
      ...(reviewerResolved ? { reviewer: reviewerResolved } : {}),
      ...(integratorResolved ? { integrator: integratorResolved } : {}),
    };
  }
  const spec: Omit<BuildSpec, 'specHash'> = {
    buildId: input.buildId,
    sourceSnapshotId: `${input.buildId}:snapshot`,
    sourceSnapshotHash: computeSnapshotHash(input.snapshotEntries),
    baseReleaseId: input.baseReleaseId,
    roles: {
      writer: writerConfig,
      reviewer: reviewerConfig,
      ...(integratorConfig ? { integrator: integratorConfig } : {}),
      ...(roles?.plannerEnabled !== undefined ? { plannerEnabled: roles.plannerEnabled } : {}),
    },
    ...(resolvedRoles ? { resolvedRoles } : {}),
    specVersion: input.specVersion ?? 'v1',
    concurrency,
    maxAutoRevisions: clampInt(input.standardKb.reviewPolicy?.maxAutoRevisions, 2, 1, 5),
    maxInterfaceRetries: clampInt(input.standardKb.reviewPolicy?.maxInterfaceRetries, 2, 0, 5),
    publishMode,
    // S3 切片 C：机械预检开关随 spec 冻结；仅显式 true 落键（false/缺省
    // 都不落）→ 缺省关闭时 specHash 与旧版一致，旧检查点可恢复
    ...(input.standardKb.reviewPolicy?.mechanicalPrecheck === true ? { mechanicalPrecheck: true } : {}),
    // diting N01：冻结流水模式（T7 启用门），恢复判定优先读标记
    pipelineMode: anyExplicit || publishMode === 'confirm' ? 'orchestrated' : 'legacy',
  };
  return { ...spec, specHash: computeBuildSpecHash(spec) };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

// ============================================================================
// 提交回执（B 案 附录 B「提交产物或报告」）
// ============================================================================

export interface BuildResultReceipt {
  taskId: string;
  revision: number;
  artifactState: BuildArtifactState;
  /** 产物/报告的不可变存储引用（调用方填写；骨架层不解释） */
  resultRef?: string;
  submittedAt: string;
}

export type LateReceiptReason =
  | 'task_not_found'
  | 'build_ended'
  | 'task_cancelled'
  | 'task_terminal'
  | 'task_not_running'
  | 'stale_revision';

export interface BuildLateReceipt {
  taskId: string;
  revision: number;
  reason: LateReceiptReason;
  detail: string;
  at: string;
}

export type SubmitResultOutcome =
  | { status: 'recorded'; receipt: BuildResultReceipt }
  | { status: 'duplicate'; receipt: BuildResultReceipt }
  | { status: 'rejected'; reason: LateReceiptReason; detail: string };

// ============================================================================
// 快照与摘要
// ============================================================================

export interface BuildOrchestrationSnapshot {
  spec: BuildSpec;
  tasks: BuildTask[];
  /** 逻辑审查对象 → 已消耗自动修订轮数（B 案 §5） */
  revisionUsage: Record<string, number>;
  /** taskId → 已记录接口失败次数（B 案 §5，恢复时保留） */
  interfaceRetries: Record<string, number>;
  receipts: BuildResultReceipt[];
  lateReceipts: BuildLateReceipt[];
  ended: { reason: string; at: string } | null;
}

export interface BuildOrchestrationSummary {
  specHash: string | null;
  taskTotal: number;
  tasksByRole: Record<string, number>;
  tasksByExecState: Record<string, number>;
  interfaceRetryTotal: number;
  autoRevisionUsage: Record<string, number>;
  receiptCount: number;
  lateReceiptCount: number;
  ended: boolean;
}

// ============================================================================
// BuildOrchestration
// ============================================================================

export interface CreateBuildTaskInput {
  taskId: string;
  revision: number;
  role: BuildRole;
  unitId: string | null;
  reviewSubjectDraftHash: string | null;
  inputRefs: string[];
  dependencies: BuildTaskDependency[];
  allowedWritePaths: string[];
  outputRequirements: string;
  /** D5（B 案 §6）：入队时间；缺省 now。类内 FIFO 排序维度用（非动态 aging；测试可注入）。 */
  queuedAt?: string;
}

/**
 * 一次构建的任务编排骨架。构造即冻结 BuildSpec（specHash 由
 * computeBuildSpecHash 生成并写回 spec.specHash）；三轴状态推进全部经
 * update*State/submitResult，非法转移抛 OrchestrationError。
 */
export class BuildOrchestration {
  readonly spec: BuildSpec;
  private readonly taskMap = new Map<string, BuildTask>();
  private readonly revisionUsage = new Map<string, number>();
  private readonly interfaceRetries = new Map<string, number>();
  private readonly receipts = new Map<string, BuildResultReceipt>();
  private readonly lateReceipts: BuildLateReceipt[] = [];
  private endedAt: { reason: string; at: string } | null = null;

  constructor(spec: BuildSpec) {
    // 冻结：无条件按当前字段重算哈希（携带 specHash 的旧值不信任——恢复
    // 校验在 restore() 中显式做）
    const { specHash: _ignored, ...rest } = spec;
    void _ignored;
    this.spec = { ...rest, specHash: computeBuildSpecHash(rest) };
  }

  // ------------------------------------------------------------------
  // 任务集合
  // ------------------------------------------------------------------

  /**
   * 创建任务（初始 queued/pending/unreviewed）。revisionBudget 由骨架
   * 按角色统一 stamp（B 案 §5：只有 write/修订类任务有预算；预算取自
   * spec.maxAutoRevisions + 该逻辑审查对象的累计用量——换稿不重置）。
   * 依赖必须引用已存在任务且不得成环（含自环）。
   */
  createTask(input: CreateBuildTaskInput): BuildTask {
    if (this.endedAt) throw new OrchestrationError('build_ended', '构建已结束，不能创建任务');
    if (!input.taskId || typeof input.taskId !== 'string') throw new OrchestrationError('invalid_task', 'taskId 不能为空');
    if (this.taskMap.has(input.taskId)) throw new OrchestrationError('task_duplicate', `任务已存在：${input.taskId}`);
    if (!BUILD_ROLES.has(input.role)) throw new OrchestrationError('invalid_role', `未知构建角色：${input.role}`);
    if (!Number.isInteger(input.revision) || input.revision < 0) {
      throw new OrchestrationError('invalid_revision', `revision 必须是非负整数：${input.taskId}`);
    }
    const deps = input.dependencies ?? [];
    for (const dep of deps) {
      if (dep.taskId === input.taskId) {
        throw new OrchestrationError('dependency_cycle', `任务不能依赖自身：${input.taskId}`);
      }
      if (!this.taskMap.has(dep.taskId)) {
        throw new OrchestrationError('unknown_dependency', `依赖的任务不存在：${input.taskId} → ${dep.taskId}`);
      }
    }
    this.assertNoCycle(input.taskId, deps);
    const task: BuildTask = {
      taskId: input.taskId,
      revision: input.revision,
      buildId: this.spec.buildId,
      role: input.role,
      unitId: input.unitId ?? null,
      reviewSubjectDraftHash: input.reviewSubjectDraftHash ?? null,
      revisionBudget: this.stampRevisionBudget(input),
      inputRefs: [...(input.inputRefs ?? [])],
      dependencies: deps.map((dep) => ({ ...dep })),
      allowedWritePaths: [...(input.allowedWritePaths ?? [])],
      outputRequirements: input.outputRequirements ?? '',
      // D5（B 案 §6）：入队时间随任务创建冻结；类内 FIFO 排序只读此字段
      queuedAt: input.queuedAt ?? new Date().toISOString(),
      execState: 'queued',
      artifactState: 'pending',
      acceptanceState: 'unreviewed',
    };
    this.taskMap.set(task.taskId, task);
    return this.snapshotTask(task);
  }

  /** 新任务对本任务图中已有节点的依赖若形成环 → 拒绝（B 案 附录 B
   * 「无环依赖」）。 */
  private assertNoCycle(taskId: string, deps: BuildTaskDependency[]): void {
    const seen = new Set<string>();
    const stack = deps.map((dep) => dep.taskId);
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === taskId) {
        throw new OrchestrationError('dependency_cycle', `依赖成环：任务 ${taskId}`);
      }
      if (seen.has(current)) continue;
      seen.add(current);
      const node = this.taskMap.get(current);
      if (node) stack.push(...node.dependencies.map((dep) => dep.taskId));
    }
  }

  private stampRevisionBudget(input: CreateBuildTaskInput): BuildRevisionBudget | null {
    if (input.role !== 'write' && input.role !== 'integrate') return null;
    const subject = budgetSubjectKey(input.unitId, input.role);
    return {
      usedAutoRevisions: this.revisionUsage.get(subject) ?? 0,
      maxAutoRevisions: this.spec.maxAutoRevisions,
    };
  }

  task(taskId: string): BuildTask | null {
    const found = this.taskMap.get(taskId);
    return found ? this.snapshotTask(found) : null;
  }

  get tasks(): BuildTask[] {
    return [...this.taskMap.values()].map((task) => this.snapshotTask(task));
  }

  private snapshotTask(task: BuildTask): BuildTask {
    return {
      ...task,
      revisionBudget: task.revisionBudget ? { ...task.revisionBudget } : null,
      dependencies: task.dependencies.map((dep) => ({ ...dep })),
      inputRefs: [...task.inputRefs],
      allowedWritePaths: [...task.allowedWritePaths],
    };
  }

  // ------------------------------------------------------------------
  // 三轴状态推进（B 案 §7）
  // ------------------------------------------------------------------

  updateExecState(taskId: string, state: BuildExecState): void {
    const task = this.guardAdvance(taskId, 'exec');
    this.transitionExec(task, state);
  }

  updateArtifactState(taskId: string, state: BuildArtifactState): void {
    const task = this.guardAdvance(taskId, 'artifact');
    this.transitionArtifact(task, state);
  }

  updateAcceptanceState(taskId: string, state: BuildAcceptanceState): void {
    const task = this.guardAdvance(taskId, 'acceptance');
    this.transitionAcceptance(task, state);
  }

  /** 三轴推进公共守卫：构建未结束、任务存在、任务未取消。 */
  private guardAdvance(taskId: string, axis: string): BuildTask {
    if (this.endedAt) {
      throw new OrchestrationError('build_ended', `构建已结束，不能推进 ${axis} 状态`);
    }
    const task = this.taskMap.get(taskId);
    if (!task) throw new OrchestrationError('task_not_found', `任务不存在：${taskId}`);
    if (task.execState === 'cancelled') {
      throw new OrchestrationError('task_cancelled', `任务已取消，拒绝推进 ${axis} 状态：${taskId}`);
    }
    return task;
  }

  /** 轴内转移：同态幂等；不在转移表内 → invalid_transition 抛错。 */
  private transitionExec(task: BuildTask, state: BuildExecState): void {
    if (task.execState === state) return;
    if (!EXEC_TRANSITIONS[task.execState].has(state)) {
      throw new OrchestrationError('invalid_transition', `非法转移：任务 ${task.taskId} exec ${task.execState} → ${state}`);
    }
    task.execState = state;
  }

  private transitionArtifact(task: BuildTask, state: BuildArtifactState): void {
    if (task.artifactState === state) return;
    if (!ARTIFACT_TRANSITIONS[task.artifactState].has(state)) {
      throw new OrchestrationError('invalid_transition', `非法转移：任务 ${task.taskId} artifact ${task.artifactState} → ${state}`);
    }
    task.artifactState = state;
  }

  private transitionAcceptance(task: BuildTask, state: BuildAcceptanceState): void {
    if (task.acceptanceState === state) return;
    if (!ACCEPTANCE_TRANSITIONS[task.acceptanceState].has(state)) {
      throw new OrchestrationError('invalid_transition', `非法转移：任务 ${task.taskId} acceptance ${task.acceptanceState} → ${state}`);
    }
    task.acceptanceState = state;
  }

  // ------------------------------------------------------------------
  // 就绪计算（B 案 §4/§7：依赖 + 解锁条件）
  // ------------------------------------------------------------------

  /**
   * 可执行任务：execState=queued 且全部依赖满足——
   * requires 'artifact_available' → 依赖任务 artifactState='available'；
   * requires 'acceptance_passed' → 依赖任务 acceptanceState='passed'。
   * 审查任务执行结束但报告缺失（artifact 非 available）不能解锁下游
   * （B 案 §7）。构建结束后不再产出就绪任务。
   *
   * D5（B 案 §6）调度优先级：结果按优先级排序返回（FIFO 升级为优先级
   * 队列；调度方消费顺序即可）：
   * 1. 已产生草稿的 review/revise 任务优先（避免新撰写抢占审查名额——
   *    B 案「优先处理已经产生草稿的审查和修订」）；
   * 2. 同优先级类内按入队时间 queuedAt 升序（diting 披露修正：这是类内
   *    FIFO——静态比较入队时间，不是动态 aging，不会随等待时长提升
   *    优先级、不跨类抗饥饿；类 1 长期饱和时类 0 之外的新任务可能持续
   *    延后，仅靠修订/重试上限与构建超时兜底）；
   * 3. 其余（write/integrate 首轮、plan）同序；queuedAt 缺省的旧快照按
   *    创建序。等待者不占位语义不变（消费方按容量领取）。
   */
  readyTasks(): BuildTask[] {
    if (this.endedAt) return [];
    const result: BuildTask[] = [];
    for (const task of this.taskMap.values()) {
      if (task.execState !== 'queued') continue;
      if (!this.dependenciesSatisfied(task)) continue;
      result.push(this.snapshotTask(task));
    }
    return result.sort((a, b) => compareReadyOrder(a, b));
  }

  dependenciesSatisfied(task: BuildTask): boolean {
    for (const dep of task.dependencies) {
      const target = this.taskMap.get(dep.taskId);
      if (!target) return false; // 防御：创建时已校验存在
      if (!dependencyUnlocked(target, dep.requires)) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // 接口失败与修订预算（B 案 §5：分开计数）
  // ------------------------------------------------------------------

  /**
   * 记录一次模型接口失败（超时/断流/格式非法——执行失败，与内容不通过
   * 分开计数）。used = 已消耗的重试额度；used < max 时本次失败后还能再试
   *（初次尝试 + 最多 max 次重试）。不动修订预算。恢复后计数保留（B 案 §8）。
   */
  recordInterfaceFailure(taskId: string): { used: number; max: number; canRetry: boolean } {
    if (this.endedAt) throw new OrchestrationError('build_ended', '构建已结束，不能记录接口失败');
    const task = this.taskMap.get(taskId);
    if (!task) throw new OrchestrationError('task_not_found', `任务不存在：${taskId}`);
    if (BUILD_EXEC_TERMINAL_STATES.has(task.execState)) {
      throw new OrchestrationError('task_terminal', `任务已终态（${task.execState}），不能记录接口失败：${taskId}`);
    }
    const used = (this.interfaceRetries.get(taskId) ?? 0) + 1;
    this.interfaceRetries.set(taskId, used);
    return { used, max: this.spec.maxInterfaceRetries, canRetry: used < this.spec.maxInterfaceRetries };
  }

  /**
   * 消耗一轮自动修订预算（内容不通过 → needs_revision 时调用）。
   * 预算按逻辑审查对象累计（budgetSubjectKey），同一对象换稿不重置
   * （B 案 §5）；耗尽返回 allowed:false，调用方应把审查对象转
   * pending_decision，不由总控抹掉阻断问题。接口失败不消耗本预算。
   */
  tryStartRevision(subjectKey: string): { allowed: boolean; budget: BuildRevisionBudget } {
    if (this.endedAt) throw new OrchestrationError('build_ended', '构建已结束，不能消耗修订预算');
    const used = this.revisionUsage.get(subjectKey) ?? 0;
    const budget: BuildRevisionBudget = { usedAutoRevisions: used, maxAutoRevisions: this.spec.maxAutoRevisions };
    if (revisionBudgetExhausted(budget)) {
      return { allowed: false, budget };
    }
    const next = used + 1;
    this.revisionUsage.set(subjectKey, next);
    return { allowed: true, budget: { usedAutoRevisions: next, maxAutoRevisions: this.spec.maxAutoRevisions } };
  }

  /** 逻辑审查对象的当前预算（只读查询）。 */
  revisionBudgetOf(subjectKey: string): BuildRevisionBudget {
    return {
      usedAutoRevisions: this.revisionUsage.get(subjectKey) ?? 0,
      maxAutoRevisions: this.spec.maxAutoRevisions,
    };
  }

  // ------------------------------------------------------------------
  // 提交回执（B 案 附录 B：幂等 + 迟到拒绝）
  // ------------------------------------------------------------------

  /**
   * 提交任务结果（产物或报告）。同一 taskId+revision 重复提交幂等返回
   * duplicate；任务已取消/构建已结束/修订过期（stale）→ 记录迟到回执
   * 并拒绝推进状态（B 案 §8：取消使未完成节点停止，迟到回执不得继续
   * 推进发布）。合法提交推进 exec→done 与 artifact→指定状态（三轴独立，
   * acceptance 不在此推进——内容验收由审查结论另行驱动）。
   */
  submitResult(input: {
    taskId: string;
    revision: number;
    artifactState: BuildArtifactState;
    resultRef?: string;
    submittedAt?: string;
  }): SubmitResultOutcome {
    const key = `${input.taskId}@${input.revision}`;
    const reject = (reason: LateReceiptReason, detail: string): SubmitResultOutcome => {
      this.lateReceipts.push({ taskId: input.taskId, revision: input.revision, reason, detail, at: input.submittedAt ?? new Date().toISOString() });
      if (this.lateReceipts.length > 200) this.lateReceipts.splice(0, this.lateReceipts.length - 200);
      return { status: 'rejected', reason, detail };
    };
    if (this.endedAt) {
      return reject('build_ended', `构建已结束（${this.endedAt.reason}）`);
    }
    const task = this.taskMap.get(input.taskId);
    if (!task) return reject('task_not_found', `任务不存在：${input.taskId}`);
    const existing = this.receipts.get(key);
    if (existing) return { status: 'duplicate', receipt: { ...existing } };
    if (task.execState === 'cancelled') {
      return reject('task_cancelled', `任务已取消：${input.taskId}`);
    }
    if (input.revision < task.revision) {
      return reject('stale_revision', `提交修订 ${input.revision} 落后于任务当前修订 ${task.revision}：${input.taskId}`);
    }
    if (task.execState !== 'running') {
      return reject('task_not_running', `任务未在运行（exec=${task.execState}）：${input.taskId}`);
    }
    const receipt: BuildResultReceipt = {
      taskId: input.taskId,
      revision: input.revision,
      artifactState: input.artifactState,
      ...(input.resultRef ? { resultRef: input.resultRef } : {}),
      submittedAt: input.submittedAt ?? new Date().toISOString(),
    };
    this.receipts.set(key, receipt);
    // 合法提交：exec→done、artifact→提交值（pending→* 合法；重复提交已被
    // 幂等挡住，此处必为首次）
    this.transitionExec(task, 'done');
    this.transitionArtifact(task, input.artifactState);
    return { status: 'recorded', receipt: { ...receipt } };
  }

  getReceipt(taskId: string, revision: number): BuildResultReceipt | null {
    const found = this.receipts.get(`${taskId}@${revision}`);
    return found ? { ...found } : null;
  }

  get lateReceiptLog(): BuildLateReceipt[] {
    return this.lateReceipts.map((receipt) => ({ ...receipt }));
  }

  // ------------------------------------------------------------------
  // 取消与结束（B 案 §8：取消使未完成节点停止）
  // ------------------------------------------------------------------

  /** 取消单个任务：queued/running → cancelled；已 cancelled 幂等；其余
   * 终态抛错（不可逆终态）。 */
  cancelTask(taskId: string): void {
    const task = this.taskMap.get(taskId);
    if (!task) throw new OrchestrationError('task_not_found', `任务不存在：${taskId}`);
    if (task.execState === 'cancelled') return;
    if (BUILD_EXEC_TERMINAL_STATES.has(task.execState)) {
      throw new OrchestrationError('task_terminal', `任务已终态（${task.execState}），不能取消：${taskId}`);
    }
    task.execState = 'cancelled';
  }

  /**
   * 结束构建：此后一切状态推进/任务创建/回执推进均拒绝。默认把全部
   * queued/running 任务置 cancelled（B 案 §8「取消使未完成节点停止」）；
   * 幂等——已结束的构建再次 endBuild 不改写首次原因。
   */
  endBuild(reason: string, options: { cancelPending?: boolean } = {}): void {
    if (this.endedAt) return;
    this.endedAt = { reason, at: new Date().toISOString() };
    if (options.cancelPending !== false) {
      for (const task of this.taskMap.values()) {
        if (task.execState === 'queued' || task.execState === 'running') task.execState = 'cancelled';
      }
    }
  }

  get ended(): boolean {
    return this.endedAt !== null;
  }

  get endReason(): string | null {
    return this.endedAt?.reason ?? null;
  }

  /**
   * T2b（B 案 §8）：恢复 failed/cancelled/interrupted 构建时重开已结束的
   * 编排（后续以 #attempt 后继任务续跑；已终态任务不动）。幂等：未结束
   * 的构建无操作。发布后的构建不应重开（调用方约束）。
   */
  reopen(reason: string): void {
    if (!this.endedAt) return;
    this.endedAt = null;
    void reason;
  }

  // ------------------------------------------------------------------
  // 快照 / 恢复（B 案 §8：先核对再恢复）
  // ------------------------------------------------------------------

  serialize(): BuildOrchestrationSnapshot {
    const dump: BuildOrchestrationSnapshot = {
      spec: { ...this.spec, roles: { ...this.spec.roles } },
      tasks: this.tasks,
      revisionUsage: Object.fromEntries(this.revisionUsage),
      interfaceRetries: Object.fromEntries(this.interfaceRetries),
      receipts: [...this.receipts.values()].map((receipt) => ({ ...receipt })),
      lateReceipts: this.lateReceipts.map((receipt) => ({ ...receipt })),
      ended: this.endedAt ? { ...this.endedAt } : null,
    };
    return dump;
  }

  /**
   * 从快照恢复。先核对 specHash（快照损坏/被篡改 → 拒绝恢复），再重建
   * 任务集合与计数。恢复归一（B 案 §8「恢复未完成任务」+ 任务书 §4）：
   * running → queued（重新排队）、其 artifact 非 pending → pending（草稿
   * 可能不完整，产出以重跑为准）；done+available 原样保留（跳过）；接口
   * 失败计数保留。ended 快照恢复后仍是 ended。
   */
  static restore(snapshot: BuildOrchestrationSnapshot): BuildOrchestration {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.spec) {
      throw new OrchestrationError('invalid_snapshot', '编排快照缺 spec');
    }
    const expected = computeBuildSpecHash(snapshot.spec);
    if (snapshot.spec.specHash !== expected) {
      throw new OrchestrationError('spec_hash_mismatch', `快照 specHash 不一致：${String(snapshot.spec.specHash)} ≠ ${expected}`);
    }
    const instance = new BuildOrchestration(snapshot.spec);
    if (!Array.isArray(snapshot.tasks)) throw new OrchestrationError('invalid_snapshot', '编排快照缺 tasks');
    for (const raw of snapshot.tasks) {
      instance.taskMap.set(raw.taskId, {
        ...raw,
        revisionBudget: raw.revisionBudget ? { ...raw.revisionBudget } : null,
        dependencies: (raw.dependencies ?? []).map((dep) => ({ ...dep })),
        inputRefs: [...(raw.inputRefs ?? [])],
        allowedWritePaths: [...(raw.allowedWritePaths ?? [])],
      });
    }
    for (const [key, value] of Object.entries(snapshot.revisionUsage ?? {})) {
      instance.revisionUsage.set(key, Math.max(0, Math.floor(Number(value) || 0)));
    }
    for (const [key, value] of Object.entries(snapshot.interfaceRetries ?? {})) {
      instance.interfaceRetries.set(key, Math.max(0, Math.floor(Number(value) || 0)));
    }
    for (const receipt of snapshot.receipts ?? []) {
      instance.receipts.set(`${receipt.taskId}@${receipt.revision}`, { ...receipt });
    }
    instance.lateReceipts.push(...(snapshot.lateReceipts ?? []).map((receipt) => ({ ...receipt })));
    if (snapshot.ended) instance.endedAt = { ...snapshot.ended };
    // 恢复归一：中断的 running 任务重新排队，产物状态回 pending
    for (const task of instance.taskMap.values()) {
      if (task.execState === 'running') {
        task.execState = 'queued';
        if (task.artifactState !== 'pending') task.artifactState = 'pending';
      }
    }
    return instance;
  }

  // ------------------------------------------------------------------
  // 摘要（kb_builds.orchestration_json 摘要缓存用）
  // ------------------------------------------------------------------

  summary(): BuildOrchestrationSummary {
    const tasksByRole: Record<string, number> = {};
    const tasksByExecState: Record<string, number> = {};
    let interfaceRetryTotal = 0;
    for (const task of this.taskMap.values()) {
      tasksByRole[task.role] = (tasksByRole[task.role] ?? 0) + 1;
      tasksByExecState[task.execState] = (tasksByExecState[task.execState] ?? 0) + 1;
    }
    for (const count of this.interfaceRetries.values()) interfaceRetryTotal += count;
    return {
      specHash: this.spec.specHash ?? null,
      taskTotal: this.taskMap.size,
      tasksByRole,
      tasksByExecState,
      interfaceRetryTotal,
      autoRevisionUsage: Object.fromEntries(this.revisionUsage),
      receiptCount: this.receipts.size,
      lateReceiptCount: this.lateReceipts.length,
      ended: this.endedAt !== null,
    };
  }
}

// ============================================================================
// 逻辑审查对象键（B 案 §5：同一对象换稿不重置；单元修订与整合修订分别记录）
// ============================================================================

export function budgetSubjectKey(unitId: string | null, role: BuildRole): string {
  if (unitId) return `unit:${unitId}`;
  return `role:${role}`;
}

// ============================================================================
// 新流水启用判定与恢复辅助（T2b，B 案 §8）
// ============================================================================

/** 角色配置是否显式（预设 id 或 provider id 非空）；与启用门/旧门控共用口径。 */
function explicitRoleConfigured(role: { modelPresetId: string; providerId?: string } | undefined): boolean {
  return Boolean(role && (role.modelPresetId.trim() !== '' || (role.providerId ?? '').trim() !== ''));
}

/**
 * T2b（B 案 §3/§8，diting F04 修订 + N01 修复）：审查修订流水是否对该
 * 构建生效。**diting N01：优先读 spec 冻结的 pipelineMode 标记**——新
 * 构建按 T7 启用门（任一角色显式或 publishMode='confirm'）写入；无标记
 * 的旧快照按 T7 之前的旧门控语义恢复：**reviewer 显式非空才启用新流
 * 水**——旧 writer-only/confirm 检查点保持旧路径，旧任务 ID（t:u1 形
 * 状）不进新执行器、不静默获得审查/整合流程。判定只读冻结 BuildSpec，
 * 不读当前配置。
 */
export function reviewPipelineActive(spec: BuildSpec | null | undefined): boolean {
  if (!spec) return false;
  if (spec.pipelineMode === 'orchestrated') return true;
  if (spec.pipelineMode === 'legacy') return false;
  // 旧快照（无标记，diting N01）：T7 之前的旧门控语义
  return explicitRoleConfigured(spec.roles.reviewer);
}

/** 为后继任务（接口重试/断点续跑）生成不冲突的 taskId：base → base#1 → base#2。 */
export function nextAttemptTaskId(orchestration: BuildOrchestration, baseId: string): string {
  if (!orchestration.task(baseId)) return baseId;
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${baseId}#${attempt}`;
    if (!orchestration.task(candidate)) return candidate;
  }
}

/** B 案 §7 解锁判定（独立导出供测试与 T2b 复用）。 */
export function dependencyUnlocked(task: BuildTask, requires: BuildTaskUnlockCondition): boolean {
  if (requires === 'artifact_available') return task.artifactState === 'available';
  return task.acceptanceState === 'passed';
}

// ============================================================================
// D5（B 案 §6）调度优先级：已产生草稿的审查/修订优先 + 类内 FIFO
// ============================================================================

/**
 * 优先级类（D5，B 案 §6「优先处理已经产生草稿的审查和修订」）：
 * - 0（高）：已产生草稿的审查与修订任务——role=review/final_review（共
 *   依赖解锁剖面上必然已有草稿产物），以及轮次 ≥1 的 write/integrate
 *   修订轮（定向回应已有审查报告的草稿）；
 * - 1（其余）：首轮 write/integrate 与 plan 按创建序 + 入队序。
 * diting 披露修正：类内比较是静态 queuedAt FIFO，不是动态 aging——
 * 不随等待时长提升优先级，不提供跨类抗饥饿。 */
export function schedulingPriorityClass(task: Pick<BuildTask, 'role' | 'revision'>): 0 | 1 {
  if (task.role === 'review' || task.role === 'final_review') return 0;
  if ((task.role === 'write' || task.role === 'integrate') && task.revision > 0) return 0;
  return 1;
}

/** readyTasks 排序比较器：优先类升序 → queuedAt 升序（类内 FIFO：早入队
 * 者先出，静态入队时间比较，非动态 aging）→ 创建序（taskMap 插入序由
 * 调用方稳定排序保留）。 */
function compareReadyOrder(a: BuildTask, b: BuildTask): number {
  const classDiff = schedulingPriorityClass(a) - schedulingPriorityClass(b);
  if (classDiff !== 0) return classDiff;
  const at = a.queuedAt ?? '';
  const bt = b.queuedAt ?? '';
  if (at !== bt) return at < bt ? -1 : 1;
  return 0; // 稳定排序保留创建序（Map 插入序）
}
