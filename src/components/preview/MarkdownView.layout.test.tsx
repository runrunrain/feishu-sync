// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from './MarkdownView';

describe('Markdown 阅读布局', () => {
  it('保留空表格行和单元格的数量、顺序以及内容', () => {
    const content = '|  |  | 近战 | 远程 |  |\n|-|-|-|-|-|\n| 弓兵 |  |  |  |  |\n|  |  |  |  |  |\n| 步兵 |  |  |  |  |';
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<MarkdownView content={content} />);
    const table = container.querySelector('table')!;
    expect(container.querySelector('[role="region"][tabindex="0"]')).not.toBeNull();
    expect(table.querySelectorAll('thead th')).toHaveLength(5);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(table.querySelectorAll('tbody tr')[1].getAttribute('data-md-empty-row')).toBe('true');
    expect(table.querySelectorAll('tbody tr')[1].querySelectorAll('td')).toHaveLength(5);
    expect([...table.querySelectorAll('tbody tr')].map((row) => row.textContent)).toEqual(['弓兵', '', '步兵']);
  });

  it('原始 HTML 表格的合并、列宽和对齐继续保留，代码块保留文本', () => {
    const content = '<table><colgroup><col width="120px"><col width="160px"></colgroup><thead><tr><th colspan="2">规则</th></tr></thead><tbody><tr><td rowspan="2" align="right">A</td><td>第一行</td></tr><tr><td>第二行</td></tr></tbody></table>\n\n```xml\n<table>示例</table>\n```';
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<MarkdownView variant="reading" content={content} />);
    expect(container.querySelector('.markdown-reading')).not.toBeNull();
    expect(container.querySelector('col')?.style.width).toBe('120px');
    expect(container.querySelector('th')?.getAttribute('colspan')).toBe('2');
    expect(container.querySelector('td')?.getAttribute('rowspan')).toBe('2');
    expect(container.querySelector('td')?.className).toContain('text-right');
    expect(container.querySelector('pre code')?.textContent).toBe('<table>示例</table>');
  });
});
