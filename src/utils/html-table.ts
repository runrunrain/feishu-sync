/**
 * HTML Table parsing and sanitization utilities.
 *
 * 用于解析飞书同步产物 Markdown 中嵌入的受控原始 HTML 表格（飞书导出产物）。
 * 纯函数实现，不依赖 DOMParser / browser runtime，在 Node.js (vitest) / Vite / Electron 均可运行。
 */

export interface HtmlTableCol {
  span?: number;
  width?: string;
}

export interface HtmlTableCell {
  tag: 'th' | 'td';
  colspan?: number;
  rowspan?: number;
  align?: 'left' | 'center' | 'right';
  valign?: string;
  style?: Record<string, string>;
  content: string;
}

export interface HtmlTableRow {
  cells: HtmlTableCell[];
}

export interface HtmlTableBlock {
  type: 'html_table';
  colgroup?: HtmlTableCol[];
  headRows: HtmlTableRow[];
  bodyRows: HtmlTableRow[];
}

export type HtmlTableSegment =
  | { type: 'text'; content: string }
  | { type: 'table'; raw: string; block: HtmlTableBlock };

/** HTML 实体解码 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00A0')
    .replace(/&#(\d+);/g, (_, code) => {
      const num = parseInt(code, 10);
      return !isNaN(num) ? String.fromCharCode(num) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
      const num = parseInt(code, 16);
      return !isNaN(num) ? String.fromCharCode(num) : _;
    });
}

/** 解析受控的内联 CSS 属性白名单 */
export function parseSafeInlineStyle(styleStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!styleStr || typeof styleStr !== 'string') return result;
  // 阻断表达式、url 与 javascript 注入
  if (/expression|javascript:|url\(/i.test(styleStr)) return result;

  const allowedProps: Record<string, string> = {
    'vertical-align': 'verticalAlign',
    'text-align': 'textAlign',
    'width': 'width',
    'min-width': 'minWidth',
    'max-width': 'maxWidth',
    'background-color': 'backgroundColor',
    'color': 'color',
    'font-weight': 'fontWeight',
    'font-style': 'fontStyle',
  };

  const declarations = styleStr.split(';');
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const val = decl.slice(colonIdx + 1).trim();
    if (!prop || !val) continue;
    const mapped = allowedProps[prop];
    if (mapped && !/[<>"';]/i.test(val)) {
      result[mapped] = val;
    }
  }
  return result;
}

/**
 * 清理 HTML 表格，执行安全白名单过滤：
 * - 剥除 <script>、<style>、<iframe> 等高危标签及其内部代码
 * - 剥除 on* 事件属性
 * - 剥除白名单外属性（仅保留结构语义属性与受控 style）
 */
export function sanitizeHtmlTable(rawHtml: string): string {
  if (!rawHtml) return '';
  let clean = rawHtml;

  // 1. 完全剔除 script 与 style 块及其内容
  clean = clean.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  clean = clean.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '');
  clean = clean.replace(/<object\b[\s\S]*?<\/object>/gi, '');

  // 2. 剥除所有 on* 事件属性（如 onclick, onerror, onload）
  clean = clean.replace(/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 3. 剥除 javascript: 链接
  clean = clean.replace(/\bhref\s*=\s*["']\s*javascript:[^"']*["']/gi, 'href="#"');

  return clean;
}

