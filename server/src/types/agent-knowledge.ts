/**
 * Agent 标准知识库（F1 后端）类型定义
 *
 * 公共契约见 docs/design/agent-knowledge-design.md。本文件只承载类型与
 * 纯常量，不引入 IO。DTO 与 Config 段在此定义后被 ConfigManager /
 * LocalMapStore / 路由层共享。
 */

// ============================================================================
// 配置段（Config 新增 agent + standardKb）
// ============================================================================

export interface AgentWorkspaceConfig {
  /** 'ws_' + 12 位随机 */
  id: string;
  name: string;
  /** 绝对路径，保存时 realpath 规范化 */
  path: string;
  createdAt: string;
}

export type AgentModelSource = 'app-llm' | 'pi-agent-dir';

export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentModelConfig {
  source: AgentModelSource;
  /** app-llm：显式 provider/preset；缺省回落 llm.activeProviderId/activeModelId */
  providerId?: string;
  modelId?: string;
  /** pi-agent-dir：'provider/id' */
  piModel?: string;
  piThinkingLevels?: Record<string, AgentThinkingLevel[]>;
  thinkingLevel: AgentThinkingLevel;
  /** app-llm 注册 provider 用（上下文窗口），默认 128000 */
  contextWindow: number;
  /** 默认 8192 */
  maxTokens: number;
}

/** 图片理解通道配置（设计 §3.1，S2）。
 *
 * 只引用 `llm.providers` 既有注册表（providerId/modelId），不新增任何
 * key/秘密字段；凭证始终取自被引用 provider 的 apiKey。缺省 disabled。 */
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
  model: AgentModelConfig;
  /** 图片理解通道（S2）；缺省 disabled，见 buildDefaultAgentVisionConfig */
  vision: AgentVisionConfig;
  /** 任务编排参数；开关位于内置插件条目 orchestration，默认启用。 */
  orchestration: AgentOrchestrationConfig;
  maxConcurrentProcesses: number;
  idleTimeoutMinutes: number;
  workspaces: AgentWorkspaceConfig[];
}

/** 任务编排参数（S6，设计 kb-agent-upgrade §5.2/§5.3）。
 *
 * `enabled` 开关不在此处：它是 knowledge-workbench 内置包的「任务编排」
 * 插件条目（AppPluginStore，默认停用），随插件快照 revision 生效。 */
export interface AgentOrchestrationConfig {
  /** 每会话非终态（queued/running/blocked）任务上限，超出 task_queue_full。1..32，默认 8。 */
  maxActiveTasksPerSession: number;
  /** 子任务单轮（单次 prompt）超时分钟数。1..1440，默认 30。 */
  taskTimeoutMinutes: number;
}

export interface StandardKbConfig {
  outputRoot: string;
  retainReleases: number;
  buildBatchSize: number;
  /** S4：单元内每批源数（语义升级为「每批源数上限」；单元划分见 build-units.ts） */
  promptTimeoutMinutes: number;
  buildTimeoutMinutes: number;
  /** P2-S2（U42/§2.5）：每批有效字数预算。0 = 关闭（按源数分批的旧行为）；
   * 4000..400000；缺省 40000（ConfigManager 归一保证存在；越界钳制到边界）。
   * full 模式单元字数上限 = 该值 ×3（U44）。 */
  buildBatchWordBudget: number;
  /** S4：并行构建 worker 数（1..6，默认 2；实际受 Agent 进程池后台配额约束）。
   * 缺省/旧配置无此字段 → 默认 2（可设为 1 得到等价单 worker 的旧行为回退）。
   * 继续有效：未设 buildConcurrency 时的回落来源（见 resolveBuildConcurrency）。 */
  buildParallelism: number;
  /** B案 §6：构建名额 N 的新语义入口——全部文本构建角色（写/审/修订/
   * 规划/整合/最终复核）合计 N 路，交互等保底名额额外计算，不再被另一
   * 道应用总上限压低。additive 可选：1..8；**优先于 buildParallelism**，
   * 未设时回落 buildParallelism（resolveBuildConcurrency 统一解析）。 */
  buildConcurrency?: number;
  /** B案 §3/§8：角色模型配置（撰写/审查必选，整合缺省跟随撰写，规划者
   * 缺省关闭）。additive 可选：旧配置无此字段 → 跟随活跃预设。 */
  buildRoles?: KbBuildRolesConfig;
  /** B案 §5：审查闭环预算。additive 可选：缺省 2/2。 */
  reviewPolicy?: KbReviewPolicyConfig;
  /** B案 §7：发布方式。additive 可选：缺省 'auto'（通过后自动整版发布）；
   * 'confirm' 只在最终候选版本就绪后确认一次（绑定候选版本）。 */
  publishMode?: 'auto' | 'confirm';
  /** 第一阶段固定 false（字段预留） */
  autoBuildAfterSync: boolean;
}

