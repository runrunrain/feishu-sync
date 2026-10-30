import { normalize, comparePath } from './normalize.js';
import { invalid } from './query-error.js';

export interface ParsedQuery { units: string[]; phrases?: string[]; fallback: Record<string, string[]>; ignored: string[]; truncated?: boolean }
export function parseQuery(query: string): ParsedQuery {
  if (typeof query !== 'string') invalid('query');
  const q = normalize(query).trim();
  if (q.length < 1 || q.length > 200) invalid('query', 'query 长度必须在 1..200');
  const units: string[] = [];
  const ignored: string[] = [];
  const phrases: string[] = [];
  const seen = new Set<string>();
  const tokens = /"([^"]*)"|“([^”]*)”|「([^」]*)」|([^\s,，。；;、:：!！?？()（）[\]【】{}<>《》'"“”‘’「」|\\/]+)/g;
  for (const m of q.matchAll(tokens)) {
    const u = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim();
    if (u && m[4] === undefined && !phrases.includes(u)) phrases.push(u);
    if (!u || seen.has(u) || /^[\x00-\x7f]$/.test(u)) continue;
    seen.add(u);
    (units.length < 8 ? units : ignored).push(u);
  }
  return { units, ...(phrases.length ? { phrases: phrases.filter((u) => units.includes(u)) } : {}), fallback: {}, ignored };
}

export function buildVocab(fields: string[]): string[] {
  const words = new Set<string>();
  for (const f of fields) for (const m of normalize(f).matchAll(/[\p{Script=Han}]+/gu)) {
    if (m[0].length >= 2 && m[0].length <= 12) words.add(m[0]);
  }
  return [...words].sort((a, b) => b.length - a.length || comparePath(a, b));
}
export function canFallback(unit: string): boolean {
  return unit.length >= 3 && /\p{Script=Han}/u.test(unit) && /^[\p{Script=Han}a-z0-9]+$/u.test(unit);
}

/** Maximum forward matching; only unmatched runs generate bigrams. */
export function fallbackTerms(unit: string, vocab: string[]): string[] {
  const terms: string[] = [];
  for (const run of unit.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (!/\p{Script=Han}/u.test(run)) { if (run.length >= 2 || /^\d+$/.test(run)) terms.push(run); continue; }
    let i = 0;
    let unmatched = '';
    const flush = () => { const chars = [...unmatched]; for (let j = 0; j < chars.length - 1; j++) terms.push(chars[j] + chars[j + 1]); unmatched = ''; };
    while (i < run.length) {
      const word = vocab.find((v) => run.startsWith(v, i));
      if (word) { flush(); terms.push(word); i += word.length; }
      else { const char = String.fromCodePoint(run.codePointAt(i)!); unmatched += char; i += char.length; }
    }
    flush();
  }
  return [...new Set(terms)];
}
export function queryHints(query: ParsedQuery, vocab: string[]): string[] {
  const bigrams = (s: string) => new Set([...s].slice(0, -1).map((c, i) => c + [...s][i + 1]));
  const q = bigrams(query.units.join(''));
  return vocab.map((word) => ({ word, score: [...bigrams(word)].filter((b) => q.has(b)).length }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || comparePath(a.word, b.word)).slice(0, 5).map((x) => x.word);
}
