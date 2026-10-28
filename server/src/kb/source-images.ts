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
 */
export function inlineImageBlocks(
  markdown: string,
  images: SourceImageRef[],
  resolve: (src: string) => ImageDescriptionLike | undefined,
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
    } catch {
      entry.imageCount = 0;
      entry.mediaHash = null;
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
