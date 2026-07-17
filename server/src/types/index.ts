/**
 * Shared TypeScript type definitions for feishu-sync server
 */

// ============================================================================
// Configuration Types
// ============================================================================

/** The on-disk layout contract for one configured Feishu wiki root. */
export type LayoutProfile = 'directory-readme' | 'mirror-title-file';

/**
 * Configuration authority for a watched root.
 *
 * `id` is the canonical wiki root node token. It deliberately matches the
 * P1 `documents.watched_root_id` value, rather than a user-editable display
 * name, so root ownership remains stable across title/host changes.
 */
export interface WatchedRootConfig {
  id: string;
  url: string;
  /** POSIX-style path relative to `knowledgeBaseRoot`. */
  localDir: string;
  layoutProfile: LayoutProfile;
  enabled: boolean;
}

export interface Config {
  /**
   * v0.2.0 P3: channel-agnostic LLM config. The legacy flat
   * `{ baseUrl, apiKey, model, temperature }` form is auto-migrated
   * to the new `LlmConfig` shape by ConfigManager on first load
   * (see migrateLegacyLlmConfig).
   *
   * For backward compatibility with v0.1.0 readers we keep the field
   * name `llm` but its type widens to the new shape.
   */
  llm: LlmConfig;
  pollIntervalMinutes: number;
  knowledgeBaseRoot: string;
  /** Authoritative P2 root configuration. */
  watchedRoots: WatchedRootConfig[];
  /**
   * Compatibility projection for pre-P2 callers. ConfigManager derives this
   * from `watchedRoots` in memory and no longer persists it to disk.
   */
  watchedRootUrls: string[];
  larkCliPath?: string;
  requiredScopes: string[];
  enableAutoStart: boolean;
  enableNotifications: boolean;
}

/** Return only roots whose explicit configuration enables traversal/sync. */
export function getEnabledWatchedRoots(
  config: { watchedRoots?: WatchedRootConfig[] } | null | undefined,
): WatchedRootConfig[] {
  return Array.isArray(config?.watchedRoots)
    ? config.watchedRoots.filter((root) => root.enabled)
    : [];
}

/** Compatibility selector for call sites that only need canonical URLs. */
export function getEnabledWatchedRootUrls(
  config: { watchedRoots?: WatchedRootConfig[] } | null | undefined,
): string[] {
  return getEnabledWatchedRoots(config).map((root) => root.url);
}

// ============================================================================
// LLM Channel Configuration (v0.2.0 P3)
// ============================================================================

/**
 * Shared LLM provider configuration consumed by BOTH channels.
 *
 * Cognitive correction (2026-06-18): there is ONE provider (bigmodel
 * GLM by default). `claude -p` (Anthropic-protocol adapter) and the
 * OpenAI SDK 直连 (OpenAI-protocol adapter) are two CHANNELS sharing
 * ONE `LlmConfig`.
 *
 * `openAiCompatBaseUrl` and `claudeCompatBaseUrl` are kept separate
 * because bigmodel (and similar dual-protocol providers) expose two
 * distinct endpoints. The same `apiKey` is accepted at both.
 *
 * `claudeCli`, `primaryChannel`, and `fallbackOnFailure` control
 * channel selection and fallback policy.
 */
export interface LlmConfig {
  /** OpenAI-protocol adapter base URL (DirectChannel/OpenAI SDK). */
  openAiCompatBaseUrl: string;
  /** Anthropic-protocol adapter base URL (ClaudeCliChannel env-inject). */
  claudeCompatBaseUrl: string;
  /** Single API key shared by both channels. */
  apiKey: string;
  /** Model alias used by both channels (e.g. glm-4-flash). */
  model: string;
  /**
   * Optional per-channel model overrides. Bigmodel's two endpoints use
   * different alias spaces (paas/v4 accepts glm-4-flash, /api/anthropic
   * accepts glm-5.2[1m]); these let users fill different aliases when
   * a single name is not valid at both endpoints.
   */
  directModel?: string;
  claudeCliModel?: string;
  /** Sampling temperature 0.0-1.0. Default 0.2. */
  temperature: number;
  /**
   * Per-call LLM adaptation timeout in milliseconds.
   *
   * Default 600000 (10 minutes). The claude-cli channel (bigmodel
   * glm-5.2[1m] via the Anthropic-compat adapter) routinely takes 1-3
   * minutes for a single feishu doc adaptation under load, and the
   * bigmodel endpoint occasionally returns transient 529 over-load
   * responses that the SDK retries internally. A 60s timeout (the
   * previous hard-coded value) was too aggressive and caused the
   * primary channel to abort and fall back to DirectChannel even when
   * the model would have produced output if given another minute or
   * two. The 10-minute default gives the model ample headroom while
   * still bounding worst-case latency; users on a fast local model
   * can lower this via the UI / config.json.
   *
   * Used by sync-engine when calling ContentAdapter.adaptContent.
   * Per-call AdaptOptions.timeoutMs still overrides this value.
   */
  timeoutMs?: number;
  /** ClaudeCliChannel process control (path + extra args). */
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
 * Legacy v0.1.0 flat LLM config shape. Retained for migration logic;
 * new code MUST use `LlmConfig`.
 */
export interface LegacyLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

/**
 * Type guard: returns true if the value looks like a legacy flat config.
 * Used by ConfigManager.migrateLegacyLlmConfig.
 */
export function isLegacyLlmConfig(value: unknown): value is LegacyLLMConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  // Legacy shape has `baseUrl` and no `openAiCompatBaseUrl`.
  return (
    typeof v.baseUrl === 'string' &&
    v.openAiCompatBaseUrl === undefined &&
    v.primaryChannel === undefined
  );
}

