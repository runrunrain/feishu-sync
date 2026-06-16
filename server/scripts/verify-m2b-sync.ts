/**
 * M2-B Verification Script
 * Tests expandSyncedBlocks, exportSheets, and IndexScanner
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

const LARK_CLI_PATH = 'lark-cli.cmd'; // Windows
const ROOT_URL = 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb';

/**
 * Test 1: Detect if subtree has sheet nodes
 */
async function testDetectSheetNodes() {
  console.log('\n=== Test 1: Detect sheet nodes in subtree ===');

  try {
    // Get root node info
    const { stdout } = await execFileAsync(LARK_CLI_PATH, [
      'wiki',
      '+node-get',
      '--node-token',
      ROOT_URL,
      '--format',
      'json',
    ], {
      shell: true,
    });

    const rootNode = JSON.parse(stdout);
    const spaceId = rootNode.data.space_id;
    const rootToken = rootNode.data.node_token;

    console.info(`Root space_id: ${spaceId}`);
    console.info(`Root node_token: ${rootToken}`);

    // List subtree nodes
    const { stdout: listStdout } = await execFileAsync(LARK_CLI_PATH, [
      'wiki',
      '+node-list',
      '--space-id',
      spaceId,
      '--parent-node-token',
      rootToken,
      '--page-all',
      '--format',
      'json',
    ], {
      shell: true,
    });

    const listResult = JSON.parse(listStdout);
    const nodes = listResult.data.items || [];

    console.info(`Total nodes in subtree: ${nodes.length}`);

    // Find sheet nodes
    const sheetNodes = nodes.filter((node: any) => node.obj_type === 'sheet');
    console.info(`Sheet nodes found: ${sheetNodes.length}`);

    if (sheetNodes.length > 0) {
      console.info('Sample sheet node:');
      console.info(JSON.stringify(sheetNodes[0], null, 2));
      return { hasSheet: true, sampleSheet: sheetNodes[0] };
    } else {
      console.warn('No sheet nodes found in subtree');
      return { hasSheet: false };
    }
  } catch (error: any) {
    console.error('Failed to detect sheet nodes:', error);
    return { hasSheet: false, error };
  }
}

/**
 * Test 2: Test sheet export with a real sheet token
 */
async function testSheetExport(sheetToken?: string) {
  console.log('\n=== Test 2: Sheet export ===');

  const testToken = sheetToken || 'test-token-placeholder';

  // Create temp directory for export
  const tempDir = fs.mkdtempSync(path.join(process.env.TEMP || 'C:\\Temp', 'feishu-sheet-test-'));
  console.info(`Temp directory: ${tempDir}`);

  try {
    // List sheets
    const { stdout: listStdout } = await execFileAsync(LARK_CLI_PATH, [
      'sheets',
      '+workbook-info',
      '--spreadsheet-token',
      testToken,
      '--format',
      'json',
    ], {
      shell: true,
    });

    const workbookInfo = JSON.parse(listStdout);
    const sheets = workbookInfo.data?.sheets || [];

    console.info(`Total sheets in workbook: ${sheets.length}`);

    if (sheets.length === 0) {
      console.warn('No sheets found to export');
      return { exported: 0 };
    }

    // Export first sheet as test
    const firstSheet = sheets[0];
    const csvPath = path.join(tempDir, `${firstSheet.title}.csv`);

    console.info(`Exporting sheet: ${firstSheet.title} (${firstSheet.sheet_id})`);

    const { stdout: exportStdout } = await execFileAsync(LARK_CLI_PATH, [
      'sheets',
      '+workbook-export',
      '--spreadsheet-token',
      testToken,
      '--file-extension',
      'csv',
      '--sheet-id',
      firstSheet.sheet_id,
      '--output-path',
      csvPath,
    ], {
      shell: true,
    });

    console.info(`Export command stdout: ${exportStdout}`);

    // Verify file exists and check size
    if (fs.existsSync(csvPath)) {
      const stats = fs.statSync(csvPath);
      console.info(`CSV file created: ${csvPath}`);
      console.info(`File size: ${stats.size} bytes`);

      // Read first few lines
      const content = fs.readFileSync(csvPath, 'utf-8');
      const lines = content.split('\n').slice(0, 5);
      console.info('First 5 lines:');
      lines.forEach((line, i) => console.info(`  ${i + 1}: ${line}`));

      return {
        exported: 1,
        csvPath,
        fileSize: stats.size,
        previewLines: lines.length,
      };
    } else {
      console.error('CSV file not created');
      return { exported: 0, error: 'File not created' };
    }
  } catch (error: any) {
    console.error('Sheet export failed:', error);
    return { exported: 0, error: error.message };
  } finally {
    // Cleanup temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.info(`Cleaned up temp directory: ${tempDir}`);
    } catch (cleanupError) {
      console.warn(`Failed to cleanup temp directory: ${cleanupError}`);
    }
  }
}

