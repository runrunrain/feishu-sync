/**
 * SyncEngine - Document synchronization orchestration
 *
 * Implements the design from 技术实现文档 §八 and 架构设计文档 §6.2:
 * - syncDocuments(): Batch synchronization with error handling
 * - syncSingleDocument(): Individual document sync pipeline
 * - fetchDocumentContent(): lark-cli docs +fetch wrapper
 * - downloadImages(): Three-tier fallback (curl -> media-download -> media-preview)
 * - downloadAttachments(): media-download for attachments
 * - writeLocalMarkdown(): HTML comment header + .md.bak backup
 * - updateLocalMap(): LocalMapStore upsert with status=synced
 *
 * P0-Q3 实测 confirmed Feishu markdown export contains NO
 * <synced_reference> tags in this deployment, so synced-block drilling
 * (R3.9 / M2-B / 03 §3.4) is intentionally NOT implemented (per diting
 * P2-core review Mi-3, dead-code cleanup). Table reconstruction / LLM
 * adaptation (M3) are optional injections.
 */

import path from 'node:path';
import fs from 'node:fs';
import { resolveInside } from '../agent/path-guard.js';
import { resolveDataRoot } from './data-root.js';
import type {
  ChangedDocument,
  DocumentRecord,
  SyncResult,
  SyncOptions,
  SyncedDocument,
  FailedDocument,
  PlannedSyncDocument,
  SyncFailureReasonCode,
  SyncRepairAction,
  WatchedRootConfig,
} from '../types/index.js';
import {
  completeOperationManifest,
  createOperationManifest,
  fallbackMarkdownTarget,
  resolveOperationDirectory,
  resolveSyncMode,
  writeOperationManifest,
} from './operation-manifest.js';
import {
  resolveAbsolute,
  resolveLocalTarget,
  toPortableRelative,
} from './path-resolver.js';
import { commitDocumentContent } from './content-commit.js';
import crypto from 'node:crypto';
import { withSyncPerformance, measureSyncPhase, recordSyncDuration } from './sync-performance.js';
import type { AdaptOutput } from './content-backend.js';
import type { DocumentIR } from './document-ir.js';
import {
  commitAtomicPlan,
  createAtomicCommitWorkspace,
  emptyCommitPlan,
  rollbackAtomicPlan,
  stageFileContent,
} from './atomic-commit.js';
import {
  extractFeishuMediaReferences,
  rewriteFeishuMediaReferences,
} from './media-reference.js';
import {
  annotateCsvWithImages,
  downloadSheetMedia,
  probeSheetFloatImages,
  renderSheetMediaAppendix,
  type SheetMediaItem,
} from './sheet-media.js';
import {
  BitableExporter,
  type BitableExportResult,
} from './bitable-exporter.js';
import { adaptSlidesXmlToMarkdown } from './slides-xml-adapter.js';
import { LarkCliError } from './lark-cli-client.js';
// P1-S5（设计 §3.1）：同步侧截图只在可选读 scope 已授权时才调用；scope
// 清单来自 lark-cli-manager 的注册表（无循环依赖：manager 不回依赖本模块）。
import { optionalScopesForFeature } from './lark-cli-manager.js';
import { stageSourceWorkbook, WorkbookAcquisitionError, readReconstructedSheetCsv } from './sheet-workbook.js';
import { managedWorkbookCompanions } from './workbook-source.js';
// P0-S8：白板旁路导出链自 S6 方法体提炼为共享纯函数——downloadImages、
// backfillWhiteboardBypass 与 custom-doc-sync（归档链）复用同一实现，
// 防止三处分叉（见 whiteboard-bypass.ts 模块头）。
import {
  exportWhiteboardBypassFile,
  resolveWhiteboardExportOptionsFromConfig,
  type WhiteboardBypassFile,
  type WhiteboardBypassOptions,
} from './whiteboard-bypass.js';
// S11（设计 §7.3）：同步提交与源编辑共享 per-token 写锁与 dirty blocker。
// 锁实例与 SourceEditService 默认使用同一进程级单例（source-write-lock.ts）。
import { sharedSourceWriteLock, type SourceWriteLockLike } from '../sources/source-write-lock.js';
// P1-S3（设计 P1 §2.2）：同步提交事务内写引用边——组合入口纯函数，
// 一次完成 body 主体 + refmap 补充 + 合并归一 + 自引用/媒体排除 + 上限。
import { extractDocumentReferences, type ExtractDocumentReferencesResult } from '../kb/reference-graph.js';
// P2-S4（设计 P2 §5.1）：同一 fetch 响应 reference_map.comments 组的评论
// 采集——纯函数解析（fixture 驱动，容错键缺失），与引用边同事务入库。
import { extractRefmapComments, type RefmapCommentsExtraction } from '../kb/source-comments.js';

interface FetchedDocument {
  content: string;
  /** P1-S3：fetch 响应 document.reference_map 原值（键可能整体缺失，RP-3）；仅 docx 携带。 */
  referenceMap?: unknown;
  images: Array<{
    token: string;
    url?: string;
    name?: string;
    kind: 'image' | 'whiteboard';
  }>;
  attachments: Array<{ token: string; name: string }>;
  sheets: Array<{ token: string; title: string }>;
  /** Slides XML media belongs to a page rather than a docs +fetch body span. */
  slideMedia?: Array<{
    token: string;
    kind: 'image' | 'whiteboard';
    slideNumber: number;
  }>;
  /** P1-S5：幻灯片总页数（截图分批与 all-or-none 的页清单来源）。 */
  slideCount?: number;
  url: string;
  obj_token: string;
}

/**
 * Normalized metadata consumed by generateHtmlHeader to emit the
 * YAML-in-comment header (header_format = yaml_html, see
 * index-scanner.ts parseYamlHtmlHeader).
 *
 * Field sourcing (no fabrication — every value comes from the live
 * sync context):
 *   - objToken / objType / lastSyncedModifyTime: straight off the
 *     ChangedDocument (populated by ChangeDetector from lark-cli).
 *   - fetchDate: current wall clock.
 *   - wikiNodeToken / spaceId: read from SQLite via getDocumentByObjToken.
 *     ChangeDetector.upsertDocumentSeen (change-detector.ts:609-616)
 *     persists BOTH for added and modified docs before the sync pipeline
 *     runs, so even a brand-new added sheet has these available without
 *     an extra lark-cli round-trip in SyncEngine.
 *   - originalLink: resolved by resolveHeaderMeta with precedence
 *     fetched.url → SQLite.original_link → constructed from
 *     wiki_node_token + feishu host.
 *
 * Nullable fields are OMITTED from the YAML block by generateHtmlHeader
 * (never written as empty strings) so IndexScanner.extractYamlFields is
 * never fed empty values.
 */
interface HeaderMeta {
  objToken: string;
  objType: 'docx' | 'sheet' | 'slides' | 'bitable' | 'unknown';
  wikiNodeToken: string | null;
  spaceId: string | null;
  originalLink: string | null;
  fetchDate: string;
  lastSyncedModifyTime: string;
}

interface Image {
  token: string;
  path: string;
  kind: 'image' | 'whiteboard';
  /**
   * P0-S6（设计 §5.2/§5.3 + P0-S1 HP-4 裁定）：白板引用的旁路导出文件，
   * 与 PNG 同主干（<stem>.wb.svg / <stem>.wb.raw.json），不被 md 引用、
   * 不进 feishu_sync 头（§5.5 快照判定在 S7，构建侧按命名约定寻址）。
   * svg 是主产物；raw 是 svg 失败/超时/校验不过时的降级产物。
   */
  whiteboardBypass?: WhiteboardBypassFile;
}

interface Attachment {
  token: string;
  path: string;
  name: string;
}

/** P0-S8（设计 §5.8）存量补齐的单条跳过记录：reason 值域见 backfillWhiteboardBypass 注释。 */
export interface WhiteboardBackfillSkipEntry {
  objToken: string;
  reason: string;
}

/**
 * P0-S8（设计 §5.8）存量补齐结果：只新增旁路文件，md 字节与 DB 基线
 * 字段前后不变（committedFiles 仅为本次 atomic-commit 入库的旁路相对
 * 路径，POSIX 形态，供报告/测试锚定）。
 */
export interface WhiteboardBackfillResult {
  /** 已检视的 synced 文档数。 */
  scanned: number;
  /** 本次新入库的旁路文件数（.wb.svg / .wb.raw.json）。 */
  exported: number;
  skipped: WhiteboardBackfillSkipEntry[];
  committedFiles: string[];
}

/** Test-only fault injection for Gate 3 SyncEngine apply path. */
export interface SyncEngineTestHooks {
  /** Fail after atomic file commit, before any DB write — must restore files. */
  failAfterFileCommit?: boolean;
  /**
   * Fail after markDocumentSynced inside the DB transaction (e.g. after
   * sheet_sheets upsert). Transaction must abort so synced baseline stays put
   * and files must be restored.
   */
  failAfterMarkDocumentSynced?: boolean;
  /** Fail before atomic file commit — KB must stay untouched. */
  failBeforeCommit?: boolean;
  /** After first successful sub-sheet CSV fetch, fail remaining sheets. */
  failSheetAfterFirst?: boolean;
}

interface SyncEngineDeps {
  larkCliClient: any; // LarkCliClient
  localMapStore: any; // LocalMapStore
  config: any; // Config
  layoutReconstructor?: any; // Optional M3 injection
  contentAdapter?: any; // Optional M3 injection
  testHooks?: SyncEngineTestHooks;
  /**
   * S11：与 SourceEditService 共享的 per-objToken 写锁（设计 §7.3「提交经
   * SourceWriteLock」）。缺省回落到进程级共享实例，routes/sync.ts 每请求
   * 构造 SyncEngine 时无需额外注入也能与编辑服务互斥。
   */
  sourceWriteLock?: SourceWriteLockLike;
}

interface ClassifiedSyncFailure {
  message: string;
  retryable: boolean;
  reasonCode: SyncFailureReasonCode;
  suggestedResolution: string;
  repairAction: SyncRepairAction;
}

/**
 * A retry button is useful only for transient failures. Permission denial and
 * a remotely deleted page require a user action in Feishu, so presenting them
 * as endlessly retryable made the sync-result screen misleading.
 */
