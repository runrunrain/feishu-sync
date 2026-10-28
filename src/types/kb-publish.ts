/**
 * 反向发布 DTO（P1-S9 前端消费，镜像 P1-S8 server/src/kb/publication-service.ts 契约）。
 *
 * 消费端点：
 *   POST /api/kb/publish/preview → KbPublishPlanDto
 *   POST /api/kb/publish         → KbPublishRunResultDto（confirm 门 + planKey 复核）
 *   GET  /api/kb/publications    → { publications: KbPublicationRowDto[] }
 *   GET  /api/kb/publications/:kbPath → KbPublicationRowDto（路径段 URL 编码）
 *   PUT  /api/kb/publish/target  → { target }（仅 desktop token 链路）
 */

/** 发布根（云侧目标）：专用 Drive 文件夹或 wiki 节点。 */
export interface PublishTargetDto {
  kind: 'drive_folder' | 'wiki_node';
  token: string;
  spaceId?: string;
  label: string;
}

/** kb_publications 行状态（§4.7 状态机；行 state 为宽松字符串）。 */
export type KbPublicationState =
  | 'creating'
  | 'published'
  | 'published_with_warnings'
  | 'conflict'
  | 'failed'
  | 'unknown'
  | 'kb_removed'
  | 'cloud_missing';

/** 发布警告（渲染警告 §4.3 + 回读校验警告 §4.5 统一形态）。 */
export interface KbPublishWarning {
  code: string;
  kbPath: string;
  target?: string;
  text?: string;
  local?: number;
  cloud?: number;
}

/** warnings_json 解析形态（previousCloudTokens 见 §4.7 旧 token 归档）。 */
export interface KbPublicationWarnings {
  warnings: KbPublishWarning[];
  previousCloudTokens?: string[];
}

/** GET /api/kb/publications 行 DTO（LMS 行 + 解析后的 warnings）。 */
export interface KbPublicationRowDto {
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
  warnings: KbPublicationWarnings;
}

/** POST /api/kb/publish/preview 计划行。 */
export interface KbPublishPlanItemDto {
  kbPath: string;
  title: string;
  action: 'create' | 'update' | 'skip_unchanged' | 'blocked';
  blockedReason?: 'publish_cloud_edited' | 'cloud_missing' | 'state_unknown' | 'render_failed';
  contentHash: string;
  warnings: KbPublishWarning[];
  /** 当前行状态（null = 无发布记录）。 */
  state: KbPublicationState | null;
  cloudToken: string | null;
  cloudUrl: string | null;
  /** publish_cloud_edited 冲突项（force 可解除并升级确认值）。 */
  cloudEdited: boolean;
}

/** 执行门状态（任一不满足执行会 403/409 拒绝）。 */
export interface KbPublishGates {
  feishuWriteEnabled: boolean;
  writeScopesGranted: boolean;
  missingScopes: string[];
  publishEnabled: boolean;
  targetConfigured: boolean;
}

export interface KbPublishPlanDto {
  releaseId: string;
  target: PublishTargetDto | null;
  planKey: string;
  items: KbPublishPlanItemDto[];
  /** 全量模式下将置 kb_removed 的已发布路径（不执行任何远端动作）。 */
  removed: string[];
  gates: KbPublishGates;
  /** 执行所需确认值（force 解除冲突时升级为 OVERWRITE_PUBLISHED）。 */
  confirmRequired: 'PUBLISH' | 'OVERWRITE_PUBLISHED';
}

/** POST /api/kb/publish 单项执行结果。 */
export interface KbPublishItemResultDto {
  kbPath: string;
  action: KbPublishPlanItemDto['action'];
  outcome: 'created' | 'updated' | 'skipped' | 'blocked' | 'failed' | 'unknown' | 'cloud_missing';
  state: KbPublicationState;
  cloudToken: string | null;
  cloudUrl: string | null;
  warnings: KbPublishWarning[];
  error?: string;
}

export interface KbPublishRunResultDto {
  releaseId: string;
  target: PublishTargetDto | null;
  items: KbPublishItemResultDto[];
  removedMarked: string[];
  counts: {
    created: number;
    updated: number;
    skipped: number;
    blocked: number;
    failed: number;
    secondPass: number;
  };
}
