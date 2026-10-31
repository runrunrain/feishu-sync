/**
 * evidence-locator — 证据 selector 解引用与复核（A 案 §5.2/§5.3）
 *
 * 纯逻辑、无 IO：资源内容（正文/CSV 文本、工作簿单元格快照、图片旁路
 * 信息）全部由调用方传入。构建侧（agent-tool-service kb_write_doc 声明
 * 校验）与后续发布门禁共用本模块做「服务端重新解引用校验」：
 * - sourceRef hash 对账（sourceSnapshotHash / resourceHash）；
 * - readReceiptId 存在且 selector 落在回执返回范围（伪造回执拒绝）；
 * - quoteHash 匹配（复核局部命中）。
 *
 * hash 约定：quoteHash = `sha256:` + sha256(规范化片段)（LF 归一、闭合
 * 行区间精确切片，不做 trim——定位证据必须逐字）。
 */

import { createHash } from 'node:crypto';

// ============================================================================
// 资源模型（调用方装配；evidence-locator 不读盘）
// ============================================================================

export interface EvidenceResourceBase {
  /** 与 Evidence.sourceRef.resourceId 对应（主文档=objToken；CSV=<objToken>#csv:<basename>） */
  resourceId: string;
  /** 所属源 objToken（与 sourceRef.sourceId 对账） */
  sourceId: string;
  /** computeSourceHash 结果（与 sourceRef.sourceSnapshotHash 对账） */
  sourceSnapshotHash: string;
  /** 该资源字节哈希（与 sourceRef.resourceHash 对账；用途不同不相互替代，A 案 §5.2） */
  resourceHash: string;
}

/** 正文资源（原始 md 正文；LF 归一后按 1 起始行列定位） */
export interface EvidenceTextResource extends EvidenceResourceBase {
  kind: 'text';
  content: string;
}

/** CSV 附件资源：1 起始逻辑 record 行（RFC4180 引号内换行不等于新记录） */
export interface EvidenceCsvResource extends EvidenceResourceBase {
  kind: 'csv';
  content: string;
  /** 资源路径标注（与 CsvCellsSelector.resourcePath 对账；可缺省跳过） */
  path?: string;
  parserVersion?: string;
}

/** 工作簿资源：冻结解析快照（消费 raw-workbook.ts 既有解析；此处无 IO）。
 * D3（A 案 §5.2）：cell/mergedAnchors 均 sheet 感知——多 sheet 工作簿里
 * 同名 A1 跨 sheet 歧义，未带 sheet 的查格会把 Sheet1 的值冒充 Sheet2
 * 证据；mergedAnchors 键为 `${sheet}!${A1}`（A1 大写）。usedRange 为全簿
 * 上界（各 sheet 维度最大值）：越出它的区间必拒绝；落在上界内但超出
 * 该 sheet 实际维度的格子按空值解（`A1=`），由 quoteHash 保持两端一致。 */
export interface EvidenceWorkbookResource extends EvidenceResourceBase {
  kind: 'workbook';
  workbookName: string;
  sheetNames: string[];
  /** 已用区域上界（1 起始；A1 区间越界拒绝） */
  usedRange: { maxRow: number; maxCol: number };
  /** sheet + A1 → 单元格快照；公式文本与缓存值性质由此区分 */
  cell: (sheet: string, a1: string) => { value: string; formula: string | null } | undefined;
  /** 实际合并主格集合（`${sheet}!${A1}`；提供时校验 selector.mergedCellAnchors） */
  mergedAnchors?: ReadonlySet<string>;
}

/** 图片/旁路资源：imageHash 校验；描述只能 machine_description（A 案 §5.2） */
export interface EvidenceImageResource extends EvidenceResourceBase {
  kind: 'image';
  imageHash: string;
  /** 旁路文字/描述（参与 quoteHash） */
  caption?: string;
  describerVersion?: string;
}

export type EvidenceResource =
  | EvidenceTextResource
  | EvidenceCsvResource
  | EvidenceWorkbookResource
  | EvidenceImageResource;

/** 读取回执（read-receipts.jsonl 的解引用面；selector 为资源本地行区间） */
export interface EvidenceReadReceipt {
  readReceiptId: string;
  resourceId: string;
  /** 资源本地 1 起始闭区间（返回窗口交叠该资源的部分） */
  lineStart: number;
  lineEnd: number;
}

// ============================================================================
// 结果类型（结构化失败原因，不抛异常）
// ============================================================================

