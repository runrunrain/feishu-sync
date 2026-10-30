/** Application-owned allowlist. The standalone MCP never opens SQLite or scans arbitrary folders. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DocumentRecord } from '../types/index.js';
import { collectSourceCandidates } from './raw-source-snapshot.js';
import { resolveInside } from '../agent/path-guard.js';
import { ScanPolicy } from '../modules/scan-policy.js';

export interface RawCatalogEntry { objToken: string; title: string; relPath: string; attachments: string[] }
export interface RawCatalog { root: string; updatedAt: string; entries: RawCatalogEntry[] }
export const rawCatalogPath = (dataRoot: string) => path.join(dataRoot, 'mcp', 'raw-catalog.json');
export function writeRawCatalog(file: string, root: string, documents: DocumentRecord[], csvPaths: (token: string) => string[]): void {
  const entries: RawCatalogEntry[] = [];
  for (const doc of collectSourceCandidates(documents)) {
    try {
      if (doc.localRelPath!.split(/[\\/]/).some((part) => ScanPolicy.shouldSkipDirectory(part) || ScanPolicy.shouldSkipFile(part))) continue;
      const full = resolveInside(root, doc.localRelPath!, 'read');
      if (!fs.statSync(full).isFile()) continue;
      const attachments: string[] = [];
      for (const csv of csvPaths(doc.objToken)) {
        try {
          const rel = path.isAbsolute(csv) ? path.relative(fs.realpathSync(root), fs.realpathSync(csv)) : csv;
          const safe = resolveInside(root, rel, 'read');
          if (fs.statSync(safe).isFile()) attachments.push(rel.replace(/\\/g, '/'));
        } catch { /* No out-of-root or missing attachments. */ }
      }
      entries.push({ objToken: doc.objToken, title: doc.title, relPath: doc.localRelPath!.replace(/\\/g, '/'), attachments });
    } catch { /* Unreadable or outside the source root. */ }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ root, updatedAt: new Date().toISOString(), entries } satisfies RawCatalog), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
