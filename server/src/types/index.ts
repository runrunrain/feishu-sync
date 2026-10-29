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

import type { AgentConfig, StandardKbConfig } from './agent-knowledge.js';

/**
 * CLI 命令行访问配置段（S8，additive）：缺省关闭；旧配置无此段时由
 * ConfigManager 读取时补默认（内存态），不主动回写磁盘。
 */
export interface CliConfig {
  /** 是否开启命令行访问（endpoint.json 发布 + /api/cli/* 命令域）。 */
  enabled: boolean;
}

/**
 * 同步行为配置段（P1-S5，additive，设计 §3.2）：旧配置无此段时由
 * ConfigManager 读取时补默认（内存态），不参与迁移回写。
 */
export interface SyncConfig {
  /**
   * 幻灯片逐页截图采集（U36/U37）：默认关闭。开启后同步侧仅在当前
   * 授权已含可选读 scope（slides:presentation:screenshot）时才采集；
   * 缺失时合法跳过（正文与关闭时逐字节一致）。授权经 OPTIONAL_READ_SCOPES
   * 注册表并入 device flow 请求基线（lark-cli-manager.ts）。
   */
  slidesScreenshot: { enabled: boolean };
  /**
   * P0-S6 白板旁路导出（设计 §5.3 + P0-S1 HP-4 裁定：svg 主产物 + raw
   * 降级）。缺省开启：旁路文件不被 md 引用，失败只告警不阻断提交。
   * svgTimeoutMs 是 whiteboard +export --output-type svg 的调用方超时
   * 预算（svg 服务端渲染超时 ~6.5s，内容相关，P0-S1 实测）；缺省用
   * lark-cli 执行层默认预算。
   */
  whiteboardExport: {
    enabled: boolean;
    svgTimeoutMs?: number;
  };
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
  /** 同步行为（P1-S5，additive，可选：旧配置内存补默认）。 */
  sync?: SyncConfig;
  /** Agent 标准知识库（F1，additive）：旧配置无此段时由 ConfigManager 补默认。 */
  agent: AgentConfig;
  /** 标准库输出与构建参数（F1，additive）。 */
  standardKb: StandardKbConfig;
  /** CLI 命令行访问（S8，additive，可选：旧配置内存补默认）。 */
  cli?: CliConfig;
  /** 飞书写回（S12，additive，可选：旧配置内存补默认 enabled=false）。 */
  feishuWrite?: FeishuWriteConfig;
  /** 反向发布（P1-S8，additive，可选：旧配置内存补默认 enabled=false）。 */
  feishuPublish?: FeishuPublishConfig;
  pollIntervalMinutes: number;
  knowledgeBaseRoot: string;
  /** Authoritative P2 root configuration. */
  watchedRoots: WatchedRootConfig[];
  /**
   * Compatibility projection for pre-P2 callers. ConfigManager derives this
   * from `watchedRoots` in memory and no longer persists it to disk.
   */
  watchedRootUrls: string[];
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
 * A model preset belonging to one remote provider.
 *
 * Agent 与标准库构建按提供商协议调用预设模型；原始文档整理的 direct
 * 通道仍使用 OpenAI Chat Completions。
 */
export interface LlmModelPreset {
  /** Stable local identifier; unique within the provider. */
  id: string;
  /** Human-readable label shown in Settings. */
  name: string;
  /** Model passed to the direct/OpenAI-compatible channel. */
  openAiModel: string;
  /** Disabled presets remain saved but cannot be selected at runtime. */
  enabled: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevels?: import('./agent-knowledge.js').AgentThinkingLevel[];
  /** 仅 UI 提示用途（识图模型下拉标记），不影响任何运行时模型选择。 */
  supportsImages?: boolean;
}

/**
 * A remotely hosted model provider and its model presets.
 *
 * Keys remain local to this application. They are redacted by GET
 * /api/config and retain the same plaintext-on-disk warning as the legacy
 * `llm.apiKey` field until secure-storage support is introduced.
 */
export type LlmProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface LlmProviderConfig {
  /** Anthropic credentials share apiKey; missing preserves legacy x-api-key authentication. */
  anthropicAuthType?: 'api-key' | 'auth-token';
  openAiProtocol?: 'openai-completions' | 'openai-responses';
  protocolBaseUrls?: Partial<Record<LlmProtocol, string>>;
  /** Missing in older configs means OpenAI Chat Completions. */
  protocol?: LlmProtocol;
  /** Stable local identifier; unique across providers. */
  id: string;
  /** Human-readable provider name, for example "智谱 GLM". */
  name: string;
  /** Disabled providers remain editable but are never chosen at runtime. */
  enabled: boolean;
  /** Credential accepted by this provider's configured endpoints. */
  apiKey: string;
  /** OpenAI-compatible base URL used by the direct channel. */
  openAiCompatBaseUrl: string;
  /** Preferred preset within this provider when no explicit active preset exists. */
  defaultModelId?: string;
  /** Provider-owned model aliases. */
  models: LlmModelPreset[];
}

/**
 * Shared LLM channel configuration.
 *
 * `providers` is the authoritative multi-provider configuration. The flat
 * endpoint/key/model fields are intentionally retained as a backward-
 * compatible projection for existing config files and integrations. Runtime
 * channels resolve the active provider/preset first, then use these legacy
 * values only when no provider profile is configured.
 */
export interface LlmConfig {
  /** Runtime projection of the selected provider's Anthropic authentication. */
  anthropicAuthType?: 'api-key' | 'auth-token';
  /** Runtime projection of the active provider protocol. */
  protocol?: LlmProtocol;
  /** OpenAI-protocol adapter base URL (DirectChannel/OpenAI SDK). */
  openAiCompatBaseUrl: string;
  /** Provider credential (bearer key). */
  apiKey: string;
  /** Model alias used at the OpenAI-compat endpoint (e.g. glm-4-flash). */
  model: string;
  /** Optional per-channel model override for the direct channel. */
  directModel?: string;
  /** Sampling temperature 0.0-1.0. Default 0.2. */
  temperature: number;
  /** Saved remote providers. Existing flat configs are migrated to GLM here. */
  providers?: LlmProviderConfig[];
  /** The remote provider currently used by the direct channel. */
  activeProviderId?: string;
  /** The model preset currently used within `activeProviderId`. */
  activeModelId?: string;
  /**
   * Per-call LLM adaptation timeout in milliseconds.
   *
   * Default 600000 (10 minutes). Remote models routinely take 1-3 minutes
   * for a single feishu doc adaptation under load, and endpoints
   * occasionally return transient over-load responses that the SDK retries
   * internally. A 60s timeout was too aggressive; the 10-minute default
   * gives the model ample headroom while still bounding worst-case latency.
   *
   * Used by sync-engine when calling ContentAdapter.adaptContent.
   * Per-call AdaptOptions.timeoutMs still overrides this value.
   */
  timeoutMs?: number;
  /**
   * Explicit opt-in for document organisation during sync. Keeping this
   * separate from the channel selection prevents a saved LLM setting from
   * silently changing document bodies on a later sync.
   */
  contentAdaptationEnabled?: boolean;
  /**
   * v0.2.9 起 claude-cli / opencode 通道已移除，恒为 'direct'。
   * 旧配置中的其他取值由 config-manager 读取时归一为 'direct'。
   */
  primaryChannel: 'direct';
  /**
   * v0.2.9 起无第二通道可回退，字段保留仅为旧配置兼容（读取后忽略）。
   * @deprecated 单通道时代无效果。
   */
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
  /** Blocked until the operator explicitly rechecks a Feishu-side repair. */
  | 'feishu_pending'
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
  objType: 'docx' | 'sheet' | 'slides' | 'bitable' | 'unknown';
  /**
   * P2-S8（设计 §4.3/U50）：normalizeObjType 折叠为 'unknown' 之前的原始
   * 云端 obj_type（mindnote/file 等）。仅折叠路径携带——已支持类型与
   * 真实类型不可得（DB 折叠值/'unknown'）时为 undefined，保证已支持类型
   * 的可观察输出（API JSON/manifest）字节级不变。
   */
  cloudObjType?: string;
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
  objType: 'docx' | 'sheet' | 'slides' | 'bitable' | 'unknown';
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
  /**
   * Why a pending_modified row is pending, when the reason is NOT a cloud
   * edit. Currently only media-gap detection writes this (values are the
   * concrete MediaGapReason: 'local_placeholder_tags' |
   * 'sheet_cloud_images_missing'). Semantics:
   *   - polling (observed == synced) must NOT wash the row back to synced;
   *   - a genuine cloud edit (observed > synced), a successful sync
   *     (markDocumentSynced) or a custom-folder ownership move clears it;
   *   - stored diff / detect responses project it as ChangedDocument
   *     .mediaGapReason so the UI can group media-gap docs separately.
   */
  pendingReason?: string | null;
  watchedRootId?: string | null;
  /** Portable, POSIX-style path. P2 owns its full backfill. */
  localRelPath?: string | null;
  missingCompleteCount?: number;
  lastSyncErrorCode?: string | null;
  hasChild?: boolean;
  /**
   * Custom-folder archive: when non-null, this document was added via the
   * quick-add flow into a custom folder (custom_folders.id). Such rows keep
   * watched_root_url/watched_root_id NULL because they are not part of any
   * synced structure tree.
   */
  customFolderId?: string | null;
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
  xlsxMissing?: boolean;
  objToken: string;
  objType: 'docx' | 'sheet' | 'slides' | 'bitable' | 'unknown';
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
  watchedRootUrl?: string | null;
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
  /**
   * Custom-folder archive: when non-null, this document belongs to a user-
   * created custom folder and is NOT part of any synced watched-root tree.
   * The sync planner bypasses watchedRoot validation for such docs and
   * reuses their existing _custom/ local path.
   */
  customFolderId?: string | null;
  /** 媒体完整性核对产出的补齐信号，非云端编辑。 */
  mediaGapReason?: 'local_placeholder_tags' | 'sheet_cloud_images_missing';
  /**
   * P2-S8（设计 §4.3/U50）：检测遍历折叠为 'unknown' 前的真实云端类型
   * （mindnote/file 等）。仅未知类型携带（透传给 unsupported_type blocker
   * 详情与 UI 文案）；已支持类型不携带，可观察输出零变化。
   */
  cloudObjType?: string;
}

/**
 * Discriminant for DocumentRecord.pendingReason values that describe a
 * media-gap repair pending. Guards projections so any future non-media
 * pending_reason value can never be mis-badged as a media-gap doc.
 */
export function isMediaGapReason(
  value: unknown,
): value is NonNullable<ChangedDocument['mediaGapReason']> {
  return value === 'local_placeholder_tags' || value === 'sheet_cloud_images_missing';
}

export interface SyncedDocument {
  performance?: import('../modules/sync-performance.js').SyncPerformance;
  sheetAcquisition?: 'native' | 'read-reconstruction' | 'csv-fallback';
  objToken: string;
  title: string;
  localMdPath: string;
  cloudModifiedTime: string;
  size: number;
  imagesCount: number;
  attachmentsCount: number;
  sheetsCount: number;
  /**
   * P1-S3（设计 P1 §2.1）：该文档引用边超 500 上限被截断时为 true
   * （同步警告 references_truncated 的结果面投射；边照常入库，不阻断）。
   */
  referencesTruncated?: boolean;
}

export interface FailedDocument {
  objToken: string;
  title: string;
  error: string;
  retryable: boolean;
  /**
   * Stable failure category shown by the result UI.  Planning failures reuse
   * SyncPlanReasonCode; runtime failures add the small operational set below.
   */
  reasonCode?: SyncFailureReasonCode;
  /** A user-facing next step; never expose an upstream stack trace here. */
  suggestedResolution?: string;
  /** Whether the application can safely perform the next step itself. */
  repairAction?: SyncRepairAction;
  /** Retained so a structural repair can re-traverse only the affected root. */
  watchedRootId?: string | null;
  /**
   * P2-S8（设计 §4.3/U50）：未知类型 blocker 的真实云端类型
   * （mindnote/file 等）。仅 reasonCode='unsupported_type' 路径填充，
   * 其余失败路径不携带（undefined 不出现在 JSON 序列化中）。
   */
  cloudObjType?: string;
}

export type SyncFailureReasonCode =
  | SyncPlanReasonCode
  | 'permission_denied'
  | 'cloud_deleted'
  | 'rate_limited'
  | 'upstream_error'
  /** S11（设计 §7.3/§8）：文档存在未写回的本地修改，同步被 blocker 跳过。 */
  | 'local_edit_pending'
  | 'cloud_operation_pending'
  | 'source_moved_out';

/**
 * Explicitly distinguishes actions that can be automated from those that
 * require a person with Feishu sharing authority.  In particular, the client
 * must never pretend it can grant itself access to a protected wiki node.
 */
export type SyncRepairAction =
  | 'rebuild_parent_chain'
  | 'adopt_existing_file'
  | 'retry'
  | 'grant_access'
  | 'review_deleted'
  | 'enable_export_adapter'
  | 'manual_review';

/**
 * A durable, operator-owned queue entry.  These items are deliberately kept
 * outside the normal added/modified diff so an unresolved Feishu permission,
 * deleted page, or unsupported cloud type cannot appear as a fresh change on
 * every detector poll.
 */
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
  /** Set only after the user clicks “处理后重新检测”. */
  recheckRequestedAt: string | null;
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
  objType: 'docx' | 'sheet' | 'slides' | 'bitable' | 'unknown';
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
  /** P2-S8：unsupported_type blocker 的真实云端类型（与 ChangedDocument 同名透传字段）。 */
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
  /**
   * Explicit recovery-only opt-in. When a canonical profile path already
   * contains a recognisable older export of the same titled cloud document,
   * adopt that file as its mapping and atomically replace it. Never enables a
   * blind overwrite of arbitrary local content.
   */
  adoptExistingProfileTargets?: boolean;
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
  obj_type: 'docx' | 'sheet' | 'slides' | 'bitable' | 'unknown';
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
  /** 持久同步状态，待同步身份不等同于已落盘文档。 */
  sync_state?: string;
  sync_blocked?: boolean;
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
  /**
   * INTERNAL / TEST INJECTION ONLY (2026-10)：不再从用户配置（Config）接线，
   * 仅作为测试哨兵注入点（确保单测绝不调起真实 lark-cli）。生产路径一律
   * 走 PATH + 桌面发现目录解析；部署级逃生口用环境变量 LARK_CLI_PATH。
   */
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

// ============================================================================
// 源库受控编辑（S11，设计 §7.2–§7.4）
// ============================================================================

/** 编辑发起方：UI 面板 / CLI（S13）/ 内部 Agent（经 app_command，S10）。 */
export type SourceEditActor = 'ui' | 'cli' | 'agent';

/** source_edits.state：dirty=有未写回修改；pushing/pushed/conflict 属写回链（S12）。 */
export type SourceEditState = 'dirty' | 'pushing' | 'pushed' | 'conflict';

/**
 * 受控编辑操作（设计 §7.2）：
 *   - replace_body：整体替换正文（编辑器保存）；
 *   - str_replace：局部替换，old 须唯一（除非 replaceAll）。
 */
export type SourceEditOp =
  | { mode: 'replace_body'; body: string }
  | { mode: 'str_replace'; old: string; new: string; replaceAll?: boolean };

/** source_edits 表行的 camelCase 投影（LocalMapStore 访问器返回）。 */
export interface SourceEditRecord {
  objToken: string;
  localRelPath: string;
  state: SourceEditState;
  baseObjEditTime: string | null;
  baseBodyHash: string;
  currentBodyHash: string;
  editCount: number;
  lastActor: SourceEditActor | string;
  pushMode: string | null;
  pushRevisionId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
}

/** source_push_log 表行的 camelCase 投影（P0-S3，设计 §4.1；LocalMapStore 访问器返回）。 */
export interface SourcePushLogRecord {
  id: string;
  objToken: string;
  localRelPath: string;
  /** append|overwrite|revert（revert 行由 P0-S4 回滚服务写入）。 */
  mode: 'append' | 'overwrite' | 'revert' | string;
  actor: SourceEditActor | string;
  /** 写前云端 obj_edit_time（force 越过时间门时可空）。 */
  preObjEditTime: string | null;
  /** 写前最新 history_version_id（写回回退锚点）。 */
  anchorHistoryId: string | null;
  anchorHistoryTime: string | null;
  /** 锚点历史时间 ≥ 写前云端 obj_edit_time（秒级取整，U23）。 */
  anchorExact: boolean;
  /** 取锚失败原因（仅 append 可空锚继续，§4.2）。 */
  anchorError: string | null;
  postRevisionId: string | null;
  /** 写后回拉成功时 SyncEngine 推进的 synced 值（只读抄录）。 */
  postObjEditTime: string | null;
  /** started|pushed|conflict|failed|unknown（§4.1；与 source_edits 状态迁移对应，见服务层映射）。 */
  outcome: 'started' | 'pushed' | 'conflict' | 'failed' | 'unknown' | string;
  revertState: 'running' | 'done' | 'failed' | 'unknown' | null | string;
  revertHistoryId: string | null;
  revertTaskId: string | null;
  revertError: string | null;
  revertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 编辑状态 DTO（GET /api/sources/:objToken/edit-status 与列表项）。 */
export interface SourceEditStateDto {
  objToken: string;
  relPath: string;
  title: string;
  state: SourceEditState;
  bodyHash: string;
  baseBodyHash: string;
  editCount: number;
  lastActor: SourceEditActor | string;
  error: null | { code: string; message: string };
  updatedAt: string;
}

// ============================================================================
// 飞书写回（S12，设计 §7.4–§7.6）
// ============================================================================

/** 写回配置段（默认关；只接受 desktop token 链路修改）。 */
export interface FeishuWriteConfig {
  enabled: boolean;
}

// ============================================================================
// 反向发布（P1-S8，设计 P1 §4.1/§4.2）
// ============================================================================

/** 发布根（云侧目标）：专用发布文件夹（Drive）或 wiki 节点。 */
export interface PublishTargetConfig {
  kind: 'drive_folder' | 'wiki_node';
  token: string;
  spaceId?: string;
  label: string;
}

/** 发布配置段（additive，缺省关；与 feishuWrite 同只接受 desktop 链路修改）。 */
export interface FeishuPublishConfig {
  enabled: boolean;
  /** 已通过双向校验的发布根；未配置时为空。 */
  target?: PublishTargetConfig | null;
}

/** kb_publications 行（LMS 直读形态；state 为服务层枚举的宽松字符串）。 */
export interface KbPublicationRecord {
  kbPath: string;
  cloudToken: string | null;
  cloudUrl: string | null;
  targetToken: string;
  publishedReleaseId: string | null;
  publishedContentHash: string | null;
  publishedObjEditTime: string | null;
  state: string;
  warningsJson: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** kb_publications upsert 入参（服务层整行写入； created_at 仅首播保留）。 */
export interface KbPublicationUpsert {
  kbPath: string;
  cloudToken?: string | null;
  cloudUrl?: string | null;
  targetToken: string;
  publishedReleaseId?: string | null;
  publishedContentHash?: string | null;
  publishedObjEditTime?: string | null;
  state: string;
  warningsJson?: string | null;
  lastError?: string | null;
}

/** 推送计划 DTO（POST /api/sources/:objToken/push/preview）。 */
export interface SourcePushPlanDto {
  mode: 'append' | 'overwrite' | 'blocked';
  blockedReason?:
    | 'no_changes'
    | 'overwrite_required'
    | 'overwrite_unsupported'
    | 'images_in_append'
    | 'images_in_overwrite'
    | 'write_disabled'
    | 'write_scope_missing'
    | 'cloud_time_unreadable'
    /** P0-S3 §4.2：overwrite 取不到云端历史回退锚点（force 不可越过）。 */
    | 'rollback_anchor_unavailable'
    /** P0-S4 §4.4：该文档有进行中的云端回滚（cloud_revert_running 互斥）。 */
    | 'cloud_revert_running';
  appendMarkdown?: string;
  bytes: number;
  cloud: { objEditTime: string | null; revisionId: number | null };
  /** 云端 obj_edit_time 已越过 base_obj_edit_time。 */
  conflict: boolean;
  warnings: string[];
  /**
   * P0-S3 §4.2 写前回退锚点（preview 实际调用一次 history-list，只读）：
   * 第 1 页最新条目；取锚失败为 null（append 照常推送 + warning，overwrite
   * 升级为 blocked）。anchorBlockedReason 与 blockedReason 同值，独立字段
   * 便于 UI/CLI 判「无锚」原因而不解析 blockedReason 语义。
   */
  rollbackAnchor?: {
    historyVersionId: string;
    revisionId: number | null;
    historyTime: string | null;
    exact: boolean;
  } | null;
  anchorBlockedReason?: 'rollback_anchor_unavailable';
  /**
   * P0-S9 §6.1：本地编辑引入的正文首个 H1 与标题的分叉（推送正文不同步
   * 标题）。null = 无警告；改名后回拉标题一致即自然消除。文案常量见
   * feishu-write-service 的 titleChangeNotPushedMessage（码 title_change_not_pushed）。
   */
  titleChangeNotPushed?: { localTitle: string; syncedTitle: string } | null;
}

/** 推送执行结果 DTO（POST /api/sources/:objToken/push）。 */
export interface SourcePushResultDto {
  state: SourceEditState | 'pushed';
  mode: 'append' | 'overwrite';
  revisionId: number | null;
  pull: { ok: boolean; status: string; message?: string };
}