export interface SelectorResolution {
  ok: true;
  /** 解出的片段文本（工作簿/图片为构造文本） */
  fragment: string;
  /** 规范化片段 hash（sha256: 前缀） */
  quoteHash: string;
}

export interface SelectorResolutionFailure {
  ok: false;
  code: string;
  message: string;
}

/** quoteHash 规范：LF 归一后的精确片段 sha256 hex（`sha256:` 前缀）。 */
export function computeQuoteHash(fragment: string): string {
  return `sha256:${createHash('sha256').update(fragment.split('\r\n').join('\n'), 'utf8').digest('hex')}`;
}

function resourceHashOf(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

// ============================================================================
// CSV 逻辑 record 解析（RFC4180：引号内换行不等于新记录）
// ============================================================================

export interface CsvParseResult {
  /** 逻辑 record（字段已去引号/反转义） */
  records: string[][];
  /** 每个 record 首行所在的物理行号（1 起始）与占用的物理行数 */
  recordSpans: Array<{ startLine: number; lineCount: number }>;
}

/** 极简 RFC4180 解析器：双引号转义（""→"）；行分隔 LF（CRLF 归一为 LF）。 */
export function parseCsvRecords(content: string): CsvParseResult {
  const text = content.replace(/\r\n/g, '\n');
  const records: string[][] = [];
  const recordSpans: Array<{ startLine: number; lineCount: number }> = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let startLine = 1;
  let line = 1;
  let sawAny = false;
  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    recordSpans.push({ startLine, lineCount: line - startLine + 1 });
    record = [];
    sawAny = false;
    startLine = line + 1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      sawAny = true;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      sawAny = true;
      continue;
    }
    if (ch === ',') { endField(); sawAny = true; continue; }
    if (ch === '\n') {
      if (record.length > 0 || field !== '' || sawAny) endRecord();
      else { startLine = line + 1; }
      line += 1;
      continue;
    }
    field += ch;
    sawAny = true;
  }
  if (record.length > 0 || field !== '' || sawAny) {
    endRecord();
  }
  return { records, recordSpans };
}

// ============================================================================
// A1 解析（WorkbookCells）
// ============================================================================

export interface A1Range { startRow: number; startCol: number; endRow: number; endCol: number }

const A1_CELL_RE = /^([A-Z]+)([1-9][0-9]*)$/;

export function parseA1Cell(a1: string): { row: number; col: number } | null {
  const match = A1_CELL_RE.exec(a1.trim().toUpperCase());
  if (!match) return null;
  let col = 0;
  for (const ch of match[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]), col };
}

export function parseA1Range(rangeA1: string): A1Range | null {
  const parts = rangeA1.trim().toUpperCase().split(':');
  if (parts.length === 1) {
    const cell = parseA1Cell(parts[0]!);
    if (!cell) return null;
    return { startRow: cell.row, startCol: cell.col, endRow: cell.row, endCol: cell.col };
  }
  if (parts.length !== 2) return null;
  const start = parseA1Cell(parts[0]!);
  const end = parseA1Cell(parts[1]!);
  if (!start || !end) return null;
  return {
    startRow: Math.min(start.row, end.row), startCol: Math.min(start.col, end.col),
    endRow: Math.max(start.row, end.row), endCol: Math.max(start.col, end.col),
  };
}

function colLetters(col: number): string {
  let name = '';
  let c = col;
  while (c > 0) { name = String.fromCharCode(65 + ((c - 1) % 26)) + name; c = Math.floor((c - 1) / 26); }
  return name;
}

// ============================================================================
// resolveSelector（A 案 §5.2 定位规范）
// ============================================================================

import type {
  CsvCellsSelector,
  EvidenceSelector,
  MediaRegionSelector,
  TextSpanSelector,
  WorkbookCellsSelector,
} from './knowledge-schema.js';

/**
 * TextSpan：LF 归一行/列闭区间 → 文本片段。colEnd<=0 表示取到行尾；
 * 重复片段靠 headingPath/contextHash 消歧（此处只解引用，消歧由声明方
 * 提供并由审查判断）。
 */
