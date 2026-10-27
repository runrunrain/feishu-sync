/** 发布版本中的源原文快照与变更元数据；与docs正文分离，无Git/SQLite依赖。 */
import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from '../agent/path-guard.js';
import { StandardKbStore } from './standard-kb-store.js';
import { RawSourceSnapshot } from './raw-source-snapshot.js';
import { lineDiff } from './line-diff.js';
import type { KbManifest } from '../types/agent-knowledge.js';
import type { KbChangePreview, KbFileChange, KbVersionDto } from '../types/kb-version.js';

export type SourceContents = Record<string, string>;
export const validReleaseId = (id: string) => /^[A-Za-z0-9_-]{1,120}$/.test(id);

export function captureSourceContents(snapshot: RawSourceSnapshot, root: string): SourceContents {
  return Object.fromEntries(snapshot.entries.map((entry) => {
    const read = snapshot.readVerified(root, entry.objToken);
    const attachments = read.attachments.map((a, index) => `\n\n--- CSV ${index + 1} ---\n${a.content}`).join('');
    return [entry.objToken, read.content + attachments];
  }));
}

export function sourceChangePreview(
  snapshot: RawSourceSnapshot,
  contents: SourceContents,
  base: KbManifest | null,
  previous: SourceContents,
  excluded = new Set<string>(),
): KbChangePreview {
  const current = new Map(snapshot.entries.map((entry) => [entry.objToken, entry]));
  const before = new Map((base?.sourceSnapshot ?? []).map((entry) => [entry.objToken, entry]));
  const sources: KbFileChange[] = [];
  for (const token of [...new Set([...current.keys(), ...before.keys()])].sort()) {
    const old = before.get(token); const next = current.get(token);
    if (old && next && old.contentHash === next.contentHash && old.relPath === next.relPath && old.title === next.title) continue;
    const kind = !old ? 'added' : !next ? 'removed' : 'changed';
    const beforeAvailable = !old || Object.hasOwn(previous, token);
    sources.push({
      key: token, title: (next ?? old)!.title, path: (next ?? old)!.relPath, kind,
      reason: !next ? (excluded.has(token) ? 'excluded' : 'missing') : 'content',
      beforeAvailable,
      ...(beforeAvailable ? lineDiff(old ? previous[token] : '', next ? contents[token] ?? '' : '')
        : { patch: '', additions: 0, deletions: 0, truncated: false }),
    });
  }
  const touched = new Set(sources.map((s) => s.key));
  return {
    baseReleaseId: base?.releaseId ?? null, sources,
    affectedDocs: (base?.docs ?? []).filter((doc) => doc.sources.some((token) => touched.has(token)))
      .map(({ docId, path: docPath, title }) => ({ docId, path: docPath, title })),
  };
}

export class KbVersionStore {
  private readonly store: StandardKbStore;
  constructor(private readonly root: string) { this.store = new StandardKbStore(root); }

  private readJson<T>(releaseId: string, name: string): T | null {
    if (!validReleaseId(releaseId)) return null;
    try {
      const releaseRoot = fs.realpathSync.native(path.join(this.root, 'releases'));
      const file = fs.realpathSync.native(path.join(releaseRoot, releaseId, name));
      const versionRoot = fs.realpathSync.native(path.join(releaseRoot, releaseId));
      if (!isPathInside(releaseRoot, versionRoot) || !isPathInside(versionRoot, file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch { return null; }
  }

  readSourceContents(releaseId: string | null): SourceContents {
    return releaseId ? this.readJson<SourceContents>(releaseId, 'source-contents.json') ?? {} : {};
  }

  /** CURRENT的祖先链才是成功发布历史；崩溃留下的孤立release不算提交。 */
  private reachableIds(): string[] {
    const result: string[] = [];
    let id: string | null | undefined = this.store.readCurrent()?.releaseId;
    while (id && validReleaseId(id) && !result.includes(id) && result.length < 50) {
      const manifest: KbManifest | null = this.readJson<KbManifest>(id, 'manifest.json');
      if (!manifest || manifest.releaseId !== id) break;
      result.push(id); id = manifest.baseReleaseId;
    }
    return result;
  }

  readVersion(releaseId: string): KbVersionDto | null {
    return this.reachableIds().includes(releaseId) ? this.loadVersion(releaseId) : null;
  }

  private loadVersion(releaseId: string): KbVersionDto | null {
    const manifest = this.readJson<KbManifest>(releaseId, 'manifest.json');
    if (!manifest || manifest.releaseId !== releaseId) return null;
    const version = this.readJson<KbVersionDto>(releaseId, 'changes.json');
    // 老发布只含hash，不假造旧原文或diff。
    return version && version.releaseId === releaseId && Array.isArray(version.sourceChanges) && Array.isArray(version.docChanges) ? version : {
      releaseId, baseReleaseId: manifest.baseReleaseId, buildId: manifest.buildId,
      publishedAt: manifest.publishedAt, mode: manifest.mode,
      summary: '历史发布未记录正文差异；后续发布将自动记录。', sourceChanges: [], docChanges: [],
    };
  }

  listVersions(): Array<Omit<KbVersionDto, 'sourceChanges' | 'docChanges'> & { sourceCount: number; docCount: number }> {
    return this.reachableIds().map((id) => this.loadVersion(id))
      .filter((v): v is KbVersionDto => Boolean(v))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, 50).map(({ sourceChanges, docChanges, ...version }) => ({
        ...version, sourceCount: sourceChanges.length, docCount: docChanges.length,
      }));
  }

  /** 必须在CURRENT提交前写完，失败沿既有发布事务终止。 */
  writeVersion(
    manifest: KbManifest,
    base: KbManifest | null,
    sourceContents: SourceContents,
    preview: KbChangePreview,
    summary: string,
  ): KbVersionDto {
    const oldDocs = new Map((base?.docs ?? []).map((doc) => [doc.path, doc]));
    const nextDocs = new Map(manifest.docs.map((doc) => [doc.path, doc]));
    const docChanges: KbFileChange[] = [];
    for (const key of [...new Set([...oldDocs.keys(), ...nextDocs.keys()])].sort()) {
      const old = oldDocs.get(key); const next = nextDocs.get(key);
      const before = old ? this.store.readReleaseDoc(base!.releaseId, old).markdown : '';
      const after = next ? this.store.readReleaseDoc(manifest.releaseId, next).markdown : '';
      const meta = (doc: typeof old) => doc && JSON.stringify([doc.path, doc.title, doc.summary, doc.tags, doc.sources]);
      if (old && next && before === after && meta(old) === meta(next)) continue;
      docChanges.push({
        key, title: (next ?? old)!.title, path: (next ?? old)!.path,
        kind: !old ? 'added' : !next ? 'removed' : 'changed', beforeAvailable: true,
        ...lineDiff(before, after),
      });
    }
    const version: KbVersionDto = {
      releaseId: manifest.releaseId, baseReleaseId: manifest.baseReleaseId, buildId: manifest.buildId,
      publishedAt: manifest.publishedAt, mode: manifest.mode, summary,
      sourceChanges: preview.sources, docChanges,
    };
    const releaseDir = path.join(this.root, 'releases', manifest.releaseId);
    fs.writeFileSync(path.join(releaseDir, 'source-contents.json'), JSON.stringify(sourceContents));
    fs.writeFileSync(path.join(releaseDir, 'changes.json'), JSON.stringify(version, null, 2));
    return version;
  }
}
