/**
 * Custom-folder docx sync helper.
 *
 * Single-purpose composition of the public fetch + atomic-commit pipeline for
 * the quick-add flow: a docx fetched from an arbitrary Feishu link is written
 * into a custom-folder directory under the knowledge base.
 *
 * It deliberately reuses the same building blocks as SyncEngine's docx and
 * sheet paths (lark-cli fetch / workbook-info + csv-get, media-reference
 * extraction/rewrite, LayoutReconstructor reconstruction, DocumentIR
 * rendering and the staging->atomic-rename coordinator in content-commit.ts)
 * instead of duplicating that logic. SyncEngine's own pipeline is bound to
 * the watched-root / manifest planner and is not reusable for ad-hoc single
 * links without dragging in unrelated structure-tree machinery.
 *
 * Slides remains intentionally out of scope: its export requires the
 * slides-XML presentation adapter that the custom-folder flow does not own.
 * The route returns unsupported_type for it instead of degrading to a
 * metadata placeholder.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  commitDocumentContent,
} from './content-commit.js';
import type { AtomicCommitPlan } from './atomic-commit.js';
import { LayoutReconstructor } from './layout-reconstructor.js';
import {
  resolveOperationDirectory,
} from './operation-manifest.js';
import {
  toPortableRelative,
} from './path-resolver.js';
import {
  extractFeishuMediaReferences,
  rewriteFeishuMediaReferences,
  type MediaReference,
} from './media-reference.js';
import {
  annotateCsvWithImages,
  downloadSheetMedia,
  probeSheetFloatImages,
  renderSheetMediaAppendix,
  type SheetMediaItem,
} from './sheet-media.js';
import type { DocumentIR } from './document-ir.js';
import { LarkCliError } from './lark-cli-client.js';

export interface SyncDocxToCustomFolderInput {
  /** LarkCliClient instance (public methods only). */
  larkCliClient: {
    fetchDocumentMarkdown(objToken: string): Promise<any>;
    downloadMedia(token: string, outputPath: string, type: 'media' | 'whiteboard'): Promise<string>;
    previewMedia(token: string, outputPath: string): Promise<string>;
  };
  knowledgeBaseRoot: string;
  /** Optional operation staging root override; defaults to ~/.feishu-sync/operations. */
  operationDirectory?: string;
  /** Absolute final markdown path inside the knowledge base. */
  localMdPath: string;
  objToken: string;
  wikiNodeToken: string | null;
  title: string;
  originalLink: string | null;
  objEditTime: number | null;
  spaceId: string | null;
  /**
   * Optional pre-fetched markdown for the pure cloud-doc fallback path: the
   * route already invoked fetchDocumentMarkdown once to resolve the title, so
   * passing it here avoids a redundant docs+fetch round-trip. Omit (the
   * wiki-link path) to let this helper fetch itself.
   */
  prefetchedDocument?: { content: string; url?: string | null };
}

export interface SyncDocxResult {
  localMdPath: string;
  localRelPath: string;
  imagesCount: number;
  attachmentsCount: number;
  /**
   * Absolute paths of every file this call committed into the knowledge base
   * (the markdown body plus each staged media/attachment). Callers that write
   * a SQLite mapping row after the commit can roll these back if the DB write
   * fails, keeping the corpus and the mapping in lockstep.
   */
  committedFiles: string[];
  /**
   * The atomic-commit plan used for this archive, carrying per-file rollback
   * snapshots. Callers that write the SQLite mapping row after the commit pass
   * this to rollbackAtomicPlan() on a DB failure so shared media files
   * (images/attachments) overwritten by this commit are restored to their
   * prior bytes instead of being blind-deleted.
   */
  commitPlan: AtomicCommitPlan;
}

