import { parseCsvRecords } from './evidence-locator.js';
import { MAX_STANDARD_DOC_BYTES } from './standard-doc-limits.js';

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
  let renderedBytes = Buffer.byteLength(`| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |`, 'utf8');
  let lastIncluded = headerRecord;
  for (let recordNo = firstRecord; recordNo <= lastRecord; recordNo += 1) {
    const values = columns.map((column) => records[recordNo - 1]?.[column] ?? '');
    if (values.every((value) => !value.trim())) continue;
    const renderedRow = `| ${values.map(cell).join(' | ')} |`;
    renderedBytes += 1 + Buffer.byteLength(renderedRow, 'utf8');
    if (renderedBytes > MAX_STANDARD_DOC_BYTES) {
      throw new Error(`CSV 导入表格超过 ${MAX_STANDARD_DOC_BYTES} 字节，请按记录范围拆成多篇文档`);
    }
    rows.push(renderedRow);
    lastIncluded = recordNo;
  }
  if (!rows.length) throw new Error('CSV 导入范围没有有效记录');
  const markdown = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows].join('\n');
  const firstSpan = recordSpans[headerRecord - 1]!;
  const lastSpan = recordSpans[lastIncluded - 1]!;
  return {
    markdown,
    importedRows: rows.length,
    lineStart: firstSpan.startLine,
    lineEnd: lastSpan.startLine + lastSpan.lineCount - 1,
  };
}