export function classifySyncFailure(error: unknown): ClassifiedSyncFailure {
  if (error instanceof LarkCliError) {
    if (error.code === 'permission') {
      return {
        message: '无权限访问该节点。请在飞书中将当前 lark-cli 用户加入该节点及其父级的可访问范围后重新检测。',
        retryable: false,
        reasonCode: 'permission_denied',
        suggestedResolution: '请在飞书中把当前 lark-cli user 加入该节点及所有父级的可访问范围；授权后点击“立即检测”，再重试同步。',
        repairAction: 'grant_access',
      };
    }
    if (error.code === 'deleted') {
      return {
        message: '云端文档已删除或不再可编辑。请在飞书中选择有效节点后重新检测；此项不能通过重试恢复。',
        retryable: false,
        reasonCode: 'cloud_deleted',
        suggestedResolution: '此云端页面已删除。请在飞书恢复或替换为有效页面；若确认删除，可在本地回收站保留或清理旧副本。',
        repairAction: 'review_deleted',
      };
    }
    if (error.code === 'rate_limited') {
      return {
        message: '飞书接口正在限流，已停止本次请求以避免继续放大流量。',
        retryable: true,
        reasonCode: 'rate_limited',
        suggestedResolution: '等待短暂冷却后重试；应用会限制并发并共享请求速率上限。',
        repairAction: 'retry',
      };
    }
    return {
      message: error.message,
      retryable: error.retryable,
      reasonCode: 'upstream_error',
      suggestedResolution: error.retryable
        ? '可在网络或飞书服务恢复后重试；应用会限制并发并共享请求速率上限。'
        : '请根据错误详情修正配置或云端状态后重新检测。',
      repairAction: error.retryable ? 'retry' : 'manual_review',
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/尚不能完整重建的富文本对象|尚不能完整重建的对象|含图表或透视表，当前只读重建无法保真/.test(message)) {
    return {
      message,
      retryable: false,
      reasonCode: 'upstream_error',
      suggestedResolution: '原件导出未成功，当前只读重建无法保留这些对象。请检查飞书表格的导出权限及导出设置，允许当前账号导出后重新同步。',
      repairAction: 'manual_review',
    };
  }
  if (/(?:3380003|document page has been deleted|page can no longer be edited|文档.*已删除)/i.test(message)) {
    return {
      message: '云端文档已删除或不再可编辑。请在飞书中选择有效节点后重新检测；此项不能通过重试恢复。',
      retryable: false,
      reasonCode: 'cloud_deleted',
      suggestedResolution: '此云端页面已删除。请在飞书恢复或替换为有效页面；若确认删除，可在本地回收站保留或清理旧副本。',
      repairAction: 'review_deleted',
    };
  }
  if (/(?:40403|131006|无权限|permission|forbidden|access denied)/i.test(message)) {
    return {
      message: '无权限访问该节点。请在飞书中将当前 lark-cli 用户加入该节点及其父级的可访问范围后重新检测。',
      retryable: false,
      reasonCode: 'permission_denied',
      suggestedResolution: '请在飞书中把当前 lark-cli user 加入该节点及所有父级的可访问范围；授权后点击“立即检测”，再重试同步。',
      repairAction: 'grant_access',
    };
  }
  if (/(?:99991400|rate limit|qps|限频|限流)/i.test(message)) {
    return {
      message: '飞书接口正在限流，已停止本次请求以避免继续放大流量。',
      retryable: true,
      reasonCode: 'rate_limited',
      suggestedResolution: '等待短暂冷却后重试；应用会限制并发并共享请求速率上限。',
      repairAction: 'retry',
    };
  }
  return {
    message,
    retryable: true,
    reasonCode: 'upstream_error',
    suggestedResolution: '可在网络或飞书服务恢复后重试；应用会限制并发并共享请求速率上限。',
    repairAction: 'retry',
  };
}

/**
 * These failures cannot be repaired by retrying local work.  They are queued
 * separately so a detector poll does not keep surfacing them as new changes
 * until an operator has acted in Feishu and explicitly requested a recheck.
 */
export function requiresFeishuSideAction(failure: Pick<FailedDocument, 'repairAction'>): boolean {
  return failure.repairAction === 'grant_access'
    || failure.repairAction === 'review_deleted'
    || failure.repairAction === 'enable_export_adapter';
}

/**
 * S11（设计 §7.3）：文档存在未写回的本地修改时的 blocker 契约。
 * 文案对齐设计的前端同步列表措辞；不进 feishu_pending（本地侧动作）。
 */
function localEditPendingFailure(doc: {
  objToken: string;
  title: string;
  watchedRootId?: string | null;
}): FailedDocument {
  return {
    objToken: doc.objToken,
    title: doc.title,
    error: '本地有未写回的修改：写回飞书或放弃修改后再同步',
    retryable: false,
    reasonCode: 'local_edit_pending',
    suggestedResolution: '在原始库编辑面板选择「写回飞书」推送本地修改，或「放弃修改」恢复为上次同步版本，然后再同步。',
    repairAction: 'manual_review',
    watchedRootId: doc.watchedRootId ?? null,
  };
}

function cloudOperationFailure(doc: { objToken: string; title: string; watchedRootId?: string | null }, reason: 'cloud_operation_pending' | 'source_moved_out'): FailedDocument {
  return {
    objToken: doc.objToken, title: doc.title, retryable: false, reasonCode: reason,
    error: reason === 'source_moved_out' ? '文档已移出知识库，不能继续同步' : '云端回滚或移出进行中或结果未知，暂不能同步',
    suggestedResolution: '请在写回记录或移出记录中核对云端任务状态，再决定后续操作。',
    repairAction: 'manual_review', watchedRootId: doc.watchedRootId ?? null,
  };
}

/** Convert a planning guard into the same actionable result contract as a runtime failure. */
function plannedFailure(planned: PlannedSyncDocument): FailedDocument {
  const reasonCode = planned.reasonCode ?? 'unknown';
  const isAdoptableProfileCollision = reasonCode === 'path_conflict'
    && /目标路径已有文件，拒绝自动覆盖/i.test(planned.reason ?? '');
  const repairAction: SyncRepairAction = reasonCode === 'missing_parent_chain'
    ? 'rebuild_parent_chain'
    : isAdoptableProfileCollision
      ? 'adopt_existing_file'
      : reasonCode === 'unsupported_type'
        ? 'enable_export_adapter'
        : reasonCode === 'deleted_requires_confirmation'
          ? 'review_deleted'
          : 'manual_review';
  const fallbackMessage = planned.action === 'move'
    ? '计划涉及路径移动，需通过独立迁移流程确认'
    : '同步计划被安全策略阻止';
  const fallbackResolution = reasonCode === 'missing_parent_chain'
    ? '可使用“自动补齐结构并重试”：应用会完整遍历受影响根目录，补齐父链后仅重试这些文档。'
    : isAdoptableProfileCollision
      ? '若该文件确为同名飞书文档的旧同步版本，可点击“认领本地旧文件并同步”。系统会校验 Markdown 标题完全一致后才会覆盖。'
    : reasonCode === 'unsupported_type'
      ? '当前对象类型没有可用导出适配器。请转换为支持的飞书文档、表格或幻灯片，或启用对应导出适配器后再同步。'
      : '请按路径冲突或云端状态提示处理后，再重新生成同步计划。';
  return {
    objToken: planned.objToken,
    title: planned.title,
    error: planned.reason || fallbackMessage,
    retryable: false,
    reasonCode,
    suggestedResolution: planned.suggestedResolution || fallbackResolution,
    repairAction,
    watchedRootId: planned.watchedRootId ?? null,
    // P2-S8（设计 §4.3/U50）：仅未知类型 blocker 路径透传真实云端类型
    // （undefined 不进 JSON，其余失败路径输出零变化）。
    cloudObjType: reasonCode === 'unsupported_type' ? planned.cloudObjType : undefined,
  };
}

/**
 * S11（设计 §7.3）：同步循环内在锁内产生的单文档结果（blocker 或提交完成）。
 */
type LocalEditSyncOutcome =
  | { kind: 'blocked'; failure: FailedDocument }
  | { kind: 'synced'; doc: SyncedDocument };

/**
 * P0-S8（设计 §5.8）：从本地 md 正文提取白板图片引用路径。
 *
 * 生产者（两端各两处，改其一必须同步另一处）：docx/custom 链
 * renderLocalizedMediaReferences → `![飞书白板](images/NN-<token>.png)`；
 * slides 媒体附录 appendSlidesMediaReferences → `![白板预览](...)`。
 * 本地 md 不含云端 token——token 由 PNG 文件名主干中的 token 段恢复
 * （既有媒体命名 `NN-<token>`）。去重后保持文档顺序。
 */
const LOCAL_WHITEBOARD_REF_PATTERN = /!\[(?:飞书白板|白板预览)\]\(([^)\s]+)\)/g;

export function extractLocalWhiteboardRefs(markdown: string): string[] {
  const seen = new Set<string>();
  for (const match of markdown.matchAll(LOCAL_WHITEBOARD_REF_PATTERN)) {
    const ref = match[1];
    if (!seen.has(ref)) seen.add(ref);
  }
  return [...seen];
}

export class SyncEngine {
  private larkCliClient: any;
  private localMapStore: any;
  private config: any;
  private layoutReconstructor?: any;
  private contentAdapter?: any;
  private testHooks: SyncEngineTestHooks;
  private sourceWriteLock: SourceWriteLockLike;
  /**
   * P1-S5：slides 截图可选读 scope 的授权态缓存（每引擎实例一次；一次
   * 同步内的多个 slides 文档共享同一次 checkAuthReady 快照）。null=未探测。
   */
  private slidesScreenshotScopeGranted: boolean | null = null;

  constructor(deps: SyncEngineDeps) {
    this.larkCliClient = deps.larkCliClient;
    this.localMapStore = deps.localMapStore;
    this.config = deps.config;
    this.layoutReconstructor = deps.layoutReconstructor;
    this.contentAdapter = deps.contentAdapter;
    this.testHooks = deps.testHooks ?? {};
    this.sourceWriteLock = deps.sourceWriteLock ?? sharedSourceWriteLock;
  }

  /** All Feishu subprocess work is delegated to the injected client. */
  private requireLarkCliClient(): any {
    if (!this.larkCliClient) {
      throw new Error('LarkCliClient 未注入：无法执行飞书读取或资源导出');
    }
    return this.larkCliClient;
  }

  /**
   * Synchronize multiple documents with error handling
   */
  async syncDocuments(
    documents: ChangedDocument[],
    options: SyncOptions
  ): Promise<SyncResult> {
    const startedAt = new Date().toISOString();
    const requestedMode = resolveSyncMode(options);
    // P3: apply goes through commitDocumentContent (staging + atomic rename).
    const mode = requestedMode;
    const manifest = createOperationManifest({
      knowledgeBaseRoot: this.config.knowledgeBaseRoot,
      documents,
      mode,
      watchedRoots: Array.isArray(this.config?.watchedRoots)
        ? this.config.watchedRoots
        : [],
      adoptExistingProfileTargets: options.adoptExistingProfileTargets === true,
    });
    const operationDirectory = resolveOperationDirectory(
      this.config.knowledgeBaseRoot,
      this.config.operationManifestDir,
    );
    // Creating this record is deliberately the first observable side effect
    // of an operation. A failed manifest write blocks apply rather than
    // allowing an untraceable filesystem mutation.
    const manifestPath = writeOperationManifest(manifest, operationDirectory);

    const syncedDocuments: SyncedDocument[] = [];
    const failedDocuments: FailedDocument[] = [];

    if (mode === 'dry-run') {
      for (const planned of manifest.documents) {
        if (planned.action === 'blocked' || planned.action === 'move') {
          failedDocuments.push(plannedFailure(planned));
          continue;
        }
        // S11（设计 §7.3）：dirty/pushing/conflict 文档在 dry-run 中也如实
        // 预告 local_edit_pending blocker，让同步列表在正式提交前可见。
        if (this.getPendingLocalEditState(planned.objToken)) {
          failedDocuments.push(localEditPendingFailure({
            objToken: planned.objToken,
            title: planned.title,
            watchedRootId: planned.watchedRootId ?? null,
          }));
        } else {
          const reason = this.getCloudOperationBlock(planned.objToken);
          if (reason) failedDocuments.push(cloudOperationFailure(planned, reason));
        }
      }

      const completedAt = new Date().toISOString();
      const result: SyncResult = {
        success: failedDocuments.length === 0,
        syncedDocuments,
        failedDocuments,
        startedAt,
        completedAt,
        duration: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
        mode,
        operationId: manifest.operationId,
        manifestPath,
        plannedDocuments: manifest.documents,
      };
      completeOperationManifest(manifest, manifestPath, {
        succeeded: 0,
        failed: failedDocuments.length,
      });
      return result;
    }

    for (let index = 0; index < documents.length; index += 1) {
      const doc = documents[index];
      const planned = manifest.documents[index];
      // A move is evidence for a separate, explicitly confirmed migration;
      // ordinary sync may only create or replace a reviewed body.
      if (planned.action === 'blocked' || planned.action === 'move' || !planned.localMdPath) {
        const failure = plannedFailure(planned);
        failedDocuments.push(failure);
        this.queueFeishuSideFailure(failure);
        continue;
      }

      try {
        // S11（设计 §7.3）：提交全程持有 SourceWriteLock(objToken)，与
        // SourceEditService 的编辑/放弃修改互斥；dirty/pushing/conflict 检查
        // 在锁内执行，消除「检查与提交之间落入新编辑」窗口，绝不覆盖带
        // 未写回修改的本地文件、绝不推进其 synced 基线。
        const outcome: LocalEditSyncOutcome = await this.sourceWriteLock.withLock(
          doc.objToken,
          async (): Promise<LocalEditSyncOutcome> => this.sourceWriteLock.withLock(`target:${process.platform === 'win32' ? path.resolve(planned.localMdPath!).toLowerCase() : path.resolve(planned.localMdPath!)}`, async () => {
            const targetHash = fs.existsSync(planned.localMdPath!) ? crypto.createHash('sha256').update(fs.readFileSync(planned.localMdPath!)).digest('hex') : null;
            if (planned.previousSha256 !== undefined && targetHash !== planned.previousSha256) throw new Error('同步排队期间本地目标发生变化，已保留当前文件，请重新检测');
            if (this.getPendingLocalEditState(doc.objToken)) {
              return { kind: 'blocked', failure: localEditPendingFailure(doc) };
            }
            const cloudBlock = this.getCloudOperationBlock(doc.objToken);
            if (cloudBlock) return { kind: 'blocked', failure: cloudOperationFailure(doc, cloudBlock) };
            // Apply uses exactly the target that was independently reviewed in
            // the manifest; it must not recompute a potentially different path.
            const measured = await withSyncPerformance(doc.objToken, () => this.syncSingleDocument(
              { ...doc, localMdPath: planned.localMdPath },
              options,
              targetHash,
            ));
            return { kind: 'synced', doc: { ...measured.value, performance: measured.performance } };
          }),
        );
        if (outcome.kind === 'blocked') {
          failedDocuments.push(outcome.failure);
          continue;
        }
        syncedDocuments.push(outcome.doc);
      } catch (error) {
        const failure = classifySyncFailure(error);
        const errMsg = failure.message;
        const errStack = error instanceof Error && error.stack ? error.stack : '';
        // 同步失败日志落盘（诊断报告 §4.3）：当前无任何磁盘日志，失败根因
        // 只能静态推测。这里把单文档失败的堆栈追加到
        // ~/.feishu-sync/sync-errors.log，便于事后回溯。
        // 用 try/catch 包住：日志写入失败不能影响同步主流程。
        try {
          const logPath = path.join(resolveDataRoot(), 'sync-errors.log');
          const header = `[${new Date().toISOString()}] ${doc.objToken} (${doc.title})\n`;
          const body = errStack ? `${errMsg}\n${errStack}\n` : `${errMsg}\n`;
          fs.appendFileSync(logPath, `${header}${body}---\n`);
        } catch (logError) {
          console.error('[SyncEngine] failed to append sync-errors.log:', logError);
        }
        const failedDocument: FailedDocument = {
          objToken: doc.objToken,
          title: doc.title,
          error: errMsg,
          retryable: failure.retryable,
          reasonCode: failure.reasonCode,
          suggestedResolution: failure.suggestedResolution,
          repairAction: failure.repairAction,
          watchedRootId: doc.watchedRootId ?? planned.watchedRootId ?? null,
        };
        failedDocuments.push(failedDocument);
        // Custom-folder docs are not tied to a watched root. The feishu_pending
        // queue is filtered by watched_root_id in the UI, so entries with a
        // NULL watched_root_id would be invisible. Keep custom doc failures
        // as normal error-classified failures instead of enqueuing them.
        if (!doc.customFolderId) {
          this.queueFeishuSideFailure(failedDocument);
        }
      }
    }

    const completedAt = new Date().toISOString();
    const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    const result: SyncResult = {
      success: failedDocuments.length === 0,
      syncedDocuments,
      failedDocuments,
      startedAt,
      completedAt,
      duration,
      mode,
      operationId: manifest.operationId,
      manifestPath,
      plannedDocuments: manifest.documents,
    };

    // Logging is not part of the content transaction. Do not turn a
    // successful write into an API error merely because observability is
    // degraded; the operation manifest remains the recovery record.
    try {
      this.localMapStore.logSync(result);
    } catch (error) {
      console.error('[SyncEngine] failed to write sync log:', error);
    }
    completeOperationManifest(manifest, manifestPath, {
      succeeded: syncedDocuments.length,
      failed: failedDocuments.length,
    });

    return result;
  }

