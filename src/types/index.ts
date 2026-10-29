/**
 * Frontend type definitions
 * Reuses server types where applicable
 */

import type { AgentConfig, StandardKbConfig } from './agent';

export type { AgentConfig, StandardKbConfig } from './agent';

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
  requiredScopes: string[];
  enableAutoStart: boolean;
  enableNotifications: boolean;
  /** F2 Agent 标准知识库（设计 §5.2；旧配置缺省时由服务端补默认值）。 */
  agent?: AgentConfig;
  standardKb?: StandardKbConfig;
  /** S12 飞书写回开关段（默认关；服务端校验，缺省视为 false）。 */
  feishuWrite?: { enabled: boolean };
  /** P1-S8/S9 反向发布段（默认关；与 feishuWrite 同只接受 desktop 链路修改，
   * 发布根设置走专用端点 PUT /api/kb/publish/target，不经本段落盘）。 */
  feishuPublish?: {
    enabled: boolean;
    target?: {
      kind: 'drive_folder' | 'wiki_node';
      token: string;
      spaceId?: string;
      label: string;
    } | null;
  };
  /** P1-S5/P0-S6 同步行为段（媒体采集开关；缺省由服务端补）。 */
  sync?: SyncConfig;
}

/** One model preset inside a provider's OpenAI-compatible route. */
export interface LlmModelPreset {
  id: string;
  name: string;
  openAiModel: string;
  enabled: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** 该预设是否支持图片输入（仅 UI 提示用途；S2 vision 通道不依赖此字段判定可用性） */
  supportsImages?: boolean;
}

/** A remotely hosted model provider configured in Settings. */
export type LlmProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface LlmProviderConfig {
  openAiProtocol?: 'openai-completions' | 'openai-responses';
  protocolBaseUrls?: Partial<Record<LlmProtocol, string>>;
  /** Missing in older configs means OpenAI Chat Completions. */
  protocol?: LlmProtocol;
  id: string;
  name: string;
  enabled: boolean;
  apiKey: string;
  openAiCompatBaseUrl: string;
  defaultModelId?: string;
  models: LlmModelPreset[];
}

/**
 * 远程模型提供商配置（v0.2.9 起仅 direct 通道）。
 *
 * claude-cli / opencode 本地无头通道已移除；`providers` 是权威配置，
 * flat endpoint/key/model 字段为旧配置文件与旧调用方保留的兼容投影。
 */
export interface LlmConfig {
  /** Runtime projection of the active provider protocol. */
  protocol?: LlmProtocol;
  /** OpenAI-protocol adapter base URL (DirectChannel/OpenAI SDK). */
  openAiCompatBaseUrl: string;
  /** Provider credential (bearer key). */
  apiKey: string;
  /** Model alias valid at the OpenAI-compat endpoint. */
  model: string;
  /** Optional per-channel model alias override for the direct channel. */
  directModel?: string;
  /** Sampling temperature 0.0-1.0. Default 0.2. */
  temperature: number;
  /** User-configured remote model providers. */
  providers?: LlmProviderConfig[];
  /** Currently selected remote provider for the direct channel. */
  activeProviderId?: string;
  /** Currently selected model preset within the active provider. */
  activeModelId?: string;
  /** Optional shared timeout used by remote channels (milliseconds). */
  timeoutMs?: number;
  /** Explicit opt-in: reorganise Markdown bodies during sync. */
  contentAdaptationEnabled?: boolean;
  /** v0.2.9 起恒为 'direct'（旧取值由服务端读取时归一）。 */
  primaryChannel: 'direct';
  /** @deprecated 单通道时代无效果，仅为旧配置兼容保留。 */
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
  xlsxMissing?: boolean;
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
  watchedRootUrl?: string | null;
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
  /** 媒体完整性核对产出的补齐信号，非云端编辑。 */
  mediaGapReason?: 'local_placeholder_tags' | 'sheet_cloud_images_missing';
  /** P2-S8：检测链折叠为 'unknown' 前的真实云端类型（mindnote/file 等），仅未知类型携带。 */
  cloudObjType?: string;
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
  sheetAcquisition?: 'native' | 'read-reconstruction' | 'csv-fallback';
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
  /** P2-S8：未知类型 blocker（reasonCode='unsupported_type'）的真实云端类型。 */
  cloudObjType?: string;
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
  | 'upstream_error'
  | 'local_edit_pending'
  | 'cloud_operation_pending'
  | 'source_moved_out';

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
  /** P2-S8：unsupported_type blocker 的真实云端类型透传。 */
  cloudObjType?: string;
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
  /** S12：写回 scope（docx:document:write_only）是否已授权（写回入口引导用）。 */
  writeScopesGranted?: boolean;
  /** P1-S5：可选读 scope 分档（granted/missing 对照注册表）。缺失不判定为
   *  授权不完整；设置页据「开关开启 ∧ missing 非空」提示增量授权。 */
  optionalScopes?: { granted: string[]; missing: string[] };
  error?: string;
  identity?: string;
  verified?: boolean;
  account?: { id: string; name?: string };
}