function resolveTextSpan(content: string, selector: TextSpanSelector): SelectorResolution | SelectorResolutionFailure {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (selector.lineStart < 1 || selector.lineEnd < selector.lineStart) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `TextSpan 行区间非法: ${selector.lineStart}..${selector.lineEnd}` };
  }
  if (selector.lineEnd > lines.length) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `TextSpan 越界: ${selector.lineEnd} > 资源总行数 ${lines.length}` };
  }
  if (selector.colStart < 1) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `TextSpan colStart 必须 ≥1（当前 ${selector.colStart}）` };
  }
  const picked: string[] = [];
  for (let lineNo = selector.lineStart; lineNo <= selector.lineEnd; lineNo += 1) {
    const text = lines[lineNo - 1]!;
    const end = selector.colEnd > 0 ? selector.colEnd : text.length;
    if (selector.colStart > text.length + 1) {
      return { ok: false, code: 'kb_evidence_unresolved', message: `TextSpan 列越界: 第 ${lineNo} 行长 ${text.length} < colStart ${selector.colStart}` };
    }
    picked.push(text.slice(selector.colStart - 1, end));
  }
  const fragment = picked.join('\n');
  return { ok: true, fragment, quoteHash: computeQuoteHash(fragment) };
}

/**
 * CsvCells：1 起始逻辑 record 行 + 列名（取自首 record 表头）→ 单元格值。
 * CSV 引号内换行不等于新记录（parseCsvRecords）；文本显示行号不能冒充
 * 逻辑 record 行号。
 */
function resolveCsvCells(resource: EvidenceCsvResource, selector: CsvCellsSelector): SelectorResolution | SelectorResolutionFailure {
  if (resource.path && selector.resourcePath && resource.path !== selector.resourcePath) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `CsvCells 资源路径不符: ${selector.resourcePath} ≠ ${resource.path}` };
  }
  const { records } = parseCsvRecords(resource.content);
  if (records.length === 0) {
    return { ok: false, code: 'kb_evidence_unresolved', message: 'CSV 资源为空' };
  }
  if (selector.recordStart < 1 || selector.recordEnd < selector.recordStart) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `CsvCells record 区间非法: ${selector.recordStart}..${selector.recordEnd}` };
  }
  if (selector.recordEnd > records.length) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `CsvCells record 越界: ${selector.recordEnd} > ${records.length}` };
  }
  const header = records[0]!;
  const colIndexes: number[] = [];
  for (const column of selector.columns) {
    const index = header.indexOf(column);
    if (index < 0) {
      return { ok: false, code: 'kb_evidence_unresolved', message: `CsvCells 列不存在: ${column}（表头 ${header.join(',')}）` };
    }
    colIndexes.push(index);
  }
  const rows: string[] = [];
  for (let recordNo = selector.recordStart; recordNo <= selector.recordEnd; recordNo += 1) {
    const record = records[recordNo - 1]!;
    rows.push(colIndexes.map((index) => record[index] ?? '').join(','));
  }
  const fragment = rows.join('\n');
  return { ok: true, fragment, quoteHash: computeQuoteHash(fragment) };
}

/** WorkbookCells：sheet + A1 区间 + 合并主格 + 公式/缓存值性质。 */
function resolveWorkbookCells(resource: EvidenceWorkbookResource, selector: WorkbookCellsSelector): SelectorResolution | SelectorResolutionFailure {
  if (selector.workbookName !== resource.workbookName) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `WorkbookCells 工作簿名不符: ${selector.workbookName} ≠ ${resource.workbookName}` };
  }
  if (!resource.sheetNames.includes(selector.sheet)) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `WorkbookCells sheet 不存在: ${selector.sheet}（可用 ${resource.sheetNames.join(',')}）` };
  }
  const range = parseA1Range(selector.rangeA1);
  if (!range) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `WorkbookCells A1 区间非法: ${selector.rangeA1}` };
  }
  if (range.endRow > resource.usedRange.maxRow || range.endCol > resource.usedRange.maxCol) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `WorkbookCells 区间越界: ${selector.rangeA1}（used ${resource.usedRange.maxRow}x${resource.usedRange.maxCol}）` };
  }
  for (const anchor of selector.mergedCellAnchors) {
    const cell = parseA1Cell(anchor);
    if (!cell
      || cell.row < range.startRow || cell.row > range.endRow
      || cell.col < range.startCol || cell.col > range.endCol) {
      return { ok: false, code: 'kb_evidence_unresolved', message: `WorkbookCells 合并主格不在区间内: ${anchor}` };
    }
    if (resource.mergedAnchors && !resource.mergedAnchors.has(`${selector.sheet}!${anchor.toUpperCase()}`)) {
      return { ok: false, code: 'kb_evidence_unresolved', message: `WorkbookCells 合并主格与资源合并表不符: ${selector.sheet}!${anchor}` };
    }
  }
  const parts: string[] = [];
  let formulaCells = 0;
  let valueCells = 0;
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    for (let col = range.startCol; col <= range.endCol; col += 1) {
      const a1 = `${colLetters(col)}${row}`;
      const cell = resource.cell(selector.sheet, a1);
      if (cell) {
        if (cell.formula) { formulaCells += 1; parts.push(`${a1}=${cell.formula}`); }
        else { valueCells += 1; parts.push(`${a1}=${cell.value}`); }
      } else {
        parts.push(`${a1}=`);
      }
    }
  }
  // 性质一致性：声明 formula_text 却存在缓存值格（且未附公式文本）→ 拒绝。
  if (selector.valueNature === 'formula_text' && valueCells > 0 && !(selector.formulaTexts && selector.formulaTexts.length > 0)) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `WorkbookCells 声明 formula_text 但区间含 ${valueCells} 个缓存值格且未附公式文本` };
  }
  if (selector.valueNature === 'cached_value' && formulaCells > 0) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `WorkbookCells 声明 cached_value 但区间含 ${formulaCells} 个公式格` };
  }
  const fragment = parts.join('\n');
  return { ok: true, fragment, quoteHash: computeQuoteHash(fragment) };
}