/** B案 §8 角色模型选择：引用 llm 注册表的 provider+model 预设，密钥不入
 * 构建记录；模型只从应用已配置的提供商中选择。 */
export interface KbBuildRoleConfig {
  /** 引用 llm.providers[].models[].id；'' = 跟随活跃预设
   * （llm.activeProviderId/activeModelId，构建期解析；同 AgentVisionConfig
   * 的回落模式）。 */
  modelPresetId: string;
  /** 预设 id 跨 provider 重名时定位；缺省回落 activeProviderId。 */
  providerId?: string;
  /** 思考强度（受控枚举，同 AgentModelConfig.thinkingLevel）；缺省 'off'。 */
  thinking?: AgentThinkingLevel;
}

export interface KbBuildRolesConfig {
  writer: KbBuildRoleConfig;
  reviewer: KbBuildRoleConfig;
  /** 整合者缺省跟随撰写模型（B案 §3） */
  integrator?: KbBuildRoleConfig;
  /** 规划者默认关闭（B案 §1/§3） */
  plannerEnabled?: boolean;
}

export interface KbReviewPolicyConfig {
  /** 每个审查对象最多自动修订轮数，1..5，默认 2（B案 §5）；同一审查对象
   * 换稿不重置预算。 */
  maxAutoRevisions?: number;
  /** 模型接口失败重试次数，0..5，默认 2（B案 §5）；与内容修订分开计数。 */
  maxInterfaceRetries?: number;
}

/** B案 §6 构建名额解析：buildConcurrency 优先，未设时回落 buildParallelism；
 * 统一钳制到 1..8。后续调度/配额改造均应从此入口取 N，不各自读字段。 */
export function resolveBuildConcurrency(config: Pick<StandardKbConfig, 'buildConcurrency' | 'buildParallelism'>): number {
  if (typeof config.buildConcurrency === 'number' && Number.isFinite(config.buildConcurrency)) {
    return Math.min(8, Math.max(1, Math.floor(config.buildConcurrency)));
  }
  const fallback = typeof config.buildParallelism === 'number' && Number.isFinite(config.buildParallelism)
    ? config.buildParallelism
    : 2;
  return Math.min(8, Math.max(1, Math.floor(fallback)));
}

export const DEFAULT_AGENT_MODEL_CONFIG: AgentModelConfig = {
  source: 'app-llm',
  thinkingLevel: 'off',
  contextWindow: 128_000,
  maxTokens: 8192,
};

export const DEFAULT_AGENT_VISION_TIMEOUT_MS = 120_000;
/** 单图硬上限 20 MiB（设计 §3.1）。 */
export const VISION_MAX_IMAGE_BYTES_CEILING = 20 * 1024 * 1024;

export function buildDefaultAgentVisionConfig(): AgentVisionConfig {
  return {
    enabled: false,
    concurrency: 3,
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerBuild: 300,
    timeoutMs: DEFAULT_AGENT_VISION_TIMEOUT_MS,
  };
}

export function buildDefaultAgentOrchestrationConfig(): AgentOrchestrationConfig {
  return {
    maxActiveTasksPerSession: 5,
    taskTimeoutMinutes: 30,
  };
}

