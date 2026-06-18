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