/** MediaRegion：imageHash 校验；片段为旁路文字或构造标记。 */
function resolveMediaRegion(resource: EvidenceImageResource, selector: MediaRegionSelector): SelectorResolution | SelectorResolutionFailure {
  if (selector.imageHash !== resource.imageHash) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `MediaRegion imageHash 不符: ${selector.imageHash} ≠ ${resource.imageHash}` };
  }
  if (selector.region && (selector.region.w < 0 || selector.region.h < 0)) {
    return { ok: false, code: 'kb_evidence_unresolved', message: 'MediaRegion 区域尺寸非法（w/h < 0）' };
  }
  const fragment = resource.caption ?? `[image:${resource.imageHash}]`;
  return { ok: true, fragment, quoteHash: computeQuoteHash(fragment) };
}

/** selector 解引用入口（A 案 §5.2 定位规范；不匹配给结构化原因）。 */
export function resolveSelector(
  resource: EvidenceResource,
  selector: EvidenceSelector,
): SelectorResolution | SelectorResolutionFailure {
  switch (selector.kind) {
    case 'text_span':
      return resource.kind === 'text'
        ? resolveTextSpan(resource.content, selector)
        : { ok: false, code: 'kb_evidence_unresolved', message: `TextSpan 只适用于 text 资源（资源为 ${resource.kind}）` };
    case 'csv_cells':
      return resource.kind === 'csv'
        ? resolveCsvCells(resource, selector)
        : { ok: false, code: 'kb_evidence_unresolved', message: `CsvCells 只适用于 csv 资源（资源为 ${resource.kind}）` };
    case 'workbook_cells':
      return resource.kind === 'workbook'
        ? resolveWorkbookCells(resource, selector)
        : { ok: false, code: 'kb_evidence_unresolved', message: `WorkbookCells 只适用于 workbook 资源（资源为 ${resource.kind}）` };
    case 'media_region':
      return resource.kind === 'image'
        ? resolveMediaRegion(resource, selector)
        : { ok: false, code: 'kb_evidence_unresolved', message: `MediaRegion 只适用于 image 资源（资源为 ${resource.kind}）` };
  }
}

// ============================================================================
// verifyEvidence（A 案 §5.3「服务端重新解引用校验」）
// ============================================================================

export interface EvidenceVerificationInput {
  /** 与 Evidence 同形（见 knowledge-schema Evidence；此处只消费语义字段） */
  evidence: {
    evidenceId?: string;
    sourceRef: { sourceId: string; sourceSnapshotHash: string; resourceId: string; resourceHash: string };
    selector: EvidenceSelector;
    quoteHash: string;
    readReceiptId?: string;
  };
  resources: EvidenceResource[];
  receipts: EvidenceReadReceipt[];
}

export type EvidenceVerification =
  | { ok: true; fragment: string; receipt: EvidenceReadReceipt | null }
  | { ok: false; code: string; message: string };

/**
 * verifyEvidence：sourceRef hash 对账 → readReceiptId 存在且 selector 落在
 * 回执范围 → quoteHash 复核。任何一步失败给结构化原因（kb_evidence_
 * unresolved），不抛异常。回执范围按资源本地行坐标：
 * - TextSpan 直接比对行区间；
 * - CsvCells 先把逻辑 record 映射到物理行（引号内换行展开）再比对；
 * - WorkbookCells/MediaRegion 非行定位：回执只需存在且资源一致。
 */
