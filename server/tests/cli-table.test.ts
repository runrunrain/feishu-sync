/**
 * CLI 人类模式表格渲染（G 项）：命中形态对齐表格，其余回退原渲染。
 *
 * --json 输出不受表格层影响（包络直出）。
 */

import { describe, expect, it, vi } from 'vitest';
import { displayWidth, tryRenderTable } from '../src/cli/table.js';
import { printOk } from '../src/cli/output.js';

describe('displayWidth（CJK 记 2）', () => {
  it('基础宽度', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a中')).toBe(3);
    expect(displayWidth('ＡＢ')).toBe(4); // 全角 ASCII
    expect(displayWidth('')).toBe(0);
  });
});

describe('命中形态：对齐表格', () => {
  it('直接对象数组：表头 + 分隔线 + 行 + --json 提示', () => {
    const lines = tryRenderTable([
      { id: 1, status: 'ok' },
      { id: 2, status: 'failed' },
    ])!;
    expect(lines).not.toBeNull();
    expect(lines[0]).toBe('id  status');
    expect(lines[1]).toBe('--  ------');
    expect(lines[2]).toBe('1   ok');
    expect(lines[3]).toBe('2   failed');
    expect(lines.at(-1)).toBe('（--json 查看完整字段）');
  });

  it('第一层唯一数组字段（{builds:[…]}）作为行源，其余标量键附在表后', () => {
    const lines = tryRenderTable({
      builds: [
        { id: '42', mode: 'incremental' },
        { id: '43', mode: 'full' },
      ],
      total: 2,
    })!;
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('mode');
    expect(lines.some((line) => line.includes('total：2'))).toBe(true);
  });

  it('CJK 对齐：中文单元格按显示宽度补齐', () => {
    const lines = tryRenderTable([
      { name: '成功', code: 'A' },
      { name: 'succeeded', code: 'B' },
    ])!;
    // '成功'（宽 4）补到列宽 9（'succeeded'），与下一行同列对齐
    expect(lines[2].split(/\s{2,}/)).toEqual(['成功', 'A']);
    expect(lines[3].split(/\s{2,}/)).toEqual(['succeeded', 'B']);
  });

  it('多数标量键的个别嵌套单元格显示 {…}/[n项]，不整列剔除', () => {
    const lines = tryRenderTable([
      { id: '1', status: 'ok', note: 'x' },
      { id: '2', status: { code: 5 }, note: ['a', 'b'] },
    ])!;
    expect(lines[0].split(/\s{2,}/)).toEqual(['id', 'status', 'note']);
    expect(lines[3]).toContain('{…}');
    expect(lines[3]).toContain('[2项]');
  });

  it('超 40 显示宽度截断补 …', () => {
    const long = 'x'.repeat(60);
    const lines = tryRenderTable([{ note: long }])!;
    const cell = lines[2];
    expect(cell.endsWith('…')).toBe(true);
    expect(displayWidth(cell)).toBeLessThanOrEqual(40);
    const cjkLong = '中文说明'.repeat(20);
    const cjkLines = tryRenderTable([{ note: cjkLong }])!;
    expect(displayWidth(cjkLines[2])).toBeLessThanOrEqual(40);
  });

  it('列取频率最高的前 8 个标量键（同频保持首次出现顺序）', () => {
    const row: Record<string, number | string> = {};
    for (let i = 0; i < 10; i += 1) row[`col${i}`] = i;
    const lines = tryRenderTable([row])!;
    const header = lines[0];
    const columns = header.trim().split(/\s{2,}/);
    expect(columns.length).toBe(8);
    expect(columns[0]).toBe('col0');
    // 频率排序：普遍出现的键多一行的优先
    const lines2 = tryRenderTable([
      { a: 1, b: 1, c: 1 },
      { a: 2, b: 2 },
      { d: 4, a: 3 },
    ])!;
    expect(lines2[0].startsWith('a')).toBe(true);
  });

  it('缺失键单元格显示 —', () => {
    const lines = tryRenderTable([
      { id: '1', note: 'x' },
      { id: '2' },
    ])!;
    expect(lines[3]).toContain('—');
  });
});

describe('非命中形态：回退原渲染（返回 null）', () => {
  it.each([
    ['标量数组', ['a', 'b']],
    ['空数组', []],
    ['纯标量对象', { a: 1 }],
    ['两个数组字段', { items: [{ a: 1 }], others: [{ b: 2 }] }],
    ['数组元素非对象', { items: [1, 2] }],
    ['嵌套数组', { items: [[1]] }],
  ])('%s → null', (_name, data) => {
    expect(tryRenderTable(data)).toBeNull();
  });

  it('元素全为嵌套对象字段（无标量列）→ null', () => {
    expect(tryRenderTable([{ a: { x: 1 } }, { a: { x: 2 } }])).toBeNull();
  });
});

describe('printOk 集成', () => {
  /** 捕获 process.stdout.write。 */
  function capture(fn: () => void): string {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
    try {
      fn();
      return chunks.join('');
    } finally {
      (process.stdout as unknown as { write: (s: string) => boolean }).write = orig;
    }
  }

  it('人类模式：对象数组走表格', () => {
    const out = capture(() => printOk({ items: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] }, { json: false }));
    expect(out).toContain('a');
    expect(out).toContain('（--json 查看完整字段）');
  });

  it('--json 输出完全不变（不走表格层）', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      printOk({ items: [{ a: 1 }] }, { json: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ ok: true, data: { items: [{ a: 1 }] } });
    } finally {
      spy.mockRestore();
    }
  });
});
