/** Frozen L0 baseline plus the explicitly named product L1 implementation.
 * L0 source: kb-search.ts at 1df5fff3dc540cb6c9e92e8e714018b61cd03663.
 * This module is a callable evaluation seam, NOT a replacement production search engine.
 */
import type { KbManifestDoc } from '../../src/types/agent-knowledge.js';
import { l1SearchDocs, parseSearchQuery } from '../../src/kb/kb-search.js';

export type RankerName = 'l0' | 'l1' | 'lex-v1';
export interface EvalHit {
  docId: string; path: string; title: string; summary: string; snippet: string;
  score?: number;
  hits?: Array<{ heading?: string; anchor?: string; line?: number }>;
}
export interface GrepMatch { path: string; line: number }
export interface EvalCorpus {
  releaseId: string;
  docs: KbManifestDoc[];
  readBody(doc: KbManifestDoc): string;
}
export interface EvalRanker {
  name: RankerName;
  implementation: string;
  supportsSections: boolean;
  search(query: string, limit: number): EvalHit[] | Promise<EvalHit[]>;
  /** Must drain all product pages before returning; never substitute reference grep. */
  grep?(query: string): GrepMatch[] | Promise<GrepMatch[]>;
  close?(): void | Promise<void>;
}

function scoreTerm(doc: KbManifestDoc, body: string, q: string) {
  const title = doc.title.toLowerCase();
  let score = 0;
  if (title.includes(q)) score += 100;
  if (title.startsWith(q)) score += 50;
  if (doc.path.toLowerCase().includes(q)) score += 30;
  if (doc.headings.some((h) => h.toLowerCase().includes(q))) score += 40;
  if (doc.summary.toLowerCase().includes(q)) score += 20;
  const index = body.toLowerCase().indexOf(q);
  let snippet = '';
  if (index >= 0 && body) {
    score += 60;
    const start = Math.max(0, index - 60);
    const end = Math.min(body.length, index + q.length + 120);
    snippet = `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\n+/g, ' ')}${end < body.length ? '…' : ''}`;
  }
  return { score, snippet };
}

/** The exact L0 field weights, whole-query matching, snippet, tie ordering and limit clamp. */
export function rankL0(corpus: EvalCorpus, query: string, limit = 20): EvalHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ hit: EvalHit; score: number }> = [];
  for (const doc of corpus.docs) {
    const { score, snippet } = scoreTerm(doc, corpus.readBody(doc), q);
    if (score <= 0) continue;
    scored.push({ score, hit: {
      docId: doc.docId, path: doc.path, title: doc.title, summary: doc.summary,
      snippet: snippet || doc.summary.slice(0, 160) || doc.title,
    } });
  }
  scored.sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path));
  return scored.slice(0, Math.max(1, Math.min(limit, 50))).map((item) => item.hit);
}

/** Product P0 parser: quoted phrases and identifiers stay intact; no lex-v1 fallback. */
export function l1Units(query: string): string[] {
  return parseSearchQuery(query);
}
export function rankL1(corpus: EvalCorpus, query: string, limit = 20): EvalHit[] {
  const byId = new Map(corpus.docs.map((doc) => [doc.docId, doc]));
  return l1SearchDocs(corpus.docs, query, limit, (doc) => corpus.readBody(byId.get(doc.docId)!));
}

export function createBaselineRanker(name: RankerName, corpus: EvalCorpus): EvalRanker {
  if (name === 'lex-v1') {
    throw new Error('ranker_not_ready: lex-v1 requires the P1 KbQueryService adapter; no metrics produced');
  }
  return {
    name,
    supportsSections: false,
    implementation: name === 'l0' ? 'frozen-kb-search@1df5fff3' : 'product-p0-l1',
    search: (query, limit) => (name === 'l0' ? rankL0 : rankL1)(corpus, query, limit),
  };
}
