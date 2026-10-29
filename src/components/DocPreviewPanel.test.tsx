import { describe, expect, it } from 'vitest';
import { initialDocumentFormat } from './DocPreviewPanel';
import type { DocumentContent } from '../types';

const base: DocumentContent = { objToken: 'token', title: '表格', objType: 'sheet', mdPath: 'a.md', mdContent: '# A', mdTruncated: false,
  csvTables: [{ name: '主表', path: 'a.csv', content: 'x', truncated: false }], workbook: { path: 'a.xlsx', size: 1, modifiedTime: '' } };
describe('sheet preview selection', () => {
  it('prefers Excel when the current sync acquired it', () => expect(initialDocumentFormat(base)).toBe('xlsx'));
  it('shows fresh fallback CSV before a retained older Excel', () => expect(initialDocumentFormat({ ...base,
    sheetStatus: { acquisition: 'csv-fallback', workbookMayBeOlder: true, syncedAt: null, approximations: [] } })).toBe('csv'));
  it('keeps historical markdown readable without an Excel', () => expect(initialDocumentFormat({ ...base, workbook: null })).toBe('md'));
});
