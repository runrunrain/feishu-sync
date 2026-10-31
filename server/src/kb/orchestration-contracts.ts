/**
 * 多模型构建编排契约（B 案《多模型构建编排方案（讨论稿）》附录 A + §5/§7）
 *
 * 本文件是编排层的**类型与纯函数契约**：
 * - 不实现调度、进程池、持久化（后续任务接入）；服务端唯一状态写入口与
 *   原子发布流程沿用既有实现（B 案附录 B）。
 * - 核心不变量：
 *   1. 审查报告绑定具体内容与输入版本——旧报告不能批准新稿（B 案 §5/§9）；
 *   2. 执行 / 产物 / 内容验收三轴分离，模型回复“完成”不等于质量通过
 *      （B 案 §7）；
 *   3. 修订预算累计、同一审查对象换稿不重置（B 案 §5）；
 *   4. 接口失败与内容不通过分开计数（B 案 §5）；
 *   5. 严重度由审查规范定，撰写者不能为通过自行降级（B 案 §5）。
 *
 * 条文出处以「B 案 §x」标注；与 A 案（知识组织）的接点在
 * knowledge-schema.ts 与 types/agent-knowledge.ts。
 */

import { createHash } from 'node:crypto';

// ============================================================================
// B 案 §3/§8 构建规格 BuildSpec
// ============================================================================

export type BuildPublishMode = 'auto' | 'confirm';

/** B 案 §3 五类文本构建角色（全部计入 N 路构建名额，§6） */
export type BuildRole = 'plan' | 'write' | 'review' | 'integrate' | 'final_review';

export const BUILD_ROLES: ReadonlySet<BuildRole> = new Set([
  'plan', 'write', 'review', 'integrate', 'final_review',
]);

/** B 案 §8：每个角色可选模型预设和思考强度；模型只从应用已配置的提供商
 * 中选择。密钥不入构建记录，凭据由应用管理。 */
export interface BuildRoleModelConfig {
  /** 引用 llm.providers[].models[].id；'' = 跟随活跃预设（llm.activeProviderId/
   * activeModelId，构建期解析）。 */
  modelPresetId: string;
  /** 预设 id 跨 provider 重名时定位；缺省回落 activeProviderId。 */
  providerId?: string;
  /** 思考强度（应用受控枚举）；缺省 'off'。 */
  thinking?: string;
}

/**
 * diting F05（B 案 §8 冻结的实际模型参数）→ F05-R 升级：构建启动时把
 * 每个角色解析后的**完整非密钥有效参数**（经默认值展开，即派发实际使用
 * 的全部参数）冻结进 BuildSpec（specHash 覆盖）。后续任务启动按冻结
 * descriptor 派发（凭据仍动态取）；恢复/派发时与当前配置解析结果完整
 * 比对（含 thinking 与有效参数），不一致 → 待处理并明示，不静默换模型
 * 或换参数。claude-code 基座不冻结（桥接层自管模型，显式角色预设在启用
 * 新流水时被显式拒绝）。
 */
export interface ResolvedRoleModel {
  /** 实际模型 id（app-llm 解析后的 openAiModel；pi-agent-dir 为 piModel） */
  modelId: string;
  providerId?: string;
  baseUrl?: string;
  protocol?: string;
  thinking: string;
  /** 角色规范版本（角色提示词/审查规范指纹；当前 'v1'） */
  roleSpecVersion: string;
  /** diting F05-R：经 providerModelParameters 默认值展开后的有效参数
   *（派发 providerJson.models[0] 的实际来源）。additive 可选：旧冻结
   * 条目（T7 检查点）缺省 = 该字段未冻结，比对时跳过不误报。 */
  maxTokens?: number;
  /** 同上（contextWindow ?? 128000 展开后的有效值） */
  contextWindow?: number;
  /** 同上（reasoning ?? false 展开后的有效值） */
  reasoning?: boolean;
  /** 预设支持的思考档位表（派发 providerJson 的 thinkingLevelMap 来源；
   * additive 可选，语义同上） */
  thinkingLevels?: string[];
  /** anthropic-messages + auth-token 协议组合（派发 providerJson.authHeader
   * 来源；additive 可选，语义同上） */
  authHeader?: boolean;
  /** diting F05-R：冻结来源标记。integrator 未显式配置时冻结条目 =
   * writer 冻结结果的显式副本（origin='follows_writer'），不留空——
   * 缺省整合者跟随撰写，撰写模型漂移必须同样阻断整合派发。 */
  origin?: 'explicit' | 'follows_writer';
}

