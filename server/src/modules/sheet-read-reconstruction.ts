/** Rebuild an XLSX using authorized read APIs when native export is unavailable. */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { downloadSheetMedia, parseSheetFloatImages, type SheetMediaDownloadClient } from './sheet-media.js';
import { addPieChart } from './sheet-chart-reconstruction.js';

type JsonObject = Record<string, any>;
export interface WorkbookReadClient extends SheetMediaDownloadClient {
  getWorkbookInfo(token: string, fresh?: boolean): Promise<any>;
  getSheetLayout(options: { spreadsheetToken: string; sheetId: string }): Promise<any>;
  getSheetCells(options: { spreadsheetToken: string; sheetId: string; range: string; formulas?: boolean; revision?: number | string }): Promise<any>;
  getSheetFloatImages(options: { spreadsheetToken: string; sheetId: string }): Promise<any>;
  getSheetCharts?(options: { spreadsheetToken: string; sheetId: string }): Promise<any>;
}

export interface WorkbookReadManifest {
  mode: 'read-reconstruction';
  revision: number | string;
  sheets: Array<{ id: string; name: string; rows: number; columns: number; cells: number; merges: number; images: number }>;
  approximations?: Array<{ sheet: string; cell?: string; kind: string; detail: unknown }>;
}

function payload(response: JsonObject): JsonObject {
  if (response?.ok === false) throw new Error('表格读取接口返回失败');
  const data = response?.data ?? response;
  if (!data || typeof data !== 'object') throw new Error('表格读取响应结构缺失');
  return data;
}

function columnNumber(letters: string): number {
  if (!/^[A-Z]+$/.test(letters)) throw new Error(`非法列坐标: ${letters}`);
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function columnLetters(column: number): string {
  let letters = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  return letters;
}

function dimensions(value: string, columns = false): [number, number] {
  const parts = String(value).split(':');
  const convert = (part: string) => columns ? columnNumber(part) : Number(part);
  const start = convert(parts[0]), end = convert(parts[1] ?? parts[0]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new Error(`非法行列范围: ${value}`);
  return [start, end];
}

function assertRevision(data: JsonObject, revision: number | string) {
  if (data.revision == null || String(data.revision) !== String(revision)) {
    throw new Error('读取期间云端表格版本变化或缺少版本号，请重新同步');
  }
}

function excelColor(value: unknown): Partial<ExcelJS.Color> | undefined {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) return undefined;
  return { argb: `FF${value.slice(1).toUpperCase()}` };
}

function excelFont(styles: JsonObject): Partial<ExcelJS.Font> {
  return {
    name: styles.font_family,
    // Sheet font-size numbers follow spreadsheet point sizes. Row heights
    // and column widths are pixels and are converted separately below.
    size: styles.font_size != null ? Number(styles.font_size) : undefined,
    color: excelColor(styles.font_color),
    bold: styles.font_weight === 'bold', italic: styles.font_style === 'italic',
    underline: styles.font_line === 'underline', strike: styles.font_line === 'line-through',
  };
}

function applyCell(cell: ExcelJS.Cell, raw: JsonObject, formulaRaw: JsonObject, approximations: NonNullable<WorkbookReadManifest['approximations']>) {
  const styles = raw.cell_styles ?? {};
  const formulaValue = formulaRaw.formula ?? formulaRaw.value;
  const formula = typeof formulaValue === 'string' && formulaValue.startsWith('=')
    && (formulaRaw.formula != null || formulaValue !== raw.value) ? formulaValue.slice(1) : null;
  const value = raw.value ?? null;
  if (formula) {
    if (value != null && !['number', 'string', 'boolean'].includes(typeof value)) throw new Error(`公式结果类型未支持: ${cell.address}`);
    cell.value = { formula, result: value ?? undefined };
  } else if (Array.isArray(raw.rich_text) && raw.rich_text.length === 1 && raw.rich_text[0].type === 'link'
    && typeof raw.rich_text[0].link === 'string') {
    cell.value = { text: String(raw.rich_text[0].text ?? value ?? raw.rich_text[0].link), hyperlink: raw.rich_text[0].link };
  } else if (Array.isArray(raw.rich_text) && raw.rich_text.length > 0) {
    if (typeof value === 'string' && raw.rich_text.every((run: JsonObject) => typeof run.text === 'string')
      && raw.rich_text.map((run: JsonObject) => run.text).join('') !== value) {
      throw new Error(`单元格 ${cell.address} 的富文本与显示值不一致，无法确认完整重建`);
    }
    const runs: ExcelJS.RichText[] = [];
    for (const run of raw.rich_text) {
      if (!['text', 'mention'].includes(run.type) || typeof run.text !== 'string') {
        throw new Error(`单元格 ${cell.address} 包含尚不能完整重建的富文本对象 (${run.type ?? '未知类型'})`);
      }
      if (run.type === 'mention') approximations.push({ sheet: cell.worksheet.name, cell: cell.address, kind: 'mention', detail: { ...run } });
      runs.push({ text: run.text, font: excelFont({ ...styles, ...run.style }) });
    }
    cell.value = { richText: runs };
  } else {
    if (value != null && !['number', 'string', 'boolean'].includes(typeof value)) throw new Error(`单元格 ${cell.address} 包含尚不能完整重建的对象`);
    cell.value = value;
  }
  cell.font = excelFont(styles);
  cell.alignment = {
    horizontal: styles.horizontal_alignment,
    vertical: styles.vertical_alignment,
    wrapText: styles.word_wrap === 'auto-wrap',
  };
  if (styles.word_wrap === 'word-clip') throw new Error(`单元格 ${cell.address} 的裁剪显示无法完整映射为 Excel，请取得原件导出权限`);
  if (styles.number_format) cell.numFmt = styles.number_format;
  const fill = excelColor(styles.background_color);
  if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: fill };
  const borders: Partial<ExcelJS.Borders> = {};
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    const border = raw.border_styles?.[edge];
    if (!border || border.style === 'none') continue;
    const style = border.style === 'dashed' ? 'dashed' : border.style === 'dotted' ? 'dotted'
      : border.style === 'double' ? 'double' : border.weight === 'thick' ? 'thick' : border.weight === 'medium' ? 'medium' : 'thin';
    borders[edge] = { style, color: excelColor(border.color) };
  }
  cell.border = borders;
  if (raw.note != null) cell.note = String(raw.note);
}

