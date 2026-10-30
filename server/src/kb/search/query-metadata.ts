import type { KbManifest, RawSourceSnapshotEntry } from '../../types/agent-knowledge.js';
import { comparePath, normalize } from './normalize.js';

export const KB_COVERAGE_NOTE = '本版是所选源文档经模型整理的标准库，并非源库镜像；多篇标准文档可来自同一源。未检索到不代表源库不存在或尚未设计。目录编号只是来源路径，编号含义须另行收录正式说明。';

const versionPattern = /(?:^|[^a-z0-9])v\.?\s*(\d+(?:\.\d+)+)(?!\d|\.\d)/i;
export function sourceVersionWarning(source: Pick<RawSourceSnapshotEntry, 'title'|'relPath'>): { code: 'source_version_label_mismatch'; titleVersion: string; pathVersion: string; message: string } | undefined {
  const titleVersion = versionPattern.exec(source.title)?.[1];
  if (!titleVersion) return;
  const parts = source.relPath.replace(/\\/g, '/').split('/');
  // Do not compare with an unrelated ancestor's version label.
  const stem = (s: string) => normalize(s.replace(/\.(md|xlsx|csv|pptx)$/i, '').replace(/v\.?\s*\d+(?:\.\d+)+/ig, '')).replace(/[\s_-]/g, '');
  const titleStem = stem(source.title);
  const label = [...parts].reverse().find((part) => stem(part) === titleStem);
  const pathVersion = label ? versionPattern.exec(label)?.[1] : undefined;
  if (!pathVersion || titleVersion === pathVersion) return;
  return { code: 'source_version_label_mismatch', titleVersion, pathVersion,
    message: '源标题与本地路径版本标签不同；路径可能保留旧名称，内容版本未经确认，请核对源正文，勿按标题推定。' };
}

/** Suggestions are hints, never silent path substitution. Only verified documents are passed in. */
export function suggestDocPaths(docs: Array<Pick<KbManifest['docs'][number], 'path'|'title'|'docId'>>, term: string, byId = false): string[] {
  const clean = (s: string) => normalize(s.replace(/\\/g, '/').split('/').at(-1)!.replace(/\.md$/i, '')).trim().slice(0, 160);
  const query = clean(term);
  if (query.length < 2) return [];
  const grams = (s: string) => { const chars = Array.from(s); return new Set(chars.slice(0, -1).map((c, i) => c + chars[i + 1])); };
  const qgrams = grams(query);
  const similarity = (input: string) => {
    const candidate = clean(input);
    if (!candidate) return 0;
    if (candidate === query) return 1;
    if (candidate.includes(query) || query.includes(candidate)) return 0.65 + 0.3 * Math.min(candidate.length, query.length) / Math.max(candidate.length, query.length);
    const other = grams(candidate);
    const shared = [...qgrams].filter((g) => other.has(g)).length;
    const dice = 2 * shared / Math.max(1, qgrams.size + other.size);
    const partial = shared >= 2 ? 0.65 * shared / qgrams.size : 0;
    // Edit distance also handles one typo in a short filename/opaque docId.
    let row = Array.from({ length: candidate.length + 1 }, (_, i) => i);
    for (let i = 0; i < query.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < candidate.length; j++) next[j + 1] = Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(query[i] !== candidate[j]));
      row = next;
    }
    const edit = 1 - row[candidate.length] / Math.max(query.length, candidate.length);
    return Math.max(dice, partial, edit >= 0.6 ? edit : 0);
  };
  return docs.map((doc) => ({ path: doc.path, score: byId ? similarity(doc.docId) : Math.max(similarity(doc.path), similarity(doc.title)) }))
    .filter((doc) => doc.score >= (byId ? 0.7 : 0.35))
    .sort((a, b) => b.score - a.score || comparePath(a.path, b.path)).slice(0, 5).map((doc) => doc.path);
}
