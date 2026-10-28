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

export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

export interface AgentModelConfig {
  source: AgentModelSource;
  /** app-llm：显式 provider/preset；缺省回落 llm.activeProviderId/activeModelId */
  providerId?: string;
  modelId?: string;
  /** pi-agent-dir：'provider/id' */
  piModel?: string;
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
  runtime: { nodePath?: string; piCliPath?: string };
  model: AgentModelConfig;
  /** 图片理解通道（S2）；缺省 disabled，见 buildDefaultAgentVisionConfig */
  vision: AgentVisionConfig;
  /** 任务编排参数（S6，设计 kb-agent-upgrade §5.1/§5.2）；开关本身在内置插件条目 orchestration 上（默认停用） */
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
  /** S4：单元内每批源数（语义升级为「单元内每批」；单元划分见 build-units.ts） */
  promptTimeoutMinutes: number;
  buildTimeoutMinutes: number;
  /** S4：并行构建 worker 数（1..6，默认 2；实际受 Agent 进程池后台配额约束）。
   * 缺省/旧配置无此字段 → 1（等价单 worker 回退，行为与既有构建一致） */
  buildParallelism: number;
  /** 第一阶段固定 false（字段预留） */
  autoBuildAfterSync: boolean;
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
    maxActiveTasksPerSession: 8,
    taskTimeoutMinutes: 30,
  };
}

export function buildDefaultAgentConfig(_dataRoot: string): AgentConfig {
  return {
    runtime: {},
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
    promptTimeoutMinutes: 15,
    buildTimeoutMinutes: 180,
    buildParallelism: 2,
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
  };
  model: {
    source: AgentModelSource;
    model: string | null;
    available: string[];
  };
  processes: { running: number; max: number };
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
}

export interface KbCurrentPointer {
  schemaVersion: number;
  releaseId: string;
  publishedAt: string;
}

export type KbSourceState = 'current' | 'changed' | 'missing' | 'excluded';

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

export type KbBuildStage = 'snapshot' | 'describing_images' | 'units' | 'finishing' | 'validating' | 'publishing';

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
export const DISCUSS_TOOLS = ['kb_search', 'kb_read', 'raw_search', 'raw_read', 'raw_read_image', 'app_command'] as const;
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
  'draft_list',
  'draft_read',
  'draft_search',
  'kb_write_doc',
  'kb_delete_doc',
  'kb_unit_done',
  'kb_finish',
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
