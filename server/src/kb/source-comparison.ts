import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../agent/path-guard.js';
import { parseWorkbookPackage } from '../modules/sheet-workbook.js';
import type { KbManifest, RawSourceSnapshotEntry } from '../types/agent-knowledge.js';
import { visitSourceFiles, type SourceFileKind } from './raw-source-snapshot.js';

export const SOURCE_COMPARISON_CACHE = '.source-comparison-v1.json';
const VERSION = 'v1:';
const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^v1:[a-f0-9]{64}$/.test(value);
const hash = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

export function withoutSyncTimestamps(markdown: string): string {
  return markdown.replace(/^\uFEFF?<!--\r?\nfeishu_sync:\r?\n[\s\S]*?-->/, header =>
    header.replace(/^( {2}(?:fetch_date|last_synced_modify_time): )"[^"\r\n]*"/gm, '$1""'));
}

function markdownDigest(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return hash(Buffer.from(text).equals(bytes) ? withoutSyncTimestamps(text) : bytes);
}

async function workbookDigest(bytes: Buffer): Promise<string> {
  const zip = await parseWorkbookPackage(bytes);
  const members: Array<[string, string]> = [];
  for (const name of Object.keys(zip.files).sort()) {
    const file = zip.files[name]!;
    if (file.dir) continue;
    let content = await file.async('nodebuffer');
    if (name === 'docProps/core.xml') {
      const xml = content.toString('utf8');
      if (/xmlns:dcterms=["']http:\/\/purl\.org\/dc\/terms\/["']/.test(xml)) {
        content = Buffer.from(xml.replace(/(<dcterms:(created|modified)\b[^>]*>)[^<]*(<\/dcterms:\2>)/g, '$1$3'));
      }
    }
    members.push([name, hash(content)]);
  }
  return hash(JSON.stringify(members));
}

/** Derive a comparison digest only from files that match the exact expected
 * snapshot hash. Used for live sources and verified recovery of old baselines. */
export async function sourceComparisonHash(
  expectedContentHash: string,
  read: (visit: (kind: SourceFileKind, name: string, bytes: Buffer) => void) => void,
): Promise<string | undefined> {
  const exact = crypto.createHash('sha256');
  const rows: Array<[SourceFileKind, string, string]> = [];
  let workbook: { name: string; bytes: Buffer } | undefined;
  read((kind, name, bytes) => {
    exact.update(bytes);
    if (kind === 'workbook') workbook = { name, bytes };
    else rows.push([kind, name, kind === 'markdown' ? markdownDigest(bytes) : hash(bytes)]);
  });
  if ('sha256:' + exact.digest('hex') !== expectedContentHash) return undefined;
  if (workbook) rows.push(['workbook', workbook.name, await workbookDigest(workbook.bytes)]);
  return VERSION + hash(JSON.stringify(rows.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
}

export function sourceContentsChanged(before: RawSourceSnapshotEntry, after: RawSourceSnapshotEntry): boolean {
  return before.contentHash !== after.contentHash && !(
    before.relPath === after.relPath && before.objType === after.objType
    && isDigest(before.comparisonHash) && before.comparisonHash === after.comparisonHash
    && !(before.mediaHash && after.mediaHash && before.mediaHash !== after.mediaHash)
    && !(after.whiteboardTextHash !== undefined && (before.whiteboardTextHash ?? '') !== after.whiteboardTextHash));
}

export function sourceComparisonKey(entry: Pick<RawSourceSnapshotEntry, 'objToken' | 'contentHash' | 'relPath'>): string {
  return JSON.stringify([entry.objToken, entry.contentHash, entry.relPath]);
}

/** Old releases stay immutable. Local proof is keyed to the exact source
 * version; imported values are as trustworthy as the bundle sender, not
 * independently verified against old source bytes. They affect pending previews
 * and incremental comparison, never build-time readVerified or the exact-byte
 * validation before publication. */
export function withSourceComparisonBaseline(base: KbManifest | null, outputRoot: string): KbManifest | null {
  if (!base || base.sourceSnapshot.every(entry => isDigest(entry.comparisonHash))) return base;
  let proof: Record<string, unknown>;
  try { proof = JSON.parse(fs.readFileSync(path.join(outputRoot, SOURCE_COMPARISON_CACHE), 'utf8')); }
  catch { return base; }
  if (!proof || typeof proof !== 'object') return base;
  return { ...base, sourceSnapshot: base.sourceSnapshot.map(entry => {
    const digest = proof[sourceComparisonKey(entry)];
    return !isDigest(entry.comparisonHash) && isDigest(digest) ? { ...entry, comparisonHash: digest } : entry;
  }) };
}

/** Fill missing proofs only when the complete source still matches this exact version. */
export async function captureMissingSourceComparisonHashes(entries: RawSourceSnapshotEntry[], root: string,
  csvPaths: (token: string) => string[]): Promise<void> {
  for (const entry of entries) {
    if (isDigest(entry.comparisonHash)) continue;
    try {
      const realPath = resolveInside(root, entry.relPath, 'read');
      const digest = await sourceComparisonHash(entry.contentHash,
        visit => visitSourceFiles(realPath, csvPaths(entry.objToken), root, visit));
      if (digest) entry.comparisonHash = digest;
    } catch { /* Missing or unsupported sources retain exact-byte comparison. */ }
  }
}

const liveDigests = new Map<string, string>();

export async function addSourceComparisonHashes(input: {
  entries: RawSourceSnapshotEntry[];
  base: KbManifest | null;
  root: string;
  csvPaths: (token: string) => string[];
  capture?: boolean;
}): Promise<void> {
  const baseline = new Map(input.base?.sourceSnapshot.map(entry => [entry.objToken, entry]));
  for (const entry of input.entries) {
    const old = baseline.get(entry.objToken);
    const key = sourceComparisonKey(entry);
    const cached = (old && sourceComparisonKey(old) === key ? old.comparisonHash : undefined) ?? liveDigests.get(key);
    if (isDigest(cached)) {
      entry.comparisonHash = cached;
      continue;
    }
    if (!input.capture && !isDigest(old?.comparisonHash)) continue;
    try {
      const realPath = resolveInside(input.root, entry.relPath, 'read');
      const csv = input.csvPaths(entry.objToken);
      const digest = await sourceComparisonHash(entry.contentHash, visit => visitSourceFiles(realPath, csv, input.root, visit));
      if (!digest) continue;
      entry.comparisonHash = digest;
      if (liveDigests.size >= 2048) liveDigests.delete(liveDigests.keys().next().value!);
      liveDigests.set(key, digest);
    } catch { /* Unsupported or unreadable bundles keep exact-byte change detection. */ }
  }
}