/** buildSpecFromConfig 的角色解析回调：按角色配置解析实际模型（不含密钥）；
 * 不可解析返回 null（该角色不冻结，派发时按待处理处理）。 */
export type RoleModelResolver = (input: { role: 'writer' | 'reviewer' | 'integrator'; config: BuildRoleModelConfig }) => ResolvedRoleModel | null;

/**
 * B 案附录 A·BuildSpec：服务端生成并固定版本；一次构建开始时冻结所用
 * 模型标识、参数、规范版本与并发配置，后续修订产生新任务，不悄悄改规格。
 */
export interface BuildSpec {
  buildId: string;
  /** 源快照标识（raw-snapshot 快照 id 与整体哈希；源变化必须失败） */
  sourceSnapshotId: string;
  sourceSnapshotHash: string;
  /** 基准版本 releaseId（发布前复核：基准未改变） */
  baseReleaseId: string | null;
  roles: {
    writer: BuildRoleModelConfig;
    reviewer: BuildRoleModelConfig;
    /** 整合者缺省跟随撰写模型（B 案 §3） */
    integrator?: BuildRoleModelConfig;
    /** 规划者默认关闭（B 案 §1/§3）：程序按关联与预算分单元。D5：开启
     * 时规划轮复用 buildRoles.writer 模型（不新增 planner 配置面——B 案
     * §8「规划作为高级选项默认关闭」），冻结身份随 writer 派发校验。 */
    plannerEnabled?: boolean;
  };
  /** 规范版本（角色提示词/审查规范/规划规则的冻结版本标识） */
  specVersion: string;
  /** N 路构建名额：所有文本构建角色合计（B 案 §6） */
  concurrency: number;
  /** 每个审查对象最多自动修订轮数；默认 2，累计不因换稿重置（B 案 §5） */
  maxAutoRevisions: number;
  /** 模型接口失败最多重试次数；默认 2，与内容修订分开计数（B 案 §5） */
  maxInterfaceRetries: number;
  /** B 案 §7：'auto' 通过后自动整版发布；'confirm' 候选就绪后确认一次 */
  publishMode: BuildPublishMode;
  /** S3 切片 C：审查提示词注入机械预检疑点段。additive 可选：仅显式
   * 开启（reviewPolicy.mechanicalPrecheck === true）才写入本字段——
   * stableStringify 过滤 undefined，缺省/关闭时 specHash 与旧版完全
   * 一致，旧检查点可恢复。预检只做提示不做门禁。 */
  mechanicalPrecheck?: boolean;
  /** diting N01：冻结的流水模式标记。新构建按 T7 启用门写入
   * （'orchestrated'=编排流水 / 'legacy'=旧路径）。additive 可选：缺省
   * 无字段 = T7 之前的旧检查点快照，恢复判定按旧门控语义
   * （reviewer 显式非空才启用新流水），旧任务 ID 不进新执行器。 */
  pipelineMode?: 'orchestrated' | 'legacy';
  /** diting F05：启动时冻结的各角色实际模型参数（非密钥）；specHash 覆盖。
   * additive 可选：旧规格/未提供解析器时缺省，派发回落实时解析。 */
  resolvedRoles?: { writer?: ResolvedRoleModel; reviewer?: ResolvedRoleModel; integrator?: ResolvedRoleModel };
  /** 冻结后哈希（computeBuildSpecHash 生成；检查点恢复时核对） */
  specHash?: string;
}