  /** Best-effort queue write; a database diagnostic failure must not mask the original sync error. */
  private queueFeishuSideFailure(failure: FailedDocument): void {
    if (!requiresFeishuSideAction(failure)) return;
    if (typeof this.localMapStore?.recordFeishuPending !== 'function') return;
    try {
      this.localMapStore.recordFeishuPending({
        objToken: failure.objToken,
        title: failure.title,
        watchedRootId: failure.watchedRootId ?? null,
        reasonCode: failure.reasonCode ?? 'unknown',
        error: failure.error,
        suggestedResolution: failure.suggestedResolution ?? '请完成飞书侧处理后点击“处理后重新检测”。',
        repairAction: failure.repairAction ?? 'manual_review',
      });
    } catch (error) {
      console.warn('[SyncEngine] failed to record Feishu-side pending item:', error);
    }
  }

  /**
   * Synchronize a single document through the complete pipeline
   */
  private async syncSingleDocument(
    doc: ChangedDocument,
    options: SyncOptions,
    expectedTargetSha?: string | null,
  ): Promise<SyncedDocument> {
    // 1. Fetch document content from Feishu
    //
    //    P1 修复 (feishu-sync-troop-sync-20260701):
    //      sheet 类型走 docs+fetch 会报 lark-cli code 3380002
    //      ("Unsupported document type 'sheet'. Only docx is supported.").
    //      对 sheet 文档，主内容由 exportSheetsAndMap + LayoutReconstructor
    //      合成，无需调用 docs+fetch（fetchDocumentContent 是 docx-only）。
    //      此处构造空 content 的 FetchedDocument，后续 step 5/6 由
    //      sheet 子表的 CSV 经 LayoutReconstructor 重构生成 markdown。
    let fetched: FetchedDocument;

    if (doc.objType === 'bitable') {
      // P0 决策（2026-10，同 sheet 3380002 教训）：bitable 走 docs+fetch 会被
      // 飞书拒绝（code 3380002，Unsupported document type），历史链路把它折叠
      // 为 unknown 后只产出元数据占位。这里与 sheet 同构：跳过 docs+fetch，
      // 主内容由 BitableExporter 直接从 base API 确定性渲染（数据表/字段
      // schema/全部记录/视图/附件/dashboard-workflow-form 元数据），见
      // step 5 之后的导出调用。零 LLM、零 LayoutReconstructor。
      console.info(
        `[SyncEngine] objType=bitable, skipping docs+fetch (base content ` +
        `is synthesized deterministically by BitableExporter)`
      );
      fetched = {
        content: '',
        images: [],
        attachments: [],
        sheets: [],
        url: '',
        obj_token: doc.objToken,
      };
    } else if (doc.objType === 'sheet') {
      console.info(
        `[SyncEngine] objType=sheet, skipping docs+fetch (sheet content ` +
        `is synthesized from sub-sheet CSVs via LayoutReconstructor)`
      );
      fetched = {
        content: '',
        images: [],
        attachments: [],
        sheets: [{ token: doc.objToken, title: doc.title }],
        url: '',
        obj_token: doc.objToken,
      };
    } else if (doc.objType === 'slides') {
      // docs +fetch is docx-only. Slides must use the dedicated XML API; a
      // read/export failure is surfaced as a failed sync instead of being
      // recorded as a successful metadata placeholder.
      fetched = await measureSyncPhase('fetch', () => this.fetchSlidesContent(doc.objToken, doc.title));
    } else {
      try {
        fetched = await measureSyncPhase('fetch', () => this.fetchDocumentContent(doc.objToken, doc.objType));
      } catch (error) {
        // A permission failure is actionable only in Feishu.  Do not create
        // an empty placeholder and falsely report the document as synced;
        // the outer batch classifier moves it into the durable Feishu queue.
        if (error instanceof Error && /(?:40403|131006|无权限|permission|forbidden|access denied)/i.test(error.message)) {
          throw error;
        } else if (
          error instanceof Error &&
          (error.message.includes('3380002') || error.message.includes('Unsupported document type'))
        ) {
          console.warn(
            `[SyncEngine] Unsupported fetch type for ${doc.title}, writing metadata body`,
          );
          fetched = {
            content:
              `# ${doc.title}\n\n` +
              `> 云端类型 \`${doc.objType}\` 无法用 docs+fetch 导出正文，已保留元数据占位。\n`,
            images: [],
            attachments: [],
            sheets: [],
            url: '',
            obj_token: doc.objToken,
          };
        } else {
          throw error; // Re-throw other errors
        }
      }
    }

    // 2–5. Prepare content entirely outside the knowledge base.
    // Media and CSV land only under operation staging / OS temp until the
    // atomic commit swaps them into the final target (Gate 3 all-or-nothing).
    const localMdPath = doc.localMdPath || this.generateLocalPath(doc);
    const operationDirectory = resolveOperationDirectory(
      this.config.knowledgeBaseRoot,
      this.config.operationManifestDir,
    );
    const operationId = `doc-${doc.objToken.slice(0, 12)}-${Date.now()}`;
    const { stagingRoot } = createAtomicCommitWorkspace({
      operationId,
      knowledgeBaseRoot: this.config.knowledgeBaseRoot,
      operationDirectory,
    });
    const relativeMd =
      toPortableRelative(this.config.knowledgeBaseRoot, localMdPath) ||
      path.basename(localMdPath);
    const relativeDir = relativeMd.includes('/')
      ? relativeMd.slice(0, relativeMd.lastIndexOf('/'))
      : '';
    const stagingDocDir = relativeDir
      ? path.join(stagingRoot, ...relativeDir.split('/'))
      : stagingRoot;
    fs.mkdirSync(stagingDocDir, { recursive: true });

    const images = await measureSyncPhase('media', () => this.downloadImages(fetched, stagingDocDir));
    const attachments = await measureSyncPhase('media', () => this.downloadAttachments(fetched, stagingDocDir));

    const localMediaReferences = new Map<string, string>();
    for (const image of images) {
      localMediaReferences.set(image.token, `images/${path.basename(image.path)}`);
    }
    for (const attachment of attachments) {
      localMediaReferences.set(attachment.token, `attachments/${path.basename(attachment.path)}`);
    }
    let expandedContent = this.renderLocalizedMediaReferences(
      rewriteFeishuMediaReferences(fetched.content, localMediaReferences),
    );
    if (fetched.slideMedia && fetched.slideMedia.length > 0) {
      expandedContent = this.appendSlidesMediaReferences(
        expandedContent,
        fetched.slideMedia,
        localMediaReferences,
      );
    }
    // P1-S5 slides 截图采集（设计 §3.2/U36）：默认关闭；开启且可选读 scope
    // 已授权才采集。all-or-none——任一页失败/超页/未授权时该文档零截图
    // 引用，正文与现状逐字节一致（截图行是唯一新增输出面）。
    const slidesScreenshots = doc.objType === 'slides'
      ? await this.stageSlidesScreenshots(doc, fetched, stagingDocDir, localMdPath)
      : [];
    if (slidesScreenshots.length > 0) {
      // 复用既有 images 通道：ir.images / extraFiles / imagesCount / 原子
      // 提交全部自动覆盖——截图是 md 引用的普通图片，不另造通道（U36）。
      for (const shot of slidesScreenshots) images.push(shot.image);
      expandedContent = this.appendSlidesScreenshotReferences(expandedContent, slidesScreenshots);
    }

    const sheets: Array<{
      sheetId: string;
      title: string;
      csvPath: string;
      csvRel: string;
      images: SheetMediaItem[];
    }> = [];
    const docname = path.basename(localMdPath, '.md');
    let workbook: Awaited<ReturnType<typeof stageSourceWorkbook>> | null = null;
    let sheetFallback = false;
    let sheetAcquisitionIssue: string | undefined;
    let fallbackRevision: unknown;
    if (doc.objType === 'sheet') {
      try { workbook = await measureSyncPhase('workbook', () => stageSourceWorkbook(this.requireLarkCliClient(), doc.objToken, stagingDocDir, localMdPath)); }
      catch (error) {
        if (!(error instanceof WorkbookAcquisitionError)) throw error;
        sheetFallback = true;
        const cause = error.cause instanceof Error
          ? error.cause.message.replace(/float_image\s+\S+\s+\([^)]*\)/g, '表格图片')
          : '';
        sheetAcquisitionIssue = `${error.message}${cause ? `：${cause}` : ''}`.slice(0, 500);
        fallbackRevision = (await this.requireLarkCliClient().getWorkbookInfo(doc.objToken))?.data?.revision;
        if (fallbackRevision == null) throw new Error('无法确认 CSV 后备版本，已保留现有本地文件');
      }
    }
    // bitable 确定性导出（P0 决策，见上方 fetched 构造处的 bitable 分支注
    // 释）：staging workspace 已建好，导出器直接复用 stagingDocDir。CSV 落
    // <docname>.csv-data/、base 元数据落 <docname>.base-meta/、附件落
    // attachments/ ——目录约定与 sheet / docx 完全一致。任一硬失败（表清
    // 单/字段/记录读取失败）在此抛出，同步中止不推进 synced 基线。
    let bitableResult: BitableExportResult | null = null;
    if (doc.objType === 'bitable') {
      const exporter = new BitableExporter(this.requireLarkCliClient());
      bitableResult = await exporter.exportBitable({
        baseToken: doc.objToken,
        title: doc.title,
        stagingDocDir,
        docname,
      });
      expandedContent = bitableResult.markdown;
      console.info(
        `[SyncEngine] Exported bitable "${doc.title}": ` +
          `${bitableResult.sections.length} tables, ` +
          `${bitableResult.attachments.length} attachments`
      );
    }
    if (doc.objType === 'sheet') {
      const exportedSheets = await measureSyncPhase('csv', () => this.exportSheetsToStaging(
        doc.objToken,
        stagingDocDir,
        docname,
        undefined,
        sheetFallback ? fallbackRevision : workbook?.revision,
        workbook?.mode === 'read-reconstruction' ? workbook.absolutePath : undefined,
      ));
      sheets.push(...exportedSheets);
      if (sheetFallback || workbook?.revision != null) {
        const finalRevision = (await this.requireLarkCliClient().getWorkbookInfo(doc.objToken, true))?.data?.revision;
        if (finalRevision == null || String(finalRevision) !== String(sheetFallback ? fallbackRevision : workbook?.revision)) throw new Error('读取 CSV 期间表格版本变化，已保留现有本地文件');
      }
    }
    // Sheet float images flow through the same images/extraFiles channel as
    // docx media so commitDocumentContent + atomic-commit cover them.
    // docx 内嵌 <sheet> 标签展开（2026-09-04）：docx 正文中未被处理的
    // <sheet sheet-id="..." token="..."></sheet> 引用此前原样落盘，预览
    // 露裸 XML（实测：战斗系统 md 第 85 行）。这里逐标签导出子表并重构，
    // 标签级替换为「## 子表:」段；任一子表失败 → 抛错不推进基线（对齐
    // 「子表失败 aborts the document」契约）。
    let inlineSheets: Array<{
      sheetId: string;
      title: string;
      csvPath: string;
      csvRel: string;
      images: SheetMediaItem[];
    }> = [];
    if (doc.objType === 'docx') {
      const expanded = await this.expandInlineSheetTags(expandedContent, stagingDocDir, docname);
      expandedContent = expanded.content;
      inlineSheets = expanded.sheets;
    }
    const sheetMediaImages: SheetMediaItem[] = [
      ...sheets.flatMap((sheet) => sheet.images),
      ...inlineSheets.flatMap((sheet) => sheet.images),
    ];

    // 6. Table reconstruction — any sub-sheet failure aborts the document.
    let finalContent = expandedContent;
    if (this.layoutReconstructor && sheets.length > 0) {
      const reconstructedSheets: string[] = [];
      for (const sheet of sheets) {
        const reconstructedMarkdown = await measureSyncPhase('layout', () => this.layoutReconstructor!.reconstructToMarkdown(sheet.csvPath));
        let section =
          `## 子表: ${sheet.title}\n\n[CSV 原始数据](${sheet.csvRel})\n\n${reconstructedMarkdown}`;
        // 浮动图片大图展示区：CSV 单元格内的引用之外，追加不依赖 CSV
        // 渲染的完整尺寸展示区块，保证表格图片在阅读器中可见。
        if (sheet.images.length > 0) {
          section += `\n\n${renderSheetMediaAppendix(sheet.title, sheet.images)}`;
        }
        reconstructedSheets.push(section);
        console.info(`[SyncEngine] Reconstructed sheet "${sheet.title}" from ${sheet.csvPath}`);
      }
      if (reconstructedSheets.length > 0) {
        finalContent = reconstructedSheets.join('\n\n---\n\n');
      }
    }

