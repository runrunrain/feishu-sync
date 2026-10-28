/**
 * renderForPublish — 标准库 md → 可发布 md 的确定性渲染纯函数（P1 §4.3 契约）
 *
 * 消费方是 P1-S8 KbPublishService（本切片不接线）：
 * - `docs +create --title <title> --content @<tmp>`：title/body 来自本函数；
 *   contentHash 落 kb_publications.published_content_hash，用于「未变化则
 *   跳过」与两遍发布的 overwrite 判定。
 * - 两遍发布：同批先创建全部新文档，再对「链接到本批新建文档」的文档按
 *   新 URL 重新渲染，contentHash 变化则 overwrite 一次——因此本函数必须
 *   纯函数且确定性：同一输入必得同一 body 字节与 contentHash。
 *
 * 渲染规则（P1 §4.3）：
 * 1. 去掉 feishu_sync_kb 头部注释（格式与 standard-kb-store.stripStdHeader
 *    一致；头字段零改动，本模块只读）。
 * 2. 标题：头部 `title:` 字段（现行头部暂无此字段，解析留作前向兼容）→
 *    其次首个 H1 → 都没有则回退 basename（去 .md，与 kb-build-service 的
 *    title 回退同口径）。与标题相同的首个 H1 从正文移除（--title 已提供
 *    标题，避免重复）；不同则 H1 保留。
 * 3. 标准库内相对链接 [t](../a/b.md)：相对 kbPath 解析目标路径，已发布
 *    （publishedUrlByKbPath 命中）→ 改写为云端 URL（fragment 丢弃——
 *    飞书文档 URL 不承载 Markdown 锚点）；未发布/解析越界 → 去链接保留
 *    文字，警告 link_target_unpublished。
 *    外部形式不解析、原样保留：带 scheme 的 URL（源引用 http(s)/mailto/
 *    feishu 等）、协议相对 `//`、根相对 `/x.md`、纯锚点 `#x`。
 * 4. 本地图片 ![alt](相对路径)：v1 不上传图片，整体替换为引用块
 *    `> ［图片未发布：alt］`（alt 为空时用原 URL，保证占位可辨认），
 *    警告 image_not_published。远程图片（带 scheme / 根相对）原样保留。
 * 5. 代码保护（确定性渲染的正确性边界，设计未明说、此处收紧）：围栏代码块
 *    （```/~~~）与行内代码 span 内的链接/图片一律不改写——标准库正文常含
 *    Markdown 示例，改写会损坏示例内容。
 *
 * contentHash = sha256(body)（UTF-8 字节的 hex；设计 §4.2「渲染后发布正文
 * sha256」——标题经 --title 单独传递，不入哈希）。
 *
 * 警告 PublishWarning 按 (code, target) 首次出现去重（同目标多次引用只报
 * 一次，稳定 warnings_json 体积与顺序）。
 */

import crypto from 'node:crypto';
import path from 'node:path';

export type PublishWarningCode = 'link_target_unpublished' | 'image_not_published';

export interface PublishWarning {
  code: PublishWarningCode;
  /** 产生警告的标准库文档（input.kbPath），用于发布计划预览归因。 */
  kbPath: string;
  /** link：解析后的目标标准库路径（含越界路径）；image：解析后的图片路径。 */
  target?: string;
  /** 保留进正文的文字（链接文字 / 图片 alt）。 */
  text?: string;
}

export interface RenderForPublishInput {
  kbPath: string;
  /** 标准库文件全文（含 feishu_sync_kb 头部）。 */
  markdown: string;
  /** 已发布文档的标准库路径 → 云端 URL。 */
  publishedUrlByKbPath: Map<string, string>;
}

export interface RenderForPublishResult {
  title: string;
  body: string;
  warnings: PublishWarning[];
  contentHash: string;
}

/** feishu_sync_kb 头部注释（捕获组 1 = 头部 YAML 体，用于读 title 字段）。 */
const STD_HEADER_RE = /^<!--\s*\nfeishu_sync_kb:\n([\s\S]*?)\n-->\s*\n?/;
const HEADER_TITLE_RE = /^ {2}title:\s*(.+?)\s*$/m;
/** 首个 H1（与 kb-build-service 的 title 提取同口径）。 */
const H1_RE = /^#\s+(.+?)\s*$/m;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,}) *$/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** 行内图片/链接（URL 不含空白与右括号；支持 "title" 后缀）。 */
const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINK_REF_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 标题回退：basename 去 .md（kbPath 假定为标准库相对 POSIX 路径）。 */
function fallbackTitle(kbPath: string): string {
  const base = kbPath.split('/').pop() ?? kbPath;
  return base.replace(/\.md$/i, '');
}

