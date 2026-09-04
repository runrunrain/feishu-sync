/**
 * MarkdownView - 轻量 Markdown 渲染器（v0.2.8 预览面板，v0.2.9 完善图片/表格，v0.3.0 受控 HTML 表格与飞书 cite 引用）
 *
 * 设计约束：项目要求断网可读、零运行时依赖，因此不引入 react-markdown，
 * 自研覆盖同步产物的常见语法子集：
 *   - ATX 标题（# ~ ######）
 *   - ``` 围栏代码块（保留语言标记展示）
 *   - GFM 管道表格（对齐行 `:---` / `:---:` / `---:`、转义 `\|`、缺列自动补齐）
 *   - 块级受控 HTML 表格（保留 colspan / rowspan 合并、vertical-align、内部行内标签、安全白名单）
 *   - 图片：相对路径经 `baseDir` 解析为 kbRoot 相对路径，走鉴权 fetch →
 *     blob → objectURL 渲染（<img> 无法携带 X-Desktop-Token）；远程 URL
 *     直接渲染；加载/失败均有占位态
 *   - 无序/有序列表（按缩进支持嵌套）
 *   - 引用块、水平线、段落
 *   - 行内：**粗体** / *斜体* / ~~删除线~~ / `行内码` / [链接](url) / 图片
 *   - 飞书 cite 引用超链接（`<cite doc-id="..." title="...">` 打开外部 wiki）
 *   - 行内常见 HTML 标记（`<b>`, `<i>`, `<br>`, `<a>`, `<span>` 等）
 *
 * 同步产物适配（media-reference.ts 的改写约定）：
 *   - 剥掉 `<synced-source>...</synced-source>` 包裹标签
 *   - `<whiteboard token="images/a.jpg"/>` 等已被改写为本地路径的 XML
 *     媒体标签转换为 Markdown 图片语法再解析
 */

import { Fragment, useEffect, useState, type JSX, type ReactNode } from 'react';
import { ImageIcon, Loader2 } from 'lucide-react';
import { getMediaBlobUrl } from '../../api/client';
import {
  decodeHtmlEntities,
  extractHtmlTableBlocks,
  parseHtmlTable,
  type HtmlTableBlock,
} from '../../utils/html-table';
import { openExternalUrl, parseCiteTag } from '../../utils/feishu-cite';

// ---------------------------------------------------------------------------
// 同步产物预处理
// ---------------------------------------------------------------------------

/** 已被改写为本地相对路径的 XML 媒体标签（whiteboard/image/img/file/source）。 */
const XML_MEDIA_RE =
  /<(whiteboard|image|img|file|source)\b[^>]*?(?:token|src)="([^"]+)"[^>]*?\/?>/g;

function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

function looksLikeLocalMedia(src: string): boolean {
  return (
    !isRemoteUrl(src) &&
    !src.includes('://') &&
    /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(src)
  );
}

function preprocess(markdown: string): string {
  let out = markdown;
  // 1) XML 媒体标签 → Markdown 图片（仅当属性值已是本地相对路径；
  //    仍是飞书 token 的保留原文，避免渲染出坏图）。
  out = out.replace(XML_MEDIA_RE, (whole, _tag, target: string) =>
    looksLikeLocalMedia(target) ? `![媒体](${target})` : whole,
  );
  // 2) 剥掉 <synced-source> 包裹标签（保留内部内容）。
  out = out.replace(/<\/?synced-source>/g, '');
  // 3) 剥掉 HTML 注释（含文件首部的 feishu_sync YAML-in-comment 头，
  //    真实 Markdown 渲染器同样不展示注释）。
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // 4) 剥掉飞书导出的 <callout> 包裹标签（保留内部内容按普通块渲染）。
  out = out.replace(/<\/?callout\b[^>]*>/g, '');
  // 5) 为紧贴其它行内或块级内容的 <table> 标签注入独立段落换行，避免被段落粘连
  out = out.replace(/([^\n])\s*(<table[\s>])/gi, '$1\n\n$2');
  out = out.replace(/(<\/table>)\s*([^\n])/gi, '$1\n\n$2');
  // 6) 飞书内嵌 sheet 标签兜底（2026-09-04）：docx 正文中的
  //    <sheet sheet-id="..." token="..."></sheet> 引用若未被同步链路
  //    展开（历史产物 / 展开失败保留原标签），优雅降级为提示块而非
  //    裸 XML。新同步产物已在服务端展开为「## 子表:」段（见
  //    sync-engine expandInlineSheetTags）。
  out = out.replace(
    /<sheet\s+([^>]*?)\s*\/?>\s*(?:<\/sheet>)?/gi,
    (_whole: string, attrs: string) => {
      const sheetId = /sheet-id="([^"]*)"/.exec(attrs)?.[1] ?? '';
      const token = /token="([^"]*)"/.exec(attrs)?.[1] ?? '';
      return `\n\n> 【内嵌子表】sheet-id: ${sheetId || '未知'}${token ? ` · token: ${token}` : ''}。触发重新同步本文档可展开为完整表格。\n\n`;
    },
  );
  return out;
}