/**
 * Backward-compat alias kept for old type references (e.g. AdaptOptions
 * in this same file). New code should prefer `LlmConfig`.
 */
export type LLMConfig = LlmConfig;

// ============================================================================
// Document Types
// ============================================================================

/**
 * Runtime synchronization state introduced by the v5 schema.
 *
 * `status` remains on DocumentRecord as a legacy/UI compatibility field;
 * this state is the authoritative answer to whether a cloud observation has
 * been committed to the local knowledge base. In particular, detection may
 * advance `observedObjEditTime`, but only a successful atomic sync commit may
 * advance `syncedObjEditTime` and transition a document to `synced`.
 */
export type SyncState =
  | 'pending_added'
  | 'pending_modified'
  | 'synced'
  | 'restricted'
  | 'error'
  | 'missing_candidate'
  | 'deleted_confirmed';

/**
 * A lossless cloud-side observation collected during wiki traversal.
 *
 * This is intentionally separate from DocumentRecord: it describes what the
 * current traversal saw, whereas DocumentRecord describes the persisted local
 * sync baseline. Keeping the two concepts distinct prevents a poll from
 * accidentally acknowledging a change before its file transaction succeeds.
 */
export interface CloudNodeObservation {
  objToken: string;
  wikiNodeToken: string;
  objType: 'docx' | 'sheet' | 'slides' | 'unknown';
  title: string;
  spaceId: string | null;
  parentNodeToken: string | null;
  watchedRootId: string;
  watchedRootUrl: string | null;
  observedObjEditTime: number | null;
  hasChild: boolean;
  /** Whether detail lookup succeeded, was permission-restricted, or failed transiently. */
  observationStatus: 'available' | 'restricted' | 'unavailable';
}

export interface DocumentRecord {
  objToken: string;
  wikiNodeToken: string | null;
  objType: 'docx' | 'sheet' | 'slides' | 'unknown';
  title: string;
  localMdPath: string;
  lastSyncedModifyTime: string;
  lastSyncedAt: string;
  status: 'synced' | 'changed' | 'error' | 'placeholder';
  /**
   * v0.2.0 mapping-expansion fields (all optional for backward compat with
   * rows written by v0.1.0 code paths; SQLite ALTER ADD COLUMN yields NULL
   * for existing rows, which we surface as null here).
   */
  parentNodeToken?: string | null;
  spaceId?: string | null;
  /**
   * Legacy alias for the most recently observed cloud edit time. New code
   * should use observedObjEditTime; keeping this field avoids breaking v2-v4
   * readers while databases are upgraded in place.
   */
  objEditTime?: number | null;
  cloudDeleted?: number; // 0 | 1
  lastSeenAt?: string | null;
  localSortOrder?: number | null;
  /**
   * v0.2.0 cloud-link-coverage fields.
   *
   * originalLink is the feishu wiki URL associated with this document.
   * For synced rows it is extracted from the .md header; for restricted
   * rows it is best-effort constructed from wiki_node_token.
   *
   * cloudMatch classifies the row's relationship with the feishu cloud:
   *   - 'synced'     : title verified from feishu (cloud reachable + readable)
   *   - 'restricted' : has obj_token but feishu returned permission-denied,
   *                    title is empty; link is a best-effort guess
   *   - 'unknown'    : default for legacy rows not yet classified by rebuild
   *   - 'local_only' : not used on documents rows (only on orphan_files entries);
   *                    included here for type completeness when unions form
   */
  originalLink?: string | null;
  cloudMatch?: 'synced' | 'restricted' | 'unknown' | 'local_only';
  /**
   * v0.2.0 structure-align Phase B fields.
   *
   * watchedRootUrl is the feishu wiki URL of the watchedRoot that owns
   * this row. Source of truth is the application config (watchedRoots);
   * rows whose local_md_path top-level directory maps to a watchedRoot
   * are tagged by IndexScanner during rebuild. Rows that live under a
   * local-only directory (no watchedRoot tracking) keep this NULL.
   */
  watchedRootUrl?: string | null;
  /** v5 runtime-state fields. */
  observedObjEditTime?: number | null;
  syncedObjEditTime?: number | null;
  syncState?: SyncState;
  watchedRootId?: string | null;
  /** Portable, POSIX-style path. P2 owns its full backfill. */
  localRelPath?: string | null;
  missingCompleteCount?: number;
  lastSyncErrorCode?: string | null;
  hasChild?: boolean;
}

