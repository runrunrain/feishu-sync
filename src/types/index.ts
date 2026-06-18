/**
 * Frontend type definitions
 * Reuses server types where applicable
 */

// Re-export shared types from server (will be available in production build)
// For development, we define them here for type safety

export interface Config {
  llm: LlmConfig;
  pollIntervalMinutes: number;
  knowledgeBaseRoot: string;
  watchedRootUrls: string[];
  larkCliPath?: string;
  requiredScopes: string[];
  enableAutoStart: boolean;
  enableNotifications: boolean;
}

/**
 * v0.2.0 P3/P4 — channel-agnostic LLM provider config (bigmodel 认知修正).
 *
 * Cognitive correction (2026-06-18): there is ONE provider (bigmodel GLM by
 * default). `claude -p` (Anthropic-protocol adapter) and the OpenAI SDK 直连
 * (OpenAI-protocol adapter) are TWO CHANNELS sharing ONE `LlmConfig`.
 *
 * Frontend type mirrors server/src/types/index.ts LlmConfig. The legacy
 * flat shape `{ baseUrl, apiKey, model, temperature }` is auto-migrated by
 * ConfigManager; UI never shows the legacy form.
 */
export interface LlmConfig {
  /** OpenAI-protocol adapter base URL (DirectChannel/OpenAI SDK). */
  openAiCompatBaseUrl: string;
  /** Anthropic-protocol adapter base URL (ClaudeCliChannel env-inject). */
  claudeCompatBaseUrl: string;
  /** Single API key shared by both channels. */
  apiKey: string;
  /** Default model alias used by both channels when no per-channel override. */
  model: string;
  /** Optional per-channel model alias override (bigmodel dual-protocol alias spaces). */
  directModel?: string;
  claudeCliModel?: string;
  /** Sampling temperature 0.0-1.0. Default 0.2. */
  temperature: number;
  /** ClaudeCliChannel process control. */
  claudeCli?: {
    claudePath?: string;
    extraArgs?: string[];
  };
  /** Primary channel name. Default 'claude-cli'. */
  primaryChannel: 'claude-cli' | 'direct';
  /** On primary failure, retry via the other channel. Default true. */
  fallbackOnFailure: boolean;
}

/**
 * Backward-compat alias for v0.1.0 readers. New code should use `LlmConfig`.
 */
export type LLMConfig = LlmConfig;

/**
 * Legacy flat config shape (auto-migrated on load; UI never edits this form).
 * Retained for migration typing only.
 */
export interface LegacyLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface ChangedDocument {
  objToken: string;
  objType: 'docx' | 'sheet' | 'slides' | 'unknown';
  title: string;
  changeType: 'modified' | 'added' | 'deleted';
  cloudModifiedTime: string;
  localSyncedTime: string | null;
  localMdPath: string | null;
}

export interface SyncedDocument {
  objToken: string;
  title: string;
  localMdPath: string;
  cloudModifiedTime: string;
  size: number;
  imagesCount: number;
  attachmentsCount: number;
  sheetsCount: number;
}

export interface FailedDocument {
  objToken: string;
  title: string;
  error: string;
  retryable: boolean;
}

export interface SyncResult {
  success: boolean;
  syncedDocuments: SyncedDocument[];
  failedDocuments: FailedDocument[];
  startedAt: string;
  completedAt: string;
  duration: number;
}

export interface ChangeDetectionResult {
  changed: boolean;
  changedDocuments: ChangedDocument[];
  checkedAt: string;
  totalNodes: number;
}

export interface AuthStatus {
  ready: boolean;
  larkCliVersion?: string;
  currentScopes?: string[];
  missingScopes?: string[];
  error?: string;
  identity?: string;
}

// ============================================================================
// Mapping API Types (v0.2.0 P4) — mirrors server/src/types/index.ts
// ============================================================================

/**
 * Flattened node entry returned by GET /api/mapping/tree.
 *
 * Field names mirror the server contract (snake_case) so this type can be
 * consumed directly from the JSON response without client-side remapping.
 * The frontend rebuilds the tree via parent_node_token (03 §3.8).
 */
export interface MappingNode {
  obj_token: string;
  wiki_node_token: string | null;
  space_id: string | null;
  obj_type: 'docx' | 'sheet' | 'slides' | 'unknown';
  title: string;
  local_path: string;
  parent_node_token: string | null;
  has_child: boolean;
  obj_edit_time: number | null;
  last_synced_modify_time: string;
  last_synced_at: string;
  last_seen_at: string | null;
  status: 'synced' | 'changed' | 'error' | 'placeholder';
  cloud_deleted: number; // 0 | 1
  sortOrder: number | null;
}

/**
 * DiffReport returned by GET /api/mapping/diff (03 §3.6.2).
 */
export interface DiffReport {
  added: ChangedDocument[];
  modified: ChangedDocument[];
  deleted: ChangedDocument[];
  unchanged: number;
  totalCloud: number;
  totalLocal: number;
  checkedAt: string;
}

/**
 * Orphan file entry from _index.json.orphan_files.
 */