export interface SyncSheetToCustomFolderInput {
  /** LarkCliClient instance (public methods only). */
  larkCliClient: {
    getWorkbookInfo(spreadsheetToken: string): Promise<any>;
    getSheetCsv(options: {
      spreadsheetToken: string;
      sheetId: string;
      range: string;
    }): Promise<any>;
    /** Optional: float-image probing; older clients / test doubles without
     * it simply skip sheet-image enrichment (probeSheetFloatImages guards). */
    getSheetFloatImages?(options: {
      spreadsheetToken: string;
      sheetId: string;
    }): Promise<any>;
    /** Used by sheet float-image three-tier download. */
    downloadMedia(token: string, outputPath: string, type?: 'media' | 'whiteboard'): Promise<string>;
    previewMedia(token: string, outputPath: string): Promise<string>;
  };
  knowledgeBaseRoot: string;
  /** Optional operation staging root override; defaults to ~/.feishu-sync/operations. */
  operationDirectory?: string;
  /** Absolute final markdown path inside the knowledge base. */
  localMdPath: string;
  objToken: string;
  wikiNodeToken: string | null;
  title: string;
  originalLink: string | null;
  objEditTime: number | null;
  spaceId: string | null;
  /** Optional LayoutReconstructor override (tests); defaults to a fresh instance. */
  layoutReconstructor?: { reconstructToMarkdown(csvPath: string): Promise<string> };
}

export interface SyncSheetResult {
  localMdPath: string;
  localRelPath: string;
  sheetsCount: number;
  /** Float images downloaded and committed alongside the CSV data. */
  imagesCount: number;
  /** See SyncDocxResult.committedFiles. */
  committedFiles: string[];
  /** See SyncDocxResult.commitPlan. */
  commitPlan: AtomicCommitPlan;
}

interface DownloadedMedia {
  token: string;
  kind: 'image' | 'whiteboard';
  absolutePath: string;
  /** POSIX path relative to the markdown file's directory, e.g. images/01.png */
  relativeToDocDir: string;
}

interface DownloadedAttachment {
  token: string;
  name: string;
  absolutePath: string;
  relativeToDocDir: string;
}

/**
 * Fetch a docx, download its media into a temp staging area, then commit the
 * rendered markdown + resources atomically into the knowledge base.
 *
 * Throws LarkCliError for Feishu-side failures (permission/deleted/upstream)
 * so the caller can classify them; other errors are wrapped as fetch_failed.
 */