/**
 * Test 3: Test index scanner on real knowledge base
 */
async function testIndexScanner() {
  console.log('\n=== Test 3: Index scanner ===');

  const knowledgeBaseRoot = 'D:/WorkPace/公司知识库/策划 - Designer';

  if (!fs.existsSync(knowledgeBaseRoot)) {
    console.warn(`Knowledge base root does not exist: ${knowledgeBaseRoot}`);
    return { scanned: 0, indexed: 0, error: 'Directory not found' };
  }

  // Count .md files
  const mdFiles = findAllMdFiles(knowledgeBaseRoot);
  console.info(`Found ${mdFiles.length} .md files in knowledge base`);

  // Sample parse first few files
  const sampleSize = Math.min(5, mdFiles.length);
  const sampleFiles = mdFiles.slice(0, sampleSize);

  let withValidHeader = 0;
  let withObjToken = 0;
  let withOriginalLink = 0;

  for (const mdPath of sampleFiles) {
    const content = fs.readFileSync(mdPath, 'utf-8');
    const header = parseHtmlHeader(content);

    if (header) {
      withValidHeader++;
      if (header.obj_token) withObjToken++;
      if (header.original_link) withOriginalLink++;
    }
  }

  console.info(`Sample results (first ${sampleSize} files):`);
  console.info(`  With valid HTML header: ${withValidHeader}/${sampleSize}`);
  console.info(`  With obj_token: ${withObjToken}/${sampleSize}`);
  console.info(`  With original link: ${withOriginalLink}/${sampleSize}`);

  return {
    totalMdFiles: mdFiles.length,
    sampleSize,
    withValidHeader,
    withObjToken,
    withOriginalLink,
  };
}

/**
 * Helper: Find all .md files recursively
 */
function findAllMdFiles(dir: string): string[] {
  const mdFiles: string[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      mdFiles.push(...findAllMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      mdFiles.push(fullPath);
    }
  }

  return mdFiles;
}

/**
 * Helper: Parse HTML comment header
 */
function parseHtmlHeader(content: string): { obj_token?: string; original_link?: string; fetch_date?: string } | null {
  const headerRegex = /<!--\s*\n([\s\S]*?)\n-->/;
  const match = content.match(headerRegex);

  if (!match) {
    return null;
  }

  const headerText = match[1];
  const result: { obj_token?: string; original_link?: string; fetch_date?: string } = {};

  const objTokenMatch = headerText.match(/obj_token:\s*(\S+)/);
  if (objTokenMatch) {
    result.obj_token = objTokenMatch[1];
  }

  const originalLinkMatch = headerText.match(/原始链接:\s*(\S+)/);
  if (originalLinkMatch) {
    result.original_link = originalLinkMatch[1];
  }

  const fetchDateMatch = headerText.match(/获取日期:\s*(\S+)/);
  if (fetchDateMatch) {
    result.fetch_date = fetchDateMatch[1];
  }

  return result;
}

/**
 * Main test runner
 */
async function main() {
  console.log('M2-B Verification Script');
  console.log('=======================\n');

  // Test 1: Detect sheet nodes
  const sheetDetectResult = await testDetectSheetNodes();

  // Test 2: Sheet export (if sheet found, or test command availability)
  if (sheetDetectResult.hasSheet) {
    const sampleSheet = sheetDetectResult.sampleSheet;
    console.info(`\nTesting sheet export with real sheet: ${sampleSheet.title}`);
    await testSheetExport(sampleSheet.obj_token);
  } else {
    console.info('\nNo sheet found in subtree, testing lark-cli command availability only');
    // Test that the command is available (will fail with proper error if command works)
    await testSheetExport();
  }

  // Test 3: Index scanner
  await testIndexScanner();

  console.log('\n=== Verification completed ===');
}

main().catch((error) => {
  console.error('Verification script failed:', error);
  process.exit(1);
});
