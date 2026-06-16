/**
 * LayoutReconstructor - Table reconstruction engine
 *
 * Implements the design from 架构设计文档 §6.3 and 技术实现文档 §九:
 * - reconstruct(): Main orchestration (loadCsv -> fixJsonEscape -> splitIntoBlocks -> identify + reconstruct)
 * - loadCsv(): UTF-8-BOM aware CSV parsing
 * - fixJsonEscape(): Restore broken JSON escapes from Feishu CSV export
 * - splitIntoBlocks(): Split by empty rows
 * - identifyBlockType(): Five-category detection (A/B/C/D/E) per 架构 §6.3 criteria
 * - reconstructBlock(): Five reconstruction methods (metadata/hierarchy/datatable/paragraph/sparse)
 *
 * Five-category criteria (from 架构 §6.3):
 * - A metadata: First cell keyword match (更新日志/作者/版本/日期 etc)
 * - B hierarchy: col_indent inconsistent across rows
 * - C datatable: >=3 rows, all start at col 0, header >=3 short fields, avg non-empty >=2.5, fill rate > 0.4 (strictly greater)
 * - D paragraph: Single column long text
 * - E sparse: Fill rate <= 0.4 (robust threshold)
 */

import fs from 'node:fs';
import csv from 'csv-parser';

interface BlockType {
  type: 'metadata' | 'hierarchy' | 'datatable' | 'paragraph' | 'sparse';
  confidence: number;
}

interface ReconstructedBlock {
  originalRange: { start: number; end: number };
  type: BlockType;
  markdown: string;
}

export class LayoutReconstructor {
  /**
   * Main reconstruction orchestration
   */
  async reconstruct(csvPath: string): Promise<ReconstructedBlock[]> {
    // 1. Load CSV
    const rows = await this.loadCsv(csvPath);

    // 2. Fix JSON escapes
    const fixedRows = rows.map((row) => this.fixJsonEscape(row));

    // 3. Split into blocks by empty rows
    const blocks = this.splitIntoBlocks(fixedRows);

    // 4. Identify and reconstruct each block
    const reconstructed: ReconstructedBlock[] = [];
    let globalRowIndex = 0;

    for (const block of blocks) {
      const blockType = this.identifyBlockType(block);
      const markdown = this.reconstructBlock(block, blockType);

      reconstructed.push({
        originalRange: {
          start: globalRowIndex,
          end: globalRowIndex + block.length - 1,
        },
        type: blockType,
        markdown,
      });

      globalRowIndex += block.length;
    }

    return reconstructed;
  }

  /**
   * Convenience method: reconstruct to Markdown string
   */
  async reconstructToMarkdown(csvPath: string): Promise<string> {
    const blocks = await this.reconstruct(csvPath);
    return blocks.map((b) => b.markdown).join('\n\n');
  }

  /**
   * Load CSV with UTF-8-BOM handling
   * Note: csv-parser treats first row as headers by default, which can affect fill rate calculation for sparse tables.
   * We preserve this behavior for A/B/C compatibility but document it for E-sparse scenarios.
   */
  private async loadCsv(csvPath: string): Promise<string[][]> {
    return new Promise((resolve, reject) => {
      const rows: string[][] = [];

      // Read as buffer to handle BOM, then decode as UTF-8
      fs.createReadStream(csvPath)
        .pipe(csv({ headers: false })) // Treat first row as data, not headers
        .on('data', (row: any) => {
          rows.push(Object.values(row));
        })
        .on('end', () => resolve(rows))
        .on('error', reject);
    });
  }

  /**
   * Fix JSON escapes from Feishu CSV export
   * Replaces '""' with '"' to restore broken escape sequences
   */
  private fixJsonEscape(cells: string[]): string[] {
    return cells.map((cell) => cell.replace(/""/g, '"'));
  }

  /**
   * Split rows into blocks by empty rows
   */
  private splitIntoBlocks(rows: string[][]): string[][][] {
    const blocks: string[][][] = [];
    let currentBlock: string[][] = [];

    for (const row of rows) {
      const isEmpty = row.every((cell) => !cell || cell.trim() === '');
      if (isEmpty) {
        if (currentBlock.length > 0) {
          blocks.push(currentBlock);
          currentBlock = [];
        }
      } else {
        currentBlock.push(row);
      }
    }

    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    return blocks;
  }

