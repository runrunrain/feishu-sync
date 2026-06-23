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

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'node:path';
import fs from 'node:fs';
import type {
  ChangedDocument,
  SyncResult,
  SyncOptions,
  SyncedDocument,
  FailedDocument,
} from '../types/index.js';

const execFileAsync = promisify(execFile);

interface FetchedDocument {
  content: string;
  images: Array<{ token: string; url?: string }>;
  attachments: Array<{ token: string; name: string }>;
  sheets: Array<{ token: string; title: string }>;
  url: string;
  obj_token: string;
}

interface Image {
  token: string;
  path: string;
}

interface Attachment {
  token: string;
  path: string;
}

interface SyncEngineDeps {
  larkCliClient: any; // LarkCliClient
  localMapStore: any; // LocalMapStore
  config: any; // Config
  layoutReconstructor?: any; // Optional M3 injection
  contentAdapter?: any; // Optional M3 injection
}

export class SyncEngine {
  private localMapStore: any;
  private config: any;
  private layoutReconstructor?: any;
  private contentAdapter?: any;

  constructor(deps: SyncEngineDeps) {
    this.localMapStore = deps.localMapStore;
    this.config = deps.config;
    this.layoutReconstructor = deps.layoutReconstructor;
    this.contentAdapter = deps.contentAdapter;
  }

