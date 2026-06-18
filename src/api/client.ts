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
 * Save configuration
 */
export async function saveConfig(config: Partial<Config>): Promise<Config> {
  return request<Config>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
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

export { APIError };