export interface OrphanFile {
  path: string;
  reason: string;
}

/**
 * Top-level directory stat from _index.json.top_level_dirs.
 */
export interface TopLevelDir {
  dir: string;
  node_count: number;
}

/**
 * Full _index.json snapshot structure (subset consumed by the UI).
 */
export interface IndexSnapshot {
  version: string;
  generated_at: string;
  knowledge_base_root: string;
  watched_root_urls: string[];
  top_level_dirs: TopLevelDir[];
  nodes: MappingNode[];
  orphan_files: OrphanFile[];
}

/**
 * Request body for POST /api/mapping/reorder (decision 5).
 */
export interface ReorderRequest {
  parent_node_token: string | null;
  ordered_obj_tokens: string[];
}

export interface ReorderResponse {
  updated: number;
  refreshed_index: boolean;
}

/**
 * Sheet sub-table entry (sheet_sheets table — 03 §3.2.2).
 * Surfaced in the UI as an expandable row under sheet change items.
 */
export interface SheetSub {
  sheetId: string;
  title: string;
  status: 'synced' | 'changed' | 'error' | 'placeholder';
}

// ============================================================================
// Toast Types (T9)
// ============================================================================

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  message: string;
  /** Optional detail line — kept short (no stack trace, decision 4). */
  hint?: string;
  /** Auto-dismiss after N ms. Defaults from type. */
  durationMs?: number;
}

export interface ServerHealth {
  status: string;
  timestamp: number;
}

// ============================================================================
// Trash / Soft-Delete Types (T10, decision 2)
// ============================================================================
//
// P4-2 NOTE: backend trash endpoints (GET /api/trash, POST /api/trash/restore,
// DELETE /api/trash/purge) are NOT yet implemented on the server side as of
// 2026-06-18 (HEAD 43121ef). The frontend implements the UI + client calls
// against the intended contract; missing endpoints surface as Toast errors
// and the drawer still renders the empty state. Leader should dispatch a
// follow-up task to 鲁班 to add the trash routes.

/**
 * Soft-deleted document entry (cloud_deleted=1, retained locally).
 * Mirrors the intended backend contract; field naming may be tuned when
 * 鲁班 implements the routes.
 */
export interface TrashedDoc {
  obj_token: string;
  title: string;
  local_path: string;
  /** ISO timestamp the row was marked cloud_deleted (best-effort). */
  deleted_at: string | null;
  /** Optional reason: 'cloud_deleted' | 'user_trashed' | 'orphan'. */
  reason?: string;
}

// ============================================================================
// Channel Connectivity Test (T7, decision 3 real call)
// ============================================================================

export type ChannelName = 'claude-cli' | 'direct';

/**
 * Connectivity test request body for POST /api/llm/test-channel.
 *
 * Backend contract (to be implemented by 鲁班 P5):
 *   - channel='claude-cli': spawn `claude -p "hello"` with bigmodel Anthropic
 *     env injection (ANTHROPIC_BASE_URL/API_KEY/MODEL), 3s timeout.
 *   - channel='direct':    POST bigmodel paas/v4 chat/completions with a
 *     tiny hello prompt, 3s timeout.
 * Both channels share the same `llm.apiKey`.
 */
export interface ChannelTestRequest {
  channel: ChannelName;
  llm: Pick<LlmConfig, 'openAiCompatBaseUrl' | 'claudeCompatBaseUrl' | 'apiKey' | 'model' | 'directModel' | 'claudeCliModel' | 'temperature'>;
  claudeCli?: { claudePath?: string; extraArgs?: string[] };
}

export interface ChannelTestResult {
  success: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Tokens reported by provider (best-effort). */
  tokensUsed?: number;
  /** Effective model alias used. */
  model: string;
  /** One-line error summary (no stack). Full detail in server logs. */
  error?: string;
}

// Desktop API types (from desktop-contracts.ts)
export interface DesktopAPI {
  getApiHeaders: () => Promise<{ 'X-Desktop-Token': string }>;
  getServerStatus: () => Promise<{ running: boolean; port: number | null }>;
  update: {
    getState: () => Promise<DesktopUpdateState>;
    check: () => Promise<DesktopUpdateCheckResult>;
    download: () => Promise<DesktopActionResult>;
    installAndRestart: () => Promise<DesktopActionResult>;
    onEvent: (callback: (event: DesktopUpdateEvent) => void) => () => void;
  };
  openDataDirectory: () => Promise<DesktopActionResult>;
  openConfigFile: () => Promise<DesktopActionResult>;
}

export interface DesktopActionResult {
  success: boolean;
  error?: string;
}

export interface DesktopUpdateState {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing';
  version?: string;
  progress?: number;
}

export interface DesktopUpdateCheckResult {
  available: boolean;
  version?: string;
  releaseNotes?: string;
}

export interface DesktopUpdateEvent {
  type: 'progress' | 'state-change' | 'error';
  state?: DesktopUpdateState['state'];
  progress?: number;
  error?: string;
}

declare global {
  interface Window {
    desktop?: DesktopAPI;
  }
}
