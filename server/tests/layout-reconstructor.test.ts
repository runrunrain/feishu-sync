/**
 * LayoutReconstructor 专项测试（T0a D4 修复轮首次补齐——此前无专项测试）。
 *
 * 覆盖：
 *   - C 型 datatable 单元格转义：`|` → `\|`、换行 → <br>（T0a D4 主项）
 *   - A/B/E 型列表路径的单元格换行折叠（D4 附带：列表项不被拆散）
 *   - 五型分类的锚定用例（转义断言所依赖的分型先验）
 *
 * CSV 经真实 csv-parser 解析（含带引号多行单元格），落在临时目录；
 * 不触碰 better-sqlite3，无 ABI 依赖。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LayoutReconstructor } from '../src/modules/layout-reconstructor.js';

const tempDirs: string[] = [];

function writeCsv(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-layout-recon-'));
  tempDirs.push(dir);
  const csvPath = path.join(dir, 'sheet.csv');
  fs.writeFileSync(csvPath, text, 'utf-8');
  return csvPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('LayoutReconstructor: C 型 datatable 单元格转义（T0a D4）', () => {
  it('转义 | 与换行：含特殊字符的单元格不拆散表格列', async () => {
    const csvPath = writeCsv(
      '名称,路径,说明\n' +
        'alpha,p|q,"两行\n续行"\n' +
        'beta,plain,文本\n',
    );
    const blocks = await new LayoutReconstructor().reconstruct(csvPath);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type.type).toBe('datatable');
    const lines = blocks[0].markdown.split('\n');
    expect(lines[0]).toBe('| 名称 | 路径 | 说明 |');
    expect(lines[1]).toBe('| --- | --- | --- |');
    // `p|q` 不得拆出新列；单元格内换行折叠为 <br> 而不是拆散表格行。
    expect(lines[2]).toBe('| alpha | p\\|q | 两行<br>续行 |');
    expect(lines[3]).toBe('| beta | plain | 文本 |');
  });

  it('表头单元格同样转义（header 行含 | 不产生幻影列）', async () => {
    const csvPath = writeCsv(
      '字段|A,字段|B,字段|C\n' + 'x,y,z\n' + '1,2,3\n',
    );
    const blocks = await new LayoutReconstructor().reconstruct(csvPath);

    expect(blocks[0].type.type).toBe('datatable');
    const lines = blocks[0].markdown.split('\n');
    expect(lines[0]).toBe('| 字段\\|A | 字段\\|B | 字段\\|C |');
    expect(lines[1]).toBe('| --- | --- | --- |');
    expect(lines[2]).toBe('| x | y | z |');
    // 全表列数恒定：每行 4 个未转义分隔（3 列）。
    for (const line of lines.slice(0, 4)) {
      expect(line.match(/(?<!\\)\|/g)).toHaveLength(4);
    }
  });
});

describe('LayoutReconstructor: A/B/E 型列表路径换行折叠（T0a D4 附带）', () => {
  it('A 型 metadata：多行单元格折叠为 <br>，列表项保持单行', async () => {
    const csvPath = writeCsv('更新日志,"2026-06-15\nv2 修订"\n');
    const blocks = await new LayoutReconstructor().reconstruct(csvPath);

    expect(blocks[0].type.type).toBe('metadata');
    const markdown = blocks[0].markdown;
    expect(markdown).toContain('* 更新日志：2026-06-15<br>v2 修订');
    expect(markdown.split('\n').filter((line) => line.startsWith('* '))).toHaveLength(1);
  });

  it('B 型 hierarchy：层级项内容含换行时折叠，不拆散列表结构', async () => {
    const csvPath = writeCsv('根节点,,\n,"子\n项",\n孙节点,,\n');
    const blocks = await new LayoutReconstructor().reconstruct(csvPath);

    expect(blocks[0].type.type).toBe('hierarchy');
    const lines = blocks[0].markdown.split('\n');
    expect(lines[0]).toBe('* 根节点');
    expect(lines[1]).toBe('  * 子<br>项');
    expect(lines[2]).toBe('* 孙节点');
  });

  it('E 型 sparse：key:value 值含换行时折叠为 <br>', async () => {
    const csvPath = writeCsv(
      '"配置项: 多行\n值",,,,末尾\n备注说明,,,,锚点\n空行示例,,,,结尾示例\n',
    );
    const blocks = await new LayoutReconstructor().reconstruct(csvPath);

    expect(blocks[0].type.type).toBe('sparse');
    const markdown = blocks[0].markdown;
    expect(markdown).toContain('* **配置项**：多行<br>值');
    expect(markdown).toContain('* 备注说明');
    expect(markdown.split('\n').filter((line) => line.startsWith('* '))).toHaveLength(3);
  });
});

describe('LayoutReconstructor: 块级组装', () => {
  it('空行分隔的多个块按序拼接（reconstructToMarkdown）', async () => {
    const csvPath = writeCsv('段落一\n\n更新日志,v1\n');
    const markdown = await new LayoutReconstructor().reconstructToMarkdown(csvPath);

    expect(markdown).toContain('段落一');
    expect(markdown).toContain('* 更新日志：v1');
    // 两块之间以空行衔接。
    expect(markdown.indexOf('段落一')).toBeLessThan(markdown.indexOf('更新日志'));
  });
});
