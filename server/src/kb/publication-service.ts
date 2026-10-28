/**
 * KbPublishService — 标准库反向发布（P1-S8，设计 P1 §4；P1-S1 PB 实测定稿）
 *
 * 把标准库某个 release 的文档发布为飞书云文档：
 *   计划（§4.4）→ 执行（docs +create --title / docs +update overwrite）
 *   → 回读校验（§4.5 parse char_count 比值 [0.8,1.25]）→ 推进 kb_publications。
 *
 * 核心不变量（设计 §4.1，违反即系统级缺陷）：
 *   1. 防自我喂养：发布根与 watchedRoots 双向不重叠（配置时校验，
 *      T4b-03：候选配置在 ConfigManager.updateConfig 收敛点联合校验，
 *      两入口两方向 + 祖先链不可读 fail-closed）；构建快照排除
 *      kb_publications 谱系（当前 cloud_token + previousCloudTokens，
 *      T4b-07）命中的源（接线在 kb-build-service，本模块提供
 *      publishedCloudTokens 数据面）。
 *   2. 永不删除云文档：本模块没有任何删除调用；KB 中已删除的文档只标
 *      kb_removed。
 *   3. 不静默覆盖他人编辑：每次实际 overwrite 前（含第二遍互链回写与
 *      首遍 skip→update 转换，T4b-02）重新取云端 obj_edit_time 与
 *      published_obj_edit_time 比对，前进或不可读 → blocked
 *      (publish_cloud_edited) fail-closed，重发需重新派生批准（force +
 *      OVERWRITE_PUBLISHED）；overwrite 前先取云端历史锥点并落
 *      source_push_log 行（T4b-04，无锥/落库失败拒绝覆盖）。
 *   4. 创建不确定不重建：creating 重启对账 → unknown（人工核对后经
 *      force 重新发布为新文档，旧 cloud_token 归档 previousCloudTokens）；
 *      create 命令发出后超时/解析失败/缺 document_id 一律 unknown
 *      （T4b-06，非幂等不普通重发）；overwrite 命令发出后的超时/解析
 *      失败/响应不完整同归 unknown（T4b-06 批C，与 create/revert/move
 *      同口径），且同批第二遍互链回写不重发本轮 unknown/失败的文档（每
 *      文档单次尝试语义，T4b-recheck F06）。
 *   5. 同实例发布互斥：execute 同步占用准入（T4b-01，检查与置位间无
 *      await），整体 finally 释放；release 使用中标记由实际持有者释放。
 *
 * 实测定稿（P1-S1）：
 *   - docs +create 响应 data.document.{document_id, revision_id, url}；
 *     --title 只前置标题不去重正文 H1 —— 同名 H1 移除由 renderForPublish
 *     本地承担（P1-S7）。
 *   - parse profile.char_count 口径 ≈ 不含文档标题的正文可见字符；本地
 *     对照 countText(body).chars（text-stats，同口径），比值 [0.8,1.25]。
 *   - docs +update 有 --reference-map 但发布不透传（设计选择，U35 修订）。
 *
 * 正文经 lark-cli-client 内部临时目录 + 子进程 cwd 相对 @file 传入，
 * 绝不落 argv/日志（与 S12 updateDocument 同一安全属性；设计 §4.4 的
 * publish-tmp 落点由 client 封装内的 mkdtemp 承担，隔离属性一致）。
 *
 * 审计：<dataRoot>/agent/audit/kb-publish.jsonl，事件
 * publish_started|item_created|item_updated|item_failed|publish_finished，
 * 不记正文。全局一个发布任务互斥（publish_in_progress，同步准入）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { LarkCliError } from '../modules/lark-cli-client.js';
import { FEISHU_WRITE_SCOPES } from '../sources/feishu-write-service.js';
import { StandardKbStore } from './standard-kb-store.js';
import { validReleaseId } from './kb-version-store.js';
import { renderForPublish } from './publish-render.js';
import { countText } from './text-stats.js';
import type {
  Config,
  KbPublicationRecord,
  KbPublicationUpsert,
  PublishTargetConfig,
} from '../types/index.js';

export type { PublishTargetConfig };

export const PUBLISH_CONFIRM = 'PUBLISH';
export const PUBLISH_OVERWRITE_CONFIRM = 'OVERWRITE_PUBLISHED';
/** §4.5：回读校验比值区间（P1-S1 实测 1.02–1.05，宽区间只捕捉量级错误）。 */
export const PUBLISH_VERIFY_RATIO_MIN = 0.8;
export const PUBLISH_VERIFY_RATIO_MAX = 1.25;
/** §4.1：wiki 祖先链上溯深度上限。 */
export const PUBLISH_ANCESTRY_MAX_DEPTH = 50;

export type KbPublicationState =
  | 'creating'
  | 'published'
  | 'published_with_warnings'
  | 'conflict'
  | 'failed'
  | 'unknown'
  | 'kb_removed'
  | 'cloud_missing';

const KB_PUBLICATION_STATES: ReadonlySet<string> = new Set<KbPublicationState>([
  'creating', 'published', 'published_with_warnings', 'conflict',
  'failed', 'unknown', 'kb_removed', 'cloud_missing',
]);

/** 发布运行警告（渲染警告 §4.3 + 回读校验警告 §4.5 的统一 DTO 形态）。 */
export interface PublicationWarningDto {
  code: string;
  kbPath: string;
  target?: string;
  text?: string;
  local?: number;
  cloud?: number;
}

/** warnings_json 解析形态（previousCloudTokens 见 §4.7 归档规则）。 */
export interface PublicationWarningsJson {
  warnings: PublicationWarningDto[];
  previousCloudTokens?: string[];
}

/** 服务级错误：code/status 对齐仓库 {error, message, details?} 约定。 */
export class PublicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PublicationError';
  }
}

// ===========================================================================
// 发布根配置解析与双向校验（§4.1 防线 1）
// ===========================================================================

/** 从粘贴 URL 解析发布根：/drive/folder/<t> | /wiki/<t>（不合法返回 null）。 */
export function parsePublishTargetUrl(url: string): { kind: 'drive_folder' | 'wiki_node'; token: string } | null {
  if (typeof url !== 'string') return null;
  const drive = /\/drive\/folder\/([A-Za-z0-9]{8,64})/.exec(url);
  if (drive) return { kind: 'drive_folder', token: drive[1] };
  const wiki = /\/wiki\/([A-Za-z0-9]{8,64})/.exec(url);
  if (wiki) return { kind: 'wiki_node', token: wiki[1] };
  return null;
}

/** watchedRoot URL → wiki 节点 token（与 watchedRoots.id 同一身份）。 */
export function nodeTokenFromWikiUrl(url: string): string {
  return /\/wiki\/([A-Za-z0-9]+)/.exec(url)?.[1] ?? '';
}

export interface WatchedRootRef {
  /** watchedRoots.id（wiki 根节点 token，权威身份）。 */
  id: string;
  url: string;
}

export type PublishTargetOverlap =
  | { ok: true }
  | { ok: false; code: 'publish_target_inside_watched_root' | 'watched_root_inside_publish_target' | 'publish_target_unverifiable'; message: string; rootId?: string };

/**
 * 双向校验纯核心（可测）：
 *   A. 发布根在监听树内：target token 等于某 watchedRoot 身份，或其祖先
 *      链命中任一 watchedRoot → 拒绝 publish_target_inside_watched_root。
 *   B. 监听树在发布根内：任一 watchedRoot 的祖先链含 target token →
 *      拒绝 watched_root_inside_publish_target。
 *   drive_folder 与 wiki 子树不同命名空间，两个方向均天然不重叠（设计
 *   §4.1）；wiki 祖先链由调用方经 getNode 解析（resolveWikiAncestry），
 *   解析失败 → publish_target_unverifiable（fail-closed，配置时拒绝）。
 */