// ---------------------------------------------------------------------------
// 鉴权图片组件
// ---------------------------------------------------------------------------

interface AuthImageProps {
  /** Markdown 中的原始 src（相对 md 文件目录或远程 URL）。 */
  src: string;
  alt: string;
  /** md 文件所在目录（kbRoot 相对），用于解析相对 src。 */
  baseDir: string;
}

export function resolveMediaPath(src: string, baseDir: string): string {
  // Win 产物防御（2026-09-04 浮动图片修复）：历史/异构产物中图片引用
  // 可能携带反斜杠分隔（`images\主表_A7.png`），先归一到 POSIX 再拼接，
  // 否则 split('/') 会把整段当成单 segment，服务端 404。
  const cleaned = src.replace(/^\.\//, '').replace(/\\/g, '/');
  const normalizedBase = baseDir.replace(/\\/g, '/');
  const segments = [...normalizedBase.split('/').filter(Boolean), ...cleaned.split('/')];
  // 归一化 ..（图片引用可能指向上级目录）
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

function AuthImage({ src, alt, baseDir }: AuthImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [failureDetail, setFailureDetail] = useState<string>('');

  useEffect(() => {
    if (isRemoteUrl(src)) {
      setBlobUrl(src);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    getMediaBlobUrl(resolveMediaPath(src, baseDir))
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setBlobUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFailed(true);
          // 失败可见化（win 浮动图片排查）：带出解析后的 kbRoot 相对路径
          // 与 HTTP 状态，真机一眼定位是路径错位还是文件缺失。
          setFailureDetail(
            `${resolveMediaPath(src, baseDir)}（${err instanceof Error ? err.message : String(err)}）`,
          );
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, baseDir]);

  if (failed) {
    return (
      <span
        className="my-2 flex items-center gap-2 rounded-md border border-dashed border-line bg-paper-2/50 px-4 py-6 text-xs text-ink-faint"
        title={failureDetail || src}
      >
        <ImageIcon className="w-4 h-4 shrink-0" />
        图片加载失败：{alt || src}
        {failureDetail && <span className="text-[10px] font-mono">{failureDetail}</span>}
      </span>
    );
  }
  if (!blobUrl) {
    return (
      <span className="my-2 flex items-center justify-center gap-2 rounded-md border border-line/60 bg-paper-2/40 px-4 py-8 text-xs text-ink-faint">
        <Loader2 className="w-4 h-4 animate-spin" />
        图片加载中…
      </span>
    );
  }
  return (
    <img
      src={blobUrl}
      alt={alt}
      title={alt || src}
      className="my-2 max-w-full rounded-md border border-line/60 shadow-sm"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

// 支持 Markdown 原生标记 + 飞书 cite 标签 + 常用行内 HTML (b/i/br/del/code/a/span)
// URL 段允许一层成对括号嵌套（2026-09-04 浮动图片修复）：同步产物文件名
// 可含半角括号（如 `③-1(Framwork)分析拆解（确定复杂度）_B63_x.png`），
// 旧模式 [^)\n]* 会在文件名内首个 `)` 截断 src（mac/win 同现「图片加载
// 失败：③-1(Framwork)…」实测）。嵌套组对齐 CommonMark 平衡括号规则；
// 无括号 URL 行为不变。
const INLINE_RE =
  /(!\[.*?\]\((?:[^()\n]|\([^()\n]*\))*\))|(\[.*?\]\((?:[^()\n]|\([^()\n]*\))*\))|(\*\*(?:\\.|[^*\\\n])+\*\*)|(\*(?:\\.|[^*\\\n])+\*)|(~~(?:\\.|[^~\\])+~~)|(`[^`]+`)|(<cite\b[^>]*>(?:[\s\S]*?<\/cite>)?|<cite\b[^>]*\/>)|(<(?:b|strong)\b[^>]*>[\s\S]*?<\/(?:b|strong)>)|(<(?:i|em)\b[^>]*>[\s\S]*?<\/(?:i|em)>)|(<br\s*\/?>)|(<(?:del|s)\b[^>]*>[\s\S]*?<\/(?:del|s)>)|(<code\b[^>]*>[\s\S]*?<\/code>)|(<a\b[^>]*>[\s\S]*?<\/a>)|(<span\b[^>]*>[\s\S]*?<\/span>)/gi;

/** 还原 GFM 反斜杠转义与 HTML 实体，只作用于展示文本 */
function unescapeInline(s: string): string {
  const unescaped = s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  return decodeHtmlEntities(unescaped);
}

interface InlineContext {
  baseDir: string;
  onNavigateCsv?: (href: string) => boolean;
  feishuHost?: string;
}

export function renderInline(text: string, keyPrefix: string, ctx: InlineContext): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;

  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(unescapeInline(text.slice(last, idx)));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;

    if (token.startsWith('![')) {
      // 1. Markdown 图片
      const close = token.indexOf('](');
      const alt = unescapeInline(token.slice(2, close));
      const src = token.slice(close + 2, -1);
      out.push(<AuthImage key={key} src={src} alt={alt} baseDir={ctx.baseDir} />);
    } else if (token.startsWith('[')) {
      // 2. Markdown 链接
      const close = token.indexOf('](');
      const label = unescapeInline(token.slice(1, close));
      const href = token.slice(close + 2, -1);
      const isCsv = !isRemoteUrl(href) && href.split(/[?#]/)[0].toLowerCase().endsWith('.csv');
      out.push(
        <a
          key={key}
          href={href}
          target={isCsv ? undefined : '_blank'}
          rel={isCsv ? undefined : 'noopener noreferrer'}
          onClick={(e) => {
            if (isCsv && ctx.onNavigateCsv) {
              const handled = ctx.onNavigateCsv(href);
              if (handled) {
                e.preventDefault();
                e.stopPropagation();
              }
            }
          }}
          className="text-jade hover:text-seal underline underline-offset-2 decoration-line hover:decoration-seal transition-colors cursor-pointer"
        >
          {label}
        </a>,
      );
    } else if (token.startsWith('**')) {
      // 3. Markdown 粗体
      out.push(
        <strong key={key} className="font-semibold text-ink">
          {unescapeInline(token.slice(2, -2))}
        </strong>,
      );
    } else if (token.startsWith('~~')) {
      // 4. Markdown 删除线
      out.push(
        <del key={key} className="text-ink-faint">
          {unescapeInline(token.slice(2, -2))}
        </del>,
      );
    } else if (token.startsWith('`')) {
      // 5. Markdown 行内代码
      out.push(
        <code
          key={key}
          className="px-1 py-0.5 mx-0.5 rounded-sm bg-paper-2 border border-line/60 text-[0.85em] text-seal font-mono"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (/^<cite\b/i.test(token)) {
      // 6. 飞书 cite 标签（需求 2）
      const parsedCite = parseCiteTag(token, ctx.feishuHost);
      if (parsedCite.url) {
        out.push(
          <a
            key={key}
            href={parsedCite.url}
            title={parsedCite.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openExternalUrl(parsedCite.url!);
            }}
            className="text-blue-600 hover:text-blue-700 underline underline-offset-2 decoration-blue-300 hover:decoration-blue-500 cursor-pointer transition-colors"
          >
            {parsedCite.displayText}
          </a>,
        );
      } else if (parsedCite.displayText) {
        out.push(
          <span key={key} className="text-ink-soft">
            {parsedCite.displayText}
          </span>,
        );
      }
    } else if (/^<(?:b|strong)\b/i.test(token)) {
      // 7. HTML 粗体
      const inner = token.replace(/^<(?:b|strong)\b[^>]*>/i, '').replace(/<\/(?:b|strong)>$/i, '');
      out.push(
        <strong key={key} className="font-semibold text-ink">
          {renderInline(inner, `${key}-b`, ctx)}
        </strong>,
      );
    } else if (/^<(?:i|em)\b/i.test(token)) {
      // 8. HTML 斜体
      const inner = token.replace(/^<(?:i|em)\b[^>]*>/i, '').replace(/<\/(?:i|em)>$/i, '');
      out.push(
        <em key={key} className="text-ink-soft">
          {renderInline(inner, `${key}-i`, ctx)}
        </em>,
      );
    } else if (/^<br\s*\/?>/i.test(token)) {
      // 9. HTML 换行
      out.push(<br key={key} />);
    } else if (/^<(?:del|s)\b/i.test(token)) {
      // 10. HTML 删除线
      const inner = token.replace(/^<(?:del|s)\b[^>]*>/i, '').replace(/<\/(?:del|s)>$/i, '');
      out.push(
        <del key={key} className="text-ink-faint">
          {renderInline(inner, `${key}-d`, ctx)}
        </del>,
      );
    } else if (/^<code\b/i.test(token)) {
      // 11. HTML <code>
      const inner = token.replace(/^<code\b[^>]*>/i, '').replace(/<\/code>$/i, '');
      out.push(
        <code
          key={key}
          className="px-1 py-0.5 mx-0.5 rounded-sm bg-paper-2 border border-line/60 text-[0.85em] text-seal font-mono"
        >
          {decodeHtmlEntities(inner)}
        </code>,
      );
    } else if (/^<a\b/i.test(token)) {
      // 12. HTML 链接
      const hrefM = token.match(/\bhref=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))/i);
      const rawHref = hrefM ? hrefM[1] ?? hrefM[2] ?? hrefM[3] ?? '' : '';
      const href = decodeHtmlEntities(rawHref);
      const safeHref = /^javascript:/i.test(href.trim()) ? '#' : href;
      const isCsv = !isRemoteUrl(safeHref) && safeHref.split(/[?#]/)[0].toLowerCase().endsWith('.csv');
      const inner = token.replace(/^<a\b[^>]*>/i, '').replace(/<\/a>$/i, '');
      out.push(
        <a
          key={key}
          href={safeHref}
          target={isCsv ? undefined : '_blank'}
          rel={isCsv ? undefined : 'noopener noreferrer'}
          onClick={(e) => {
            if (isCsv && ctx.onNavigateCsv) {
              const handled = ctx.onNavigateCsv(safeHref);
              if (handled) {
                e.preventDefault();
                e.stopPropagation();
              }
            }
          }}
          className="text-jade hover:text-seal underline underline-offset-2 decoration-line hover:decoration-seal transition-colors cursor-pointer"
        >
          {renderInline(inner, `${key}-a`, ctx)}
        </a>,
      );
    } else if (/^<span\b/i.test(token)) {
      // 13. HTML span
      const inner = token.replace(/^<span\b[^>]*>/i, '').replace(/<\/span>$/i, '');
      out.push(<span key={key}>{renderInline(inner, `${key}-sp`, ctx)}</span>);
    } else {
      // 14. Markdown *斜体*
      out.push(
        <em key={key} className="text-ink-soft">
          {unescapeInline(token.slice(1, -1))}
        </em>,
      );
    }
    last = idx + token.length;
  }

  if (last < text.length) out.push(unescapeInline(text.slice(last)));
  return out;
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

type TableAlign = 'left' | 'center' | 'right';

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'table'; header: string[]; aligns: TableAlign[]; rows: string[][] }
  | HtmlTableBlock
  | { type: 'list'; ordered: boolean; items: { indent: number; text: string }[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

/** 按未转义的 | 切分单元格（`\|` 是字面竖线，不是分隔符）。 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** 判断是否为 GFM 表格分隔行，并解析各列对齐方式。 */
function parseTableSeparator(line: string): TableAlign[] | null {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed.includes('-')) return null;
  const parts = trimmed.split('|').map((p) => p.trim());
  if (parts.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const part of parts) {
    if (!/^:?-+:?$/.test(part)) return null;
    const left = part.startsWith(':');
    const right = part.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : 'left');
  }
  return aligns;
}

export function parseBlocks(markdown: string): Block[] {
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

    // 块级 HTML 表格（需求 1）
    if (/^\s*<table[\s>]/i.test(line)) {
      const tableLines: string[] = [line];
      let closed = /<\/table>/i.test(line);
      i++;
      while (!closed && i < lines.length) {
        tableLines.push(lines[i]);
        if (/<\/table>/i.test(lines[i])) {
          closed = true;
        }
        i++;
      }
      const rawHtml = tableLines.join('\n');
      const tableBlock = parseHtmlTable(rawHtml);
      if (tableBlock) {
        blocks.push(tableBlock);
        continue;
      }
    }

    // GFM 管道表格：当前行含 | 且下一行是合法分隔行
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = parseTableSeparator(lines[i + 1]);
      if (aligns) {
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
        const width = Math.max(header.length, aligns.length);
        while (header.length < width) header.push('');
        while (aligns.length < width) aligns.push('left');
        for (const row of rows) {
          while (row.length < width) row.push('');
        }
        blocks.push({ type: 'table', header, aligns, rows });
        continue;
      }
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

    // 段落：合并连续普通行（遇到标题、代码块、引用、列表、分隔线、HTML 表格停止）
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) &&
      !(
        lines[i].includes('|') &&
        i + 1 < lines.length &&
        parseTableSeparator(lines[i + 1]) !== null
      ) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !/^\s*<table[\s>]/i.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }

    const paragraphText = buf.join(' ');
    // 容错提取：若段落中仍嵌有块级 HTML 表格，将其切分独立
    const segments = extractHtmlTableBlocks(paragraphText);
    if (segments.length > 1 || (segments.length === 1 && segments[0].type === 'table')) {
      for (const seg of segments) {
        if (seg.type === 'table') {
          blocks.push(seg.block);
        } else if (seg.content.trim()) {
          blocks.push({ type: 'paragraph', text: seg.content.trim() });
        }
      }
    } else {
      blocks.push({ type: 'paragraph', text: paragraphText });
    }
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

const ALIGN_CLASS: Record<TableAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function renderList(
  block: Extract<Block, { type: 'list' }>,
  keyPrefix: string,
  ctx: InlineContext,
): JSX.Element {
  const baseIndent = Math.min(...block.items.map((it) => it.indent));
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
          {renderInline(item.text, `${keyPrefix}-${idx}`, ctx)}
        </li>
      ))}
    </ListTag>
  );
}

