/**
 * Agent 标准知识库 / 会话 DTO 类型（F2 前端契约层）
 *
 * 契约来源：docs/design/agent-knowledge-design.md §3.2 / §5.2 / §9。
 * F1 后端按同一契约并行实现；本文件只描述 HTTP 响应形状，不含任何秘密
 * （apiKey / 运行令牌永不进入 renderer，§13 不变量 5）。
 *
 * 注意：字段名与顺序以设计文档为准，勿自行增删；服务端未实现前，
 * 前端以 fixture backend（明确标注）驱动这些类型做状态覆盖测试。
 */

// ---------------------------------------------------------------------------
// §3.2 就绪码
// ---------------------------------------------------------------------------

export type ReadinessCode =
  | 'ready'
  | 'node_missing'
  | 'node_too_old'
  | 'pi_missing'
  | 'pi_version_unsupported'
  | 'pi_spawn_failed'
  | 'claude_missing'
  | 'claude_spawn_failed'
  | 'claude_protocol_unsupported'
  | 'model_unconfigured'
  | 'model_auth_missing';

/** §9.1 GET /api/agent/status */
export interface AgentStatusDto {
  externalPlugins?: number;
  code: ReadinessCode;
  message: string;
  runtime: {
    nodePath: string | null;
    nodeVersion: string | null;
    piCliPath: string | null;
    piVersion: string | null;
    supportedRange: string;
    backend?: 'pi' | 'claude-code';
    claudeCliPath?: string | null;
    claudeVersion?: string | null;
  };
  model: {
    source: 'app-llm' | 'pi-agent-dir';
    model: string | null;
    available: string[];
    capabilities?: Record<string, Array<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>>;
  };
  processes: { running: number; max: number };
  checkedAt: string;
}