export function buildDefaultAgentConfig(_dataRoot: string): AgentConfig {
  return {
    runtime: { backend: 'claude-code' },
    model: { ...DEFAULT_AGENT_MODEL_CONFIG },
    vision: buildDefaultAgentVisionConfig(),
    orchestration: buildDefaultAgentOrchestrationConfig(),
    maxConcurrentProcesses: 3,
    idleTimeoutMinutes: 10,
    workspaces: [],
  };
}

export function buildDefaultStandardKbConfig(dataRoot: string): StandardKbConfig {
  return {
    outputRoot: defaultKbOutputRoot(dataRoot),
    retainReleases: 3,
    buildBatchSize: 10,
    buildBatchWordBudget: 40_000,
    promptTimeoutMinutes: 15,
    buildTimeoutMinutes: 180,
    buildParallelism: 2,
    // B案 §6：buildConcurrency 不设默认值——未设时回落 buildParallelism
    // （resolveBuildConcurrency），避免默认值冻结回落语义。
    // B案 §3/§8/§5/§7：角色/审查预算/发布方式默认值（旧配置 additive 兼容）
    buildRoles: {
      writer: { modelPresetId: '' },
      reviewer: { modelPresetId: '' },
      plannerEnabled: false,
    },
    reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
    publishMode: 'auto',
    autoBuildAfterSync: false,
  };
}

export function defaultKbOutputRoot(dataRoot: string): string {
  // posix join：dataRoot 在两平台都是绝对路径，标准库目录名固定
  const sep = dataRoot.includes('\\') ? '\\' : '/';
  return `${dataRoot.replace(/[\\/]+$/, '')}${sep}standard-kb`;
}

// ============================================================================
// 就绪诊断（§3.2）
// ============================================================================

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

export const PI_SUPPORTED_RANGE = '>=1.4.0 <2.0.0';
export const NODE_MIN_VERSION = '22.19.0';

export interface AgentStatusDto {
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
    source: AgentModelSource;
    model: string | null;
    available: string[];
    capabilities?: Record<string, AgentThinkingLevel[]>;
  };
  processes: { running: number; max: number; /** B 案 §6：构建通道诊断（容量 N 独立，总上限 = N + max，如实上报） */ build?: { running: number; capacity: number } };
  checkedAt: string;
}

// ============================================================================
// 标准库（§6 / §9.2）
// ============================================================================

export interface RawSourceSnapshotEntry {
  objToken: string;
  objType: string;
  title: string;
  relPath: string;
  contentHash: string;
  objEditTime: string | null;
  /** S3：源关联图片合并哈希（按 src 排序逐图 sha256 再合并）；无图 null。
   * contentHash 公式不变；旧 manifest 无此字段视为未变（U4） */
  mediaHash?: string | null;
  /** S3：图片引用计数 */
  imageCount?: number;
  /** P0-S7（设计 P0 §5.5）：白板旁路文字合并哈希（按引用顺序逐板
   * sha256(origin\0抽取文字) 再拼接后整体 sha256）；无旁路文字为 ''。
   * 旁路文件不进 contentHash/mediaHash——contentHash 公式不变，升级不
   * 触发全量 changed；旧 manifest 无此字段视为未变（additive 兼容） */
  whiteboardTextHash?: string;
}

export interface KbManifestDoc {
  docId: string;
  path: string;
  title: string;
  summary: string;
  headings: string[];
  tags: string[];
  sources: string[];
  contentHash: string;
  updatedInBuild: string;
}

export interface KbManifest {
  schemaVersion: number;
  releaseId: string;
  buildId: string;
  mode: 'incremental' | 'full';
  baseReleaseId: string | null;
  publishedAt: string;
  model: string | null;
  sourceSnapshot: RawSourceSnapshotEntry[];
  docs: KbManifestDoc[];
  skippedSources: Array<{ objToken: string; reason: string }>;
  /** A案 §10.2 manifest v2：组织元数据（knowledge.json 的版本/哈希与覆盖
   * 模式）。v2 = schemaVersion:2 且必含 organization（isKbManifestV2）；
   * 旧读者遇 v2 应报不支持，禁止静默读无状态内容。 */
  organization?: KbOrganizationManifestSection;
  /** A案 §5.4/§6.2：证据资源索引（evidence-resources.json）路径与哈希 */
  evidence?: { resourcesPath: string; hash: string };
  /** A案 §4.2：治理文件（governance.json，本 release 使用的人工决定与
   * 审查凭据）路径与哈希 */
  governance?: { path: string; hash: string };
}