type Window = { top: number; bottom: number; left: number; right: number };

function completeWindow(data: JsonObject, window: Window): boolean {
  const range = data.ranges?.[0];
  const rows = window.bottom - window.top + 1, cols = window.right - window.left + 1;
  const expectedRange = `${columnLetters(window.left)}${window.top}:${columnLetters(window.right)}${window.bottom}`;
  return data.has_more === false && data.truncated !== true && data.ranges?.length === 1
    && range.actual_range === expectedRange
    && range.truncated !== true && Array.isArray(range.row_indices) && Array.isArray(range.col_indices)
    && range.row_indices.length === rows && range.col_indices.length === cols
    && range.row_indices.every((row: unknown, i: number) => row === window.top + i)
    && range.col_indices.every((column: unknown, i: number) => column === columnLetters(window.left + i))
    && Array.isArray(range.cells) && range.cells.length === rows
    && range.cells.every((row: unknown) => Array.isArray(row) && row.length === cols);
}

async function readWindow(
  client: WorkbookReadClient, token: string, sheetId: string, revision: number | string,
  window: Window, worksheet: ExcelJS.Worksheet, approximations: NonNullable<WorkbookReadManifest['approximations']>,
  sizing: { rows: number; columns: number },
): Promise<number> {
  const range = `${columnLetters(window.left)}${window.top}:${columnLetters(window.right)}${window.bottom}`;
  const values = payload(await client.getSheetCells({ spreadsheetToken: token, sheetId, range, revision }));
  assertRevision(values, revision);
  // The formula rendering mode replaces values, so read cached values and
  // formulas separately. This also distinguishes literal '=...' text.
  const formulas = completeWindow(values, window)
    ? payload(await client.getSheetCells({ spreadsheetToken: token, sheetId, range, formulas: true, revision })) : values;
  assertRevision(formulas, revision);
  if (!completeWindow(values, window) || !completeWindow(formulas, window)) {
    // No partially returned cells are accepted. Retry smaller rectangles.
    if (window.bottom > window.top) {
      const mid = (window.top + window.bottom) >>> 1;
      sizing.rows = Math.min(sizing.rows, mid - window.top + 1);
      return await readWindow(client, token, sheetId, revision, { ...window, bottom: mid }, worksheet, approximations, sizing)
        + await readWindow(client, token, sheetId, revision, { ...window, top: mid + 1 }, worksheet, approximations, sizing);
    }
    if (window.right > window.left) {
      const mid = (window.left + window.right) >>> 1;
      sizing.columns = Math.min(sizing.columns, mid - window.left + 1);
      return await readWindow(client, token, sheetId, revision, { ...window, right: mid }, worksheet, approximations, sizing)
        + await readWindow(client, token, sheetId, revision, { ...window, left: mid + 1 }, worksheet, approximations, sizing);
    }
    throw new Error(`单元格 ${range} 读取仍被截断，不能确认完整同步`);
  }
  let nonEmpty = 0;
  values.ranges[0].cells.forEach((row: JsonObject[], rowIndex: number) => {
    row.forEach((raw: JsonObject, colIndex: number) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`单元格响应无效: ${range}`);
      if (Object.keys(raw).length === 0) return;
      const cell = worksheet.getCell(values.ranges[0].row_indices[rowIndex], columnNumber(values.ranges[0].col_indices[colIndex]));
      applyCell(cell, raw, formulas.ranges[0].cells[rowIndex][colIndex], approximations);
      if (cell.value != null) nonEmpty++;
    });
  });
  return nonEmpty;
}