export interface ClaudeConnectionTestResult {
  ok: boolean;
  providerName: string;
  model: string;
  latencyMs: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// §5.2 配置段（config.json 新增；GET /api/config 原样返回，无秘密字段）
// ---------------------------------------------------------------------------

export interface AgentWorkspaceConfig {
  id: string;
  name: string;
  /** 绝对路径（保存时 realpath 规范化）。 */
  path: string;
  createdAt: string;
}

/** 图片理解通道配置（S2 §3.6；只引用 llm.providers 既有注册表，不新增任何秘密字段）。
 * 旧配置缺省时由服务端 load 补默认（disabled），前端按可选字段防御。 */
export interface AgentVisionConfig {
  enabled: boolean;
  /** 引用 llm.providers[].id；缺省回落 activeProviderId */
  providerId?: string;
  /** 引用该 provider 的 models[].id；缺省回落 provider 默认预设 */
  modelId?: string;
  /** server 侧 HTTP 并发（describeMany），1..8，默认 3。不占 pi 进程槽 */
  concurrency: number;
  /** 单图上限（字节），默认 5 MiB，硬上限 20 MiB；超限 too_large */
  maxImageBytes: number;
  /** 单次构建最多理解的未缓存图片数，0..5000，默认 300；超出 limit */
  maxImagesPerBuild: number;
  /** 单图远端调用超时（毫秒），默认 120000 */
  timeoutMs: number;
}

export interface AgentConfig {
  runtime: { backend?: 'pi' | 'claude-code'; nodePath?: string; piCliPath?: string; claudeCliPath?: string };
  model: {
    source: 'app-llm' | 'pi-agent-dir';
    providerId?: string;
    modelId?: string;
    piModel?: string;
    thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    piThinkingLevels?: Record<string, Array<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>>;
    contextWindow: number;
    maxTokens: number;
  };
  /** 图片理解通道（S2/S5 UI）；缺省 disabled */
  vision?: AgentVisionConfig;
  maxConcurrentProcesses: number;
  idleTimeoutMinutes: number;
  workspaces: AgentWorkspaceConfig[];
}

/** 新配置只使用 pi-amagi；旧模式值保留用于历史记录兼容。 */
export type KbOrchestrationMode = 'legacy' | 'pi-amagi' | 'claude-native';

/** B案 §8：思考档位受控枚举（同 AgentConfig.model.thinkingLevel；server AgentThinkingLevel）。 */
export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** B案 §8 构建角色模型：引用 llm.providers[].models[].id 的预设（密钥不入构建记录）。
 *  modelPresetId '' = 跟随活跃预设（llm.activeProviderId/activeModelId，构建期解析）；
 *  providerId 仅在预设 id 跨 provider 重名时定位，缺省回落 activeProviderId。 */
export interface KbBuildRoleConfig {
  modelPresetId: string;
  providerId?: string;
  thinking?: AgentThinkingLevel;
}

export interface KbBuildRolesConfig {
  writer: KbBuildRoleConfig;
  reviewer: KbBuildRoleConfig;
  /** 整合者缺省跟随撰写模型（B案 §3）；键缺省 = 跟随。 */
  integrator?: KbBuildRoleConfig;
  /** 规划者默认关闭（B案 §1/§3）。 */
  plannerEnabled?: boolean;
}

/** B案 §5 审查闭环预算；缺省 2/2（服务端归一保证存在）。 */
export interface KbReviewPolicyConfig {
  /** 每个审查对象最多自动修订轮数，1..5，默认 2；同一审查对象换稿不重置预算。 */
  maxAutoRevisions?: number;
  /** 模型接口失败重试次数，0..5，默认 2；与内容修订分开计数。 */
  maxInterfaceRetries?: number;
}

export interface StandardKbConfig {
  outputRoot: string;
  retainReleases: number;
  buildBatchSize: number;
  promptTimeoutMinutes: number;
  buildTimeoutMinutes: number;
  /** P2-S2：每批有效字数预算（0 = 按源数分批旧行为；取值域 {0}∪[4000,400000]，
   *  默认 40000。buildBatchSize 降为每批源数上限）。 */
  buildBatchWordBudget: number;
  /** 全部文本构建任务共享的并发上限，1..6，默认 2。 */
  buildConcurrency: number;
  /** B案 §3/§8：角色模型配置（additive 可选；PUT 对 buildRoles 整体替换）。 */
  buildRoles?: KbBuildRolesConfig;
  /** B案 §5：审查闭环预算（additive 可选；缺省 2/2）。 */
  reviewPolicy?: KbReviewPolicyConfig;
  /** 服务端固定为 pi-amagi；旧模式只读兼容，前端不提供选择。 */
  orchestrationMode?: KbOrchestrationMode;
  autoBuildAfterSync: boolean;
}

// ---------------------------------------------------------------------------
// S2/S5：图片理解 status/test（GET/POST /api/agent/vision/*，S2-report §四）
// ---------------------------------------------------------------------------

/** GET /api/agent/vision/status */
export interface AgentVisionStatusDto {
  enabled: boolean;
  state: 'disabled' | 'ready' | 'invalid';
  /** 配置引用的原始展示（disabled 时也回显引用值） */
  provider: string | null;
  /** 仅 ready 时非空 */
  model: string | null;
  /** invalid 时给人读的原因 */
  message: string;
  cachedCount: number;
}

/** POST /api/agent/vision/test（失败也回 200，ok=false 携带脱敏 error） */
export interface AgentVisionTestResult {
  ok: boolean;
  finishReason: 'stop' | 'length' | 'error' | 'timeout';
  model: string;
  latencyMs: number;
  sample: string;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// §9.2 标准库
// ---------------------------------------------------------------------------

export interface KbStatusDto {
  outputRoot: string;
  current: null | {
    releaseId: string;
    buildId: string;
    publishedAt: string;
    docCount: number;
    sourceCount: number;
    model: string | null;
    imported?: boolean;
  };
  pending: { added: number; changed: number; removed: number };
  activeBuild: KbBuildDto | null;
}

export interface KbTreeNode {
  name: string;
  path: string;
  type: 'dir' | 'doc';
  docId?: string;
  title?: string;
  children?: KbTreeNode[];
}

export interface KbDocSourceRef {
  objToken: string;
  title: string;
  relPath: string;
  state: 'current' | 'changed' | 'missing' | 'excluded' | 'deleted' | 'packaged';
}

/** §9.2 GET /api/kb/docs/:docId */
export interface KbDocDto {
  docId: string;
  path: string;
  title: string;
  summary: string;
  tags: string[];
  /** 已去除 feishu_sync_kb header 的正文。 */
  markdown: string;
  releaseId: string;
  updatedInBuild: string;
  sources: KbDocSourceRef[];
}

export interface KbSearchResult {
  docId: string;
  path: string;
  title: string;
  snippet: string;
}

export type KbBuildStatus =
  | 'queued'
  | 'preflight'
  | 'running'
  | 'validating'
  | 'publishing'
  /** T2b（B 案 §7）：publishMode=confirm 时最终候选就绪后的待确认态 */
  | 'awaiting_release'
  | 'published'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

// ---------------------------------------------------------------------------
// S4 §4.6：构建进度 DTO（多 worker / 单元 / 图片维度）
// ---------------------------------------------------------------------------

export type KbBuildStage = 'snapshot' | 'describing_images' | 'units' | 'reviewing' | 'finishing' | 'validating' | 'publishing';

export interface KbBuildUnitsProgress {
  total: number;
  done: number;
  running: number;
  failed: number;
  retried: number;
}

export type KbBuildWorkerState = 'waiting_slot' | 'running' | 'finishing' | 'exited';

export interface KbBuildWorkerProgress {
  workerId: string;
  state: KbBuildWorkerState;
  unitId: string | null;
  unitBatchIndex: number;
  unitBatchTotal: number;
}

export interface KbBuildImagesProgress {
  total: number;
  described: number;
  cached: number;
  unavailable: number;
}

export interface KbBuildProgressDto {
  /** 兼容字段：已完成批次 / 全部批次 + 1（收尾轮） */
  batchIndex: number;
  batchTotal: number;
  stage: KbBuildStage | null;
  units: KbBuildUnitsProgress;
  workers: KbBuildWorkerProgress[];
  images: KbBuildImagesProgress;
}

/** 构建警告（如 images_unavailable），随构建历史持久化 */
export interface KbBuildWarning {
  code: string;
  count: number;
  message: string;
}

// ---------------------------------------------------------------------------
// 构建度量（S1/S2/WP-F：kb_builds.metrics_json 对象形状）——镜像
// server/src/types/agent-knowledge.ts 的同名类型（字段一致、只镜像 UI 消费面；
// 语义与口径注释以 server 侧为准，此处只留指路说明）。
// ---------------------------------------------------------------------------

/** token 用量累计；运行时事件不携带用量时为 null（如实未采集，不编造）。 */
export interface KbBuildTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 阶段角色：write 首写 / review 独立审查 / revise 定向修订 / integrate 整合 / final 最终复核 / plan 组织规划。 */
export type KbBuildMetricsPhaseRole = 'write' | 'review' | 'revise' | 'integrate' | 'final' | 'plan';

/** 单元规模条目（words 仅 buildBatchWordBudget>0 时统计，否则为 0）。 */
export interface KbBuildMetricsUnit {
  unitId: string;
  sources: number;
  words: number;
  bytes: number;
}

/** 一轮模型执行的起止与时长。 */
export interface KbBuildMetricsPhase {
  unitId: string | null;
  role: KbBuildMetricsPhaseRole;
  round: number;
  startedAt: string;
  finishedAt: string;
  ms: number;
}

/** 单次机械预检的发现计数（每审查主体一条）。 */
export interface KbBuildMetricsPrecheck {
  unitId: string | null;
  scope: 'unit' | 'integration';
  findingsByKind: { number_missing: number; number_added: number; condition_dropped: number; term_variant: number };
  truncated: number;
}

/** S1 构建度量对象（随 kb_builds.metrics_json 持久化）。 */
export interface KbBuildMetrics {
  units: { total: number; perUnit: KbBuildMetricsUnit[]; maxWordsShare: number | null };
  phases: KbBuildMetricsPhase[];
  /** 超过采集/聚合上限被丢弃的阶段条数（additive 可选：未截断不带此字段） */
  phasesDropped?: number;
  queueWaits: { count: number; totalMs: number; maxMs: number };
  review: { blocking: number; suggestion: number; revisions: number };
  /** null = 本次构建无用量来源（禁止编造数值） */
  tokenUsage: KbBuildTokenUsage | null;
  /** writer/reviewer 同 provider+model；无法判定为 null */
  reviewerSameModelAsWriter: boolean | null;
  /** additive 可选：开关关闭的旧 metrics_json 不带此字段。 */
  precheck?: KbBuildMetricsPrecheck[];
  /** WP-F：pi-amagi 编排构建度量段。additive 可选：legacy 流水与旧
   *  metrics_json 不带此字段（无该段 = 旧采集或非 pi-amagi）。 */
  orchestration?: KbBuildMetricsOrchestration;
}

/**
 * WP-F pi-amagi 编排度量（metrics_json 的 orchestration 段）。数据来源全部
 * 为服务端权威落盘记录；无法推导的字段如实省略或置 null（notes 说明缺口），
 * 禁止编造数值——前端展示同样不得把 null 冒充 0。
 */
export interface KbBuildMetricsOrchestration {
  /** 构建墙钟（started_at → finished_at；未收口终态按采集时刻，notes 注明）。 */
  wallClockMs: number;
  /** 本轮产出文档数（docs_written）与工作集源数（source_total）。 */
  docsPublished: number;
  sourcesTotal: number;
  /** 按角色派发计数（luban 写作 / diting 独立审查 / baize 调研；含 resume
   *  续接身份）。null = actors.json 不可得；真实空数组 = 0。 */
  authorDispatches: number | null;
  reviewDispatches: number | null;
  researchDispatches: number | null;
  /** 每篇文档审查轮数分布与首审结论。null = reviews.json 不可得。 */
  revisionRounds: {
    /** 收到至少一次（有范围）审查的文档数 */
    docsReviewed: number;
    /** 有范围审查回执总数 */
    totalReviews: number;
    /** 每篇文档审查次数中位数（无审查 → null） */
    roundsMedian: number | null;
    roundsMax: number | null;
    /** 每篇文档首审（最早回执）结论计数（未识别 verdict 不计入） */
    firstVerdicts: { pass: number; needs_revision: number; insufficient_material: number; fail: number };
    /** 首审 pass 的文档占比（docsReviewed=0 → null） */
    firstPassRate: number | null;
  } | null;
  /** 发布门拒绝计数（按 reason 计，缺 reason 计 unknown）。空对象 = 真实
   *  无拒绝；null = 文件不可得（不冒充「无拒绝」）。 */
  publishRejections: Record<string, number> | null;
  /** 派发守卫拒绝计数。additive 可选：记录文件不可得（WP-F 之前的旧构建）
   *  不带此键，不编造；空对象 = 真实无拒绝。 */
  dispatchRejections?: Record<string, number>;
  /** 模型池并发（推导口径见 derivation；无来源 → peak/avg null）。 */
  pool: {
    peakInflight: number | null;
    /** 时间加权平均运行并发（窗口=首个 session → 最后一次 settle） */
    avgInflight: number | null;
    /** 推导口径：journal-session=审计 session→settle 区间；actor-events=
     *  账本事件近似（含排队间隙）；none=无来源 */
    derivation: 'journal-session' | 'actor-events' | 'none';
    /** 派发在途（dispatch→最终 settle，含排队）并发峰值/均值。additive
     *  可选：无 journal 时省略。 */
    submittedPeakInflight?: number | null;
    submittedAvgInflight?: number | null;
  };
  /** 每篇文档首稿→发布结算耗时分布（nearest-rank 分位）。additive 可选：
   *  receipts 可读且到达发布才带此键（不可得/未发布省略并在 notes 注明）。 */
  firstDraftToPublish?: {
    count: number;
    p50Ms: number;
    p90Ms: number;
    maxMs: number;
  };
  /** 数据缺口/口径说明（人读）；无缺口不带键。 */
  notes?: string[];
}

export interface KbBuildDto {
  id: string;
  mode: 'incremental' | 'full';
  status: KbBuildStatus;
  noChanges: boolean;
  baseReleaseId: string | null;
  releaseId: string | null;
  model: string | null;
  /** v2：本次构建冻结的编排模式（集成侧仅 pi-amagi 显式携带；缺省
   *  legacy。claude-native 启动被服务端拒绝，不会出现在构建 DTO）。 */
  orchestrationMode?: 'legacy' | 'pi-amagi';
  counts: {
    sourceTotal: number;
    added: number;
    changed: number;
    removed: number;
    docsWritten: number;
    docsDeleted: number;
  };
  progress: KbBuildProgressDto;
  /** S4：本次构建并行度（实际生效值；1=等价单进程回退） */
  parallelism: number;
  /** S4：构建警告（如 images_unavailable） */
  warnings: KbBuildWarning[];
  /** S1（构建编排优化 §3）：构建度量（可选——旧记录无 metrics_json 时缺省；
   *  服务端 toDto 解析失败/空值也缺省，不冒充空对象）。 */
  metrics?: KbBuildMetrics | null;
  error: null | { code: string; message: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  eventSeq?: number;
  recovery?: { canResume: boolean; reason: string | null; checkpointAt: string | null; draftCount: number; completedBatches: number; totalBatches: number };
}

export interface KbBuildIssue {
  path?: string;
  objToken?: string;
  code: string;
  message: string;
}

/** §9.2 GET /api/kb/builds/:id 的 report 扩展 */
export interface KbBuildReportDto {
  issues: KbBuildIssue[];
}

// ---------------------------------------------------------------------------
// T2b（B 案 §4/§5/附录 B）编排流水进度 —— server KbBuildOrchestrationDto 镜像
// ---------------------------------------------------------------------------

/** 编排任务三轴状态（role 为 server BuildRole 字符串：plan/write/review/integrate/final_review）。 */
export interface KbBuildOrchestrationTaskDto {
  taskId: string;
  role: string;
  unitId: string | null;
  /** 任务规格修订（B 案附录 A TaskSpec.revision） */
  revision: number;
  /** 审查/修订轮次（write/integrate 的 r<n>；接口重试为 #<n> 后缀任务） */
  round: number;
  attempt: number;
  execState: string;
  artifactState: string;
  acceptanceState: string;
  /** 依赖未满足时的等待原因（taskId + 未满足条件） */
  waitingOn: string[];
  /** 该任务使用的角色模型（来自冻结 BuildSpec；''=跟随活跃预设） */
  model: { modelPresetId: string; providerId?: string; thinking?: string };
  /** 逻辑审查对象剩余自动修订预算（仅 write/integrate 任务；null=不适用） */
  revisionBudget: { usedAutoRevisions: number; maxAutoRevisions: number } | null;
  /** 该单元/整合范围最新审查报告的未关闭阻断问题数（无报告为 0） */
  blockingIssues: number;
}

export interface KbBuildOrchestrationReviewSummary {
  /** 已完成写入（产物可用）的单元数 */
  unitsWritten: number;
  /** 内容验收通过（含整合）的单元数 */
  unitsReviewed: number;
  /** 待修订/待裁定（needs_revision + pending_decision）单元数 */
  unitsPendingRevision: number;
  /** 整合/最终复核就绪标记与沿用文档数（B 案 §4 沿用披露） */
  integration: { integratePassed: boolean; finalReviewDone: boolean; carriedOverDocs: number };
}

export interface KbBuildOrchestrationDto {
  buildId: string;
  spec: {
    specHash: string | null;
    publishMode: 'auto' | 'confirm';
    concurrency: number;
    maxAutoRevisions: number;
    maxInterfaceRetries: number;
  };
  ended: boolean;
  endReason: string | null;
  tasks: KbBuildOrchestrationTaskDto[];
  reviewSummary: KbBuildOrchestrationReviewSummary;
  lateReceiptCount: number;
  /** 接口失败重试总次数（与内容修订分开计数，B 案 §5） */
  interfaceRetryTotal: number;
  autoRevisionUsage: Record<string, number>;
}

// ---------------------------------------------------------------------------
// v2（设计 v2 §8/§12/§13.5）Leader 监督运行进度 —— 镜像集成切片真实契约：
// server/src/types/agent-knowledge.ts 的 LeaderRunProgressDto，端点
// GET /api/kb/builds/:id/leader（非 pi-amagi 构建 → 404 build_not_found）。
// 用量/排队原因细分/成果计数未随端点提供：前端如实标未知，不虚构。
// ---------------------------------------------------------------------------

/** 监督视角任务行（ActorBinding 监督快照；写入授权登记在工具服务侧）。 */
export interface KbLeaderRunTaskDto {
  /** amagi nativeTaskId（应用从创建事件登记的任务身份）。 */
  nativeTaskId: string;
  /** amagi 角色（luban/diting/baize…）。 */
  role: string;
  /** 续接链父任务；null = 首派。 */
  parentTaskId: string | null;
  /** 身份状态：pending=待确认 confirmed=已确认 revoked=已撤销。 */
  status: 'pending' | 'confirmed' | 'revoked';
  /** amagi 执行三轴状态（queued/running/done/failed/cancelled…；未知值原样展示）。 */
  execState: string | null;
  lastEventAt: string;
  /** 历史DTO可能缺省；已知时用于区分历史任务与当前运行。 */
  runtimeEpoch?: number | null;
  generation?: number;
}

/** GET /api/kb/builds/:id/leader —— Leader 监督运行进度（仅 pi-amagi 构建）。
 *  镜像集成切片 LeaderRunProgressDto（含 summary 真实计数/termination/
 *  skill 冻结信息）；无可靠来源的字段为 null，前端如实标未知。 */
export interface KbLeaderRunProgressDto {
  buildId: string;
  orchestrationMode: 'pi-amagi';
  /** 凭据代次。 */
  generation: number;
  runtimeEpoch?: number | null;
  leader: {
    sessionId: string | null;
    pid: number | null;
    /** 恢复级别三态：session=原会话续接；artifact=成果级重建；none=不支持。 */
    resumeCapability: 'session' | 'artifact' | 'none';
  } | null;
  /** 当前计划任务快照（数量随 Leader 分解变化，非可信总数）。 */
  tasks: KbLeaderRunTaskDto[];
  /** Leader 自触发轮次（首个 agent_end 不代表构建结束）。 */
  rounds: { started: number | null; ended: number | null } | null;
  /** 空闲宽限：提醒已发时间与最近活动时间。 */
  idle: { remindedAt: string | null; lastActivityAt: string | null };
  /** 最近一次发布申请。 */
  publishRequest: KbLeaderPublishRequestDto | null;
  /** 成果/问题/用量汇总（无可靠来源=null，不虚构）。 */
  summary: {
    /** 已接受文档数（actorStore 回执去重 paths）；null=未知。 */
    acceptedDocumentCount: number | null;
    /** 未解决 blocking 问题数；null=未知。 */
    openBlockingCount: number | null;
    /** 活动输出分配数；null=未知。 */
    activeAssignments: number | null;
    /** 子任务排队原因细分（amagi 准入内部不可观测；如实 null）。 */
    queueReason: string | null;
    /** 末次 Leader 轮次用量（非累计；子任务用量不经 Leader RPC 事件）。 */
    lastUsage: { inputTokens: number; outputTokens: number; at: string } | null;
    /** 累计用量：父子去重后不可得，恒 null（不假累加）。 */
    cumulativeUsage: null;
  };
  /** 监督结束原因（null=运行中）。 */
  endedReason: string | null;
  /** 终止状态：cancelling=已请求取消未落地；finished=已结束；none=运行中；
 *  无可靠来源（仅检查点）时 null，不虚构。 */
  termination?: 'none' | 'cancelling' | 'finished' | 'termination-unconfirmed' | null;
  /** 生命周期核验而非业务成功状态；缺省不推断已退出。 */
  processTermination?: {
    state: 'confirmed' | 'unconfirmed';
    at: string;
    note: string;
    unconfirmedPids: number[];
  } | null;
  /** 冻结工作流 skill（路径+内容哈希=workflowRevision；供核对）。 */
  skill?: { path: string; revision: string } | null;
  /** 已处理事件游标（按 source:eventId）。 */
  eventCursor: Record<string, string>;
  updatedAt: string;
}

/** 发布申请快照（镜像集成侧 LeaderPublishRequestSnapshot）。 */
export interface KbLeaderPublishRequestDto {
  requestId: string | null;
  candidateRevision: string;
  summary: string;
  accepted: boolean;
  status: 'pending' | 'accepted' | 'rejected' | 'not_wired' | null;
  decidedAt: string;
}

// ---------------------------------------------------------------------------
// v2 构建运行宿主状态（镜像集成侧 kb/build-runtime-host.ts BuildRuntimeStatusDto
// 与 routes/kb.ts：GET /api/kb/build-runtime、POST /api/kb/build-runtime/install；
// 宿主未接线 → 503 build_runtime_unavailable）。
// ---------------------------------------------------------------------------

/** GET /api/kb/build-runtime —— 能力探测/包安装/运行状态（UI 设置卡消费）。 */
export interface KbBuildRuntimeStatusDto {
  orchestrationMode: 'legacy' | 'pi-amagi' | 'claude-native';
  runtime: {
    nodePath: string | null;
    nodeVersion: string | null;
    piCliPath: string | null;
    piVersion: string | null;
  } | null;
  amagi: {
    /** 新构建目标版本；优先已配置的较新本地包，缺省为内置回退版本。 */
    pinnedVersion: string;
    selectedSource?: string | null;
    distribution?: 'bundled' | 'configured' | 'git';
    installed: boolean;
    version: string | null;
    installDir: string | null;
    contentHash: string | null;
    layout: string | null;
    /** 私有安装事实（installed=已装可校；missing=未装；broken=目录/记录损坏）。 */
    installState: 'installed' | 'missing' | 'broken';
    installDetail: string | null;
    /** 官方 Git 默认安装来源（未安装时的确定来源）。 */
    gitSource: string;
    commit: string;
    repoUrl: string;
    /** 只读发现的 amagi-pi 候选（全局 Pi home / 应用 pi-home）。 */
    candidates: KbAmagiCandidateDto[];
    /** 发现异常（unavailable/error 不代表未安装，单独表达）。 */
    discoveryIssues: KbAmagiDiscoveryIssueDto[];
  } | null;
  probe: {
    /** 静态检查全部 pass（无 fail）才为 true；warn 不阻断。 */
    staticOk: boolean;
    /** 完整启用（含实测）前必须为 true；staticOk ≠ fullyVerified。 */
    fullyVerified: boolean;
    checks: Array<{ id: string; title: string; kind: string; state: string; detail: string }>;
  } | null;
  /** 探测失败原因（probe=null 时非空）。 */
  error: string | null;
}

/** 只读发现的单个 amagi-pi 候选（其他 Pi home 里真实存在的安装）。 */
export interface KbAmagiCandidateDto {
  origin: 'global-pi-home' | 'app-pi-home';
  source: string;
  sourceType: 'npm' | 'git' | 'local';
  packagePath: string | null;
  version: string | null;
  matchesPin: boolean;
}

/** 单个 Pi home 的发现异常状态。 */
export interface KbAmagiDiscoveryIssueDto {
  origin: 'global-pi-home' | 'app-pi-home';
  status: 'unavailable' | 'error';
  detail: string | null;
  settingsErrors: Array<{ scope: string; path: string | null; message: string }>;
}

/** POST /api/kb/build-runtime/install 响应（sourceDir 可选本地可信包源绝对路径；
 * 缺省走官方 Git 固定 commit 获取链；已装则完整校验复用 fresh=false）。 */
export interface KbBuildRuntimeInstallResultDto {
  installed: boolean;
  fresh: boolean;
  version: string;
  installDir: string;
  contentHash: string;
  layout: string | null;
  dependenciesIncluded: boolean;
  acquisition?: { gitSource: string; commit: string; repoUrl: string; acquiredPackageRoot: string };
}

/** §9.5 GET /api/kb/mcp */
export interface KbMcpInfoDto {
  available: boolean;
  snippet: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// §9.3 会话
// ---------------------------------------------------------------------------

export type AgentBackend = 'pi' | 'claude-code';
export type AgentSessionMode = 'discuss' | 'work';
export type AgentSessionState = 'idle' | 'starting' | 'streaming' | 'error';

export type SessionModelConfig = Pick<AgentConfig['model'], 'source' | 'providerId' | 'modelId' | 'piModel' | 'thinkingLevel'>;

export interface AgentSessionDto {
  localResources?: boolean;
  approvalMode?: 'ask' | 'auto';
  backend?: 'pi' | 'claude-code';
  model?: SessionModelConfig | null;
  id: string;
  title: string;
  mode: AgentSessionMode;
  workspace: null | { id: string; name: string; path: string };
  state: AgentSessionState;
  lastError: null | { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

export interface AgentToolCallRef {
  id: string;
  name: string;
  argsSummary: string;
}

export interface AgentAttachmentDto {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: 'image' | 'document';
  textLength: number;
  lineCount: number;
  note?: string;
}

export interface AgentMessageDto {
  /** Native Pi thinking blocks, retained separately from assistant prose. */
  thinking?: string;
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  at: string;
  text?: string;
  attachments?: AgentAttachmentDto[];
  toolCalls?: AgentToolCallRef[];
  tool?: {
    callId: string;
    name: string;
    isError: boolean;
    resultSummary: string;
  };
  error?: { code: string; message: string };
  model?: string;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 会话内批准（S10，设计 kb-agent-upgrade §6.5）
// ---------------------------------------------------------------------------

export type AgentApprovalRisk = 'read' | 'mutate' | 'destructive' | 'remote_write';

/** 批准请求（SSE approval_request 负载 + GET /approvals 列表项）。 */
export interface AgentApprovalDto {
  id: string;
  sessionId: string;
  command: string;
  risk: AgentApprovalRisk;
  argsSummary: string;
  preview?: unknown;
  expiresAt: string;
}

export type AgentApprovalOutcome = 'approve' | 'reject' | 'timeout' | 'cancelled';

// ---------------------------------------------------------------------------
// 任务编排（S7，设计 kb-agent-upgrade §5.4；S6 后端契约）
// ---------------------------------------------------------------------------

export type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/**
 * 任务 DTO：GET /api/agent/tasks* 响应项，亦是父会话 SSE `task_update`
 * 事件的负载（每次状态迁移 / rounds 变化 / 截断结果更新都会推）。
 */
export interface AgentTaskDto {
  id: string;
  sessionId: string;
  role: string;
  title: string;
  status: AgentTaskStatus;
  /** queued 时为会话内排队序（1 起，按 created_at,id 字典序）；其余为 null。 */
  queuePosition: number | null;
  rounds: number;
  outputDir: string | null;
  /** blocked 时子任务提出的 QUESTIONS（作答素材）。 */
  questions: string | null;
  result: string | null;
  /** true = 展示层已截断（工具返回 20000 字符 / 库内 64KB 上限）。 */
  resultTruncated: boolean;
  error: null | { code: string; message: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 任务态变化在消息流中的提示行（前端由 task_update 事件推导）。 */
export interface AgentTaskNotice {
  id: string;
  text: string;
}

// SSE 事件负载（§9.2 构建 / §9.3 会话）
// ---------------------------------------------------------------------------

/** 会话 SSE 事件的判别联合；`type` 为 event 名。 */
export type AgentSessionEvent =
  | { type: 'session_state'; session: AgentSessionDto }
  | { type: 'run_start'; runId: string }
  | { type: 'text_delta'; runId: string; delta: string }
  | { type: 'thinking_delta'; runId: string; delta: string }
  | {
      type: 'tool';
      runId: string;
      phase: 'start' | 'end';
      callId: string;
      toolName: string;
      argsSummary: string;
      resultSummary?: string;
      isError?: boolean;
    }
  | { type: 'message_end'; runId: string; message: AgentMessageDto }
  | { type: 'approval_request'; approval: AgentApprovalDto }
  | { type: 'approval_resolved'; id: string; decision: AgentApprovalOutcome }
  | { type: 'task_update'; task: AgentTaskDto }
  | {
      type: 'run_end';
      runId: string;
      outcome: 'completed' | 'failed' | 'aborted';
      error?: { code: string; message: string };
    }
  | { type: 'resync' };

export type KbBuildEvent =
  | { type: 'build_status'; build: KbBuildDto }
  | { type: 'build_log'; level: 'info' | 'warn' | 'error'; message: string; at: string; workerId?: string; unitId?: string }
  | { type: 'build_worker'; workerId: string; state: KbBuildWorkerState; unitId: string | null; unitBatchIndex: number; unitBatchTotal: number }
  | { type: 'build_units'; total: number; done: number; running: number; failed: number; retried: number }
  | {
      type: 'tool';
      phase: 'start' | 'end';
      toolName: string;
      summary: string;
      isError?: boolean;
      workerId?: string;
      unitId?: string;
    }
  | { type: 'assistant_delta'; delta: string; workerId?: string; unitId?: string };

// ---------------------------------------------------------------------------
// D1（A 案 §4.2/§5.1）人工治理 —— server KnowledgeGovernanceService 镜像
// ---------------------------------------------------------------------------

export type KbGovernanceBusinessStatus = 'unknown' | 'candidate' | 'approved' | 'disputed' | 'deprecated';

/** 人工业务决定记录（追加式；supersede 链保留历史） */
export interface KbGovernanceDecisionDto {
  decisionId: string;
  createdAt: string;
  actor: string;
  objectId: string;
  payloadHash: string;
  scopeKey: string;
  businessStatus: KbGovernanceBusinessStatus;
  rationale: string;
  evidenceIds?: string[];
  supersedesDecisionId?: string;
  /** 登记时与当前对象 payloadHash 不匹配（消费端拒绝当轮生效） */
  payloadMismatch?: boolean;
}

/** 人工内容复核记录（绑定 reviewSubjectHash；变化即失效） */
export interface KbHumanReviewDto {
  reviewId: string;
  createdAt: string;
  actor: string;
  objectId: string;
  reviewSubjectHash: string;
  reviewerId?: string;
  passed: boolean;
  note?: string;
}

export interface KbGovernanceDecisionsDto {
  records: KbGovernanceDecisionDto[];
  effective: KbGovernanceDecisionDto[];
  revision: number;
}

/** 待治理对象（GET /api/kb/governance/pending 行；当前 release × 治理状态联查） */
export interface KbGovernancePendingObjectDto {
  objectId: string;
  title: string;
  type: string;
  docPath: string | null;
  anchor: string | null;
  scopeKey: string;
  businessStatus: KbGovernanceBusinessStatus;
  reviewStatus: string;
  payloadHash: string;
  reviewSubjectHash: string;
  highRiskClaims: string[];
  claimPreviews: Array<{ claimKey: string; excerpt: string; evidenceSources: string[] }>;
  humanReviewed: boolean;
  reviewRejection: string | null;
  effectiveDecision: {
    decisionId: string;
    businessStatus: KbGovernanceBusinessStatus;
    createdAt: string;
    payloadMismatch: boolean;
  } | null;
  allowedDecisionTargets: KbGovernanceBusinessStatus[];
}

export interface KbGovernancePendingDto {
  releaseId: string | null;
  /** Only an explicit rejected human review is an actionable content problem. */
  highRisk: KbGovernancePendingObjectDto[];
  candidates: KbGovernancePendingObjectDto[];
  staleDecisions: KbGovernancePendingObjectDto[];
  /** diting S-F04：可操作对象（当前 release 全部活跃对象；含 unknown/
 * approved/deprecated 的合法转移入口，目标集由服务端按有效决定链计算） */
  governable: KbGovernancePendingObjectDto[];
  /** 状态转移表（server DECISION_TARGETS_BY_STATUS；渲染选择项语义用） */
  transitionTable: Record<string, KbGovernanceBusinessStatus[]>;
}