export function checkPublishTargetOverlapCore(input: {
  target: PublishTargetConfig;
  watchedRoots: WatchedRootRef[];
  targetAncestors: string[];
  watchedAncestorsByRootId: Record<string, string[]>;
}): PublishTargetOverlap {
  const { target, watchedRoots } = input;
  if (target.kind !== 'wiki_node') return { ok: true };
  for (const root of watchedRoots) {
    const rootIds = new Set<string>([root.id, nodeTokenFromWikiUrl(root.url)].filter(Boolean));
    if (rootIds.has(target.token) || input.targetAncestors.includes(root.id)
      || input.targetAncestors.some((anc) => rootIds.has(anc))) {
      return {
        ok: false,
        code: 'publish_target_inside_watched_root',
        message: `发布根（wiki 节点 ${target.token}）位于监听子树 ${root.id} 内：已发布内容会被同步回流，形成自我喂养回路。请选择监听目录之外的发布根`,
        rootId: root.id,
      };
    }
    const watchedAncestors = input.watchedAncestorsByRootId[root.id] ?? [];
    if (watchedAncestors.includes(target.token)) {
      return {
        ok: false,
        code: 'watched_root_inside_publish_target',
        message: `监听子树 ${root.id} 位于发布根（wiki 节点 ${target.token}）内：发布内容会覆盖监听范围。请先更换发布根或调整监听根`,
        rootId: root.id,
      };
    }
  }
  return { ok: true };
}

/** getNode 风格祖先解析器（测试注入用）。 */
export type WikiNodeParentResolver = (token: string) => Promise<{ parent_node_token?: string }>;

/** 沿 parent 链上溯（深度 ≤ maxDepth；环路/到根即停）。 */
export async function resolveWikiAncestry(
  getNode: WikiNodeParentResolver,
  token: string,
  maxDepth = PUBLISH_ANCESTRY_MAX_DEPTH,
): Promise<string[]> {
  const ancestors: string[] = [];
  const seen = new Set<string>([token]);
  let current = token;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const node = await getNode(current);
    const parent = typeof node?.parent_node_token === 'string' && node.parent_node_token.length > 0
      ? node.parent_node_token
      : null;
    if (!parent || seen.has(parent)) break;
    ancestors.push(parent);
    seen.add(parent);
    current = parent;
  }
  return ancestors;
}

/**
 * 发布根双向校验（配置时调用；wiki_node 走云端祖先链，任一解析失败
 * fail-closed 拒绝——无法证明不重叠即不允许配置）。
 */
export async function validatePublishTargetAgainstWatchedRoots(
  target: PublishTargetConfig,
  watchedRoots: WatchedRootRef[],
  getNode: WikiNodeParentResolver,
): Promise<PublishTargetOverlap> {
  if (target.kind !== 'wiki_node') return { ok: true };
  try {
    const targetAncestors = await resolveWikiAncestry(getNode, target.token);
    const watchedAncestorsByRootId: Record<string, string[]> = {};
    for (const root of watchedRoots) {
      watchedAncestorsByRootId[root.id] = await resolveWikiAncestry(getNode, root.id);
    }
    return checkPublishTargetOverlapCore({ target, watchedRoots, targetAncestors, watchedAncestorsByRootId });
  } catch (error) {
    return {
      ok: false,
      code: 'publish_target_unverifiable',
      message: `无法解析发布根的 wiki 祖先链（${error instanceof Error ? error.message : String(error)}）：不能证明发布根在监听子树之外，已拒绝。请稍后重试或改用 Drive 文件夹发布根`,
    };
  }
}

/** 发布重叠相关的配置身份指纹（target 身份 + watchedRoot 身份集）。 */
function publishOverlapConfigIdentity(config: Config): string {
  const target = config?.feishuPublish?.target;
  const roots = (config?.watchedRoots ?? []).map((root) => [root.id, nodeTokenFromWikiUrl(root.url)]);
  return JSON.stringify({
    target: target ? [target.kind, target.token] : null,
    roots,
  });
}

/**
 * T4b-03：ConfigManager.updateConfig 的候选配置联合校验钩子——通用配置
 * 入口（PUT /api/config）与专用 target 路由两方向两入口的收敛点。
 * feishuPublish 段或 watchedRoots 任一变化时，对候选态做完整祖先链交叉
 * 验证（发布根在监听树内 / 监听树在发布根内双向）；祖先链不可读 →
 * fail-closed 拒绝（publish_target_unverifiable，502）。身份（target
 * token / watchedRoot 身份集）未变化时跳过，无关配置保存不触发云端
 * 解析。拒绝以 PublicationError 抛出（409/502），由路由层透传状态码。
 */
export function createPublishOverlapConfigHook(
  getNode: WikiNodeParentResolver,
): (candidate: Config, previous: Config) => Promise<void> {
  return async (candidate: Config, previous: Config): Promise<void> => {
    const target = candidate?.feishuPublish?.target;
    if (!target || target.kind !== 'wiki_node') return;
    const watchedRoots = (candidate.watchedRoots ?? []).map((root) => ({ id: root.id, url: root.url }));
    if (watchedRoots.length === 0) return;
    if (publishOverlapConfigIdentity(candidate) === publishOverlapConfigIdentity(previous)) return;
    const overlap = await validatePublishTargetAgainstWatchedRoots(target, watchedRoots, getNode);
    if (!overlap.ok) {
      throw new PublicationError(
        'publish_target_invalid',
        overlap.message,
        overlap.code === 'publish_target_unverifiable' ? 502 : 409,
        { code: overlap.code, ...(overlap.rootId ? { rootId: overlap.rootId } : {}) },
      );
    }
  };
}

// ===========================================================================
// release「使用中」标记（§4.6：发布期间保留策略清理跳过使用中的 release）
// ===========================================================================

const releasesInUse = new Set<string>();

export function markReleaseInUse(releaseId: string): void {
  releasesInUse.add(releaseId);
}

export function releaseInUseEnded(releaseId: string): void {
  releasesInUse.delete(releaseId);
}

export function isReleaseInUse(releaseId: string): boolean {
  return releasesInUse.has(releaseId);
}

// ===========================================================================
// 计划与执行 DTO（§4.4）
// ===========================================================================

export interface PublishPlanItemDto {
  kbPath: string;
  title: string;
  action: 'create' | 'update' | 'skip_unchanged' | 'blocked';
  blockedReason?: 'publish_cloud_edited' | 'cloud_missing' | 'state_unknown' | 'render_failed';
  contentHash: string;
  warnings: PublicationWarningDto[];
  state: KbPublicationState | null;
  cloudToken: string | null;
  cloudUrl: string | null;
  /** publish_cloud_edited 冲突项（force 可解除并升级确认值 OVERWRITE_PUBLISHED）。 */
  cloudEdited: boolean;
}

export interface PublishPlanDto {
  releaseId: string;
  target: PublishTargetConfig | null;
  planKey: string;
  items: PublishPlanItemDto[];
  /** 全量模式下将置 kb_removed 的已发布路径（不执行任何远端动作）。 */
  removed: string[];
  gates: {
    feishuWriteEnabled: boolean;
    writeScopesGranted: boolean;
    missingScopes: string[];
    publishEnabled: boolean;
    targetConfigured: boolean;
  };
  /** 执行所需确认值（force 解除冲突时升级为 OVERWRITE_PUBLISHED）。 */
  confirmRequired: typeof PUBLISH_CONFIRM | typeof PUBLISH_OVERWRITE_CONFIRM;
}

export interface PublishItemResultDto {
  kbPath: string;
  action: PublishPlanItemDto['action'];
  outcome: 'created' | 'updated' | 'skipped' | 'blocked' | 'failed' | 'unknown' | 'cloud_missing';
  state: KbPublicationState;
  cloudToken: string | null;
  cloudUrl: string | null;
  warnings: PublicationWarningDto[];
  error?: string;
}

export interface PublishRunResultDto {
  releaseId: string;
  target: PublishTargetConfig | null;
  items: PublishItemResultDto[];
  removedMarked: string[];
  counts: { created: number; updated: number; skipped: number; blocked: number; failed: number; secondPass: number };
}

interface RenderCacheEntry {
  kbPath: string;
  title: string;
  body: string;
  warnings: PublicationWarningDto[];
  contentHash: string;
}

interface BuiltPlan {
  dto: PublishPlanDto;
  renders: Map<string, RenderCacheEntry>;
}

