import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { resolveInside } from '../agent/path-guard.js';
import { StandardKbStore } from './standard-kb-store.js';
import type { KbManifestDoc } from '../types/agent-knowledge.js';
import type { EvidenceResourcesFile } from './knowledge-compiler.js';

export class DistributionError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 413 | 503 = 400) { super(message); }
}
export interface DocumentSelection { releaseId: string; docIds: string[] }
export function selectDocuments(root: string, input: DocumentSelection) {
  if (!input || typeof input.releaseId !== 'string' || !Array.isArray(input.docIds)
    || !input.docIds.length || input.docIds.length > 1000 || input.docIds.some(id => typeof id !== 'string')) {
    throw new DistributionError('请选择 1–1000 篇标准库文档');
  }
  const store = new StandardKbStore(root);
  if (store.readCurrent()?.releaseId !== input.releaseId) throw new DistributionError('标准库版本已变化，请刷新后重试', 409);
  const manifest = store.readManifest(input.releaseId);
  if (!manifest) throw new DistributionError('标准库版本不可用', 404);
  const docs = [...new Set(input.docIds)].map(id => {
    const doc = manifest.docs.find(d => d.docId === id);
    if (!doc) throw new DistributionError('所选文档不存在', 404);
    if (/[\\:\x00-\x1f]/.test(doc.path) || doc.path.split('/').some(part => !part || part === '.' || part === '..') || !doc.path.endsWith('.md')) {
      throw new DistributionError('文档路径无效');
    }
    return doc;
  });
  let bytes = 0;
  return { store, docs: docs.map(doc => {
    const loaded = store.readReleaseDoc(manifest.releaseId, doc);
    bytes += Buffer.byteLength(loaded.markdown);
    if (bytes > 32 * 1024 ** 2) throw new DistributionError('所选正文超过 32 MB，请分批操作', 413);
    return loaded;
  }) };
}

/** Resolve only relative URLs; never let URL decoding turn links into filesystem roots. */
export function relativeTarget(current: string, href: string): { path: string; hash: string } | null {
  try {
    if (/^[a-z][a-z\d+.-]*:|^[/\\]/i.test(href)) return null;
    const hashAt = href.indexOf('#');
    const hash = hashAt < 0 ? '' : href.slice(hashAt);
    const raw = href.split(/[?#]/)[0];
    const decoded = decodeURIComponent(raw);
    if (/^[a-z][a-z\d+.-]*:|^[/\\]/i.test(decoded) || /[\\\x00-\x1f]/.test(decoded)) return null;
    const target = raw ? path.posix.normalize(path.posix.join(path.posix.dirname(current), decoded)) : current;
    return target === '..' || target.startsWith('../') ? null : { path: target, hash };
  } catch { return null; }
}

type Render = (markdown: string, link: (href: string) => string | null, image: (src: string) => string | null) => string;
let renderFunction: Render | undefined;
export function renderDocument(markdown: string, link: (href: string) => string | null, image: (src: string) => string | null): string {
  renderFunction ??= (createRequire(import.meta.url)(fileURLToPath(new URL('../../dist/share-render.cjs', import.meta.url))) as { render: Render }).render;
  return renderFunction(markdown, link, image);
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp' };
export function readImage(store: StandardKbStore, releaseId: string, doc: KbManifestDoc, src: string) {
  const target = relativeTarget(`docs/${doc.path}`, src);
  if (!target || !IMAGE_TYPES[path.extname(target.path).toLowerCase()]) return null;
  try {
    const release = store.queryService.resolveRelease(releaseId);
    let file: string;
    let expectedHash: string | undefined;
    try { file = resolveInside(release.releaseDir, target.path, 'read'); }
    catch {
      // Organized releases freeze source images as evidence/*.bin. Resolve the
      // registered image of this document's source, never the mutable raw library.
      const evidence = release.manifest.evidence;
      if (!evidence) return null;
      const indexFile = resolveInside(release.releaseDir, evidence.resourcesPath, 'read');
      if (fs.statSync(indexFile).size > 8 * 1024 ** 2) return null;
      const indexBytes = fs.readFileSync(indexFile);
      if (`sha256:${createHash('sha256').update(indexBytes).digest('hex')}` !== evidence.hash) return null;
      const index = JSON.parse(indexBytes.toString('utf8')) as EvidenceResourcesFile;
      const matches = index.evidenceFiles.filter(item => item.kind === 'image' && item.image?.src === src
        && doc.sources.some(token => item.resourceId === `${token}#image:${src}`));
      if (!matches.length || new Set(matches.map(item => item.hash)).size !== 1) return null;
      file = resolveInside(release.releaseDir, matches[0].path, 'read');
      expectedHash = matches[0].hash;
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024 ** 2) return null;
    const bytes = fs.readFileSync(file);
    if (expectedHash && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expectedHash) return null;
    return { path: target.path, bytes, type: IMAGE_TYPES[path.extname(target.path).toLowerCase()] };
  } catch { return null; }
}

export async function exportDocuments(root: string, input: DocumentSelection & { format: 'md' | 'zip' }) {
  if (!input || !['md', 'zip'].includes(input.format)) throw new DistributionError('导出格式无效');
  const { store, docs } = selectDocuments(root, input);
  if (input.format === 'md') {
    if (docs.length !== 1) throw new DistributionError('单个 Markdown 文件只能导出一篇文档');
    return { bytes: Buffer.from(docs[0].markdown), name: path.posix.basename(docs[0].doc.path), type: 'text/markdown; charset=utf-8' };
  }
  const zip = new JSZip();
  const images = new Set<string>();
  let bytes = 0;
  for (const { doc, markdown } of docs) {
    if (!relativeTarget('index.md', doc.path) || !doc.path.endsWith('.md')) throw new DistributionError('文档路径无效');
    zip.file(`docs/${doc.path}`, markdown);
    renderDocument(markdown, () => null, src => {
      const image = readImage(store, input.releaseId, doc, src);
      if (image && !images.has(image.path)) {
        images.add(image.path); bytes += image.bytes.length;
        if (bytes > 128 * 1024 ** 2) throw new DistributionError('图片总量超过 128 MB，请分批导出', 413);
        zip.file(image.path, image.bytes);
      }
      return null;
    });
  }
  return { bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), name: 'standard-documents.zip', type: 'application/zip' };
}
