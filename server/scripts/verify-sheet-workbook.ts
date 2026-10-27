/** Read-only live verification. Writes only to the explicitly selected output. */
import fs from 'node:fs';
import path from 'node:path';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { readWorkbookPreview, stageSourceWorkbook } from '../src/modules/sheet-workbook.js';

const args = process.argv.slice(2);
const token = args[args.indexOf('--token') + 1];
const output = args[args.indexOf('--output') + 1];
if (!args.includes('--token') || !args.includes('--output') || !token || !output || !/\.xlsx$/i.test(output)) {
  throw new Error('Usage: tsx scripts/verify-sheet-workbook.ts --token <spreadsheet-token> --output <new-file.xlsx>');
}
const outputPath = path.resolve(output);
if (fs.existsSync(outputPath)) throw new Error('验证输出已存在，请选择一个新文件');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const client = new LarkCliClient({ requiredScopes: [] });
const staged = await stageSourceWorkbook(client, token, path.dirname(outputPath), outputPath.replace(/\.xlsx$/i, '.md'));
const first = await readWorkbookPreview(staged.absolutePath, 0);
const sheets = [];
for (const item of first.sheets) {
  const { sheet } = item.index === 0 ? first : await readWorkbookPreview(staged.absolutePath, item.index);
  sheets.push({ name: sheet.name, cells: sheet.cells.filter((cell) => cell.text).length,
    images: sheet.images.length, merges: sheet.merges.length, warnings: sheet.warnings });
}
console.info(JSON.stringify({ outputPath, mode: staged.mode, bytes: fs.statSync(staged.absolutePath).size, sheets }, null, 2));
