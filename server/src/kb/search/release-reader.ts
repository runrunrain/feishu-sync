/** Read-only release resolution. Check existence and realpath BEFORE consulting index caches. */
import fs from 'node:fs';
import { resolveInside } from '../../agent/path-guard.js';
import type { KbCurrentPointer, KbManifest } from '../../types/agent-knowledge.js';
import { QueryError, invalid } from './query-error.js';
export interface ResolvedRelease { releaseId: string; releaseDir: string; manifest: KbManifest; currentReleaseId?: string }
export function validateReleaseId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(id) || id === '.' || id === '..') invalid('releaseId');
}
export function readCurrent(kbRoot: string): KbCurrentPointer | null {
  try {
    const file = resolveInside(kbRoot, 'CURRENT.json', 'read');
    const pointer = JSON.parse(fs.readFileSync(file, 'utf8')) as KbCurrentPointer;
    validateReleaseId(pointer.releaseId);
    if (typeof pointer.publishedAt !== 'string') throw new Error('publishedAt missing');
    return pointer;
  } catch (e) {
    if (!fs.existsSync(kbRoot) || (e as { code?: string }).code === 'not_found') return null;
    throw new QueryError('kb_index_failed', 'CURRENT.json 无效', { detail: String(e) });
  }
}
export function resolveRelease(kbRoot: string, requested?: string): ResolvedRelease {
  if (requested !== undefined) validateReleaseId(requested);
  const current = readCurrent(kbRoot);
  const id = requested ?? current?.releaseId;
  if (!id) throw new QueryError('kb_not_published', '标准知识库尚未发布');
  let releaseDir: string;
  try {
    const releasesDir = resolveInside(kbRoot, 'releases', 'read');
    releaseDir = resolveInside(releasesDir, id, 'read');
    if (!fs.statSync(releaseDir).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new QueryError('kb_release_unavailable', '指定版本不存在、已被清理或越出 releases 围栏', { currentReleaseId: current?.releaseId ?? null });
  }
  try {
    const file = resolveInside(releaseDir, 'manifest.json', 'read');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as KbManifest;
    if (manifest.schemaVersion !== 1 || manifest.releaseId !== id || typeof manifest.buildId !== 'string' || typeof manifest.publishedAt !== 'string'
      || !['full', 'incremental'].includes(manifest.mode) || (manifest.baseReleaseId !== null && typeof manifest.baseReleaseId !== 'string')
      || (manifest.model !== null && typeof manifest.model !== 'string') || !Array.isArray(manifest.docs) || !Array.isArray(manifest.sourceSnapshot)) throw new Error('manifest identity/fields invalid');
    if (!manifest.sourceSnapshot.every((s) => s && typeof s.objToken === 'string' && typeof s.title === 'string' && typeof s.relPath === 'string')) throw new Error('manifest sources invalid');
    const paths = new Set<string>(), ids = new Set<string>();
    for (const d of manifest.docs) {
      if (!d || !['docId', 'path', 'title', 'summary', 'contentHash'].every((k) => typeof (d as unknown as Record<string, unknown>)[k] === 'string')
        || !Array.isArray(d.tags) || !d.tags.every((v) => typeof v === 'string') || !Array.isArray(d.sources) || !d.sources.every((v) => typeof v === 'string')
        || paths.has(d.path) || ids.has(d.docId)) throw new Error('invalid/duplicate manifest doc');
      paths.add(d.path); ids.add(d.docId);
    }
    return { releaseId: id, releaseDir, manifest, currentReleaseId: current?.releaseId };
  } catch (e) { throw new QueryError('kb_index_failed', '发布 manifest 无效或无法读取', { detail: String(e) }); }
}
export function availableReleases(kbRoot: string): string[] {
  try {
    const dir = resolveInside(kbRoot, 'releases', 'read');
    return fs.readdirSync(dir).filter((id) => {
      try { validateReleaseId(id); const release = resolveInside(dir, id, 'read'); return fs.statSync(resolveInside(release, 'manifest.json', 'read')).isFile(); } catch { return false; }
    }).sort();
  } catch { return []; }
}