    // 7. LLM adaptation (M3 + v0.2.0 P3 B6 修正)
    //
    //    v0.2.0 P3 flow chain (03 §4.4.1):
    //      LayoutReconstructor (必跑, 前置, step 6 above)
    //        -> ContentAdapter (optional, enableLLM=true)
    //           primary channel: ClaudeCliChannel (default) or DirectChannel
    //           on failure: fallback channel (single layer)
    //        -> B6 deterministic fallback: reconstructedMarkdown
    //
    //    B6 修正 (content-adapter.ts:95-104 旧缺陷): LLM 失败时不再
    //    返回 rawContent，而是保留 step 6 的 finalContent
    //    （LayoutReconstructor 的 reconstructedMarkdown）。这是确定性
    //    算法的产物，比 rawContent 可读性更好且稳定可重现。
    //
    //    finalContent 在 LLM 调用前已经持有 reconstructedMarkdown
    //    （sheet 重构结果拼接），LLM 失败时直接保留即可。
    // P3 fix: original condition `doc.localMdPath` skipped LLM for added
    // documents (detect-all does not populate localMdPath for added nodes).
    // Use the locally-resolved `localMdPath` (step 2) so the LLM stage runs
    // for added documents as well. For modified documents both values are
    // equal. Reading the local old content for an added doc returns '' from
    // readLocalMarkdown (file does not exist yet), which is the correct
    // "no prior version" signal for the adapter.
    //    bitable 跳过 LLM（P0 决策）：数据表格 LLM 重排有丢数据风险，
    //    bitable 的 markdown 是 API 数据的确定性投影，必须逐字节可重现。
    if (this.contentAdapter && options.enableLLM && localMdPath && doc.objType !== 'bitable') {
      try {
        const localOldContent = await this.readLocalMarkdown(localMdPath);
        // P3 新接口: ContentAdapter.adaptContent(rawContent, localOld,
        // { channel?, adapt: { temperature, enableStreaming, onProgress,
        //                       timeoutMs } }). ContentAdapter 内部根据
        // registry 的 primaryChannel 选择通道并自动 fallback。
        const adapted = await measureSyncPhase<AdaptOutput>('llm', () => this.contentAdapter!.adaptContent(
          finalContent,
          localOldContent,
          {
            adapt: {
              temperature: this.config.llm.temperature ?? 0.2,
              enableStreaming: false,
              // Surface the LLM timeout as a config knob (LlmConfig.timeoutMs,
              // default 600000ms = 10 min). Channels still clamp this value
              // via their own resolveOptions when the caller omits it.
              timeoutMs: this.config.llm.timeoutMs ?? 600_000,
            },
          }
        ));
        if (
          (adapted.finishReason === 'stop' || adapted.finishReason === 'length') &&
          adapted.adaptedMarkdown.trim().length > 0
        ) {
          finalContent = adapted.adaptedMarkdown;
          console.info(
            `[SyncEngine] LLM adaptation succeeded via ${adapted.channelName} ` +
              `(${adapted.durationMs}ms, ${adapted.tokensUsed ?? 0} tokens) for ${doc.title}`
          );
        } else {
          // B6 deterministic fallback: keep finalContent = reconstructedMarkdown.
          console.warn(
            `[SyncEngine] LLM adaptation failed for ${doc.title} ` +
              `(finishReason=${adapted.finishReason ?? 'unknown'}, ` +
              `error=${adapted.errorMessage ?? '<none>'}); ` +
              `using LayoutReconstructor deterministic fallback.`
          );
        }
      } catch (error) {
        // Defensive: ContentAdapter contract says it never throws on
        // channel errors, but if it does (e.g. registry misconfig),
        // keep finalContent as the reconstructed fallback.
        console.warn(
          `[SyncEngine] LLM adaptation threw for ${doc.title}, ` +
            `using LayoutReconstructor deterministic fallback:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    const commitStarted = performance.now();
    if (expectedTargetSha !== undefined) {
      const currentHash = fs.existsSync(localMdPath) ? crypto.createHash('sha256').update(fs.readFileSync(localMdPath)).digest('hex') : null;
      if (currentHash !== expectedTargetSha) throw new Error('同步读取期间本地文件发生变化，已保留当前文件，请重新检测');
    }
    // 8. Atomic content commit: only this step mutates knowledge-base files.
    const headerMeta = this.resolveHeaderMeta(doc, fetched);
    // P1-S3（设计 P1 §2.2）：引用边抽取——纯函数、零 IO，在 DB 事务外
    // 计算（避免拉长 SQLite 事务，§6 事务变长风险）；插入在下方原子路径
    // 的 applyDbWrites 事务内与正文基线同生共死。legacy 写入路径
    // （FEISHU_SYNC_LEGACY_WRITE）不写边，保持零边缺省。
    let referenceExtraction: ExtractDocumentReferencesResult = { edges: [], truncated: false };
    // P2-S4（设计 §5.1）：评论采集——仅 docs+fetch 成功时解析与入库；
    // sheet/bitable/slides 未采集，reference_map 缺失表示零评论（RP-3），
    // 与「从未采集」（无 meta 行）区分。解析纯函数、零 IO，事务外计算
    // （与引用边同款，避免拉长 SQLite 事务）。
    let commentExtraction: RefmapCommentsExtraction | null = null;
    if (fetched.referenceMap !== undefined) {
      commentExtraction = extractRefmapComments(fetched.referenceMap);
    }
    if (process.env.FEISHU_SYNC_LEGACY_WRITE === '1' && !workbook && !sheetFallback) {
      await this.writeLocalMarkdown(localMdPath, finalContent, headerMeta);
      await this.updateLocalMap(doc, localMdPath);
    } else {
      const ir: DocumentIR = {
        objToken: doc.objToken,
        wikiNodeToken: headerMeta.wikiNodeToken,
        spaceId: headerMeta.spaceId,
        objType: doc.objType,
        title: doc.title,
        originalLink: headerMeta.originalLink,
        observedObjEditTime: doc.observedObjEditTime ?? null,
        bodyMarkdown: finalContent,
        workbook: workbook ? { relativePath: workbook.relativePath, metadataRelativePath: workbook.metadataRelativePath, mode: workbook.mode } : undefined,
        sheetFallback,
        previousWorkbook: sheetFallback && managedWorkbookCompanions(localMdPath).length ? `${docname}.xlsx` : undefined,
        images: [
          ...images.map((img) => ({
            relativePath: `images/${path.basename(img.path)}`,
            token: img.token,
          })),
          // Sheet float images join ir.images so renderDocumentMarkdown's
          // requiredRelativePaths validation and the atomic commit cover them.
          ...sheetMediaImages.map((img) => ({
            relativePath: img.localRelPath,
            token: img.token,
          })),
        ],
        attachments: [
          ...attachments.map((att) => ({
            relativePath: `attachments/${path.basename(att.path)}`,
            name: att.name,
            token: att.token,
          })),
          // bitable 附件由 BitableExporter 落入同一个 staging attachments/
          // 目录（同名约定），与 docx 附件共用 ir.attachments 校验通道；
          // 下载失败的附件不会出现在这里（软降级仅 md 标注）。
          ...(bitableResult?.attachments ?? []).map((att) => ({
            relativePath: att.relativePath,
            name: att.name,
            token: att.token,
          })),
        ],
        sheets: [...sheets, ...inlineSheets].map((sheet) => ({
          sheetId: sheet.sheetId,
          title: sheet.title,
          csvRelativePath: sheet.csvRel,
          csvContent: fs.readFileSync(sheet.csvPath, 'utf-8'),
        })),
      };
      const extraFiles: Array<{ relativePath: string; absoluteSource: string }> = [];
      if (workbook) {
        extraFiles.push({
          relativePath: relativeDir ? `${relativeDir}/${workbook.relativePath}` : workbook.relativePath,
          absoluteSource: workbook.absolutePath,
        });
        extraFiles.push({
          relativePath: relativeDir ? `${relativeDir}/${workbook.metadataRelativePath}` : workbook.metadataRelativePath,
          absoluteSource: workbook.metadataPath,
        });
      }
      for (const img of images) {
        const name = path.basename(img.path);
        extraFiles.push({
          relativePath: relativeDir ? `${relativeDir}/images/${name}` : `images/${name}`,
          absoluteSource: img.path,
        });
        // P0-S6：白板旁路文件（svg/raw）与 PNG 同批原子提交；md 不引用，
        // 不进 requiredRelativePaths（旁路是可选资源，缺失不得阻断提交）。
        if (img.whiteboardBypass) {
          const bypassName = path.basename(img.whiteboardBypass.path);
          extraFiles.push({
            relativePath: relativeDir ? `${relativeDir}/images/${bypassName}` : `images/${bypassName}`,
            absoluteSource: img.whiteboardBypass.path,
          });
        }
      }
      for (const img of sheetMediaImages) {
        const name = path.basename(img.localPath);
        extraFiles.push({
          relativePath: relativeDir ? `${relativeDir}/images/${name}` : `images/${name}`,
          absoluteSource: img.localPath,
        });
      }
      for (const att of attachments) {
        const name = path.basename(att.path);
        extraFiles.push({
          relativePath: relativeDir
            ? `${relativeDir}/attachments/${name}`
            : `attachments/${name}`,
          absoluteSource: att.path,
        });
      }
      // bitable 附属文件：每表 CSV（<docname>.csv-data/）与 base 元数据
      // JSON（<docname>.base-meta/），均从 staging 经 extraFiles 原子提交
      // （与 sheet CSV 同款相对链接约定，routes/content.ts 的 csv-data 读
      // 取逻辑对 bitable 同样生效）。
      for (const file of bitableResult?.commitFiles ?? []) {
        extraFiles.push({
          relativePath: relativeDir ? `${relativeDir}/${file.relativePath}` : file.relativePath,
          absoluteSource: file.absolutePath,
        });
      }
      for (const att of bitableResult?.attachments ?? []) {
        extraFiles.push({
          relativePath: relativeDir ? `${relativeDir}/${att.relativePath}` : att.relativePath,
          absoluteSource: att.absolutePath,
        });
      }

      const commit = commitDocumentContent({
        operationId,
        knowledgeBaseRoot: this.config.knowledgeBaseRoot,
        operationDirectory,
        localMdPath,
        ir,
        extraFiles,
        failBeforeCommit: this.testHooks.failBeforeCommit === true,
        // failAfterFileCommit is handled here so DB linkage can roll files back.
      });
      if (!commit.ok) {
        throw new Error(commit.error || '原子内容提交失败');
      }

      // P1-S3：sheet/bitable/slides 不走 docs+fetch（referenceMap undefined）
      // → 仅正文链接解析（§2.2）。
      referenceExtraction = extractDocumentReferences({
        markdown: finalContent,
        referenceMap: fetched.referenceMap,
        selfTokens: [doc.objToken, doc.wikiNodeToken ?? null, headerMeta.wikiNodeToken],
        excludeTokens: [
          // 媒体计划 token 集（图片/白板/附件，media-reference 已处理者不入图，§2.1）
          ...images.map((img) => img.token),
          ...sheetMediaImages.map((img) => img.token),
          ...attachments.map((att) => att.token),
          ...(bitableResult?.attachments ?? []).map((att) => att.token),
        ],
      });

      // 9. DB baseline + sheet_sheets only after files are committed.
      //    All DB writes run in one SQLite transaction so a mid-DB failure
      //    cannot advance synced_obj_edit_time while leaving sheet_sheets
      //    half-written (or vice versa). Any failure also restores prior files.
      try {
        if (this.testHooks.failAfterFileCommit) {
          throw new Error('注入失败：文件提交后数据库事务失败');
        }

        const applyDbWrites = (): void => {
          const nowIso = new Date().toISOString();
          // Sheet rows first; synced baseline is the final commit marker.
          for (const sheet of sheets) {
            const finalCsv = path.join(
              path.dirname(localMdPath),
              ...sheet.csvRel.split('/'),
            );
            if (typeof this.localMapStore.upsertSheetSheet === 'function') {
              this.localMapStore.upsertSheetSheet({
                sheetObjToken: doc.objToken,
                sheetId: sheet.sheetId,
                sheetTitle: sheet.title,
                localCsvPath: finalCsv,
                lastSyncedModifyTime: nowIso,
                status: 'synced',
              });
            }
          }
          // Synchronous DB writes only — must stay inside the SQLite transaction.
          this.localMapStore.upsertDocument({
            objToken: doc.objToken,
            wikiNodeToken: doc.wikiNodeToken ?? null,
            objType: doc.objType,
            title: doc.title,
            localMdPath,
            lastSyncedModifyTime: doc.cloudModifiedTime,
            lastSyncedAt: nowIso,
            status: 'synced',
            localRelPath:
              toPortableRelative(this.config.knowledgeBaseRoot, localMdPath) ??
              null,
            watchedRootId: doc.watchedRootId ?? null,
          });
          if (typeof this.localMapStore.markDocumentSynced === 'function') {
            this.localMapStore.markDocumentSynced({
              objToken: doc.objToken,
              syncedObjEditTime: doc.observedObjEditTime ?? null,
              localMdPath,
              lastSyncedModifyTime: doc.cloudModifiedTime,
              lastSyncedAt: nowIso,
            });
          }
          // P1-S3：与正文同一 DB 事务替换引用边（先删该源旧边再插新边）。
          // 方法缺失（旧测试替身/旧版本库）时静默跳过；事务中止（含
          // failAfterMarkDocumentSynced 注入）时边随基线一起回滚。
          if (typeof this.localMapStore.replaceSourceReferences === 'function') {
            this.localMapStore.replaceSourceReferences(doc.objToken, referenceExtraction.edges);
          }
          // P2-S4：与引用边同事务替换评论（先删后插 + meta；truncated 来自
          // comments.tips 存在性，如实标注）。commentExtraction === null 表示
          // 本次 fetch 无 reference_map（非 docx），不写任何行。方法缺失
          // （旧测试替身）时静默跳过；事务中止时随基线一起回滚。
          if (commentExtraction !== null && typeof this.localMapStore.replaceSourceComments === 'function') {
            this.localMapStore.replaceSourceComments(
              doc.objToken,
              commentExtraction.comments,
              { truncated: commentExtraction.truncated },
            );
          }
          if (this.testHooks.failAfterMarkDocumentSynced) {
            throw new Error(
              '注入失败：markDocumentSynced 之后 sheet/DB 事务中止',
            );
          }
        };

        if (typeof this.localMapStore.withTransaction === 'function') {
          this.localMapStore.withTransaction(applyDbWrites);
        } else {
          applyDbWrites();
        }
      } catch (dbError) {
        rollbackAtomicPlan(commit.plan);
        throw dbError instanceof Error
          ? dbError
          : new Error(String(dbError));
      }
    }

    // S11（设计 §7.3）：写回推送（S12）后的回拉同步成功 → 删除该 pushed
    // 行与备份目录。清行失败不吞掉同步成功（行残留只会继续显示已推送
    // 状态，下次成功同步会再试清理）。
    this.finalizePushedSourceEdit(doc.objToken);
    recordSyncDuration('commit', commitStarted);

    // P1-S3（§2.1）：单文档引用边超 500 上限 → 同步警告 references_truncated
    // （边照常入库，按 occurrences 降序截断；不阻断提交）。
    if (referenceExtraction.truncated) {
      console.warn(
        `[SyncEngine] references_truncated: ${doc.title} 引用边超过上限，已按 occurrences 截断为 ${referenceExtraction.edges.length} 条`,
      );
    }

    return {
      objToken: doc.objToken,
      title: doc.title,
      localMdPath,
      cloudModifiedTime: doc.cloudModifiedTime,
      size: finalContent.length,
      imagesCount: images.length + sheetMediaImages.length,
      attachmentsCount: attachments.length + (bitableResult?.attachments.length ?? 0),
      sheetsCount: sheets.length,
      sheetAcquisition: doc.objType === 'sheet' ? (workbook?.mode ?? 'csv-fallback') : undefined,
      sheetAcquisitionIssue,
      referencesTruncated: referenceExtraction.truncated ? true : undefined,
    };
  }

  /**
   * S11：source_edits 行在 dirty/pushing/conflict 状态时阻断同步覆盖
   * （设计 §7.3/§9.1 不变量 1a）。旧测试替身没有该方法 → 不阻断，
   * 保持既有行为。
   */
  private getPendingLocalEditState(objToken: string): { state: string } | null {
    if (typeof this.localMapStore?.getSourceEdit !== 'function') return null;
    // 状态读取失败时无法证明本地文件安全，必须阻断同步及补齐。
    const row = this.localMapStore.getSourceEdit(objToken);
    return row && row.state !== 'pushed' ? row : null;
  }

  private getCloudOperationBlock(objToken: string): 'cloud_operation_pending' | 'source_moved_out' | null {
    if (this.localMapStore?.getRunningRevertPushLog?.(objToken) != null || this.localMapStore?.getActiveCloudMove?.(objToken) != null) return 'cloud_operation_pending';
    return this.localMapStore?.getLatestCloudMove?.(objToken)?.state === 'moved' ? 'source_moved_out' : null;
  }

  /** S11：pushed 行在回拉同步成功后清除，同时清理编辑备份目录。 */
  private finalizePushedSourceEdit(objToken: string): void {
    try {
      if (typeof this.localMapStore?.getSourceEdit !== 'function') return;
      const row = this.localMapStore.getSourceEdit(objToken);
      if (!row || row.state !== 'pushed') return;
      if (typeof this.localMapStore.clearSourceEdit === 'function') {
        this.localMapStore.clearSourceEdit(objToken);
      }
      fs.rmSync(
        path.join(resolveDataRoot(), 'source-edits', objToken),
        { recursive: true, force: true },
      );
    } catch (error) {
      console.warn(`[SyncEngine] 清理 pushed 编辑行失败（${objToken}，不影响本次同步）:`, error);
    }
  }

  /**
   * Fetch document content using lark-cli docs +fetch
   */
  private async fetchDocumentContent(
    objToken: string,
    objType: string
  ): Promise<FetchedDocument> {
    // Suppress unused parameter warning
    void objType;
    const result = await this.requireLarkCliClient().fetchDocumentMarkdown(objToken);
    const document = result.data.document ?? {};
    const content = typeof document.content === 'string' ? document.content : '';
    const mediaReferences = extractFeishuMediaReferences(content);

    return {
      content,
      // docs +fetch v2 returns content/document_id/revision_id, not the
      // legacy images/attachments arrays. Derive the media plan from the
      // authoritative Markdown/XML body so every downloaded resource can be
      // rewritten to its committed local path.
      images: mediaReferences
        .filter((reference) => reference.kind === 'image' || reference.kind === 'whiteboard')
        .map((reference) => ({
          token: reference.token,
          url: reference.sourceUrl ?? undefined,
          name: reference.filename ?? undefined,
          kind: reference.kind === 'whiteboard' ? 'whiteboard' : 'image',
        })),
      attachments: mediaReferences
        .filter((reference) => reference.kind === 'attachment')
        .map((reference) => ({
          token: reference.token,
          name: reference.filename || reference.token,
        })),
      sheets: Array.isArray(document.sheets) ? document.sheets : [],
      url: typeof document.url === 'string' ? document.url : '',
      obj_token: objToken,
      // P1-S3（设计 §2.2/U32）：reference_map 与正文同响应返回，零成本携带；
      // 键整体缺失（RP-3）时用空对象，标记本次成功采集了零评论。
      // docs +fetch 省略该字段表示本次无评论；与未调用 fetch 的其他类型区分。
      referenceMap: document.reference_map ?? {},
    };
  }

  /** Fetch Slides XML and project it to Markdown without a metadata fallback. */
  private async fetchSlidesContent(
    objToken: string,
    title: string,
  ): Promise<FetchedDocument> {
    const result = await this.requireLarkCliClient().fetchSlidesXml(objToken);
    const xml = result?.data?.xml_presentation?.content;
    if (typeof xml !== 'string' || xml.trim().length === 0) {
      throw new Error('Slides API 未返回 presentation XML，拒绝写入占位正文');
    }

    const adapted = adaptSlidesXmlToMarkdown(xml, title);
    const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
    const slideMedia = adapted.mediaReferences.filter((reference) => {
      if (tokenPattern.test(reference.token)) return true;
      console.warn(
        `[SyncEngine] Ignoring non-token Slides ${reference.kind} reference on slide ${reference.slideNumber}`,
      );
      return false;
    });

    return {
      content: adapted.markdown,
      slideCount: adapted.slideCount,
      images: [
        ...adapted.imageTokens
          .filter((token) => tokenPattern.test(token))
          .map((token) => ({ token, kind: 'image' as const })),
        ...adapted.whiteboardTokens
          .filter((token) => tokenPattern.test(token))
          .map((token) => ({ token, kind: 'whiteboard' as const })),
      ],
      attachments: [],
      sheets: [],
      slideMedia,
      url: '',
      obj_token: objToken,
    };
  }

  /**
   * Download image/whiteboard resources into staging. Feishu currently
   * returns HTTP 403 from media-download for some normal image tokens while
   * media-preview succeeds; whiteboards are the inverse special case and
   * must use media-download --type whiteboard.
   */
  private async downloadImages(
    doc: FetchedDocument,
    saveDir: string
  ): Promise<Image[]> {
    const images: Image[] = [];
    const imagesDir = path.join(saveDir, 'images');

    // Create images directory if it doesn't exist
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    for (let i = 0; i < doc.images.length; i++) {
      const img = doc.images[i];
      // Deliberately omit an extension. lark-cli derives the correct suffix
      // from Content-Type and returns saved_path; hard-coding .png previously
      // mislabeled JPEG whiteboards and made absolute --output invalid.
      const outputStem = path.join(
        imagesDir,
        `${String(i + 1).padStart(2, '0')}-${img.token}`,
      );

      try {
        const filepath = await this.execMediaDownload(
          outputStem,
          img.token,
          img.kind === 'whiteboard' ? 'whiteboard' : 'media',
        );
        this.assertDownloadedMedia(filepath, img.token);
        // P0-S6：白板旁路导出（svg 主 + raw 降级）——只在 PNG 预览已就绪
        // 之后追加；任何失败只告警，绝不上抛（缺 PNG 阻断、缺旁路降级）。
        const whiteboardBypass = img.kind === 'whiteboard'
          ? await this.exportWhiteboardBypassFile(filepath, img.token)
          : undefined;
        images.push({ token: img.token, path: filepath, kind: img.kind, whiteboardBypass });
      } catch (downloadError) {
        if (img.kind === 'whiteboard') {
          throw downloadError instanceof Error
            ? downloadError
            : new Error(String(downloadError));
        }
        try {
          const filepath = await this.execMediaPreview(outputStem, img.token);
          this.assertDownloadedMedia(filepath, img.token);
          images.push({ token: img.token, path: filepath, kind: img.kind });
        } catch (previewError) {
          // A direct Feishu URL is optional metadata, not our primary
          // transport. It is retained as the last fallback for deployments
          // where both CLI shortcuts reject an otherwise readable resource.
          if (img.url) {
            const filepath = await this.downloadUrlToFile(outputStem, img.url);
            this.assertDownloadedMedia(filepath, img.token);
            images.push({ token: img.token, path: filepath, kind: img.kind });
          } else {
            throw previewError instanceof Error
              ? previewError
              : new Error(String(previewError));
          }
        }
      }
    }

    return images;
  }

  // -------------------------------------------------------------------------
  // P0-S6 白板旁路导出（设计 §5.1–§5.3 + §10 裁定 1：svg 主 + raw 降级）
  // ---------------------------------------------------------------------------

  private resolveWhiteboardExportOptions(): WhiteboardBypassOptions {
    return resolveWhiteboardExportOptionsFromConfig(this.config);
  }

  /**
   * 白板旁路导出（永不抛错）：svg 主产物 → 失败/超时/校验不过降级 raw →
   * 双失败仅告警（whiteboard_svg_unavailable），正文照常走既有 PNG 通道。
   *
   * 命名（设计 §5.2）：与 PNG 同主干——<stem>.wb.svg / <stem>.wb.raw.json；
   * 构建侧（S7）按命名约定寻址，无映射表。md 正文与 feishu_sync 头零
   * 改动；旁路文件经 downloadImages 调用方加入 atomic-commit extraFiles。
   *
   * 校验链（设计 §5.3）：非空、≤ 8 MiB；svg 额外要求开头 2 KiB 内含
   * "<svg"（防错误页/空壳被当作产物入库）。校验不过删 staging 残留。
   */
  private async exportWhiteboardBypassFile(
    pngPath: string,
    whiteboardToken: string,
  ): Promise<WhiteboardBypassFile | undefined> {
    const options = this.resolveWhiteboardExportOptions();
    if (!options.enabled) return undefined;
    const client = this.requireLarkCliClient();
    // P0-S2 新增方法：旧测试替身没有 → 跳过而非误报降级（与 slides
    // 截图链的容错先例一致）。
    if (typeof client.exportWhiteboard !== 'function') return undefined;
    return exportWhiteboardBypassFile(client, pngPath, whiteboardToken, options);
  }

  // -------------------------------------------------------------------------
  // P0-S8 存量补齐（设计 §5.8）：对已同步文档补导白板旁路文件。
  // 硬约束：只新增 .wb.svg/.wb.raw.json——md 字节与 DB 基线字段（含
  // synced_obj_edit_time / synced 状态）前后完全不变；脏文档跳过。
  // -------------------------------------------------------------------------

  /** 从 PNG 主干恢复白板 token；无 `NN-<token>` 形态返回 null。 */
  private static whiteboardTokenFromStem(stem: string): string | null {
    const match = stem.match(/^\d+-(.+)$/);
    const token = match?.[1] ?? '';
    return token.length > 0 ? token : null;
  }

  /** §5.8 跳过项：objToken 定位到文档，reason 见方法注释。 */
  private pushBackfillSkip(
    skipped: WhiteboardBackfillSkipEntry[],
    objToken: string,
    reason: string,
  ): void {
    skipped.push({ objToken, reason });
  }

  /** documents 行的本地 md 绝对路径（兼容旧相对 localMdPath 行）。 */
  private resolveBackfillMdPath(row: DocumentRecord, root: string): string | null {
    if (row.localMdPath && path.isAbsolute(row.localMdPath)) return row.localMdPath;
    if (row.localRelPath) {
      return path.join(root, ...row.localRelPath.replace(/\\/g, '/').split('/'));
    }
    if (row.localMdPath) return path.resolve(root, row.localMdPath);
    return null;
  }

  /**
   * P0-S8 存量补齐（设计 §5.8）：对 synced 文档解析本地 md 白板引用，
   * 导出缺失的旁路文件（svg 主 + raw 降级，同 S6 导出链）。
   *
   * 与自然重同步的差别：稳定不再修改的架构图文档永远不会自然重同步，
   * 其白板内精确文字只能靠本命令一次性补齐（§5.8 为什么不等自然重同步）。
   *
   * 不变量（硬验收）：
   * - 只新增 .wb.svg/.wb.raw.json——不重写 md、不重写 feishu_sync 头；
   * - 不写任何 SQLite 字段（synced_obj_edit_time / sync_state / status /
   *   content_hash 的推导源 md 字节均不变）；
   * - 导出物先进 staging（镜像路径只用于命名派生，PNG 本体不被读取），
   *   校验后经同一 atomic-commit 入位，失败整体回滚不留残留。
   *
   * 逐文档串行；跳过项进 skipped（reason 值域）：
   * - not_found / not_synced：仅显式 docTokens 模式报告；
   * - local_edit_pending：source_edits 存在非 pushed 行（S11 同款判定）；
   * - local_md_missing：行无本地路径或文件不存在；
   * - token_unresolvable:<stem>：主干无 `NN-<token>` 段（§5.8 解析不出
   *   token 的引用跳过并计入报告）；
   * - already_present:<stem>：同主干旁路已存在（svg 或 raw 任一）；
   * - png_missing:<stem>：引用的 PNG 预览缺失（KB 不完整，旁路无从锚定）；
   * - ref_outside_root:<ref>：引用路径逃逸知识库根（防御，生产者不产）；
   * - export_failed:<stem>：svg+raw 双失败（降级链内已告警）。
   *
   * 前置（路由层已拦截，此处防御性直调同样成立）：
   * sync.whiteboardExport.enabled=false → 抛错拒绝；构建活跃由路由 409
   * （引擎不依赖 kb 构建面，保持模块边界）。
   */
  async backfillWhiteboardBypass(
    options: { docTokens?: string[] } = {},
  ): Promise<WhiteboardBackfillResult> {
    const exportOptions = this.resolveWhiteboardExportOptions();
    if (!exportOptions.enabled) {
      throw new Error(
        'whiteboard_export_disabled: sync.whiteboardExport.enabled=false，旁路导出已关闭，无需补齐',
      );
    }
    const client = this.requireLarkCliClient();
    if (typeof client.exportWhiteboard !== 'function') {
      throw new Error(
        'lark_cli_export_whiteboard_unavailable: lark-cli 客户端不支持 whiteboard +export，无法补齐旁路文件',
      );
    }

    const root = path.resolve(this.config.knowledgeBaseRoot);
    const skipped: WhiteboardBackfillSkipEntry[] = [];
    const selective = Array.isArray(options.docTokens) && options.docTokens.length > 0;

    // 候选行：显式 docTokens → 逐个解析（缺失/非 synced 计报告，重复
    // token 去重防同一文档两次扫描）；缺省 → 全量 synced 行（非 synced
    // 行静默跳过，非本命令可修复面）。
    let rows: DocumentRecord[];
    if (selective) {
      rows = [];
      const seenTokens = new Set<string>();
      for (const token of options.docTokens!) {
        if (seenTokens.has(token)) continue;
        seenTokens.add(token);
        const row = typeof this.localMapStore?.getDocumentByObjToken === 'function'
          ? this.localMapStore.getDocumentByObjToken(token)
          : null;
        if (!row) {
          this.pushBackfillSkip(skipped, token, 'not_found');
          continue;
        }
        rows.push(row);
      }
    } else {
      rows = typeof this.localMapStore?.getAllDocuments === 'function'
        ? this.localMapStore.getAllDocuments()
        : [];
    }

    // 与 getSyncStats 同款成功判定：三字段任一为真即视为 synced 行。
    const isSyncedRow = (row: DocumentRecord): boolean =>
      row.status === 'synced' || row.syncState === 'synced' || row.syncedObjEditTime != null;

    // staging 工作区：导出物先落 staging 镜像路径（镜像只用于命名派生），
    // 全部文档处理完后一次 atomic-commit 入位（校验已由导出链完成）。
    const operationDirectory = resolveOperationDirectory(
      root,
      this.config.operationManifestDir,
    );
    const operationId = `wb-backfill-${Date.now()}`;
    const { stagingRoot, rollbackRoot } = createAtomicCommitWorkspace({
      operationId,
      knowledgeBaseRoot: root,
      operationDirectory,
    });
    const plan = emptyCommitPlan({
      operationId,
      knowledgeBaseRoot: root,
      stagingRoot,
      rollbackRoot,
    });
    // 同一相对路径只入 plan 一次：共享 images 目录（mirror-leaf 布局）下
    // 不同文档引用同一白板时不重复导出/重复计数。
    const stagedRels = new Set<string>();
    const checkedDocs: Array<{ objToken: string; mdPath: string; body: Buffer }> = [];
    const checkedTargets: Array<{ svg: string; raw: string; pngRel: string }> = [];

    let scanned = 0;
    for (const row of rows) {
      if (!isSyncedRow(row)) {
        if (selective) this.pushBackfillSkip(skipped, row.objToken, 'not_synced');
        continue;
      }
      scanned += 1;

      // S11 同款脏判定：source_edits 非 pushed 行 → 跳过（§5.8 守卫）。
      if (this.getPendingLocalEditState(row.objToken)) {
        this.pushBackfillSkip(skipped, row.objToken, 'local_edit_pending');
        continue;
      }
      const cloudBlock = this.getCloudOperationBlock(row.objToken);
      if (cloudBlock) {
        this.pushBackfillSkip(skipped, row.objToken, cloudBlock);
        continue;
      }

      let mdPath = this.resolveBackfillMdPath(row, root);
      const mdRel = mdPath ? toPortableRelative(root, mdPath) : null;
      try { if (mdRel) resolveInside(root, mdRel, 'read'); else mdPath = null; } catch { mdPath = null; }
      if (
        !mdPath
        || !fs.existsSync(mdPath)
        || !fs.statSync(mdPath).isFile()
      ) {
        this.pushBackfillSkip(skipped, row.objToken, 'local_md_missing');
        continue;
      }
      const body = fs.readFileSync(mdPath);
      const refs = extractLocalWhiteboardRefs(body.toString('utf-8'));
      if (refs.length === 0) continue;
      checkedDocs.push({ objToken: row.objToken, mdPath, body });

      const docDir = path.dirname(mdPath);
      for (const ref of refs) {
        const pngAbs = path.resolve(docDir, ...ref.split('/'));
        const relToRoot = path.relative(root, pngAbs);
        if (
          relToRoot === ''
          || relToRoot.startsWith(`..${path.sep}`)
          || relToRoot === '..'
          || path.isAbsolute(relToRoot)
        ) {
          this.pushBackfillSkip(skipped, row.objToken, `ref_outside_root:${ref}`);
          continue;
        }
        const stem = path.basename(pngAbs).replace(/\.[^./\\]+$/, '');
        const whiteboardToken = SyncEngine.whiteboardTokenFromStem(stem);
        if (!whiteboardToken) {
          this.pushBackfillSkip(skipped, row.objToken, `token_unresolvable:${stem}`);
          continue;
        }
        const svgExisting = path.join(path.dirname(pngAbs), `${stem}.wb.svg`);
        const rawExisting = path.join(path.dirname(pngAbs), `${stem}.wb.raw.json`);
        if (fs.existsSync(svgExisting) || fs.existsSync(rawExisting)) {
          this.pushBackfillSkip(skipped, row.objToken, `already_present:${stem}`);
          continue;
        }
        if (!fs.existsSync(pngAbs)) {
          this.pushBackfillSkip(skipped, row.objToken, `png_missing:${stem}`);
          continue;
        }
        try {
          // realpath 校验图片及其父目录，防符号链接把旁路写入根目录外。
          resolveInside(root, relToRoot.split(path.sep).join('/'), 'read');
          const parentRel = toPortableRelative(root, path.dirname(pngAbs));
          resolveInside(root, parentRel || '.', 'read');
        } catch {
          this.pushBackfillSkip(skipped, row.objToken, `ref_outside_root:${ref}`);
          continue;
        }

        // 镜像路径 = stagingRoot + 文档内相对布局；只用于命名派生与
        // lark-cli 子进程 cwd，PNG 本体从不被复制或读取。
        const mirrorDir = path.join(
          stagingRoot,
          ...(toPortableRelative(root, path.dirname(pngAbs)) ?? '')
            .split('/')
            .filter(Boolean),
        );
        fs.mkdirSync(mirrorDir, { recursive: true });
        const bypass = await exportWhiteboardBypassFile(
          client,
          path.join(mirrorDir, path.basename(pngAbs)),
          whiteboardToken,
          exportOptions,
        );
        if (!bypass) {
          this.pushBackfillSkip(skipped, row.objToken, `export_failed:${stem}`);
          continue;
        }
        if (fs.existsSync(svgExisting) || fs.existsSync(rawExisting)) {
          this.pushBackfillSkip(skipped, row.objToken, `already_present:${stem}`);
          continue;
        }
        const relDir = toPortableRelative(root, path.dirname(pngAbs)) ?? '';
        const relBypass = relDir
          ? `${relDir}/${path.basename(bypass.path)}`
          : path.basename(bypass.path);
        if (stagedRels.has(relBypass)) continue;
        stagedRels.add(relBypass);
        checkedTargets.push({ svg: svgExisting, raw: rawExisting, pngRel: relToRoot.split(path.sep).join('/') });
        stageFileContent(plan, relBypass, fs.readFileSync(bypass.path));
      }
    }

    // 以上导出会等待云端；提交前重新检查源文件和所有目标，且检查到
    // 原子提交之间不再 await，防止本进程其他任务在窗口内修改这些状态。
    for (const doc of checkedDocs) {
      const rel = toPortableRelative(root, doc.mdPath);
      if (!rel) throw new Error(`白板补齐期间源路径无效：${doc.objToken}`);
      resolveInside(root, rel, 'read');
      if (this.getPendingLocalEditState(doc.objToken) || this.getCloudOperationBlock(doc.objToken)
        || !fs.existsSync(doc.mdPath) || !fs.readFileSync(doc.mdPath).equals(doc.body)) {
        throw new Error(`白板补齐期间源文档或云端操作状态发生变化：${doc.objToken}，未提交任何文件`);
      }
    }
    for (const { svg, raw, pngRel } of checkedTargets) {
      if (fs.existsSync(svg) || fs.existsSync(raw)) throw new Error('白板补齐期间目标文件已出现，未提交任何文件');
      resolveInside(root, pngRel, 'read');
      const parentRel = toPortableRelative(root, path.dirname(svg));
      resolveInside(root, parentRel || '.', 'read');
    }
    const commit = commitAtomicPlan(plan);
    if (!commit.ok) {
      throw new Error(commit.error || '白板旁路补齐原子提交失败（已整体回滚，无残留入库）');
    }
    return {
      scanned,
      exported: commit.committed.length,
      skipped,
      committedFiles: [...commit.committed],
    };
  }

  /**
   * Download attachments into staging. The same 403 -> preview fallback is
   * used for normal media; filenames from cloud content are never used as a
   * destination path, preventing traversal and collision hazards.
   */
  private async downloadAttachments(
    doc: FetchedDocument,
    saveDir: string
  ): Promise<Attachment[]> {
    const attachments: Attachment[] = [];
    const attachmentsDir = path.join(saveDir, 'attachments');

    // Create attachments directory if it doesn't exist
    if (!fs.existsSync(attachmentsDir)) {
      fs.mkdirSync(attachmentsDir, { recursive: true });
    }

    for (let index = 0; index < doc.attachments.length; index += 1) {
      const attachment = doc.attachments[index];
      const outputStem = path.join(
        attachmentsDir,
        `${String(index + 1).padStart(2, '0')}-${attachment.token}`,
      );

      let filepath: string;
      try {
        filepath = await this.execMediaDownload(outputStem, attachment.token, 'media');
      } catch {
        filepath = await this.execMediaPreview(outputStem, attachment.token);
      }
      this.assertDownloadedMedia(filepath, attachment.token);
      attachments.push({
        token: attachment.token,
        path: filepath,
        name: attachment.name,
      });
    }

    return attachments;
  }

  /**
   * Write local markdown file with HTML comment header
   */
  private async writeLocalMarkdown(
    localMdPath: string,
    content: string,
    meta: HeaderMeta
  ): Promise<void> {
    // Create directory if it doesn't exist
    const dir = path.dirname(localMdPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Backup existing file if it exists
    if (fs.existsSync(localMdPath)) {
      const backupPath = `${localMdPath}.bak`;
      try {
        fs.copyFileSync(localMdPath, backupPath);
      } catch (error) {
        console.warn(`[SyncEngine] Failed to create backup: ${error}`);
        // Continue without backup if it fails
      }
    }

    // Generate HTML comment header (YAML-in-comment new spec).
    const header = this.generateHtmlHeader(meta);

    // Write file with header + content
    fs.writeFileSync(localMdPath, header + content, 'utf-8');
  }

  /**
   * Update local mapping in database
   */
  private async updateLocalMap(
    doc: ChangedDocument,
    localMdPath: string,
  ): Promise<void> {
    await this.updateLocalMapWithStatus(doc, localMdPath, 'synced');
  }

  /**
   * Update local mapping with custom status (e.g., 'placeholder')
   */
  private async updateLocalMapWithStatus(
    doc: ChangedDocument,
    localMdPath: string,
    status: 'synced' | 'changed' | 'error' | 'placeholder'
  ): Promise<void> {
    this.localMapStore.upsertDocument({
      objToken: doc.objToken,
      wikiNodeToken: null, // Will be filled if available
      objType: doc.objType,
      title: path.basename(localMdPath, '.md'),
      localMdPath,
      lastSyncedModifyTime: doc.cloudModifiedTime,
      lastSyncedAt: new Date().toISOString(),
      status,
    });

    // This is the only write path that advances the v5 synced baseline.
    // P0 keeps apply closed until P3 wraps the surrounding file work in one
    // atomic transaction; when that coordinator opens the gate, this call is
    // made only after the staged file commit has succeeded.
    if (status === 'synced' && typeof this.localMapStore.markDocumentSynced === 'function') {
      this.localMapStore.markDocumentSynced({
        objToken: doc.objToken,
        syncedObjEditTime: doc.observedObjEditTime ?? null,
        localMdPath,
        lastSyncedModifyTime: doc.cloudModifiedTime,
        lastSyncedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Generate local file path via PathResolver when a watched root is known;
   * otherwise fall back to the legacy root-level title.md plan (blocked in
   * dry-run when multi-root config is present without watchedRootId).
   */
  private generateLocalPath(doc: ChangedDocument): string {
    const roots = Array.isArray(this.config?.watchedRoots)
      ? this.config.watchedRoots
      : [];
    const rootConfig = doc.watchedRootId
      ? roots.find((item: { id: string }) => item.id === doc.watchedRootId)
      : roots.length === 1
        ? roots[0]
        : null;

    if (rootConfig) {
      const planned = resolveLocalTarget({
        knowledgeBaseRoot: this.config.knowledgeBaseRoot,
        watchedRoot: rootConfig,
        title: doc.title,
        hasChild: doc.hasChild === true,
        parentChainTitles: doc.parentChainTitles,
        isWatchedRootNode: doc.isWatchedRootNode,
        existingLocalRelPath: doc.localRelPath ?? null,
        existingLocalMdPath: doc.localMdPath,
        objType: doc.objType,
        rejectExistingFiles: false,
      });
      if (planned.ok && planned.target) {
        return resolveAbsolute(
          this.config.knowledgeBaseRoot,
          planned.target.relativeMarkdownPath,
        );
      }
    }

    return fallbackMarkdownTarget(this.config.knowledgeBaseRoot, doc.title);
  }

  /**
   * Read local markdown file for LLM comparison
   */
  private async readLocalMarkdown(localMdPath: string): Promise<string> {
    if (!fs.existsSync(localMdPath)) {
      return '';
    }
    return fs.readFileSync(localMdPath, 'utf-8');
  }

  /** Download a URL with fetch — no shell, no string interpolation. */
  private async downloadUrlToFile(filepath: string, url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`URL 下载失败 HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('URL 下载内容为空');
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() ?? '';
    const extension = this.mediaExtensionForContentType(contentType);
    const targetPath = path.extname(filepath) ? filepath : `${filepath}${extension}`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, buffer);
    return targetPath;
  }

  /**
   * Execute media-download command
   */
  private async execMediaDownload(
    filepath: string,
    token: string,
    type: 'media' | 'whiteboard',
  ): Promise<string> {
    const result = await this.requireLarkCliClient().downloadMedia(token, filepath, type);
    return this.resolveStagedMediaPath(filepath, result);
  }

  /**
   * Execute media-preview command (fallback)
   */
  private async execMediaPreview(filepath: string, token: string): Promise<string> {
    const result = await this.requireLarkCliClient().previewMedia(token, filepath);
    return this.resolveStagedMediaPath(filepath, result);
  }

  /** Resolve a CLI-reported auto-extension, retaining test-double support. */
  private resolveStagedMediaPath(requestedPath: string, reportedPath: unknown): string {
    const directory = path.dirname(requestedPath);
    const canonical = (candidate: string): string => {
      try {
        return fs.realpathSync.native(candidate);
      } catch {
        return path.resolve(candidate);
      }
    };
    const isInsideDirectory = (candidate: string): boolean => {
      const relative = path.relative(canonical(directory), canonical(candidate));
      return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
    };

    if (typeof reportedPath === 'string' && reportedPath.length > 0) {
      const resolved = path.resolve(reportedPath);
      if (!isInsideDirectory(resolved)) {
        throw new Error(`媒体下载器返回了 staging 目录外路径: ${resolved}`);
      }
      return resolved;
    }

    // Existing unit-test doubles write to the requested stem and predate the
    // CLI's saved_path response. Accept that exact path, or one deterministic
    // auto-extension sibling produced by the real shortcut.
    if (fs.existsSync(requestedPath)) return requestedPath;
    const stem = path.basename(requestedPath);
    const candidates = fs.existsSync(directory)
      ? fs.readdirSync(directory)
        .filter((name) => name.startsWith(`${stem}.`))
        .sort()
      : [];
    if (candidates.length === 1) return path.join(directory, candidates[0]);
    throw new Error(`媒体下载未产生可定位文件: ${stem}`);
  }

  private assertDownloadedMedia(filepath: string, token: string): void {
    if (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile() || fs.statSync(filepath).size <= 0) {
      throw new Error(`媒体下载失败或为空: ${token}`);
    }
  }

  private mediaExtensionForContentType(contentType: string): string {
    const extensions: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'application/pdf': '.pdf',
      'application/zip': '.zip',
    };
    return extensions[contentType] ?? '.bin';
  }

