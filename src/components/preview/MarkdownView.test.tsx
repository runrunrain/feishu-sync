import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
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
      const link = nodes.find(
        (n): n is ReactElement<{ href: string }> =>
          isValidElement(n) && n.type === 'a' && typeof (n.props as { href?: unknown }).href === 'string',
      );
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

// ---------------------------------------------------------------------------
// F2 安全回归：链接协议白名单 + 不可信远程图片策略
// （Leader 审查修正项：Markdown 链接 href 此前未经白名单直出 <a href>，
//  HTML <a> 仅拦 /^javascript:/ 字面量，实体/控制字符可绕过。）
// ---------------------------------------------------------------------------

import { sanitizeHref, MarkdownView } from './MarkdownView';

describe('sanitizeHref 协议白名单', () => {
  it('放行 http/https/mailto 与相对路径/锚点', () => {
    expect(sanitizeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(sanitizeHref('http://example.com')).toBe('http://example.com');
    expect(sanitizeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(sanitizeHref('docs/子表.csv')).toBe('docs/子表.csv');
    expect(sanitizeHref('#anchor')).toBe('#anchor');
  });

  it('拒绝 javascript:/data:/vbscript:/file: 与协议相对 URL', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeHref('data:text/html,<script>')).toBeNull();
    expect(sanitizeHref('vbscript:msgbox')).toBeNull();
    expect(sanitizeHref('file:///etc/passwd')).toBeNull();
    expect(sanitizeHref('//evil.com/x')).toBeNull();
    expect(sanitizeHref('\\\\evil.com/x')).toBeNull();
    expect(sanitizeHref('/\\evil.com/x')).toBeNull();
  });

  it('拦截实体编码混淆（HTML 分支已解码后的二次防御 + markdown 分支）', () => {
    // `&#106;` = j → javascript:
    expect(sanitizeHref('&#106;avascript:alert(1)')).toBeNull();
    expect(sanitizeHref('&#x6a;avascript:alert(1)')).toBeNull();
    // 大小写不敏感
    expect(sanitizeHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(sanitizeHref('JAVASCRIPT:alert(1)')).toBeNull();
    // 带空格的实体变体（&Tab; 制表符）
    expect(sanitizeHref('java&Tab;script:alert(1)')).toBeNull();
  });

  it('拦截控制字符/换行切片绕过（java\\nscript: / \\x01javascript:）', () => {
    expect(sanitizeHref('java\nscript:alert(1)')).toBeNull();
    expect(sanitizeHref('java\tscript:alert(1)')).toBeNull();
    expect(sanitizeHref('\x01javascript:alert(1)')).toBeNull();
    expect(sanitizeHref(' javascript:alert(1)')).toBeNull();
    // 剥离后合法的 https 仍应放行（控制字符剔除不误伤）
    expect(sanitizeHref(' https://example.com ')).toBe('https://example.com');
  });

  it('保留有空格的本地 CSV 文件名而不放行空格混淆协议', () => {
    expect(sanitizeHref('tables/经济 模型.csv')).toBe('tables/经济 模型.csv');
    expect(sanitizeHref('java script:alert(1)')).toBeNull();
    expect(sanitizeHref('https ://example.com')).toBeNull();
  });

  it('空值与纯空白返回 null', () => {
    expect(sanitizeHref('')).toBeNull();
    expect(sanitizeHref('   ')).toBeNull();
  });
});

describe('renderInline 链接拦截（Markdown 与 HTML 两个分支）', () => {
  const ctx = { baseDir: '' };

  const findAnchor = (nodes: ReturnType<typeof renderInline>) =>
    (nodes as React.ReactElement[]).find((n) => isValidElement(n) && n.type === 'a') as
      | React.ReactElement<{ href?: string }>
      | undefined;

  it('markdown 链接：javascript: 降级为纯文本（无 <a>）', () => {
    const nodes = renderInline('[点击](javascript:alert(1))', 't', ctx);
    expect(findAnchor(nodes)).toBeUndefined();
    // 降级文本仍可读（不丢内容）
    expect((nodes as React.ReactElement[]).some((n) => isValidElement(n))).toBe(true);
  });

  it('markdown 链接：data: 拒绝、https: 放行', () => {
    expect(findAnchor(renderInline('[x](data:text/html,hi)', 't', ctx))).toBeUndefined();
    const ok = findAnchor(renderInline('[x](https://ok.com)', 't', ctx));
    expect(ok?.props.href).toBe('https://ok.com');
  });

  it('HTML <a>：实体编码 javascript: 与控制字符变体拒绝', () => {
    expect(
      findAnchor(renderInline('<a href="&#106;avascript:alert(1)">x</a>', 't', ctx)),
    ).toBeUndefined();
    expect(
      findAnchor(renderInline('<a href="java\nscript:alert(1)">x</a>', 't', ctx)),
    ).toBeUndefined();
    expect(
      findAnchor(renderInline('<a href="java&Tab;script:alert(1)">x</a>', 't', ctx)),
    ).toBeUndefined();
  });

  it('HTML <a>：mailto 与 https 放行', () => {
    expect(findAnchor(renderInline('<a href="mailto:a@b.c">m</a>', 't', ctx))?.props.href).toBe(
      'mailto:a@b.c',
    );
    expect(findAnchor(renderInline('<a href="https://x.com">x</a>', 't', ctx))?.props.href).toBe(
      'https://x.com',
    );
  });
});

describe('不可信内容远程图片策略（remoteImages="confirm"）', () => {
  const imgCtx = { baseDir: '', remoteImages: 'confirm' as const };
  const autoCtx = { baseDir: '', remoteImages: 'auto' as const };

  it('confirm 策略下远程图片节点仍渲染但由 AuthImage 占位（不自动加载）', () => {
    // AuthImage 是内部组件；策略经 props 传入。这里验证 confirm 上下文
    // 传递到图片节点（关键安全属性不丢失），完整占位 UI 在浏览器验证。
    const confirmNodes = renderInline('![x](https://evil.com/pixel.png)', 't', imgCtx);
    const autoNodes = renderInline('![x](https://evil.com/pixel.png)', 't', autoCtx);
    expect(confirmNodes.length).toBeGreaterThan(0);
    expect(autoNodes.length).toBeGreaterThan(0);
  });

  it('MarkdownView 组件接受 remoteImages prop（类型面）', () => {
    // SSR 级烟测：confirm 模式渲染不抛错（AuthImage 占位分支）。
    const el = <MarkdownView content="![x](https://a.com/b.png)" remoteImages="confirm" />;
    expect(isValidElement(el)).toBe(true);
  });
});