export async function syncDocxToCustomFolder(
  input: SyncDocxToCustomFolderInput,
): Promise<SyncDocxResult> {
  const root = path.resolve(input.knowledgeBaseRoot);
  const relativeMd =
    toPortableRelative(root, input.localMdPath) ?? path.basename(input.localMdPath);
  const docDirRel = relativeMd.includes('/')
    ? relativeMd.slice(0, relativeMd.lastIndexOf('/'))
    : '';

  // 1. Fetch markdown body, or reuse a caller-provided result (the pure
  // cloud-doc fallback already fetched once to resolve the title).
  let result: any;
  if (input.prefetchedDocument) {
    result = {
      data: {
        document: {
          content: input.prefetchedDocument.content,
          url: input.prefetchedDocument.url ?? null,
        },
      },
    };
  } else {
    result = await input.larkCliClient.fetchDocumentMarkdown(input.objToken);
  }
  const document = result?.data?.document ?? {};
  const content = typeof document.content === 'string' ? document.content : '';
  const fetchedUrl = typeof document.url === 'string' && document.url.trim()
    ? document.url.trim()
    : null;

  // 2. Extract media references and download into a temp dir (never the KB).
  const references = extractFeishuMediaReferences(content);
  const mediaTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-custom-doc-'));
  try {
    const images = await downloadMediaReferences(
      input.larkCliClient,
      references.filter((r) => r.kind === 'image' || r.kind === 'whiteboard'),
      mediaTemp,
    );
    const attachments = await downloadAttachments(
      input.larkCliClient,
      references.filter((r) => r.kind === 'attachment'),
      mediaTemp,
    );

    // 3. Rewrite media spans to local relative paths.
    const localMediaReferences = new Map<string, string>();
    for (const image of images) localMediaReferences.set(image.token, image.relativeToDocDir);
    for (const attachment of attachments) {
      localMediaReferences.set(attachment.token, attachment.relativeToDocDir);
    }
    const bodyMarkdown = rewriteFeishuMediaReferences(content, localMediaReferences);

    // 4. Build DocumentIR + extraFiles and commit atomically.
    const ir: DocumentIR = {
      objToken: input.objToken,
      wikiNodeToken: input.wikiNodeToken,
      spaceId: input.spaceId,
      objType: 'docx',
      title: input.title,
      originalLink: input.originalLink ?? fetchedUrl,
      observedObjEditTime: input.objEditTime,
      bodyMarkdown,
      images: images.map((image) => ({
        relativePath: image.relativeToDocDir,
        token: image.token,
      })),
      attachments: attachments.map((attachment) => ({
        relativePath: attachment.relativeToDocDir,
        name: attachment.name,
        token: attachment.token,
      })),
      sheets: [],
    };

    const extraFiles: Array<{ relativePath: string; absoluteSource: string }> = [];
    for (const image of images) {
      extraFiles.push({
        relativePath: docDirRel
          ? `${docDirRel}/${image.relativeToDocDir}`
          : image.relativeToDocDir,
        absoluteSource: image.absolutePath,
      });
    }
    for (const attachment of attachments) {
      extraFiles.push({
        relativePath: docDirRel
          ? `${docDirRel}/${attachment.relativeToDocDir}`
          : attachment.relativeToDocDir,
        absoluteSource: attachment.absolutePath,
      });
    }

    const operationDirectory = resolveOperationDirectory(
      root,
      input.operationDirectory,
    );
    const operationId = `custom-${input.objToken.slice(0, 12)}-${Date.now()}`;

    const commit = commitDocumentContent({
      operationId,
      knowledgeBaseRoot: root,
      operationDirectory,
      localMdPath: input.localMdPath,
      ir,
      extraFiles,
    });
    if (!commit.ok) {
      throw new Error(commit.error || '自定义归档文档写入失败');
    }

    // Absolute paths of everything this commit wrote, so the caller can roll
    // them back if the subsequent DB write fails (file commit and mapping
    // write must stay atomic from the corpus's point of view).
    const committedFiles: string[] = [input.localMdPath];
    for (const extra of extraFiles) {
      committedFiles.push(path.join(root, ...extra.relativePath.split('/')));
    }

    return {
      localMdPath: input.localMdPath,
      localRelPath: relativeMd,
      imagesCount: images.length,
      attachmentsCount: attachments.length,
      committedFiles,
      commitPlan: commit.plan,
    };
  } finally {
    // Best-effort cleanup of the temp media dir; committed files live in the KB.
    try {
      fs.rmSync(mediaTemp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Export every sub-sheet of a spreadsheet (workbook-info + csv-get) into a
 * temp staging area, reconstruct each CSV into markdown via
 * LayoutReconstructor, then commit the rendered markdown + csv-data files
 * atomically into the knowledge base.
 *
 * Mirrors SyncEngine's sheet path (exportSheetsToStaging + step-6
 * reconstruction): docs+fetch is docx-only (lark-cli code 3380002 rejects
 * sheets), the body is synthesized from per-sub-sheet CSVs and any sub-sheet
 * failure aborts the whole document so a partial archive never lands.
 *
 * Throws LarkCliError for Feishu-side failures (permission/deleted/upstream)
 * so the caller can classify them; other errors map to fetch_failed.
 */
export async function syncSheetToCustomFolder(
  input: SyncSheetToCustomFolderInput,
): Promise<SyncSheetResult> {
  const root = path.resolve(input.knowledgeBaseRoot);
  const relativeMd =
    toPortableRelative(root, input.localMdPath) ?? path.basename(input.localMdPath);
  const docname = path.basename(input.localMdPath, '.md');
  const docDirRel = relativeMd.includes('/')
    ? relativeMd.slice(0, relativeMd.lastIndexOf('/'))
    : '';

  // 1. List the workbook's sub-sheets. An empty workbook cannot produce a
  // body, so refuse instead of writing a metadata-only placeholder.
  const workbookInfo = await input.larkCliClient.getWorkbookInfo(input.objToken);
  const sheetsList = (workbookInfo?.data?.sheets || []) as Array<{
    sheet_id: string;
    sheet_name: string;
    row_count?: number;
    column_count?: number;
  }>;
  if (sheetsList.length === 0) {
    throw new Error(`workbook 无子表: ${input.objToken}`);
  }

  // 2. Export every sub-sheet CSV into a temp dir (never the KB). The
  // committed files are staged later from ir.sheets[].csvContent.
  const csvTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-custom-sheet-'));
  try {
    const csvDataDir = path.join(csvTemp, `${docname}.csv-data`);
    fs.mkdirSync(csvDataDir, { recursive: true });

    const exported: Array<{
      sheetId: string;
      title: string;
      csvPath: string;
      csvRel: string;
      images: SheetMediaItem[];
    }> = [];
    for (const sheet of sheetsList) {
      const safeTitle = sheet.sheet_name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
      const csvPath = path.join(csvDataDir, `${safeTitle}.csv`);
      const rows = sheet.row_count ?? 200;
      const cols = sheet.column_count ?? 20;
      const range = `A1:${colToLetter(cols)}${rows}`;

      const csvResult = await input.larkCliClient.getSheetCsv({
        spreadsheetToken: input.objToken,
        sheetId: sheet.sheet_id,
        range,
      });
      const csvText = csvResult?.data?.annotated_csv ?? '';
      if (!csvText || csvText.trim().length === 0) {
        throw new Error(
          `csv-get 返回空内容: sheet="${sheet.sheet_name}" range=${range}`,
        );
      }

      // Float-image enrichment mirrors SyncEngine's sheet path: probe
      // metadata (soft-fail), three-tier download into the temp images/ dir,
      // then inject local references into the CSV cells.
      const floatImages = await probeSheetFloatImages(input.larkCliClient, {
        spreadsheetToken: input.objToken,
        sheetId: sheet.sheet_id,
        sheetTitle: sheet.sheet_name,
      });
      const sheetImages = floatImages.length > 0
        ? await downloadSheetMedia({
            client: input.larkCliClient,
            floatImages,
            imagesDir: path.join(csvTemp, 'images'),
            subSheetTitle: sheet.sheet_name,
          })
        : [];

      fs.writeFileSync(csvPath, annotateCsvWithImages(csvText, sheetImages), 'utf-8');
      exported.push({
        sheetId: sheet.sheet_id,
        title: sheet.sheet_name,
        csvPath,
        csvRel: `${docname}.csv-data/${safeTitle}.csv`,
        images: sheetImages,
      });
    }

    // 3. Reconstruct every sub-sheet into markdown (same section format as
    // SyncEngine step 6: header + CSV link + reconstructed body, joined by
    // horizontal rules).
    const reconstructor = input.layoutReconstructor ?? new LayoutReconstructor();
    const sections: string[] = [];
    for (const sheet of exported) {
      const reconstructed = await reconstructor.reconstructToMarkdown(sheet.csvPath);
      let section = `## 子表: ${sheet.title}\n\n[CSV 原始数据](${sheet.csvRel})\n\n${reconstructed}`;
      if (sheet.images.length > 0) {
        section += `\n\n${renderSheetMediaAppendix(sheet.title, sheet.images)}`;
      }
      sections.push(section);
    }
    const bodyMarkdown = sections.join('\n\n---\n\n');

    // 4. Build the DocumentIR and commit atomically. content-commit stages
    // each ir.sheets[].csvContent itself; float images ride the extraFiles
    // channel (same as docx media) so the atomic commit covers them.
    const sheetMediaImages = exported.flatMap((sheet) => sheet.images);
    const ir: DocumentIR = {
      objToken: input.objToken,
      wikiNodeToken: input.wikiNodeToken,
      spaceId: input.spaceId,
      objType: 'sheet',
      title: input.title,
      originalLink: input.originalLink,
      observedObjEditTime: input.objEditTime,
      bodyMarkdown,
      images: sheetMediaImages.map((image) => ({
        relativePath: image.localRelPath,
        token: image.token,
      })),
      attachments: [],
      sheets: exported.map((sheet) => ({
        sheetId: sheet.sheetId,
        title: sheet.title,
        csvRelativePath: sheet.csvRel,
        csvContent: fs.readFileSync(sheet.csvPath, 'utf-8'),
      })),
    };

    const extraFiles: Array<{ relativePath: string; absoluteSource: string }> = [];
    for (const image of sheetMediaImages) {
      extraFiles.push({
        relativePath: docDirRel
          ? `${docDirRel}/${image.localRelPath}`
          : image.localRelPath,
        absoluteSource: image.localPath,
      });
    }

    const operationDirectory = resolveOperationDirectory(
      root,
      input.operationDirectory,
    );
    const operationId = `custom-${input.objToken.slice(0, 12)}-${Date.now()}`;

    const commit = commitDocumentContent({
      operationId,
      knowledgeBaseRoot: root,
      operationDirectory,
      localMdPath: input.localMdPath,
      ir,
      extraFiles,
    });
    if (!commit.ok) {
      throw new Error(commit.error || '自定义归档表格写入失败');
    }

    const committedFiles: string[] = [input.localMdPath];
    for (const sheet of exported) {
      committedFiles.push(path.join(path.dirname(input.localMdPath), ...sheet.csvRel.split('/')));
    }
    for (const image of sheetMediaImages) {
      committedFiles.push(
        path.join(path.dirname(input.localMdPath), ...image.localRelPath.split('/')),
      );
    }

    return {
      localMdPath: input.localMdPath,
      localRelPath: relativeMd,
      sheetsCount: exported.length,
      imagesCount: sheetMediaImages.length,
      committedFiles,
      commitPlan: commit.plan,
    };
  } finally {
    // Best-effort cleanup of the temp csv dir; committed files live in the KB.
    try {
      fs.rmSync(csvTemp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Column number (1-based) to Excel column letter (A, Z, AA, AZ, BE...).
 * Local copy of SyncEngine's csv-get range helper: custom-doc-sync keeps
 * module independence from the engine (see file header) and the function is
 * a 10-line pure utility.
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

/**
 * Download image/whiteboard tokens into tempDir. Mirrors SyncEngine's
 * transport policy: media-download first, media-preview fallback for plain
 * images; whiteboards are download-only (preview does not support them).
 */
async function downloadMediaReferences(
  client: SyncDocxToCustomFolderInput['larkCliClient'],
  refs: MediaReference[],
  tempDir: string,
): Promise<DownloadedMedia[]> {
  const out: DownloadedMedia[] = [];
  const imagesDir = path.join(tempDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  let index = 0;
  for (const ref of refs) {
    if (ref.kind !== 'image' && ref.kind !== 'whiteboard') continue;
    const stem = path.join(imagesDir, `${String(index + 1).padStart(2, '0')}-${ref.token}`);
    let absolutePath: string | null = null;
    try {
      // LarkCliClient.downloadMedia signature is (token, outputPath, type).
      // Passing them reversed silently downloaded into a wrong location.
      absolutePath = await client.downloadMedia(
        ref.token,
        stem,
        ref.kind === 'whiteboard' ? 'whiteboard' : 'media',
      );
    } catch (downloadError) {
      if (ref.kind === 'whiteboard') throw downloadError;
      try {
        absolutePath = await client.previewMedia(ref.token, stem);
      } catch {
        throw downloadError;
      }
    }
    assertDownloaded(absolutePath, ref.token);
    out.push({
      token: ref.token,
      kind: ref.kind,
      absolutePath,
      relativeToDocDir: `images/${path.basename(absolutePath)}`,
    });
    index += 1;
  }
  return out;
}

async function downloadAttachments(
  client: SyncDocxToCustomFolderInput['larkCliClient'],
  refs: MediaReference[],
  tempDir: string,
): Promise<DownloadedAttachment[]> {
  const out: DownloadedAttachment[] = [];
  const attachmentsDir = path.join(tempDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });

  let index = 0;
  for (const ref of refs) {
    if (ref.kind !== 'attachment') continue;
    const stem = path.join(attachmentsDir, `${String(index + 1).padStart(2, '0')}-${ref.token}`);
    let absolutePath: string;
    try {
      absolutePath = await client.downloadMedia(ref.token, stem, 'media');
    } catch {
      absolutePath = await client.previewMedia(ref.token, stem);
    }
    assertDownloaded(absolutePath, ref.token);
    out.push({
      token: ref.token,
      name: ref.filename || ref.token,
      absolutePath,
      relativeToDocDir: `attachments/${path.basename(absolutePath)}`,
    });
    index += 1;
  }
  return out;
}

function assertDownloaded(absolutePath: string, token: string): void {
  if (
    !absolutePath ||
    !fs.existsSync(absolutePath) ||
    !fs.statSync(absolutePath).isFile() ||
    fs.statSync(absolutePath).size <= 0
  ) {
    throw new LarkCliError(`媒体下载失败或为空: ${token}`, 'upstream', true);
  }
}
