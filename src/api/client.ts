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
} from '../types';
import { emitDiffChanged } from '../utils/syncEvents';

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
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Ignore JSON parse errors
      }
      throw new APIError(errorMessage, response.status);
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
}

/** POST /api/feishu/auth/device/complete —— 阻塞等待授权后的最终状态。 */
export interface DeviceAuthCompleteResult {
  ok: boolean;
  ready: boolean;
  larkCliVersion?: string;
  currentScopes?: string[];
  missingScopes?: string[];
  identity?: string;
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

export async function startDeviceAuth(): Promise<DeviceAuthStartResult> {
  return request<DeviceAuthStartResult>('/api/feishu/auth/device/start', {
    method: 'POST',
    body: JSON.stringify({}),
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
export async function syncDocs(
  documents: ChangedDocument[],
  options: { enableLLM?: boolean; adoptExistingProfileTargets?: boolean } = {},
): Promise<SyncResult> {
  const result = await request<SyncResult>('/api/sync', {
    method: 'POST',
    body: JSON.stringify({
      documents,
      options: {
        enableLLM: options.enableLLM === true,
        adoptExistingProfileTargets: options.adoptExistingProfileTargets === true,
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
 * 本地 .md 移入 .trash-bin/（镜像路径可找回），documents + sheet_sheets
 * 行硬删；回收站行（cloud_deleted=1）会 409，需走回收站面板。
 */
export async function manualDeleteDoc(objToken: string): Promise<{
  ok: boolean;
  file_moved_to_trash: boolean;
  already_gone?: boolean;
}> {
  const result = await request<{
    ok: boolean;
    file_moved_to_trash: boolean;
    already_gone?: boolean;
  }>('/api/trash/manual-delete', {
    method: 'POST',
    body: JSON.stringify({ obj_token: objToken }),
  });
  emitDiffChanged('manual-delete');
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