  /**
   * Synchronize multiple documents with error handling
   */
  async syncDocuments(
    documents: ChangedDocument[],
    options: SyncOptions
  ): Promise<SyncResult> {
    const startedAt = new Date().toISOString();
    const syncedDocuments: SyncedDocument[] = [];
    const failedDocuments: FailedDocument[] = [];

    for (const doc of documents) {
      try {
        const result = await this.syncSingleDocument(doc, options);
        syncedDocuments.push(result);
      } catch (error) {
        failedDocuments.push({
          objToken: doc.objToken,
          title: doc.title,
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
    }

    const completedAt = new Date().toISOString();
    const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    // Log sync operation
    this.localMapStore.logSync({
      success: failedDocuments.length === 0,
      syncedDocuments,
      failedDocuments,
      startedAt,
      completedAt,
      duration,
    });

    return {
      success: failedDocuments.length === 0,
      syncedDocuments,
      failedDocuments,
      startedAt,
      completedAt,
      duration,
    };
  }

  /**
   * Synchronize a single document through the complete pipeline
   */
  private async syncSingleDocument(
    doc: ChangedDocument,
    options: SyncOptions
  ): Promise<SyncedDocument> {
    // 1. Fetch document content from Feishu
    let fetched: FetchedDocument;
    let isPlaceholder = false;

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
      } else {
        throw error; // Re-throw other errors
      }
    }

    // For placeholder files, create a placeholder .md and mark in local map
    if (isPlaceholder) {
      const localMdPath = doc.localMdPath || this.generateLocalPath(doc);
      await this.writePlaceholderFile(localMdPath, doc);
      await this.updateLocalMapWithStatus(doc.objToken, localMdPath, doc.cloudModifiedTime, doc.objType, 'placeholder');
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

    // 2. Download images (three-tier fallback)
    const localMdPath = doc.localMdPath || this.generateLocalPath(doc);
    const saveDir = path.dirname(localMdPath);
    const images = await this.downloadImages(fetched, saveDir);

    // 3. Download attachments
    const attachments = await this.downloadAttachments(fetched, saveDir);

    // 4. Synced-block expansion (R3.9 / M2-B): NOT implemented.
    //    P0-Q3 实测 confirmed Feishu markdown export contains no
    //    <synced_reference> tags in this deployment, so this step is a
    //    no-op (content flows through unchanged).
    const expandedContent = fetched.content;

    // 5. Export sheets if applicable (v0.2.0: also map sub-sheets to
    //    the sheet_sheets table for finer-grained change detection)
    const sheets: Array<{ sheetId: string; title: string; csvPath: string }> = [];
    if (doc.objType === 'sheet') {
      const exportedSheets = await this.exportSheetsAndMap(doc.objToken, saveDir);
      sheets.push(...exportedSheets);
    }

    // 6. Table reconstruction (M3 - apply to exported sheets)
    let finalContent = expandedContent;
    if (this.layoutReconstructor && sheets.length > 0) {
      // Reconstruct each sheet and append to content
      const reconstructedSheets: string[] = [];
      for (const sheet of sheets) {
        try {
          const reconstructedMarkdown = await this.layoutReconstructor.reconstructToMarkdown(sheet.csvPath);
          reconstructedSheets.push(`## ${sheet.title}\n\n${reconstructedMarkdown}`);
          console.info(`[SyncEngine] Reconstructed sheet "${sheet.title}" from ${sheet.csvPath}`);
        } catch (error) {
          console.warn(`[SyncEngine] Failed to reconstruct sheet "${sheet.title}":`, error);
          // Continue with other sheets on failure
        }
      }
      // Append reconstructed sheets to content
      if (reconstructedSheets.length > 0) {
        finalContent = expandedContent + '\n\n' + reconstructedSheets.join('\n\n---\n\n');
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
              timeoutMs: 60_000,
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

    // 8. Write local markdown file
    await this.writeLocalMarkdown(localMdPath, finalContent, fetched);

    // 9. Update local mapping
    await this.updateLocalMap(doc.objToken, localMdPath, doc.cloudModifiedTime, doc.objType);

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
    const args = [
      'docs',
      '+fetch',
      '--api-version', 'v2',
      '--doc', objToken,
      '--doc-format', 'markdown',
      '--detail', 'simple',
    ];

    const result = await this.execLarkCli(args);

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
          // Tier 1: Download with curl if URL is available
          await this.execCurl(filepath, img.url);
        } else {
          // Tier 2: Use media-download if only token is available
          await this.execMediaDownload(filepath, img.token);
        }
        images.push({ token: img.token, path: filepath });
      } catch (error) {
        // Tier 3: Fallback to media-preview if media-download fails
        try {
          if (!img.url) {
            await this.execMediaPreview(filepath, img.token);
            images.push({ token: img.token, path: filepath });
          } else {
            throw error; // Re-throw if curl failed
          }
        } catch (previewError) {
          console.warn(`[SyncEngine] Failed to download image ${img.token}:`, previewError);
          // Continue with other images on failure
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

      try {
        await this.execMediaDownload(filepath, attachment.token);
        attachments.push({ token: attachment.token, path: filepath });
      } catch (error) {
        console.warn(`[SyncEngine] Failed to download attachment ${attachment.token}:`, error);
        // Continue with other attachments on failure
      }
    }

    return attachments;
  }

  /**
   * Write local markdown file with HTML comment header
   */
  private async writeLocalMarkdown(
    localMdPath: string,
    content: string,
    fetched: FetchedDocument
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

    // Generate HTML comment header
    const header = this.generateHtmlHeader(fetched);

    // Write file with header + content
    fs.writeFileSync(localMdPath, header + content, 'utf-8');
  }

  /**
   * Update local mapping in database
   */
  private async updateLocalMap(
    objToken: string,
    localMdPath: string,
    cloudModifiedTime: string,
    objType: string
  ): Promise<void> {
    await this.updateLocalMapWithStatus(objToken, localMdPath, cloudModifiedTime, objType, 'synced');
  }

  /**
   * Update local mapping with custom status (e.g., 'placeholder')
   */
  private async updateLocalMapWithStatus(
    objToken: string,
    localMdPath: string,
    cloudModifiedTime: string,
    objType: string,
    status: 'synced' | 'changed' | 'error' | 'placeholder'
  ): Promise<void> {
    this.localMapStore.upsertDocument({
      objToken,
      wikiNodeToken: null, // Will be filled if available
      objType, // Use actual objType from document
      title: path.basename(localMdPath, '.md'),
      localMdPath,
      lastSyncedModifyTime: cloudModifiedTime,
      lastSyncedAt: new Date().toISOString(),
      status,
    });
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
    const placeholderContent = `# 无权限文档：${doc.title}

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

<!--
来源: 飞书知识库（占位文件）
状态: 无权限访问 (40403)
原始链接: 需要在飞书中访问
obj_token: ${doc.objToken}
获取日期: ${currentDate}
-->
`;

    fs.writeFileSync(localMdPath, placeholderContent, 'utf-8');
    console.info(`[SyncEngine] Created placeholder file: ${localMdPath}`);
  }

  /**
   * Generate local file path from document title
   */
  private generateLocalPath(doc: ChangedDocument): string {
    const sanitizedTitle = doc.title.replace(/[<>:"/\\|?*]/g, '_');
    return path.join(this.config.knowledgeBaseRoot, `${sanitizedTitle}.md`);
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

  /**
   * Execute lark-cli command
   */
  private async execLarkCli(args: string[]): Promise<any> {
    const larkCliPath = this.config.larkCliPath || this.getDefaultLarkCliPath();
    const timeout = 30000;

    try {
      const { stdout } = await execFileAsync(larkCliPath, args, {
        timeout,
        encoding: 'utf-8',
        shell: process.platform === 'win32',
      });

      return this.parseJsonOutput(stdout);
    } catch (error: any) {
      if (error.killed && error.signal === 'SIGTERM') {
        throw new Error('lark-cli 执行超时');
      }
      throw new Error(`lark-cli 执行失败：${error.stderr || error.message}`);
    }
  }

  /**
   * Execute curl to download image
   */
  private async execCurl(filepath: string, url: string): Promise<void> {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
      exec(`curl -sSL -o "${filepath}" "${url}"`, (error: any) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /**
   * Execute media-download command
   */
  private async execMediaDownload(filepath: string, token: string): Promise<void> {
    const args = [
      'docs',
      '+media-download',
      '--token', token,
      '--output', filepath,
    ];

    await this.execLarkCli(args);
  }

  /**
   * Execute media-preview command (fallback)
   */
  private async execMediaPreview(filepath: string, token: string): Promise<void> {
    const args = [
      'docs',
      '+media-preview',
      '--token', token,
      '--output', filepath,
    ];

    await this.execLarkCli(args);
  }

  /**
   * Parse JSON output from lark-cli
   */
  private parseJsonOutput(stdout: string): any {
    // Remove BOM and ANSI codes
    const cleaned = stdout
      .replace(/^﻿/, '')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim();

    if (!cleaned.startsWith('{')) {
      return { ok: true, data: { version: cleaned } };
    }

    // Extract JSON fragment
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
      throw new Error(`解析 lark-cli 输出失败：未找到有效 JSON 结构\n原始输出：${stdout}`);
    }

    const jsonStr = cleaned.substring(firstBrace, lastBrace + 1);

    try {
      const json = JSON.parse(jsonStr);
      if ('ok' in json && json.ok === false) {
        throw new Error(`lark-cli 返回错误：${json.msg || '未知错误'}`);
      }
      return 'ok' in json ? json : { ok: true, data: json };
    } catch (error) {
      throw new Error(`解析 lark-cli 输出失败：${error instanceof Error ? error.message : String(error)}\n原始输出：${stdout}`);
    }
  }

  /**
   * Generate HTML comment header
   */
  private generateHtmlHeader(fetched: FetchedDocument): string {
    const currentDate = new Date().toISOString().split('T')[0];

    return `<!--
来源: 飞书知识库
节点: ${path.basename(fetched.url).split('/').pop() || 'unknown'}
原始链接: ${fetched.url}
obj_token: ${fetched.obj_token}
获取日期: ${currentDate}
-->

`;
  }

  /**
   * Get default lark-cli executable path
   */
  private getDefaultLarkCliPath(): string {
    if (process.platform === 'win32') {
      return 'lark-cli.cmd';
    }
    return 'lark-cli';
  }

  /**
   * Export spreadsheet sub-sheets to CSV files AND map each sub-sheet to
   * the sheet_sheets table (03 §3.5). Workbook-level obj_edit_time is
   * shared across all sub-sheets on the Feishu side, so per-sub-sheet
   * change detection is performed by ChangeDetector.detectSheetSubChanges
   * via set differences against this mapping.
   *
   * The local CSV directory follows the existing project convention of
   * a single `csv-data/` directory under the doc save dir (NOT the
   * `<docname>.csv-data/` form mandated by the fetch-feishu-doc skill).
   * Q6 (白泽调研) flagged this as pre-existing tech debt — correcting it
   * would force a mass path migration and is out of P2 scope; we
   * preserve the existing layout and record the deviation in the
   * implementation report.
   *
   * Sub-sheet rows are upserted with COALESCE on local_md_path so a
   * later reconstruction pass can fill in the per-sub-sheet .md path
   * without this method needing to know about reconstruction.
   */
  private async exportSheetsAndMap(
    sheetToken: string,
    saveDir: string
  ): Promise<Array<{ sheetId: string; title: string; csvPath: string }>> {
    const csvDataDir = path.join(saveDir, 'csv-data');

    // Create csv-data directory if it doesn't exist
    if (!fs.existsSync(csvDataDir)) {
      fs.mkdirSync(csvDataDir, { recursive: true });
    }

    const exports: Array<{ sheetId: string; title: string; csvPath: string }> = [];

    try {
      // 1. List all sub-sheets in the workbook
      const workbookInfo = await this.execLarkCli([
        'sheets',
        '+workbook-info',
        '--spreadsheet-token', sheetToken,
        '--format', 'json',
      ]);

      const sheetsList = (workbookInfo.data?.sheets || []) as Array<{
        sheet_id: string;
        sheet_name: string;
        index?: number;
      }>;

      const nowIso = new Date().toISOString();

      // 2. Export each sub-sheet to CSV + upsert sheet_sheets row
      for (const sheet of sheetsList) {
        const csvPath = path.join(csvDataDir, `${sheet.sheet_name}.csv`);

        try {
          await this.execLarkCli([
            'sheets',
            '+workbook-export',
            '--spreadsheet-token', sheetToken,
            '--file-extension', 'csv',
            '--sheet-id', sheet.sheet_id,
            '--output-path', csvPath,
          ]);

          exports.push({
            sheetId: sheet.sheet_id,
            title: sheet.sheet_name,
            csvPath,
          });

          // Map this sub-sheet to the sheet_sheets table for future
          // change detection (detectSheetSubChanges reads this).
          this.localMapStore.upsertSheetSheet({
            sheetObjToken: sheetToken,
            sheetId: sheet.sheet_id,
            sheetTitle: sheet.sheet_name,
            localCsvPath: csvPath,
            lastSyncedModifyTime: nowIso,
            status: 'synced',
          });

          console.info(`[SyncEngine] Exported sheet "${sheet.sheet_name}" to ${csvPath}`);
        } catch (error) {
          console.warn(`[SyncEngine] Failed to export sheet "${sheet.sheet_name}":`, error);
          // Continue with other sheets on failure
        }
      }
    } catch (error) {
      console.error(`[SyncEngine] Failed to list sheets for ${sheetToken}:`, error);
      throw error;
    }

    return exports;
  }
}