export interface KbPublishServiceDeps {
  configManager: { getConfig?: () => Config | null | undefined; load?: () => Promise<Config> };
  localMapStore: {
    getKbPublication(kbPath: string): KbPublicationRecord | null;
    listKbPublications(): KbPublicationRecord[];
    upsertKbPublication(row: KbPublicationUpsert): void;
    listPublishedCloudTokens(): string[];
    /** T4b-04：发布 overwrite 写前锚点行（与源写回共用 source_push_log 原语，不套 source_edits 状态机）。 */
    insertSourcePushLog(input: {
      objToken: string;
      localRelPath: string;
      mode: 'append' | 'overwrite' | 'revert';
      actor: string;
      preObjEditTime?: number | string | null;
      anchorHistoryId?: string | null;
      anchorHistoryTime?: string | null;
      anchorExact?: boolean;
      anchorError?: string | null;
    }): string;
    updateSourcePushLog(id: string, patch: {
      outcome?: 'started' | 'pushed' | 'conflict' | 'failed' | 'unknown';
      postRevisionId?: string | null;
      postObjEditTime?: string | null;
    }): boolean;
  };
  larkCliClient: any;
  dataRoot: string;
}

export type PublishActor = 'ui' | 'cli' | 'agent';

export class KbPublishService {
  private publishRunning = false;

  constructor(private readonly deps: KbPublishServiceDeps) {}

  // ------------------------------------------------------------------
  // 基础面
  // ------------------------------------------------------------------

  private async config(): Promise<Config> {
    return this.deps.configManager.getConfig?.() ?? await this.deps.configManager.load!();
  }

  private auditPath(): string {
    return path.join(this.deps.dataRoot, 'agent', 'audit', 'kb-publish.jsonl');
  }

