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

export interface LoadedRawWorkbook { workbook: ExcelJS.Workbook; contentHash: string; compatibility?: 'mixed_shared_string_prefix' }
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
  } catch { throw new QueryError('raw_workbook_unreadable', '已登记的 Excel 路径无效或文件不可读取；可使用 raw_read 查看已有文本和 CSV。', { reason: 'missing_or_unsafe_path' }); }
  try {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { throw new QueryError('raw_workbook_unreadable', '已登记的 Excel 文件缺失或不可读取；可使用 raw_read 查看已有文本和 CSV。', { reason: 'missing_or_unreadable' }); }
    if (!stat.isFile() || stat.size === 0) throw new QueryError('raw_workbook_unreadable', 'Excel 文件为空或不是普通文件。', { reason: 'invalid_file' });
    if (stat.size > 64 * 1024 * 1024) throw new QueryError('raw_workbook_unreadable', 'Excel 文件超过 64 MiB 读取上限；可使用 raw_read 查看已有文本和 CSV。', { reason: 'file_too_large' });
    const bytes = fs.readFileSync(file);
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const key = `${file}\0${contentHash}`;
    let promise = pending.get(key);
    if (!promise) {
      promise = (async () => {
        let zip: JSZip;
        try { zip = await JSZip.loadAsync(bytes); } catch { throw new QueryError('raw_workbook_unreadable', 'Excel 文件的 ZIP 结构无法解析；可使用 raw_read 查看已有文本和 CSV。', { reason: 'invalid_archive' }); }
        const files = Object.values(zip.files);
        const expanded = files.reduce((sum, item) => sum + ((item as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
        if (files.length > 10_000 || expanded > 256 * 1024 * 1024) throw new QueryError('raw_workbook_unreadable', 'Excel 解压内容超过读取上限；可使用 raw_read 查看已有文本和 CSV。', { reason: 'expanded_too_large' });
        if (!zip.file('[Content_Types].xml') || !zip.file('xl/workbook.xml')) throw new QueryError('raw_workbook_unreadable', 'Excel 文件缺少必要的工作簿结构。', { reason: 'invalid_archive' });
        let workbook = new ExcelJS.Workbook();
        let compatibility: LoadedRawWorkbook['compatibility'];
        try {
          await workbook.xlsx.load(bytes as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
        } catch (error) {
          // Some workbooks prefix rich-text runs with a direct <t>. ExcelJS 4
          // treats that string as its model and then mutates it. Normalize only
          // this mixed form in memory, retaining non-empty text as an initial run.
          const shared = zip.file('xl/sharedStrings.xml');
          if (!shared || !(error instanceof Error) || !/Cannot create property 'richText' on string/.test(error.message)) throw error;
          const xml = await shared.async('string');
          const normalized = xml.replace(/(<si\b[^>]*>\s*)(<t(?:\s[^>]*)?>([^<]*)<\/t>|<t(?:\s[^>]*)?\s*\/>)(?=\s*<r(?:\s|>))/g,
            (_match, opening: string, textNode: string, text: string | undefined) => opening + (text ? `<r>${textNode}</r>` : ''));
          if (normalized === xml) throw error;
          zip.file('xl/sharedStrings.xml', normalized);
          const repaired = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
          workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(repaired as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
          compatibility = 'mixed_shared_string_prefix';
        }
        if (!workbook.worksheets.length) throw new QueryError('raw_workbook_unreadable', 'Excel 工作簿没有可读取的工作表。', { reason: 'empty_workbook' });
        return { workbook, contentHash, ...(compatibility ? { compatibility } : {}) };
      })();
      pending.set(key, promise);
      while (pending.size > 2) pending.delete(pending.keys().next().value!);
      promise.catch(() => pending.delete(key));
    } else { pending.delete(key); pending.set(key, promise); }
    return await promise;
  } catch (error) {
    if (error instanceof QueryError) throw error;
    throw new QueryError('raw_workbook_unreadable', 'Excel 解析失败；可使用 raw_read 查看已有文本和 CSV。原始文件未被修改。', { reason: 'parse_failed' });
  }
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
