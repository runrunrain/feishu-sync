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
  TreeResponse,
} from '../types';

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

/**
 * Make an authenticated API request
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = await getApiHeaders();
  const baseUrl = await getBaseUrl();
  const url = `${baseUrl}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...options.headers,
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

  return response.json();
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
 * The server also sanitizes `llm.apiKey` to `'***'` on GET (see GET
 * /api/config). Callers MUST NOT send `llm.apiKey` back unless they have
 * the real value; otherwise the literal `'***'` is persisted, destroying
 * the user's key. `saveConfig` therefore drops `llm.apiKey` from the
 * outbound payload when it still looks masked.
 */
export async function saveConfig(config: Partial<Config>): Promise<Config> {
  const outbound = sanitizeOutboundConfig(config);
  const data = await request<unknown>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(outbound),
  });
  return unwrapConfigResponse(data);
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
 * Drop fields the server has masked so we never persist the mask back over
 * the real value. Currently this means `llm.apiKey === '***'`.
 */
function sanitizeOutboundConfig(config: Partial<Config>): OutboundConfigBody {
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

/**
 * Detect changes in watched URLs
 */
export async function detectChanges(rootUrl: string): Promise<ChangeDetectionResult> {
  return request<ChangeDetectionResult>('/api/detect/changes', {
    method: 'POST',
    body: JSON.stringify({ rootUrl }),
  });
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
export async function detectChangesAll(): Promise<MultiRootDetectionResult> {
  return request<MultiRootDetectionResult>('/api/detect/changes-all', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Sync documents
 */
export async function syncDocs(
  options: {
    documents: ChangedDocument[];
    enableLLM: boolean;
    fullSync: boolean;
  }
): Promise<SyncResult> {
  return request<SyncResult>('/api/sync', {
    method: 'POST',
    body: JSON.stringify(options),
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
 * GET /api/mapping/diff — DiffReport grouped by added/modified/deleted.
 */
export async function getMappingDiff(rootUrl: string): Promise<DiffReport> {
  const qs = new URLSearchParams({ rootUrl });
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
}

export async function rebuildIndex(): Promise<RebuildIndexResponse> {
  return request<RebuildIndexResponse>('/api/index/rebuild', {
    method: 'POST',
    body: JSON.stringify({}),
  });
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
  return request<{ ok: true }>('/api/trash/restore', {
    method: 'POST',
    body: JSON.stringify({ obj_token: objToken }),
  });
}

/**
 * DELETE /api/trash/purge — permanently delete a soft-deleted document
 * (fs.unlink the local .md copy). Pass { all: true } to clear all trashed.
 */
export async function purgeTrashedDoc(objToken: string): Promise<{ purged: number }> {
  return request<{ purged: number }>(`/api/trash/purge?obj_token=${encodeURIComponent(objToken)}`, {
    method: 'DELETE',
  });
}

export async function clearTrash(): Promise<{ purged: number }> {
  return request<{ purged: number }>('/api/trash/purge?all=1', { method: 'DELETE' });
}

// ============================================================================
// Channel Connectivity Test (T7, decision 3 real bigmodel call)
// ============================================================================

/**
 * POST /api/llm/test-channel — real connectivity test against the currently
 * selected channel (claude-cli or direct). Server sends a tiny hello prompt
 * with a 3s timeout and returns the result without surfacing the stack to
 * the UI (full detail lives in server logs).
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

export { APIError };