  private appendAudit(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath()), { recursive: true });
      fs.appendFileSync(this.auditPath(), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
      console.error('[KbPublishService] audit append failed:', error);
    }
  }

  static parseWarningsJson(value: string | null): PublicationWarningsJson {
    if (!value) return { warnings: [] };
    try {
      const parsed = JSON.parse(value) as PublicationWarningsJson;
      return {
        warnings: Array.isArray(parsed?.warnings) ? parsed.warnings : [],
        ...(Array.isArray(parsed?.previousCloudTokens) ? { previousCloudTokens: parsed.previousCloudTokens } : {}),
      };
    } catch {
      return { warnings: [] };
    }
  }

  /**
   * warningsJson 写入（T4b-07）：状态/警告更新不得擦除 previousCloudTokens
   * 谱系——把既有谱系并入新 warnings 再落盘（recordBlocked 与失败路径
   * 原样保留整串 JSON，不经此合并）。
   */
  private static mergeWarningsJson(
    existing: string | null | undefined,
    warnings: PublicationWarningDto[],
  ): string {
    const parsed = KbPublishService.parseWarningsJson(existing ?? null);
    return JSON.stringify({
      warnings,
      ...(parsed.previousCloudTokens && parsed.previousCloudTokens.length > 0
        ? { previousCloudTokens: parsed.previousCloudTokens }
        : {}),
    });
  }

  private static toState(value: string): KbPublicationState {
    return KB_PUBLICATION_STATES.has(value) ? value as KbPublicationState : 'unknown';
  }

  listPublications(): Array<KbPublicationRecord & { warnings: PublicationWarningsJson }> {
    return this.deps.localMapStore.listKbPublications().map((row) => ({
      ...row,
      state: KbPublishService.toState(row.state),
      warnings: KbPublishService.parseWarningsJson(row.warningsJson),
    }));
  }

  getPublication(kbPath: string): (KbPublicationRecord & { warnings: PublicationWarningsJson }) | null {
    const row = this.deps.localMapStore.getKbPublication(kbPath);
    if (!row) return null;
    return {
      ...row,
      state: KbPublishService.toState(row.state),
      warnings: KbPublishService.parseWarningsJson(row.warningsJson),
    };
  }

  // ------------------------------------------------------------------
  // 门控（§4.6：feishuWrite.enabled ∧ 写 scope ∧ feishuPublish.enabled ∧ target）
  // ------------------------------------------------------------------

  private feishuWriteEnabled(config: Config): boolean {
    return config?.feishuWrite?.enabled === true;
  }

  async writeScopesGranted(): Promise<{ granted: boolean; missingScopes: string[] }> {
    try {
      const readiness = await this.deps.larkCliClient.checkAuthReady({ verify: false });
      const granted = new Set<string>(readiness?.currentScopes ?? []);
      const missing = FEISHU_WRITE_SCOPES.filter((scope) => !granted.has(scope));
      return { granted: missing.length === 0, missingScopes: missing };
    } catch {
      return { granted: false, missingScopes: [...FEISHU_WRITE_SCOPES] };
    }
  }

  private publishEnabled(config: Config): boolean {
    return config?.feishuPublish?.enabled === true;
  }

  private target(config: Config): PublishTargetConfig | null {
    const target = config?.feishuPublish?.target;
    if (!target || typeof target !== 'object') return null;
    if ((target.kind !== 'drive_folder' && target.kind !== 'wiki_node')
      || typeof target.token !== 'string' || target.token.length === 0) {
      return null;
    }
    return target as PublishTargetConfig;
  }

  /** 发布时的廉价复核：发布根 token 不得等于任一 watchedRoot 身份（配置时已做完整祖先链校验）。 */
  private cheapTargetOverlapCheck(target: PublishTargetConfig, config: Config): void {
    const roots: WatchedRootRef[] = (config.watchedRoots ?? []).map((root) => ({ id: root.id, url: root.url }));
    const overlap = checkPublishTargetOverlapCore({
      target,
      watchedRoots: roots,
      targetAncestors: [],
      watchedAncestorsByRootId: {},
    });
    if (!overlap.ok) {
      throw new PublicationError('publish_target_invalid', overlap.message, 409, { code: overlap.code });
    }
  }

  private async requireGates(config: Config): Promise<PublishTargetConfig> {
    if (!this.publishEnabled(config)) {
      throw new PublicationError('publish_disabled', '反向发布未开启：请在「设置 → 飞书发布」中开启后再发布', 403);
    }
    if (!this.feishuWriteEnabled(config)) {
      throw new PublicationError('feishu_write_disabled', '飞书写入未开启：反向发布依赖写权限门（feishuWrite.enabled），请在应用设置中开启', 403);
    }
    const scopes = await this.writeScopesGranted();
    if (!scopes.granted) {
      throw new PublicationError(
        'feishu_write_scope_missing',
        `缺少写权限（${scopes.missingScopes.join(', ')}）：请发起一次「写入权限」授权（scopeSet=write）后再发布`,
        403,
        { missingScopes: scopes.missingScopes },
      );
    }
    const target = this.target(config);
    if (!target) {
      throw new PublicationError('publish_target_not_configured', '发布根未配置：请先在应用设置中选择并校验发布根', 409);
    }
    this.cheapTargetOverlapCheck(target, config);
    return target;
  }

  // ------------------------------------------------------------------
  // 计划（§4.4 preview：只读，不改 kb_publications）
  // ------------------------------------------------------------------

  async plan(options: { releaseId?: string; kbPaths?: string[]; force?: boolean }): Promise<PublishPlanDto> {
    return (await this.buildPlan(options)).dto;
  }

  private async buildPlan(options: { releaseId?: string; kbPaths?: string[]; force?: boolean }): Promise<BuiltPlan> {
    const config = await this.config();
    const store = new StandardKbStore(config.standardKb.outputRoot);
    if (options.releaseId !== undefined && !validReleaseId(options.releaseId)) {
      throw new PublicationError('invalid_request', 'releaseId 无效', 400);
    }
    const manifest = store.readManifest(options.releaseId);
    if (!manifest) {
      throw new PublicationError('kb_not_published', '标准知识库尚未发布（找不到 release manifest）', 404);
    }
    const fullMode = options.kbPaths === undefined;
    const allPaths = new Set(manifest.docs.map((doc) => doc.path));
    let selected = manifest.docs;
    if (!fullMode) {
      if (!Array.isArray(options.kbPaths) || options.kbPaths.length === 0
        || !options.kbPaths.every((p) => typeof p === 'string')) {
        throw new PublicationError('invalid_request', 'kbPaths 必须是非空字符串数组（缺省=整个 release）', 400);
      }
      if (options.kbPaths.length > 5000) {
        throw new PublicationError('invalid_request', 'kbPaths 数量超出上限（5000）', 400);
      }
      const missing = options.kbPaths.filter((p) => !allPaths.has(p));
      if (missing.length > 0) {
        throw new PublicationError('kb_doc_not_found', `以下路径不在 release ${manifest.releaseId} 中：${missing.slice(0, 5).join('、')}${missing.length > 5 ? '…' : ''}`, 404, { missing });
      }
      const wanted = new Set(options.kbPaths);
      selected = manifest.docs.filter((doc) => wanted.has(doc.path));
    }

    // 行与发布 URL 映射（published* 行的 URL 可用于链接改写）
    const rows = new Map<string, KbPublicationRecord>();
    for (const row of this.deps.localMapStore.listKbPublications()) rows.set(row.kbPath, row);
    const publishedUrlByKbPath = new Map<string, string>();
    for (const [kbPath, row] of rows) {
      if ((row.state === 'published' || row.state === 'published_with_warnings')
        && typeof row.cloudUrl === 'string' && row.cloudUrl.length > 0) {
        publishedUrlByKbPath.set(kbPath, row.cloudUrl);
      }
    }

    // 渲染（确定性；readReleaseDoc 失败 → blocked(render_failed)）
    const renders = new Map<string, RenderCacheEntry>();
    const items: PublishPlanItemDto[] = [];
    const updateCandidates: Array<{ item: PublishPlanItemDto; row: KbPublicationRecord }> = [];
    for (const doc of selected) {
      const row = rows.get(doc.path) ?? null;
      const dto: PublishPlanItemDto = {
        kbPath: doc.path,
        title: doc.title || doc.path,
        action: 'blocked',
        contentHash: '',
        warnings: [],
        state: row ? KbPublishService.toState(row.state) : null,
        cloudToken: row?.cloudToken ?? null,
        cloudUrl: row?.cloudUrl ?? null,
        cloudEdited: false,
      };
      let render: RenderCacheEntry | null = null;
      try {
        const loaded = store.readReleaseDoc(manifest.releaseId, doc);
        const result = renderForPublish({ kbPath: doc.path, markdown: loaded.markdown, publishedUrlByKbPath });
        render = {
          kbPath: doc.path,
          title: result.title || doc.title || doc.path,
          body: result.body,
          warnings: result.warnings as PublicationWarningDto[],
          contentHash: result.contentHash,
        };
        renders.set(doc.path, render);
      } catch (error) {
        dto.action = 'blocked';
        dto.blockedReason = 'render_failed';
        dto.warnings = [{ code: 'render_failed', kbPath: doc.path, text: String(error instanceof Error ? error.message : error).slice(0, 200) }];
        items.push(dto);
        continue;
      }
      dto.title = render.title;
      dto.contentHash = render.contentHash;
      dto.warnings = render.warnings;
      this.decideAction(dto, render, row, options.force === true);
      if (dto.action === 'update' && row) updateCandidates.push({ item: dto, row });
      items.push(dto);
    }

    // update 候选批量取云端 obj_edit_time（drive metas ≤200/批，fail-closed）
    if (updateCandidates.length > 0) {
      const times = await this.fetchCloudEditTimes(updateCandidates.map(({ row }) => row.cloudToken!));
      for (const { item, row } of updateCandidates) {
        const cloudTime = times.get(row.cloudToken!);
        const baseTime = row.publishedObjEditTime != null ? Number(row.publishedObjEditTime) : NaN;
        const readable = typeof cloudTime === 'number' && Number.isFinite(cloudTime)
          && Number.isFinite(baseTime);
        if (readable && (cloudTime as number) <= baseTime) continue; // 无并发编辑 → update
        // 云端时间前进或不可读 → fail-closed 冲突；force 解除并升级确认值
        item.cloudEdited = true;
        if (options.force === true) {
          item.action = 'update';
        } else {
          item.action = 'blocked';
          item.blockedReason = 'publish_cloud_edited';
        }
      }
    }

    // 全量模式：release 中已不存在的已发布路径 → kb_removed（仅展示，不执行远端动作）
    const removed: string[] = [];
    if (fullMode) {
      for (const [kbPath, row] of rows) {
        if (row.state !== 'kb_removed' && !allPaths.has(kbPath)) removed.push(kbPath);
      }
      removed.sort();
    }

    items.sort((a, b) => a.kbPath.localeCompare(b.kbPath, 'zh'));
    const planKey = `${manifest.releaseId}|${items.map((item) => `${item.kbPath}:${item.action}`).join(',')}`;
    const forceReleasedConflict = options.force === true && items.some((item) => item.cloudEdited);
    const scopes = await this.writeScopesGranted();
    const target = this.target(config);
    const dto: PublishPlanDto = {
      releaseId: manifest.releaseId,
      target,
      planKey,
      items,
      removed,
      gates: {
        feishuWriteEnabled: this.feishuWriteEnabled(config),
        writeScopesGranted: scopes.granted,
        missingScopes: scopes.missingScopes,
        publishEnabled: this.publishEnabled(config),
        targetConfigured: target !== null,
      },
      confirmRequired: forceReleasedConflict ? PUBLISH_OVERWRITE_CONFIRM : PUBLISH_CONFIRM,
    };
    return { dto, renders };
  }

  /**
   * 单项动作决策（无云端时间参与；update 的时间门在批量取数后回填）。
   *   - 无行 / 行无 cloudToken（从未成功创建）→ create
   *   - unknown / creating → blocked(state_unknown)（force → 重新发布为新文档 create）
   *   - cloud_missing → blocked(cloud_missing)（force → create）
   *   - published（含 published_with_warnings）或 failed 且 contentHash 与上次发布一致 → skip_unchanged
   *   - conflict / kb_removed（重现）/ hash 变化 → update 候选
   */
  private decideAction(
    dto: PublishPlanItemDto,
    render: RenderCacheEntry,
    row: KbPublicationRecord | null,
    force: boolean,
  ): void {
    if (!row || !row.cloudToken) {
      if (row && (row.state === 'unknown' || row.state === 'creating')) {
        if (force) {
          dto.action = 'create';
          return;
        }
        dto.action = 'blocked';
        dto.blockedReason = 'state_unknown';
        return;
      }
      if (row && row.state === 'cloud_missing') {
        if (force) {
          dto.action = 'create';
          return;
        }
        dto.action = 'blocked';
        dto.blockedReason = 'cloud_missing';
        return;
      }
      dto.action = 'create';
      return;
    }
    const hashUnchanged = row.publishedContentHash === render.contentHash;
    if (hashUnchanged && (row.state === 'published' || row.state === 'published_with_warnings' || row.state === 'failed')) {
      dto.action = 'skip_unchanged';
      return;
    }
    if (row.state === 'unknown' || row.state === 'creating') {
      if (force) {
        dto.action = 'create';
        return;
      }
      dto.action = 'blocked';
      dto.blockedReason = 'state_unknown';
      return;
    }
    if (row.state === 'cloud_missing') {
      if (force) {
        dto.action = 'create';
        return;
      }
      dto.action = 'blocked';
      dto.blockedReason = 'cloud_missing';
      return;
    }
    // published（含 warnings）与 conflict 与 kb_removed（重现）与 failed（hash 变化）→ update 候选
    dto.action = 'update';
  }

  /** 批量取云端 obj_edit_time（≤200/批；单批失败按该批全部不可读 fail-closed）。 */
  private async fetchCloudEditTimes(tokens: string[]): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    const unique = [...new Set(tokens)];
    for (let start = 0; start < unique.length; start += 200) {
      const batch = unique.slice(start, start + 200)
        .map((token) => ({ docToken: token, docType: 'docx' }));
      let metas: any[] = [];
      try {
        const response = await this.deps.larkCliClient.getDocumentMetas(batch);
        metas = Array.isArray(response?.metas) ? response.metas : [];
      } catch {
        metas = [];
      }
      const byToken = new Map<string, number | null>();
      for (const meta of metas) {
        if (typeof meta?.docToken === 'string') {
          byToken.set(meta.docToken, typeof meta.latestModifyTime === 'number' && Number.isFinite(meta.latestModifyTime) ? meta.latestModifyTime : null);
        }
      }
      for (const token of unique.slice(start, start + 200)) {
        result.set(token, byToken.has(token) ? byToken.get(token)! : null);
      }
    }
    return result;
  }

  // ------------------------------------------------------------------
  // 写前回退锚点 + push_log（T4b-04；与 FeishuWriteService 共用同一原语
  // 语义：docs +history-list 第 1 页最新条目 → 先落锚点行再写云端）
  // ------------------------------------------------------------------

  /** 取回退锚点（P0-S3 §4.2 步骤 3）：失败容错为空锚，是否阻断由调用方裁定。 */
  private async fetchRollbackAnchor(objToken: string): Promise<{
    historyVersionId: string | null;
    revisionId: number | null;
    historyTime: string | null;
    error: string | null;
  }> {
    try {
      const page = await this.deps.larkCliClient.listDocumentHistory(objToken, { pageSize: 5 });
      const entry = page?.entries?.[0];
      if (typeof entry?.historyVersionId === 'string' && entry.historyVersionId !== '') {
        return {
          historyVersionId: entry.historyVersionId,
          revisionId: typeof entry.revisionId === 'number' ? entry.revisionId : null,
          historyTime: typeof entry.editTime === 'string' ? entry.editTime : null,
          error: null,
        };
      }
      return { historyVersionId: null, revisionId: null, historyTime: null, error: 'history_list_empty' };
    } catch (error) {
      const code = error instanceof LarkCliError ? (error.upstreamCode ?? error.code) : 'history_list_failed';
      return { historyVersionId: null, revisionId: null, historyTime: null, error: String(code) };
    }
  }

  /** anchor_exact（U23，与 FeishuWriteService 同公式）：锥点历史时间 ≥ 写前云端 obj_edit_time（秒级取整）；任一侧不可读 → false。 */
  private computeAnchorExact(anchorHistoryTime: string | null, preObjEditTime: number | null): boolean {
    if (anchorHistoryTime == null || preObjEditTime == null) return false;
    const anchorMs = Date.parse(anchorHistoryTime);
    if (!Number.isFinite(anchorMs) || !Number.isFinite(preObjEditTime)) return false;
    return Math.floor(anchorMs / 1000) >= Math.floor(preObjEditTime);
  }

  /** 锥点行写后状态更新（best-effort：主写入已完成，失败只记控制台，与 P0-S3 同容错）。 */
  private safeUpdatePushLog(
    pushLogId: string | null,
    patch: {
      outcome?: 'started' | 'pushed' | 'conflict' | 'failed' | 'unknown';
      postRevisionId?: string | null;
      postObjEditTime?: string | null;
    },
  ): void {
    if (!pushLogId) return;
    try {
      this.deps.localMapStore.updateSourcePushLog(pushLogId, patch);
    } catch (error) {
      console.error('[KbPublishService] source_push_log update failed:', error);
    }
  }

  // ------------------------------------------------------------------
  // 执行（§4.4：逐文档串行，全局一个发布任务互斥）
  // ------------------------------------------------------------------

  async execute(options: {
    releaseId?: string;
    kbPaths?: string[];
    force?: boolean;
    confirm: string;
    planKey?: string;
    actor?: PublishActor;
  }): Promise<PublishRunResultDto> {
    // T4b-01：同步占用准入——检查与置位之间没有任何 await，同实例并发
    // 第二请求必然在此被拒。此前检查在 buildPlan 之前、置位在其后，存在
    // 异步准入窗口：两个首发布计划都读到空映射，各自 create 出重复云
    // 文档，先结束者还会释放后者仍需的全局标记。整体 try/finally 保证
    // 门控/计划/确认校验失败也释放准入；release 使用中标记只在真正持有
    // 者（本任务）标记后于 finally 释放。
    if (this.publishRunning) {
      throw new PublicationError('publish_in_progress', '已有发布任务进行中，请等待结束后再发起', 409);
    }
    this.publishRunning = true;
    let inUseReleaseId: string | null = null;
    try {
      const config = await this.config();
      const target = await this.requireGates(config);
      const actor: PublishActor = options.actor === 'cli' || options.actor === 'agent' ? options.actor : 'ui';
      const { dto: plan, renders } = await this.buildPlan(options);
      if (options.planKey !== undefined && options.planKey !== plan.planKey) {
        throw new PublicationError(
          'publish_plan_changed',
          '发布计划已变化（批准与执行之间 release 内容或云端状态发生变化），请重新预览确认',
          409,
          { expected: options.planKey, actual: plan.planKey },
        );
      }
      if (options.confirm !== plan.confirmRequired) {
        throw new PublicationError(
          'confirmation_required',
          `发布到飞书需要 confirm: "${plan.confirmRequired}"`,
          400,
          { required: plan.confirmRequired },
        );
      }

      markReleaseInUse(plan.releaseId);
      inUseReleaseId = plan.releaseId;
      this.appendAudit({
        event: 'publish_started', actor, releaseId: plan.releaseId,
        target: { kind: target.kind, token: target.token },
        items: plan.items.length, force: options.force === true,
      });
      const results: PublishItemResultDto[] = [];
      const createdUrls = new Map<string, string>();
      const counts = { created: 0, updated: 0, skipped: 0, blocked: 0, failed: 0, secondPass: 0 };
      // T4b-06（批C）：第二遍准入排除集——第一遍未确认成功（unknown/failed/
      // blocked/cloud_missing）的文档本批不再重发。第二遍互链回写只接纳
      // 本批确认成功或安全 skip 的项：unknown 的云端写入未经人工核对，
      // 同批自动重发会在未知结果之上二次覆盖（t4b-secondpass-timeout 反例）。
      const firstPassUnresolved = new Set<string>();
      for (const item of plan.items) {
        if (item.action === 'skip_unchanged') {
          counts.skipped += 1;
          results.push(this.itemResult(item, 'skipped', item.state ?? 'published', item.warnings));
          continue;
        }
        if (item.action === 'blocked') {
          counts.blocked += 1;
          const error = `blocked: ${item.blockedReason ?? 'unknown'}`;
          this.recordBlocked(item, target.token);
          this.appendAudit({
            event: 'item_failed', actor, releaseId: plan.releaseId, kbPath: item.kbPath,
            cloudToken: item.cloudToken, result: 'blocked', errorCode: item.blockedReason,
          });
          results.push(this.itemResult(item, 'blocked', this.deps.localMapStore.getKbPublication(item.kbPath)?.state as KbPublicationState ?? 'failed', item.warnings, error));
          continue;
        }
        const render = renders.get(item.kbPath);
        if (!render) {
          counts.failed += 1;
          results.push(this.itemResult(item, 'failed', 'failed', item.warnings, 'render 缓存缺失'));
          continue;
        }
        if (item.action === 'create') {
          const outcome = await this.runCreate(item, render, plan.releaseId, target, actor);
          if (outcome.outcome !== 'created') firstPassUnresolved.add(item.kbPath);
          counts[outcome.outcome === 'created' ? 'created' : 'failed'] += 1;
          if (outcome.cloudUrl) createdUrls.set(item.kbPath, outcome.cloudUrl);
          results.push(outcome);
        } else {
          const outcome = await this.runUpdate(item, render, plan.releaseId, actor, false, options.force === true);
          if (outcome.outcome !== 'updated') firstPassUnresolved.add(item.kbPath);
          if (outcome.outcome === 'updated') counts.updated += 1;
          else if (outcome.outcome === 'blocked') counts.blocked += 1;
          else counts.failed += 1;
          results.push(outcome);
        }
      }

      // ---- 两遍发布（§4.3）：本批新建文档的 URL 回填互链后按需 overwrite 一次 ----
      if (createdUrls.size > 0) {
        const config2 = await this.config();
        const store = new StandardKbStore(config2.standardKb.outputRoot);
        const manifest = store.readManifest(plan.releaseId);
        if (manifest) {
          // 第二遍映射 = 全部已发布行 URL（含本批之外/子集外的既有发布，
          // 与第一遍 publishedUrlByKbPath 同源）+ 本批新建 URL（后写覆盖）。
          // 只用 skip_unchanged 项种子会丢失 update 项/未选中项的既有 URL，
          // 导致第二遍把已改写链接降级为去链接文字。
          const urlMap2 = new Map<string, string>();
          for (const row of this.deps.localMapStore.listKbPublications()) {
            if ((row.state === 'published' || row.state === 'published_with_warnings')
              && typeof row.cloudUrl === 'string' && row.cloudUrl.length > 0) {
              urlMap2.set(row.kbPath, row.cloudUrl);
            }
          }
          for (const [kbPath, url] of createdUrls) urlMap2.set(kbPath, url);
          for (const item of plan.items) {
            if (item.action === 'create' || item.action === 'update' || item.action === 'skip_unchanged') {
              // T4b-06（批C）：第一遍 unknown/failed/blocked 的文档不参与第二遍
              // （每文档单次尝试；unknown 重发须人工核对后另行显式发起，不由
              // 同批互链回写代发）。
              if (firstPassUnresolved.has(item.kbPath)) continue;
              // 无 cloud_token 的项（首遍创建失败）无从 overwrite，跳过
              if (!this.deps.localMapStore.getKbPublication(item.kbPath)?.cloudToken) continue;
              const doc = manifest.docs.find((candidate) => candidate.path === item.kbPath);
              if (!doc) continue;
              try {
                const loaded = store.readReleaseDoc(manifest.releaseId, doc);
                const second = renderForPublish({ kbPath: item.kbPath, markdown: loaded.markdown, publishedUrlByKbPath: urlMap2 });
                const first = renders.get(item.kbPath);
                if (first && second.contentHash !== first.contentHash) {
                  const render2: RenderCacheEntry = {
                    kbPath: item.kbPath,
                    title: second.title || item.title,
                    body: second.body,
                    warnings: second.warnings as PublicationWarningDto[],
                    contentHash: second.contentHash,
                  };
                  const outcome = await this.runUpdate(item, render2, plan.releaseId, actor, true, options.force === true);
                  counts.secondPass += 1;
                  if (outcome.outcome !== 'updated') {
                    if (outcome.outcome === 'blocked') counts.blocked += 1;
                    else counts.failed += 1;
                  }
                  results.push(outcome);
                }
              } catch {
                /* 第二遍渲染失败保留第一遍结果（互链已在预览警告中可见） */
              }
            }
          }
        }
      }

      // ---- kb_removed 标记（全量模式；不执行任何远端动作） ----
      const removedMarked: string[] = [];
      for (const kbPath of plan.removed) {
        const row = this.deps.localMapStore.getKbPublication(kbPath);
        if (row && row.state !== 'kb_removed') {
          this.deps.localMapStore.upsertKbPublication({ ...row, state: 'kb_removed' });
          removedMarked.push(kbPath);
        }
      }

      this.appendAudit({
        event: 'publish_finished', actor, releaseId: plan.releaseId,
        counts: { ...counts }, removedMarked: removedMarked.length,
      });
      return { releaseId: plan.releaseId, target, items: results, removedMarked, counts };
    } finally {
      if (inUseReleaseId !== null) releaseInUseEnded(inUseReleaseId);
      this.publishRunning = false;
    }
  }

  /** blocked 项落账：publish_cloud_edited → 行置 conflict（§4.7），其余状态原样保留。 */
  private recordBlocked(item: PublishPlanItemDto, targetToken: string): void {
    if (item.blockedReason !== 'publish_cloud_edited') return;
    const row = this.deps.localMapStore.getKbPublication(item.kbPath);
    this.deps.localMapStore.upsertKbPublication({
      kbPath: item.kbPath,
      cloudToken: item.cloudToken ?? null,
      cloudUrl: item.cloudUrl ?? null,
      targetToken: row?.targetToken ?? targetToken,
      publishedReleaseId: row?.publishedReleaseId ?? null,
      publishedContentHash: row?.publishedContentHash ?? null,
      publishedObjEditTime: row?.publishedObjEditTime ?? null,
      state: 'conflict',
      warningsJson: row?.warningsJson ?? null,
      lastError: '云端文档在发布后有新的修改（publish_cloud_edited）：请核对云端后以 force + OVERWRITE_PUBLISHED 覆盖，或放弃更新',
    });
  }

  private itemResult(
    item: PublishPlanItemDto,
    outcome: PublishItemResultDto['outcome'],
    state: KbPublicationState,
    warnings: PublicationWarningDto[],
    error?: string,
  ): PublishItemResultDto {
    return {
      kbPath: item.kbPath,
      action: item.action,
      outcome,
      state,
      cloudToken: item.cloudToken,
      cloudUrl: item.cloudUrl,
      warnings,
      ...(error !== undefined ? { error } : {}),
    };
  }

  // ------------------------------------------------------------------
  // 单项执行
  // ------------------------------------------------------------------

  /**
   * 旧 cloud_token 归档（§4.7：unknown/cloud_missing 重新发布为新文档时）。
   * T4b-07（批C）：previousCloudTokens 谱系的保留与当前行是否仍有
   * cloud_token 无关——force 重建失败（行已清 token）后再次 force 成功的
   * 故障恢复链里，既有谱系必须原样带过（当前 cloud_token 仅作可选追加），
   * 否则旧 token 退出快照排除集、防自我喂养不变量被破坏
   * （t4b-replay-review F07 反例）。空谱系不写 previousCloudTokens 字段
   * （保持首次发布行为不变）。
   */
  private archivedTokens(item: PublishPlanItemDto): { warnings: PublicationWarningDto[]; previousCloudTokens?: string[] } {
    const row = this.deps.localMapStore.getKbPublication(item.kbPath);
    const parsed = KbPublishService.parseWarningsJson(row?.warningsJson ?? null);
    const previous = new Set<string>(parsed.previousCloudTokens ?? []);
    if (row?.cloudToken) previous.add(row.cloudToken);
    if (previous.size === 0) return { warnings: parsed.warnings };
    return { warnings: parsed.warnings, previousCloudTokens: [...previous] };
  }

  private async runCreate(
    item: PublishPlanItemDto,
    render: RenderCacheEntry,
    releaseId: string,
    target: PublishTargetConfig,
    actor: PublishActor,
  ): Promise<PublishItemResultDto> {
    const archived = this.archivedTokens(item);
    this.deps.localMapStore.upsertKbPublication({
      kbPath: item.kbPath,
      cloudToken: null,
      cloudUrl: null,
      targetToken: target.token,
      publishedReleaseId: null,
      publishedContentHash: null,
      publishedObjEditTime: null,
      state: 'creating',
      warningsJson: JSON.stringify({ warnings: render.warnings, ...(archived.previousCloudTokens ? { previousCloudTokens: archived.previousCloudTokens } : {}) }),
      lastError: null,
    });
    let created: { documentId: string; url: string | null; revisionId: number | null };
    try {
      created = await this.deps.larkCliClient.createDocumentMarkdown({
        title: render.title,
        markdown: render.body,
        parentToken: target.token,
      });
    } catch (error) {
      // T4b-06：create 专属分类——命令发出后结果不确定（超时/解析失败/
      // 缺 document_id）→ unknown，不自动重发（非幂等，防重复云文档）。
      const classified = this.classifyCreateError(error);
      this.deps.localMapStore.upsertKbPublication({
        kbPath: item.kbPath, cloudToken: null, cloudUrl: null, targetToken: target.token,
        state: classified.state,
        // T4b-07：失败落账不擦除 previousCloudTokens 谱系（归档值随 creating 行已写入）。
        warningsJson: JSON.stringify({
          warnings: render.warnings,
          ...(archived.previousCloudTokens ? { previousCloudTokens: archived.previousCloudTokens } : {}),
        }),
        lastError: classified.message,
      });
      this.appendAudit({ event: 'item_failed', actor, releaseId, kbPath: item.kbPath, result: classified.state, errorCode: classified.code, error: classified.message });
      return this.itemResult(item, classified.outcome, classified.state, render.warnings, classified.message);
    }
    const verify = await this.verifyPublished(created.documentId, render.body, item.kbPath);
    const state: KbPublicationState = verify.warnings.length > 0 ? 'published_with_warnings' : 'published';
    const warnings = [...render.warnings, ...verify.warnings];
    this.deps.localMapStore.upsertKbPublication({
      kbPath: item.kbPath,
      cloudToken: created.documentId,
      cloudUrl: created.url,
      targetToken: target.token,
      publishedReleaseId: releaseId,
      publishedContentHash: render.contentHash,
      publishedObjEditTime: verify.objEditTime != null ? String(verify.objEditTime) : null,
      state,
      warningsJson: JSON.stringify({ warnings, ...(archived.previousCloudTokens ? { previousCloudTokens: archived.previousCloudTokens } : {}) }),
      lastError: null,
    });
    this.appendAudit({
      event: 'item_created', actor, releaseId, kbPath: item.kbPath,
      cloudToken: created.documentId, contentHash: render.contentHash,
      state, objEditTime: verify.objEditTime,
    });
    return {
      kbPath: item.kbPath,
      action: item.action,
      outcome: 'created',
      state,
      cloudToken: created.documentId,
      cloudUrl: created.url,
      warnings,
    };
  }

  /**
   * update（T4b-02/T4b-04 修订）：云端时间安全门 → 写前历史锚点 +
   * push_log 落行 → fetch revision → overwrite（client 内部三段式 revision
   * 语义）→ 回读校验。第一遍与第二遍共用同一安全门：每次实际 overwrite
   * 前重新取云端 obj_edit_time 与行基线比对（计划阶段批量取值不得作为
   * 长批次末尾写入的唯一复核，含首遍 skip_unchanged→第二遍 update 的
   * 转换）；前进或不可读 → fail-closed 阻断该文档并置 conflict，重发需
   * 重新派生批准（force + OVERWRITE_PUBLISHED），不能沿用 PUBLISH。
   * force（已持 OVERWRITE_PUBLISHED）越过时间门；锚点门不因 force 豁免
   * （与 FeishuWriteService §4.2 同语义：force 是接受覆盖，不是放弃回退点）。
   */
  private async runUpdate(
    item: PublishPlanItemDto,
    render: RenderCacheEntry,
    releaseId: string,
    actor: PublishActor,
    secondPass: boolean,
    force: boolean,
  ): Promise<PublishItemResultDto> {
    const row = this.deps.localMapStore.getKbPublication(item.kbPath);
    const token = row?.cloudToken ?? item.cloudToken;
    if (!token) {
      return this.itemResult(item, 'failed', 'failed', render.warnings, '缺少 cloud_token，无法更新发布');
    }
    const targetToken = row?.targetToken ?? '';

    // ---- T4b-02：执行期时间门（第一遍/第二遍共用） ----
    let preCloudTime: number | null = null;
    if (!force) {
      const times = await this.fetchCloudEditTimes([token]);
      const cloudTime = times.get(token) ?? null;
      const baseTime = row?.publishedObjEditTime != null ? Number(row.publishedObjEditTime) : NaN;
      const readable = typeof cloudTime === 'number' && Number.isFinite(cloudTime)
        && Number.isFinite(baseTime);
      if (!readable || (cloudTime as number) > baseTime) {
        const message = `执行时检测到云端文档在发布后有新的修改（publish_cloud_edited：obj_edit_time ${row?.publishedObjEditTime ?? '?'} → ${cloudTime ?? '不可读'}${secondPass ? '；第二遍互链回写' : ''}）：已阻断本次覆盖，请核对云端后以 force + ${PUBLISH_OVERWRITE_CONFIRM} 重新确认，或放弃更新`;
        this.recordBlocked({ ...item, cloudToken: token, blockedReason: 'publish_cloud_edited', cloudEdited: true }, targetToken);
        this.appendAudit({
          event: 'item_failed', actor, releaseId, kbPath: item.kbPath, cloudToken: token,
          result: 'blocked', errorCode: 'publish_cloud_edited', secondPass,
        });
        return this.itemResult(item, 'blocked', 'conflict', render.warnings, message);
      }
      preCloudTime = cloudTime;
    }

    // ---- T4b-04：写前历史锚点（P0-S3 原语；无锚/落库失败拒绝覆盖） ----
    const anchor = await this.fetchRollbackAnchor(token);
    if (anchor.historyVersionId == null) {
      return this.refuseUpdate(item, row, token, 'rollback_anchor_unavailable',
        `无法取得云端历史回退锚点（${anchor.error ?? 'history_list_empty'}）：覆盖会改写云端块结构，发布更新已拒绝执行（云端未做任何修改）。请稍后重试`,
        { releaseId, actor, secondPass, render });
    }
    if (preCloudTime == null) {
      // force 越过时间门时尽力补读写前云端时间（失败可空——force 语义）
      const times = await this.fetchCloudEditTimes([token]).catch(() => null);
      preCloudTime = times?.get(token) ?? null;
    }
    let pushLogId: string | null = null;
    try {
      pushLogId = this.deps.localMapStore.insertSourcePushLog({
        objToken: token,
        localRelPath: `kb:${item.kbPath}`,
        mode: 'overwrite',
        actor: `publish:${actor}`,
        preObjEditTime: preCloudTime,
        anchorHistoryId: anchor.historyVersionId,
        anchorHistoryTime: anchor.historyTime,
        anchorExact: this.computeAnchorExact(anchor.historyTime, preCloudTime),
        anchorError: anchor.error,
      });
    } catch (logError) {
      return this.refuseUpdate(item, row, token, 'push_log_unavailable',
        `写前锚点日志写入失败，发布更新已拒绝（云端未做任何修改）：${logError instanceof Error ? logError.message : String(logError)}`,
        { releaseId, actor, secondPass, render });
    }

    let overwriteIssued = false;
    try {
      const revisionInfo = await this.deps.larkCliClient.fetchDocumentRevision(token);
      const revision = revisionInfo?.revisionId ?? revisionInfo?.revision_id ?? null;
      if (typeof revision !== 'number' || !Number.isFinite(revision)) {
        throw new PublicationError('publish_revision_unreadable', '无法读取云端文档 revision（更新前置条件缺失），本次未写入任何内容', 502);
      }
      // T4b-06（批C）：overwrite 命令即将发出——此后 catch 中的
      // parse/incomplete_response/timeout 按「写后未知」分类（unknown），
      // 与写前只读失败（如 fetchRevision 抛 parse → failed 可重试）区分。
      overwriteIssued = true;
      const overwriteResult = await this.deps.larkCliClient.overwriteDocument(token, render.body, revision);
      const verify = await this.verifyPublished(token, render.body, item.kbPath);
      const state: KbPublicationState = verify.warnings.length > 0 ? 'published_with_warnings' : 'published';
      const warnings = [...render.warnings, ...verify.warnings];
      this.deps.localMapStore.upsertKbPublication({
        kbPath: item.kbPath,
        cloudToken: token,
        cloudUrl: row?.cloudUrl ?? null,
        targetToken,
        publishedReleaseId: releaseId,
        publishedContentHash: render.contentHash,
        publishedObjEditTime: verify.objEditTime != null ? String(verify.objEditTime) : null,
        state,
        // T4b-07：警告/状态更新不擦除 previousCloudTokens 谱系
        warningsJson: KbPublishService.mergeWarningsJson(row?.warningsJson, warnings),
        lastError: null,
      });
      this.safeUpdatePushLog(pushLogId, {
        outcome: 'pushed',
        postRevisionId: typeof overwriteResult?.revisionId === 'number' ? String(overwriteResult.revisionId) : null,
        postObjEditTime: verify.objEditTime != null ? String(verify.objEditTime) : null,
      });
      this.appendAudit({
        event: 'item_updated', actor, releaseId, kbPath: item.kbPath, cloudToken: token,
        contentHash: render.contentHash, state, secondPass, objEditTime: verify.objEditTime,
        pushLogId,
      });
      return {
        kbPath: item.kbPath,
        action: item.action,
        outcome: 'updated',
        state,
        cloudToken: token,
        cloudUrl: row?.cloudUrl ?? null,
        warnings,
      };
    } catch (error) {
      const classified = overwriteIssued ? this.classifyOverwriteError(error) : this.classifyError(error);
      this.safeUpdatePushLog(pushLogId, {
        outcome: classified.state === 'unknown' ? 'unknown' : 'failed',
      });
      this.deps.localMapStore.upsertKbPublication({
        kbPath: item.kbPath,
        cloudToken: token,
        cloudUrl: row?.cloudUrl ?? null,
        targetToken,
        publishedReleaseId: row?.publishedReleaseId ?? null,
        publishedContentHash: row?.publishedContentHash ?? null,
        publishedObjEditTime: row?.publishedObjEditTime ?? null,
        state: classified.state,
        warningsJson: row?.warningsJson ?? null,
        lastError: classified.message,
      });
      this.appendAudit({ event: 'item_failed', actor, releaseId, kbPath: item.kbPath, cloudToken: token, result: classified.state, errorCode: classified.code, secondPass, error: classified.message });
      return this.itemResult(item, classified.outcome, classified.state, render.warnings, classified.message);
    }
  }

  /**
   * runUpdate 的 fail-closed 拒绝落账（T4b-04）：云端零写入，行置 failed
   * 并保留发布基线（下次计划仍按 hash 差异进入 update 候选，可重试）。
   */
  private refuseUpdate(
    item: PublishPlanItemDto,
    row: KbPublicationRecord | null,
    token: string,
    errorCode: string,
    message: string,
    context: { releaseId: string; actor: PublishActor; secondPass: boolean; render: RenderCacheEntry },
  ): PublishItemResultDto {
    this.deps.localMapStore.upsertKbPublication({
      kbPath: item.kbPath,
      cloudToken: token,
      cloudUrl: row?.cloudUrl ?? null,
      targetToken: row?.targetToken ?? '',
      publishedReleaseId: row?.publishedReleaseId ?? null,
      publishedContentHash: row?.publishedContentHash ?? null,
      publishedObjEditTime: row?.publishedObjEditTime ?? null,
      state: 'failed',
      warningsJson: row?.warningsJson ?? null,
      lastError: message,
    });
    this.appendAudit({
      event: 'item_failed', actor: context.actor, releaseId: context.releaseId,
      kbPath: item.kbPath, cloudToken: token, result: 'failed', errorCode, secondPass: context.secondPass,
    });
    return this.itemResult(item, 'failed', 'failed', context.render.warnings, message);
  }

  // ------------------------------------------------------------------
  // 回读校验（§4.5）与 obj_edit_time 基线
  // ------------------------------------------------------------------

  private async verifyPublished(cloudToken: string, body: string, kbPath: string): Promise<{ warnings: PublicationWarningDto[]; objEditTime: number | null }> {
    const warnings: PublicationWarningDto[] = [];
    const localChars = countText(body).chars;
    try {
      const profile = await this.deps.larkCliClient.parseDocumentProfile(cloudToken);
      const cloudChars = typeof profile?.charCount === 'number' && Number.isFinite(profile.charCount) ? profile.charCount : null;
      if (cloudChars == null) {
        warnings.push({ code: 'publish_verify_unavailable', kbPath, text: 'parse 回读未返回 char_count，无法完成转换完整性校验' });
      } else {
        const ratio = localChars > 0 ? (cloudChars as number) / localChars : null;
        const outOfRange = ratio == null
          ? (cloudChars as number) > 0
          : ratio < PUBLISH_VERIFY_RATIO_MIN || ratio > PUBLISH_VERIFY_RATIO_MAX;
        if (outOfRange) {
          warnings.push({
            code: 'publish_verify_mismatch', kbPath, local: localChars, cloud: cloudChars,
            text: `回读字符数比值越界（local=${localChars} cloud=${cloudChars}，区间 [${PUBLISH_VERIFY_RATIO_MIN}, ${PUBLISH_VERIFY_RATIO_MAX}]），可能存在整段丢失或转换异常，请人工核对`,
          });
        }
      }
    } catch (error) {
      warnings.push({
        code: 'publish_verify_unavailable', kbPath,
        text: `parse 回读校验失败（${String(error instanceof Error ? error.message : error).slice(0, 200)}）`,
      });
    }
    let objEditTime: number | null = null;
    try {
      const metas = await this.deps.larkCliClient.getDocumentMetas([{ docToken: cloudToken, docType: 'docx' }]);
      const time = metas?.metas?.[0]?.latestModifyTime;
      if (typeof time === 'number' && Number.isFinite(time)) objEditTime = time;
    } catch {
      objEditTime = null;
    }
    return { warnings, objEditTime };
  }

  /**
   * 错误分类（§4.4）：
   *   子进程超时 → unknown（写入结果未知，不自动重建）；
   *   404/981003/已删除 → cloud_missing（不重建）；
   *   其余业务错误 → failed。
   */
  private classifyError(error: unknown): { state: KbPublicationState; outcome: PublishItemResultDto['outcome']; code: string; message: string } {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    if (error instanceof LarkCliError) {
      if (error.code === 'timeout') {
        return { state: 'unknown', outcome: 'unknown', code: 'timeout', message: `lark-cli 子进程超时，写入结果未知：${message}。已标记 unknown，请到发布根核对后再决定是否重新发布为新文档` };
      }
      const codeText = `${error.code ?? ''} ${error.upstreamCode ?? ''} ${message}`;
      if (/(?:^|\W)(?:404|981003)(?:\W|$)/i.test(codeText) || /not.?found|deleted|不存在|已删除/i.test(codeText)) {
        return { state: 'cloud_missing', outcome: 'cloud_missing', code: error.upstreamCode ?? error.code, message: `云端文档不可访问（${codeText.trim().slice(0, 200)}）：已标记 cloud_missing，不会自动重建` };
      }
      return { state: 'failed', outcome: 'failed', code: error.upstreamCode ?? error.code, message };
    }
    if (error instanceof PublicationError) {
      return { state: 'failed', outcome: 'failed', code: error.code, message };
    }
    return { state: 'failed', outcome: 'failed', code: 'publish_failed', message };
  }

  /**
   * overwrite 写后未知分类（T4b-06 批C，与 create/revert/move 同口径）：
   * docs +update overwrite 命令已发出后响应不可判定（子进程超时 / 响应
   * 解析失败 / 响应形态不完整）一律 unknown——云端可能已受理写入，未经
   * 人工核对的重发会在未知结果之上二次覆盖；普通重发由计划层
   * blocked(state_unknown) 拦截，force 是显式人工核对通道。写前只读失败
   * （revision 读取等）与权威业务拒绝（404/权限）不进本方法，仍走
   * classifyError（failed/cloud_missing），不得笼统把只读失败改成未知。
   */
  private classifyOverwriteError(error: unknown): { state: KbPublicationState; outcome: PublishItemResultDto['outcome']; code: string; message: string } {
    if (error instanceof LarkCliError
      && (error.code === 'timeout' || error.code === 'parse' || error.code === 'incomplete_response')) {
      return {
        state: 'unknown',
        outcome: 'unknown',
        code: error.code,
        message: `覆盖写回命令已发出但结果不确定（${(error instanceof Error ? error.message : String(error)).slice(0, 300)}）：已标记 unknown，请到发布根核对文档内容后再决定是否重新发布`,
      };
    }
    return this.classifyError(error);
  }

  /**
   * create 专属错误分类（T4b-06）：docs +create 非幂等——命令已发出后
   * 结果不确定（子进程超时 / 响应解析失败 / 缺 document_id，客户端对后
   * 者抛 code='incomplete_response'）一律 unknown，不自动重发（防重复
   * 云文档）；与写前校验错误（客户端普通 Error → failed，可重试）和
   * 权威业务拒绝
   * （404/权限等 → failed/cloud_missing）区分。
   */
  private classifyCreateError(error: unknown): { state: KbPublicationState; outcome: PublishItemResultDto['outcome']; code: string; message: string } {
    if (error instanceof LarkCliError
      && (error.code === 'timeout' || error.code === 'parse' || error.code === 'incomplete_response')) {
      return {
        state: 'unknown',
        outcome: 'unknown',
        code: error.code,
        message: `创建命令已发出但结果不确定（${(error instanceof Error ? error.message : String(error)).slice(0, 300)}）：已标记 unknown，请到发布根核对是否已生成文档；确认未生成后以 force 重新发布为新文档`,
      };
    }
    return this.classifyError(error);
  }
}
