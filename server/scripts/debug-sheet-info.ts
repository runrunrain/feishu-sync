/**
 * Debug sheet info structure
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const LARK_CLI_PATH = 'lark-cli.cmd';
const SHEET_TOKEN = 'Gummsu16RhQhk9tEb2NcxzNRnZc';

async function debugSheetInfo() {
  try {
    const { stdout } = await execFileAsync(LARK_CLI_PATH, [
      'sheets',
      '+workbook-info',
      '--spreadsheet-token',
      SHEET_TOKEN,
      '--format',
      'json',
    ], {
      shell: true,
    });

    console.info('Raw stdout:');
    console.info(stdout);

    const result = JSON.parse(stdout);
    console.info('\nParsed result:');
    console.info(JSON.stringify(result, null, 2));

    if (result.data && result.data.sheets) {
      console.info(`\nTotal sheets: ${result.data.sheets.length}`);
      console.info('First sheet structure:');
      console.info(JSON.stringify(result.data.sheets[0], null, 2));
    }
  } catch (error) {
    console.error('Failed:', error);
  }
}

debugSheetInfo();
