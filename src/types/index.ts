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

/** One model preset inside a provider's OpenAI/Anthropic-compatible routes. */
export interface LlmModelPreset {
  id: string;
  name: string;
  openAiModel: string;
  claudeCliModel: string;
  enabled: boolean;
}

/** A remotely hosted model provider configured in Settings. */
export interface LlmProviderConfig {
  id: string;
  name: string;
  enabled: boolean;
  apiKey: string;
  openAiCompatBaseUrl: string;
  claudeCompatBaseUrl: string;
  defaultModelId?: string;
  models: LlmModelPreset[];
}

/**
 * v0.2.0 — remote-provider profiles plus local execution-channel controls.
 *
 * `providers` is used by the remote direct and Claude Code channels. The
 * flat endpoint/key/model fields remain for migration and older callers; the
 * server resolves the selected provider/model before a remote request.
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
  /** User-configured remote model providers. */
  providers?: LlmProviderConfig[];
  /** Currently selected remote provider for direct / Claude Code. */
  activeProviderId?: string;
  /** Currently selected model preset within the active provider. */
  activeModelId?: string;
  /** Optional shared timeout used by remote channels (milliseconds). */
  timeoutMs?: number;
  /** ClaudeCliChannel process control. */
  claudeCli?: {
    claudePath?: string;
    extraArgs?: string[];
  };
  /**
   * Local OpenCode process controls. When the active provider has a key, the
   * app passes it to OpenCode only for that child process; it is never written
   * to OpenCode's config file. Without an active key OpenCode uses its own
   * local configuration.
   */
  opencode?: {
    executablePath?: string;
    model?: string;
    agent?: string;
    timeoutMs?: number;
  };
  /** Explicit opt-in: reorganise Markdown bodies during sync. */
  contentAdaptationEnabled?: boolean;
  /** Primary channel name. Default 'claude-cli'. */
  primaryChannel: 'claude-cli' | 'direct' | 'opencode';
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
  /**
   * Ancestor titles from the configured watched root (exclusive) to the
   * immediate parent.  An empty array is valid for a direct child; undefined
   * means the hierarchy is not safe to plan yet.
   */
  parentChainTitles?: string[];
  /** True only for the body of the configured watched-root node itself. */
  isWatchedRootNode?: boolean;
  /** Portable relative path from a verified existing mapping, if any. */
  localRelPath?: string | null;
}

export type SyncState =
  | 'pending_added'
  | 'pending_modified'
  | 'synced'
  | 'restricted'
  | 'feishu_pending'
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
  reasonCode?: SyncFailureReasonCode;
  suggestedResolution?: string;
  repairAction?: SyncRepairAction;
  watchedRootId?: string | null;
}

export type SyncPlanReasonCode =
  | 'deleted_requires_confirmation'
  | 'missing_parent_chain'
  | 'unknown_watched_root'
  | 'path_conflict'
  | 'unsafe_path'
  | 'planned_move'
  | 'unsupported_type'
  | 'restricted'
  | 'unknown';

export type SyncFailureReasonCode =
  | SyncPlanReasonCode
  | 'permission_denied'
  | 'cloud_deleted'
  | 'rate_limited'
  | 'upstream_error';

export type SyncRepairAction =
  | 'rebuild_parent_chain'
  | 'adopt_existing_file'
  | 'retry'
  | 'grant_access'
  | 'review_deleted'
  | 'enable_export_adapter'
  | 'manual_review';