/** 同步行为段（additive；旧配置无此段时由服务端内存补默认）。
 *  契约：P1-S5 slidesScreenshot（缺省 false）/ P0-S6 whiteboardExport
 *  （缺省 enabled=true；svgTimeoutMs 非正有限数在服务端归一时剔除）。 */
export interface SyncConfig {
  /** 幻灯片整页截图采集（需额外授权 slides:presentation:screenshot）。 */
  slidesScreenshot?: { enabled: boolean };
  /** 白板旁路导出（svg 主 + raw 降级，失败只告警不阻断同步）。 */
  whiteboardExport?: { enabled: boolean; svgTimeoutMs?: number };
}

// ============================================================================
// 源编辑与写回（S11/S12 API 消费，S13 UI）——镜像 server/src/types/index.ts
// ============================================================================

export type SourceEditState = 'dirty' | 'pushing' | 'pushed' | 'conflict';
export type SourceEditActorKind = 'ui' | 'cli' | 'agent' | string;

/** GET /api/sources/:objToken/edit-status 响应（预览面板 OCC 入口）。 */
export interface SourceEditStatus {
  objToken: string;
  relPath: string;
  title: string;
  /** 当前正文（不含 feishu_sync 头）的 sha256；编辑保存时作 baseHash。 */
  bodyHash: string;
  /** 无编辑行时为 null（此时 bodyHash 即编辑基线）。 */
  editState: SourceEditStateDto | null;
}

export interface SourceEditStateDto {
  objToken: string;
  relPath: string;
  title: string;
  state: SourceEditState;
  bodyHash: string;
  baseBodyHash: string;
  editCount: number;
  lastActor: SourceEditActorKind;
  error: null | { code: string; message: string };
  updatedAt: string;
}

/** POST /api/sources/:objToken/edit 响应。 */
export interface SourceEditResult {
  bodyHash: string;
  state: SourceEditStateDto;
}

/** POST /api/sources/:objToken/push/preview 响应（S12）。 */
export interface SourcePushPlan {
  unknownPushUpdatedAt?: string | null;
  mode: 'append' | 'overwrite' | 'blocked';
  blockedReason?:
    | 'no_changes'
    | 'overwrite_required'
    | 'overwrite_unsupported'
    | 'images_in_append'
    | 'images_in_overwrite'
    | 'write_disabled'
    | 'write_scope_missing'
    /** P0-S3：overwrite 取不到云端历史回退锚点（force 不可越过）。 */
    | 'rollback_anchor_unavailable'
    /** P0-S4：该文档有进行中的云端回滚（互斥门）。 */
    | 'cloud_revert_running';
  appendMarkdown?: string;
  bytes: number;
  cloud: { objEditTime: string | null; revisionId: number | null };
  /** 云端 obj_edit_time 已越过 base_obj_edit_time（需 force 决策）。 */
  conflict: boolean;
  warnings: string[];
  /**
   * P0-S3 写前回退锚点（preview 实际调用一次 history-list，只读）：
   * 第 1 页最新条目；取锚失败为 null（append 照常推送 + warning，
   * overwrite 升级 blocked + anchorBlockedReason）。
   */
  rollbackAnchor?: {
    historyVersionId: string;
    revisionId: number | null;
    historyTime: string | null;
    /** U23：false = 锚点历史早于写前云端状态，回滚会一并撤销此期间修改。 */
    exact: boolean;
  } | null;
  /** 与 blockedReason='rollback_anchor_unavailable' 同值，独立字段便于 UI 判因。 */
  anchorBlockedReason?: 'rollback_anchor_unavailable';
}

/** POST /api/sources/:objToken/push 响应（S12）。 */
export interface SourcePushResult {
  state: SourceEditState | 'pushed';
  mode: 'append' | 'overwrite';
  revisionId: number | null;
  pull: { ok: boolean; status: string; message?: string };
}