export function verifyEvidence(input: EvidenceVerificationInput): EvidenceVerification {
  const { evidence } = input;
  const resource = input.resources.find((candidate) => candidate.resourceId === evidence.sourceRef.resourceId);
  if (!resource) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `证据资源不在本构建资源表: ${evidence.sourceRef.resourceId}` };
  }
  if (resource.sourceId !== evidence.sourceRef.sourceId) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `sourceRef.sourceId 与资源不符: ${evidence.sourceRef.sourceId} ≠ ${resource.sourceId}` };
  }
  if (resource.sourceSnapshotHash !== evidence.sourceRef.sourceSnapshotHash) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `sourceSnapshotHash 对账失败（源快照已变或伪造）: ${evidence.sourceRef.sourceSnapshotHash} ≠ ${resource.sourceSnapshotHash}` };
  }
  if (resource.resourceHash !== evidence.sourceRef.resourceHash) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `resourceHash 对账失败: ${evidence.sourceRef.resourceHash} ≠ ${resource.resourceHash}` };
  }
  // readReceiptId：提供时必须命中本 build 回执登记，且范围覆盖 selector。
  let receipt: EvidenceReadReceipt | null = null;
  if (evidence.readReceiptId !== undefined) {
    const found = input.receipts.find((candidate) => candidate.readReceiptId === evidence.readReceiptId);
    if (!found) {
      return { ok: false, code: 'kb_evidence_unresolved', message: `readReceiptId 不在本构建回执登记（伪造或跨构建引用）: ${evidence.readReceiptId}` };
    }
    if (found.resourceId !== resource.resourceId) {
      return { ok: false, code: 'kb_evidence_unresolved', message: `回执资源不符: 回执 ${found.resourceId} ≠ 证据 ${resource.resourceId}` };
    }
    const rangeCheck = selectorWithinReceipt(resource, evidence.selector, found);
    if (!rangeCheck.ok) return rangeCheck;
    receipt = found;
  }
  const resolution = resolveSelector(resource, evidence.selector);
  if (!resolution.ok) return resolution;
  if (resolution.quoteHash !== evidence.quoteHash) {
    return { ok: false, code: 'kb_evidence_unresolved', message: `quoteHash 不匹配（资源内容与所选片段不一致）: 证据 ${evidence.quoteHash} ≠ 复核 ${resolution.quoteHash}` };
  }
  return { ok: true, fragment: resolution.fragment, receipt };
}

function selectorWithinReceipt(
  resource: EvidenceResource,
  selector: EvidenceSelector,
  receipt: EvidenceReadReceipt,
): { ok: true } | { ok: false; code: string; message: string } {
  if (selector.kind === 'text_span') {
    if (selector.lineStart < receipt.lineStart || selector.lineEnd > receipt.lineEnd) {
      return {
        ok: false,
        code: 'kb_evidence_unresolved',
        message: `TextSpan 超出回执范围: ${selector.lineStart}..${selector.lineEnd} ⊄ 回执 ${receipt.lineStart}..${receipt.lineEnd}（截断范围外的文字必须再读，A 案 §5.3）`,
      };
    }
    return { ok: true };
  }
  if (selector.kind === 'csv_cells' && resource.kind === 'csv') {
    const { recordSpans } = parseCsvRecords(resource.content);
    const start = recordSpans[selector.recordStart - 1];
    const end = recordSpans[selector.recordEnd - 1];
    if (!start || !end) {
      return { ok: false, code: 'kb_evidence_unresolved', message: `CsvCells record 越界（资源共 ${recordSpans.length} 条记录）` };
    }
    const startLine = start.startLine;
    const endLine = end.startLine + end.lineCount - 1;
    if (startLine < receipt.lineStart || endLine > receipt.lineEnd) {
      return {
        ok: false,
        code: 'kb_evidence_unresolved',
        message: `CsvCells 物理行 ${startLine}..${endLine} 超出回执范围 ${receipt.lineStart}..${receipt.lineEnd}`,
      };
    }
    return { ok: true };
  }
  // WorkbookCells / MediaRegion：非行定位，回执存在且资源一致即可。
  return { ok: true };
}

/** 便捷：按内容构造资源哈希（与 raw_read 回执资源表同公式）。 */
export function contentResourceHash(content: string): string {
  return resourceHashOf(content);
}