export const KB_MANIFEST_SCHEMA_V2 = 2;

export interface KbOrganizationManifestSection {
  schemaVersion: number;
  /** knowledge.json 相对 release 根路径 */
  path: string;
  hash: string;
  /** managed = 全库纳管；mixed = 已纳管按对象门禁 + 未纳管完整文档显式登记
   * legacy-unclassified 原样保留（A案 §10.2） */
  coverageMode: 'managed' | 'mixed';
}

/** v2 判定（A案 §10.2）：schemaVersion:2 且必含 organization；缺组织段
 * 的 schemaVersion:2 视为非法 v2（老消费者忽略新状态会造成静默误用）。 */
export function isKbManifestV2(manifest: KbManifest): boolean {
  return manifest.schemaVersion === KB_MANIFEST_SCHEMA_V2 && manifest.organization !== undefined;
}

export interface KbCurrentPointer {
  schemaVersion: number;
  releaseId: string;
  publishedAt: string;
}

export type KbSourceState = 'current' | 'changed' | 'missing' | 'excluded' | 'deleted';

export interface KbStatusDto {
  outputRoot: string;
  current: null | {
    releaseId: string;
    buildId: string;
    publishedAt: string;
    docCount: number;
    sourceCount: number;
    model: string | null;
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

export interface KbDocDto {
  docId: string;
  path: string;
  title: string;
  summary: string;
  tags: string[];
  markdown: string;
  releaseId: string;
  updatedInBuild: string;
  sources: Array<{
    objToken: string;
    title: string;
    relPath: string;
    state: KbSourceState;
  }>;
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

export interface KbBuildDto {
  id: string;
  mode: 'incremental' | 'full';
  status: KbBuildStatus;
  noChanges: boolean;
  baseReleaseId: string | null;
  releaseId: string | null;
  model: string | null;
  counts: {
    sourceTotal: number;
    added: number;
    changed: number;
    removed: number;
    docsWritten: number;
    docsDeleted: number;
  };
  progress: KbBuildProgressDto;
  /** S4：本次构建并行度（实际生效值） */
  parallelism: number;
  /** S4：构建警告（如 images_unavailable），随构建历史持久化 */
  warnings: KbBuildWarning[];
  error: null | { code: string; message: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 当前状态已包含至此的事件；重启/恢复连接据此跳过旧终态。 */
  eventSeq?: number;
  recovery?: { canResume: boolean; reason: string | null; checkpointAt: string | null; draftCount: number; completedBatches: number; totalBatches: number };
}

export interface KbBuildReportIssue {
  path?: string;
  objToken?: string;
  code: string;
  message: string;
}

// ============================================================================
// 构建进度（S4 §4.6：多 worker / 单元 / 图片维度）
// ============================================================================

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

// ============================================================================
// T2b（B 案 §4/§5/附录 B）：编排流水进度 DTO —— 同一份 BuildOrchestration
// 数据源派生，不生成第二份统计
// ============================================================================

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
  /** 逻辑审查对象剩余自动修订预算（仅 write/integrate 任务） */
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

export interface KbBuildWarning {
  code: string;
  count: number;
  message: string;
}

// ============================================================================
// 会话（§7 / §9.3）
// ============================================================================

export type AgentSessionMode = 'discuss' | 'work';

export type AgentSessionState = 'idle' | 'starting' | 'streaming' | 'error';

export type SessionModelConfig = Pick<AgentModelConfig, 'source' | 'providerId' | 'modelId' | 'piModel' | 'thinkingLevel'>;

export interface AgentSessionDto {
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

export interface AgentToolCallDto {
  id: string;
  name: string;
  argsSummary: string;
}

export interface AgentMessageDto {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  at: string;
  text?: string;
  toolCalls?: AgentToolCallDto[];
  tool?: {
    callId: string;
    name: string;
    isError: boolean;
    resultSummary: string;
  };
  error?: { code: string; message: string };
  model?: string;
}

export interface KbMcpInfoDto {
  available: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  alternative: { command: string; args: string[]; note: string };
  snippet: string;
}

// ============================================================================
// 任务编排（S6，设计 kb-agent-upgrade §5.4）
// ============================================================================

export type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** 终态：不再被 TaskService 推进；blocked 可经作答回到 queued。 */
export const AGENT_TASK_TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

export interface AgentTaskDto {
  id: string;
  sessionId: string;
  role: string;
  title: string;
  status: AgentTaskStatus;
  /** queued 时为会话内排队序（1 起，按 created_at,id）；其余为 null */
  queuePosition: number | null;
  rounds: number;
  outputDir: string | null;
  questions: string | null;
  result: string | null;
  /** true = 展示层已截断（工具返回 20000 字符 / 库内 64KB 上限） */
  resultTruncated: boolean;
  error: null | { code: string; message: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ============================================================================
// 工具规格（§7.1）
// ============================================================================

export type AgentRunKind = 'discuss' | 'work' | 'build' | 'probe' | 'task';

/**
 * S6 子任务运行（depth=1）：基线工具集为空，实际白名单由 TaskService
 * 按「角色请求 ∩ 父会话模式工具集 ∩ 已知工具」冻结后经
 * createRunContext({ allowedToolsOverride }) 显式授予；task_* 永不进入
 * 子任务白名单（防递归派发）。
 */

export interface AgentToolSpec {
  name: string;
  label: string;
  description: string;
  /** 纯 JSON Schema（pi 校验器按 JSON Schema type 工作） */
  parameters: Record<string, unknown>;
}

export interface AgentRunContext {
  runKind: AgentRunKind;
  sessionId?: string;
  buildId?: string;
  workspaceRoot?: string;
  stagingRoot?: string;
  allowedTools: string[];
  createdAt: number;
}

// S10：app_command（ops 工具族）进入 discuss/work 基线面（Build/Task 不下发）；
// 白名单成员由 agent-tool-service 的族注册表派生，此处仅保证 pi --tools 参数面同步。
// S3：raw_read_image 追加进 discuss/work 基线面（会话侧按需识图）；
// S4：kb_unit_done 追加进 build 基线面（逐单元上报）。
// P1-S4：raw_links（引用关系查询，只读）追加进 discuss/work/build 三面。
// P2-S4：raw_comments（评论溯源，只读）只追加进 discuss/work 两面，
// **不进 build**——评论不在文件哈希围栏内，不得进入构建输入（设计
// §5.1 硬约束；agent-tool-service 族注册 runKinds 同步限制）。
// T3（A 案 §7.1/§7.2）：知识协议三工具追加进 build 面——kb_submit_plan
// （仅规划轮 phase 内部约束）、kb_get_plan（只读）、kb_submit_review
// （仅审查轮；审查者无草稿写入口）。白名单进入面与族注册同步。
export const DISCUSS_TOOLS = ['kb_search', 'kb_read', 'kb_grep', 'raw_search', 'raw_read', 'raw_read_image', 'raw_links', 'raw_comments', 'app_command'] as const;
export const WORK_TOOLS = [
  ...DISCUSS_TOOLS,
  'ws_ls',
  'ws_read',
  'ws_search',
  'ws_write',
  'ws_edit',
  'ws_mkdir',
] as const;
export const BUILD_TOOLS = [
  'raw_list',
  'raw_read',
  'raw_search',
  'raw_links',
  'draft_list',
  'draft_read',
  'draft_search',
  'kb_write_doc',
  'kb_delete_doc',
  'kb_unit_done',
  'kb_finish',
  'kb_submit_plan',
  'kb_get_plan',
  'kb_submit_review',
] as const;

export function toolsForRunKind(kind: AgentRunKind): string[] {
  switch (kind) {
    case 'discuss':
      return [...DISCUSS_TOOLS];
    case 'work':
      return [...WORK_TOOLS];
    case 'build':
      return [...BUILD_TOOLS];
    case 'probe':
      return [];
    case 'task':
      return [];
  }
}
