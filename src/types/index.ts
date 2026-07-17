/**
 * Frontend type definitions
 * Reuses server types where applicable
 */

// Re-export shared types from server (will be available in production build)
// For development, we define them here for type safety

export type LayoutProfile = 'directory-readme' | 'mirror-title-file';

/** Authoritative local layout configuration for one Feishu wiki root. */
export interface WatchedRootConfig {
  /** Canonical wiki root node token; matches server `watched_root_id`. */
  id: string;
  url: string;
  /** POSIX-style path relative to `knowledgeBaseRoot`. */
  localDir: string;
  layoutProfile: LayoutProfile;
  enabled: boolean;
}

export interface Config {
  llm: LlmConfig;
  pollIntervalMinutes: number;
  knowledgeBaseRoot: string;
  watchedRoots: WatchedRootConfig[];
  /** Compatibility projection derived by the server; not persisted by P2+. */
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
  wikiNodeToken?: string | null;
  parentNodeToken?: string | null;
  spaceId?: string | null;
  watchedRootId?: string | null;
  hasChild?: boolean;
  observedObjEditTime?: number | null;
  syncState?: SyncState;
}

export type SyncState =
  | 'pending_added'
  | 'pending_modified'
  | 'synced'
  | 'restricted'
  | 'error'
  | 'missing_candidate'
  | 'deleted_confirmed';

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

export interface PlannedSyncDocument {
  objToken: string;
  title: string;
  objType: 'docx' | 'sheet' | 'slides' | 'unknown';
  changeType: 'modified' | 'added' | 'deleted';
  action: 'create' | 'replace' | 'blocked';
  localMdPath: string | null;
  previousSha256: string | null;
  reason?: string;
}

export type SyncMode = 'dry-run' | 'apply';

export interface SyncResult {
  success: boolean;
  syncedDocuments: SyncedDocument[];
  failedDocuments: FailedDocument[];
  startedAt: string;
  completedAt: string;
  duration: number;
  mode?: SyncMode;
  operationId?: string;
  manifestPath?: string;
  plannedDocuments?: PlannedSyncDocument[];
}

export interface ChangeDetectionResult {
  changed: boolean;
  changedDocuments: ChangedDocument[];
  checkedAt: string;
  totalNodes: number;
  traversalComplete?: boolean;
  failedNodeTokens?: string[];
  missingCandidates?: number;
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
  /**
   * v0.2.0 cloud-link-coverage: explicit feishu cloud relationship.
   * See server/src/types/index.ts MappingNode for full semantics.
   */
  original_link: string | null;
  cloud_match: 'synced' | 'restricted' | 'unknown';
  /**
   * v0.2.0 structure-align Phase B: the watchedRoot URL that owns this node.
   * Used by the cloud view to group top-level nodes by watchedRoot.
   * Null for local-only or unclassified rows.
   */
  watched_root_url?: string | null;
}

// ============================================================================
// v0.2.0 structure-align Phase B: watchedRoots + TreeResponse envelope
// ============================================================================

/**
 * Materialized watchedRoot record (mirrors server/src/types/index.ts).
 *
 * Derived from config.watchedRootUrls + the documents table; one row per
 * configured root. The frontend uses this for:
 *   - Cloud view: top-level grouping of MappingNode by watched_root_url.
 *   - Settings panel: surface child count + status per watchedRoot.
 *
 * `status`:
 *   - 'synced'         : watchedRoot is configured + at least one doc maps to it.
 *   - 'missing_in_db'  : watchedRoot is configured but no doc references it
 *                        (typical when detect hasn't run yet or the root has
 *                        no local .md files under its local_dir).
 *   - 'error'          : detect attempted and failed (lark-cli error etc);
 *                        `diagnostic` holds the failure reason.
 */
export interface WatchedRoot {
  url: string;
  nodeToken: string;
  title: string;
  displayName: string;
  localDir: string;
  trackMode: 'tracked' | 'mounted';
  status: 'synced' | 'missing_in_db' | 'error';
  lastDetectedAt: string | null;
  childCount: number;
  diagnostic?: string;
}

/**
 * v0.2.0 structure-align Phase B: response envelope returned by
 * GET /api/mapping/tree?view=feishu|local. Mirrors server TreeResponse.
 *
 * - `view`: echoes the requested view.
 * - `nodes`: filtered MappingNode[] (feishu view → wiki_node_token != null).
 * - `watched_roots`: top-level grouping metadata.
 * - `orphan_files`: included in local view; empty array in feishu view.
 * - `stats`: summary counts for the status bar.
 */
export interface TreeResponse {
  view: 'feishu' | 'local';
  nodes: MappingNode[];
  watched_roots: WatchedRoot[];
  orphan_files: Array<{ path: string; reason: string; cloud_match: 'local_only' }>;
  stats: {
    total_nodes: number;
    watched_root_count: number;
    cloud_match_distribution: Record<string, number>;
  };
}

/**
 * Local directory tree node used by LocalDirTreeView (D2).
 *
 * Built client-side by splitting `local_path` on '/' and reassembling the
 * directory tree. The shape is intentionally recursive so the React
 * component can render with a single recursive function.
 */
export interface LocalDirTreeNode {
  type: 'dir' | 'file';
  name: string;
  /** POSIX-style relative path (knowledgeBaseRoot-relative). */
  path: string;
  children?: LocalDirTreeNode[];
  /** Present on file nodes that map to a documents row. */
  docRecord?: MappingNode;
  /** cloud_match from docRecord or orphan_files entry. */
  cloud_match?: 'synced' | 'restricted' | 'unknown' | 'local_only';
  original_link?: string | null;
  watched_root_url?: string | null;
  /** True if the entry comes from orphan_files (not a documents row). */
  is_orphan?: boolean;
}

/**
 * v0.2.0 structure-align Phase B: mounted_dirs entry (local-only top-level
 * directories that exist on disk but are not bound to any watchedRoot).
 */
export interface MountedDir {
  local_dir: string;
  reason: string;
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
 *
 * v0.2.0 cloud-link-coverage: cloud_match is always 'local_only' for orphans
 * (they have no feishu correspondence by definition). Surfaced explicitly so
 * the UI can render "本地独有 / 无飞书对应" rather than treating them as broken.
 */
export interface OrphanFile {
  path: string;
  reason: string;
  cloud_match: 'local_only';
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
  /**
   * v0.2.0 structure-align Phase B: materialized watchedRoots array
   * (one entry per configured watchedRoot). Frontend uses this for
   * top-level grouping in cloud view + status display in settings.
   */
  watched_roots?: WatchedRoot[];
  /**
   * v0.2.0 structure-align Phase B: local-only directories (e.g. _reports/,
   * attachments/) that exist on disk but are not tracked against any
   * watchedRoot. Surfaced in local view under "未绑定 watchedRoot" group.
   */
  mounted_dirs?: MountedDir[];
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
 *     env injection (ANTHROPIC_BASE_URL/API_KEY/MODEL), 30s timeout.
 *   - channel='direct':    POST bigmodel paas/v4 chat/completions with a
 *     tiny hello prompt, 30s timeout.
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
