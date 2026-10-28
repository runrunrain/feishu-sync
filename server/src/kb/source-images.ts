/**
 * source-images — 源文档关联图片枚举与 mediaHash（设计 §3.3，S3）
 *
 * 图片落盘形态：源 md 同目录 `images/NN-<token>`（无扩展名），md 相对
 * 引用（`![alt](images/…)` / `<img src="images/…">` / `<image …>` 标签，
 * token 属性已被同步引擎改写为本地相对路径）。sheet 的 CSV 附件与
 * source_workbook 已经计入 contentHash（既有设计），不属于 mediaHash
 * 范围——mediaHash 只覆盖“图片字节”。
 *
 * mediaHash 兼容性（U4）：contentHash 公式不变；旧 manifest 条目无
 * mediaHash → 变更判定视为未变（升级后首次增量不触发全量 changed）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PathGuardError, resolveInside } from '../agent/path-guard.js';
import type { RawSourceSnapshotEntry } from '../types/agent-knowledge.js';

export interface SourceImageRef {
  /** md 内原始引用（src），作排序与对齐键 */
  src: string;
  /** 解析到围栏内的绝对路径；逃逸引用被丢弃（不出现在结果中） */
  file: string;
}

/** 内联块需要的最小描述形状（S2 ImageDescription 的结构化子集）。 */
export interface ImageDescriptionLike {
  src: string;
  imageHash?: string;
  state: 'described' | 'cached' | 'unavailable';
  reason?: string;
  text?: string;
}

/** 是否为应忽略的非本地引用（http/data/file、锚点、绝对路径）。 */
function isNonLocalRef(src: string): boolean {
  return /^(?:https?|data|file|mailto):/i.test(src) || src.startsWith('#') || src.startsWith('/');
}

/**
 * 提取 markdown 中的本地图片引用。只认图片语义：
 * - `![alt](path)`（markdown 图片；普通链接 `[t](p)` 不算）
 * - `<img src="path">` / `<image src=…|token=…>`（同步引擎改写后 token 属性
 *   即本地路径）
 * 去重保序；http(s)/data:/file:/锚点/绝对路径忽略。
 */
