import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../agent/path-guard.js';
import { parseWorkbookPackage } from '../modules/sheet-workbook.js';
import { frozenSourcesFromRelease, type FrozenSource } from './progressive-source-snapshot.js';
import type { KbManifest, RawSourceSnapshotEntry } from '../types/agent-knowledge.js';
import { visitSourceFiles, type SourceFileKind } from './raw-source-snapshot.js';

export const SOURCE_COMPARISON_CACHE = '.source-comparison-v1.json';
const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^v[12]:[a-f0-9]{64}$/.test(value);
const hash = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const comparisonText = (text: string) => withoutSyncTimestamps(text.replace(/\r\n/g, '\n'));

export function withoutSyncTimestamps(markdown: string): string {
  return markdown.replace(/^\uFEFF?<!--\r?\nfeishu_sync:\r?\n[\s\S]*?-->/, header =>
    header.replace(/^( {2}(?:fetch_date|last_synced_modify_time): )"[^"\r\n]*"/gm, '$1""'));
}

function textDigest(kind: SourceFileKind, bytes: Buffer, version: 1 | 2): string {
  if (kind !== 'markdown' && (kind !== 'csv' || version === 1)) return hash(bytes);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) return hash(bytes);
  return hash(version === 1 ? withoutSyncTimestamps(text)
    : kind === 'markdown' ? comparisonText(text) : text.replace(/\r\n/g, '\n'));
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
type SourceFile = [kind: SourceFileKind, name: string, bytes: Buffer];
type DigestRow = [kind: SourceFileKind, name: string, digest: string];

function digestRows(rows: DigestRow[], version: 1 | 2): string {
  return 'v' + version + ':' + hash(JSON.stringify(rows.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1
      : version === 2 ? a[2].localeCompare(b[2]) : 0)));
}

async function readComparisonFiles(
  expectedContentHash: string,
  read: (visit: (kind: SourceFileKind, name: string, bytes: Buffer) => void) => void,
): Promise<{ text: SourceFile[]; opaque: DigestRow[] } | undefined> {
  const exact = crypto.createHash('sha256');
  const text: SourceFile[] = [];
  const binary: SourceFile[] = [];
  read((kind, name, bytes) => {
    exact.update(bytes);
    (kind === 'markdown' || kind === 'csv' ? text : binary).push([kind, name, bytes]);
  });
  if ('sha256:' + exact.digest('hex') !== expectedContentHash) return undefined;
  const opaque: DigestRow[] = [];
  for (const [kind, name, bytes] of binary) {
    opaque.push([kind, name, kind === 'workbook' ? await workbookDigest(bytes) : hash(bytes)]);
  }
  return { text, opaque };
}

function digestFiles(text: SourceFile[], opaque: DigestRow[], version: 1 | 2): string {
  return digestRows([...opaque, ...text.map(([kind, name, bytes]): DigestRow =>
    [kind, name, textDigest(kind, bytes, version)])], version);
}

export async function sourceComparisonHash(
  expectedContentHash: string,
  read: (visit: (kind: SourceFileKind, name: string, bytes: Buffer) => void) => void,
  version: 1 | 2 = 2,
): Promise<string | undefined> {
  const files = await readComparisonFiles(expectedContentHash, read);
  return files && digestFiles(files.text, files.opaque, version);
}

// The verified legacy match applies to this live scan and this exact baseline.
const legacyMatches = new WeakMap<RawSourceSnapshotEntry, string>();
const diffTexts = new WeakMap<RawSourceSnapshotEntry, { baseHash: string; before: string; after: string }>();

export function sourceDiffTexts(old: RawSourceSnapshotEntry, next: RawSourceSnapshotEntry) {
  const texts = diffTexts.get(next);
  return texts?.baseHash === old.contentHash ? texts : undefined;
}

export function sourceContentsChanged(before: RawSourceSnapshotEntry, after: RawSourceSnapshotEntry): boolean {
  return before.contentHash !== after.contentHash && !(
    before.relPath === after.relPath && before.objType === after.objType
    && ((isDigest(before.comparisonHash) && before.comparisonHash === after.comparisonHash)
      || legacyMatches.get(after) === before.contentHash)
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
    if (entry.comparisonHash?.startsWith('v2:')) continue;
    try {
      const realPath = resolveInside(root, entry.relPath, 'read');
      const digest = await sourceComparisonHash(entry.contentHash,
        visit => visitSourceFiles(realPath, csvPaths(entry.objToken), root, visit));
      if (digest) entry.comparisonHash = digest;
    } catch { /* Missing or unsupported sources retain exact-byte comparison. */ }
  }
}

const liveDigests = new Map<string, string>();