  /** Render downloaded whiteboard previews as portable local Markdown images. */
  private renderLocalizedMediaReferences(content: string): string {
    const whiteboards = content.replace(
      /<whiteboard\b[^>]*\btoken=(['"])(images\/[^'"]+)\1[^>]*>(?:\s*<\/whiteboard>)?/gi,
      (_whole, _quote: string, localPath: string) => `![飞书白板](${localPath})`,
    );
    return whiteboards.replace(
      /<(?:file|source)\b[^>]*\btoken=(['"])(attachments\/[^'"]+)\1[^>]*\/?>(?:\s*<\/(?:file|source)>)?/gi,
      (_whole, _quote: string, localPath: string) =>
        `[${path.basename(localPath)}](${localPath})`,
    );
  }

  /** Append page-addressable local media links to a Slides Markdown export. */
  private appendSlidesMediaReferences(
    content: string,
    references: NonNullable<FetchedDocument['slideMedia']>,
    localReferences: ReadonlyMap<string, string>,
  ): string {
    const rendered = references
      .map((reference) => {
        const localPath = localReferences.get(reference.token);
        if (!localPath) return null;
        const label = reference.kind === 'whiteboard' ? '白板预览' : '图片';
        return `- 幻灯片 ${reference.slideNumber} ${label}：![${label}](${localPath})`;
      })
      .filter((line): line is string => line !== null);

    if (rendered.length === 0) return content;
    return `${content.trimEnd()}\n\n## 媒体资源\n\n${rendered.join('\n')}\n`;
  }

  // -------------------------------------------------------------------------
  // P1-S5 slides 截图采集（设计 §3.2；P1-S1 SP-1 实测：scope
  // slides:presentation:screenshot 未授权时 CLI 以 missing_scope 拒绝——
  // 「缺失即跳过」是本切片主线；授权后真实采集路径（SP-2 输出映射 /
  // SP-3 字节稳定性 / SP-4 体积）待主上授权后于 P1-S6 前实测固化）。
  // ---------------------------------------------------------------------------

  /** slides +screenshot 单请求页数上限（CLI 契约，SP-1 help 实测）。 */
  private static readonly SLIDES_SCREENSHOT_BATCH_SIZE = 10;
  /** 单页体积上限（设计 §6 SP-4：越界按失败处理，all-or-none）。 */
  private static readonly SLIDES_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
  /** 单文档页数上限（设计 §3.2 默认 60；超出记警告并跳过）。 */
  private static readonly SLIDES_SCREENSHOT_MAX_PAGES = 60;

  /**
   * 采集 slides 逐页截图到 staging（all-or-none）。任一环节失败 → 删除本
   * 文档全部已暂存截图并返回空数组：文档照常提交、仅记警告，不阻断同步
   * 也不影响 synced 基线推进条件（U36：失败是警告不是阻断）。
   */
  private async stageSlidesScreenshots(
    doc: ChangedDocument,
    fetched: FetchedDocument,
    stagingDocDir: string,
    localMdPath: string,
  ): Promise<Array<{ slideNumber: number; image: Image }>> {
    const warnSkip = (reason: string, detail?: unknown): void => {
      console.warn(
        `[SyncEngine] slides_screenshot_unavailable(reason=${reason}) slides="${doc.title}"`,
        detail ?? '',
      );
    };
    if (this.config?.sync?.slidesScreenshot?.enabled !== true) return [];
    const pages = fetched.slideCount ?? 0;
    if (pages < 1) return [];
    if (pages > SyncEngine.SLIDES_SCREENSHOT_MAX_PAGES) {
      warnSkip('too_many_pages', pages);
      return [];
    }
    if (!(await this.resolveSlidesScreenshotScopeGranted())) {
      warnSkip('scope_missing');
      return [];
    }

    const stem = path.basename(localMdPath, '.md') || doc.objToken;
    const imagesDir = path.join(stagingDocDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const results: Array<{ slideNumber: number; image: Image }> = [];
    try {
      for (
        let start = 0;
        start < pages;
        start += SyncEngine.SLIDES_SCREENSHOT_BATCH_SIZE
      ) {
        const batch = Array.from(
          { length: Math.min(SyncEngine.SLIDES_SCREENSHOT_BATCH_SIZE, pages - start) },
          (_, index) => start + index + 1,
        );
        const batchDir = path.join(stagingDocDir, `.slides-screenshots-${start}`);
        const outputs = await this.requireLarkCliClient().screenshotSlides(doc.objToken, {
          slideNumbers: batch,
          outputDir: batchDir,
        });
        const byNumber = new Map<number, string>(
          outputs.map((output: { slideNumber: number; path: string }) => [output.slideNumber, output.path]),
        );
        for (const slideNumber of batch) {
          const source = byNumber.get(slideNumber);
          if (!source || typeof source !== 'string') {
            throw new Error(`页 ${slideNumber} 无输出文件映射`);
          }
          const extension = this.validateScreenshotFile(source, slideNumber);
          const target = path.join(
            imagesDir,
            `${stem}-p${String(slideNumber).padStart(2, '0')}${extension}`,
          );
          fs.copyFileSync(source, target);
          results.push({
            slideNumber,
            image: {
              token: `slides-screenshot-p${slideNumber}`,
              path: target,
              kind: 'image',
            },
          });
        }
        fs.rmSync(batchDir, { recursive: true, force: true });
      }
    } catch (error) {
      // all-or-none：删除本文档全部已暂存截图（含先前批次的成品与临时目录）。
      for (const entry of results) fs.rmSync(entry.image.path, { force: true });
      warnSkip('capture_failed', error instanceof Error ? error.message : String(error));
      return [];
    }
    return results;
  }

  /** 截图 scope 授权态：一次 checkAuthReady（不联网 verify）快照，失败即未授。 */
  private async resolveSlidesScreenshotScopeGranted(): Promise<boolean> {
    if (this.slidesScreenshotScopeGranted !== null) return this.slidesScreenshotScopeGranted;
    const client = this.requireLarkCliClient();
    if (typeof client.checkAuthReady !== 'function') {
      this.slidesScreenshotScopeGranted = false;
      return false;
    }
    try {
      const readiness = await client.checkAuthReady({ verify: false });
      const granted = new Set<string>(readiness?.currentScopes ?? []);
      this.slidesScreenshotScopeGranted = optionalScopesForFeature('slidesScreenshots')
        .every((scope) => granted.has(scope));
    } catch {
      this.slidesScreenshotScopeGranted = false;
    }
    return this.slidesScreenshotScopeGranted;
  }

  /** 校验单页截图：存在、非空、≤10MiB、PNG/JPEG 魔数（SP-4 契约）。 */
  private validateScreenshotFile(file: string, slideNumber: number): '.png' | '.jpg' {
    const stat = fs.statSync(file);
    if (stat.size <= 0 || stat.size > SyncEngine.SLIDES_SCREENSHOT_MAX_BYTES) {
      throw new Error(`页 ${slideNumber} 截图体积越界: ${stat.size} bytes`);
    }
    const head = Buffer.alloc(8);
    const fd = fs.openSync(file, 'r');
    try {
      const read = fs.readSync(fd, head, 0, head.length, 0);
      if (
        read >= 8
        && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
        && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
      ) {
        return '.png';
      }
      if (read >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        return '.jpg';
      }
      throw new Error(`页 ${slideNumber} 截图非 PNG/JPEG 魔数`);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * P1-S5（设计 §3.2）：为每页追加截图行，位于该页既有媒体行之前；
   * 「## 媒体资源」区不存在时创建之（格式与 appendSlidesMediaReferences
   * 一致，两分支产出的区段可安全共存）。
   */
  private appendSlidesScreenshotReferences(
    content: string,
    screenshots: Array<{ slideNumber: number; image: Image }>,
  ): string {
    if (screenshots.length === 0) return content;
    const shotEntries = screenshots.map((shot) => ({
      slideNumber: shot.slideNumber,
      line: `- 幻灯片 ${shot.slideNumber} 截图：![幻灯片 ${shot.slideNumber} 截图](images/${path.basename(shot.image.path)})`,
    }));
    const header = '## 媒体资源';
    const headerIndex = content.lastIndexOf(header);
    if (headerIndex < 0) {
      return `${content.trimEnd()}\n\n${header}\n\n${shotEntries.map((entry) => entry.line).join('\n')}\n`;
    }
    const before = content.slice(0, headerIndex + header.length);
    const body = content.slice(headerIndex + header.length).replace(/^\n\n/, '');
    const mediaEntries = body
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const match = /^- 幻灯片 (\d+) /.exec(line);
        return { slideNumber: match ? Number(match[1]) : Number.MAX_SAFE_INTEGER, line };
      });
    const merged: Array<{ slideNumber: number; line: string }> = [];
    let mediaIndex = 0;
    let shotIndex = 0;
    while (mediaIndex < mediaEntries.length || shotIndex < shotEntries.length) {
      const media = mediaEntries[mediaIndex];
      const shot = shotEntries[shotIndex];
      // 同页时截图行在前（设计：位于该页既有媒体行之前）。
      if (shot && (!media || shot.slideNumber <= media.slideNumber)) {
        merged.push(shot);
        shotIndex += 1;
      } else {
        merged.push(media);
        mediaIndex += 1;
      }
    }
    return `${before}\n\n${merged.map((entry) => entry.line).join('\n')}\n`;
  }

  /**
   * Generate the YAML-in-comment HTML header (header_format = yaml_html).
   *
   * Emits the new-spec format that IndexScanner parses FIRST and most
   * completely (parseYamlHtmlHeader + extractYamlFields). Replaces the
   * legacy Chinese-key block (来源/节点/原始链接/obj_token/获取日期) which
   * carried no wiki_node_token / space_id / obj_type and produced
   * `节点: unknown` + empty `原始链接:` on the sheet path.
   *
   * Field emission rules:
   *   - obj_token, fetch_date are always emitted (always available).
   *   - obj_type emitted only when docx/sheet/slides (the concrete types
   *     parseYamlHtmlHeader recognizes). 'unknown' is omitted so the
   *     parser falls back to its default 'docx' classification rather
   *     than persisting 'unknown'.
   *   - wiki_node_token / space_id / original_link / last_synced_modify_time
   *     are emitted only when non-null/non-empty (never fabricated).
   *
   * Output shape (matches 规范 §5.3 docx/sheet target samples):
   *
   *   <!--
   *   feishu_sync:
   *     obj_token: "..."
   *     wiki_node_token: "..."
   *     space_id: "..."
   *     obj_type: "docx"
   *     original_link: "https://..."
   *     fetch_date: "2026-07-08T..."
   *     last_synced_modify_time: "2026-07-08T..."
   *   -->
   */
  private generateHtmlHeader(meta: HeaderMeta): string {
    const lines: string[] = ['<!--', 'feishu_sync:'];

    // obj_token is always present (it is the SQLite PK + the document's
    // identity). Without it IndexScanner.parseMetadata cannot index the
    // file, so we always emit it.
    lines.push(`  obj_token: ${this.yamlScalar(meta.objToken)}`);

    if (meta.wikiNodeToken) {
      lines.push(`  wiki_node_token: ${this.yamlScalar(meta.wikiNodeToken)}`);
    }
    if (meta.spaceId) {
      lines.push(`  space_id: ${this.yamlScalar(meta.spaceId)}`);
    }

    // obj_type: emit only concrete recognized types. 'unknown' (e.g. a
    // placeholder that slipped through) is omitted so the parser's
    // default 'docx' classification (index-scanner.ts:208) takes effect.
    // bitable（2026-10）：与 docx/sheet/slides 同为 IndexScanner
    // parseYamlHtmlHeader 识别的具体类型，round-trip 必须闭环。
    if (
      meta.objType === 'docx'
      || meta.objType === 'sheet'
      || meta.objType === 'slides'
      || meta.objType === 'bitable'
    ) {
      lines.push(`  obj_type: ${this.yamlScalar(meta.objType)}`);
    }

    if (meta.originalLink) {
      lines.push(`  original_link: ${this.yamlScalar(meta.originalLink)}`);
    }

    lines.push(`  fetch_date: ${this.yamlScalar(meta.fetchDate)}`);

    // last_synced_modify_time comes from ChangedDocument.cloudModifiedTime
    // (ChangeDetector.formatUnixSeconds → ISO8601). It may be '' for the
    // 0/NULL branch; emit only when non-empty.
    if (meta.lastSyncedModifyTime && meta.lastSyncedModifyTime.length > 0) {
      lines.push(`  last_synced_modify_time: ${this.yamlScalar(meta.lastSyncedModifyTime)}`);
    }

    lines.push('-->');
    // Trailing blank line separates the header from the document body,
    // matching the original generateHtmlHeader contract.
    return lines.join('\n') + '\n\n';
  }

  /**
   * Wrap a scalar value in double quotes for the YAML-in-comment header.
   *
   * IndexScanner.extractYamlFields strips a single matching leading /
   * trailing quote via `/^["']|["']$/g` (index-scanner.ts:564), so
   * double-quoting every value is round-trip safe. Feishu tokens /
   * URLs / ISO8601 timestamps never contain double quotes, so no
   * escape sequence is needed.
   */
  private yamlScalar(value: string): string {
    return `"${value}"`;
  }

  /**
   * Resolve the metadata block for the YAML file header.
   *
   * This is the core of the sheet-header fix (规范 §5.4): the sheet
   * path constructs FetchedDocument with `url: ''` because sheet content
   * is synthesized from CSVs via LayoutReconstructor and never goes
   * through `docs +fetch`. The legacy generateHtmlHeader then wrote
   * `节点: unknown` / `原始链接:` empty. resolveHeaderMeta sources the
   * wiki-layer fields from SQLite instead of fetched.url.
   *
   * Why SQLite is reliable here for BOTH added and modified docs:
   *   ChangeDetector.upsertDocumentSeen (change-detector.ts:609-616)
   *   runs for every cloud node during detect and persists
   *   wiki_node_token (= node.node_token) + space_id BEFORE the sync
   *   pipeline is dispatched. So by the time SyncEngine writes the .md,
   *   getDocumentByObjToken returns a row carrying both fields even for
   *   a brand-new added sheet.
   *
   * original_link precedence (no fabrication):
   *   (1) fetched.url — docx path's authoritative feishu URL from
   *       `docs +fetch`.
   *   (2) SQLite documents.original_link — populated for previously
   *       synced docs and by recomputeCloudMatch's best-effort
   *       construction from wiki_node_token.
   *   (3) Constructed as `https://{host}/wiki/{wiki_node_token}` where
   *       host is derived from the first configured watchedRootUrl —
   *       this branch is what fills the sheet gap when (1) and (2) are
   *       both empty.
   *
   * If all three fail AND wikiNodeToken is null, originalLink stays
   * null and generateHtmlHeader omits the line. obj_token is always
   * present so the file remains indexable.
   */
  private resolveHeaderMeta(
    doc: ChangedDocument,
    fetched: FetchedDocument
  ): HeaderMeta {
    // getDocumentByObjToken is a synchronous SQLite lookup. For both
    // added and modified docs a row exists at this point because
    // ChangeDetector.upsertDocumentSeen wrote it during detect.
    const record = this.localMapStore.getDocumentByObjToken(doc.objToken);

    const wikiNodeToken = record?.wikiNodeToken ?? null;
    const spaceId = record?.spaceId ?? null;

    let originalLink: string | null = null;
    if (fetched.url && fetched.url.trim().length > 0) {
      originalLink = fetched.url.trim();
    } else if (record?.originalLink && record.originalLink.trim().length > 0) {
      originalLink = record.originalLink.trim();
    } else if (wikiNodeToken) {
      const host = this.extractFeishuHost(record?.watchedRootId, record?.watchedRootUrl);
      if (host) {
        originalLink = `https://${host}/wiki/${wikiNodeToken}`;
      }
    }

    return {
      objToken: doc.objToken,
      objType: doc.objType,
      wikiNodeToken,
      spaceId,
      originalLink,
      fetchDate: new Date().toISOString(),
      lastSyncedModifyTime: doc.cloudModifiedTime,
    };
  }

  /**
   * Extract the feishu wiki host (e.g. `qcnbafdrjx7n.feishu.cn`) from
   * the document's configured watched root. Used to construct an
   * original_link for sheets (whose fetched.url is empty) from
   * wiki_node_token. Returns null when no URL is configured or the URL
   * is unparseable; the caller then leaves original_link null rather
   * than fabricating a host.
   */
  private extractFeishuHost(
    watchedRootId: string | null | undefined,
    watchedRootUrl: string | null | undefined,
  ): string | null {
    const roots: WatchedRootConfig[] = Array.isArray(this.config?.watchedRoots)
      ? this.config.watchedRoots as WatchedRootConfig[]
      : [];
    const selected = roots.find((root) => root.id === watchedRootId)
      ?? roots.find((root) => root.url === watchedRootUrl)
      ?? roots.find((root) => root.enabled);
    // Keep a narrow legacy fallback for callers that construct SyncEngine
    // with a pre-P2 in-memory config. Persisted config always has roots.
    const candidate = selected?.url
      ?? (typeof watchedRootUrl === 'string' ? watchedRootUrl : null)
      ?? (Array.isArray(this.config?.watchedRootUrls) ? this.config.watchedRootUrls[0] : null);
    if (typeof candidate !== 'string' || candidate.length === 0) return null;
    try {
      return new URL(candidate).host;
    } catch {
      return null;
    }
  }

  /**
   * Export every sub-sheet CSV into a staging directory only.
   * Does NOT write into the knowledge base and does NOT touch sheet_sheets —
   * those DB rows are written only after atomic file commit succeeds.
   *
   * Per sub-sheet float-image handling: probe metadata (soft-fail, see
   * sheet-media.probeSheetFloatImages), three-tier download into
   * stagingDocDir/images/, then enrich the CSV cells with local image links.
   * A download failure (listed but undownloadable) throws and aborts the
   * document — same contract as docx media: never advance the synced
   * baseline while resources are missing.
   */
  /**
   * docx 正文内嵌 <sheet> 标签展开（2026-09-04）。
   *
   * 飞书 docx 导出的 markdown 中，嵌入的电子表格以
   * `<sheet sheet-id="..." token="..."></sheet>` 引用。历史链路只展开
   * objType==='sheet' 的整文档型表格，docx 内嵌标签原样落盘，预览直接
   * 显示裸 XML。这里逐标签：token → exportSheetsToStaging（csv + 浮动
   * 图片全管道）→ LayoutReconstructor 重构 → 标签级替换为「## 子表:」
   * 段（与整文档型同款段格式，含 CSV 链接与浮动图片附录）。
   *
   * 失败语义：任一标签导出/重构失败 → 抛错，文档同步中止、不推进
   * synced 基线（与整文档型「子表失败 aborts the document」一致），
   * 下次同步重试。
   *
   * 多标签同文档：每个 token 的 csv-data 目录以 `${docname}_${sheetId}`
   * 命名，避免同名冲突。
   *
   * 按标签 sheetId 过滤（2026-09-10 实测修复）：飞书导出的 markdown 中，
   * 同一 workbook 的多个子表在同一 docx 里各占一个 `<sheet>` 标签。
   * 旧逻辑对每个标签都导出整个 workbook 的全部子表：28 标签 × 30 子表
   * 写出 840 个「## 子表:」段（md 23KB→333KB）与 28 个目录 × 30
   * 份 CSV。现在标签级只导 sheet_id 匹配的那一个子表；sheetId 为空或
   * 在 workbook 中已不存在时回退全量导出（保持旧行为，子表被删后标签
   * 仍能展开而不是报错卡死）。
   */
  private async expandInlineSheetTags(
    content: string,
    stagingDocDir: string,
    docname: string,
  ): Promise<{
    content: string;
    sheets: Array<{
      sheetId: string;
      title: string;
      csvPath: string;
      csvRel: string;
      images: SheetMediaItem[];
    }>;
  }> {
    const SHEET_TAG_RE = /<sheet\s+sheet-id="([^"]*)"\s+token="([A-Za-z0-9]+)"\s*>\s*<\/sheet>/g;
    const tags = [...content.matchAll(SHEET_TAG_RE)];
    if (tags.length === 0) return { content, sheets: [] };

    const collected: Array<{
      sheetId: string;
      title: string;
      csvPath: string;
      csvRel: string;
      images: SheetMediaItem[];
    }> = [];

    let out = content;
    for (const tag of tags) {
      const [whole, sheetId, token] = tag;
      const stagingName = `${docname}_${sheetId || 'sheet'}`;
      const exported = await this.exportSheetsToStaging(
        token,
        stagingDocDir,
        stagingName,
        sheetId || undefined,
      );
      const sections: string[] = [];
      for (const sheet of exported) {
        let section =
          `## 子表: ${sheet.title}\n\n[CSV 原始数据](${sheet.csvRel})\n\n`;
        if (this.layoutReconstructor) {
          section += await this.layoutReconstructor.reconstructToMarkdown(sheet.csvPath);
        } else {
          // 无重构器时退化为纯链接段（正常链路 layoutReconstructor 必在）
          section += `原始数据见 CSV：${sheet.csvRel}`;
        }
        if (sheet.images.length > 0) {
          section += `\n\n${renderSheetMediaAppendix(sheet.title, sheet.images)}`;
        }
        sections.push(section);
        collected.push(sheet);
      }
      // 函数形式 replace：sections 内容含 $ 等特殊字符时避免被当作替换模式
      out = out.replace(whole, () => sections.join('\n\n---\n\n'));
      console.info(
        `[SyncEngine] Expanded inline <sheet> tag ${token} into ${exported.length} subsection(s)`,
      );
    }
    return { content: out, sheets: collected };
  }

  private async exportSheetsToStaging(
    sheetToken: string,
    stagingDocDir: string,
    docname: string,
    onlySheetId?: string,
    expectedRevision?: unknown,
    reconstructedWorkbook?: string,
  ): Promise<Array<{
    sheetId: string;
    title: string;
    csvPath: string;
    csvRel: string;
    images: SheetMediaItem[];
  }>> {
    const csvDataDir = path.join(stagingDocDir, `${docname}.csv-data`);
    fs.mkdirSync(csvDataDir, { recursive: true });

    const exports: Array<{
      sheetId: string;
      title: string;
      csvPath: string;
      csvRel: string;
      images: SheetMediaItem[];
    }> = [];

    const workbookInfo = await this.requireLarkCliClient().getWorkbookInfo(sheetToken);
    if (expectedRevision != null && String(workbookInfo?.data?.revision) !== String(expectedRevision)) {
      throw new Error('读取子表清单期间表格版本变化，已保留现有本地文件');
    }
    let sheetsList = (workbookInfo.data?.sheets || []) as Array<{
      sheet_id: string;
      sheet_name: string;
      row_count?: number;
      column_count?: number;
    }>;

    if (sheetsList.length === 0) {
      throw new Error(`workbook 无子表: ${sheetToken}`);
    }

    // docx 内嵌标签只导标签指向的那一个子表（见 expandInlineSheetTags
    // 注释：旧全量导出导致多标签同 workbook 时内容/目录爆炸）。匹配不到
    // 时不报错，回退全量，保持整文档型 sheet 与「子表已删」场景兼容。
    if (onlySheetId) {
      const matched = sheetsList.filter((sheet) => sheet.sheet_id === onlySheetId);
      if (matched.length > 0) {
        sheetsList = matched;
      } else {
        console.warn(
          `[SyncEngine] sheet-id "${onlySheetId}" not found in workbook ${sheetToken}; falling back to all ${sheetsList.length} sheet(s)`,
        );
      }
    }

    for (let index = 0; index < sheetsList.length; index += 1) {
      const sheet = sheetsList[index];
      if (this.testHooks.failSheetAfterFirst && index > 0) {
        throw new Error(`注入失败：子表导出中止于 ${sheet.sheet_name}`);
      }

      const safeTitle = sheet.sheet_name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
      const csvPath = path.join(csvDataDir, `${safeTitle}.csv`);
      const rows = sheet.row_count ?? 200;
      const cols = sheet.column_count ?? 20;
      const range = `A1:${colToLetter(cols)}${rows}`;

      const csvResult = reconstructedWorkbook ? { data: { annotated_csv: await readReconstructedSheetCsv(reconstructedWorkbook, sheet.sheet_name, rows, cols), actual_range: range, has_more: false, revision: expectedRevision } } : await this.requireLarkCliClient().getSheetCsv({
        spreadsheetToken: sheetToken,
        sheetId: sheet.sheet_id,
        range,
      });
      const csvText = csvResult?.data?.annotated_csv ?? '';
      if (expectedRevision != null && (csvResult?.data?.has_more !== false || csvResult?.data?.truncated === true
        || csvResult?.data?.actual_range !== range || String(csvResult?.data?.revision) !== String(expectedRevision))) {
        throw new Error(`子表 ${sheet.sheet_name} 的 CSV 范围、版本或完整性无法确认，已保留现有本地文件`);
      }
      if (!csvText || csvText.trim().length === 0) {
        throw new Error(
          `csv-get 返回空内容: sheet="${sheet.sheet_name}" range=${range}`,
        );
      }

      // Float-image discovery + three-tier download into staging images/,
      // then inject local references into the staged CSV cells.
      const client = this.requireLarkCliClient();
      const floatImages = await probeSheetFloatImages(client, {
        spreadsheetToken: sheetToken,
        sheetId: sheet.sheet_id,
        sheetTitle: sheet.sheet_name,
      });
      const sheetImages = floatImages.length > 0
        ? await downloadSheetMedia({
            client,
            floatImages,
            imagesDir: path.join(stagingDocDir, 'images'),
            subSheetTitle: sheet.sheet_name,
          })
        : [];

      fs.writeFileSync(csvPath, annotateCsvWithImages(csvText, sheetImages), 'utf-8');
      exports.push({
        sheetId: sheet.sheet_id,
        title: sheet.sheet_name,
        csvPath,
        csvRel: `${docname}.csv-data/${safeTitle}.csv`,
        images: sheetImages,
      });
      console.info(
        `[SyncEngine] Staged sheet "${sheet.sheet_name}" at ${csvPath}` +
          (sheetImages.length > 0 ? ` (+${sheetImages.length} float images)` : ''),
      );
    }

    return exports;
  }
}

/**
 * 列号（1-based）转 Excel 列字母（A、Z、AA、AZ、BE...）。
 * 用于 csv-get range 构造（A1 形式）。
 */
function colToLetter(n: number): string {
  let s = '';
  let x = Math.max(1, Math.floor(n));
  while (x > 0) {
    const mod = (x - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    x = Math.floor((x - mod) / 26);
  }
  return s;
}
