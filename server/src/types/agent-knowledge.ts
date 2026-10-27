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

export interface AgentConfig {
  runtime: { nodePath?: string; piCliPath?: string };
  model: AgentModelConfig;
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
  /** 第一阶段固定 false（字段预留） */
  autoBuildAfterSync: boolean;
}

export const DEFAULT_AGENT_MODEL_CONFIG: AgentModelConfig = {
  source: 'app-llm',
  thinkingLevel: 'off',
  contextWindow: 128_000,
  maxTokens: 8192,
};

export function buildDefaultAgentConfig(_dataRoot: string): AgentConfig {
  return {
    runtime: {},
    model: { ...DEFAULT_AGENT_MODEL_CONFIG },
    maxConcurrentProcesses: 2,
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

export type KbSourceState = 'current' | 'changed' | 'missing';

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
  progress: { batchIndex: number; batchTotal: number };
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
// 会话（§7 / §9.3）
// ============================================================================

export type AgentSessionMode = 'discuss' | 'work';

export type AgentSessionState = 'idle' | 'starting' | 'streaming' | 'error';

export interface AgentSessionDto {
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
// 工具规格（§7.1）
// ============================================================================

export type AgentRunKind = 'discuss' | 'work' | 'build' | 'probe';

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

export const DISCUSS_TOOLS = ['kb_search', 'kb_read', 'raw_search', 'raw_read'] as const;
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
  }
}
