/**
 * Shared TypeScript type definitions for feishu-sync server
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface Config {
  llm: LLMConfig;
  pollIntervalMinutes: number;
  knowledgeBaseRoot: string;
  watchedRootUrls: string[];
  larkCliPath?: string;
  requiredScopes: string[];
  enableAutoStart: boolean;
  enableNotifications: boolean;
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: 'deepseek-chat' | 'deepseek-reasoner';
  temperature: number;
}

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
}

/**
 * Full _index.json snapshot structure (03 §2.4.1).
 * Written to knowledge_base_root/_index.json as a read-only cache;
 * SQLite remains the write source of truth.
 */
export interface IndexSnapshot {
  version: string;
  generated_at: string;
  knowledge_base_root: string;
  watched_root_urls: string[];
  top_level_dirs: Array<{ dir: string; node_count: number }>;
  nodes: MappingNode[];
  orphan_files: Array<{ path: string; reason: string }>;
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

export interface AdaptOptions {
  baseUrl: string;
  apiKey: string;
  model: 'deepseek-chat' | 'deepseek-reasoner';
  temperature: number;
  enableStreaming: boolean;
  onProgress?: (chunk: string) => void;
}

export interface AdaptResult {
  adaptedMarkdown: string;
  tokensUsed: number;
  duration: number;
  model: string;
}