  /**
   * Identify block type using five-category criteria from 架构 §6.3
   */
  private identifyBlockType(block: string[][]): BlockType {
    if (block.length === 0) {
      return { type: 'paragraph', confidence: 0 };
    }

    // Criterion A: Metadata detection (first cell keyword match)
    const firstCell = block[0][0]?.toLowerCase() || '';
    const metadataKeywords = ['更新日志', '作者', '版本', '日期', '修订', '记录', '说明', '备注'];
    if (metadataKeywords.some((kw) => firstCell.includes(kw))) {
      return { type: 'metadata', confidence: 0.9 };
    }

    // Criterion B: Hierarchy detection (col_indent inconsistent)
    const colIndents = block.map((row) => {
      const idx = row.findIndex((cell) => cell && cell.trim() !== '' && cell !== '.');
      return idx === -1 ? -1 : idx;
    });

    const uniqueIndents = new Set(colIndents.filter((i) => i >= 0));
    if (uniqueIndents.size > 1) {
      return { type: 'hierarchy', confidence: 0.8 };
    }

    // Criterion D: Paragraph detection (single column long text) - check BEFORE C/E
    // Single-row paragraph or two-row paragraph where second row is single-column continuation
    if (block.length === 1 || (block.length === 2 && block[1].length === 1)) {
      return { type: 'paragraph', confidence: 0.6 };
    }

    // Criterion C vs E: Datatable vs Sparse (fill rate based)
    const totalCells = block.reduce((sum, row) => sum + row.length, 0);
    const nonEmptyCells = block.reduce((sum, row) => {
      return sum + row.filter((cell) => cell && cell.trim() !== '' && cell !== '.').length;
    }, 0);

    const fillRate = totalCells > 0 ? nonEmptyCells / totalCells : 0;
    const avgNonEmptyPerRow = nonEmptyCells / block.length;
    const validColumns = block[0]?.filter((cell) => cell && cell.trim() !== '' && cell !== '.').length || 0;

    // Criterion C: Datatable detection (priority over sparse)
    // - At least 3 rows
    // - All rows start at column 0
    // - Header has >=3 short fields
    // - Average non-empty cells per row >= 2.5
    // - Fill rate > 0.4 (absolute threshold, strictly greater than sparse)
    if (
      block.length >= 3 &&
      colIndents.every((indent) => indent === 0) &&
      validColumns >= 3 &&
      avgNonEmptyPerRow >= 2.5 &&
      fillRate > 0.4
    ) {
      return { type: 'datatable', confidence: 0.7 };
    }

    // Criterion E: Sparse detection (fill rate <= 0.4 for robustness)
    if (fillRate <= 0.4) {
      return { type: 'sparse', confidence: 0.7 };
    }

    // Default: paragraph
    return { type: 'paragraph', confidence: 0.5 };
  }

  /**
   * Reconstruct block based on type
   */
  private reconstructBlock(block: string[][], blockType: BlockType): string {
    switch (blockType.type) {
      case 'metadata':
        return this.reconstructMetadata(block);
      case 'hierarchy':
        return this.reconstructHierarchy(block);
      case 'datatable':
        return this.reconstructDatatable(block);
      case 'paragraph':
        return this.reconstructParagraph(block);
      case 'sparse':
        return this.reconstructSparse(block);
      default:
        return this.reconstructParagraph(block);
    }
  }

  /**
   * Reconstruct metadata block (folded into <details>)
   */
  private reconstructMetadata(block: string[][]): string {
    const lines = block.map((row) => `* ${row[0]}：${row.slice(1).join('、')}`);
    return `<details>\n<summary>元数据</summary>\n\n${lines.join('\n')}\n</details>\n`;
  }

  /**
   * Reconstruct hierarchy block (Markdown indented list)
   */
  private reconstructHierarchy(block: string[][]): string {
    const lines = block.map((row) => {
      const indent = row.findIndex((cell) => cell && cell.trim() !== '');
      const content = row[indent];
      const indentation = '  '.repeat(indent);
      return `${indentation}* ${content}`;
    });
    return lines.join('\n') + '\n';
  }

  /**
   * Reconstruct datatable block (clean Markdown table, trim empty columns)
   */
  private reconstructDatatable(block: string[][]): string {
    if (block.length === 0) return '';

    // Trim empty columns on the right
    const trimmedBlock = block.map((row) => {
      // Find last non-empty cell
      let lastNonEmpty = row.length - 1;
      for (let i = row.length - 1; i >= 0; i--) {
        if (row[i] && row[i].trim() !== '') {
          lastNonEmpty = i;
          break;
        }
      }
      return row.slice(0, lastNonEmpty + 1);
    });

    const header = '| ' + trimmedBlock[0].join(' | ') + ' |';
    const separator = '| ' + trimmedBlock[0].map(() => '---').join(' | ') + ' |';
    const rows = trimmedBlock.slice(1).map((row) => '| ' + row.join(' | ') + ' |');
    return [header, separator, ...rows].join('\n') + '\n';
  }

  /**
   * Reconstruct paragraph block (normal paragraph)
   */
  private reconstructParagraph(block: string[][]): string {
    const lines = block.map((row) => row.join(' ').trim());
    return lines.join('\n') + '\n';
  }

  /**
   * Reconstruct sparse block (parameter:value list)
   */
  private reconstructSparse(block: string[][]): string {
    const lines = block.map((row) => {
      const firstNonEmpty = row.find((cell) => cell && cell.trim() !== '');
      if (!firstNonEmpty) return '';

      // Split by '：' (Chinese colon) or ':'
      const parts = firstNonEmpty.split(/：|:/);
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join(':').trim();
        return `* **${key}**：${value}`;
      }
      return `* ${firstNonEmpty}`;
    });
    return lines.filter((line) => line).join('\n') + '\n';
  }
}
