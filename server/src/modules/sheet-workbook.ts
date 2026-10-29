/** Native XLSX is the source of truth. This module only reads its bytes. */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as SSF from 'ssf';
import crypto from 'node:crypto';
import { reconstructWorkbookFromReads, type WorkbookReadClient } from './sheet-read-reconstruction.js';
import { workbookPathForMarkdown } from './workbook-source.js';
import { measureSyncPhase } from './sync-performance.js';
export { workbookPathForMarkdown } from './workbook-source.js';
import type { WorkbookCell, WorkbookFont, WorkbookPreview, WorkbookSheetLayout } from '../types/workbook.js';

export const MAX_WORKBOOK_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 1_024;
const MAX_CELLS = 250_000;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/** Package validation precedes decompression/import. Never accept CLI JSON/HTML as XLSX. */
export async function readWorkbookPackage(absolutePath: string): Promise<JSZip> {
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_WORKBOOK_BYTES) {
    throw new Error('Excel 原件为空或超过 64 MB 读取上限');
  }
  const bytes = fs.readFileSync(absolutePath);
  if (bytes.length < 4 || bytes.readUInt16LE(0) !== 0x4b50) throw new Error('导出文件不是有效的 XLSX 工作簿');
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  // JSZip keeps central-directory sizes on its compressed objects; this does
  // not inflate the members and protects the subsequent ExcelJS import.
  let expandedBytes = 0;
  for (const entry of entries) {
    expandedBytes += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  }
  if (entries.length > 10_000 || expandedBytes > MAX_EXPANDED_BYTES) {
    throw new Error('Excel 工作簿解压后超过预览读取上限');
  }
  if (!zip.file('[Content_Types].xml') || !zip.file('xl/workbook.xml')) {
    throw new Error('导出文件缺少 XLSX 工作簿结构');
  }
  const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
  if (!/<(?:\w+:)?sheet\s/.test(workbookXml)) throw new Error('Excel 工作簿没有工作表');
  return zip;
}

export interface WorkbookExportClient {
  exportWorkbook(spreadsheetToken: string, outputPath: string): Promise<string>;
}

/** Only acquisition failures may fall back to CSV; local ownership and auth failures remain blockers. */
export class WorkbookAcquisitionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'WorkbookAcquisitionError'; }
}

/** Export into staging and preserve the native archive without re-serializing. */
export async function stageSourceWorkbook(
  client: WorkbookExportClient & Partial<WorkbookReadClient>,
  spreadsheetToken: string,
  stagingDocDir: string,
  localMdPath: string,
): Promise<{
  absolutePath: string; relativePath: string;
  metadataPath: string; metadataRelativePath: string;
  mode: 'native' | 'read-reconstruction';
  revision?: number | string;
}> {
  if (typeof client.exportWorkbook !== 'function') {
    throw new Error('当前 lark-cli 客户端不支持 Excel 原件导出，请更新应用和 lark-cli 后重试');
  }
  const finalPath = workbookPathForMarkdown(localMdPath);
  // A hand-placed Excel file has no ownership marker. Do not silently adopt it.
  if (fs.existsSync(finalPath)) {
    const previous = fs.existsSync(localMdPath) ? fs.readFileSync(localMdPath, 'utf-8') : '';
    let knownOwner = false;
    try {
      const metadataPath = `${finalPath}.metadata.json`;
      if (fs.statSync(metadataPath).size < 2 * 1024 * 1024) {
        knownOwner = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')).objToken === spreadsheetToken;
      }
    } catch { /* Historical/manual files have no ownership sidecar. */ }
    if (!knownOwner && !previous.includes(`source_workbook: ${JSON.stringify(path.basename(finalPath))}`)
      && !previous.includes(`previous_workbook: ${JSON.stringify(path.basename(finalPath))}`)) {
      throw new Error(`本地 Excel 文件已存在且未纳管，无法覆盖: ${path.basename(finalPath)}`);
    }
  }
  const relativePath = path.basename(finalPath);
  const absolutePath = path.join(stagingDocDir, relativePath);
  let mode: 'native' | 'read-reconstruction' = 'native';
  let details: object = {};
  try {
    const reported = await measureSyncPhase('native-export', () => client.exportWorkbook(spreadsheetToken, absolutePath));
    if (path.resolve(reported) !== path.resolve(absolutePath)) throw new Error('Excel 导出未写入指定 staging 路径');
    await readWorkbookPackage(absolutePath);
  } catch (error) {
    if ((error as { code?: string })?.code === 'auth') throw error;
    if (typeof client.getSheetLayout !== 'function' || typeof client.getSheetCells !== 'function'
      || typeof client.getSheetFloatImages !== 'function' || typeof client.getWorkbookInfo !== 'function') {
      throw new WorkbookAcquisitionError('Excel 原件获取失败，且只读重建不可用', { cause: error });
    }
    console.info('[sheet-workbook] Native export unavailable; rebuilding workbook through read APIs.');
    try {
      details = await measureSyncPhase('read-reconstruction', () => reconstructWorkbookFromReads(client as WorkbookReadClient, spreadsheetToken, absolutePath));
    } catch (reconstructionError) {
      if ((reconstructionError as { code?: string })?.code === 'auth') throw reconstructionError;
      throw new WorkbookAcquisitionError('Excel 原件获取和只读重建均未完成', { cause: reconstructionError });
    }
    mode = 'read-reconstruction';
    await readWorkbookPackage(absolutePath);
  }
  const metadataRelativePath = `${relativePath}.metadata.json`;
  const metadataPath = path.join(stagingDocDir, metadataRelativePath);
  fs.writeFileSync(metadataPath, JSON.stringify({
    schemaVersion: 1, objToken: spreadsheetToken, ...details, mode,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'),
  }, null, 2), 'utf-8');
  return { absolutePath, relativePath, metadataPath, metadataRelativePath, mode, revision: (details as { revision?: number | string }).revision };
}