/** 规格冻结哈希：对除 specHash 外的全部字段做规范化 JSON sha256
 * （键排序，同 knowledge-schema.ts 的确定性定义）。 */
export function computeBuildSpecHash(spec: Omit<BuildSpec, 'specHash'>): string {
  const { specHash: _ignored, ...rest } = spec as BuildSpec;
  void _ignored;
  return createHash('sha256').update(stableStringify(rest), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// ============================================================================
// B 案 §7 任务规格 BuildTask（执行/产物/内容验收三轴分离）
// ============================================================================

export type BuildExecState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export const BUILD_EXEC_TERMINAL_STATES: ReadonlySet<BuildExecState> = new Set([
  'done', 'failed', 'cancelled',
]);

export type BuildArtifactState = 'pending' | 'available' | 'missing' | 'incomplete';

export type BuildAcceptanceState = 'unreviewed' | 'needs_revision' | 'passed' | 'pending_decision';

/** 解锁条件：B 案 §7「撰写完成且产物可用后解锁审查；内容通过后解锁整合」。 */
export type BuildTaskUnlockCondition = 'artifact_available' | 'acceptance_passed';

export interface BuildTaskDependency {
  taskId: string;
  requires: BuildTaskUnlockCondition;
}

/** 修订预算（B 案 §5）：同一审查对象换稿产生新版本不重置预算；达到上限
 * 进入待处理（pending_decision），不由总控一句“接受”抹掉阻断问题。 */
export interface BuildRevisionBudget {
  usedAutoRevisions: number;
  maxAutoRevisions: number;
}

export function revisionBudgetExhausted(budget: BuildRevisionBudget): boolean {
  return budget.usedAutoRevisions >= budget.maxAutoRevisions;
}

/** B 案附录 A·TaskSpec：输入和有效配置可追溯；模型不得放大权限或改配额。 */
export interface BuildTask {
  taskId: string;
  /** 任务规格修订：后续修订产生可追溯的新任务/新修订（B 案 §8） */
  revision: number;
  buildId: string;
  role: BuildRole;
  unitId: string | null;
  /** 逻辑审查对象：被审草稿的内容哈希（write 为产出草稿；review 为其输入） */
  reviewSubjectDraftHash: string | null;
  /** 仅 write/修订类任务有预算；review 任务沿用 BuildSpec 上限 */
  revisionBudget: BuildRevisionBudget | null;
  /** 完整输入引用（不可变文件位置；摘要不承担完整输入） */
  inputRefs: string[];
  dependencies: BuildTaskDependency[];
  /** 允许写入路径（路径认领仍是并行写入的基本单位） */
  allowedWritePaths: string[];
  /** 输出要求说明 */
  outputRequirements: string;
  /** D5（B 案 §6）：入队时间（ISO UTC，additive 可选——旧快照缺省按创建
   * 序参与排序）。调度优先级的 aging 维度：queued 越久优先级越高（同
   * 优先级类内比较），防新撰写长期抢占不到名额。 */
  queuedAt?: string;
  // ---- 三轴状态（B 案 §7）：分别记录、分别推进 ----
  execState: BuildExecState;
  artifactState: BuildArtifactState;
  acceptanceState: BuildAcceptanceState;
}

// ============================================================================
// B 案 §5/§7 审查报告与问题
// ============================================================================

export type ReviewIssueSeverity = 'blocking' | 'suggestion';

export type RevisionResponse = 'fixed' | 'kept_with_basis' | 'needs_more_input';

/** B 案附录 A·ReviewIssue：稳定问题标识；修订后由审查复核关闭，保留讨论
 * 轨迹。阻断/改进建议两分级，严重度由审查规范定，不能由撰写者自行降级。 */
export interface ReviewIssue {
  issueId: string;
  /** 草稿位置（路径+定位） */
  draftLocation: string;
  /** 源位置（原文依据；报告必须包含问题位置和原文依据） */
  sourceLocation?: string;
  description: string;
  severity: ReviewIssueSeverity;
  /** 修订回应（修订者填写；未回应为 undefined） */
  revisionResponse?: RevisionResponse;
  /** 关闭依据（审查者复核后填写；非空即视为该问题已关闭） */
  closureBasis?: string;
}

/** 问题是否已关闭：仅审查复核写入 closureBasis 后成立；撰写者的
 * revisionResponse 不构成关闭。 */
export function isIssueClosed(reviewIssue: ReviewIssue): boolean {
  return Boolean(reviewIssue.closureBasis && reviewIssue.closureBasis.trim().length > 0);
}

export type ReviewConclusion = 'pass' | 'needs_revision' | 'insufficient_material' | 'fail';

export interface ReviewReportCoverage {
  /** 检查了哪些草稿（内容哈希集合） */
  draftHashes: string[];
  /** 对应哪些源材料（引用标识） */
  sourceRefs: string[];
}

/** B 案附录 A·ReviewReport：审查对象与输入版本绑定（draftHash）；服务端
 * 附加版本标识；不能审查可变的“最新稿”。 */
export interface ReviewReport {
  reportId: string;
  buildId: string;
  /** 审查对象+输入版本：被审草稿内容哈希（旧报告不能批准新稿） */
  draftHash: string;
  /** 覆盖范围：检查了哪些草稿/源材料/内容维度；不能只给总分 */
  coverage: ReviewReportCoverage;
  checkedDimensions: string[];
  issues: ReviewIssue[];
  /** 未检查范围（必须显式声明） */
  uncheckedScope: string[];
  conclusion: ReviewConclusion;
  /** 服务端附加版本标识（记录输入/规范/报告结构版本） */
  serverVersionTag: string;
}

/** 报告绑定校验（B 案 §5/§9）：报告只覆盖其 draftHash 绑定的那个草稿版本。 */
export function reportCoversDraft(report: ReviewReport, draftHash: string): boolean {
  return report.draftHash === draftHash;
}

// ============================================================================
// B 案 §7 验收记录与发布候选
// ============================================================================

export interface AcceptanceProgramChecks {
  passed: boolean;
  checkIds: string[];
  failed?: string[];
}

/** B 案附录 A·Acceptance：内容修改使相关接受记录失效；无报告不得冒充通过。 */
export interface AcceptanceRecord {
  acceptanceId: string;
  /** 被接受的产物版本（草稿/候选内容哈希） */
  acceptedArtifactHash: string;
  /** 有效报告集合（发布条件：本轮必审范围具备对应版本的有效审查记录） */
  validReportIds: string[];
  programChecks: AcceptanceProgramChecks;
  /** auto = 程序验收规则；confirm = 用户确认（绑定候选版本） */
  decisionMode: BuildPublishMode;
  decidedBy?: string;
  decidedAt?: string;
}

export interface CandidateDocumentEntry {
  path: string;
  contentHash: string;
}

/** 沿用内容范围（B 案 §4）：沿用旧版必须显式标记；旧版没有语义审查记录
 * 就标 never_reviewed，不补造通过状态。 */
export interface CarriedOverEntry {
  path: string;
  priorReview: 'reviewed' | 'never_reviewed';
}

/** B 案附录 A·CandidateRelease：发布对象与已检查对象一致，提交前再次核对。 */
export interface CandidateRelease {
  buildId: string;
  documents: CandidateDocumentEntry[];
  acceptance: AcceptanceRecord;
  carriedOver: CarriedOverEntry[];
  /** 来源去向（本轮处理范围内材料的 disposition 摘要） */
  sourceDisposition: Array<{ sourceId: string; disposition: string }>;
  changeSummary: string;
  /** 原始资料与本轮快照一致性（发布前复核） */
  sourceSnapshotHash: string;
  /** 标准库基准版本（发布前复核：未改变） */
  baseReleaseId: string | null;
  publishMode: BuildPublishMode;
  /** publishMode='confirm' 时的确认绑定：后续内容变化使确认失效（B 案 §7） */
  confirmBinding?: { candidateHash: string; confirmedAt: string; actor: string };
}

/** 候选文档清单哈希：按 path 排序后对 {path, contentHash} 规范化 JSON
 * sha256——confirmBinding 绑定的候选版本指纹。 */
export function computeCandidateHash(candidate: Pick<CandidateRelease, 'documents'>): string {
  const entries = [...candidate.documents]
    .map((doc) => ({ path: doc.path, contentHash: doc.contentHash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256').update(stableStringify(entries), 'utf8').digest('hex');
}

// ============================================================================
// B 案 §7 发布条件 canPublish
// ============================================================================

export const PUBLISH_BLOCK_REASONS = [
  'source_snapshot_mismatch',
  'base_release_changed',
  'missing_report',
  'review_missing',
  'blocking_issue_open',
  'program_check_failed',
  'carry_over_unmarked',
  'required_review_doc_missing',
  'confirm_binding_stale',
  'source_disposition_missing',
] as const;

export type PublishBlockReason = (typeof PUBLISH_BLOCK_REASONS)[number];

export interface PublishCheckInput {
  candidate: CandidateRelease;
  /** 全量报告池（按 reportId 解析 acceptance.validReportIds） */
  reports: ReviewReport[];
  /** 本轮必审范围的草稿内容哈希集合（含整合改写与受影响交叉引用） */
  requiredReviewDraftHashes: string[];
  /** 当前源快照整体哈希（重新核对的期望值） */
  expectedSourceSnapshotHash: string;
  /** 当前基准 releaseId（重新核对的期望值） */
  expectedBaseReleaseId: string | null;
}

export interface PublishCheckResult {
  publishable: boolean;
  reasons: PublishBlockReason[];
  /** 逐条细节（进 report.json / 构建详情，不新增吞错降级通道） */
  details: string[];
}

/**
 * canPublish —— B 案 §7 发布条件（纯函数）：
 * 1. 本轮处理范围内的材料有明确去向（sourceDisposition 齐且非空）；
 * 2. 候选中本轮必审内容具备**对应版本**的有效审查记录（报告绑定 draftHash，
 *    旧报告不能批准新稿；必审对象必须在候选文档清单内）；
 * 3. 本轮必审范围没有未关闭的阻断问题（closureBasis 非空才视为关闭）；
 * 4. 沿用文档及其审查范围标记准确（carriedOver 必须带 priorReview 标记；
 *    历史未审查按 §4 单独披露，不混入“审查通过”统计）；
 * 5. 程序规则检查通过（programChecks.passed）；
 * 6. 原始资料与本轮快照一致；标准库基准版本未改变；
 * 7. publishMode='confirm' 时确认绑定当前候选哈希（内容变化使确认失效）。
 */
export function canPublish(input: PublishCheckInput): PublishCheckResult {
  const { candidate } = input;
  const reasons = new Set<PublishBlockReason>();
  const details: string[] = [];
  const fail = (reason: PublishBlockReason, detail: string): void => {
    reasons.add(reason);
    details.push(detail);
  };

  // 6. 源与基准一致（提交前再次核对）
  if (candidate.sourceSnapshotHash !== input.expectedSourceSnapshotHash) {
    fail('source_snapshot_mismatch', `源快照不一致：候选 ${candidate.sourceSnapshotHash} ≠ 当前 ${input.expectedSourceSnapshotHash}`);
  }
  if (candidate.baseReleaseId !== input.expectedBaseReleaseId) {
    fail('base_release_changed', `基准版本已改变：候选 ${String(candidate.baseReleaseId)} ≠ 当前 ${String(input.expectedBaseReleaseId)}`);
  }

  // 2. 有效报告解析：acceptance 引用的报告必须存在
  const reportById = new Map(input.reports.map((r) => [r.reportId, r] as const));
  const validReports: ReviewReport[] = [];
  for (const reportId of candidate.acceptance.validReportIds) {
    const report = reportById.get(reportId);
    if (!report) {
      fail('missing_report', `验收记录引用的报告不存在：${reportId}`);
    } else {
      validReports.push(report);
    }
  }

  // 2. 必审范围：每个 hash 有对应版本的有效报告；且对应文档在候选清单内
  // （T2b：最终复核绑定整版候选哈希——set 级必审对象即候选本身，按
  // computeCandidateHash 相等判定在清单内，B 案 §4「改写文档进必审范围」
  // 由整版绑定覆盖；逐文档哈希的旧语义不变）
  const candidateHashes = new Set(candidate.documents.map((d) => d.contentHash));
  const wholeCandidateHash = computeCandidateHash(candidate);
  const coveredHashes = new Set(validReports.map((r) => r.draftHash));
  for (const requiredHash of input.requiredReviewDraftHashes) {
    if (!coveredHashes.has(requiredHash)) {
      fail('review_missing', `本轮必审内容缺有效审查记录（或报告未绑定当前版本）：${requiredHash}`);
    }
    if (!candidateHashes.has(requiredHash) && requiredHash !== wholeCandidateHash) {
      fail('required_review_doc_missing', `必审内容不在候选文档清单内：${requiredHash}`);
    }
  }

  // 3. 无未关闭阻断问题
  for (const report of validReports) {
    for (const reviewIssue of report.issues) {
      if (reviewIssue.severity === 'blocking' && !isIssueClosed(reviewIssue)) {
        fail('blocking_issue_open', `阻断问题未关闭：${report.reportId}/${reviewIssue.issueId}（${reviewIssue.description}）`);
      }
    }
  }

  // 5. 程序检查
  if (!candidate.acceptance.programChecks.passed) {
    const failed = candidate.acceptance.programChecks.failed ?? [];
    fail('program_check_failed', `程序规则检查未通过：${failed.join(', ') || 'passed=false'}`);
  }

  // 4. 沿用标记准确：每个沿用条目带 priorReview；非必审文档必须显式沿用
  for (const carried of candidate.carriedOver) {
    if (carried.priorReview !== 'reviewed' && carried.priorReview !== 'never_reviewed') {
      fail('carry_over_unmarked', `沿用文档缺审查范围标记：${carried.path}`);
    }
  }
  const carriedPaths = new Set(candidate.carriedOver.map((c) => c.path));
  const reviewedHashes = new Set(input.requiredReviewDraftHashes);
  for (const doc of candidate.documents) {
    if (!reviewedHashes.has(doc.contentHash) && !carriedPaths.has(doc.path)) {
      fail('carry_over_unmarked', `候选文档既非本轮必审对象也未显式沿用：${doc.path}`);
    }
  }

  // 7. 确认绑定（publishMode='confirm'）
  if (candidate.publishMode === 'confirm') {
    const currentHash = computeCandidateHash(candidate);
    if (!candidate.confirmBinding) {
      fail('confirm_binding_stale', '待确认发布缺用户确认记录');
    } else if (candidate.confirmBinding.candidateHash !== currentHash) {
      fail('confirm_binding_stale', `确认绑定的候选版本已失效：${candidate.confirmBinding.candidateHash} ≠ ${currentHash}`);
    }
  }

  // 1. 材料去向
  for (const entry of candidate.sourceDisposition) {
    if (!entry.disposition || !entry.disposition.trim()) {
      fail('source_disposition_missing', `材料缺明确去向：${entry.sourceId}`);
    }
  }

  return { publishable: reasons.size === 0, reasons: [...reasons], details };
}