/** Persistent issues that require an operator to act in Feishu before sync can resume. */
export interface FeishuPendingItem {
  objToken: string;
  title: string;
  watchedRootId: string | null;
  reasonCode: SyncFailureReasonCode;
  error: string;
  suggestedResolution: string;
  repairAction: SyncRepairAction;
  createdAt: string;
  updatedAt: string;
  recheckRequestedAt: string | null;
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

export interface SyncDocumentOptions {
  enableLLM?: boolean;
  /** Explicitly adopt only title-verified legacy exports at profile paths. */
  adoptExistingProfileTargets?: boolean;
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
  orphan_files: OrphanFile[];
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
 * P2-05: classification distinguishes missing metadata, ambiguous cloud
 * matches, confirmed local-only files, and ignored navigation artifacts.
 * cloud_match remains for backward-compatible badge rendering.
 */
export type OrphanClassification =
  | 'missing_metadata'
  | 'cloud_match_ambiguous'
  | 'local_only_confirmed'
  | 'ignored_artifact';

export interface OrphanFile {
  path: string;
  reason: string;
  classification?: OrphanClassification;
  cloud_match: 'local_only' | 'unknown';
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

export type ChannelName = 'claude-cli' | 'direct' | 'opencode';

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
  llm: Pick<
    LlmConfig,
    | 'openAiCompatBaseUrl'
    | 'claudeCompatBaseUrl'
    | 'apiKey'
    | 'model'
    | 'directModel'
    | 'claudeCliModel'
    | 'temperature'
    | 'providers'
    | 'activeProviderId'
    | 'activeModelId'
  >;
  claudeCli?: { claudePath?: string; extraArgs?: string[] };
  opencode?: LlmConfig['opencode'];
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

export interface OpenCodeStatus {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  source: 'configured' | 'path' | 'login-shell' | 'npm-global-prefix' | 'npm-global-root' | 'missing';
  executable: boolean;
  error?: string;
}

export interface OpenCodeInstallResult {
  success: boolean;
  status: OpenCodeStatus;
  message: string;
}

/** Read-only availability result for the local Claude Code executable. */
export interface ClaudeCliStatus {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  source: 'configured' | 'environment' | 'path' | 'known-location' | 'missing';
  executable: boolean;
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
  /** 当前应用真实版本（Electron app.getVersion，桌面端存在）；与 electron/contracts.ts 对齐。 */
  currentVersion?: string;
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

// ============================================================================
// Custom Folders (快捷添加云链接 + 自定义文件夹归档)
// ============================================================================
//
// API 契约（前后端共同遵守，字段名勿改）：
//   GET    /api/custom-folders           → { folders: CustomFolder[] }
//   POST   /api/custom-folders { name }  → 201 { folder }；400 invalid_name；409 duplicate_name
//   PATCH  /api/custom-folders/:id { name } → { folder }（仅改 name，localRelPath 不变）
//   DELETE /api/custom-folders/:id       → { ok: true }（文档 custom_folder_id 置空，文件保留）
//   POST   /api/custom-folders/:id/docs { links: string[] }（≤20 条/次）
//          → { results: AddLinkToFolderResult[] }

/** 自定义归档文件夹下的单篇云文档。 */
export interface CustomFolderDoc {
  objToken: string;
  title: string;
  objType: 'docx' | 'sheet' | 'slides' | string;
  originalLink: string;
  /** 相对知识库根的 POSIX 路径（<folderRelPath>/<title>.<ext>）。 */
  localRelPath: string;
}

export interface CustomFolder {
  id: string;
  name: string;
  /** 相对知识库根的 POSIX 路径，默认 `_custom/<sanitized-name>`。 */
  localRelPath: string;
  createdAt: string;
  docs: CustomFolderDoc[];
}

/** POST /docs 逐条错误分类（契约固定枚举）。 */
export type AddLinkErrorCode =
  | 'parse_failed'
  | 'already_exists'
  | 'unsupported_type'
  | 'fetch_failed'
  | 'permission_denied';

export interface AddLinkResultError {
  code: AddLinkErrorCode | string;
  message?: string;
  /** already_exists 时附已有归属（结构树 / 归档文件夹名）。
   * 真实后端字段名为 existingLocation；owner 为兼容别名。 */
  owner?: string;
  existingLocation?: string;
}

/** POST /api/custom-folders/:id/docs 的逐条结果。 */
export interface AddLinkToFolderResult {
  link: string;
  ok: boolean;
  objToken?: string;
  title?: string;
  objType?: string;
  error?: AddLinkResultError;
}

declare global {
  interface Window {
    desktop?: DesktopAPI;
  }
}
