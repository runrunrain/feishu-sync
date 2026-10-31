/**
 * evidence-resources — 工作簿/图片证据资源装配与发布落盘规划（A 案 §5.2/§5.4）
 *
 * D3：构建声明面（kb_write_doc 证据校验）与发布面（prepareKnowledgePublish
 * 的 evidence/ 落盘 + 发布门禁重解引用）共用本模块，保证两端对同一资源
 * 构造出逐字节一致的 EvidenceResource（quoteHash 复核才可对齐）：
 * - 工作簿：raw-source-snapshot 已纳入 contentHash 的声明 XLSX
 *   （md 头 source_workbook 标记），经 loadRawWorkbook 既有解析路径冻结
 *   为 EvidenceWorkbookResource（sheet 感知；公式文本与缓存值性质由
 *   cell().formula 区分）。
 * - 图片：快照内被引用图片（resolveSourceImages），只登记已有识图描述
 *   （described/cached 且有文本）的图片——unavailable 的图片不得充当
 *   支撑（A 案 §5.1），引用未描述图片在资源表层即被拒。
 *
 * 发布规划（planReleaseEvidenceFiles）：工作簿只保留被证据引用区间的
 * 最小充分快照（单元格值/公式/合并信息 JSON 化，附源工作簿 hash 与原始
 * 库内路径），不复制整个工作簿；图片保留本体字节 + 描述快照。超预算/
 * 落盘失败由调用方按 kb_evidence_unresolved blocking（A 案 §5.4：关键
 * 图片证据无法在体量预算内保留 → 阻止该 claim 发布，不能悄悄仅留描述）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Evidence, WorkbookCellsSelector } from './knowledge-schema.js';
import type { EvidenceImageResource, EvidenceWorkbookResource } from './evidence-locator.js';
import { loadRawWorkbook, rawCellText } from './raw-workbook.js';
import { resolveSourceImages } from './source-images.js';
import type { RawSourceSnapshotEntry } from '../types/agent-knowledge.js';
import type { ImageDescription } from '../agent/vision/vision-describer.js';

/** 资源 ID 约定（与 raw_read 资源表/`#csv:` 同族；A 案 §5.2 resourceId） */
export const WORKBOOK_RESOURCE_PREFIX = '#workbook:';
export const IMAGE_RESOURCE_PREFIX = '#image:';

export const workbookResourceId = (objToken: string, workbookName: string): string =>
  `${objToken}${WORKBOOK_RESOURCE_PREFIX}${workbookName}`;
export const imageResourceId = (objToken: string, src: string): string => `${objToken}${IMAGE_RESOURCE_PREFIX}${src}`;

/** md 头 source_workbook 标记（与 computeSourceHash/loadRawWorkbook 同识别式） */
const SOURCE_WORKBOOK_MARKER_RE = /^\s+source_workbook:\s*("[^\n]+")\s*$/m;