function archivedSources(outputRoot: string, base: KbManifest, tokens: ReadonlySet<string>) {
  try {
    const releaseRoot = resolveInside(outputRoot, 'releases/' + base.releaseId, 'read');
    const contentsPath = resolveInside(releaseRoot, 'source-contents.json', 'read');
    const contents = JSON.parse(fs.readFileSync(contentsPath, 'utf8')) as Record<string, string>;
    const named = frozenSourcesFromRelease({ releaseRoot, manifest: base,
      sourceContents: contents, tokens, skipUnavailable: true });
    return { contents, named };
  } catch { return undefined; }
}

/** Some releases only recorded CSV spans used as evidence. Match the archived
 * pieces by normalized content, then require the legacy digest to verify
 * every guessed filename before treating the match as equivalent. */
function matchLegacyCsv(combined: string | undefined, files: SourceFile[]): FrozenSource | undefined {
  if (typeof combined !== 'string') return undefined;
  const [content, ...parts] = combined.split(/\n\n--- CSV (\d+) ---\n/);
  const live = files.filter(([kind]) => kind === 'csv');
  if (!live.length || parts.length !== live.length * 2) return undefined;
  const attachments: FrozenSource['attachments'] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] !== String(i / 2 + 1)) return undefined;
    const csv = parts[i + 1]!;
    const digest = textDigest('csv', Buffer.from(csv), 2);
    const match = live.findIndex(([, , bytes]) => textDigest('csv', bytes, 2) === digest);
    if (match === -1) return undefined;
    attachments.push({ path: live.splice(match, 1)[0]![1], content: csv });
  }
  return { content: content!, attachments };
}

function diffText(files: SourceFile[]): string {
  return files.slice().sort((a, b) => a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0] === 'markdown' ? -1 : 1)
    .map(([kind, name, bytes]) => kind === 'markdown' ? comparisonText(bytes.toString('utf8'))
      : '\n\n--- CSV: ' + name + ' ---\n' + bytes.toString('utf8').replace(/\r\n/g, '\n')).join('');
}

export async function addSourceComparisonHashes(input: {
  entries: RawSourceSnapshotEntry[];
  base: KbManifest | null;
  root: string;
  csvPaths: (token: string) => string[];
  capture?: boolean;
  outputRoot?: string;
}): Promise<void> {
  const baseline = new Map(input.base?.sourceSnapshot.map(entry => [entry.objToken, entry]));
  const drift = new Set(input.entries.filter(entry => {
    const old = baseline.get(entry.objToken);
    return old && old.contentHash !== entry.contentHash;
  }).map(entry => entry.objToken));
  const archived = drift.size && input.base && input.outputRoot
    ? archivedSources(input.outputRoot, input.base, drift) : undefined;
  for (const entry of input.entries) {
    const old = baseline.get(entry.objToken);
    const key = sourceComparisonKey(entry);
    const cached = (old && sourceComparisonKey(old) === key ? old.comparisonHash : undefined) ?? liveDigests.get(key);
    if (!drift.has(entry.objToken) && isDigest(cached) && (!input.capture || cached.startsWith('v2:'))) {
      entry.comparisonHash = cached;
      continue;
    }
    if (!input.capture && !drift.has(entry.objToken)) continue;
    try {
      const realPath = resolveInside(input.root, entry.relPath, 'read');
      const csv = input.csvPaths(entry.objToken);
      const files = await readComparisonFiles(entry.contentHash, visit => visitSourceFiles(realPath, csv, input.root, visit));
      if (!files) continue;
      const digest = digestFiles(files.text, files.opaque, 2);
      entry.comparisonHash = digest;
      if (liveDigests.size >= 2048) liveDigests.delete(liveDigests.keys().next().value!);
      liveDigests.set(key, digest);
      if (!old || !drift.has(entry.objToken)) continue;
      const legacy = old.comparisonHash?.startsWith('v1:') ? old.comparisonHash : undefined;
      if (legacy && legacy === digestFiles(files.text, files.opaque, 1)) legacyMatches.set(entry, old.contentHash);
      const named = archived?.named.get(entry.objToken);
      const frozen = named ?? (legacy ? matchLegacyCsv(archived?.contents[entry.objToken], files.text) : undefined);
      if (!frozen) continue;
      const oldText: SourceFile[] = [['markdown', path.posix.basename(old.relPath.replace(/\\/g, '/')), Buffer.from(frozen.content)],
        ...frozen.attachments.map(({ path: name, content }): SourceFile => ['csv', name, Buffer.from(content)])];
      // v1 proves that the archived text plus today's workbook/external
      // attachments reproduce the published comparison, including binary data.
      // For older text-only releases the exact hash proves the original split.
      const verified = legacy ? legacy === digestFiles(oldText, files.opaque, 1)
        : !files.opaque.length && old.contentHash === 'sha256:' + hash(Buffer.concat(oldText.map(file => file[2])));
      if (named || verified) diffTexts.set(entry, { baseHash: old.contentHash, before: diffText(oldText), after: diffText(files.text) });
      if (verified && digestFiles(oldText, files.opaque, 2) === digest) legacyMatches.set(entry, old.contentHash);
    } catch { /* Unsupported or unreadable bundles keep exact-byte change detection. */ }
  }
}