function renderBlock(block: Block, index: number, ctx: InlineContext): ReactNode {
  const key = `b-${index}`;
  switch (block.type) {
    case 'heading':
      return (
        <div key={key} className={HEADING_CLASS[block.level] ?? HEADING_CLASS[6]}>
          {renderInline(block.text, key, ctx)}
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
                    className={`px-3 py-2 font-medium text-ink border-b border-line whitespace-nowrap ${
                      ALIGN_CLASS[block.aligns[ci] ?? 'left']
                    }`}
                  >
                    {renderInline(cell, `${key}-h${ci}`, ctx)}
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
                      className={`px-3 py-1.5 text-ink-soft border-b border-line/40 align-top ${
                        ALIGN_CLASS[block.aligns[ci] ?? 'left']
                      }`}
                    >
                      {renderInline(cell, `${key}-r${ri}c${ci}`, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'html_table':
      // 需求 1：受控 HTML 表格渲染，保留 colspan/rowspan，样式与 Markdown 表格一致
      return (
        <div key={key} className="my-3 overflow-x-auto scrollbar-thin rounded-md border border-line/70">
          <table className="w-full text-xs border-collapse">
            {block.colgroup && (
              <colgroup>
                {block.colgroup.map((col, ci) => (
                  <col
                    key={ci}
                    span={col.span}
                    style={col.width ? { width: col.width } : undefined}
                  />
                ))}
              </colgroup>
            )}
            {block.headRows.length > 0 && (
              <thead>
                {block.headRows.map((row, ri) => (
                  <tr key={ri} className="bg-paper-2">
                    {row.cells.map((cell, ci) => (
                      <th
                        key={ci}
                        colSpan={cell.colspan}
                        rowSpan={cell.rowspan}
                        style={{
                          verticalAlign: cell.valign || 'top',
                          ...(cell.style || {}),
                        }}
                        className={`px-3 py-2 font-medium text-ink border-b border-line ${
                          cell.align ? ALIGN_CLASS[cell.align] : 'text-left'
                        }`}
                      >
                        {renderInline(cell.content, `${key}-h${ri}c${ci}`, ctx)}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
            )}
            <tbody>
              {block.bodyRows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 1 ? 'bg-paper/60' : 'bg-card-bg'}>
                  {row.cells.map((cell, ci) => (
                    <td
                      key={ci}
                      colSpan={cell.colspan}
                      rowSpan={cell.rowspan}
                      style={{
                        verticalAlign: cell.valign || 'top',
                        ...(cell.style || {}),
                      }}
                      className={`px-3 py-1.5 text-ink-soft border-b border-line/40 ${
                        cell.align ? ALIGN_CLASS[cell.align] : 'text-left'
                      }`}
                    >
                      {renderInline(cell.content, `${key}-r${ri}c${ci}`, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list':
      return renderList(block, key, ctx);
    case 'quote':
      return (
        <blockquote
          key={key}
          className="my-3 pl-3 border-l-2 border-jade/60 text-sm text-ink-soft italic space-y-1"
        >
          {block.lines.map((l, li) => (
            <p key={li}>{renderInline(l, `${key}-q${li}`, ctx)}</p>
          ))}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} className="my-4 border-line/60" />;
    case 'paragraph':
      return (
        <p key={key} className="my-2 text-sm leading-relaxed text-ink-soft">
          {renderInline(block.text, key, ctx)}
        </p>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 组件出口
// ---------------------------------------------------------------------------

export interface MarkdownViewProps {
  content: string;
  /** md 文件所在目录（kbRoot 相对 POSIX 路径），用于解析相对图片路径。 */
  baseDir?: string;
  /** 点击相对 .csv 链接时的拦截处理器：返回 true 表示已命中本地子表并阻止浏览器默认跳转。 */
  onNavigateCsv?: (href: string) => boolean;
  /** 飞书租户域名（如 "qcnbafdrjx7n.feishu.cn"），用于生成并打开 wiki 超链接。 */
  feishuHost?: string;
}

export function MarkdownView({
  content,
  baseDir = '',
  onNavigateCsv,
  feishuHost,
}: MarkdownViewProps) {
  const blocks = parseBlocks(preprocess(content));
  const ctx: InlineContext = { baseDir, onNavigateCsv, feishuHost };
  return (
    <div className="px-5 py-4">
      {blocks.map((b, i) => (
        <Fragment key={i}>{renderBlock(b, i, ctx)}</Fragment>
      ))}
    </div>
  );
}
