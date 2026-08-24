/**
 * MarkdownView - 轻量 Markdown 渲染器（v0.2.8 预览面板）
 *
 * 设计约束：项目要求断网可读、零运行时依赖，因此不引入 react-markdown，
 * 自研覆盖同步产物的常见语法子集：
 *   - ATX 标题（# ~ ######）
 *   - ``` 围栏代码块（保留语言标记展示）
 *   - GFM 管道表格
 *   - 无序/有序列表（按缩进支持嵌套）
 *   - 引用块、水平线、段落
 *   - 行内：**粗体** / *斜体* / ~~删除线~~ / `行内码` / [链接](url) / 图片占位
 *
 * 纯函数解析 + React 渲染，只读预览不做编辑。样式沿用宣纸/墨色设计 token。
 */

import { Fragment, type JSX, type ReactNode } from 'react';
import { ImageIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

const INLINE_RE =
  /(!\[[^\]]*\]\([^)]*\))|(\[[^\]]*\]\([^)]*\))|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(~~[^~]+~~)|(`[^`]+`)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('![')) {
      // 图片：本地相对路径无法直接渲染，显示占位徽章
      const alt = token.slice(2, token.indexOf(']'));
      out.push(
        <span
          key={key}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-sm bg-paper-2 border border-line text-[11px] text-ink-faint align-middle"
          title={token}
        >
          <ImageIcon className="w-3 h-3" />
          {alt || '图片'}
        </span>,
      );
    } else if (token.startsWith('[')) {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      out.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-jade hover:text-seal underline underline-offset-2 decoration-line hover:decoration-seal transition-colors"
        >
          {label}
        </a>,
      );
    } else if (token.startsWith('**')) {
      out.push(
        <strong key={key} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('~~')) {
      out.push(
        <del key={key} className="text-ink-faint">
          {token.slice(2, -2)}
        </del>,
      );
    } else if (token.startsWith('`')) {
      out.push(
        <code
          key={key}
          className="px-1 py-0.5 mx-0.5 rounded-sm bg-paper-2 border border-line/60 text-[0.85em] text-seal font-mono"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      // *斜体*
      out.push(
        <em key={key} className="text-ink-soft">
          {token.slice(1, -1)}
        </em>,
      );
    }
    last = idx + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; items: { indent: number; text: string }[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line.trim());
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 围栏代码块
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang: fence[1] ?? '', lines: buf });
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: heading[2].trim(),
      });
      i++;
      continue;
    }

    // 水平线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (
        i < lines.length &&
        lines[i].includes('|') &&
        lines[i].trim() !== ''
      ) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // 列表（按缩进嵌套）
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[2]);
      const items: { indent: number; text: string }[] = [];
      while (i < lines.length) {
        const lm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!lm) break;
        items.push({ indent: lm[1].length, text: lm[3] });
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: buf });
      continue;
    }

    // 段落：合并连续普通行
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) &&
      !(
        lines[i].includes('|') &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      ) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: buf.join(' ') });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// 块级渲染
// ---------------------------------------------------------------------------

const HEADING_CLASS: Record<number, string> = {
  1: 'text-xl font-kai font-medium text-ink mt-6 mb-3 pb-2 border-b border-line/60 first:mt-0',
  2: 'text-lg font-kai font-medium text-ink mt-5 mb-2.5 first:mt-0',
  3: 'text-base font-kai font-medium text-ink mt-4 mb-2 first:mt-0',
  4: 'text-sm font-kai font-medium text-ink-soft mt-3 mb-1.5 first:mt-0',
  5: 'text-sm font-medium text-ink-soft mt-3 mb-1.5 first:mt-0',
  6: 'text-xs font-medium text-ink-faint mt-2 mb-1 first:mt-0',
};

function renderList(
  block: Extract<Block, { type: 'list' }>,
  keyPrefix: string,
): JSX.Element {
  // 按 indent 分层：indent === 基准值 为一层；更大缩进归入子层。
  const baseIndent = Math.min(...block.items.map((it) => it.indent));
  const levels: { indent: number; text: string }[][] = [];
  for (const item of block.items) {
    const depth = Math.round((item.indent - baseIndent) / 2);
    if (!levels[depth]) levels[depth] = [];
    levels[depth].push(item);
  }
  // 简化渲染：一层列表 + 缩进 padding 表示嵌套，避免复杂递归树。
  const ListTag = block.ordered ? 'ol' : 'ul';
  return (
    <ListTag
      className={`my-2 space-y-1 text-sm leading-relaxed text-ink-soft ${
        block.ordered ? 'list-decimal' : 'list-disc'
      }`}
    >
      {block.items.map((item, idx) => (
        <li
          key={`${keyPrefix}-${idx}`}
          style={{ marginLeft: `${16 + Math.max(0, item.indent - baseIndent) * 1.5}px` }}
          className="pl-1 marker:text-jade"
        >
          {renderInline(item.text, `${keyPrefix}-${idx}`)}
        </li>
      ))}
    </ListTag>
  );
}

function renderBlock(block: Block, index: number): ReactNode {
  const key = `b-${index}`;
  switch (block.type) {
    case 'heading':
      return (
        <div key={key} className={HEADING_CLASS[block.level] ?? HEADING_CLASS[6]}>
          {renderInline(block.text, key)}
        </div>
      );
    case 'code':
      return (
        <div key={key} className="my-3 rounded-md border border-line/70 bg-dark overflow-hidden">
          {block.lang && (
            <div className="px-3 py-1.5 text-[10px] font-mono text-paper/60 border-b border-paper/10 bg-dark">
              {block.lang}
            </div>
          )}
          <pre className="px-3.5 py-3 text-xs leading-relaxed text-paper font-mono overflow-x-auto scrollbar-thin">
            {block.lines.join('\n')}
          </pre>
        </div>
      );
    case 'table':
      return (
        <div key={key} className="my-3 overflow-x-auto scrollbar-thin rounded-md border border-line/70">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-paper-2">
                {block.header.map((cell, ci) => (
                  <th
                    key={ci}
                    className="px-3 py-2 text-left font-medium text-ink border-b border-line whitespace-nowrap"
                  >
                    {renderInline(cell, `${key}-h${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 1 ? 'bg-paper/60' : 'bg-card-bg'}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="px-3 py-1.5 text-ink-soft border-b border-line/40 align-top"
                    >
                      {renderInline(cell, `${key}-r${ri}c${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list':
      return renderList(block, key);
    case 'quote':
      return (
        <blockquote
          key={key}
          className="my-3 pl-3 border-l-2 border-jade/60 text-sm text-ink-soft italic space-y-1"
        >
          {block.lines.map((l, li) => (
            <p key={li}>{renderInline(l, `${key}-q${li}`)}</p>
          ))}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} className="my-4 border-line/60" />;
    case 'paragraph':
      return (
        <p key={key} className="my-2 text-sm leading-relaxed text-ink-soft">
          {renderInline(block.text, key)}
        </p>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 组件出口
// ---------------------------------------------------------------------------

export function MarkdownView({ content }: { content: string }) {
  const blocks = parseBlocks(content);
  return (
    <div className="px-5 py-4">
      {blocks.map((b, i) => (
        <Fragment key={i}>{renderBlock(b, i)}</Fragment>
      ))}
    </div>
  );
}
