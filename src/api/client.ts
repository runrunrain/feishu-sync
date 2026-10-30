import type { KbLanMcpStatus, KbLanMcpSettings, KbLanMcpAuditEntry } from '../types/kb-lan-mcp';
import type { McpClientTarget, McpInstallStatus } from '../types/kb-mcp-install';
import type { SourceBatchRequest, SourceBatchPreview, SourceBatchResult } from '../types/source-batch';
import type { CliEnableResult, CliInfoDto, CliRotateResult, CliShimInstallResult } from '../types/cli';
import type { PiPluginsDto } from '../types/pi-plugin';
import type { AgentPluginsDto, AgentPluginInput } from '../types/agent-plugin';
import type { KbSourceTreeDto, KbSourceChoice, KbChangePreview, KbVersionDto } from '../types/kb-version';
import type {
  KbPublicationRowDto,
  KbPublishPlanDto,
  KbPublishRunResultDto,
  PublishTargetDto,
} from '../types/kb-publish';
/**
 * API client for feishu-sync
 * All requests include X-Desktop-Token header from window.desktop
 */

import type {
  Config,
  AuthStatus,
  ChangeDetectionResult,
  SyncResult,
  ServerHealth,
  ChangedDocument,
  MappingNode,
  DiffReport,
  IndexSnapshot,
  ReorderRequest,
  ReorderResponse,
  TrashedDoc,
  ChannelTestRequest,
  ChannelTestResult,
  FeishuPendingItem,
  TreeResponse,
  CustomFolder,
  AddLinkToFolderResult,
  DocumentContent,
  DocumentComments,
  SourceEditStatus,
  SourcePushPlan,
  SourcePushResult,
  SourcePushLogRecord,
  CloudHistoryListResult,
  HistoryRevertPlan,
  HistoryRevertExecutionResult,
  MoveOutPreview,
  MoveOutExecutionResult,
  CloudMoveRecord,
} from '../types';
import type {
  AgentBackend,
  ClaudeConnectionTestResult,
  AgentApprovalDto,
  AgentMessageDto,
  AgentSessionDto,
  AgentStatusDto,
  AgentTaskDto,
  AgentVisionStatusDto,
  AgentVisionTestResult,
  AgentWorkspaceConfig,
  KbBuildDto,
  KbBuildReportDto,
  KbDocDto,
  KbMcpInfoDto,
  KbSearchResult,
  KbStatusDto,
  KbTreeNode,
} from '../types/agent';
import { emitDiffChanged } from '../utils/syncEvents';
import type { WorkbookPreview } from '../types/workbook';

class APIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: any
  ) {
    super(message);
    this.name = 'APIError';
  }
}

/**
 * Get API headers including X-Desktop-Token
 */
async function getApiHeaders(): Promise<Record<string, string>> {
  if (typeof window !== 'undefined' && window.desktop) {
    try {
      const desktopHeaders = await window.desktop.getApiHeaders();
      return desktopHeaders;
    } catch (error) {
      console.error('Failed to get desktop headers:', error);
      throw new APIError('Failed to authenticate with desktop');
    }
  }

  // Development fallback: proxy through Vite
  return {};
}

/**
 * F2 SSE 专用：一次性取得鉴权头与 baseUrl，供 SseConnection 在每次
 * （重）连接时重新获取（token 可能轮换）。EventSource 无法携带
 * X-Desktop-Token，因此 SSE 一律走 fetch 流（utils/sseStream.ts）。
 */
export async function getSseAuth(): Promise<{
  headers: Record<string, string>;
  baseUrl: string;
}> {
  const [headers, baseUrl] = await Promise.all([getApiHeaders(), getBaseUrl()]);
  return { headers, baseUrl };
}

/**
 * Get base URL for API requests
 */
