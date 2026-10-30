import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInside } from '../agent/path-guard.js';
import { extractImageRefs } from './source-images.js';
import { loadRawWorkbook, type LoadedRawWorkbook } from './raw-workbook.js';
import { QueryError } from './search/query-error.js';
import type { RawCatalog, RawCatalogEntry } from './raw-mcp-catalog.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_HASH_BYTES = 20 * 1024 * 1024;
export interface RawImageInfo { src: string; origin: 'document'|'workbook'; alt?: string; sheet?: string; available: boolean; mimeType?: string; imageHash?: string; description?: string; reason?: string }
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}
function hashLargeFile(file: string): { hash: string; mimeType?: string } {
  const fd = fs.openSync(file, 'r');
  try {
    const digest = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(64 * 1024); let total = 0, mimeType: string | undefined;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
      if (!total) mimeType = imageMime(chunk.subarray(0, count));
      total += count; if (total > MAX_HASH_BYTES) throw Error('too_large');
      digest.update(chunk.subarray(0, count));
    }
    return { hash: digest.digest('hex'), mimeType };
  } finally { fs.closeSync(fd); }
}

/** Only application-owned, content-addressed cached descriptions; never calls a vision provider. */
function cachedDescription(cacheRoot: string | undefined, hash: string): string | undefined {
  if (!cacheRoot) return;
  try {
    const bucket = resolveInside(cacheRoot, hash.slice(0, 2), 'read');
    const current = `${hash}.json`;
    const legacy = fs.readdirSync(bucket).filter((name) => new RegExp(`^${hash}\\.[a-f0-9]{12}\\.json$`).test(name));
    const read = (name: string) => {
      try {
        const file = resolveInside(cacheRoot, `${hash.slice(0, 2)}/${name}`, 'read');
        if (fs.statSync(file).size > 1024 * 1024) return;
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value.imageHash === hash && typeof value.text === 'string' && value.text.trim()) return { text: value.text, time: Date.parse(value.createdAt) || fs.statSync(file).mtimeMs };
      } catch { /* An invalid cache entry is not an image description. */ }
    };
    const preferred = read(current); if (preferred) return preferred.text;
    return legacy.map(read).filter((x): x is { text: string; time: number } => Boolean(x)).sort((a, b) => b.time - a.time)[0]?.text;
  } catch { return; }
}

function relativeImage(catalog: RawCatalog, entry: RawCatalogEntry, src: string): string | undefined {
  try {
    const decoded = decodeURIComponent(src);
    if (!decoded || decoded.includes('\\') || decoded.split('/').includes('..') || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(decoded)) return;
    return resolveInside(catalog.root, path.posix.join(path.posix.dirname(entry.relPath), decoded), 'read');
  } catch { return; }
}
function altText(content: string, src: string): string | undefined {
  for (const match of content.matchAll(/!\[([^\]]*)\]\(\s*([^\s)]+)/g)) if (match[2] === src && match[1]) return match[1];
  return undefined;
}

