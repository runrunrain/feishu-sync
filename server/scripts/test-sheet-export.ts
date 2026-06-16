/**
 * Test exportSheets with real sheet token
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

const LARK_CLI_PATH = 'lark-cli.cmd';
const SHEET_TOKEN = 'Gummsu16RhQhk9tEb2NcxzNRnZc'; // Real sheet from M1 detection

async function testRealSheetExport() {
  console.info('Testing real sheet export with token:', SHEET_TOKEN);

  // Create temp directory
  const tempDir = fs.mkdtempSync(path.join(process.env.TEMP || 'C:\\Temp', 'feishu-sheet-test-'));
  console.info('Temp directory:', tempDir);

  try {
    // List sheets
    const { stdout: listStdout } = await execFileAsync(LARK_CLI_PATH, [
      'sheets',
      '+workbook-info',
      '--spreadsheet-token',
      SHEET_TOKEN,
      '--format',
      'json',
    ], {
      shell: true,
    });

    const workbookInfo = JSON.parse(listStdout);
    const sheets = workbookInfo.data?.sheets || [];

    console.info(`Total sheets in workbook: ${sheets.length}`);

    if (sheets.length === 0) {
      console.warn('No sheets found');
      return;
    }

    // Export first 3 sheets as sample
    const exportCount = Math.min(3, sheets.length);
    const exported: Array<{ title: string; sheetId: string; csvPath: string; size: number }> = [];

    for (let i = 0; i < exportCount; i++) {
      const sheet = sheets[i];
      const csvPath = path.join(tempDir, `${sheet.title}.csv`);

      console.info(`Exporting sheet ${i + 1}/${exportCount}: "${sheet.title}" (${sheet.sheet_id})`);

      const { stdout: exportStdout } = await execFileAsync(LARK_CLI_PATH, [
        'sheets',
        '+workbook-export',
        '--spreadsheet-token',
        SHEET_TOKEN,
        '--file-extension',
        'csv',
        '--sheet-id',
        sheet.sheet_id,
        '--output-path',
        csvPath,
      ], {
        shell: true,
      });

      console.info(`Export stdout: ${exportStdout}`);

      // Verify file
      if (fs.existsSync(csvPath)) {
        const stats = fs.statSync(csvPath);
        console.info(`SUCCESS: ${csvPath} (${stats.size} bytes)`);

        // Read first 3 lines as preview
        const content = fs.readFileSync(csvPath, 'utf-8');
        const lines = content.split('\n').slice(0, 3);
        console.info('Preview:');
        lines.forEach((line, idx) => console.info(`  ${idx + 1}: ${line.substring(0, 80)}...`));

        exported.push({
          title: sheet.title,
          sheetId: sheet.sheet_id,
          csvPath,
          size: stats.size,
        });
      } else {
        console.error(`FAILED: CSV file not created`);
      }
    }

    console.info(`\nExport summary: ${exported.length}/${exportCount} sheets exported successfully`);
    exported.forEach(exp => {
      console.info(`  - ${exp.title}: ${exp.csvPath} (${exp.size} bytes)`);
    });

  } catch (error: any) {
    console.error('Sheet export failed:', error);
  } finally {
    // Cleanup
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.info(`\nCleaned up temp directory`);
    } catch (cleanupError) {
      console.warn(`Failed to cleanup: ${cleanupError}`);
    }
  }
}

testRealSheetExport().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
