/** Read-only pinned release input. Bad/missing/hash-mismatched inputs fail the evaluation,
 * rather than silently shrinking the denominator. All output is owned by the CLI caller. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveInside } from '../../src/agent/path-guard.js';
import { stripStdHeader } from '../../src/kb/standard-kb-store.js';
import { computeSourceHash } from '../../src/kb/raw-source-snapshot.js';
import type { KbManifest, KbManifestDoc } from '../../src/types/agent-knowledge.js';
import type { EvalCorpus } from './kb-eval-rankers.js';
import type { EvalQuery } from './kb-eval-metrics.js';

export const sha256 = (bytes: string | Buffer) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
export interface LoadedRelease extends EvalCorpus {
  dir: string;
  manifest: KbManifest;
  manifestHash: string;
  bodyBytes: number;
  synthetic: boolean;
}

export function loadRelease(dir: string): LoadedRelease {
  dir = fs.realpathSync(dir);
  const manifestBytes = fs.readFileSync(resolveInside(dir, 'manifest.json', 'read'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as KbManifest & { synthetic?: boolean };
  if (manifest.schemaVersion !== 1 || typeof manifest.releaseId !== 'string' || !manifest.releaseId || !Array.isArray(manifest.docs)) {
    throw new Error('invalid_manifest: expected schemaVersion=1, releaseId and docs');
  }
  const docsDir = resolveInside(dir, 'docs', 'read');
  const paths = new Set<string>();
  const ids = new Set<string>();
  let bodyBytes = 0;
  const verifiedHashes = new Map<string, string>();
  const readBody = (doc: KbManifestDoc): string => {
    const file = resolveInside(docsDir, doc.path, 'read');
    const bytes = fs.readFileSync(file);
    // Same hash formula as publishReleaseInner (including source_workbook when present).
    // Recheck each read so mutation between preparation and a query cannot taint metrics.
    if (computeSourceHash(file, [], docsDir) !== doc.contentHash) throw new Error(`integrity_error: ${doc.path}`);
    return stripStdHeader(bytes.toString('utf8'));
  };
  for (const doc of manifest.docs) {
    if (!doc || ['docId', 'path', 'title', 'summary', 'contentHash'].some((key) => typeof doc[key as keyof KbManifestDoc] !== 'string') ||
      !Array.isArray(doc.headings) || !doc.headings.every((h) => typeof h === 'string') || !doc.path.endsWith('.md') ||
      paths.has(doc.path) || ids.has(doc.docId)) throw new Error('invalid_manifest: invalid or duplicate doc');
    paths.add(doc.path); ids.add(doc.docId);
    bodyBytes += Buffer.byteLength(readBody(doc));
    verifiedHashes.set(doc.path, doc.contentHash);
  }
  return {
    dir, manifest, manifestHash: sha256(manifestBytes), releaseId: manifest.releaseId,
    docs: manifest.docs, bodyBytes, synthetic: manifest.synthetic === true,
    readBody: (doc) => {
      if (verifiedHashes.get(doc.path) !== doc.contentHash) throw new Error(`manifest_mutated: ${doc.path}`);
      return readBody(doc);
    },
  };
}

/** Annotation validation only, never used to manufacture search hits. */
function sectionNames(body: string): Set<string> {
  const names = new Set(['']);
  let h2 = '';
  let fence: { char: string; size: number } | undefined;
  for (const line of body.split('\n')) {
    const mark = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) {
      if (!fence) fence = { char: mark[1][0], size: mark[1].length };
      else if (mark[1][0] === fence.char && mark[1].length >= fence.size && !mark[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    if (heading[1].length === 2) { h2 = heading[2]; names.add(h2); }
    else names.add(h2 ? `${h2} › ${heading[2]}` : heading[2]);
  }
  return names;
}

export function loadQueries(file: string, release: LoadedRelease): EvalQuery[] {
  const queries: EvalQuery[] = [];
  const ids = new Set<string>();
  const docs = new Map(release.docs.map((doc) => [doc.path, doc]));
  const bodies = new Map<string, string>();
  const body = (p: string) => {
    const doc = docs.get(p);
    if (!doc) throw new Error(`annotation_path_missing: ${p}`);
    if (!bodies.has(p)) bodies.set(p, release.readBody(doc));
    return bodies.get(p)!;
  };
  for (const [i, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      const q = JSON.parse(line) as EvalQuery;
      if (!q || typeof q.id !== 'string' || !q.id || ids.has(q.id) || !/^Q[1-6]$/.test(q.category) ||
        !['planner', 'programmer'].includes(q.consumer) || typeof q.query !== 'string' || !q.query.trim() || q.query.length > 200 ||
        q.releaseId !== release.releaseId || !Array.isArray(q.relevant) || !q.relevant.length) {
        throw new Error('invalid_query: id/category/consumer/query/relevant/releaseId');
      }
      const p = q.provenance;
      if (!p || !['synthetic', 'human'].includes(p.kind) || typeof p.source !== 'string' || !p.source.trim()) throw new Error('provenance_required');
      if (p.kind === 'human' && (!['user', 'session-log', 'manual-reading'].includes(p.source) || !p.annotator?.trim() || !p.reference?.trim())) {
        throw new Error('human_provenance_required: source, annotator and reference');
      }
      for (const rel of q.relevant) {
        if (![1, 2].includes(rel.grade) || typeof rel.section !== 'string' || !sectionNames(body(rel.path)).has(rel.section)) {
          throw new Error(`invalid_qrel: ${rel.path}#${rel.section}`);
        }
      }
      if (q.category === 'Q4' && (!Array.isArray(q.exhaustive) || !q.exhaustive.length)) throw new Error('Q4_exhaustive_required');
      if (q.exhaustive !== undefined && !Array.isArray(q.exhaustive)) throw new Error('invalid_exhaustive');
      for (const loc of q.exhaustive ?? []) {
        if (!Number.isInteger(loc.line) || loc.line < 1 || loc.line > body(loc.path).split('\n').length) throw new Error('invalid_exhaustive_line');
      }
      ids.add(q.id); queries.push(q);
    } catch (error) {
      throw new Error(`${file}:${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!queries.length) throw new Error('empty_queries');
  const kinds = new Set(queries.map((q) => q.provenance.kind));
  if (kinds.size > 1 || (release.synthetic && !kinds.has('synthetic'))) throw new Error('mixed_or_mislabeled_synthetic_data');
  return queries;
}
