/**
 * API client for feishu-sync
 * All requests include X-Desktop-Token header from window.desktop
 */

import type { Config, AuthStatus, ChangeDetectionResult, SyncResult, ServerHealth, ChangedDocument } from '../types';

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

export { APIError };
