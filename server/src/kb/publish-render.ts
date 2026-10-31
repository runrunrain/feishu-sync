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
 * 6. 对象锚点降级（A 案 §7.5）：服务端注入的受限空锚点 `<a id="ko_…"></a>`
 *    剥离（飞书富文本无对应承载，保留会以字面 HTML 泄入云端）；对象链接
 *    `path.md#ko_objectId` 保留链接文字降级为指向目标文档的链接（fragment
 *    丢弃——飞书文档 URL 不承载 Markdown 锚点，云端只能保证文档级跳转）；
 *    裸锚 `#ko_…`（编译正常不应出现，防御性处理）同样降级为纯文字。每次
 *    降级发 object_anchor_not_preserved 警告（reason: invisible_anchor /
 *    link_fragment），进入 publication-service 的 warnings 通道。
 *
 * contentHash = sha256(body)（UTF-8 字节的 hex；设计 §4.2「渲染后发布正文
 * sha256」——标题经 --title 单独传递，不入哈希）。
 *
 * 警告 PublishWarning 按 (code, target, objectId, reason) 首次出现去重
 * （同目标/同对象多次引用只报一次，稳定 warnings_json 体积与顺序）。
 */

import crypto from 'node:crypto';
import path from 'node:path';

export type PublishWarningCode =
  | 'link_target_unpublished'
  | 'image_not_published'
  | 'object_anchor_not_preserved';

/** A 案 §7.5 锚点降级种类：invisible_anchor=空锚点剥离；link_fragment=
 * 对象链接 fragment 丢弃（降级为文档级跳转/纯文字）。 */
export type AnchorDegradeReason = 'link_fragment' | 'invisible_anchor';

export interface PublishWarning {
  code: PublishWarningCode;
  /** 产生警告的标准库文档（input.kbPath），用于发布计划预览归因。 */
  kbPath: string;
  /** link：解析后的目标标准库路径（含越界路径）；image：解析后的图片路径。 */
  target?: string;
  /** 保留进正文的文字（链接文字 / 图片 alt）。 */
  text?: string;
  /** object_anchor_not_preserved：锚点/fragment 指向的知识对象 ID。 */
  objectId?: string;
  /** object_anchor_not_preserved：降级种类（A 案 §7.5）。 */
  reason?: AnchorDegradeReason;
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
const H1_RE = /^#\s+(.+?)\s*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,}) *$/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** 行内图片/链接（URL 不含空白与右括号；支持 "title" 后缀）。 */
const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINK_REF_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** A 案 §7.5 对象锚点：服务端注入的受限空锚点（与 knowledge-schema 的
 * SERVER_ANCHOR_RE 同形态）与内部链接的 ko_ fragment。 */
const SERVER_ANCHOR_TAG_RE = /<a id="(ko_[A-Za-z0-9_-]+)"><\/a>/g;
const KO_FRAGMENT_RE = /#(ko_[A-Za-z0-9_-]+)$/;
const BARE_KO_ANCHOR_RE = /^#(ko_[A-Za-z0-9_-]+)$/;

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 标题回退：basename 去 .md（kbPath 假定为标准库相对 POSIX 路径）。 */
function fallbackTitle(kbPath: string): string {
  const base = kbPath.split('/').pop() ?? kbPath;
  return base.replace(/\.md$/i, '');
}

/** Find a heading outside fenced code so code examples are never used as titles. */
function findHeading(body: string): { index: number; text: string } | null {
  let offset = 0;
  let fence: { char: string; len: number } | null = null;
  for (const line of body.split('\n')) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
    } else {
      const open = FENCE_OPEN_RE.exec(line);
      if (open) fence = { char: open[1][0], len: open[1].length };
      else {
        const match = H1_RE.exec(line);
        if (match) return { index: offset, text: match[1].trim() };
      }
    }
    offset += line.length + 1;
  }
  return null;
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

/**
 * A 案 §7.5 剥离服务端受限空锚点（invisible_anchor）：飞书富文本无对应
 * 承载，保留会以字面 HTML 泄入云端正文。只剥该精确形态，其余 HTML 不动
 * （knowledge-compiler 已在发布侧剥离任意其他 HTML ID）；每处剥离发一次
 * 警告。剥离只移除标签本身——独占一行的锚点变空行而非删行，避免把锚点
 * 两侧的段落合并（段落分隔语义不变，contentHash 仍确定性）。
 */
function stripServerAnchors(
  text: string,
  kbPath: string,
  warn: (w: PublishWarning) => void,
): string {
  return text.replace(SERVER_ANCHOR_TAG_RE, (_whole, objectId: string) => {
    warn({ code: 'object_anchor_not_preserved', kbPath, objectId, reason: 'invisible_anchor' });
    return '';
  });
}

/** 围栏外一行的链接/图片改写（图片先于链接，避免 `!` 残留；锚点剥离先于
 * 二者——A 案 §7.5）。 */
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
    if (target === null) {
      // A 案 §7.5：裸 ko_ 锚链接（#ko_…，指向本文档内对象锚点）——锚点
      // 已剥离、云端无承载，降级为纯文字保留链接文字；非 ko_ 纯锚与
      // 外部形式（源引用/外链）原样保留（现状）。
      const bareKo = BARE_KO_ANCHOR_RE.exec(url);
      if (bareKo) {
        warn({ code: 'object_anchor_not_preserved', kbPath, objectId: bareKo[1], reason: 'link_fragment' });
        return label;
      }
      return whole; // 源引用/外链/普通锚点：原样保留
    }
    const cloud = urlMap.get(target);
    const koFragment = KO_FRAGMENT_RE.exec(url);
    if (cloud) {
      // A 案 §7.5：对象链接降级为文档级跳转——fragment 丢弃（飞书文档
      // URL 不承载 Markdown 锚点），链接文字与目标文档链接保留。
      if (koFragment) {
        warn({ code: 'object_anchor_not_preserved', kbPath, target, objectId: koFragment[1], reason: 'link_fragment' });
      }
      return `[${label}](${cloud})`;
    }
    // 目标未发布：链接整体降级为纯文字，由 link_target_unpublished 表达
    // （锚点定位信息随之消失，不再叠加 object_anchor_not_preserved——
    // 未发布是更根本的阻断，警告不重复计）。
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

  const h1Match = findHeading(body);
  const h1Text = h1Match?.text;
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
    // A 案 §7.5：去重键含 objectId/reason——同一对象的多处锚点/fragment
    // 只报一次，不同对象/不同降级种类分别可见。
    const key = `${w.code}\u0000${w.target ?? ''}\u0000${w.objectId ?? ''}\u0000${w.reason ?? ''}`;
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
      .map((seg) => (seg.code
        ? seg.text
        : rewriteRefs(stripServerAnchors(seg.text, kbPath, warn), kbPath, publishedUrlByKbPath, warn)))
      .join('');
    outLines.push(rewritten);
  }
  body = outLines.join('\n');

  return { title, body, warnings, contentHash: sha256Hex(body) };
}
