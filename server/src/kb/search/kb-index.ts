import fs from 'node:fs';
import { resolveInside } from '../../agent/path-guard.js';
import { computeSourceHash } from '../raw-source-snapshot.js';
import type { KbManifest } from '../../types/agent-knowledge.js';
import { stripStdHeader } from './header.js';
import { assembleIndex, indexDoc } from './index-core.js';
import type { KbIndex, KbIndexDoc } from './index-types.js';
export type { KbIndex, KbIndexDoc } from './index-types.js';
export interface BuildIndexOptions { yieldEvery?: number; yieldFn?: () => Promise<void> }
export async function buildKbIndex(releaseDir: string, manifest: KbManifest, opts: BuildIndexOptions = {}): Promise<KbIndex> {
  const integrity = { verified: 0, mismatched: [] as string[], missing: [] as string[] };
  const docs: KbIndexDoc[] = [];
  let bytes = 0, done = 0;
  let docsDir: string | undefined;
  try { docsDir = resolveInside(releaseDir, 'docs', 'read'); } catch { /* each unreadable doc is disclosed below */ }
  const yieldFn = opts.yieldFn ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const every = Math.max(1, opts.yieldEvery ?? 50);
  for (const doc of manifest.docs) {
    try {
      if (!docsDir) throw new Error('docs unavailable');
      const file = resolveInside(docsDir, doc.path, 'read');
      if (!fs.statSync(file).isFile()) throw new Error('not a file');
      const content = fs.readFileSync(file);
      // Use the publication formula, including source_workbook attachments; never hash only the body.
      if (computeSourceHash(file, [], docsDir) !== doc.contentHash) integrity.mismatched.push(doc.path);
      else { docs.push(indexDoc(doc, stripStdHeader(content.toString('utf8')))); integrity.verified++; bytes += Buffer.byteLength(docs[docs.length - 1].lines.join('\n')); }
    } catch { integrity.missing.push(doc.path); }
    if (++done % every === 0) await yieldFn();
  }
  return assembleIndex(manifest.releaseId, docs, integrity, bytes);
}