function applyLayout(worksheet: ExcelJS.Worksheet, layout: JsonObject, rows: number, columns: number) {
  const rowCoverage = new Set<number>(), colCoverage = new Set<number>();
  if (!Array.isArray(layout.row_heights) || !Array.isArray(layout.column_widths)
    || !Array.isArray(layout.hidden_rows) || !Array.isArray(layout.hidden_columns) || !Array.isArray(layout.merged_cells)) {
    throw new Error(`工作表 ${worksheet.name} 缺少必要布局字段`);
  }
  for (const band of layout.row_heights) {
    const [start, end] = dimensions(band.rows);
    if (!Number.isFinite(band.height) || band.height <= 0 || end > rows) throw new Error('行高信息不完整或越界');
    for (let row = start; row <= end; row++) { worksheet.getRow(row).height = band.height * 0.75; rowCoverage.add(row); }
  }
  for (const band of layout.column_widths) {
    const [start, end] = dimensions(band.cols, true);
    if (!Number.isFinite(band.width) || band.width <= 0 || end > columns) throw new Error('列宽信息不完整或越界');
    for (let column = start; column <= end; column++) {
      // OOXML stores the padded width, not the character count shown in the
      // Excel column-width dialog. Calibri 11 has a 7px maximum digit width.
      worksheet.getColumn(column).width = Math.floor(band.width / 7 * 256) / 256;
      colCoverage.add(column);
    }
  }
  if (rowCoverage.size !== rows || colCoverage.size !== columns) throw new Error(`工作表 ${worksheet.name} 的行高或列宽未覆盖完整范围`);
  for (const hidden of layout.hidden_rows) {
    const [start, end] = dimensions(typeof hidden === 'string' ? hidden : hidden.rows);
    if (end > rows) throw new Error('隐藏行范围越界');
    for (let row = start; row <= end; row++) worksheet.getRow(row).hidden = true;
  }
  for (const hidden of layout.hidden_columns) {
    const [start, end] = dimensions(typeof hidden === 'string' ? hidden : hidden.cols, true);
    if (end > columns) throw new Error('隐藏列范围越界');
    for (let column = start; column <= end; column++) worksheet.getColumn(column).hidden = true;
  }
  const xSplit = Number(layout.frozen_column_count ?? layout.frozen_columns ?? 0);
  const ySplit = Number(layout.frozen_row_count ?? layout.frozen_rows ?? 0);
  worksheet.views = [{ state: xSplit || ySplit ? 'frozen' : 'normal', xSplit, ySplit, showGridLines: layout.show_gridlines !== false }];
  for (const group of layout.row_groups ?? []) {
    const [start, end] = dimensions(group.rows ?? group.range);
    if (end > rows) throw new Error('行分组范围越界');
    for (let row = start; row <= end; row++) worksheet.getRow(row).outlineLevel = Number(group.level ?? 1);
  }
  for (const group of layout.column_groups ?? []) {
    const [start, end] = dimensions(group.cols ?? group.range, true);
    if (end > columns) throw new Error('列分组范围越界');
    for (let column = start; column <= end; column++) worksheet.getColumn(column).outlineLevel = Number(group.level ?? 1);
  }
}

function imageExtension(buffer: Buffer): 'png' | 'jpeg' | 'gif' {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 3).toString() === 'GIF') return 'gif';
  throw new Error('图片不是可嵌入 Excel 的 PNG/JPEG/GIF 原始图像，不能确认完整同步');
}

