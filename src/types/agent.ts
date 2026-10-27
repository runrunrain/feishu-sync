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

export interface AgentConfig {
  runtime: { nodePath?: string; piCliPath?: string };
  model: {
    source: 'app-llm' | 'pi-agent-dir';
    providerId?: string;
    modelId?: string;
    piModel?: string;
    thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
    contextWindow: number;
    maxTokens: number;
  };
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
  autoBuildAfterSync: boolean;
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
  progress: { batchIndex: number; batchTotal: number };
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
  | {
      type: 'run_end';
      runId: string;
      outcome: 'completed' | 'failed' | 'aborted';
      error?: { code: string; message: string };
    }
  | { type: 'resync' };

export type KbBuildEvent =
  | { type: 'build_status'; build: KbBuildDto }
  | { type: 'build_log'; level: 'info' | 'warn' | 'error'; message: string; at: string }
  | {
      type: 'tool';
      phase: 'start' | 'end';
      toolName: string;
      summary: string;
      isError?: boolean;
    }
  | { type: 'assistant_delta'; delta: string };