const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
const INDEXED_COLORS = ['000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
  '000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
  '800000','008000','000080','808000','800080','008080','C0C0C0','808080',
  '9999FF','993366','FFFFCC','CCFFFF','660066','FF8080','0066CC','CCCCFF',
  '000080','FF00FF','FFFF00','00FFFF','800080','800000','008080','0000FF',
  '00CCFF','CCFFFF','CCFFCC','FFFF99','99CCFF','FF99CC','CC99FF','FFCC99',
  '3366FF','33CCCC','99CC00','FFCC00','FF9900','FF6600','666699','969696',
  '003366','339966','003300','333300','993300','993366','333399','333333'];

function colorCss(color: (Partial<ExcelJS.Color> & { indexed?: number; tint?: number }) | undefined, theme: string[]): string | undefined {
  if (!color) return undefined;
  let hex = color.argb?.slice(-6) ?? (color.theme != null ? theme[color.theme] : undefined)
    ?? (color.indexed != null ? INDEXED_COLORS[color.indexed] : undefined);
  if (!hex || !/^[a-f\d]{6}$/i.test(hex)) return undefined;
  const tint = color.tint ?? 0;
  if (tint) {
    hex = hex.match(/../g)!.map((part) => {
      const n = parseInt(part, 16);
      return Math.round(Math.max(0, Math.min(255, tint < 0 ? n * (1 + tint) : n + (255 - n) * tint)))
        .toString(16).padStart(2, '0');
    }).join('');
  }
  return `#${hex}`;
}

function fontDto(font: Partial<ExcelJS.Font> | undefined, theme: string[]): WorkbookFont {
  return {
    name: font?.name,
    size: (font?.size ?? 11) * 4 / 3,
    color: colorCss(font?.color, theme),
    bold: font?.bold,
    italic: font?.italic,
    underline: Boolean(font?.underline),
    strike: font?.strike,
  };
}

function formattedText(cell: ExcelJS.Cell, date1904: boolean): string {
  const value = cell.value;
  const result = value && typeof value === 'object' && 'result' in value ? value.result : value;
  if (typeof result === 'number' || result instanceof Date) {
    try { return SSF.format(cell.numFmt || (result instanceof Date ? 'yyyy-mm-dd' : 'General'), result, { date1904 }); }
    catch { /* Unrecognized Excel format: retain the actual value. */ }
  }
  // Formula evaluation belongs to Excel; use its exported cached result only.
  if (result == null && cell.type === ExcelJS.ValueType.Formula) return `=${cell.formula}`;
  return cell.text;
}

