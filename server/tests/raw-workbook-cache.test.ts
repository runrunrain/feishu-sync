import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { loadRawWorkbook } from '../src/kb/raw-workbook.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-workbook-cache-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('unchanged workbook reads reuse parsing/hash work, while content and source authorization changes invalidate reuse', async () => {
  const md = path.join(root, 'source.md'); const xlsx = path.join(root, 'source.xlsx');
  const write = async (value: string) => { const wb = new ExcelJS.Workbook(); wb.addWorksheet('data').getCell('A1').value = value; await wb.xlsx.writeFile(xlsx); };
  fs.writeFileSync(md, '---\nsource:\n  source_workbook: "source.xlsx"\n---'); await write('before');
  const catalog = { root, updatedAt: '', entries: [] }; const entry = { objToken: 'o', title: 'source', relPath: 'source.md', attachments: [] };
  const first = await loadRawWorkbook(catalog, entry); const read = vi.spyOn(fs.promises, 'readFile');
  try {
    for (let i = 0; i < 20; i++) expect(await loadRawWorkbook(catalog, entry)).toBe(first);
    expect(read).not.toHaveBeenCalled();
    await write('after'); const next = await loadRawWorkbook(catalog, entry);
    expect(next.contentHash).not.toBe(first.contentHash); expect(next.workbook.worksheets[0].getCell('A1').value).toBe('after');
    fs.writeFileSync(md, '---\nsource:\n  source_workbook: "../outside.xlsx"\n---');
    await expect(loadRawWorkbook(catalog, entry)).rejects.toMatchObject({ code: 'raw_workbook_unreadable' });
  } finally { read.mockRestore(); }
});