export class RawImageService {
  private readonly descriptions = new Map<string, { statKey: string; hash: string; description?: string; mimeType?: string }>();
  constructor(private readonly cacheRoot?: string) {}
  private describe(bytes: Buffer): { imageHash: string; mimeType?: string; description?: string } {
    const imageHash = crypto.createHash('sha256').update(bytes).digest('hex');
    return { imageHash, mimeType: imageMime(bytes), description: cachedDescription(this.cacheRoot, imageHash) };
  }
  private documentImage(catalog: RawCatalog, entry: RawCatalogEntry, content: string, src: string): RawImageInfo {
    const alt = altText(content, src);
    const base: RawImageInfo = { src, origin: 'document', available: false, ...(alt ? { alt } : {}) };
    const file = relativeImage(catalog, entry, src);
    if (!file) return { ...base, reason: 'missing_or_outside_root' };
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return { ...base, reason: 'not_file' };
      if (stat.size > MAX_IMAGE_BYTES) {
        if (stat.size > MAX_HASH_BYTES) return { ...base, reason: 'too_large' };
        const { hash, mimeType } = hashLargeFile(file), description = cachedDescription(this.cacheRoot, hash);
        return { ...base, reason: 'too_large', imageHash: hash, ...(mimeType ? { mimeType } : {}), ...(description ? { description } : {}) };
      }
      const statKey = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      let cached = this.descriptions.get(file);
      if (!cached || cached.statKey !== statKey) {
        const described = this.describe(fs.readFileSync(file));
        cached = { statKey, hash: described.imageHash, mimeType: described.mimeType, description: described.description };
      } else {
        // Descriptions may be produced after the image itself; refresh the cache lookup.
        cached.description = cachedDescription(this.cacheRoot, cached.hash);
      }
      this.descriptions.delete(file); this.descriptions.set(file, cached);
      while (this.descriptions.size > 1000) this.descriptions.delete(this.descriptions.keys().next().value!);
      return { ...base, available: Boolean(cached.mimeType), imageHash: cached.hash,
        ...(cached.mimeType ? { mimeType: cached.mimeType } : { reason: 'unsupported_format' }), ...(cached.description ? { description: cached.description } : {}) };
    } catch { return { ...base, reason: 'unreadable' }; }
  }
  documentImages(catalog: RawCatalog, entry: RawCatalogEntry, content: string): RawImageInfo[] {
    return extractImageRefs(content).map((src) => this.documentImage(catalog, entry, content, src));
  }
  private excelImages(loaded: LoadedRawWorkbook): RawImageInfo[] {
    const images: RawImageInfo[] = [];
    for (const [index, sheet] of loaded.workbook.worksheets.entries()) {
      const seen = new Set<number>();
      for (const image of sheet.getImages()) {
        const imageId = Number(image.imageId);
        if (!Number.isSafeInteger(imageId) || seen.has(imageId)) continue;
        seen.add(imageId);
        const src = `workbook:${index}:${imageId}`;
        const media = loaded.workbook.getImage(imageId);
        const bytes = media?.buffer ? Buffer.from(media.buffer) : media?.base64 ? Buffer.from(media.base64.replace(/^data:[^,]*,/, ''), 'base64') : undefined;
        if (!bytes) { images.push({ src, origin: 'workbook', sheet: sheet.name, available: false, reason: 'missing' }); continue; }
        if (bytes.length > MAX_IMAGE_BYTES) {
          const described = bytes.length <= MAX_HASH_BYTES ? this.describe(bytes) : undefined;
          images.push({ src, origin: 'workbook', sheet: sheet.name, available: false, reason: 'too_large', ...(described ?? {}) }); continue;
        }
        const info = this.describe(bytes);
        images.push({ src, origin: 'workbook', sheet: sheet.name, available: Boolean(info.mimeType), imageHash: info.imageHash,
          ...(info.mimeType ? { mimeType: info.mimeType } : { reason: 'unsupported_format' }), ...(info.description ? { description: info.description } : {}) });
      }
    }
    return images;
  }
  async list(catalog: RawCatalog, entry: RawCatalogEntry, content: string): Promise<{ images: RawImageInfo[]; workbookStatus: 'checked'|'not_available'|'unreadable' }> {
    const images = this.documentImages(catalog, entry, content);
    try {
      const workbook = await loadRawWorkbook(catalog, entry);
      return { images: [...images, ...this.excelImages(workbook)], workbookStatus: 'checked' };
    } catch (error) {
      return { images, workbookStatus: error instanceof QueryError && error.code === 'raw_workbook_unavailable' ? 'not_available' : 'unreadable' };
    }
  }
  async read(catalog: RawCatalog, entry: RawCatalogEntry, content: string, src: string, expectedHash?: string, includeImage = true): Promise<{ info: RawImageInfo; data?: string }> {
    const workbookRef = /^workbook:(\d+):(\d+)$/.exec(src);
    let bytes: Buffer; let info: RawImageInfo;
    if (workbookRef) {
      const loaded = await loadRawWorkbook(catalog, entry), sheet = loaded.workbook.worksheets[Number(workbookRef[1])], imageId = Number(workbookRef[2]);
      if (!sheet || !sheet.getImages().some((image) => Number(image.imageId) === imageId)) throw new QueryError('raw_image_unavailable', '图片不属于该工作表');
      const media = loaded.workbook.getImage(imageId);
      if (media?.buffer) bytes = Buffer.from(media.buffer);
      else if (media?.base64) bytes = Buffer.from(media.base64.replace(/^data:[^,]*,/, ''), 'base64');
      else throw new QueryError('raw_image_unavailable', '工作簿图片不可读取');
      info = { src, origin: 'workbook', sheet: sheet.name, available: true };
    } else {
      if (!extractImageRefs(content).includes(src)) throw new QueryError('raw_image_unavailable', '图片不属于此源文档');
      const file = relativeImage(catalog, entry, src);
      if (!file) throw new QueryError('raw_image_unavailable', '本地图片缺失或路径越界');
      try {
        const size = fs.statSync(file).size;
        if (size > MAX_HASH_BYTES || size > MAX_IMAGE_BYTES && includeImage) throw Error();
        if (size > MAX_IMAGE_BYTES) {
          const { hash, mimeType } = hashLargeFile(file);
          if (expectedHash && expectedHash !== hash) throw new QueryError('raw_changed', '图片已变化，请重新查询图片列表');
          if (!mimeType) throw new QueryError('raw_image_unavailable', '图片格式不受支持');
          const description = cachedDescription(this.cacheRoot, hash);
          return { info: { src, origin: 'document', available: false, reason: 'too_large', imageHash: hash, mimeType,
            ...(description ? { description } : {}) } };
        }
        bytes = fs.readFileSync(file);
      }
      catch (error) {
        if (error instanceof QueryError) throw error;
        throw new QueryError('raw_image_unavailable', '图片不可读或超过 4 MiB');
      }
      info = { src, origin: 'document', available: true, ...(altText(content, src) ? { alt: altText(content, src) } : {}) };
    }
    if (bytes.length > MAX_HASH_BYTES || bytes.length > MAX_IMAGE_BYTES && includeImage) throw new QueryError('raw_image_unavailable', '图片超过 4 MiB');
    const described = this.describe(bytes);
    if (!described.mimeType) throw new QueryError('raw_image_unavailable', '图片格式不受支持');
    if (expectedHash && expectedHash !== described.imageHash) throw new QueryError('raw_changed', '图片已变化，请重新查询图片列表');
    return { info: { ...info, ...described, ...(bytes.length > MAX_IMAGE_BYTES ? { available: false, reason: 'too_large' } : {}) },
      ...(includeImage ? { data: bytes.toString('base64') } : {}) };
  }
}