async function getBaseUrl(): Promise<string> {
  if (typeof window !== 'undefined' && window.desktop) {
    try {
      const serverStatus = await window.desktop.getServerStatus();
      if (serverStatus.running && serverStatus.port) {
        return `http://127.0.0.1:${serverStatus.port}`;
      }
    } catch (error) {
      console.error('Failed to get server status:', error);
    }
  }

  // Development fallback: use Vite proxy
  return '';
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * Make an authenticated API request
 */
async function request<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { timeoutMs, signal: userSignal, ...fetchOptions } = options;
  const headers = await getApiHeaders();
  const baseUrl = await getBaseUrl();
  const url = `${baseUrl}${endpoint}`;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal | undefined = userSignal ?? undefined;

  if (timeoutMs && timeoutMs > 0) {
    const controller = new AbortController();
    if (userSignal) {
      if (userSignal.aborted) {
        controller.abort(userSignal.reason);
      } else {
        userSignal.addEventListener('abort', () => controller.abort(userSignal.reason), { once: true });
      }
    }
    timeoutId = setTimeout(() => {
      controller.abort(new DOMException(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`, 'TimeoutError'));
    }, timeoutMs);
    signal = controller.signal;
  }

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...fetchOptions.headers,
      },
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      let errorData: unknown;
      try {
        errorData = await response.json();
        const data = errorData as { message?: unknown; error?: unknown } | null;
        // 结构化错误码供程序判断；message 才是用户需要的失败原因。
        const message = typeof data?.message === 'string' ? data.message.trim() : '';
        const code = typeof data?.error === 'string' ? data.error.trim() : '';
        errorMessage = message || code || errorMessage;
      } catch {
        // Ignore JSON parse errors
      }
      throw new APIError(errorMessage, response.status, errorData);
    }

    return await response.json();
  } catch (err: any) {
    if (
      err?.name === 'TimeoutError' ||
      (err instanceof DOMException && err.name === 'TimeoutError') ||
      (signal?.aborted && !userSignal?.aborted)
    ) {
      const msg = err?.message || '请求超时';
      throw new APIError(msg.includes('超时') ? msg : '请求超时，请检查网络或服务状态');
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Health check
 */
export async function getHealth(): Promise<ServerHealth> {
  return request<ServerHealth>('/api/health');
}

/**
 * Get configuration
 */
export async function getConfig(): Promise<Config> {
  return request<Config>('/api/config');
}

/**
 * Save configuration.
 *
 * Server (server/src/routes/config.ts PUT /api/config) wraps the updated
 * config in `{ success: true, config: <Config> }`. Earlier callers assumed
 * the response was the bare `Config`, which caused useConfig to store the
 * wrapper as config — subsequent renders then read `config.watchedRootUrls`
 * as undefined and KnowledgeSettingsCard crashed inside the ErrorBoundary,
 * hiding the entire settings area. This helper unwraps both shapes so the
 * UI is robust to either response style.
 *
 * The server sanitizes `llm.apiKey` to `'***'` on GET (see GET
 * /api/config). `saveConfig` drops that legacy mask from the outbound
 * payload; provider-profile masks are retained and matched by profile id on
 * the server so a profile edit never needs to expose its plaintext key.
 */
export type ConfigUpdate = Omit<Partial<Config>, 'llm'> & {
  /** LLM settings are independently owned by Settings sub-cards. */
  llm?: Partial<Config['llm']>;
};

export async function saveConfig(config: ConfigUpdate): Promise<Config> {
  const outbound = sanitizeOutboundConfig(config);
  const data = await request<unknown>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(outbound),
  });
  return unwrapConfigResponse(data);
}

/**
 * Explicit, user-initiated reveal for one saved provider credential.
 * Normal configuration reads remain redacted; callers must never invoke
 * this in a background refresh or log the returned value.
 */
export async function revealProviderApiKey(providerId: string): Promise<string> {
  const data = await request<{ apiKey?: unknown }>('/api/config/reveal-provider-key', {
    method: 'POST',
    body: JSON.stringify({ providerId }),
  });
  if (typeof data.apiKey !== 'string') {
    throw new Error('服务器未返回可显示的 API Key');
  }
  return data.apiKey;
}

/**
 * Internal: shape of the outbound body. `llm` may be partial because we
 * strip the masked `apiKey` before sending (see sanitizeOutboundConfig).
 * The server merges with `{...currentConfig, ...partialConfig}` so any
 * missing field is retained.
 */
type OutboundConfigBody = Omit<Partial<Config>, 'llm'> & {
  llm?: Partial<NonNullable<Config['llm']>>;
};

/**
 * Unwrap either `{success, config}` (current server shape) or a bare Config.
 * Returns the input untouched if it does not look like the wrapper shape so
 * the type stays honest at the call site.
 */
function unwrapConfigResponse(data: unknown): Config {
  if (data && typeof data === 'object') {
    const maybe = data as { success?: unknown; config?: Config };
    if (maybe && typeof maybe.success === 'boolean' && maybe.config) {
      return maybe.config;
    }
  }
  return data as Config;
}

/**
 * Drop the legacy flat field the server has masked so we never persist its
 * sentinel over the real value. Provider-profile keys intentionally remain
 * in the payload as `***`: ConfigManager merges each profile by id and keeps
 * the corresponding stored secret, allowing Settings to save provider/model
 * edits without ever receiving a plaintext key from GET /api/config.
 */
function sanitizeOutboundConfig(config: ConfigUpdate): OutboundConfigBody {
  if (!config.llm) return config;
  const llm = { ...config.llm };
  // If the apiKey field still holds the server's mask sentinel, drop only
  // that one field so the backend keeps its stored value. Other llm fields
  // (baseUrl/model/temperature/...) stay intact.
  if (typeof llm.apiKey === 'string' && llm.apiKey.trim() === '***') {
    const { apiKey: _drop, ...rest } = llm;
    return { ...config, llm: rest };
  }
  return { ...config, llm };
}

/**
 * Get Feishu authentication status
 */
export async function getAuthStatus(): Promise<AuthStatus> {
  return request<AuthStatus>('/api/feishu/auth-status');
}

// ============================================================================
// Lark-cli Onboarding API（新用户引导：安装/更新/设备授权）
// ============================================================================

/** GET /api/feishu/lark-cli/status —— 安装/认证/npm 组合状态。 */
export interface LarkCliToolStatus {
  larkCliInstalled: boolean;
  larkCliVersion?: string;
  /** registry 最新版（npm view，查询失败时缺省）。 */
  latestLarkCliVersion?: string;
  authReady: boolean;
  missingScopes?: string[];
  error?: string;
  npmAvailable: boolean;
  npmPath: string | null;
}

/** POST /api/feishu/lark-cli/install —— 幂等安装/更新结果。 */
export interface LarkCliInstallResult {
  ok: boolean;
  reason?: 'npm_not_found' | 'npm_failed' | 'verify_failed' | string;
  output: string;
  version?: string;
  error?: string;
}

/** POST /api/feishu/auth/device/start —— 立即返回的设备授权会话。 */
export interface DeviceAuthStartResult {
  verificationUrl: string;
  deviceCode: string;
  /** 秒；lark-cli 契约默认 600。 */
  expiresIn: number;
  /** 本次请求的 scope 集（2026-10 起服务端返回；旧版本无此字段）。 */
  requestedScopes?: string[];
  /** S12：read=同步读权限；write=额外并入 docx:document:write_only。 */
  scopeSet?: 'read' | 'write';
  mode: DeviceAuthMode;
  previousAccount?: AuthStatus['account'];
}

export type DeviceAuthMode = 'reauthorize' | 'switch_account';

/** POST /api/feishu/auth/device/complete —— 阻塞等待授权后的最终状态。 */
export interface DeviceAuthCompleteResult {
  ok: boolean;
  ready: boolean;
  larkCliVersion?: string;
  currentScopes?: string[];
  missingScopes?: string[];
  identity?: string;
  error?: string;
  account?: AuthStatus['account'];
  verified?: boolean;
}

/** POST /api/feishu/lark-cli/config-init/start —— 立即返回的初始化配置会话。 */
export interface ConfigInitStartResult {
  /** 浏览器完成 lark-cli 应用初始化的验证 URL（进程在服务端后台等待）。 */
  verificationUrl: string;
}

/** POST /api/feishu/lark-cli/config-init/complete —— 阻塞等待初始化结果。 */
export interface ConfigInitCompleteResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export async function getLarkCliStatus(): Promise<LarkCliToolStatus> {
  return request<LarkCliToolStatus>('/api/feishu/lark-cli/status');
}

export async function installLarkCli(): Promise<LarkCliInstallResult> {
  return request<LarkCliInstallResult>('/api/feishu/lark-cli/install', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function startDeviceAuth(
  mode: DeviceAuthMode = 'reauthorize',
  options: { scopeSet?: 'read' | 'write'; includeOptionalScopes?: boolean } = {},
): Promise<DeviceAuthStartResult> {
  return request<DeviceAuthStartResult>('/api/feishu/auth/device/start', {
    method: 'POST',
    body: JSON.stringify({
      mode,
      ...(options.scopeSet ? { scopeSet: options.scopeSet } : options.includeOptionalScopes ? {} : { scopeSet: 'read' }),
      ...(options.includeOptionalScopes ? { includeOptionalScopes: true } : {}),
    }),
  });
}

export async function cancelDeviceAuthRemote(deviceCode: string): Promise<{ cancelled: boolean }> {
  return request('/api/feishu/auth/device/cancel', {
    method: 'POST', body: JSON.stringify({ deviceCode }),
  });
}

/**
 * 阻塞等待浏览器授权完成（服务端最长约 11 分钟）。signal 用于前端取消
 * 等待；默认不设短超时，由调用方控制 AbortController（12 分钟）。 */
export async function completeDeviceAuth(
  deviceCode: string,
  options: { signal?: AbortSignal } = {},
): Promise<DeviceAuthCompleteResult> {
  return request<DeviceAuthCompleteResult>('/api/feishu/auth/device/complete', {
    method: 'POST',
    body: JSON.stringify({ deviceCode }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** 发起 lark-cli 初始化配置（安装后 not_configured 态的应用内闭环步骤）。 */
export async function startConfigInit(): Promise<ConfigInitStartResult> {
  return request<ConfigInitStartResult>('/api/feishu/lark-cli/config-init/start', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** 阻塞等待浏览器完成初始化配置（服务端最长约 12 分钟；signal 用于取消）。 */
export async function completeConfigInit(
  options: { signal?: AbortSignal } = {},
): Promise<ConfigInitCompleteResult> {
  return request<ConfigInitCompleteResult>('/api/feishu/lark-cli/config-init/complete', {
    method: 'POST',
    body: JSON.stringify({}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** 取消进行中的初始化配置（服务端 kill 子进程 + 回收，幂等；容错静默）。 */
export async function cancelConfigInitRemote(): Promise<void> {
  try {
    await request<{ cancelled: boolean }>('/api/feishu/lark-cli/config-init/cancel', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch {
    // 服务端已自行回收/重启属正常时序，取消失败不影响前端复位。
  }
}

/**
 * Detect changes in watched URLs
 */
export type DetectionMode = 'fast' | 'full';

export interface DetectChangesOptions {
  mode?: DetectionMode;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * `fast` is the normal metadata-only check. `full` is intentionally opt-in
 * and used only by the structural-repair action, where parent hierarchy must
 * be reconciled before a new local path can be planned safely.
 */
export async function detectChanges(
  rootUrl: string,
  options: DetectChangesOptions = {},
): Promise<ChangeDetectionResult> {
  const { timeoutMs = 300_000, signal, mode } = options;
  const result = await request<ChangeDetectionResult>('/api/detect/changes', {
    method: 'POST',
    body: JSON.stringify({ rootUrl, ...(mode ? { mode } : {}) }),
    timeoutMs,
    signal,
  });
  // 检测会推进 observed 基线并重写持久化 diff：广播事件让所有持有
  // diff 快照的视图（状态栏计数/变更列表/最近变更）重拉 cached diff。
  emitDiffChanged('detect');
  return result;
}

/**
 * Multi-root detect result envelope returned by POST /api/detect/changes-all.
 *
 * Mirrors the server-side `MultiRootDetectionResult` interface declared in
 * server/src/routes/detect.ts. Kept here (not in types/index.ts) because the
 * shape is an HTTP response contract, not a domain model — matching the
 * existing detect.ts style.
 */
export interface MultiRootDetectionResult {
  changed: boolean;
  totalNodes: number;
  changedDocuments: ChangedDocument[];
  checkedAt: string;
  results: Array<{
    rootUrl: string;
    status: 'ok' | 'error';
    result?: ChangeDetectionResult;
    error?: string;
  }>;
}

/**
 * Detect changes across ALL configured watchedRootUrls.
 *
 * The backend iterates `config.watchedRootUrls` sequentially, aggregates
 * per-root results, and lets a single failed root degrade gracefully
 * (status='error' in `results[i]` without aborting the batch). This is the
 * correct detect entry point when the user has more than one watchedRoot,
 * which is the default in v0.2.0.
 */
export async function detectChangesAll(
  options: DetectChangesOptions = {},
): Promise<MultiRootDetectionResult> {
  const { timeoutMs = 300_000, signal, mode } = options;
  const result = await request<MultiRootDetectionResult>('/api/detect/changes-all', {
    method: 'POST',
    body: JSON.stringify(mode ? { mode } : {}),
    timeoutMs,
    signal,
  });
  emitDiffChanged('detect-all');
  return result;
}

/**
 * Synchronize explicitly selected documents to the local knowledge base.
 *
 * The server rejects writes unless both `apply` and the literal confirmation
 * are present. This client is only called after the Sync view has shown the
 * user a write confirmation, while the server still plans and blocks unsafe
 * paths (for example, an existing local file with no cloud mapping).
 */
/** GET /api/config/knowledge-root-suggestion —— 缺省知识库根目录建议（只算不建）。 */
export async function getKnowledgeRootSuggestion(): Promise<string> {
  const data = await request<{ root: string }>('/api/config/knowledge-root-suggestion');
  return data.root;
}

/**
 * POST /api/config/knowledge-root-suggestion/adopt —— 采用缺省路径：
 * 建目录 + 保存配置 → { root }。失败抛 APIError（message 已带可读原因）。
 */
export async function adoptKnowledgeRootSuggestion(): Promise<string> {
  const data = await request<{ root: string }>(
    '/api/config/knowledge-root-suggestion/adopt',
    { method: 'POST', body: JSON.stringify({}) },
  );
  return data.root;
}

export async function syncDocs(
  documents: ChangedDocument[],
  options: { enableLLM?: boolean; adoptExistingProfileTargets?: boolean; deferSnapshot?: boolean } = {},
): Promise<SyncResult> {
  const result = await request<SyncResult>('/api/sync', {
    method: 'POST',
    body: JSON.stringify({
      documents,
      options: {
        enableLLM: options.enableLLM === true,
        adoptExistingProfileTargets: options.adoptExistingProfileTargets === true,
        deferSnapshot: options.deferSnapshot === true,
        fullSync: false,
        apply: true,
        confirmation: 'APPLY',
      },
    }),
  });
  // 同步成功推进 synced 基线，已同步项会从 diff 中消失：广播事件让
  // 总览待同步计数/最近变更/变更列表等所有视图同步刷新（修复同步
  // 完成后总览计数不更新的问题）。dry-run 结果也会走这里，重拉 cached
  // diff 无副作用。
  emitDiffChanged('sync');
  return result;
}

export async function flushSyncSnapshot(): Promise<void> {
  await request('/api/sync/snapshot', { method: 'POST' });
  emitDiffChanged('sync-batch-completed');
}

export async function refreshSheet(objToken: string): Promise<SyncResult> {
  const result = await request<SyncResult>('/api/sync/refresh-sheet', { method: 'POST', body: JSON.stringify({ objToken }) });
  emitDiffChanged('sheet-refresh');
  return result;
}

export async function updateAgentRuntime(backend: 'pi' | 'claude-code'): Promise<void> {
  await request('/api/agent/runtime/update', { method: 'POST', body: JSON.stringify({ backend }) });
}

export function testClaudeConnection(): Promise<ClaudeConnectionTestResult> {
  return request('/api/agent/claude/connection-test', { method: 'POST', body: '{}', timeoutMs: 90_000 });
}

/** Read durable issues that must be repaired in Feishu before syncing can continue. */
export async function listFeishuPending(): Promise<FeishuPendingItem[]> {
  const data = await request<{ items?: FeishuPendingItem[] } | FeishuPendingItem[]>('/api/sync/feishu-pending');
  return Array.isArray(data) ? data : (data.items ?? []);
}

/**
 * Permit one recovery scan after the user has repaired sharing/deletion/type
 * state in Feishu. This is local bookkeeping only; it never changes Feishu.
 */
export async function requestFeishuPendingRecheck(
  watchedRootIds?: string[],
): Promise<{ requested: number }> {
  return request<{ requested: number }>('/api/sync/feishu-pending/recheck', {
    method: 'POST',
    body: JSON.stringify(watchedRootIds ? { watchedRootIds } : {}),
  });
}

/**
 * Sync index - scan local knowledge base and build initial index
 */
export async function syncIndex(options?: {
  rootDir?: string;
}): Promise<{
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
  errors?: string[];
}> {
  return request('/api/sync/index', {
    method: 'POST',
    body: JSON.stringify(options || {}),
  });
}

// ============================================================================
// Mapping API (v0.2.0 P2-T5/T6/T7/T10, consumed by P4 frontend)
// ============================================================================

/**
 * GET /api/mapping/tree — flat MappingNode[] for client-side tree rebuild.
 */
export async function getMappingTree(): Promise<MappingNode[]> {
  const data = await request<{ nodes: MappingNode[] }>('/api/mapping/tree');
  return data.nodes ?? [];
}

/**
 * GET /api/mapping/tree?view=feishu|local — full TreeResponse envelope
 * (v0.2.0 structure-align Phase B). Returns nodes + watched_roots +
 * orphan_files + stats in one round-trip so the frontend has everything
 * it needs to render a grouped cloud tree or a local directory tree.
 *
 * Legacy callers that omit `view` should keep using getMappingTree(); the
 * server returns the bare `{ nodes }` shape for backward compat.
 */
export async function getMappingTreeDetailed(
  view: 'feishu' | 'local',
  options: { includeOrphans?: boolean } = {},
): Promise<TreeResponse> {
  const qs = new URLSearchParams({ view });
  if (options.includeOrphans === false) qs.set('include_orphans', 'false');
  return request<TreeResponse>(`/api/mapping/tree?${qs.toString()}`);
}

/**
 * GET /api/mapping/content/:objToken — 本地文档内容（v0.2.8 预览面板）。
 * 返回 Markdown 全文 + sheet 伴随 CSV 表格列表；文件缺失时 mdContent 为 null。
 */
export async function getDocumentContent(objToken: string): Promise<DocumentContent> {
  return request<DocumentContent>(
    `/api/mapping/content/${encodeURIComponent(objToken)}`,
  );
}

/** Read a referenced Feishu block on demand; the source file stays unchanged. */
export function getSyncedReference(token: string, block: string): Promise<{ content: string; baseDir?: string }> {
  const query = new URLSearchParams({ token, block });
  return request<{ content: string }>(`/api/mapping/synced-reference?${query}`);
}

/**
 * GET /api/mapping/comments/:objToken — 文档评论（P2-S4 评论溯源）。
 * collected=false 表示从未采集（非 docx 或未成功同步过）。
 */
export async function getDocumentComments(objToken: string): Promise<DocumentComments> {
  return request<DocumentComments>(
    `/api/mapping/comments/${encodeURIComponent(objToken)}`,
  );
}

export async function getWorkbookPreview(objToken: string, sheet: number, signal?: AbortSignal): Promise<WorkbookPreview> {
  return request<WorkbookPreview>(`/api/mapping/workbook/${encodeURIComponent(objToken)}?sheet=${sheet}`, {
    signal, timeoutMs: 60_000,
  });
}

/** Authenticated download of the byte-for-byte archived workbook. */
export async function getWorkbookBlob(objToken: string): Promise<Blob> {
  const headers = await getApiHeaders();
  const baseUrl = await getBaseUrl();
  const response = await fetch(`${baseUrl}/api/mapping/workbook/${encodeURIComponent(objToken)}/file`, { headers });
  if (!response.ok) throw new APIError(`Excel 原件下载失败 (${response.status})`, response.status);
  return response.blob();
}

/**
 * GET /api/mapping/media?path=... — 图片二进制（v0.2.9 预览图片支持）。
 * <img> 标签无法携带 X-Desktop-Token，因此走 fetch → blob → objectURL；
 * 调用方负责在组件卸载时 URL.revokeObjectURL()。
 */
export async function getMediaBlobUrl(relPath: string): Promise<string> {
  const headers = await getApiHeaders();
  const baseUrl = await getBaseUrl();
  const qs = new URLSearchParams({ path: relPath });
  const response = await fetch(`${baseUrl}/api/mapping/media?${qs.toString()}`, {
    headers: { ...headers },
  });
  if (!response.ok) {
    throw new APIError(`media ${response.status}`, response.status);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

/**
 * GET /api/mapping/diff — DiffReport grouped by added/modified/deleted.
 */
export async function getMappingDiff(rootUrl: string): Promise<DiffReport> {
  const qs = new URLSearchParams({ rootUrl });
  const report = await request<DiffReport>(`/api/mapping/diff?${qs.toString()}`);
  // 无 cached 参数的调用会在服务端触发一次云检测并推进持久化 diff。
  emitDiffChanged('mapping-diff');
  return report;
}

/**
 * Read the most recently persisted change state without triggering cloud
 * detection. Dashboard/status/list views use this so mounting UI components
 * cannot fan out into Feishu requests; explicit detect actions own refresh.
 */
export async function getStoredMappingDiff(rootUrl: string): Promise<DiffReport> {
  const qs = new URLSearchParams({ rootUrl, cached: '1' });
  return request<DiffReport>(`/api/mapping/diff?${qs.toString()}`);
}

/**
 * GET /api/mapping/index — current _index.json snapshot (no regen).
 * Returns 404 if the snapshot has not been generated yet; caller handles.
 */
export async function getMappingIndex(): Promise<IndexSnapshot | null> {
  try {
    return await request<IndexSnapshot>('/api/mapping/index');
  } catch (err) {
    // 404 → snapshot not generated yet; surface as null (not an error).
    if (err instanceof APIError && err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * POST /api/mapping/refresh-index — force-regenerate _index.json.
 */
export async function refreshMappingIndex(): Promise<{
  generated_at: string;
  node_count: number;
  orphan_count: number;
  top_level_dirs: Array<{ dir: string; node_count: number }>;
}> {
  return request('/api/mapping/refresh-index', { method: 'POST' });
}

/**
 * POST /api/index/rebuild — rescan the local knowledge base and rebuild the
 * documents table (fixes P0-bug-2: refresh-index only regenerated the
 * snapshot from the existing DB rows; this endpoint actually re-runs
 * IndexScanner.scanAllFiles to repopulate titles/status for every .md).
 *
 * Contract with backend (鲁班 implements in parallel):
 *   request:  {}
 *   response: {
 *     rebuilt: number,            // count of documents upserted by the scan
 *     refreshed_index: boolean,   // whether _index.json was regenerated
 *     failed: Array<{ path: string; error: string }>
 *   }
 *
 * NOTE: endpoint is implemented server-side in parallel by 鲁班 in the same
 * Phase. If the endpoint is missing the call surfaces an APIError (404) and
 * the caller shows a Toast — no silent failure.
 */
export interface RebuildIndexFailure {
  path: string;
  error: string;
}

export interface RebuildIndexResponse {
  rebuilt: number;
  refreshed_index: boolean;
  failed: RebuildIndexFailure[];
  /** 手动删除清理：本地文件已不存在而被硬删的 documents 行数。 */
  pruned_local_missing?: number;
}

export async function rebuildIndex(): Promise<RebuildIndexResponse> {
  const result = await request<RebuildIndexResponse>('/api/index/rebuild', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  // 重建会重扫本地知识库并翻转 placeholder/synced 等状态，diff 可能变化。
  emitDiffChanged('rebuild-index');
  return result;
}

/**
 * POST /api/mapping/reorder — local-only drag reorder (decision 5).
 * Backend rejects cross-parent reorders with 400.
 */
export async function reorderMapping(
  body: ReorderRequest,
): Promise<ReorderResponse> {
  return request<ReorderResponse>('/api/mapping/reorder', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ============================================================================
// Trash / Soft-Delete API (T10, decision 2)
// ============================================================================
//
// NOTE: backend routes (GET /api/trash, POST /api/trash/restore,
// DELETE /api/trash/purge) are NOT implemented as of HEAD 43121ef. The
// client functions below target the intended contract; a 404 from the
// server surfaces to the caller as an APIError, which the UI handles by
// showing the empty state + a Toast hint that the endpoint is missing.

/**
 * GET /api/trash — list soft-deleted documents (cloud_deleted=1).
 * Returns 404 if the backend has not implemented trash routes yet; caller
 * handles by surfacing the empty drawer state.
 */
export async function listTrashedDocs(): Promise<TrashedDoc[]> {
  try {
    const data = await request<{ items: TrashedDoc[] } | TrashedDoc[]>('/api/trash');
    return Array.isArray(data) ? data : (data.items ?? []);
  } catch (err) {
    if (err instanceof APIError && (err.statusCode === 404 || err.statusCode === 405)) return [];
    throw err;
  }
}

/**
 * POST /api/trash/restore — restore a soft-deleted document (clears
 * cloud_deleted flag and moves the file back to its original path).
 */
export async function restoreTrashedDoc(objToken: string): Promise<{ ok: true }> {
  const result = await request<{ ok: true }>('/api/trash/restore', {
    method: 'POST',
    body: JSON.stringify({ obj_token: objToken }),
  });
  emitDiffChanged('trash-restore');
  return result;
}

/**
 * DELETE /api/trash/purge — permanently delete a soft-deleted document
 * (fs.unlink the local .md copy). Pass { all: true } to clear all trashed.
 */
export async function purgeTrashedDoc(objToken: string): Promise<{ purged: number }> {
  const result = await request<{ purged: number }>(`/api/trash/purge?obj_token=${encodeURIComponent(objToken)}`, {
    method: 'DELETE',
  });
  emitDiffChanged('trash-purge');
  return result;
}

export async function clearTrash(): Promise<{ purged: number }> {
  const result = await request<{ purged: number }>('/api/trash/purge?all=1', { method: 'DELETE' });
  emitDiffChanged('trash-purge-all');
  return result;
}

/**
 * POST /api/trash/manual-delete — 手动删除任意活行节点（2026-09）：
 * 可选回收本地文件与屏蔽。有效父链下保留待同步身份；其他行清理索引。
 * 回收站行（cloud_deleted=1）会409，需走原回收站面板。
 */
export async function manualDeleteDoc(objToken: string, options: { deleteFiles?: boolean; block?: boolean } = {}): Promise<{
  ok: boolean; file_moved_to_trash: boolean; already_gone?: boolean; pending_sync?: boolean; blocked?: boolean; trash_dir?: string;
}> {
  const result = await request<{ ok: boolean; file_moved_to_trash: boolean; already_gone?: boolean; pending_sync?: boolean; blocked?: boolean; trash_dir?: string }>('/api/trash/manual-delete', {
    method: 'POST', body: JSON.stringify({ obj_token: objToken, delete_local_files: options.deleteFiles !== false, block: options.block === true }),
  });
  emitDiffChanged('manual-delete'); return result;
}
export function getSyncBlocklist() { return request<{ root: string; items: Array<{ objToken: string; title: string; wikiNodeToken: string | null; blockedAt: string }> }>('/api/sync/blocklist'); }
export async function removeSyncBlocklist(root: string, tokens: string[]) {
  const result = await request<{ removed: number }>('/api/sync/blocklist/remove', { method: 'POST', body: JSON.stringify({ root, tokens }) });
  emitDiffChanged('sync-blocklist'); return result;
}

/**
 * POST /api/trash/bulk-process 批量处理结果（2026-09 变更列表修复）。
 * failed 内 reason 常见值：not_deletion_candidate（活行非删除候选，拒删）、
 * purge_failed（DB/IO 删除失败，详见服务端日志）、purge_noop_row_kept
 * （行未被删除而残留，异常数据防御）。
 * warnings：非阻断性缺陷，如 file_move_failed（软删成功但本地文件移入
 * .trash-bin 失败；行已在回收站，可在回收站面板继续处理）。
 */
export interface BulkProcessDeletedResult {
  requested: number;
  trashed: number;
  purged: number;
  already_trashed: number;
  gone: number;
  failed: Array<{ obj_token: string; reason: string }>;
  warnings: Array<{ obj_token: string; reason: string }>;
}

/**
 * POST /api/trash/bulk-process — 批量处理变更列表删除候选（missing_candidate）：
 *   - action='trash'：软删进回收站（cloud_deleted=1）+ 本地 .md 移入
 *     .trash-bin/（可在回收站面板恢复/清理）；
 *   - action='purge'：硬删（unlink 本地文件 + 删映射行），不可恢复。
 * 服务端仅接受删除候选状态，活文档（synced/pending_*）会被拒（failed）。
 */
export async function bulkProcessDeletedDocs(
  objTokens: string[],
  action: 'trash' | 'purge',
): Promise<BulkProcessDeletedResult> {
  const result = await request<BulkProcessDeletedResult>('/api/trash/bulk-process', {
    method: 'POST',
    body: JSON.stringify({ obj_tokens: objTokens, action, confirmation: 'DELETE' }),
  });
  emitDiffChanged(`trash-bulk-${action}`);
  return result;
}

// ============================================================================
// Channel Connectivity Test (T7, decision 3 real bigmodel call)
// ============================================================================

/**
 * POST /api/llm/test-channel — real connectivity test against the direct
 * channel (OpenAI-compatible endpoint). Server sends a tiny hello prompt
 * and returns the result without surfacing the stack to the UI (full
 * detail lives in server logs).
 *
 * NOTE: this endpoint is part of the P4-2 contract; if 鲁班 has not added it
 * yet, callers will receive an APIError (404) and should surface a Toast.
 */
export async function testLlmChannel(body: ChannelTestRequest): Promise<ChannelTestResult> {
  return request<ChannelTestResult>('/api/llm/test-channel', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ============================================================================
// Custom Folders API (快捷添加云链接 + 自定义文件夹归档)
// ============================================================================
//
// 契约见 src/types/index.ts 的 Custom Folder 区块注释。字段名（camelCase）
// 前后端共同遵守，勿改。写失败语义：400 invalid_name / 409 duplicate_name /
// 逐条 error.code 分类均由调用方转为用户可读文案。

/** GET /api/custom-folders — 列出全部自定义归档文件夹（含各自文档）。 */
export async function listCustomFolders(): Promise<CustomFolder[]> {
  const data = await request<{ folders: CustomFolder[] }>('/api/custom-folders');
  return data.folders ?? [];
}

/**
 * POST /api/custom-folders — 新建文件夹。
 * 400 invalid_name（空 / 超长 / 含非法字符）；409 duplicate_name（同名）。
 */
export async function createCustomFolder(name: string): Promise<CustomFolder> {
  const data = await request<{ folder: CustomFolder }>('/api/custom-folders', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return data.folder;
}

/** PATCH /api/custom-folders/:id — 仅改 name 标签，localRelPath 不变，不做文件移动。 */
export async function renameCustomFolder(id: string, name: string): Promise<CustomFolder> {
  const data = await request<{ folder: CustomFolder }>(
    `/api/custom-folders/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify({ name }) },
  );
  return data.folder;
}

/** DELETE /api/custom-folders/:id — 文件夹下文档置空归档归属，本地文件保留。 */
export async function deleteCustomFolder(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/custom-folders/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * POST /api/custom-folders/:id/docs — 批量添加云链接（≤20 条/次，调用方负责前端校验）。
 * 返回逐条结果；error.code ∈ parse_failed | already_exists | unsupported_type |
 * fetch_failed | permission_denied，already_exists 附已有归属。
 */
export async function addLinksToFolder(
  folderId: string,
  links: string[],
): Promise<AddLinkToFolderResult[]> {
  const data = await request<{ results: AddLinkToFolderResult[] }>(
    `/api/custom-folders/${encodeURIComponent(folderId)}/docs`,
    { method: 'POST', body: JSON.stringify({ links }) },
  );
  // 归档文档脱离结构树（watched_root 清空），结构树 diff 成员随之变化。
  emitDiffChanged('custom-folder-add');
  return data.results ?? [];
}

/**
 * DELETE /api/custom-folders/:id/docs/:objToken — 把单篇文档移出归档
 * （custom_folder_id 置空，本地文件与同步基线保留）。404：文件夹不存在或文档不在其中。
 */
export async function removeDocFromFolder(
  folderId: string,
  objToken: string,
): Promise<{ ok: true }> {
  const result = await request<{ ok: true }>(
    `/api/custom-folders/${encodeURIComponent(folderId)}/docs/${encodeURIComponent(objToken)}`,
    { method: 'DELETE' },
  );
  emitDiffChanged('custom-folder-remove');
  return result;
}

export { APIError };

/**
 * GET /api/orphan-files — 孤立本地文件 dry-run 扫描（2026-09-04）。
 * 列出知识库根目录下与任何 watchedRoot/custom_folder 无对应关系、
 * 且被证实为同步产物（feishu_sync 头）的目录/散档。
 */
export interface OrphanFileItem {
  relPath: string;
  type: 'dir' | 'file';
  evidence: string | null;
}

export async function scanOrphanFiles(): Promise<{ rootDir: string; items: OrphanFileItem[] }> {
  return request<{ rootDir: string; items: OrphanFileItem[] }>('/api/orphan-files');
}

/**
 * POST /api/orphan-files/cleanup — 清理孤立项到 <root>/.trash-bin/orphan-<ts>/
 * （可恢复移动，非删除）。confirmation !== 'APPLY' 时服务端 dry-run 只回显。
 */
export async function cleanupOrphanFiles(
  items: OrphanFileItem[],
  confirmation: 'APPLY' | 'DRY_RUN' = 'APPLY',
): Promise<{
  success: boolean;
  dryRun: boolean;
  trashDir: string;
  moved: Array<{ relPath: string }>;
  failed: Array<{ relPath: string; error: string }>;
  scannedTotal: number;
}> {
  return request('/api/orphan-files/cleanup', {
    method: 'POST',
    body: JSON.stringify({ items, confirmation }),
  });
}

// ============================================================================
// Agent 标准知识库 / 会话 API（F2，契约 docs/design/agent-knowledge-design.md §9）
// ============================================================================
//
// 与 F1 后端并行开发：本节函数按公共契约实现；服务端未就绪时调用方会收到
// APIError（404 等）并按各视图的不可达/错误状态呈现，不做假成功。
// 秘密约束（§13-5）：任何 DTO 不含 apiKey / 运行令牌 / desktop token。

/** GET /api/agent/status —— pi 运行时与模型就绪诊断（§9.1）。 */
export async function getAgentStatus(): Promise<AgentStatusDto> {
  return request<AgentStatusDto>('/api/agent/status', { timeoutMs: 30_000 });
}

/** POST /api/agent/status/recheck —— 重新发现与探测（不消耗模型额度）。 */
export async function recheckAgentStatus(): Promise<AgentStatusDto> {
  return request<AgentStatusDto>('/api/agent/status/recheck', {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: 60_000,
  });
}

/** GET /api/agent/vision/status —— 图片理解通道状态（S2 §四；无秘密字段）。 */
export async function getAgentVisionStatus(): Promise<AgentVisionStatusDto> {
  return request<AgentVisionStatusDto>('/api/agent/vision/status');
}

/**
 * POST /api/agent/vision/test —— 用内置测试图实测识图模型（真实远端调用，
 * 仅由用户显式点击触发）。传 providerId/modelId 显式覆盖时允许在启用前
 * 试测候选模型；失败也回 200（ok=false 携带脱敏 error），400/500 抛 APIError。
 * 客户端超时留足 vision.timeoutMs（上限 600s）余量，以服务端判定为准。
 */
export async function testAgentVision(
  body: { providerId?: string; modelId?: string } = {},
): Promise<AgentVisionTestResult> {
  return request<AgentVisionTestResult>('/api/agent/vision/test', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 620_000,
  });
}

/** GET /api/kb/status —— 发布状态 + 待处理变更 + 活跃构建（§9.2）。 */
export async function getKbStatus(): Promise<KbStatusDto> {
  return request<KbStatusDto>('/api/kb/status');
}

/** GET /api/kb/tree —— 发布目录树；未发布抛 APIError(404 kb_not_published)。 */
export async function getKbTree(): Promise<{ releaseId: string; nodes: KbTreeNode[] }> {
  return request<{ releaseId: string; nodes: KbTreeNode[] }>('/api/kb/tree');
}

/** GET /api/kb/docs/:docId —— 标准文档正文 + 来源状态（§9.2）。 */
export async function getKbDoc(docId: string): Promise<KbDocDto> {
  return request<KbDocDto>(`/api/kb/docs/${encodeURIComponent(docId)}`);
}

/** GET /api/kb/search?q= —— 标题/正文子串检索（q 1..200 字符）。 */
export async function searchKb(
  q: string,
  limit = 20,
): Promise<{ releaseId: string; results: KbSearchResult[] }> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  return request(`/api/kb/search?${qs.toString()}`);
}

/** POST /api/kb/builds —— 触发构建（需 confirm:'BUILD'；§6.6 手动触发）。 */
export async function createKbBuild(
  mode: 'incremental' | 'full',
  options?: { refreshImages?: boolean },
): Promise<KbBuildDto> {
  return request<KbBuildDto>('/api/kb/builds', {
    method: 'POST',
    body: JSON.stringify({ mode, confirm: 'BUILD', ...options }),
  });
}

/** GET /api/kb/builds —— 构建历史（默认最近 20 条）。 */
export async function listKbBuilds(limit = 20): Promise<{ builds: KbBuildDto[] }> {
  return request<{ builds: KbBuildDto[] }>(`/api/kb/builds?limit=${limit}`);
}

/** GET /api/kb/builds/:id —— 单次构建 + 校验报告（含失败 issues）。 */
export async function getKbBuild(id: string): Promise<KbBuildDto & { report?: KbBuildReportDto }> {
  return request<KbBuildDto & { report?: KbBuildReportDto }>(
    `/api/kb/builds/${encodeURIComponent(id)}`,
  );
}

/** POST /api/kb/builds/:id/cancel —— 取消进行中的构建（幂等友好）。 */
export async function cancelKbBuild(id: string): Promise<KbBuildDto> {
  return request<KbBuildDto>(`/api/kb/builds/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** GET /api/kb/mcp —— 外部 MCP 连接信息（§9.5，供设置页复制）。 */
export async function getKbMcpInfo(): Promise<KbMcpInfoDto> {
  return request<KbMcpInfoDto>('/api/kb/mcp');
}

/** User-level MCP changes are immediate and require desktop authorization. */
export function getKbMcpInstallStatus(): Promise<{ targets: McpInstallStatus[] }> {
  return request('/api/kb-mcp-install/status', { cache: 'no-store' });
}
export function installKbMcp(target: McpClientTarget): Promise<McpInstallStatus> {
  return request('/api/kb-mcp-install/install', { method: 'POST', body: JSON.stringify({ target }) });
}
export function removeKbMcp(target: McpClientTarget): Promise<McpInstallStatus> {
  return request('/api/kb-mcp-install/remove', { method: 'POST', body: JSON.stringify({ target }) });
}

// ---------------------------------------------------------------------------
// 反向发布（P1-S9，设计 P1 §4.6；契约见 P1-S8 报告 §二）
// ---------------------------------------------------------------------------

export interface KbPublishPlanOptions {
  /** 缺省 = CURRENT 指向的 release（release 不可变，显式指定亦可）。 */
  releaseId?: string;
  /** 缺省 = 整个 release（全量模式，含 kb_removed 标记）。 */
  kbPaths?: string[];
  /** 解除 publish_cloud_edited 冲突（确认值升级为 OVERWRITE_PUBLISHED）。 */
  force?: boolean;
}

/** POST /api/kb/publish/preview —— 只读发布计划（动作/警告/门控/确认值派生）。 */
export async function previewKbPublish(options: KbPublishPlanOptions): Promise<KbPublishPlanDto> {
  return request<KbPublishPlanDto>('/api/kb/publish/preview', {
    method: 'POST',
    body: JSON.stringify({
      ...(options.releaseId !== undefined ? { releaseId: options.releaseId } : {}),
      ...(options.kbPaths !== undefined ? { kbPaths: options.kbPaths } : {}),
      ...(options.force !== undefined ? { force: options.force } : {}),
    }),
    // 计划含云端 metas 批量取数（≤200/批），大库给足余量。
    timeoutMs: 180_000,
  });
}

/** POST /api/kb/publish —— 执行发布（confirm 门 + planKey 复核）。 */
export async function executeKbPublish(
  options: KbPublishPlanOptions & { confirm: string; planKey?: string },
): Promise<KbPublishRunResultDto> {
  const { confirm, planKey, ...rest } = options;
  const body: Record<string, unknown> = { ...rest, confirm, actor: 'ui' };
  if (planKey !== undefined) body.planKey = planKey;
  // 服务端逐文档串行执行，可能持续数分钟：不设前端超时（由服务端控制节奏）。
  return request<KbPublishRunResultDto>('/api/kb/publish', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** GET /api/kb/publications —— 全部发布记录（kb_path 序）。 */
export function listKbPublications(): Promise<{ publications: KbPublicationRowDto[] }> {
  return request<{ publications: KbPublicationRowDto[] }>('/api/kb/publications');
}

/** GET /api/kb/publications/:kbPath —— 单条发布记录（路径含 `/`，整体编码）。 */
export function getKbPublication(kbPath: string): Promise<KbPublicationRowDto> {
  return request<KbPublicationRowDto>(`/api/kb/publications/${encodeURIComponent(kbPath)}`);
}

/** PUT /api/kb/publish/target —— 设置/清除发布根（仅 desktop token 链路）。 */
export function setKbPublishTarget(
  body: { url: string } | { kind: 'drive_folder' | 'wiki_node'; token: string; label?: string; spaceId?: string } | { target: null },
): Promise<{ target: PublishTargetDto | null; overlapChecked?: boolean }> {
  return request('/api/kb/publish/target', {
    method: 'PUT',
    body: JSON.stringify(body),
    // wiki 发布根走云端祖先链双向校验（深度 ≤50）。
    timeoutMs: 120_000,
  });
}

// ---------------------------------------------------------------------------
// 会话（§9.3）
// ---------------------------------------------------------------------------

/** GET /api/agent/sessions —— 按 updatedAt 倒序，不含已删除。 */
export async function listAgentSessions(): Promise<AgentSessionDto[]> {
  const data = await request<{ sessions: AgentSessionDto[] }>('/api/agent/sessions');
  return data.sessions ?? [];
}

/** POST /api/agent/sessions —— 新建只允许 discuss；Work 经模式切换进入。 */
export async function createAgentSession(title?: string, backend?: AgentBackend, workspaceId?: string): Promise<AgentSessionDto> {
  return request<AgentSessionDto>('/api/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ mode: 'discuss', ...(title ? { title } : {}), ...(backend ? { backend } : {}), ...(workspaceId ? { workspaceId } : {}) }),
  });
}

export async function getAgentSession(id: string): Promise<AgentSessionDto> {
  return request<AgentSessionDto>(`/api/agent/sessions/${encodeURIComponent(id)}`);
}

/** PATCH /api/agent/sessions/:id —— 重命名（title 1..80 字符）。 */
export async function renameAgentSession(id: string, title: string): Promise<AgentSessionDto> {
  return request<AgentSessionDto>(`/api/agent/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

/** DELETE /api/agent/sessions/:id —— 停进程 + JSONL 归档 + DB 软删。 */
export async function deleteAgentSession(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/agent/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** GET /api/agent/sessions/:id/messages —— 权威全量历史（resync 拉取用）。 */
export async function getAgentSessionMessages(id: string): Promise<AgentMessageDto[]> {
  const data = await request<{ messages: AgentMessageDto[] }>(
    `/api/agent/sessions/${encodeURIComponent(id)}/messages`,
  );
  return data.messages ?? [];
}

/**
 * POST /api/agent/sessions/:id/messages —— 发送消息。
 * 运行中再发需带 delivery:'steer'|'followUp'（否则 409 session_busy）。
 */
export async function sendAgentMessage(
  id: string,
  body: { text: string; delivery?: 'steer' | 'followUp' },
): Promise<{ accepted: true; runId: string }> {
  return request<{ accepted: true; runId: string }>(
    `/api/agent/sessions/${encodeURIComponent(id)}/messages`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/** POST /api/agent/sessions/:id/abort —— 停止当前运行。 */
export async function abortAgentSession(id: string): Promise<AgentSessionDto> {
  return request<AgentSessionDto>(`/api/agent/sessions/${encodeURIComponent(id)}/abort`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ---------------------------------------------------------------------------
// 会话内批准（S10，设计 kb-agent-upgrade §6.5）——app_command 的
// mutate/destructive/remote_write 级命令挂起等待用户裁决。
// ---------------------------------------------------------------------------

/** GET /api/agent/sessions/:id/approvals —— 当前待裁决的批准请求。 */
export async function listAgentApprovals(sessionId: string): Promise<AgentApprovalDto[]> {
  const data = await request<{ approvals: AgentApprovalDto[] }>(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/approvals`,
  );
  return data.approvals;
}

/** POST /api/agent/sessions/:id/approvals/:approvalId/decide —— 用户裁决。 */
export async function decideAgentApproval(
  sessionId: string,
  approvalId: string,
  decision: 'approve' | 'reject',
): Promise<{ id: string; decision: 'approve' | 'reject' }> {
  return request(`/api/agent/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}

// ---------------------------------------------------------------------------
// 任务编排（S7，设计 kb-agent-upgrade §5.4）——编排子任务的用户面板。
// 编排开关本身经既有插件上下文 API（PUT /api/agent/plugin-contexts/
// orchestration，expectedRevision 乐观锁）切换，不新增路由。
// ---------------------------------------------------------------------------

/** GET /api/agent/tasks?sessionId= —— 会话内任务（created_at 升序）。 */
export async function listAgentTasks(sessionId: string): Promise<AgentTaskDto[]> {
  const data = await request<{ tasks: AgentTaskDto[]}>(
    `/api/agent/tasks?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return data.tasks ?? [];
}

export async function getAgentTask(id: string): Promise<AgentTaskDto> {
  return request<AgentTaskDto>(`/api/agent/tasks/${encodeURIComponent(id)}`);
}

/** POST /api/agent/tasks/:id/cancel —— 取消非终态任务（终态 409 task_not_active）。 */
export async function cancelAgentTask(id: string): Promise<AgentTaskDto> {
  return request<AgentTaskDto>(`/api/agent/tasks/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** POST /api/agent/tasks/:id/resume —— 对 blocked 任务提交作答（→ queued）。 */
export async function resumeAgentTask(id: string, message: string): Promise<AgentTaskDto> {
  return request<AgentTaskDto>(`/api/agent/tasks/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

/** GET /api/agent/tasks/:id/messages —— 子任务 JSONL 解析出的消息（同会话历史格式）。 */
export async function getAgentTaskMessages(id: string): Promise<AgentMessageDto[]> {
  const data = await request<{ messages: AgentMessageDto[] }>(
    `/api/agent/tasks/${encodeURIComponent(id)}/messages`,
  );
  return data.messages ?? [];
}

/**
 * POST /api/agent/sessions/:id/mode —— 模式切换。
 * 切到 Work 必须带 workspaceId + confirm:'WORK'（§7.6）。
 */
export async function switchAgentSessionMode(
  id: string,
  body: { mode: 'discuss' } | { mode: 'work'; workspaceId: string; confirm: 'WORK' },
): Promise<AgentSessionDto> {
  return request<AgentSessionDto>(`/api/agent/sessions/${encodeURIComponent(id)}/mode`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Workspace（§9.4）
// ---------------------------------------------------------------------------

/** GET /api/agent/workspaces —— Work 会话可绑定的授权目录列表。 */
export async function listAgentWorkspaces(): Promise<AgentWorkspaceConfig[]> {
  const data = await request<{ workspaces: AgentWorkspaceConfig[] }>('/api/agent/workspaces');
  return data.workspaces ?? [];
}

/** POST /api/agent/workspaces —— 新增；路径合法性由后端校验（§7.3）。 */
export async function addAgentWorkspace(body: {
  name: string;
  path: string;
}): Promise<AgentWorkspaceConfig> {
  return request<AgentWorkspaceConfig>('/api/agent/workspaces', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** DELETE /api/agent/workspaces/:id —— 绑定它的 Work 会话被切回 discuss。 */
export async function deleteAgentWorkspace(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/agent/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export { type AgentMessageDto, type AgentSessionDto, type AgentStatusDto };

// 标准库源选择、待更新diff与独立版本记录。
export function listKbSources(q = '', page = 1) {
  const query = new URLSearchParams({ q, page: String(page), limit: '50' });
  return request<{ sources: KbSourceChoice[]; total: number; page: number; limit: number }>(`/api/kb/sources?${query}`);
}
export function setKbSourceIncluded(objToken: string, included: boolean) {
  return request<{ objToken: string; included: boolean }>(`/api/kb/sources/${encodeURIComponent(objToken)}`, {
    method: 'PUT', body: JSON.stringify({ included }),
  });
}
export function getKbChanges() { return request<KbChangePreview>('/api/kb/changes'); }
export function listKbVersions() {
  return request<{ versions: Array<Omit<KbVersionDto, 'sourceChanges' | 'docChanges'> & { sourceCount: number; docCount: number }>; retainReleases: number }>('/api/kb/versions');
}
export function getKbVersion(releaseId: string) {
  return request<KbVersionDto>(`/api/kb/versions/${encodeURIComponent(releaseId)}`);
}


export function getAgentPlugins(): Promise<AgentPluginsDto> {
  return request('/api/agent/plugin-contexts');
}
export function createAgentPlugin(expectedRevision: string, plugin: AgentPluginInput): Promise<AgentPluginsDto> {
  return request('/api/agent/plugin-contexts', { method: 'POST', body: JSON.stringify({ expectedRevision, ...plugin }) });
}
export function updateAgentPlugin(id: string, expectedRevision: string, plugin: AgentPluginInput): Promise<AgentPluginsDto> {
  return request(`/api/agent/plugin-contexts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ expectedRevision, ...plugin }) });
}
export function resetAgentPlugin(id: string, expectedRevision: string): Promise<AgentPluginsDto> {
  return request(`/api/agent/plugin-contexts/${encodeURIComponent(id)}/reset`, { method: 'POST', body: JSON.stringify({ expectedRevision }) });
}
export function deleteAgentPlugin(id: string, expectedRevision: string): Promise<AgentPluginsDto> {
  return request(`/api/agent/plugin-contexts/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }) });
}

export function listPiPlugins(): Promise<PiPluginsDto> { return request('/api/agent/plugins'); }
export function managePiPlugin(action: 'install' | 'update' | 'remove' | 'toggle', expectedRevision: string,
  input: { source?: string; id?: string; enabled?: boolean }): Promise<PiPluginsDto> {
  return request(`/api/agent/plugins/${action}`, { method: 'POST', body: JSON.stringify({ expectedRevision, ...input }) });
}

export function getKbSourceTree() { return request<KbSourceTreeDto>('/api/kb/sources/tree'); }
export function setKbSourcesSelection(root: string, tokens: string[], action: 'include' | 'exclude' | 'invert') {
  return request<{ selection: { objToken: string; included: boolean }[] }>('/api/kb/sources/selection', { method: 'POST', body: JSON.stringify({ root, tokens, action }) });
}

/** 指定原始源移入库内回收目录，并清理对应索引。 */
export async function cleanupKbSources(root: string, sources: Array<{ objToken: string; relPath: string }>) {
  const result = await request<{ cleaned: number; movedFiles: number; trashDir: string }>('/api/kb/sources/cleanup', { method: 'POST', body: JSON.stringify({ root, sources, confirm: 'CLEANUP' }) });
  emitDiffChanged('source-cleanup');
  return result;
}

export function previewSourceBatch(requestBody: SourceBatchRequest) {
  return request<SourceBatchPreview>('/api/trash/source-batch/preview', { method: 'POST', body: JSON.stringify(requestBody) });
}
export async function applySourceBatch(requestBody: SourceBatchRequest, expectedRevision: string) {
  const result = await request<SourceBatchResult>('/api/trash/source-batch/apply', { method: 'POST', body: JSON.stringify({ ...requestBody, expectedRevision, confirm: 'APPLY' }) });
  emitDiffChanged('source-batch'); return result;
}

export interface AgentModelOption {
  source: 'app-llm' | 'pi-agent-dir'; providerId?: string; modelId?: string; piModel?: string;
  label: string; reasoning: boolean;
  thinkingLevels?: import('../types/agent').AgentConfig['model']['thinkingLevel'][] | null;
}
export function setSessionApprovalMode(id: string, mode: 'ask' | 'auto'): Promise<AgentSessionDto> {
  return request(`/api/agent/sessions/${encodeURIComponent(id)}/approval-mode`, { method: 'PUT', body: JSON.stringify({ mode }) });
}
export function listConversationModels(source: 'app-llm' | 'pi-agent-dir', refresh = false, backend?: 'pi' | 'claude-code'): Promise<{ items: AgentModelOption[]; message: string }> {
  return request(`/api/agent/models?source=${source}${refresh ? '&refresh=1' : ''}${backend ? `&backend=${backend}` : ''}`);
}
export function saveConversationModel(id: string, model: import('../types/agent').SessionModelConfig | null): Promise<AgentSessionDto> {
  return request(`/api/agent/sessions/${encodeURIComponent(id)}/model`, { method: 'PATCH', body: JSON.stringify({ model }) });
}
export function requestSessionAgentStatus(id: string, refresh = false): Promise<AgentStatusDto> {
  return request(`/api/agent/sessions/${encodeURIComponent(id)}/status${refresh ? '?refresh=1' : ''}`);
}

// ---------------------------------------------------------------------------
// CLI 命令行访问（S9；desktop-guarded 管理面，见 server/src/routes/cli*.ts）
// ---------------------------------------------------------------------------

/** 内网 MCP：轮询只读脱敏 status/audit；明文只能由显式用户动作获取。 */
export function getKbLanMcpStatus(signal?: AbortSignal): Promise<KbLanMcpStatus> {
  return request('/api/kb-lan-mcp/status', { signal, timeoutMs: 15_000 });
}
/** status 未包含高级配置；沿用配置读取面，绝不经通用 config PUT 写入。 */
export function getKbLanMcpSettings(signal?: AbortSignal): Promise<{ kbLanMcp?: KbLanMcpSettings }> {
  return request('/api/config', { signal, timeoutMs: 15_000 });
}
export function enableKbLanMcp(body: { bindAddress?: string; port?: number } = {}): Promise<KbLanMcpStatus> {
  return request('/api/kb-lan-mcp/enable', { method: 'POST', body: JSON.stringify({
    ...(body.bindAddress !== undefined ? { bindAddress: body.bindAddress } : {}),
    ...(body.port !== undefined ? { port: body.port } : {}),
  }), timeoutMs: 20_000 });
}
export function disableKbLanMcp(revokeToken = false): Promise<unknown> {
  return request('/api/kb-lan-mcp/disable', { method: 'POST', body: JSON.stringify({ revokeToken }), timeoutMs: 20_000 });
}
export function saveKbLanMcpSettings(body: KbLanMcpSettings): Promise<unknown> {
  const { bindAddress, port, maxSessions, allowCidrs } = body;
  return request('/api/kb-lan-mcp/settings', {
    method: 'PUT', body: JSON.stringify({ bindAddress, port, maxSessions, ...(allowCidrs !== undefined ? { allowCidrs } : {}) }), timeoutMs: 20_000,
  });
}
export function rotateKbLanMcpToken(): Promise<unknown> {
  return request('/api/kb-lan-mcp/token/rotate', { method: 'POST', timeoutMs: 20_000 });
}
export async function revealKbLanMcpToken(): Promise<string> {
  const data = await request<{ token: string }>('/api/kb-lan-mcp/token/reveal', { method: 'POST', cache: 'no-store', timeoutMs: 15_000 });
  if (typeof data.token !== 'string' || !data.token) throw new Error('服务未返回令牌');
  return data.token;
}
export function getKbLanMcpAudit(signal?: AbortSignal): Promise<KbLanMcpAuditEntry[]> {
  return request('/api/kb-lan-mcp/audit?limit=20', { signal, timeoutMs: 15_000 });
}

/** GET /api/cli/info —— 开关/端点/shim 状态（不含令牌）。 */
export function getCliInfo(): Promise<CliInfoDto> {
  return request<CliInfoDto>('/api/cli/info');
}

/** POST /api/cli/enable —— 开启/关闭命令行访问（发布/撤销 endpoint.json）。 */
export function setCliEnabled(enabled: boolean): Promise<CliEnableResult> {
  return request<CliEnableResult>('/api/cli/enable', { method: 'POST', body: JSON.stringify({ enabled }) });
}

/** POST /api/cli/token/rotate —— 轮换 CLI 令牌（需已开启）。 */
export function rotateCliToken(): Promise<CliRotateResult> {
  return request<CliRotateResult>('/api/cli/token/rotate', { method: 'POST', body: JSON.stringify({}) });
}

/** POST /api/cli/install-shim —— 生成 <dataRoot>/bin/feishu-sync 可执行入口。 */
export function installCliShim(): Promise<CliShimInstallResult> {
  return request<CliShimInstallResult>('/api/cli/install-shim', { method: 'POST', body: JSON.stringify({}) });
}

// ---------------------------------------------------------------------------
// 源编辑与写回（S11/S12 API，S13 UI 消费）
// ---------------------------------------------------------------------------

/** GET /api/sources/:objToken/edit-status —— 正文 hash 与编辑状态（OCC 入口）。 */
export function getSourceEditStatus(objToken: string): Promise<SourceEditStatus> {
  return request<SourceEditStatus>(`/api/sources/${encodeURIComponent(objToken)}/edit-status`);
}

/** POST /api/sources/:objToken/revert —— 放弃修改（恢复上次同步正文）。 */
export function revertSourceEdit(objToken: string, acknowledgedUnknownUpdatedAt?: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/sources/${encodeURIComponent(objToken)}/revert`, {
    method: 'POST',
    body: JSON.stringify({ confirm: 'REVERT', actor: 'ui', acknowledgedUnknownUpdatedAt }),
  });
}

/** POST /api/sources/:objToken/push/preview —— 写回计划（不动状态）。 */
export function previewSourcePush(objToken: string): Promise<SourcePushPlan> {
  return request<SourcePushPlan>(`/api/sources/${encodeURIComponent(objToken)}/push/preview`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * POST /api/sources/:objToken/push —— 执行写回。
 * confirm 门（S12）：追加→'PUSH'；覆盖/强制→'OVERWRITE_CLOUD'。
 */
export function pushSourceToFeishu(
  objToken: string,
  opts: { allowOverwrite?: boolean; force?: boolean; acknowledgedUnknownUpdatedAt?: string; confirm: 'PUSH' | 'OVERWRITE_CLOUD' },
): Promise<SourcePushResult> {
  return request<SourcePushResult>(`/api/sources/${encodeURIComponent(objToken)}/push`, {
    method: 'POST',
    body: JSON.stringify({
      allowOverwrite: opts.allowOverwrite === true,
      force: opts.force === true,
      acknowledgedUnknownUpdatedAt: opts.acknowledgedUnknownUpdatedAt,
      confirm: opts.confirm,
      actor: 'ui',
    }),
  });
}

// ---------------------------------------------------------------------------
// P0-S5 回滚 UI（写回记录 / 云端历史 / 回滚两段流；消费 S3/S4 路由）
// ---------------------------------------------------------------------------

/** GET /api/sources/:objToken/push-log —— 写回记录（created_at 倒序，≤50 行）。 */
export function getSourcePushLog(objToken: string): Promise<{ logs: SourcePushLogRecord[] }> {
  return request<{ logs: SourcePushLogRecord[] }>(`/api/sources/${encodeURIComponent(objToken)}/push-log`);
}

export function reconcileUnknownRevert(objToken: string, pushLogId: string, confirm?: string): Promise<{
  state: 'unknown' | 'done' | 'failed' | 'resolved'; reason: string | null;
}> {
  return request(`/api/sources/${encodeURIComponent(objToken)}/reverts/${encodeURIComponent(pushLogId)}/reconcile`, {
    method: 'POST', body: JSON.stringify(confirm ? { confirm } : {}),
  });
}

/**
 * GET /api/sources/:objToken/history —— 云端历史。缺省从第一页聚合（上限
 * 3 页，truncated=true 时 nextPageToken 续翻）；显式 pageToken 单页透传。
 */
export function getCloudHistory(
  objToken: string,
  opts?: { pageToken?: string; pageSize?: number },
): Promise<CloudHistoryListResult> {
  const query = new URLSearchParams();
  if (opts?.pageToken) query.set('pageToken', opts.pageToken);
  if (opts?.pageSize != null) query.set('pageSize', String(opts.pageSize));
  const qs = query.toString();
  return request<CloudHistoryListResult>(
    `/api/sources/${encodeURIComponent(objToken)}/history${qs ? `?${qs}` : ''}`,
  );
}

/**
 * GET /api/sources/:objToken/history-content —— 只读云端正文（T4b-08 对比
 * 弹窗「对比云端当前」的真实数据源）。缺省 revisionId = 云端当前正文
 *（最新版）；显式 revisionId 按历史 revision 读取（数值 id 空间，
 * P0-S1 HP-3）。只读，不碰本地基线。
 */
export function fetchCloudContent(
  objToken: string,
  opts?: { revisionId?: number },
): Promise<{ revisionId: number | null; content: string }> {
  const query = new URLSearchParams();
  if (opts?.revisionId != null && Number.isFinite(opts.revisionId)) {
    query.set('revisionId', String(Math.floor(opts.revisionId)));
  }
  const qs = query.toString();
  return request<{ revisionId: number | null; content: string }>(
    `/api/sources/${encodeURIComponent(objToken)}/history-content${qs ? `?${qs}` : ''}`,
  );
}

/**
 * POST /api/sources/:objToken/history-revert/preview —— 回滚计划（只读）。
 * target 二选一：{ pushLogId }（写回锚点回滚）| { historyVersionId }（指定版本）。
 */
export function previewHistoryRevert(
  objToken: string,
  target: { pushLogId?: string; historyVersionId?: string },
): Promise<HistoryRevertPlan> {
  return request<HistoryRevertPlan>(`/api/sources/${encodeURIComponent(objToken)}/history-revert/preview`, {
    method: 'POST',
    body: JSON.stringify(target),
  });
}

/**
 * POST /api/sources/:objToken/history-revert —— 执行回滚（destructive）。
 * confirm 必须是 `REVERT_CLOUD:<historyVersionId>`（裸 REVERT_CLOUD 拒 400）；
 * 异步起步返回 202 { state:'running', taskId, pushLogId }，同步完成 200。
 */
export function executeHistoryRevert(
  objToken: string,
  target: { pushLogId?: string; historyVersionId?: string },
  confirm: string,
): Promise<HistoryRevertExecutionResult> {
  return request<HistoryRevertExecutionResult>(
    `/api/sources/${encodeURIComponent(objToken)}/history-revert`,
    {
      method: 'POST',
      body: JSON.stringify({ ...target, confirm, actor: 'ui' }),
    },
  );
}

// ---------------------------------------------------------------------------
// P2-S7 移出 UI（消费 P2-S6 四端点：preview / 执行 / moves/:id / moves）
// ---------------------------------------------------------------------------

/**
 * POST /api/sources/:objToken/move-to-drive/preview —— 移出预览（只读）。
 * 返回权威 wikiNodeToken（确认值派生源）+ 门控面 + 后果固定文案。
 */
export function previewMoveToDrive(
  objToken: string,
  opts?: { folderToken?: string },
): Promise<MoveOutPreview> {
  return request<MoveOutPreview>(`/api/sources/${encodeURIComponent(objToken)}/move-to-drive/preview`, {
    method: 'POST',
    body: JSON.stringify({ folderToken: opts?.folderToken ?? null }),
  });
}

/**
 * POST /api/sources/:objToken/move-to-drive —— 执行移出（destructive 逐次
 * 确认）。confirm 必须是 `MOVE_OUT:<nodeToken>`（裸 MOVE_OUT 拒 400）；
 * 异步起步返回 202 { state:'moving', moveId, taskId }，同步完成 200。
 */
export function executeMoveToDrive(
  objToken: string,
  confirm: string,
  opts?: { folderToken?: string },
): Promise<MoveOutExecutionResult> {
  return request<MoveOutExecutionResult>(
    `/api/sources/${encodeURIComponent(objToken)}/move-to-drive`,
    {
      method: 'POST',
      body: JSON.stringify({ folderToken: opts?.folderToken ?? null, confirm, actor: 'ui' }),
    },
  );
}

/** GET /api/sources/moves/:moveId —— 单条移出记录（异步收敛轮询）。 */
export function getCloudMove(moveId: string): Promise<CloudMoveRecord> {
  return request<CloudMoveRecord>(`/api/sources/moves/${encodeURIComponent(moveId)}`);
}

export function reconcileCloudMove(moveId: string, confirm?: string): Promise<{
  moveId: string; objToken: string; state: 'moved' | 'failed' | 'unknown'; taskId: string | null; reason: string | null;
}> {
  return request(`/api/sources/moves/${encodeURIComponent(moveId)}/reconcile`, {
    method: 'POST', body: JSON.stringify(confirm ? { confirm } : {}),
  });
}

/** GET /api/sources/moves?objToken=&limit= —— 移出记录列表（最新在前）。 */
export function listCloudMoves(
  opts?: { objToken?: string; limit?: number },
): Promise<{ moves: CloudMoveRecord[] }> {
  const query = new URLSearchParams();
  if (opts?.objToken) query.set('objToken', opts.objToken);
  if (opts?.limit != null && Number.isFinite(opts.limit)) query.set('limit', String(Math.floor(opts.limit)));
  const qs = query.toString();
  return request<{ moves: CloudMoveRecord[] }>(`/api/sources/moves${qs ? `?${qs}` : ''}`);
}
