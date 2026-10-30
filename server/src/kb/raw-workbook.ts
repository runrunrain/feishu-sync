/** Read managed XLSX workbooks without importing SQLite or invoking cloud APIs. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as SSF from 'ssf';
import { resolveInside } from '../agent/path-guard.js';
import { QueryError } from './search/query-error.js';
import type { RawCatalog, RawCatalogEntry } from './raw-mcp-catalog.js';

export interface LoadedRawWorkbook { workbook: ExcelJS.Workbook; contentHash: string }
const pending = new Map<string, Promise<LoadedRawWorkbook>>();

export async function loadRawWorkbook(catalog: RawCatalog, entry: RawCatalogEntry): Promise<LoadedRawWorkbook> {
  let md: string, header: string;
  try {
    md = resolveInside(catalog.root, entry.relPath, 'read');
    const mdStat = fs.statSync(md);
    if (!mdStat.isFile() || mdStat.size > 8 * 1024 * 1024) throw Error();
    header = fs.readFileSync(md, 'utf8').slice(0, 16_384);
  } catch { throw new QueryError('raw_unreadable', '源文档不可读取，请重新同步后重试'); }
  const marker = /^\s+source_workbook:\s*("[^\n]+")\s*$/m.exec(header)?.[1];
  if (!marker && !/^\s+source_workbook\s*:/m.test(header)) {
    throw new QueryError('raw_workbook_unavailable', '此源文档没有可用的已纳管 Excel；可使用 raw_read 阅读现有文本和 CSV。');
  }
  let file: string;
  try {
    if (!marker) throw Error();
    const name: unknown = JSON.parse(marker);
    const expected = path.basename(md).replace(/\.md$/i, '') + '.xlsx';
    if (typeof name !== 'string' || name !== expected || /[\\/]/.test(name)) throw Error();
    file = resolveInside(catalog.root, path.posix.join(path.posix.dirname(entry.relPath), name), 'read');
  } catch { throw new QueryError('raw_workbook_unreadable', '已登记的 Excel 文件缺失、路径无效或不可读取；原始文件未被修改。'); }
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > 64 * 1024 * 1024) throw new Error('workbook_size');
    const bytes = fs.readFileSync(file);
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const key = `${file}\0${contentHash}`;
    let promise = pending.get(key);
    if (!promise) {
      promise = (async () => {
        const zip = await JSZip.loadAsync(bytes);
        const files = Object.values(zip.files);
        const expanded = files.reduce((sum, item) => sum + ((item as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
        if (files.length > 10_000 || expanded > 256 * 1024 * 1024 || !zip.file('[Content_Types].xml') || !zip.file('xl/workbook.xml')) throw Error('workbook_invalid');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(bytes as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
        if (!workbook.worksheets.length) throw Error('workbook_empty');
        return { workbook, contentHash };
      })();
      pending.set(key, promise);
      while (pending.size > 2) pending.delete(pending.keys().next().value!);
      promise.catch(() => pending.delete(key));
    } else { pending.delete(key); pending.set(key, promise); }
    return await promise;
  } catch { throw new QueryError('raw_workbook_unreadable', 'Excel 文件无效、不可读或超过读取上限；原始文件未被修改。'); }
}

export function rawCellText(cell: ExcelJS.Cell, date1904 = false): string {
  const value = cell.value;
  const result = value && typeof value === 'object' && 'result' in value ? value.result : value;
  if (typeof result === 'number' || result instanceof Date) {
    try { return String(SSF.format(cell.numFmt || (result instanceof Date ? 'yyyy-mm-dd' : 'General'), result, { date1904 })); }
    catch { /* Preserve the raw value when the Excel format is unknown. */ }
  }
  if (result == null && cell.type === ExcelJS.ValueType.Formula) return `=${cell.formula}`;
  return cell.text;
}
