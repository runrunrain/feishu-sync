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
import os from 'node:os';
import type {
  ChangedDocument,
  SyncResult,
  SyncOptions,
  SyncedDocument,
  FailedDocument,
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
import type { DocumentIR } from './document-ir.js';
import {
  createAtomicCommitWorkspace,
  rollbackAtomicPlan,
} from './atomic-commit.js';

interface FetchedDocument {
  content: string;
  images: Array<{ token: string; url?: string }>;
  attachments: Array<{ token: string; name: string }>;
  sheets: Array<{ token: string; title: string }>;
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
  objType: 'docx' | 'sheet' | 'slides' | 'unknown';
  wikiNodeToken: string | null;
  spaceId: string | null;
  originalLink: string | null;
  fetchDate: string;
  lastSyncedModifyTime: string;
}

interface Image {
  token: string;
  path: string;
}

interface Attachment {
  token: string;
  path: string;
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
}

export class SyncEngine {
  private larkCliClient: any;
  private localMapStore: any;
  private config: any;
  private layoutReconstructor?: any;
  private contentAdapter?: any;
  private testHooks: SyncEngineTestHooks;

  constructor(deps: SyncEngineDeps) {
    this.larkCliClient = deps.larkCliClient;
    this.localMapStore = deps.localMapStore;
    this.config = deps.config;
    this.layoutReconstructor = deps.layoutReconstructor;
    this.contentAdapter = deps.contentAdapter;
    this.testHooks = deps.testHooks ?? {};
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
        if (planned.action === 'blocked') {
          failedDocuments.push({
            objToken: planned.objToken,
            title: planned.title,
            error: planned.reason || '同步计划被安全策略阻止',
            retryable: false,
          });
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
      if (planned.action === 'blocked' || !planned.localMdPath) {
        failedDocuments.push({
          objToken: doc.objToken,
          title: doc.title,
          error: planned.reason || '同步计划被安全策略阻止',
          retryable: false,
        });
        continue;
      }

      try {
        // Apply uses exactly the target that was independently reviewed in
        // the manifest; it must not recompute a potentially different path.
        const result = await this.syncSingleDocument(
          { ...doc, localMdPath: planned.localMdPath },
          options,
        );
        syncedDocuments.push(result);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const errStack = error instanceof Error && error.stack ? error.stack : '';
        // 同步失败日志落盘（诊断报告 §4.3）：当前无任何磁盘日志，失败根因
        // 只能静态推测。这里把单文档失败的堆栈追加到
        // ~/.feishu-sync/sync-errors.log，便于事后回溯。
        // 用 try/catch 包住：日志写入失败不能影响同步主流程。
        try {
          const logPath = path.join(os.homedir(), '.feishu-sync', 'sync-errors.log');
          const header = `[${new Date().toISOString()}] ${doc.objToken} (${doc.title})\n`;
          const body = errStack ? `${errMsg}\n${errStack}\n` : `${errMsg}\n`;
          fs.appendFileSync(logPath, `${header}${body}---\n`);
        } catch (logError) {
          console.error('[SyncEngine] failed to append sync-errors.log:', logError);
        }
        failedDocuments.push({
          objToken: doc.objToken,
          title: doc.title,
          error: errMsg,
          retryable: true,
        });
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

  /**
   * Synchronize a single document through the complete pipeline
   */
  private async syncSingleDocument(
    doc: ChangedDocument,
    options: SyncOptions
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
    let isPlaceholder = false;

    if (doc.objType === 'sheet') {
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
      // docs+fetch only supports docx (API 3380002). Keep a deterministic
      // markdown placeholder body; media still downloads when tokens exist.
      console.info(
        `[SyncEngine] objType=slides, skipping docs+fetch (unsupported by docs+fetch)`,
      );
      fetched = {
        content:
          `# ${doc.title}\n\n` +
          `> 飞书幻灯片（slides）。当前 lark-cli \`docs +fetch\` 不支持 slides，` +
          `已同步元数据占位；完整页面内容请在飞书中查看。\n`,
        images: [],
        attachments: [],
        sheets: [],
        url: '',
        obj_token: doc.objToken,
      };
    } else {
      try {
        fetched = await this.fetchDocumentContent(doc.objToken, doc.objType);
      } catch (error) {
        // Check if this is a 40403 no permission error
        if (error instanceof Error && error.message.includes('40403')) {
          console.warn(`[SyncEngine] No permission for document ${doc.title}, creating placeholder`);
          isPlaceholder = true;
          fetched = {
            content: '',
            images: [],
            attachments: [],
            sheets: [],
            url: doc.localMdPath || '', // Will be filled in writePlaceholder
            obj_token: doc.objToken,
          };
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

    // For placeholder files, create a placeholder .md and mark in local map
    if (isPlaceholder) {
      const localMdPath = doc.localMdPath || this.generateLocalPath(doc);
      await this.writePlaceholderFile(localMdPath, doc);
      await this.updateLocalMapWithStatus(doc, localMdPath, 'placeholder');
      return {
        objToken: doc.objToken,
        title: doc.title,
        localMdPath,
        cloudModifiedTime: doc.cloudModifiedTime,
        size: 0,
        imagesCount: 0,
        attachmentsCount: 0,
        sheetsCount: 0,
      };
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

    const images = await this.downloadImages(fetched, stagingDocDir);
    const attachments = await this.downloadAttachments(fetched, stagingDocDir);

    const expandedContent = fetched.content;

    const sheets: Array<{ sheetId: string; title: string; csvPath: string; csvRel: string }> = [];
    if (doc.objType === 'sheet') {
      const docname = path.basename(localMdPath, '.md');
      const exportedSheets = await this.exportSheetsToStaging(
        doc.objToken,
        stagingDocDir,
        docname,
      );
      sheets.push(...exportedSheets);
    }

    // 6. Table reconstruction — any sub-sheet failure aborts the document.
    let finalContent = expandedContent;
    if (this.layoutReconstructor && sheets.length > 0) {
      const reconstructedSheets: string[] = [];
      for (const sheet of sheets) {
        const reconstructedMarkdown = await this.layoutReconstructor.reconstructToMarkdown(
          sheet.csvPath,
        );
        reconstructedSheets.push(
          `## 子表: ${sheet.title}\n\n[CSV 原始数据](${sheet.csvRel})\n\n${reconstructedMarkdown}`,
        );
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
    if (this.contentAdapter && options.enableLLM && localMdPath) {
      try {
        const localOldContent = await this.readLocalMarkdown(localMdPath);
        // P3 新接口: ContentAdapter.adaptContent(rawContent, localOld,
        // { channel?, adapt: { temperature, enableStreaming, onProgress,
        //                       timeoutMs } }). ContentAdapter 内部根据
        // registry 的 primaryChannel 选择通道并自动 fallback。
        const adapted = await this.contentAdapter.adaptContent(
          finalContent,
          localOldContent,
          {
            adapt: {
              temperature: this.config.llm.temperature ?? 0.2,
              enableStreaming: false,
              // Surface the LLM timeout as a config knob (LlmConfig.timeoutMs,
              // default 600000ms = 10 min). The previous hard-coded 60s was
              // too aggressive for bigmodel glm-5.2[1m] under load; raising
              // the ceiling here lets the primary channel finish instead of
              // prematurely aborting to the fallback. Channels still clamp
              // this value via their own resolveOptions when the caller
              // omits it.
              timeoutMs: this.config.llm.timeoutMs ?? 600_000,
            },
          }
        );
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

    // 8. Atomic content commit: only this step mutates knowledge-base files.
    const headerMeta = this.resolveHeaderMeta(doc, fetched);
    if (process.env.FEISHU_SYNC_LEGACY_WRITE === '1') {
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
        images: images.map((img) => ({
          relativePath: `images/${path.basename(img.path)}`,
          token: img.token,
        })),
        attachments: attachments.map((att) => ({
          relativePath: `attachments/${path.basename(att.path)}`,
          name: path.basename(att.path),
          token: att.token,
        })),
        sheets: sheets.map((sheet) => ({
          sheetId: sheet.sheetId,
          title: sheet.title,
          csvRelativePath: sheet.csvRel,
          csvContent: fs.readFileSync(sheet.csvPath, 'utf-8'),
        })),
      };
      const extraFiles: Array<{ relativePath: string; absoluteSource: string }> = [];
      for (const img of images) {
        const name = path.basename(img.path);
        extraFiles.push({
          relativePath: relativeDir ? `${relativeDir}/images/${name}` : `images/${name}`,
          absoluteSource: img.path,
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

    return {
      objToken: doc.objToken,
      title: doc.title,
      localMdPath,
      cloudModifiedTime: doc.cloudModifiedTime,
      size: finalContent.length,
      imagesCount: images.length,
      attachmentsCount: attachments.length,
      sheetsCount: sheets.length,
    };
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

    return {
      content: result.data.document?.content || '',
      images: result.data.document?.images || [],
      attachments: result.data.document?.attachments || [],
      sheets: result.data.document?.sheets || [],
      url: result.data.document?.url || '',
      obj_token: objToken,
    };
  }

  /**
   * Download images with three-tier fallback strategy
   * Tier 1: If image has URL, use curl
   * Tier 2: If only token, use media-download
   * Tier 3: If cross-origin 403, fallback to media-preview
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
      const filename = `${String(i + 1).padStart(2, '0')}-${img.token}.png`;
      const filepath = path.join(imagesDir, filename);

      try {
        if (img.url) {
          await this.downloadUrlToFile(filepath, img.url);
        } else {
          await this.execMediaDownload(filepath, img.token);
        }
        if (!fs.existsSync(filepath) || fs.statSync(filepath).size <= 0) {
          throw new Error(`图片为空: ${img.token}`);
        }
        images.push({ token: img.token, path: filepath });
      } catch (error) {
        try {
          if (!img.url) {
            await this.execMediaPreview(filepath, img.token);
            if (!fs.existsSync(filepath) || fs.statSync(filepath).size <= 0) {
              throw new Error(`media-preview 空文件: ${img.token}`);
            }
            images.push({ token: img.token, path: filepath });
          } else {
            throw error;
          }
        } catch (previewError) {
          throw previewError instanceof Error
            ? previewError
            : new Error(String(previewError));
        }
      }
    }

    return images;
  }

  /**
   * Download attachments using media-download
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

    for (const attachment of doc.attachments) {
      const filepath = path.join(attachmentsDir, attachment.name);

      await this.execMediaDownload(filepath, attachment.token);
      if (!fs.existsSync(filepath) || fs.statSync(filepath).size <= 0) {
        throw new Error(`附件下载失败或为空: ${attachment.token}`);
      }
      attachments.push({ token: attachment.token, path: filepath });
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
   * Write placeholder file for documents with no permission
   */
  private async writePlaceholderFile(localMdPath: string, doc: ChangedDocument): Promise<void> {
    // Create directory if it doesn't exist
    const dir = path.dirname(localMdPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const currentDate = new Date().toISOString().split('T')[0];

    // Header: reuse the canonical YAML-in-comment pipeline so placeholders
    // carry the same obj_token / wiki_node_token / space_id / obj_type /
    // original_link metadata as regular synced docs (规范 §5.3). The
    // placeholder's FetchedDocument.url is intentionally empty —
    // resolveHeaderMeta backfills original_link from SQLite (or constructs
    // it from wiki_node_token + the configured feishu host). obj_type
    // 'unknown' is omitted by generateHtmlHeader so IndexScanner falls back
    // to its default 'docx' classification rather than persisting a fake
    // type (规范 §5.3 / red line 7: 不伪造字段).
    const placeholderFetched: FetchedDocument = {
      content: '',
      images: [],
      attachments: [],
      sheets: [],
      url: '',
      obj_token: doc.objToken,
    };
    const meta = this.resolveHeaderMeta(doc, placeholderFetched);
    const header = this.generateHtmlHeader(meta);

    const body = `# 无权限文档：${doc.title}

> **权限限制**：此文档需要额外权限才能访问。请联系文档所有者或管理员获取访问权限。

## 文档信息

- **文档标题**：${doc.title}
- **对象类型**：${doc.objType}
- **对象Token**：${doc.objToken}
- **变更类型**：${doc.changeType}
- **云端修改时间**：${doc.cloudModifiedTime}
- **本地同步时间**：${currentDate}

## 下一步操作

1. 在飞书中申请该文档的访问权限
2. 获取权限后，在应用中重新同步此文档
3. 系统将自动下载完整内容并替换此占位文件

---
`;

    fs.writeFileSync(localMdPath, header + body, 'utf-8');
    console.info(`[SyncEngine] Created placeholder file: ${localMdPath}`);
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
  private async downloadUrlToFile(filepath: string, url: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`URL 下载失败 HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('URL 下载内容为空');
    }
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, buffer);
  }

  /**
   * Execute media-download command
   */
  private async execMediaDownload(filepath: string, token: string): Promise<void> {
    await this.requireLarkCliClient().downloadMedia(token, filepath);
  }

  /**
   * Execute media-preview command (fallback)
   */
  private async execMediaPreview(filepath: string, token: string): Promise<void> {
    await this.requireLarkCliClient().previewMedia(token, filepath);
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
    if (meta.objType === 'docx' || meta.objType === 'sheet' || meta.objType === 'slides') {
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
   */
  private async exportSheetsToStaging(
    sheetToken: string,
    stagingDocDir: string,
    docname: string,
  ): Promise<Array<{ sheetId: string; title: string; csvPath: string; csvRel: string }>> {
    const csvDataDir = path.join(stagingDocDir, `${docname}.csv-data`);
    fs.mkdirSync(csvDataDir, { recursive: true });

    const exports: Array<{
      sheetId: string;
      title: string;
      csvPath: string;
      csvRel: string;
    }> = [];

    const workbookInfo = await this.requireLarkCliClient().getWorkbookInfo(sheetToken);
    const sheetsList = (workbookInfo.data?.sheets || []) as Array<{
      sheet_id: string;
      sheet_name: string;
      row_count?: number;
      column_count?: number;
    }>;

    if (sheetsList.length === 0) {
      throw new Error(`workbook 无子表: ${sheetToken}`);
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

      const csvResult = await this.requireLarkCliClient().getSheetCsv({
        spreadsheetToken: sheetToken,
        sheetId: sheet.sheet_id,
        range,
      });
      const csvText = csvResult?.data?.annotated_csv ?? '';
      if (!csvText || csvText.trim().length === 0) {
        throw new Error(
          `csv-get 返回空内容: sheet="${sheet.sheet_name}" range=${range}`,
        );
      }
      fs.writeFileSync(csvPath, csvText, 'utf-8');
      exports.push({
        sheetId: sheet.sheet_id,
        title: sheet.sheet_name,
        csvPath,
        csvRel: `${docname}.csv-data/${safeTitle}.csv`,
      });
      console.info(`[SyncEngine] Staged sheet "${sheet.sheet_name}" at ${csvPath}`);
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