/** Derive the textual companion from the same verified XLSX, without a second cloud read. */
export async function readReconstructedSheetCsv(file: string, name: string, rows: number, columns: number): Promise<string> {
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows * columns > 2_000_000) throw new Error('CSV 派生范围无效');
  const { workbook } = await loadWorkbook(file);
  const sheet = workbook.getWorksheet(name); if (!sheet) throw new Error('Excel 中缺少待派生工作表');
  const lines: string[] = [];
  for (let row = 1; row <= rows; row++) {
    const source = sheet.findRow(row); const fields: string[] = [];
    for (let column = 1; column <= columns; column++) {
      const cell = source?.findCell(column);
      const text = !cell || (cell.isMerged && cell.master.address !== cell.address) ? '' : formattedText(cell, Boolean(workbook.properties.date1904));
      fields.push(/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(fields.join(','));
  }
  return lines.join('\n') + '\n';
}

export function columnWidthPixels(width: number): number {
  // ISO/IEC 29500: raw OOXML width already includes cell padding.
  return Math.floor((256 * width + Math.floor(128 / 7)) / 256 * 7);
}

function offsets(sizes: number[]): number[] {
  const values = [0];
  for (const size of sizes) values.push(values[values.length - 1] + size);
  return values;
}

type NativeAnchor = { nativeCol?: number; nativeColOff?: number; nativeRow?: number; nativeRowOff?: number; col: number; row: number };
type NativeImageRange = { tl: NativeAnchor; br?: NativeAnchor; ext?: { width: number; height: number } };

function anchorPoint(anchor: NativeAnchor, xs: number[], ys: number[]) {
  // DrawingML offsets are EMUs (9525 per CSS pixel). ExcelJS's fractional
  // getters normalize against its own width heuristic and lose exact offsets.
  const column = anchor.nativeCol ?? Math.floor(anchor.col);
  const row = anchor.nativeRow ?? Math.floor(anchor.row);
  return {
    x: (xs[Math.min(column, xs.length - 1)] ?? 0) + (anchor.nativeColOff ?? 0) / 9525,
    y: (ys[Math.min(row, ys.length - 1)] ?? 0) + (anchor.nativeRowOff ?? 0) / 9525,
  };
}

interface LoadedWorkbook { workbook: ExcelJS.Workbook; theme: string[]; warnings: string[] }
const cache = new Map<string, Promise<LoadedWorkbook>>();

function xmlAttribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}=(['"])(.*?)\\1`).exec(attributes)?.[2];
}

/** ExcelJS 4.4 parses <sz> with parseInt, losing 10.5pt etc. Restore the
 * original floating point sizes in the read model, without changing the XLSX. */
async function restoreOriginalFontSizes(workbook: ExcelJS.Workbook, zip: JSZip) {
  const styles = await zip.file('xl/styles.xml')?.async('string');
  if (!styles) return;
  const fontsBlock = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(styles)?.[1] ?? '';
  const fontSizes = [...fontsBlock.matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/g)].map((font) => {
    const attributes = /<sz\b([^>]*)\/?\s*>/.exec(font[1])?.[1];
    return attributes ? Number(xmlAttribute(attributes, 'val')) : undefined;
  });
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const sizesByStyle = [...xfs.matchAll(/<xf\b([^>]*)>/g)].map((xf) => fontSizes[Number(xmlAttribute(xf[1], 'fontId') ?? 0)]);
  const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
  const relationships = await zip.file('xl/_rels/workbook.xml.rels')?.async('string') ?? '';
  const targets = new Map([...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map((match) => [xmlAttribute(match[1], 'Id'), xmlAttribute(match[1], 'Target')]));
  const sheetRefs = [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)].map((match) => xmlAttribute(match[1], 'r:id'));
  for (const [index, sheet] of workbook.worksheets.entries()) {
    const target = targets.get(sheetRefs[index]);
    if (!target) continue;
    const filename = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`);
    const xml = await zip.file(filename)?.async('string');
    if (!xml) continue;
    for (const match of xml.matchAll(/<c\b([^>]*)>/g)) {
      const address = xmlAttribute(match[1], 'r');
      const size = sizesByStyle[Number(xmlAttribute(match[1], 's') ?? 0)];
      if (address && size != null && Number.isFinite(size)) {
        const cell = sheet.getCell(address);
        cell.font = { ...cell.font, size };
      }
    }
  }
}

async function loadWorkbook(absolutePath: string): Promise<LoadedWorkbook> {
  const stat = fs.statSync(absolutePath);
  const key = `${absolutePath}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const zip = await readWorkbookPackage(absolutePath);
      const warnings: string[] = [];
      const theme = [...DEFAULT_THEME];
      const themeXml = await zip.file('xl/theme/theme1.xml')?.async('string');
      if (themeXml) {
        const names = ['lt1','dk1','lt2','dk2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'];
        names.forEach((name, i) => {
          const block = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`).exec(themeXml)?.[1];
          const hex = block && /(?:lastClr|val)="([a-f\d]{6})"/i.exec(block)?.[1];
          if (hex) theme[i] = hex;
        });
      }
      if (Object.keys(zip.files).some((name) => /^xl\/(?:charts|diagrams)\//.test(name))) {
        warnings.push('此工作簿包含图表或关系图，请打开 Excel 原件查看这些对象。');
      }
      for (const entry of Object.values(zip.files).filter((file) => /^xl\/drawings\/drawing\d+\.xml$/.test(file.name))) {
        const xml = await entry.async('string');
        if (/<(?:\w+:)?(?:sp|grpSp|cxnSp)\b/.test(xml)) {
          warnings.push('此工作簿包含形状或文本框，请打开 Excel 原件查看这些对象。');
          break;
        }
      }
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(absolutePath);
      await restoreOriginalFontSizes(workbook, zip);
      return { workbook, theme, warnings };
    })();
    cache.set(key, pending);
    while (cache.size > 2) cache.delete(cache.keys().next().value!);
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

export async function readWorkbookPreview(absolutePath: string, sheetIndex: number): Promise<WorkbookPreview> {
  const { workbook, theme, warnings: commonWarnings } = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets[sheetIndex];
  if (!sheet) throw new RangeError('工作表不存在');
  const warnings = [...commonWarnings];
  const images = sheet.getImages().map((image) => ({ ...image, range: image.range as NativeImageRange }));
  // ExcelJS's declared WorksheetModel omits rows and conditionalFormattings.
  const model = sheet.model as ExcelJS.WorksheetModel & {
    rows: Array<{ number: number; cells: ExcelJS.CellModel[] }>;
    conditionalFormattings?: unknown[];
  };
  let lastRow = Math.max(30, sheet.rowCount + 2);
  let lastColumn = Math.max(16, sheet.columnCount + 2);
  for (const image of images) {
    const range = image.range;
    lastRow = Math.max(lastRow, Math.ceil(range.br?.row ?? range.tl.row + (range.ext?.height ?? 100) / 20) + 3);
    lastColumn = Math.max(lastColumn, Math.ceil(range.br?.col ?? range.tl.col + (range.ext?.width ?? 100) / 64) + 3);
  }
  if (lastRow > MAX_ROWS || lastColumn > MAX_COLUMNS) warnings.push('预览范围限于前 50000 行、1024 列；完整内容保存在 Excel 原件中。');
  lastRow = Math.min(lastRow, MAX_ROWS);
  lastColumn = Math.min(lastColumn, MAX_COLUMNS);
  const rows = Array.from({ length: lastRow }, (_, i) => {
    const row = sheet.findRow(i + 1);
    return row?.hidden ? 0 : (row?.height ?? sheet.properties.defaultRowHeight ?? 15) * 4 / 3;
  });
  const columns = Array.from({ length: lastColumn }, (_, i) => {
    const column = sheet.getColumn(i + 1);
    return column.hidden ? 0 : columnWidthPixels(column.width ?? sheet.properties.defaultColWidth ?? 9.140625);
  });
  const cells: WorkbookCell[] = [];
  for (const row of model.rows) {
    if (row.number > lastRow) continue;
    for (const cellModel of row.cells) {
      const cell = sheet.getCell(String(cellModel.address));
      const column = Number(cell.col);
      if (column > lastColumn || cells.length >= MAX_CELLS) continue;
      if (cell.isMerged && cell.master.address !== cell.address) continue;
      const fill = cell.fill;
      const borders: WorkbookCell['borders'] = {};
      for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
        const border = cell.border?.[edge];
        if (border?.style) borders[edge] = { style: border.style, color: colorCss(border.color, theme) ?? '#000000' };
      }
      const value = cell.value;
      cells.push({
        address: cell.address, row: row.number - 1, column: column - 1,
        text: formattedText(cell, workbook.properties.date1904 ?? false),
        formula: cell.type === ExcelJS.ValueType.Formula ? cell.formula : undefined,
        richText: value && typeof value === 'object' && 'richText' in value
          ? value.richText.map((run) => ({ text: run.text, font: fontDto({ ...cell.font, ...run.font }, theme) })) : undefined,
        font: fontDto(cell.font, theme),
        fill: fill?.type === 'pattern' && fill.pattern === 'solid' ? colorCss(fill.fgColor, theme) : undefined,
        horizontal: cell.alignment?.horizontal ?? (typeof cell.result === 'number' || typeof value === 'number' ? 'right' : 'left'),
        vertical: cell.alignment?.vertical ?? 'bottom',
        wrap: cell.alignment?.wrapText,
        indent: cell.alignment?.indent,
        rotation: typeof cell.alignment?.textRotation === 'number' ? cell.alignment.textRotation : undefined,
        borders,
      });
    }
  }
  if (cells.length >= MAX_CELLS) warnings.push('单页预览最多显示 250000 个单元格；其余内容请查看 Excel 原件。');
  if (model.conditionalFormattings?.length) warnings.push('预览显示单元格基础样式；条件格式的计算效果请查看 Excel 原件。');
  const xs = offsets(columns), ys = offsets(rows);
  const layout: WorkbookSheetLayout = {
    index: sheetIndex, name: sheet.name, rows, columns, cells,
    merges: (model.merges ?? []).map((range) => {
      const [start, end = start] = range.split(':');
      const a = sheet.getCell(start), b = sheet.getCell(end);
      return { top: Number(a.row) - 1, left: Number(a.col) - 1, bottom: Number(b.row) - 1, right: Number(b.col) - 1 };
    }).filter((merge) => merge.top < lastRow && merge.left < lastColumn),
    images: [],
    showGridLines: sheet.views?.[0]?.showGridLines !== false,
    warnings,
  };
  let imageBytes = 0;
  images.forEach((image, index) => {
    const media = workbook.getImage(Number(image.imageId));
    const extension = media?.extension?.toLowerCase();
    if (!media || !extension || !['png', 'jpeg', 'jpg', 'gif', 'webp'].includes(extension)) {
      warnings.push(`图片 ${index + 1} 的格式无法预览，请查看 Excel 原件。`);
      return;
    }
    const buffer = media.buffer ? Buffer.from(media.buffer) : media.base64 ? Buffer.from(media.base64.replace(/^data:[^,]*,/, ''), 'base64') : null;
    if (!buffer || (imageBytes += buffer.length) > MAX_IMAGE_BYTES) {
      warnings.push(`图片 ${index + 1} 超过预览读取上限，请查看 Excel 原件。`);
      return;
    }
    const start = anchorPoint(image.range.tl as NativeAnchor, xs, ys);
    const end = image.range.br ? anchorPoint(image.range.br as NativeAnchor, xs, ys) : null;
    layout.images.push({
      id: `${sheetIndex}-${index}`, ...start,
      width: end ? Math.max(1, end.x - start.x) : image.range.ext?.width ?? 100,
      height: end ? Math.max(1, end.y - start.y) : image.range.ext?.height ?? 100,
      dataUrl: `data:image/${extension === 'jpg' ? 'jpeg' : extension};base64,${buffer.toString('base64')}`,
    });
  });
  return {
    sheets: workbook.worksheets.map((item, index) => ({ index, name: item.name, state: item.state })),
    sheet: layout,
  };
}