export function extractImageRefs(markdown: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    const src = (raw ?? '').trim().replace(/&amp;/g, '&');
    if (!src || isNonLocalRef(src)) return;
    if (seen.has(src)) return;
    seen.add(src);
    refs.push(src);
  };
  const mdImage = /!\[[^\]]*\]\(\s*([^)\s]+)\s*(?:"[^"]*")?\)/g;
  for (const match of markdown.matchAll(mdImage)) push(match[1]);
  const tagImage = /<(?:img|image)\b[^>]*>/gi;
  for (const tagMatch of markdown.matchAll(tagImage)) {
    const tag = tagMatch[0];
    const attr = /(?:src|token)\s*=\s*(["'])([^"']+)\1/i.exec(tag);
    if (attr) push(attr[2]);
  }
  return refs;
}

/**
 * 解析源文档的关联图片：相对源文件目录解析，经 resolveInside(root,…,'read')
 * 围栏校验。越界/非法引用直接丢弃（防御：不因脏引用阻断构建）；缺失文件
 * 保留条目（后续按 missing_file 记 unavailable），因为“存在过但消失了”
 * 本身是变更信号。
 */
export function resolveSourceImages(
  knowledgeBaseRoot: string,
  sourceRelPath: string,
  markdown: string,
): SourceImageRef[] {
  const sourceDir = sourceRelPath.includes('/')
    ? sourceRelPath.slice(0, sourceRelPath.lastIndexOf('/'))
    : '';
  const result: SourceImageRef[] = [];
  for (const src of extractImageRefs(markdown)) {
    const rel = sourceDir ? `${sourceDir}/${src}` : src;
    try {
      // 'read' intent 要求存在；缺失文件降级为父目录 read + join（围栏仍校验）
      try {
        result.push({ src, file: resolveInside(knowledgeBaseRoot, rel, 'read') });
      } catch (error) {
        if (error instanceof PathGuardError && error.code === 'not_found') {
          const normalized = resolveInside(knowledgeBaseRoot, sourceDir || '.', 'read');
          result.push({ src, file: path.join(normalized, ...src.split('/')) });
        } else {
          throw error;
        }
      }
    } catch {
      /* path_escape / 非法段：丢弃该引用 */
    }
  }
  return result;
}

/**
 * 计算快照条目 mediaHash：按 src 排序逐文件 sha256 后合并；无图返回
 * null。缺失文件以 `missing:<name>` 占位参与哈希——图片消失与图片变化
 * 一样是变更。
 */
export function computeMediaHash(images: SourceImageRef[]): string | null {
  if (images.length === 0) return null;
  const combined = crypto.createHash('sha256');
  for (const image of [...images].sort((a, b) => a.src.localeCompare(b.src))) {
    combined.update(image.src, 'utf-8');
    try {
      combined.update(fs.readFileSync(image.file));
    } catch {
      combined.update(Buffer.from(`missing:${path.basename(image.file)}`, 'utf-8'));
    }
  }
  return `sha256:${combined.digest('hex')}`;
}

/** 单图内容哈希（vision 缓存键；与 VisionDescriber 的 imageHash 同公式）。 */
export function hashImageFile(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 在图片引用所在行之后插入 <image_description> 块（设计 §3.4）：
 * - 描述命中（described/cached）→ 带文本的元素（文本转义；描述同属不可信数据）
 * - 否则 → 自闭合 unavailable 标记（带 reason）
 * 每个 src 只在首次出现处插入一次；行内多次引用同图不重复。
 *
 * P0-S7（设计 §5.6）：可选 whiteboardText 解析器命中（非空文字）时，在
 * <image_description> 之前先插入 <whiteboard_text>（白板内文字逐字抽取，
 * 优先于识图描述）；resolve 返回 undefined 则该图不插描述（白板旁路文字
 * 命中时调用方用它跳过识图，省额度）。
 */
export function inlineImageBlocks(
  markdown: string,
  images: SourceImageRef[],
  resolve: (src: string) => ImageDescriptionLike | undefined,
  whiteboardText?: (src: string) => { origin: 'svg' | 'raw'; text: string; truncated: boolean } | undefined,
): string {
  if (images.length === 0) return markdown;
  const lines = markdown.split('\n');
  const output: string[] = [];
  const inserted = new Set<string>();
  for (const line of lines) {
    output.push(line);
    const blocks: string[] = [];
    for (const image of images) {
      if (inserted.has(image.src)) continue;
      if (!line.includes(image.src)) continue;
      inserted.add(image.src);
      const whiteboard = whiteboardText?.(image.src);
      if (whiteboard && whiteboard.text) {
        blocks.push(`<whiteboard_text src="${escapeXmlText(image.src)}" origin="${whiteboard.origin}" truncated="${whiteboard.truncated ? 'true' : 'false'}">\n${escapeXmlText(whiteboard.text)}\n</whiteboard_text>`);
      }
      const description = resolve(image.src);
      if (!description) continue;
      if (description.state === 'unavailable') {
        blocks.push(`<image_description src="${escapeXmlText(image.src)}" state="unavailable" reason="${escapeXmlText(description.reason ?? 'not_described')}"/>`);
      } else {
        blocks.push(`<image_description src="${escapeXmlText(image.src)}" state="${description.state}">\n${escapeXmlText(description.text ?? '')}\n</image_description>`);
      }
    }
    output.push(...blocks);
  }
  return output.join('\n');
}

/**
 * preflight 便利函数：为快照条目就地补充 mediaHash/imageCount（读取源
 * md → 枚举图片 → 哈希）。单条失败（文件不可读等）只跳过该条目——
 * mediaHash 留空按“无媒体信息”处理，contentHash 判定不受影响。
 */
export function enrichEntriesWithMedia(
  knowledgeBaseRoot: string,
  entries: RawSourceSnapshotEntry[],
): { totalImages: number } {
  let totalImages = 0;
  for (const entry of entries) {
    try {
      const content = fs.readFileSync(
        resolveInside(knowledgeBaseRoot, entry.relPath, 'read'),
        'utf-8',
      );
      const images = resolveSourceImages(knowledgeBaseRoot, entry.relPath, content);
      entry.imageCount = images.length;
      totalImages += images.length;
      entry.mediaHash = computeMediaHash(images);
      // P0-S7（§5.4/§5.5）：白板旁路文字 hash——同一读取顺带计算（旁路文件
      // 不进 contentHash/mediaHash，contentHash 公式不变）。
      entry.whiteboardTextHash = computeWhiteboardTextHash(
        extractWhiteboardBypassTexts(knowledgeBaseRoot, entry.relPath, content),
      );
    } catch {
      entry.imageCount = 0;
      entry.mediaHash = null;
      entry.whiteboardTextHash = '';
    }
  }
  return { totalImages };
}

/**
 * 发布前复核：重算单条目的 mediaHash 与快照值比对（verifySnapshotIntact
 * 对有 mediaHash 的源同步复核——构建中图片被替换 → 调用方抛
 * source_changed_during_build）。返回 true 表示一致或条目无媒体信息。
 */
export function verifyEntryMediaHash(
  knowledgeBaseRoot: string,
  entry: RawSourceSnapshotEntry,
): boolean {
  if (!entry.mediaHash) return true;
  let content: string;
  try {
    content = fs.readFileSync(resolveInside(knowledgeBaseRoot, entry.relPath, 'read'), 'utf-8');
  } catch {
    return false;
  }
  const images = resolveSourceImages(knowledgeBaseRoot, entry.relPath, content);
  const current = computeMediaHash(images);
  return current === entry.mediaHash;
}

// ============================================================================
// P0-S7 白板旁路文字（设计 P0 §5.4/§5.5/§5.6 + §10 裁定 1：svg 主 + raw 降级）
//
// 旁路文件（P0-S6 落盘契约）：与白板 PNG 预览同主干——
//   images/<stem>.wb.svg      （主产物，文字为真实 <text>/<tspan> 节点）
//   images/<stem>.wb.raw.json （svg 导出失败/超时/校验不过时的降级产物）
// 不被 md 引用、不进 contentHash/mediaHash；本节提供纯函数抽取 + 命名约定
// 寻址（无映射表）+ whiteboardTextHash。
// ============================================================================

/** 单源旁路文字抽取上限（设计 §5.4：缺省 8000 字符，超出截断并置 truncated）。 */
export const WHITEBOARD_TEXT_DEFAULT_MAX_CHARS = 8000;
/** 旁路输入体积上限（设计 §5.4：超 8 MiB 直接视为不可用，返回空）。 */
export const WHITEBOARD_INPUT_MAX_BYTES = 8 * 1024 * 1024;

export interface WhiteboardTextExtract {
  text: string;
  truncated: boolean;
}

function normalizeMaxChars(maxChars: number | undefined): number {
  return typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars >= 0
    ? Math.floor(maxChars)
    : WHITEBOARD_TEXT_DEFAULT_MAX_CHARS;
}

/** 行组装共享尾段：逐行累计到 maxChars，超出整行丢弃并置 truncated。 */
function assembleWhiteboardText(lines: string[], maxChars: number): WhiteboardTextExtract {
  const out: string[] = [];
  let used = 0;
  let truncated = false;
  for (const line of lines) {
    const cost = line.length + (out.length > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      truncated = true;
      break;
    }
    out.push(line);
    used += cost;
  }
  return { text: out.join('\n'), truncated };
}

/**
 * 解码 5 个 XML 预定义实体与十/十六进制数字字符引用；其它实体原样保留
 * （设计 §5.4）。非法码点（超出 Unicode 上限）原样保留，不抛错。
 */
function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(amp|lt|gt|quot|apos|#\d{1,10}|#x[0-9a-fA-F]{1,8});/g, (whole, name: string) => {
    switch (name) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        try {
          const code = name[1] === 'x' || name[1] === 'X'
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
  });
}

const SVG_COLLECT_TAGS = new Set(['text', 'tspan', 'foreignobject']);
const SVG_SKIP_TAGS = new Set(['script', 'style']);

/**
 * 从白板 SVG 导出内容抽取文字（设计 §5.4，P0-S1 实证：文字为真实
 * `<text>/<tspan>` 中文节点，非路径化字形）。
 *
 * - 有界标签扫描器（无 DOM、无新依赖）：收集 `<text>`/`<tspan>` 与
 *   `<foreignObject>` 内的文本节点；跳过 `<script>`/`<style>`/注释/CDATA。
 * - 一个 `<text>` 元素一行（嵌套 tspan 并入同一行）；保持文档顺序，不按
 *   坐标重排（空间关系交给识图，§5.6）；相邻重复行去重；空白归一。
 * - maxChars 缺省 8000，超出截断并置 truncated；输入超 8 MiB 返回空
 *   （视为不可用——调用方不插入空元素）。
 */
export function extractWhiteboardSvgText(
  svgContent: string,
  opts?: { maxChars?: number },
): WhiteboardTextExtract {
  if (typeof svgContent !== 'string' || svgContent.length === 0) return { text: '', truncated: false };
  if (Buffer.byteLength(svgContent, 'utf-8') > WHITEBOARD_INPUT_MAX_BYTES) {
    return { text: '', truncated: false };
  }
  const maxChars = normalizeMaxChars(opts?.maxChars);
  const len = svgContent.length;
  const lines: string[] = [];
  let line = '';
  let depth = 0;
  const pushLine = () => {
    const normalized = line.replace(/\s+/g, ' ').trim();
    line = '';
    if (!normalized) return;
    if (lines[lines.length - 1] === normalized) return; // 相邻重复行去重
    lines.push(normalized);
  };
  let i = 0;
  while (i < len) {
    if (svgContent[i] !== '<') {
      const next = svgContent.indexOf('<', i);
      const end = next < 0 ? len : next;
      if (depth > 0) line += decodeXmlEntities(svgContent.slice(i, end));
      i = end;
      continue;
    }
    if (svgContent.startsWith('<!--', i)) {
      const end = svgContent.indexOf('-->', i + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (svgContent.startsWith('<![CDATA[', i)) {
      const end = svgContent.indexOf(']]>', i + 9);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (svgContent.startsWith('<!', i) || svgContent.startsWith('<?', i)) {
      // DOCTYPE / 处理指令：跳到 '>'
      const end = svgContent.indexOf('>', i);
      i = end < 0 ? len : end + 1;
      continue;
    }
    // 标签：找结束 '>'（尊重引号内的 '>' 属性值）
    let quote: string | null = null;
    let j = i + 1;
    for (; j < len; j += 1) {
      const c = svgContent[j];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === '>') break;
    }
    if (j >= len) break; // 未闭合标签：有界终止
    const tag = svgContent.slice(i, j + 1);
    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(tag);
    if (match) {
      const closing = match[1] === '/';
      const name = match[2].toLowerCase();
      const selfClosing = tag.endsWith('/>');
      if (!closing && !selfClosing && SVG_SKIP_TAGS.has(name)) {
        const closeRe = new RegExp(`</${name}\\s*>`, 'gi');
        closeRe.lastIndex = j + 1;
        const closeMatch = closeRe.exec(svgContent);
        i = closeMatch ? closeMatch.index + closeMatch[0].length : len;
        continue;
      }
      if (SVG_COLLECT_TAGS.has(name)) {
        if (closing) {
          if (depth > 0) depth -= 1;
          if (name === 'text' || name === 'foreignobject') pushLine();
        } else if (!selfClosing) {
          depth += 1;
        }
      }
    }
    i = j + 1;
  }
  pushLine(); // 兜底：未闭合尾段
  return assembleWhiteboardText(lines, maxChars);
}

/**
 * 从白板 raw 导出（降级旁路）抽取文字（P0-S1 实证路径）：
 * 形状 `nodes[i].text.text` + 连线标注 `nodes[i].connector.captions.data[j].text`。
 * 未知结构宽容（非法 JSON / 无 nodes / 字段类型不符 → 返回空，不抛错）；
 * 保持节点顺序；与 SVG 抽取同一套行组装（空白归一 / 相邻去重 / 截断）。
 */
export function extractWhiteboardRawText(
  rawJson: string | unknown,
  opts?: { maxChars?: number },
): WhiteboardTextExtract {
  let data: unknown = rawJson;
  if (typeof rawJson === 'string') {
    if (!rawJson.trim()) return { text: '', truncated: false };
    if (Buffer.byteLength(rawJson, 'utf-8') > WHITEBOARD_INPUT_MAX_BYTES) {
      return { text: '', truncated: false };
    }
    try {
      data = JSON.parse(rawJson);
    } catch {
      return { text: '', truncated: false };
    }
  }
  const nodes = (data as { nodes?: unknown } | null | undefined)?.nodes;
  if (!Array.isArray(nodes)) return { text: '', truncated: false };
  const lines: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    if (lines[lines.length - 1] === normalized) return;
    lines.push(normalized);
  };
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const textObj = record.text;
    if (textObj && typeof textObj === 'object') push((textObj as Record<string, unknown>).text);
    const connector = record.connector;
    if (connector && typeof connector === 'object') {
      const captions = (connector as Record<string, unknown>).captions;
      if (captions && typeof captions === 'object') {
        const captionData = (captions as Record<string, unknown>).data;
        if (Array.isArray(captionData)) {
          for (const caption of captionData) {
            if (caption && typeof caption === 'object') {
              push((caption as Record<string, unknown>).text);
            }
          }
        }
      }
    }
  }
  return assembleWhiteboardText(lines, normalizeMaxChars(opts?.maxChars));
}

/** 白板 PNG 引用的旁路文件命中（svg 优先，raw 降级；命名约定寻址）。 */
export interface WhiteboardBypassRef {
  /** md 内白板 PNG 引用（src），与 inlineImageBlocks 对齐键一致 */
  src: string;
  /** 旁路文件绝对路径（围栏内） */
  file: string;
  origin: 'svg' | 'raw';
}

const WHITEBOARD_BYPASS_SUFFIXES: ReadonlyArray<{ suffix: string; origin: 'svg' | 'raw' }> = [
  { suffix: '.wb.svg', origin: 'svg' },
  { suffix: '.wb.raw.json', origin: 'raw' },
];

/**
 * 按命名约定探测白板旁路文件（设计 §5.2 + P0-S6 双产物）：对 md 图片引用
 * 去 `.png` 扩展名后接 `.wb.svg` / `.wb.raw.json`，svg 优先命中即止。
 * 旁路只有白板才有，探测即识别（无需 alt/类型标记）；越界/非法引用跳过。
 */
export function resolveWhiteboardBypassRefs(
  knowledgeBaseRoot: string,
  sourceRelPath: string,
  markdown: string,
): WhiteboardBypassRef[] {
  const sourceDir = sourceRelPath.includes('/')
    ? sourceRelPath.slice(0, sourceRelPath.lastIndexOf('/'))
    : '';
  const result: WhiteboardBypassRef[] = [];
  for (const src of extractImageRefs(markdown)) {
    const stem = src.replace(/\.[^./\\]+$/, '');
    for (const { suffix, origin } of WHITEBOARD_BYPASS_SUFFIXES) {
      const rel = `${stem}${suffix}`;
      const relWithDir = sourceDir ? `${sourceDir}/${rel}` : rel;
      try {
        let resolved: string;
        try {
          resolved = resolveInside(knowledgeBaseRoot, relWithDir, 'read');
        } catch (error) {
          if (error instanceof PathGuardError && error.code === 'not_found') {
            const normalized = resolveInside(knowledgeBaseRoot, sourceDir || '.', 'read');
            resolved = path.join(normalized, ...relWithDir.split('/'));
          } else {
            throw error;
          }
        }
        const stat = fs.statSync(resolved, { throwIfNoEntry: false });
        if (stat?.isFile()) {
          result.push({ src, file: resolved, origin });
          break;
        }
      } catch {
        /* path_escape / 非法段：跳过该旁路探测 */
      }
    }
  }
  return result;
}

/** 旁路命中后的抽取结果（仅保留非空 text——空 = 不可用，不内联不进 hash）。 */
export interface WhiteboardBypassText extends WhiteboardTextExtract {
  src: string;
  origin: 'svg' | 'raw';
}

/**
 * 读取旁路文件并抽取白板文字（svg 主 / raw 降级）。缺文件、超 8 MiB、
 * 抽取为空一律跳过（降级语义，不抛错）；结果按引用顺序返回。
 */
export function extractWhiteboardBypassTexts(
  knowledgeBaseRoot: string,
  sourceRelPath: string,
  markdown: string,
  opts?: { maxChars?: number },
): WhiteboardBypassText[] {
  const result: WhiteboardBypassText[] = [];
  for (const ref of resolveWhiteboardBypassRefs(knowledgeBaseRoot, sourceRelPath, markdown)) {
    try {
      const stat = fs.statSync(ref.file);
      if (!stat.isFile() || stat.size === 0 || stat.size > WHITEBOARD_INPUT_MAX_BYTES) continue;
      const content = fs.readFileSync(ref.file, 'utf-8');
      const extracted = ref.origin === 'svg'
        ? extractWhiteboardSvgText(content, opts)
        : extractWhiteboardRawText(content, opts);
      if (!extracted.text) continue;
      result.push({ src: ref.src, origin: ref.origin, text: extracted.text, truncated: extracted.truncated });
    } catch {
      /* 旁路缺失/不可读是降级语义，不阻断 */
    }
  }
  return result;
}

/**
 * 单源 whiteboardTextHash（设计 §5.4 公式的文字版）：按引用顺序拼接
 * `<ref>\0<sha256(origin\0text)>\n` 后整体 sha256；无旁路文字的源为 ''。
 * origin 进哈希——svg→raw 降级切换（同文字）也算消费内容变化。
 */
export function computeWhiteboardTextHash(
  texts: ReadonlyArray<{ src: string; origin: 'svg' | 'raw'; text: string }>,
): string {
  if (texts.length === 0) return '';
  const combined = crypto.createHash('sha256');
  for (const item of texts) {
    combined.update(item.src, 'utf-8');
    combined.update('\0', 'utf-8');
    const perItem = crypto.createHash('sha256')
      .update(item.origin, 'utf-8')
      .update('\0', 'utf-8')
      .update(item.text, 'utf-8')
      .digest('hex');
    combined.update(perItem, 'utf-8');
    combined.update('\n', 'utf-8');
  }
  return `sha256:${combined.digest('hex')}`;
}

/** buildState 用的旁路文字条目（objToken → src → 抽取结果）。 */
export type WhiteboardTextMap = Map<string, { origin: 'svg' | 'raw'; text: string; truncated: boolean }>;

/**
 * 为快照条目批量预取旁路文字（构建 preflight / 会话 raw_read 内联共用数据
 * 源）。只保留有非空文字的源；单条失败跳过（与 enrichEntriesWithMedia 同
 * 容错语义）。
 */
export function collectWhiteboardTextsForEntries(
  knowledgeBaseRoot: string,
  entries: RawSourceSnapshotEntry[],
): Map<string, WhiteboardTextMap> {
  const result = new Map<string, WhiteboardTextMap>();
  for (const entry of entries) {
    try {
      const content = fs.readFileSync(
        resolveInside(knowledgeBaseRoot, entry.relPath, 'read'),
        'utf-8',
      );
      const texts = extractWhiteboardBypassTexts(knowledgeBaseRoot, entry.relPath, content);
      if (texts.length === 0) continue;
      result.set(entry.objToken, new Map(texts.map((item) => [
        item.src,
        { origin: item.origin, text: item.text, truncated: item.truncated },
      ])));
    } catch {
      /* 源不可读：无旁路文字（快照/读取链路另行报错） */
    }
  }
  return result;
}

/**
 * 发布前复核（P0-S7）：重算单条目 whiteboardTextHash 与快照值比对。
 * 旧 manifest 无该字段 → 恒真（additive 兼容，升级不触发全量 changed）。
 */
export function verifyEntryWhiteboardTextHash(
  knowledgeBaseRoot: string,
  entry: RawSourceSnapshotEntry,
): boolean {
  if (entry.whiteboardTextHash === undefined || entry.whiteboardTextHash === null) return true;
  let content: string;
  try {
    content = fs.readFileSync(resolveInside(knowledgeBaseRoot, entry.relPath, 'read'), 'utf-8');
  } catch {
    return false;
  }
  const current = computeWhiteboardTextHash(
    extractWhiteboardBypassTexts(knowledgeBaseRoot, entry.relPath, content),
  );
  return current === entry.whiteboardTextHash;
}

/**
 * 只补 whiteboardTextHash（不动 mediaHash/imageCount）——/api/kb/status
 * 预览（routes/kb.ts compareSources）的轻量 enrich：RawSourceSnapshot.scan
 * 的条目不带该字段，与非空 manifest 值恒不等会虚报 pending changed。
 * 单条失败按 ''（无旁路文字）。mediaHash 语义保持不变（vision 判定仍由
 * 构建链 enrich）。
 */
export function enrichEntriesWithWhiteboardTextHash(
  knowledgeBaseRoot: string,
  entries: RawSourceSnapshotEntry[],
): void {
  for (const entry of entries) {
    try {
      const content = fs.readFileSync(
        resolveInside(knowledgeBaseRoot, entry.relPath, 'read'),
        'utf-8',
      );
      entry.whiteboardTextHash = computeWhiteboardTextHash(
        extractWhiteboardBypassTexts(knowledgeBaseRoot, entry.relPath, content),
      );
    } catch {
      entry.whiteboardTextHash = '';
    }
  }
}
