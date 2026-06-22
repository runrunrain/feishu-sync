/**
 * Shared TypeScript type definitions for feishu-sync server
 */

// ============================================================================
// Configuration Types
// ============================================================================

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
  watchedRootUrls: string[];
  larkCliPath?: string;
  requiredScopes: string[];
  enableAutoStart: boolean;
  enableNotifications: boolean;
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
}

export interface SyncOptions {
  enableLLM: boolean;
  fullSync: boolean;
}

export interface ChangeDetectionResult {
  changed: boolean;
  changedDocuments: ChangedDocument[];
  checkedAt: string;
  totalNodes: number;
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
}

/**
 * Full _index.json snapshot structure (03 §2.4.1).
 * Written to knowledge_base_root/_index.json as a read-only cache;
 * SQLite remains the write source of truth.
 *
 * v0.2.0 cloud-link-coverage: orphan_files entries carry an explicit
 * cloud_match marker so the UI can distinguish "no feishu correspondence"
 * from a transient parsing failure.
 */
export interface IndexSnapshot {
  version: string;
  generated_at: string;
  knowledge_base_root: string;
  watched_root_urls: string[];
  top_level_dirs: Array<{ dir: string; node_count: number }>;
  nodes: MappingNode[];
  orphan_files: Array<{ path: string; reason: string; cloud_match: 'local_only' }>;
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
  obj_edit_time: number; // Unix seconds
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