/**
 * v0.2.0 structure-align Phase B: local_dirs table row shape.
 *
 * Each row maps a local directory (relative to knowledgeBaseRoot) to its
 * feishu counterpart (or marks the directory as local-only when no
 * feishu node exists). Used by LocalDirTreeView + NodeDetailCard.
 */
export interface LocalDirRecord {
  localPath: string;          // PK, POSIX-style relative path
  title: string;
  parentPath: string | null;
  watchedRootUrl: string | null;
  mappedWikiNodeToken: string | null;
  mappedObjToken: string | null;
  cloudMatch: 'synced' | 'restricted' | 'unknown' | 'local_only';
  autoDetected: number;       // 0 | 1
  sortOrder: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * v0.2.0 structure-align Phase B: watchedRoots top-level structure.
 *
 * Materialized both in SQLite (derived from config + documents table) and
 * in _index.json.watched_roots. The SQLite form carries extra fields for
 * diagnostics (status, lastDetectedAt, childCount, diagnostic).
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
 * Sub-sheet granularity mapping (sheet_sheets table).
 * A single feishu workbook (sheet) holds multiple sub-sheets, each tracked
 * independently for finer-grained change detection.
 */
export interface SheetSheetRecord {
  sheetObjToken: string;
  sheetId: string;
  sheetTitle: string;
  localCsvPath: string;
  localMdPath?: string | null;
  lastSyncedModifyTime?: string | null;
  status: 'synced' | 'changed' | 'error' | 'placeholder';
}

export interface ChangedDocument {
  objToken: string;
  objType: 'docx' | 'sheet' | 'slides' | 'unknown';
  title: string;
  changeType: 'modified' | 'added' | 'deleted';
  cloudModifiedTime: string;
  localSyncedTime: string | null;
  localMdPath: string | null;
  /** v5 observation identity, carried end-to-end without re-querying cloud. */
  wikiNodeToken?: string | null;
  parentNodeToken?: string | null;
  spaceId?: string | null;
  watchedRootId?: string | null;
  hasChild?: boolean;
  observedObjEditTime?: number | null;
  syncState?: SyncState;
  /**
   * Titles of ancestors under the watched root (exclusive of the root and
   * of this node). Used by PathResolver when no existing mapping is present.
   */
  parentChainTitles?: string[];
  /** True when this document is the watched root body itself. */
  isWatchedRootNode?: boolean;
  /** Portable relative path already stored in the database, if any. */
  localRelPath?: string | null;
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

/**
 * A filesystem change planned by the synchronizer before any cloud content
 * is fetched or local state is changed. `blocked` entries are deliberately
 * kept in the manifest so an unsafe path can be reviewed rather than silently
 * falling back to a different target.
 */
export interface PlannedSyncDocument {
  objToken: string;
  title: string;
  objType: 'docx' | 'sheet' | 'slides' | 'unknown';
  changeType: 'modified' | 'added' | 'deleted';
  action: 'create' | 'replace' | 'blocked' | 'move';
  localMdPath: string | null;
  /** Portable POSIX path relative to knowledgeBaseRoot. */
  localRelPath?: string | null;
  previousSha256: string | null;
  /** Stable category for an intentionally non-writable or review-only plan. */
  reasonCode?: SyncPlanReasonCode;
  reason?: string;
  /** Cloud identity and hierarchy retained for auditable triage. */
  watchedRootId?: string | null;
  wikiNodeToken?: string | null;
  parentChainTitles?: string[] | null;
  /** Candidate profile path when a safe write was intentionally blocked. */
  candidateLocalRelPath?: string | null;
  suggestedResolution?: string;
  plannedMoveFrom?: string | null;
  pathSource?: 'existing-mapping' | 'layout-profile' | 'legacy-fallback';
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

export type SyncMode = 'dry-run' | 'apply';

// ============================================================================
// Sync Types
// ============================================================================

export interface SyncResult {
  success: boolean;
  syncedDocuments: SyncedDocument[];
  failedDocuments: FailedDocument[];
  startedAt: string;
  completedAt: string;
  duration: number;
  /** P0 safety gate: requests are dry-runs unless apply is explicitly confirmed. */
  mode?: SyncMode;
  operationId?: string;
  manifestPath?: string;
  plannedDocuments?: PlannedSyncDocument[];
}

export interface SyncOptions {
  enableLLM: boolean;
  fullSync: boolean;
  /** Must be accompanied by confirmation: 'APPLY'; absent/false always dry-runs. */
  apply?: boolean;
  confirmation?: string;
}

export interface ChangeDetectionResult {
  changed: boolean;
  changedDocuments: ChangedDocument[];
  checkedAt: string;
  totalNodes: number;
  /** A partial traversal is observational only and can never create deletion candidates. */
  traversalComplete?: boolean;
  failedNodeTokens?: string[];
  missingCandidates?: number;
}

// ============================================================================
// Mapping API Types (P2-T5/T6/T7/T10, v0.2.0 mapping-core)
// ============================================================================

/**
 * DiffReport returned by GET /api/mapping/diff (03 §3.6.2).
 * Groups changed documents by state + summary statistics for the UI.
 * `unchanged` is a count (not an array) since surfacing every unchanged
 * node to the UI would be noisy; the array form is available via the
 * tree API when needed.
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
 * Flattened node entry in the _index.json snapshot and the
 * GET /api/mapping/tree response (03 §2.4.1 + §3.6.4 + §3.8).
 *
 * The frontend rebuilds the tree client-side using parent_node_token;
 * we keep the array flat to avoid recursion / depth limits in transport
 * and let the UI decide on lazy expansion strategy.
 *
 * sortOrder mirrors documents.local_sort_order (decision 5): null means
 * "user has not reordered, display in Feishu's original order"; non-null
 * is a 0-based weight applied within the same parent scope.
 */
/** Classification for local files that are not (yet) uniquely mapped. */
export type OrphanClassification =
  | 'missing_metadata'
  | 'cloud_match_ambiguous'
  | 'local_only_confirmed'
  | 'ignored_artifact';

export interface OrphanFileEntry {
  /** Portable POSIX path relative to knowledge_base_root. */
  path: string;
  reason: string;
  classification: OrphanClassification;
  /**
   * Legacy cloud_match marker retained for older UI clients.
   * Prefer `classification` for new code.
   */
  cloud_match: 'local_only' | 'unknown';
}

export interface MappingNode {
  obj_token: string;
  wiki_node_token: string | null;
  space_id: string | null;
  obj_type: 'docx' | 'sheet' | 'slides' | 'unknown';
  title: string;
  /**
   * Portable POSIX path relative to knowledge_base_root.
   * Absolute device paths must not appear here (P2-05).
   */
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
   *
   * original_link: feishu wiki URL (clickable). null only when truly
   * unknown (legacy rows); always present for rows indexed from a .md
   * header (which always carries the URL or wiki_node_token).
   *
   * cloud_match: 'synced' | 'restricted' | 'unknown'. The UI uses this
   * to render the appropriate badge and decide whether to render the
   * link as authoritative or as a best-effort guess.
   */
  original_link: string | null;
  cloud_match: 'synced' | 'restricted' | 'unknown';
  /**
   * v0.2.0 structure-align Phase B: the watchedRoot that owns this node.
   *
   * Derived from documents.watched_root_url; present when the row's
   * local_md_path lives under a tracked watchedRoot directory. The
   * frontend uses this to group top-level nodes by watchedRoot in the
   * cloud view. Null when the row is local-only or unclassified.
   */
  watched_root_url: string | null;
}

/**
 * v0.2.0 structure-align Phase B: response envelope for
 * GET /api/mapping/tree?view=feishu|local.
 *
 * The legacy GET /api/mapping/tree returned `{ nodes: MappingNode[] }`.
 * The new endpoint wraps that shape with view metadata + watched_roots
 * so the frontend has everything it needs to render a grouped tree in
 * one round-trip. Backward compat: clients that only read `.nodes` see
 * the same shape as before (with extra per-node fields).
 */
export interface TreeResponse {
  view: 'feishu' | 'local';
  nodes: MappingNode[];
  watched_roots: WatchedRoot[];
  orphan_files: OrphanFileEntry[];
  stats: {
    total_nodes: number;
    watched_root_count: number;
    cloud_match_distribution: Record<string, number>;
  };
}

/**
 * Full _index.json snapshot structure (03 §2.4.1).
 * Written to knowledge_base_root/_index.json as a read-only cache;
 * SQLite remains the write source of truth.
 *
 * v0.2.0 cloud-link-coverage: orphan_files entries carry an explicit
 * cloud_match marker so the UI can distinguish "no feishu correspondence"
 * from a transient parsing failure.
 *
 * v0.2.0 structure-align Phase B: adds `watched_roots` top-level array
 * (one entry per configured watchedRoot) + `mounted_dirs` for local-only
 * directories that exist on disk but are not tracked against any
 * watchedRoot (e.g. _reports/, attachments/).
 */
export interface IndexSnapshot {
  version: string;
  generated_at: string;
  knowledge_base_root: string;
  watched_root_urls: string[];
  /**
   * v0.2.0 structure-align Phase B: materialized watchedRoot records.
   * Built from the configured watchedRoots + documents table state.
   * Each entry includes display_name + status + child_count for the
   * frontend to render top-level groupings without a second round-trip.
   */
  watched_roots: WatchedRoot[];
  /**
   * v0.2.0 structure-align Phase B: local-only directories that exist
   * on disk but are not bound to any watchedRoot. Used by the local
   * view to surface "mounted" top-level entries distinctly from
   * tracked watchedRoots.
   */
  mounted_dirs: Array<{ local_dir: string; reason: string }>;
  top_level_dirs: Array<{ dir: string; node_count: number }>;
  nodes: MappingNode[];
  orphan_files: OrphanFileEntry[];
}

/**
 * Request body for POST /api/mapping/reorder (03 §3.6.5.3, decision 5).
 * parent_node_token is null when reordering top-level nodes.
 * ordered_obj_tokens is the COMPLETE new ordering of the sibling set
 * under that parent; backend assigns 0..N as local_sort_order.
 */
export interface ReorderRequest {
  parent_node_token: string | null;
  ordered_obj_tokens: string[];
}

export interface ReorderResponse {
  updated: number;
  refreshed_index: boolean;
}

// ============================================================================
// LarkCli Types
// ============================================================================

export interface LarkCliNodeInfo {
  node_token: string;
  obj_token: string;
  obj_type: 'docx' | 'sheet' | 'slides' | 'bitable' | 'mindnote' | 'file' | 'unknown';
  title: string;
  space_id: string;
  // Unix seconds. null when lark-cli returns a non-numeric value (empty
  // string / undefined for permission-restricted or missing fields). The
  // NaN-defense coercion lives in lark-cli-client.getNode; upstream
  // consumers (change-detector.compareWithLocalRecords) treat null as
  // "unknown" and skip the modified branch (see diagnosis §2.2 根因 D).
  obj_edit_time: number | null;
  has_child: boolean;
  /**
   * v0.2.0: parent_node_token is returned by both `wiki +node-list`
   * (P0-Q2 实测 confirmed present in lark-cli 1.0.53 output) and
   * `wiki +node-get`. Optional because some legacy call paths and
   * root-node resolutions may not supply it.
   */
  parent_node_token?: string;
}

export interface LarkCliConfig {
  larkCliPath?: string;
  requiredScopes: string[];
  timeout: number;
}

// ============================================================================
// Layout Reconstructor Types (for M3)
// ============================================================================

export interface BlockType {
  type: 'metadata' | 'hierarchy' | 'datatable' | 'paragraph' | 'sparse';
  confidence: number;
}

export interface ReconstructedBlock {
  originalRange: { start: number; end: number };
  type: BlockType;
  markdown: string;
}

/**
 * @deprecated v0.2.0 P3: use `AdaptOptions`/`AdaptOutput` from
 * `modules/content-backend.js`. This type is retained only for type
 * compatibility with code that has not yet been migrated.
 */
export interface AdaptOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  enableStreaming?: boolean;
  onProgress?: (chunk: string) => void;
}

/** @deprecated v0.2.0 P3: use AdaptOutput from content-backend.js. */
export interface AdaptResult {
  adaptedMarkdown: string;
  tokensUsed: number;
  duration: number;
  model: string;
}