/** 内部行与单元格解析器 */
function parseTrSection(html: string): HtmlTableRow[] {
  const rows: HtmlTableRow[] = [];
  // 匹配每个 <tr>...</tr>，亦容忍未闭合到下一 <tr> 或末尾的形态
  const trMatches = html.matchAll(/<tr\b[^>]*>([\s\S]*?)(?:<\/tr>|(?=<tr\b)|$)/gi);

  for (const trMatch of trMatches) {
    const trContent = trMatch[1].trim();
    if (!trContent) continue;

    const cells: HtmlTableCell[] = [];
    const cellMatches = trContent.matchAll(
      /<(th|td)\b([^>]*)>([\s\S]*?)(?:<\/\1>|(?=<(?:th|td)\b)|$)/gi,
    );

    for (const cm of cellMatches) {
      const tag = cm[1].toLowerCase() as 'th' | 'td';
      const attrStr = cm[2] || '';
      const content = cm[3].trim();

      // colspan
      const colspanM = attrStr.match(/\bcolspan=["']?(\d+)["']?/i);
      const colspan = colspanM ? parseInt(colspanM[1], 10) : undefined;

      // rowspan
      const rowspanM = attrStr.match(/\browspan=["']?(\d+)["']?/i);
      const rowspan = rowspanM ? parseInt(rowspanM[1], 10) : undefined;

      // vertical-align or valign
      let valign: string | undefined;
      const valignM = attrStr.match(/\b(?:vertical-align|valign)=["']?([^"'\s>]+)["']?/i);
      if (valignM) {
        valign = valignM[1].toLowerCase();
      }

      // align
      let align: 'left' | 'center' | 'right' | undefined;
      const alignM = attrStr.match(/\balign=["']?(left|center|right)["']?/i);
      if (alignM) {
        align = alignM[1].toLowerCase() as 'left' | 'center' | 'right';
      }

      // style
      const styleM = attrStr.match(/\bstyle=["']([^"']*)["']/i);
      let style: Record<string, string> | undefined;
      if (styleM) {
        style = parseSafeInlineStyle(styleM[1]);
        if (style.verticalAlign && !valign) {
          valign = style.verticalAlign;
        }
        if (style.textAlign && !align) {
          const ta = style.textAlign.toLowerCase();
          if (ta === 'left' || ta === 'center' || ta === 'right') {
            align = ta;
          }
        }
      }

      cells.push({
        tag,
        colspan: colspan && colspan > 1 ? colspan : undefined,
        rowspan: rowspan && rowspan > 1 ? rowspan : undefined,
        align,
        valign: valign || 'top',
        style,
        content,
      });
    }

    if (cells.length > 0) {
      rows.push({ cells });
    }
  }

  return rows;
}

/**
 * 将单个 <table>...</table> 文本解析为受控的 HtmlTableBlock AST。
 * 若输入不含有效的 <table> 或行解析为空，返回 null。
 */
export function parseHtmlTable(rawHtml: string): HtmlTableBlock | null {
  if (!rawHtml || !/<table\b/i.test(rawHtml)) return null;
  const clean = sanitizeHtmlTable(rawHtml);

  // 1. colgroup
  const colgroup: HtmlTableCol[] = [];
  const colgroupMatch = clean.match(/<colgroup\b[^>]*>([\s\S]*?)<\/colgroup>/i);
  if (colgroupMatch) {
    const colMatches = colgroupMatch[1].matchAll(/<col\b([^>]*)\/?>/gi);
    for (const cm of colMatches) {
      const attrs = cm[1] || '';
      const spanM = attrs.match(/\bspan=["']?(\d+)["']?/i);
      const widthM = attrs.match(/\bwidth=["']?([^"'\s>]+)["']?/i);
      colgroup.push({
        span: spanM ? parseInt(spanM[1], 10) : undefined,
        width: widthM ? widthM[1] : undefined,
      });
    }
  }

  // 2. thead
  const headRows: HtmlTableRow[] = [];
  const theadMatches = clean.matchAll(/<thead\b[^>]*>([\s\S]*?)<\/thead>/gi);
  for (const thm of theadMatches) {
    headRows.push(...parseTrSection(thm[1]));
  }

  // 3. tbody
  const bodyRows: HtmlTableRow[] = [];
  const tbodyMatches = clean.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi);
  for (const tbm of tbodyMatches) {
    bodyRows.push(...parseTrSection(tbm[1]));
  }

  // 4. tfoot（可折算至 body 末尾）
  const tfootMatches = clean.matchAll(/<tfoot\b[^>]*>([\s\S]*?)<\/tfoot>/gi);
  for (const tfm of tfootMatches) {
    bodyRows.push(...parseTrSection(tfm[1]));
  }

  // 5. 若无 thead/tbody 包装，直接从 table 提取 <tr>
  if (headRows.length === 0 && bodyRows.length === 0) {
    // 剔除已解析的 colgroup/caption
    const innerTable = clean
      .replace(/<table\b[^>]*>/i, '')
      .replace(/<\/table>$/i, '')
      .replace(/<colgroup\b[\s\S]*?<\/colgroup>/gi, '');
    const directRows = parseTrSection(innerTable);
    if (directRows.length > 0) {
      // 若首行全部由 <th> 构成，提升为 headRows
      const firstRowAllTh = directRows[0].cells.every((c) => c.tag === 'th');
      if (firstRowAllTh) {
        headRows.push(directRows[0]);
        bodyRows.push(...directRows.slice(1));
      } else {
        bodyRows.push(...directRows);
      }
    }
  }

  if (headRows.length === 0 && bodyRows.length === 0) {
    return null;
  }

  return {
    type: 'html_table',
    colgroup: colgroup.length > 0 ? colgroup : undefined,
    headRows,
    bodyRows,
  };
}

/**
 * 识别文本中包含的所有块级 <table>...</table> 片段，
 * 切分为文本段与 HtmlTableBlock 结构列表。
 * 纯函数，独立于 DOM 环境，单元可测。
 */
export function extractHtmlTableBlocks(text: string): HtmlTableSegment[] {
  const segments: HtmlTableSegment[] = [];
  if (!text) return segments;

  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tableRe.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before.length > 0) {
      segments.push({ type: 'text', content: before });
    }

    const rawTable = match[0];
    const block = parseHtmlTable(rawTable);
    if (block) {
      segments.push({ type: 'table', raw: rawTable, block });
    } else {
      segments.push({ type: 'text', content: rawTable });
    }

    lastIndex = match.index + rawTable.length;
  }

  const remainder = text.slice(lastIndex);
  if (remainder.length > 0) {
    segments.push({ type: 'text', content: remainder });
  }

  return segments;
}
