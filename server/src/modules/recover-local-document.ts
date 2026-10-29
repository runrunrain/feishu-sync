import fs from 'node:fs';
import path from 'node:path';
import { IndexScanner } from './index-scanner.js';
import { ScanPolicy } from './scan-policy.js';
import { isPathInsideRoot } from './path-resolver.js';
import type { DocumentRecord } from '../types/index.js';

type Candidate = { file: string; wiki?: string };
const cache = new Map<string, { at: number; candidates: Map<string, Candidate[]> }>();
const parser = new IndexScanner({ localMapStore: null, larkCliClient: null, config: null });
function readIdentity(file: string) {
  const fd = fs.openSync(file, 'r');
  try { const bytes = Buffer.alloc(64 * 1024); const n = fs.readSync(fd, bytes, 0, bytes.length, 0); return parser.parseMetadata(bytes.subarray(0, n).toString('utf8')); }
  finally { fs.closeSync(fd); }
}

/** Locate an unindexed local version by its embedded Feishu identity, without changing sync state. */
export function recoverLocalDocument(root: string, doc: Pick<DocumentRecord, 'objToken' | 'localMdPath'> & Partial<Pick<DocumentRecord, 'wikiNodeToken' | 'syncState' | 'lastSyncErrorCode' | 'cloudMatch'>>): string | null {
  if (!root || doc.localMdPath || !(doc.syncState === 'restricted' || doc.lastSyncErrorCode === 'permission_denied' || doc.cloudMatch === 'restricted')) return null;
  const resolvedRoot = path.resolve(root);
  let index = cache.get(resolvedRoot);
  if (!index || Date.now() - index.at > 10_000) {
    const candidates = new Map<string, Candidate[]>();
    const queue = [resolvedRoot];
    let complete = true;
    while (queue.length) {
      const dir = queue.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { complete = false; continue; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && !ScanPolicy.shouldSkipDirectory(entry.name)) queue.push(file);
        else if (entry.isFile() && /\.md$/i.test(entry.name) && !ScanPolicy.shouldSkipFile(entry.name)) {
          try {
            const meta = readIdentity(file);
            if (meta?.obj_token) candidates.set(meta.obj_token, [...(candidates.get(meta.obj_token) ?? []), { file, wiki: meta.wiki_node_token }]);
          } catch { complete = false; }
        }
      }
    }
    index = { at: Date.now(), candidates: complete ? candidates : new Map() };
    if (!cache.has(resolvedRoot) && cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(resolvedRoot, index);
  }
  const matches = index.candidates.get(doc.objToken) ?? [];
  if (matches.length !== 1 || (matches[0].wiki && doc.wikiNodeToken && matches[0].wiki !== doc.wikiNodeToken)) return null;
  try {
    const rootReal = fs.realpathSync.native(resolvedRoot);
    const fileReal = fs.realpathSync.native(matches[0].file);
    if (!isPathInsideRoot(rootReal, fileReal) || !fs.statSync(fileReal).isFile()) return null;
    const meta = readIdentity(fileReal);
    if (meta?.obj_token !== doc.objToken || (meta.wiki_node_token && doc.wikiNodeToken && meta.wiki_node_token !== doc.wikiNodeToken)) return null;
    return matches[0].file;
  } catch { return null; }
}
