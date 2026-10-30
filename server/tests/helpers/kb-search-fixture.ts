/** Synthetic releases only; publication-equivalent hashes, never production fixtures. */
import fs from 'node:fs';
import path from 'node:path';
import type { KbManifest } from '../../src/types/agent-knowledge.js';
import { computeSourceHash } from '../../src/kb/raw-source-snapshot.js';
export interface FixtureDoc { path: string; body: string; title?: string; summary?: string; tags?: string[]; docId?: string }
export function writeSearchRelease(root: string, releaseId: string, docs: FixtureDoc[], current = true): KbManifest {
  const dir = path.join(root, 'releases', releaseId);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const manifest: KbManifest = { schemaVersion: 1, releaseId, buildId: `b_${releaseId}`, mode: 'full', baseReleaseId: null,
    publishedAt: '2026-10-29T00:00:00Z', model: 'fixture', sourceSnapshot: [], docs: [], skippedSources: [] };
  for (const [i, d] of docs.entries()) {
    const file = path.join(dir, 'docs', d.path), docId = d.docId ?? `kd_${i}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<!--\nfeishu_sync_kb:\n  doc_id: ${docId}\n  sources:\n    - fixture\n  build_id: b_${releaseId}\n-->\n${d.body}`);
    manifest.docs.push({ docId, path: d.path, title: d.title ?? d.path, summary: d.summary ?? '', headings: [], tags: d.tags ?? [], sources: ['fixture'],
      contentHash: computeSourceHash(file, []), updatedInBuild: manifest.buildId });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (current) fs.writeFileSync(path.join(root, 'CURRENT.json'), JSON.stringify({ schemaVersion: 1, releaseId, publishedAt: manifest.publishedAt }));
  return manifest;
}
