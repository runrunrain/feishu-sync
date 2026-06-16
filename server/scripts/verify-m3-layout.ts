/**
 * Verification script for M3 LayoutReconstructor
 *
 * Tests five-category block detection with sample CSV data:
 * - A metadata: Keyword match
 * - B hierarchy: col_indent inconsistent
 * - C datatable: >=3 rows, start at col 0, header >=3, avg non-empty >=2.5, fill rate >= valid cols * 0.4
 * - D paragraph: Single column long text
 * - E sparse: Fill rate < 0.4
 */

import fs from 'node:fs';
import path from 'node:path';
import { LayoutReconstructor } from '../src/modules/layout-reconstructor.js';

interface TestCase {
  name: string;
  type: 'metadata' | 'hierarchy' | 'datatable' | 'paragraph' | 'sparse';
  csvData: string[][];
  description: string;
}

const testCases: TestCase[] = [
  {
    name: 'A-Metadata',
    type: 'metadata',
    description: 'First cell keyword match (更新日志/作者/版本/日期)',
    csvData: [
      ['更新日志', '2026-06-16', '初始版本'],
      ['作者', '天城'],
      ['版本', '1.0'],
    ],
  },
  {
    name: 'B-Hierarchy',
    type: 'hierarchy',
    description: 'col_indent inconsistent across rows',
    csvData: [
      ['', '系统架构', '概述'],
      ['', '', '设计原则'],
      ['', '技术选型', ''],
      ['', '', 'Electron vs Tauri'],
    ],
  },
  {
    name: 'C-Datatable',
    type: 'datatable',
    description: '>=3 rows, all start at col 0, header >=3 short fields, avg non-empty >=2.5, fill rate >= valid cols * 0.4',
    csvData: [
      ['Name', 'Ver', 'Lic', 'Purpose'],
      ['Electron', '31.x', 'MIT', 'Desktop framework'],
      ['Hono', '4.x', 'MIT', 'Web server'],
      ['SQLite', '3.x', 'PD', 'Embedded DB'],
    ],
  },
  {
    name: 'D-Paragraph',
    type: 'paragraph',
    description: 'Single column long text',
    csvData: [
      ['这是一个长段落内容，包含多个句子和详细描述，应该在单列中显示。'],
    ],
  },
  {
    name: 'E-Sparse',
    type: 'sparse',
    description: 'Fill rate < 0.4 (many columns, few non-empty values)',
    csvData: [
      ['参数', '.', '.', '.', '.', '.', '.', '.', '.', '.'],
      ['.', '.', '.', '.', '.', '.', '.', '.', '.', 'sk-xxx'],
      ['.', '.', '.', '.', '.', '.', '.', '.', '.', 'deepseek-chat'],
    ],
  },
];

async function runVerification() {
  console.info('=== M3 LayoutReconstructor Verification ===\n');

  const reconstructor = new LayoutReconstructor();
  const results: Array<{
    name: string;
    passed: boolean;
    expectedType: string;
    actualType: string;
    confidence: number;
    markdown: string;
  }> = [];

  for (const testCase of testCases) {
    try {
      // Create temporary CSV file
      const tempDir = path.join(process.cwd(), 'temp-test-csv');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const csvPath = path.join(tempDir, `${testCase.name}.csv`);

      // Write CSV data (use quote to preserve empty strings)
      const csvContent = testCase.csvData.map((row) =>
        row.map((cell) => `"${cell}"`).join(',')
      ).join('\n');
      fs.writeFileSync(csvPath, csvContent, 'utf-8');

      console.info(`\n[Test ${testCase.name}] CSV content:\n${csvContent}\n`);

      // Reconstruct
      const blocks = await reconstructor.reconstruct(csvPath);

      if (blocks.length === 0) {
        console.error(`❌ ${testCase.name}: No blocks detected`);
        results.push({
          name: testCase.name,
          passed: false,
          expectedType: testCase.type,
          actualType: 'none',
          confidence: 0,
          markdown: '',
        });
        continue;
      }

      const block = blocks[0];
      const passed = block.type.type === testCase.type;

      console.info(`${passed ? '✅' : '❌'} ${testCase.name}: ${block.type.type} (confidence: ${block.type.confidence})`);
      console.info(`   Description: ${testCase.description}`);
      console.info(`   Markdown preview:\n${block.markdown.split('\n').slice(0, 5).join('\n')}\n`);

      results.push({
        name: testCase.name,
        passed,
        expectedType: testCase.type,
        actualType: block.type.type,
        confidence: block.type.confidence,
        markdown: block.markdown,
      });

      // Cleanup
      fs.unlinkSync(csvPath);
    } catch (error) {
      console.error(`❌ ${testCase.name}: Error during reconstruction - ${error instanceof Error ? error.message : String(error)}`);
      results.push({
        name: testCase.name,
        passed: false,
        expectedType: testCase.type,
        actualType: 'error',
        confidence: 0,
        markdown: '',
      });
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.info(`\n=== Summary: ${passed}/${total} passed ===`);

  if (passed === total) {
    console.info('✅ All LayoutReconstructor tests passed');
    process.exit(0);
  } else {
    console.error('❌ Some tests failed');
    process.exit(1);
  }
}

runVerification().catch((error) => {
  console.error('Verification failed:', error);
  process.exit(1);
});
