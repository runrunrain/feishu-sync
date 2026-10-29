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
  };
  processes: { running: number; max: number };
  checkedAt: string;
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
    thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
    contextWindow: number;
    maxTokens: number;
  };
  /** 图片理解通道（S2/S5 UI）；缺省 disabled */
  vision?: AgentVisionConfig;
  maxConcurrentProcesses: number;
  idleTimeoutMinutes: number;
  workspaces: AgentWorkspaceConfig[];
}

export interface StandardKbConfig {
  outputRoot: string;
  retainReleases: number;
  buildBatchSize: number;
  promptTimeoutMinutes: number;
  buildTimeoutMinutes: number;
  /** S4：并行构建 worker 数（1..6，默认 2；实际受 Agent 进程池后台配额约束） */
  buildParallelism: number;
  /** P2-S2：每批有效字数预算（0 = 按源数分批旧行为；取值域 {0}∪[4000,400000]，
   *  默认 40000。buildBatchSize 降为每批源数上限）。 */
  buildBatchWordBudget: number;
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
  state: 'current' | 'changed' | 'missing' | 'excluded';
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
  | 'published'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

// ---------------------------------------------------------------------------
// S4 §4.6：构建进度 DTO（多 worker / 单元 / 图片维度）
// ---------------------------------------------------------------------------

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

/** 构建警告（如 images_unavailable），随构建历史持久化 */
export interface KbBuildWarning {
  code: string;
  count: number;
  message: string;
}

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
  /** S4：本次构建并行度（实际生效值；1=等价单进程回退） */
  parallelism: number;
  /** S4：构建警告（如 images_unavailable） */
  warnings: KbBuildWarning[];
  error: null | { code: string; message: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
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

/** §9.5 GET /api/kb/mcp */
export interface KbMcpInfoDto {
  available: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  alternative: { command: string; args: string[]; note: string };
  snippet: string;
}

// ---------------------------------------------------------------------------
// §9.3 会话
// ---------------------------------------------------------------------------

export type AgentSessionMode = 'discuss' | 'work';
export type AgentSessionState = 'idle' | 'starting' | 'streaming' | 'error';

export type SessionModelConfig = Pick<AgentConfig['model'], 'source' | 'providerId' | 'modelId' | 'piModel' | 'thinkingLevel'>;

export interface AgentSessionDto {
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

export interface AgentMessageDto {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  at: string;
  text?: string;
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