export async function reconstructWorkbookFromReads(
  client: WorkbookReadClient, token: string, outputPath: string,
): Promise<WorkbookReadManifest> {
  const info = payload(await client.getWorkbookInfo(token));
  if (!Array.isArray(info.sheets) || !info.sheets.length || info.revision == null) throw new Error('工作簿清单或版本号缺失，无法完整重建 Excel');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'feishu-sync';
  const manifest: WorkbookReadManifest = { mode: 'read-reconstruction', revision: info.revision, sheets: [], approximations: [] };
  let totalCells = 0;
  for (const source of [...info.sheets].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))) {
    if (source.resource_type !== 'sheet') throw new Error(`工作表类型缺失或包含非网格工作表，无法完整重建: ${source.sheet_name}`);
    for (const field of ['float_image_count', 'merged_cells_count', 'chart_count', 'pivot_table_count']) {
      if (!Number.isInteger(source[field]) || source[field] < 0) throw new Error(`工作表 ${source.sheet_name} 缺少对象数量元信息 (${field})`);
    }
    if (Number(source.pivot_table_count ?? 0)) throw new Error(`工作表 ${source.sheet_name} 含图表或透视表，当前只读重建无法保真，请取得原件导出权限`);
    const rows = Number(source.row_count), columns = Number(source.column_count);
    totalCells += rows * columns;
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows > 50_000 || columns > 1024 || totalCells > 2_000_000) {
      throw new Error(`工作表 ${source.sheet_name} 的范围无效或超过当前完整重建上限`);
    }
    const options = { spreadsheetToken: token, sheetId: String(source.sheet_id) };
    if (source.chart_count > 0) {
      if (!client.getSheetCharts) throw new Error(`工作表 ${source.sheet_name} 的图表读取不可用`);
      const chartData = payload(await client.getSheetCharts(options));
      assertRevision(chartData, info.revision);
      const charts = chartData.sheets?.find((s: JsonObject) => s.sheet_id === source.sheet_id)?.charts;
      if (!Array.isArray(charts) || charts.length !== source.chart_count) throw new Error(`工作表 ${source.sheet_name} 图表清单不完整`);
      for (const chart of charts) manifest.approximations!.push({ sheet: source.sheet_name, kind: 'chart-metadata-only', detail: chart });
    }
    const layout = payload(await client.getSheetLayout(options));
    assertRevision(layout, info.revision);
    const worksheet = workbook.addWorksheet(String(source.sheet_name));
    worksheet.state = source.is_hidden ? 'hidden' : 'visible';
    applyLayout(worksheet, layout, rows, columns);
    let cells = 0;
    const sizing = { rows: 256, columns: 32 };
    for (let top = 1; top <= rows;) {
      const bottom = Math.min(rows, top + sizing.rows - 1);
      for (let left = 1; left <= columns;) {
        const right = Math.min(columns, left + sizing.columns - 1);
        cells += await readWindow(client, token, source.sheet_id, info.revision,
          { top, left, bottom, right }, worksheet, manifest.approximations!, sizing);
        left = right + 1;
      }
      top = bottom + 1;
    }
    if (source.merged_cells_count != null && layout.merged_cells.length !== Number(source.merged_cells_count)) throw new Error(`工作表 ${source.sheet_name} 的合并区域数量不一致`);
    for (const merge of layout.merged_cells) {
      const range = typeof merge === 'string' ? merge : merge.range;
      if (!/^[A-Z]+\d+:[A-Z]+\d+$/.test(range)) throw new Error('合并单元格范围无效');
      worksheet.mergeCellsWithoutStyle(range);
    }
    const imageResponse = await client.getSheetFloatImages(options);
    const imagePayload = payload(imageResponse);
    assertRevision(imagePayload, info.revision);
    const rawImages = imagePayload.sheets?.find((item: JsonObject) => item.sheet_id === source.sheet_id)?.float_images
      ?? imagePayload.float_images ?? (imagePayload.total === 0 && Array.isArray(imagePayload.sheets) ? [] : undefined);
    if (!Array.isArray(rawImages)) throw new Error(`工作表 ${source.sheet_name} 的图片清单缺失`);
    const parsed = parseSheetFloatImages(imageResponse);
    if (parsed.length !== rawImages.length || (source.float_image_count != null && parsed.length !== Number(source.float_image_count))) throw new Error(`工作表 ${source.sheet_name} 的图片数量不一致`);
    // A unique download directory makes retries independent of earlier partial
    // exports; media CLI shortcuts refuse to overwrite an existing filename.
    const mediaParent = path.resolve(path.dirname(outputPath));
    const imagesDir = fs.mkdtempSync(path.join(mediaParent, '.workbook-media-'));
    let imageCount = 0;
    try {
      const downloaded = await downloadSheetMedia({ client, floatImages: parsed, imagesDir, subSheetTitle: source.sheet_id });
      imageCount = downloaded.length;
      for (const raw of [...rawImages].sort((a, b) => Number(a.z_index ?? 0) - Number(b.z_index ?? 0))) {
        const image = downloaded.find((item) => item.floatImageId === raw.float_image_id);
        const parsedImage = parsed.find((item) => item.floatImageId === raw.float_image_id);
        if (!image || !parsedImage || parsedImage.row == null || parsedImage.col == null
          || parsedImage.width == null || parsedImage.height == null || parsedImage.width <= 0 || parsedImage.height <= 0) throw new Error('图片锚点或尺寸缺失');
        const buffer = fs.readFileSync(image.localPath);
        const id = workbook.addImage({ base64: buffer.toString('base64'), extension: imageExtension(buffer) });
        worksheet.addImage(id, {
          tl: {
            nativeCol: parsedImage.col, nativeRow: parsedImage.row,
            nativeColOff: Math.round(Number(raw.offset?.col_offset ?? 0) * 9525),
            nativeRowOff: Math.round(Number(raw.offset?.row_offset ?? 0) * 9525),
          } as unknown as ExcelJS.Anchor,
          ext: { width: parsedImage.width, height: parsedImage.height }, editAs: 'oneCell',
        });
      }
    } finally {
      // Delete only the fresh directory created directly under this staging
      // parent. Never follow a calculated path into an unrelated directory.
      if (path.dirname(path.resolve(imagesDir)) === mediaParent && path.basename(imagesDir).startsWith('.workbook-media-')) {
        fs.rmSync(imagesDir, { recursive: true, force: true });
      }
    }
    manifest.sheets.push({ id: source.sheet_id, name: worksheet.name, rows, columns, cells, merges: layout.merged_cells.length, images: imageCount });
    console.info(`[sheet-workbook] Rebuilt sheet ${worksheet.name}: ${cells} populated cells, ${layout.merged_cells.length} merges, ${imageCount} images.`);
  }
  const finalInfo = payload(await client.getWorkbookInfo(token, true));
  assertRevision(finalInfo, info.revision);
  if (finalInfo.sheets?.length !== info.sheets.length) throw new Error('读取期间工作表清单变化，请重新同步');
  await workbook.xlsx.writeFile(outputPath);
  // Pin Normal's font explicitly so the host Office default cannot change
  // the digit-width basis used by column geometry. Cell fonts are untouched.
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  for (const entry of manifest.approximations!) {
    if (entry.kind !== 'chart-metadata-only') continue;
    const sheetIndex = manifest.sheets.findIndex((sheet) => sheet.name === entry.sheet) + 1;
    if (sheetIndex > 0 && await addPieChart(zip, sheetIndex, entry.detail as JsonObject)) entry.kind = 'chart-approximate-pie';
  }
  const stylesFile = zip.file('xl/styles.xml');
  if (!stylesFile) throw new Error('重建工作簿缺少样式定义');
  let styles = await stylesFile.async('string');
  styles = styles.replace(/(<fonts\b[^>]*>)<font>[\s\S]*?<\/font>/,
    '$1<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>');
  styles = styles.replace(/(<cellStyleXfs\b[^>]*>)<xf\b([^>]*?)\/>/,
    (_all, opening: string, attributes: string) => `${opening}<xf${attributes.replace(/\s+applyFont="[^"]*"/g, '')} applyFont="1"/>`);
  zip.file('xl/styles.xml', styles);
  fs.writeFileSync(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  // Verify the serialized result, not just the in-memory writer state.
  const saved = new ExcelJS.Workbook();
  await saved.xlsx.readFile(outputPath);
  if (saved.worksheets.length !== manifest.sheets.length) throw new Error('重建工作簿的工作表数量校验失败');
  manifest.sheets.forEach((expected, index) => {
    const actual = saved.worksheets[index];
    if (actual.name !== expected.name || actual.getImages().length !== expected.images || actual.model.merges.length !== expected.merges) throw new Error(`工作表 ${expected.name} 的保存回读校验失败`);
  });
  return manifest;
}
