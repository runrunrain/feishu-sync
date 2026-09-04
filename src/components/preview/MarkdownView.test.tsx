import { describe, expect, it } from 'vitest';
import { parseBlocks, renderInline, resolveMediaPath } from './MarkdownView';
import type { HtmlTableBlock } from '../../utils/html-table';

describe('MarkdownView parser and renderer', () => {
  describe('parseBlocks with HTML table', () => {
    it('recognises standalone block-level HTML tables with colspan and rowspan', () => {
      const content = `
# 标题

前置说明

<table>
  <thead>
    <tr>
      <th vertical-align="top">机制</th>
      <th vertical-align="top">部队</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td colspan="2" vertical-align="top"><b>合并表头</b></td>
    </tr>
    <tr>
      <td rowspan="2" vertical-align="top">多行跨越</td>
      <td vertical-align="top">数值 A</td>
    </tr>
    <tr>
      <td vertical-align="top">数值 B</td>
    </tr>
  </tbody>
</table>

后置说明
      `.trim();

      const blocks = parseBlocks(content);
      expect(blocks.length).toBe(4);
      expect(blocks[0].type).toBe('heading');
      expect(blocks[1].type).toBe('paragraph');

      const tableBlock = blocks[2] as HtmlTableBlock;
      expect(tableBlock.type).toBe('html_table');
      expect(tableBlock.headRows.length).toBe(1);
      expect(tableBlock.headRows[0].cells.length).toBe(2);

      // Verify colspan on Row 0
      expect(tableBlock.bodyRows[0].cells[0].colspan).toBe(2);
      expect(tableBlock.bodyRows[0].cells[0].content).toBe('<b>合并表头</b>');

      // Verify rowspan on Row 1
      expect(tableBlock.bodyRows[1].cells[0].rowspan).toBe(2);
      expect(tableBlock.bodyRows[1].cells[0].content).toBe('多行跨越');

      expect(blocks[3].type).toBe('paragraph');
    });

    it('handles single-line HTML table properly', () => {
      const line = '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>';
      const blocks = parseBlocks(line);
      expect(blocks.length).toBe(1);
      expect(blocks[0].type).toBe('html_table');
    });
  });

  describe('renderInline with cite and inline tags', () => {
    const ctx = {
      baseDir: '',
      feishuHost: 'qcnbafdrjx7n.feishu.cn',
    };

    it('renders cite tag as clickable link with title and host URL', () => {
      const input = '详细参考<cite doc-id="DUZzwzedWiXmeSk9gGscuWCuneh" file-type="wiki" title="战斗实体感知吸引力-300 by 小星" type="doc"></cite>';
      const nodes = renderInline(input, 'test', ctx);

      expect(nodes.length).toBe(2);
      expect(nodes[0]).toBe('详细参考');

      const linkNode = nodes[1] as any;
      expect(linkNode.type).toBe('a');
      expect(linkNode.props.href).toBe('https://qcnbafdrjx7n.feishu.cn/wiki/DUZzwzedWiXmeSk9gGscuWCuneh');
      expect(linkNode.props.title).toBe('https://qcnbafdrjx7n.feishu.cn/wiki/DUZzwzedWiXmeSk9gGscuWCuneh');
      expect(linkNode.props.children).toBe('战斗实体感知吸引力-300 by 小星');
      expect(linkNode.props.className).toContain('text-blue-600');
    });

    it('falls back to docId when title is missing in cite tag', () => {
      const input = '<cite doc-id="TOKEN123" file-type="wiki" type="doc"></cite>';
      const nodes = renderInline(input, 'test', ctx);

      expect(nodes.length).toBe(1);
      const linkNode = nodes[0] as any;
      expect(linkNode.props.children).toBe('TOKEN123');
      expect(linkNode.props.href).toBe('https://qcnbafdrjx7n.feishu.cn/wiki/TOKEN123');
    });

    it('falls back to plain text for user cite tag without doc-id', () => {
      const input = '由<cite type="user" user-name="赵春玉(Joey)"></cite>确认';
      const nodes = renderInline(input, 'test', ctx);

      expect(nodes.length).toBe(3);
      expect(nodes[0]).toBe('由');
      const spanNode = nodes[1] as any;
      expect(spanNode.type).toBe('span');
      expect(spanNode.props.children).toBe('@赵春玉(Joey)');
      expect(nodes[2]).toBe('确认');
    });

    it('handles empty cite tag without crashing', () => {
      const input = '前置<cite></cite>后置';
      const nodes = renderInline(input, 'test', ctx);
      expect(nodes).toEqual(['前置', '后置']);
    });

    it('renders inline <b>, <i>, <br/> and unescapes &gt; properly', () => {
      const input = '<b>粗体</b><br/><i>斜体</i> &gt; 100';
      const nodes = renderInline(input, 'test', ctx);

      expect(nodes.length).toBe(4);
      expect((nodes[0] as any).type).toBe('strong');
      expect((nodes[1] as any).type).toBe('br');
      expect((nodes[2] as any).type).toBe('em');
      expect(nodes[3]).toBe(' > 100');
    });
  });

  describe('resolveMediaPath win-backslash normalization (2026-09-04 浮动图片修复)', () => {
    it('normalizes backslash separators in both src and baseDir', () => {
      expect(resolveMediaPath('images\\主表_A7_fip1.png', '技术 - Dev\\子目录')).toBe(
        '技术 - Dev/子目录/images/主表_A7_fip1.png',
      );
    });

    it('keeps POSIX behavior unchanged', () => {
      expect(resolveMediaPath('images/a.png', '技术 - Dev')).toBe('技术 - Dev/images/a.png');
      expect(resolveMediaPath('./images/../images/a.png', '技术 - Dev')).toBe('技术 - Dev/images/a.png');
    });
  });

  describe('inline image src with half-width parentheses (2026-09-04 浮动图片修复)', () => {
    const ctx = { baseDir: 'test' };

    // 实测样本：同步产物文件名含半角括号，旧模式 [^)\n]* 在首个 ) 截断
    it('keeps full src when filename contains paired parentheses', () => {
      const line = '![③-1(Framwork)分析拆解（确定复杂度） B63 浮动图片](images/③-1(Framwork)分析拆解（确定复杂度）_B63_DbT4OWAt8s.png)';
      const blocks = parseBlocks(line);
      expect(blocks.length).toBeGreaterThan(0);
      const paragraph = blocks[0] as { type: string; text?: string };
      expect(paragraph.type).toBe('paragraph');
      expect(paragraph.text).toBe(line);
    });

    it('keeps csv link href intact with paired parentheses', () => {
      const line = '[CSV 原始数据](300-三观系统.csv-data/③-1(Framwork)分析拆解（确定复杂度）.csv)';
      const nodes = renderInline(line, 't', ctx);
      const link = nodes.find((n): n is { type: string; props: { href: string } } =>
        typeof n === 'object' && n !== null && 'props' in (n as object) && 'href' in (n as { props: unknown }).props as object);
      expect(link).toBeTruthy();
      expect(link!.props.href).toBe('300-三观系统.csv-data/③-1(Framwork)分析拆解（确定复杂度）.csv');
    });

    it('still truncates safely on unpaired open paren (fallback behavior)', () => {
      const nodes = renderInline('![alt](images/a(b.png)', 't', ctx);
      // 未闭合括号：回退旧行为（在 ( 处截断），不崩溃、不丢整段
      expect(nodes.length).toBeGreaterThan(0);
    });
  });
});