/** 从源 md 正文提取声明工作簿名；无标记返回 null。 */
export function declaredWorkbookName(content: string): string | null {
  const marker = SOURCE_WORKBOOK_MARKER_RE.exec(content)?.[1];
  if (!marker) return null;
  try {
    const name: unknown = JSON.parse(marker);
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

export interface WorkbookEvidencePayload {
  resource: EvidenceWorkbookResource;
  workbookName: string;
  /** xlsx 字节哈希（sha256: 前缀；与 resource.resourceHash 同值） */
  workbookBytesHash: string;
  /** 原始库内相对路径（发布 evidence/ 登记源工作簿 hash 与资源路径用） */
  sourceWorkbookPath: string;
}

/**
 * 装配声明 XLSX 的冻结资源。无声明工作簿 → null；不可读/无效 → 抛错
 * （message 面向 kb_evidence_unresolved 透出）。sheet 感知查格；合并主格
 * 键 `${sheet}!${A1}`（与 evidence-locator 约定一致）。
 */
export async function loadWorkbookEvidenceResource(
  knowledgeBaseRoot: string,
  entry: RawSourceSnapshotEntry,
  content: string,
): Promise<WorkbookEvidencePayload | null> {
  const name = declaredWorkbookName(content);
  if (!name) return null;
  // loadRawWorkbook 只读 catalog.root/entry.relPath；标记名合法性（等于
  // basename.md → .xlsx、无路径分隔）由它统一裁决，错误原样透出。
  const loaded = await loadRawWorkbook(
    { root: knowledgeBaseRoot } as Parameters<typeof loadRawWorkbook>[0],
    { relPath: entry.relPath } as Parameters<typeof loadRawWorkbook>[1],
  );
  const workbook = loaded.workbook;
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  let maxRow = 0;
  let maxCol = 0;
  const mergedAnchors = new Set<string>();
  for (const sheet of workbook.worksheets) {
    maxRow = Math.max(maxRow, sheet.rowCount);
    maxCol = Math.max(maxCol, sheet.columnCount);
    for (const range of sheet.model.merges ?? []) {
      const anchor = typeof range === 'string' ? range.split(':')[0] : null;
      if (anchor) mergedAnchors.add(`${sheet.name}!${anchor.toUpperCase()}`);
    }
  }
  const date1904 = Boolean(workbook.properties.date1904);
  const resource: EvidenceWorkbookResource = {
    kind: 'workbook',
    resourceId: workbookResourceId(entry.objToken, name),
    sourceId: entry.objToken,
    sourceSnapshotHash: entry.contentHash,
    resourceHash: `sha256:${loaded.contentHash}`,
    workbookName: name,
    sheetNames,
    usedRange: { maxRow, maxCol },
    cell: (sheet, a1) => {
      const ws = workbook.getWorksheet(sheet);
      if (!ws) return undefined;
      const cell = ws.getCell(a1);
      if (cell.value === null || cell.value === undefined) return undefined;
      return {
        value: rawCellText(cell, date1904),
        formula: typeof cell.formula === 'string' && cell.formula ? cell.formula : null,
      };
    },
    mergedAnchors,
  };
  const sourceDir = entry.relPath.includes('/') ? entry.relPath.slice(0, entry.relPath.lastIndexOf('/')) : '';
  return {
    resource,
    workbookName: name,
    workbookBytesHash: resource.resourceHash,
    sourceWorkbookPath: path.posix.join(sourceDir, name),
  };
}

export interface ImageEvidencePayload {
  resource: EvidenceImageResource;
  src: string;
  /** 图片本体字节（发布 evidence/ 保留本体，不只留描述） */
  bytes: Buffer;
}

/**
 * 装配源内被引用图片的证据资源。只登记已有描述（described/cached 且有
 * 文本）的图片：resourceHash/imageHash = sha256(图片字节)（sha256: 前缀，
 * 与 hashImageFile 同摘要）；caption = 识图描述文本（参与 quoteHash）。
 * 缺失/不可读文件与未描述图片不进资源表（引用即 kb_evidence_unresolved）。
 */
export function collectImageEvidenceResources(
  knowledgeBaseRoot: string,
  entry: RawSourceSnapshotEntry,
  content: string,
  descriptions: Map<string, ImageDescription> | undefined,
): ImageEvidencePayload[] {
  const result: ImageEvidencePayload[] = [];
  for (const image of resolveSourceImages(knowledgeBaseRoot, entry.relPath, content)) {
    const description = descriptions?.get(image.src);
    if (!description || (description.state !== 'described' && description.state !== 'cached')) continue;
    const text = (description.text ?? '').trim();
    if (!text) continue;
    let bytes: Buffer;
    try {
      // image.file 已是围栏内解析过的绝对路径（resolveSourceImages 产物）；
      // readFileSync 前不再二次拼路径，缺失/不可读则不登记该资源。
      bytes = fs.readFileSync(image.file);
    } catch {
      continue;
    }
    const imageHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    result.push({
      src: image.src,
      bytes,
      resource: {
        kind: 'image',
        resourceId: imageResourceId(entry.objToken, image.src),
        sourceId: entry.objToken,
        sourceSnapshotHash: entry.contentHash,
        resourceHash: imageHash,
        imageHash,
        caption: text,
      },
    });
  }
  return result;
}

// ============================================================================
// 发布落盘规划（A 案 §5.4/§6.2：release evidence/ 最小充分内容）
// ============================================================================

export interface WorkbookRangeSnapshot {
  sheet: string;
  rangeA1: string;
  valueNature: WorkbookCellsSelector['valueNature'];
  mergedCellAnchors: string[];
  /** 区间内逐格（含空格 value=''；读者按同一序重建 selector 片段与 quoteHash） */
  cells: Array<{ a1: string; value: string; formula: string | null }>;
}

export interface WorkbookEvidenceFileBody {
  schemaVersion: 1;
  resourceId: string;
  sourceId: string;
  sourceSnapshotHash: string;
  workbookName: string;
  /** 源工作簿字节哈希（证明资源版本；不复制整个工作簿） */
  workbookResourceHash: string;
  /** 原始库内相对路径（完整原工作簿仍在原始库） */
  sourceWorkbookPath: string;
  evidenceIds: string[];
  ranges: WorkbookRangeSnapshot[];
}

export interface ReleaseEvidenceImageMeta {
  src: string;
  imageHash: string;
  caption: string;
  describerVersion?: string;
}

/** evidence/ 内单个文件的写盘计划（bytes 为将写盘字节；hash 供登记） */
export interface ReleaseEvidenceFilePlan {
  /** release 内相对路径（evidence/ 前缀） */
  path: string;
  bytes: Buffer;
  hash: string;
  kind: 'workbook' | 'image';
  resourceId: string;
  evidenceIds: string[];
  /** 图片证据的描述快照（A 案 §5.4：审查所需图片资源及描述一并保留） */
  image?: ReleaseEvidenceImageMeta;
}

function slugOf(resourceId: string): string {
  const cleaned = resourceId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const digest = crypto.createHash('sha256').update(resourceId, 'utf8').digest('hex').slice(0, 8);
  return `${cleaned.slice(0, 72)}-${digest}`;
}

function colLetters(col: number): string {
  let name = '';
  let c = col;
  while (c > 0) { name = String.fromCharCode(65 + ((c - 1) % 26)) + name; c = Math.floor((c - 1) / 26); }
  return name;
}

function cellA1(row: number, col: number): string {
  return `${colLetters(col)}${row}`;
}

/** A1 区间展开（与 evidence-locator.parseA1Range 同语义的本地实现，纯函数） */
function expandRange(rangeA1: string): Array<{ row: number; col: number }> | null {
  const cellOf = (token: string): { row: number; col: number } | null => {
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(token.trim().toUpperCase());
    if (!match) return null;
    let col = 0;
    for (const ch of match[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { row: Number(match[2]), col };
  };
  const parts = rangeA1.trim().toUpperCase().split(':');
  const start = cellOf(parts[0] ?? '');
  const end = parts.length === 2 ? cellOf(parts[1]!) : start;
  if (!start || !end) return null;
  const cells: Array<{ row: number; col: number }> = [];
  for (let row = Math.min(start.row, end.row); row <= Math.max(start.row, end.row); row += 1) {
    for (let col = Math.min(start.col, end.col); col <= Math.max(start.col, end.col); col += 1) {
      cells.push({ row, col });
    }
  }
  return cells;
}

/**
 * 规划 release evidence/ 内容：被证据引用的工作簿区间最小快照（JSON）与
 * 图片本体（bin）。纯函数、无 IO——payload 由调用方按快照装配。返回
 * 逐文件写盘计划与总量（体量预算判定用，A 案 §5.4）。
 */
export function planReleaseEvidenceFiles(input: {
  evidence: Evidence[];
  workbookPayloads: Map<string, WorkbookEvidencePayload>;
  imagePayloads: Map<string, ImageEvidencePayload>;
}): { files: ReleaseEvidenceFilePlan[]; totalBytes: number } {
  const files: ReleaseEvidenceFilePlan[] = [];
  const workbookByResource = new Map<string, { payload: WorkbookEvidencePayload; claims: Evidence[] }>();
  const imageByResource = new Map<string, { payload: ImageEvidencePayload; claims: Evidence[] }>();
  for (const evidence of input.evidence) {
    if (evidence.selector.kind === 'workbook_cells') {
      const bucket = workbookByResource.get(evidence.sourceRef.resourceId) ?? { payload: input.workbookPayloads.get(evidence.sourceRef.resourceId)!, claims: [] };
      bucket.claims.push(evidence);
      workbookByResource.set(evidence.sourceRef.resourceId, bucket);
    } else if (evidence.selector.kind === 'media_region') {
      const bucket = imageByResource.get(evidence.sourceRef.resourceId) ?? { payload: input.imagePayloads.get(evidence.sourceRef.resourceId)!, claims: [] };
      bucket.claims.push(evidence);
      imageByResource.set(evidence.sourceRef.resourceId, bucket);
    }
  }
  for (const [resourceId, { payload, claims }] of workbookByResource) {
    if (!payload) continue;
    const resource = payload.resource;
    // 同 (sheet, rangeA1) 去重；cells 含区间内空格（value=''），读者可按
    // resolveWorkbookCells 同序重建片段与 quoteHash（最小充分内容）。
    const rangeKeys = new Set<string>();
    const ranges: WorkbookRangeSnapshot[] = [];
    for (const claim of claims) {
      const selector = claim.selector as WorkbookCellsSelector;
      const key = `${selector.sheet}\u0000${selector.rangeA1.toUpperCase()}`;
      if (rangeKeys.has(key)) continue;
      rangeKeys.add(key);
      const positions = expandRange(selector.rangeA1) ?? [];
      const cells = positions.map(({ row, col }) => {
        const a1 = cellA1(row, col);
        const cell = resource.cell(selector.sheet, a1);
        return { a1, value: cell?.value ?? '', formula: cell?.formula ?? null };
      });
      ranges.push({
        sheet: selector.sheet,
        rangeA1: selector.rangeA1.toUpperCase(),
        valueNature: selector.valueNature,
        mergedCellAnchors: [...selector.mergedCellAnchors],
        cells,
      });
    }
    ranges.sort((a, b) => (a.sheet < b.sheet ? -1 : a.sheet > b.sheet ? 1 : a.rangeA1.localeCompare(b.rangeA1)));
    const body: WorkbookEvidenceFileBody = {
      schemaVersion: 1,
      resourceId,
      sourceId: resource.sourceId,
      sourceSnapshotHash: resource.sourceSnapshotHash,
      workbookName: payload.workbookName,
      workbookResourceHash: payload.workbookBytesHash,
      sourceWorkbookPath: payload.sourceWorkbookPath,
      evidenceIds: claims.map((claim) => claim.evidenceId).sort(),
      ranges,
    };
    const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
    files.push({
      path: `evidence/workbook-${slugOf(resourceId)}.json`,
      bytes,
      hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      kind: 'workbook',
      resourceId,
      evidenceIds: [...body.evidenceIds],
    });
  }
  for (const [resourceId, { payload, claims }] of imageByResource) {
    if (!payload) continue;
    files.push({
      path: `evidence/image-${payload.resource.imageHash.replace(/^sha256:/, '').slice(0, 16)}.bin`,
      bytes: payload.bytes,
      hash: payload.resource.imageHash,
      kind: 'image',
      resourceId,
      evidenceIds: claims.map((claim) => claim.evidenceId).sort(),
      image: {
        src: payload.src,
        imageHash: payload.resource.imageHash,
        caption: payload.resource.caption ?? '',
      },
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0) };
}