/**
 * 相对 URL → 标准库内目标路径。返回 null 表示「非标准库内相对链接」
 * （外部/锚点/根相对），调用方原样保留；越界路径原样返回（如 ../x.md），
 * 交由未发布分支处理。
 */
function resolveInternal(kbPath: string, url: string): string | null {
  if (SCHEME_RE.test(url) || url.startsWith('//') || url.startsWith('/') || url.startsWith('#')) {
    return null;
  }
  const pathPart = url.replace(/[?#].*$/, '');
  if (!pathPart) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(kbPath), pathPart));
}

interface InlineSegment {
  text: string;
  code: boolean;
}

/**
 * 行内代码 span 保护：n 个反引号开、恰 n 个反引号闭（CommonMark 口径），
 * 未闭合的反引号视为普通文字。代码段内的链接/图片不参与改写。
 */
function splitInlineCode(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let buf = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let n = 0;
      while (line[i + n] === '`') n++;
      let close = -1;
      let j = i + n;
      while (j < line.length) {
        if (line[j] === '`') {
          let m = 0;
          while (line[j + m] === '`') m++;
          if (m === n) {
            close = j;
            break;
          }
          j += m;
          continue;
        }
        j++;
      }
      if (close === -1) {
        buf += line.slice(i, i + n); // 未闭合：字面反引号
        i += n;
        continue;
      }
      if (buf) {
        segments.push({ text: buf, code: false });
        buf = '';
      }
      segments.push({ text: line.slice(i, close + n), code: true });
      i = close + n;
      continue;
    }
    buf += line[i];
    i++;
  }
  if (buf) segments.push({ text: buf, code: false });
  return segments;
}

/** 围栏外一行的链接/图片改写（图片先于链接，避免 `!` 残留）。 */
function rewriteRefs(
  text: string,
  kbPath: string,
  urlMap: Map<string, string>,
  warn: (w: PublishWarning) => void,
): string {
  const images = text.replace(IMAGE_REF_RE, (whole, alt: string, url: string) => {
    const target = resolveInternal(kbPath, url);
    if (target === null) return whole; // 远程/锚点图片：原样保留
    warn({ code: 'image_not_published', kbPath, target, text: alt || url });
    return `> ［图片未发布：${alt || url}］`;
  });
  return images.replace(LINK_REF_RE, (whole, label: string, url: string) => {
    const target = resolveInternal(kbPath, url);
    if (target === null) return whole; // 源引用/外链：原样保留
    const cloud = urlMap.get(target);
    if (cloud) return `[${label}](${cloud})`;
    warn({ code: 'link_target_unpublished', kbPath, target, text: label });
    return label;
  });
}

export function renderForPublish(input: RenderForPublishInput): RenderForPublishResult {
  const { kbPath, markdown, publishedUrlByKbPath } = input;

  // 1) 头部去除与标题确定
  const headerMatch = STD_HEADER_RE.exec(markdown);
  let body = headerMatch ? markdown.slice(headerMatch[0].length) : markdown;
  const headerTitle = headerMatch ? HEADER_TITLE_RE.exec(headerMatch[1])?.[1].trim() : undefined;

  const h1Match = H1_RE.exec(body);
  const h1Text = h1Match?.[1].trim();
  const title = headerTitle || h1Text || fallbackTitle(kbPath);

  // 2) 与标题相同的首个 H1 从正文移除
  if (h1Match && h1Text === title) {
    const lineEnd = body.indexOf('\n', h1Match.index);
    body = lineEnd === -1 ? body.slice(0, h1Match.index) : body.slice(0, h1Match.index) + body.slice(lineEnd + 1);
  }

  // 3) 链接/图片改写（围栏与行内代码内不改写）
  const warnings: PublishWarning[] = [];
  const seen = new Set<string>();
  const warn = (w: PublishWarning) => {
    const key = `${w.code}\u0000${w.target ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push(w);
  };

  const outLines: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of body.split('\n')) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      outLines.push(line); // 围栏内与闭合围栏行：原样
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      outLines.push(line); // 开围栏行：原样
      continue;
    }
    const rewritten = splitInlineCode(line)
      .map((seg) => (seg.code ? seg.text : rewriteRefs(seg.text, kbPath, publishedUrlByKbPath, warn)))
      .join('');
    outLines.push(rewritten);
  }
  body = outLines.join('\n');

  return { title, body, warnings, contentHash: sha256Hex(body) };
}