// ============================================================================
// P2-S7 移出 UI（消费 P2-S6 后端契约）——镜像 server 侧 DTO
// ============================================================================

/**
 * 移出门控分支（server CloudMoveBlockedReason 七分支 + 查询期 404 文档
 * 不在库中共八分支；UI 以可读文案映射呈现，服务端门控兜底）。
 */
export type CloudMoveBlockedReason =
  | 'not_watched_root'
  | 'has_children'
  | 'node_not_found'
  | 'local_edit_pending'
  | 'cloud_revert_running'
  | 'cloud_move_running'
  | 'kb_build_active'
  | 'source_not_found';

/** POST /api/sources/:objToken/move-to-drive/preview 响应。 */
export interface MoveOutPreview {
  objToken: string;
  title: string;
  /** 权威 wiki node token（确认值 `MOVE_OUT:<nodeToken>` 的派生源）。 */
  nodeToken: string;
  watchedRootId: string | null;
  watchedRootLabel: string;
  hasChildren: boolean;
  target: { folderToken: string | null; label: string };
  /** 后果固定文案（预览与确认弹窗原样展示，设计 §3.4）。 */
  consequences: string[];
  blockedReason: CloudMoveBlockedReason | null;
}

/** POST /api/sources/:objToken/move-to-drive 响应（200 moved / 202 moving）。 */
export interface MoveOutExecutionResult {
  state: 'moved' | 'moving';
  moveId: string;
  taskId: string | null;
  nodeToken: string;
}

