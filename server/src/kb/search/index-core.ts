import { normalize, normalizePath } from './normalize.js';
import { buildOutline } from './outline.js';
import { buildVocab } from './query.js';
import type { KbManifestDoc } from '../../types/agent-knowledge.js';
import type { KbIndex, KbIndexDoc } from './index-types.js';

export function indexDoc(doc: Pick<KbManifestDoc, 'docId'|'path'|'title'|'summary'|'tags'|'sources'>, body: string): KbIndexDoc {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const normLines = lines.map(normalize);
  const lineOffsets = new Int32Array(lines.length);
  for (let i = 1; i < lines.length; i++) lineOffsets[i] = lineOffsets[i - 1] + normLines[i - 1].length + 1;
  return { ...doc, lines, normAll: normLines.join('\n'), lineOffsets,
    meta: { title: normalize(doc.title), tags: normalize(doc.tags.join(' | ')), path: normalizePath(doc.path), summary: normalize(doc.summary) },
    ...buildOutline(lines, doc.path, doc.title) };
}
export function assembleIndex(releaseId: string, docs: KbIndexDoc[], integrity = { verified: docs.length, mismatched: [] as string[], missing: [] as string[] }, bytes = 0): KbIndex {
  const sections = docs.flatMap((d) => d.sections);
  return { releaseId, docs, rankerVersion: 'lex-v1', builtAt: Date.now(),
    byPath: new Map(docs.map((d, i) => [d.path, i])), byDocId: new Map(docs.map((d, i) => [d.docId, i])),
    vocab: buildVocab(docs.flatMap((d) => [d.meta.title, d.meta.tags, d.meta.path, ...d.sections.map((s) => s.headingPath)])),
    avgSummaryLen: docs.reduce((sum, d) => sum + d.meta.summary.length, 0) / (docs.length || 1) || 1,
    avgSectionLen: sections.reduce((sum, s) => sum + s.normEnd - s.normStart, 0) / (sections.length || 1) || 1,
    integrity, bytes };
}
