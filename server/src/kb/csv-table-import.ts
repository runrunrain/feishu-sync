import { parseCsvRecords } from './evidence-locator.js';

export interface CsvTableImportOptions {
  columns: number[];
  headerRecord: number;
  firstRecord: number;
  lastRecord?: number;
}

export interface RenderedCsvTable {
  markdown: string;
  importedRows: number;
  lineStart: number;
  lineEnd: number;
}

function cell(value: string): string {
  return value.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
}

/** Copy a frozen CSV table into a standard document without asking the model
 * to retype rows. Record numbers are logical CSV records; the returned physical
 * line range can be registered as a truthful read receipt for evidence checks. */
export function renderCsvTableImport(content: string, options: CsvTableImportOptions): RenderedCsvTable {
  const parsed = parseCsvRecords(content);
  const { records, recordSpans } = parsed;
  const { columns, headerRecord, firstRecord } = options;
  const lastRecord = options.lastRecord ?? records.length;
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > 20
    || columns.some((column) => !Number.isSafeInteger(column) || column < 0 || column >= 100)
    || new Set(columns).size !== columns.length) throw new Error('CSV 导入列坐标无效');
  if (!Number.isSafeInteger(headerRecord) || headerRecord < 1 || headerRecord > records.length
    || !Number.isSafeInteger(firstRecord) || firstRecord <= headerRecord || firstRecord > records.length
    || !Number.isSafeInteger(lastRecord) || lastRecord < firstRecord || lastRecord > records.length) {
    throw new Error('CSV 导入记录范围无效');
  }
  const header = columns.map((column, index) => cell(records[headerRecord - 1]?.[column] || `列 ${index + 1}`));
  const rows: string[] = [];
  let lastIncluded = headerRecord;
  for (let recordNo = firstRecord; recordNo <= lastRecord; recordNo += 1) {
    const values = columns.map((column) => records[recordNo - 1]?.[column] ?? '');
    if (values.every((value) => !value.trim())) continue;
    rows.push(`| ${values.map(cell).join(' | ')} |`);
    lastIncluded = recordNo;
    if (rows.length > 2_000) throw new Error('CSV 导入超过 2000 条有效记录，请拆分文档');
  }
  if (!rows.length) throw new Error('CSV 导入范围没有有效记录');
  const markdown = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows].join('\n');
  if (Buffer.byteLength(markdown, 'utf8') > 1_000_000) throw new Error('CSV 导入表格超过 1 MB，请缩小范围');
  const firstSpan = recordSpans[headerRecord - 1]!;
  const lastSpan = recordSpans[lastIncluded - 1]!;
  return {
    markdown,
    importedRows: rows.length,
    lineStart: firstSpan.startLine,
    lineEnd: lastSpan.startLine + lastSpan.lineCount - 1,
  };
}
