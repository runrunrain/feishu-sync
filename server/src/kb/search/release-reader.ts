/** Read-only release resolution. Check existence and realpath BEFORE consulting index caches. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { resolveInside } from '../../agent/path-guard.js';
import type { KbCurrentPointer, KbManifest, KbOrganizationManifestSection } from '../../types/agent-knowledge.js';
import type { KnowledgeManifest } from '../knowledge-schema.js';
import { QueryError, invalid } from './query-error.js';
export interface ResolvedRelease {
  releaseId: string;
  releaseDir: string;
  manifest: KbManifest;
  currentReleaseId?: string;
  /** v2（A案 §10.2）：schemaVersion=2 时的组织段（knowledge.json 描述） */
  organization?: KbOrganizationManifestSection;
}
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
    // A案 §10.2 双读器：v1 与 v2（=2 且必含 organization）显式接受；v2 缺
    // 组织段视为非法（老消费者忽略新状态会造成静默误用），其余版本拒绝。
    if ((manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) || manifest.releaseId !== id || typeof manifest.buildId !== 'string' || typeof manifest.publishedAt !== 'string'
      || !['full', 'incremental'].includes(manifest.mode) || (manifest.baseReleaseId !== null && typeof manifest.baseReleaseId !== 'string')
      || (manifest.model !== null && typeof manifest.model !== 'string') || !Array.isArray(manifest.docs) || !Array.isArray(manifest.sourceSnapshot)) throw new Error('manifest identity/fields invalid');
    if (manifest.schemaVersion === 2) {
      const organization = manifest.organization;
      if (!organization || organization.path !== 'knowledge.json' || typeof organization.schemaVersion !== 'number'
        || typeof organization.hash !== 'string' || organization.hash.length === 0
        || (organization.coverageMode !== 'managed' && organization.coverageMode !== 'mixed')) {
        throw new Error('manifest v2 organization section invalid');
      }
      if (manifest.evidence && (typeof manifest.evidence.resourcesPath !== 'string' || typeof manifest.evidence.hash !== 'string')) throw new Error('manifest evidence section invalid');
      if (manifest.governance && (typeof manifest.governance.path !== 'string' || typeof manifest.governance.hash !== 'string')) throw new Error('manifest governance section invalid');
    }
    if (!manifest.sourceSnapshot.every((s) => s && typeof s.objToken === 'string' && typeof s.title === 'string' && typeof s.relPath === 'string')) throw new Error('manifest sources invalid');
    const paths = new Set<string>(), ids = new Set<string>();
    for (const d of manifest.docs) {
      if (!d || !['docId', 'path', 'title', 'summary', 'contentHash'].every((k) => typeof (d as unknown as Record<string, unknown>)[k] === 'string')
        || !Array.isArray(d.tags) || !d.tags.every((v) => typeof v === 'string') || !Array.isArray(d.sources) || !d.sources.every((v) => typeof v === 'string')
        || paths.has(d.path) || ids.has(d.docId)) throw new Error('invalid/duplicate manifest doc');
      paths.add(d.path); ids.add(d.docId);
    }
    return {
      releaseId: id, releaseDir, manifest, currentReleaseId: current?.releaseId,
      ...(manifest.schemaVersion === 2 ? { organization: manifest.organization } : {}),
    };
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

export interface ResolvedKnowledge {
  releaseId: string;
  organization: KbOrganizationManifestSection;
  knowledge: KnowledgeManifest;
}

/**
 * A案 §6.2/§8.2：加载 release 的 knowledge.json 并按 organization 描述
 * hash 校验。sidecar 损坏/哈希不一致 → 组织查询失败（kb_index_failed），
 * **不回退**成无状态全文结果；MCP 不依赖 SQLite——knowledge.json 全量
 * 自包含。v1 release 无组织段 → kb_not_found（调用方据此区分双写期）。
 */
export function loadReleaseKnowledge(release: ResolvedRelease): ResolvedKnowledge {
  if (!release.organization) {
    throw new QueryError('kb_not_found', '该 release 无知识组织数据（v1 或未组织化）');
  }
  let bytes: Buffer;
  try {
    const file = resolveInside(release.releaseDir, release.organization.path, 'read');
    bytes = fs.readFileSync(file);
  } catch (e) {
    throw new QueryError('kb_index_failed', 'knowledge.json 无法读取', { detail: String(e) });
  }
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (hash !== release.organization.hash) {
    throw new QueryError('kb_index_failed', 'knowledge.json 损坏或与 manifest 哈希不一致（组织查询失败，不回退无状态全文）', { releaseId: release.releaseId });
  }
  let knowledge: KnowledgeManifest;
  try {
    knowledge = JSON.parse(bytes.toString('utf8')) as KnowledgeManifest;
  } catch (e) {
    throw new QueryError('kb_index_failed', 'knowledge.json 不是合法 JSON', { detail: String(e) });
  }
  if (typeof knowledge.schemaVersion !== 'number' || !Array.isArray(knowledge.objects)
    || !Array.isArray(knowledge.presentations) || !Array.isArray(knowledge.relations)
    || !Array.isArray(knowledge.evidence) || !Array.isArray(knowledge.documents)) {
    throw new QueryError('kb_index_failed', 'knowledge.json 结构不完整');
  }
  return { releaseId: release.releaseId, organization: release.organization, knowledge };
}