/** cloud_moves 行 camelCase 投影（GET /api/sources/moves[:id]）。 */
export interface CloudMoveRecord {
  id: string;
  objToken: string;
  wikiNodeToken: string;
  watchedRootId: string | null;
  title: string | null;
  targetFolderToken: string | null;
  /** 状态机：pending（起步）→ moving → moved / failed / unknown。 */
  state: 'pending' | 'moving' | 'moved' | 'failed' | 'unknown' | string;
  taskId: string | null;
  error: string | null;
  /** ui | cli。 */
  actor: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// P0-S5 回滚 UI（消费 P0-S3/S4 后端契约）——镜像 server 侧 DTO
// ============================================================================

/** source_push_log 行 camelCase 投影（GET /api/sources/:objToken/push-log 项）。 */
export interface SourcePushLogRecord {
  id: string;
  objToken: string;
  localRelPath: string;
  /** append|overwrite|revert（revert 行由云端历史回滚写入，本身也可再回滚）。 */
  mode: 'append' | 'overwrite' | 'revert' | string;
  /** ui|cli|agent。 */
  actor: string;
  preObjEditTime: string | null;
  /** 写回前最新 history_version_id（回滚锚点；无锚行不可回滚）。 */
  anchorHistoryId: string | null;
  anchorHistoryTime: string | null;
  /** 锚点历史时间 ≥ 写前云端时间（U23；false 时回滚是近似回退）。 */
  anchorExact: boolean;
  /** 取锚失败原因（仅 append 可空锚继续）。 */
  anchorError: string | null;
  postRevisionId: string | null;
  postObjEditTime: string | null;
  /** started|pushed|conflict|failed|unknown。 */
  outcome: 'started' | 'pushed' | 'conflict' | 'failed' | 'unknown' | string;
  /** null|running|done|failed|unknown（该行发起的云端回滚状态）。 */
  revertState: 'running' | 'done' | 'failed' | 'unknown' | null | string;
  revertHistoryId: string | null;
  revertTaskId: string | null;
  revertError: string | null;
  revertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** docs +history-list 单条历史条目（GET /api/sources/:objToken/history 项）。 */
export interface CloudHistoryEntry {
  historyVersionId: string | null;
  revisionId: number | null;
  /** RFC3339Z（秒级取整）。 */
  editTime: string | null;
  /** 编辑者 open_id（上游无姓名字段）。 */
  editorIds: string[];
  /** 1=建档 / 2=普通编辑 / 3=revert 产生的历史。 */
  type: number | null;
}

/** GET /api/sources/:objToken/history 响应（缺省聚合 3 页，truncated 可续翻）。 */
export interface CloudHistoryListResult {
  entries: CloudHistoryEntry[];
  hasMore: boolean;
  nextPageToken: string | null;
  /** true = 因页数上限截断（nextPageToken 非空，可继续翻页）。 */
  truncated: boolean;
}

export type HistoryRevertBlockedReason =
  | 'write_disabled'
  | 'scope_missing'
  | 'local_edit_pending'
  | 'kb_build_active'
  | 'cloud_revert_running'
  | 'anchor_missing'
  | 'history_not_found'
  | 'invalid_target';

export type HistoryRevertWarning =
  | 'anchor_inexact'
  | 'cloud_changed_since_push'
  | 'cloud_time_unreadable';

/** POST /api/sources/:objToken/history-revert/preview 响应。 */
export interface HistoryRevertPlan {
  objToken: string;
  target: {
    historyVersionId: string;
    createdAt: string | null;
    editorName: string | null;
    editorIds: string[];
  };
  source: 'push_log' | 'history';
  /** 仅 source='push_log'（U23 锚点精确性）；history 源为 null。 */
  anchorExact: boolean | null;
  warnings: HistoryRevertWarning[];
  blockedReason: HistoryRevertBlockedReason | null;
}

/** POST /api/sources/:objToken/history-revert 响应（202 异步起步 / 200 同步完成）。 */
export interface HistoryRevertExecutionResult {
  state: 'done' | 'running' | 'failed';
  pushLogId: string;
  taskId: string | null;
  targetHistoryVersionId: string;
  failedBlockTokens?: string[];
  partialFailure?: boolean;
  /** 仅 state='done'（锁外回拉结果；失败只记 warning，交检测链收敛）。 */
  pull: { ok: boolean; status: string; message?: string } | null;
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
  /** 持久同步状态，待同步身份不等同于已落盘文档。 */
  sync_state?: string;
  sync_blocked?: boolean;
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
 * GET /api/mapping/content/:objToken 响应（v0.2.8 布局重构 批次1）。
 * mdContent 为 null 表示索引引用了文件但磁盘上不存在（尚未同步）；
 * sheet 文档的原始表格在 csvTables 中（`<stem>.csv-data/*.csv`）。
 */
export interface DocumentContent {
  objToken: string;
  title: string;
  objType: string;
  /** 知识库根目录相对的 POSIX 路径；索引中无路径时为 null。 */
  mdPath: string | null;
  mdContent: string | null;
  mdTruncated: boolean;
  csvTables: DocumentCsvTable[];
  /** Native sheet source; absent on historical CSV-only exports. */
  workbook?: { path: string; size: number; modifiedTime: string; mode?: 'native' | 'read-reconstruction' } | null;
  sheetStatus?: { acquisition: 'native' | 'read-reconstruction' | 'unknown-excel' | 'csv-fallback' | 'legacy-csv' | 'unavailable'; workbookMayBeOlder: boolean; syncedAt: string | null; cloudEditTime?: number | null; approximations: string[] } | null;
  /**
   * P1-S3/S4：被引用关系（入边，服务端返回）；目标双键反查，附引用方
   * title/相对路径（源行已删时为 null）。
   */
  referencedBy?: DocumentIncomingReference[];
  /** P1-S4：出边引用（已解析到本地文档行；未入本库的目标 objToken 为 null）。 */
  references?: DocumentOutgoingReference[];
}

/** P1-S3：入边行（GET /api/mapping/content referencedBy 元素）。 */
export interface DocumentIncomingReference {
  srcObjToken: string;
  targetToken: string;
  targetType: string;
  label: string | null;
  origin: 'body' | 'refmap';
  kind: string;
  occurrences: number;
  updatedAt: string;
  srcTitle: string | null;
  srcLocalRelPath: string | null;
}

/** P1-S4：出边行（GET /api/mapping/content references 元素）。 */
export interface DocumentOutgoingReference {
  direction: 'out';
  token: string;
  targetType: string;
  origin: 'body' | 'refmap';
  kind: string;
  title: string | null;
  occurrences: number;
  objToken: string | null;
  localRelPath: string | null;
  synced: boolean;
}

export interface DocumentCsvTable {
  /** 去扩展名的表名（sheet 子表名）。 */
  name: string;
  /** 知识库根目录相对的 POSIX 路径。 */
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * GET /api/mapping/comments/:objToken 响应（P2-S4 评论溯源）。
 * collected=false 表示从未采集（非 docx 或未成功同步过），前端隐藏评论区；
 * truncated=true 表示云端截断（UI 显示「可能不完整」）。
 */
export interface DocumentComments {
  objToken: string;
  collected: boolean;
  total: number;
  truncated: boolean;
  updatedAt: string | null;
  comments: Array<{
    commentRef: string;
    text: string;
    quote: string | null;
    author: string | null;
    createdAtCloud: string | null;
    solved: boolean | null;
  }>;
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

export type ChannelName = 'direct';

/**
 * Connectivity test request body for POST /api/llm/test-channel.
 *
 * Backend contract（v0.2.9 单通道）：channel='direct'，向 OpenAI 兼容端点
 * 发送一条 tiny hello prompt（默认 10 分钟容忍，超时结构化返回）。
 */
export interface ChannelTestRequest {
  channel: ChannelName;
  llm: Pick<
    LlmConfig,
    | 'openAiCompatBaseUrl'
    | 'apiKey'
    | 'model'
    | 'directModel'
    | 'temperature'
    | 'timeoutMs'
    | 'providers'
    | 'activeProviderId'
    | 'activeModelId'
  >;
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
  /** 平台能力与真实应用版本（electron/main.ts desktop:get-platform-capabilities）。 */
  getPlatformCapabilities: () => Promise<DesktopPlatformCapabilities>;
  update: {
    getState: () => Promise<DesktopUpdateState>;
    check: () => Promise<DesktopUpdateCheckResult>;
    download: () => Promise<DesktopActionResult>;
    installAndRestart: () => Promise<DesktopActionResult>;
    onEvent: (callback: (event: DesktopUpdateEvent) => void) => () => void;
  };
  openDataDirectory: () => Promise<DesktopActionResult>;
  /** F2 Agent Workspace：原生目录选择（设计 §9.4）；取消返回 null。路径合法性只由后端校验。 */
  selectDirectory: () => Promise<string | null>;
  openConfigFile: () => Promise<DesktopActionResult>;
  /** 在系统默认浏览器打开外部 URL（仅 http/https，与 electron/main.ts 白名单对应）。 */
  openExternal: (url: string) => Promise<DesktopActionResult>;
  /** 在系统文件管理器中定位并选中文件（绝对路径；父目录则直接打开）。 */
  revealInFolder: (absolutePath: string) => Promise<DesktopActionResult>;
  /** 界面缩放（layoutZoomLevel，夹在 -3..3）；高分屏文本模糊时微调。 */
  setZoomLevel: (level: number) => void;
  getZoomLevel: () => number;
}

/**
 * 2026-09 对齐修复：以下 DesktopUpdate 系列与 DesktopActionResult 类型此前
 * 与 electron/contracts.ts 分叉（前端用 state、version、available，主进程实际
 * 返回 phase、latestVersion、{ok,state}），导致「关于与更新」卡片永远读不到
 * 真实更新状态。现在与主进程契约逐字段对齐；修改任一侧时必须同步另一侧
 * （electron/contracts.ts + desktop-contracts.ts + 此处）。
 */
export type DesktopActionResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

/** 平台能力快照（electron app.isPackaged / app.getVersion / 发布页地址等）。 */
export interface DesktopPlatformCapabilities {
  platform: string;
  arch: string;
  appVersion: string;
  packaged: boolean;
  systemTraySupported: boolean;
  hideOnCloseSupported: boolean;
  backgroundResidentSupported: boolean;
  singleInstanceSupported: boolean;
  updateCheckSupported: boolean;
  updateDownloadSupported: boolean;
  updateInstallSupported: boolean;
  updateInstallUnsupportedReason?: string;
  updateProvider: 'generic';
  releasePageUrl: string;
}

export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'up-to-date'
  | 'error'
  | 'unsupported';

export interface DesktopUpdateInfo {
  version: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: string;
}

export interface DesktopDownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  currentVersion?: string;
  latestVersion?: string;
  updateInfo?: DesktopUpdateInfo;
  progress?: DesktopDownloadProgress;
  error?: string;
  lastCheckedAt?: string;
}

export type DesktopUpdateCheckResult =
  | { ok: true; state: DesktopUpdateState }
  | { ok: false; code: string; error: string; state: DesktopUpdateState };

export type DesktopUpdateEvent =
  | { type: 'state'; state: DesktopUpdateState }
  | { type: 'progress'; state: DesktopUpdateState; progress: DesktopDownloadProgress };

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

/**
 * 左侧树跳转导航目标（快捷添加 / 设置管理「跳转查看」用）。
 * - group：激活书签条对应分组（key 为 watchedRoot.url / 内置分组 key）；
 * - custom-doc：切到自定义归档分组、展开目标文件夹、滚动定位并选中该文档。
 */
export type TreeNavTarget =
  | { kind: 'group'; key: string }
  | { kind: 'custom-doc'; folderId: string; objToken: string };

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
