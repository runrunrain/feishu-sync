/**
 * computeLineDiff 单测（P0-S5）——与 server kb/line-diff 同源算法的前端版：
 * 前后缀修剪 / LCS 对齐 / 整块退化 / 上下文窗口 / 截断上限。
 */

import { describe, expect, it } from 'vitest';
import { computeLineDiff } from './lineDiff';

describe('computeLineDiff 基础行为', () => {
  it('两侧一致 → identical，无行', () => {
    const result = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(result.identical).toBe(true);
    expect(result.rows).toHaveLength(0);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });

  it('纯追加：+ 行带新行号、无旧行号', () => {
    const result = computeLineDiff('第一行\n第二行', '第一行\n第二行\n第三行');
    expect(result.identical).toBe(false);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(0);
    const added = result.rows.filter((row) => row.kind === '+');
    expect(added.map((row) => row.text)).toEqual(['第三行']);
    expect(added[0].newLine).toBe(3);
    expect(added[0].oldLine).toBeNull();
  });

  it('修改一行：一删一增，行号对齐', () => {
    const result = computeLineDiff('第一行\n旧第二行\n第三行', '第一行\n新第二行\n第三行');
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.rows.find((row) => row.kind === '-')?.text).toBe('旧第二行');
    expect(result.rows.find((row) => row.kind === '+')?.text).toBe('新第二行');
  });

  it('删除多行：- 行带旧行号', () => {
    const result = computeLineDiff('a\nb\nc\nd\ne', 'a\ne');
    expect(result.deletions).toBe(3);
    expect(result.additions).toBe(0);
    const removed = result.rows.filter((row) => row.kind === '-').map((row) => row.text);
    expect(removed).toEqual(['b', 'c', 'd']);
  });

  it('空串一侧：全增或全删', () => {
    expect(computeLineDiff('', 'x\ny').additions).toBe(2);
    expect(computeLineDiff('x\ny', '').deletions).toBe(2);
  });
});

describe('computeLineDiff 上下文窗口与有界性', () => {
  it('差异行 ±3 行上下文可见，远处公共行折叠', () => {
    const before = Array.from({ length: 30 }, (_, i) => `行${i + 1}`).join('\n');
    const after = before.replace('行15', '行十五');
    const result = computeLineDiff(before, after);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    // 差异附近（12~18 行）可见；首尾远处不可见。
    const texts = result.rows.map((row) => row.text);
    expect(texts).toContain('行12');
    expect(texts).toContain('行18');
    expect(texts).not.toContain('行3');
    // 行号保持旧行号序列。
    const minusRow = result.rows.find((row) => row.kind === '-')!;
    expect(minusRow.oldLine).toBe(15);
  });

  it('超限（>1e6 LCS 格）退化为整块替换，不抛错', () => {
    const before = Array.from({ length: 1200 }, (_, i) => `旧${i}`).join('\n');
    const after = Array.from({ length: 1200 }, (_, i) => `新${i}`).join('\n');
    const result = computeLineDiff(before, after);
    expect(result.deletions).toBe(1200);
    expect(result.additions).toBe(1200);
    expect(result.rows.filter((row) => row.kind === '-')).toHaveLength(1200);
  });

  it('maxRows 截断：truncated=true，统计仍完整', () => {
    const before = Array.from({ length: 50 }, (_, i) => `旧${i}`).join('\n');
    const after = Array.from({ length: 50 }, (_, i) => `新${i}`).join('\n');
    const result = computeLineDiff(before, after, { maxRows: 10 });
    expect(result.rows.length).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
    expect(result.additions).toBe(50);
    expect(result.deletions).toBe(50);
  });

  it('相邻差异合并展示（无 hunk 分隔需求，行流连续；LCS 平局时 + 先于 -，与 server 版同序）', () => {
    const result = computeLineDiff('a\nb\nc\nd', 'a\nB\nc\nD');
    const kinds = result.rows.filter((row) => row.kind !== ' ').map((row) => row.kind + row.text);
    expect(kinds).toEqual(['+B', '-b', '+D', '-d']);
  });
});
