import type { KbIndex, KbIndexDoc } from './index-types.js';
import type { KbSection } from './outline.js';
import { canFallback, fallbackTerms, parseQuery, type ParsedQuery } from './query.js';
import { comparePath } from './normalize.js';

export const LEX_V1 = Object.freeze({ version: 'lex-v1' as const, k1: 1.2,
  w_title: 5, w_tags: 4, w_path: 3, w_summary: 2, w_heading: 4, w_body: 1,
  b_summary: 0.5, b_body: 0.75, cap_meta: 3, cap_body: 20,
  mu_multi: 0.1, multi_sections: 5, phi_fallback: 0.15, cov_floor: 0.25, prox: 0.3, title_bonus: 1.3 });
export interface RankedDoc { doc: KbIndexDoc; score: number; coverage: number; matchedUnits: string[]; fallbackUnits: string[]; sections: Array<{ section: KbSection; score: number }> }
export interface RankResult { query: ParsedQuery; ranked: RankedDoc[]; terms: string[] }
export function countTerm(text: string, term: string, cap: number): number {
  if (!term) return 0;
  let count = 0, offset = 0;
  while (count < cap) { const at = text.indexOf(term, offset); if (at < 0) break; count++; offset = at + term.length; }
  return count;
}
function contains(doc: KbIndexDoc, term: string): boolean {
  return doc.normAll.includes(term) || Object.values(doc.meta).some((v) => v.includes(term));
}
/** Pure synchronous core. Corpus df is computed before path/tag filtering. */
export function rankLexV1(index: KbIndex, query: string): RankResult {
  const parsed = parseQuery(query);
  const postings = new Map<string, Set<number>>();
  const df = (term: string) => {
    let hits = postings.get(term);
    if (!hits) { hits = new Set<number>(); index.docs.forEach((doc, i) => { if (contains(doc, term)) hits!.add(i); }); postings.set(term, hits); }
    return hits;
  };
  const scans = new Set(parsed.units); // Reserve one exact scan for every unit.
  const unitTerms = parsed.units.map((unit) => {
    if (df(unit).size || parsed.phrases?.includes(unit) || !canFallback(unit)) return { unit, terms: [unit], fallback: false };
    const terms: string[] = [];
    const all = fallbackTerms(unit, index.vocab);
    for (const term of all) {
      if (terms.length === 8 || (!scans.has(term) && scans.size === 24)) { parsed.truncated = true; break; }
      terms.push(term); scans.add(term); df(term);
    }
    parsed.fallback[unit] = terms;
    return { unit, terms, fallback: true };
  });
  const terms = [...new Set(unitTerms.flatMap((u) => u.terms))];
  const idf = new Map(terms.map((t) => [t, Math.log(1 + (index.docs.length - df(t).size + 0.5) / (df(t).size + 0.5))]));
  const candidates = new Set(terms.flatMap((t) => [...df(t)]));
  const p = LEX_V1;
  const sat = (x: number) => x * (p.k1 + 1) / (x + p.k1);
  const aggregate = (u: typeof unitTerms[number], score: (term: string) => number) => {
    const sum = u.terms.reduce((s, t) => s + score(t), 0);
    return u.fallback ? p.phi_fallback * sum / (u.terms.length || 1) : sum;
  };
  const ranked: RankedDoc[] = [];
  for (const no of candidates) {
    const doc = index.docs[no], m = doc.meta;
    const tf = (text: string, t: string) => countTerm(text, t, p.cap_meta);
    const metaScore = (t: string) => idf.get(t)! * sat(p.w_title * tf(m.title, t) + p.w_tags * tf(m.tags, t) + p.w_path * tf(m.path, t)
      + p.w_summary * tf(m.summary, t) / (1 - p.b_summary + p.b_summary * m.summary.length / index.avgSummaryLen));
    const sections = doc.sections.map((section) => {
      const body = doc.normAll.slice(section.normStart, section.normEnd);
      const scoreTerm = (t: string) => idf.get(t)! * sat(p.w_heading * tf(section.normHeading, t)
        + p.w_body * countTerm(body, t, p.cap_body) / (1 - p.b_body + p.b_body * body.length / index.avgSectionLen));
      const scores = unitTerms.map((u) => aggregate(u, scoreTerm));
      const hitUnits = scores.filter((s, i) => s > 0 && !unitTerms[i].fallback).length;
      return { section, score: scores.reduce((a, b) => a + b, 0) * (1 + (hitUnits >= 2 && hitUnits >= unitTerms.length / 2 ? p.prox : 0)) };
    }).sort((a, b) => b.score - a.score || a.section.startLine - b.section.startLine);
    // A fragment hit is a recall hint, never evidence that the original keyword matched.
    const matchedUnits = unitTerms.filter((u) => !u.fallback && df(u.unit).has(no)).map((u) => u.unit);
    const fallbackUnits = unitTerms.filter((u) => u.fallback && u.terms.some((t) => df(t).has(no))).map((u) => u.unit);
    const coverage = matchedUnits.length / (unitTerms.length || 1);
    const titleAll = unitTerms.length > 0 && unitTerms.every((u) => !u.fallback && m.title.includes(u.unit));
    const sectionScore = (sections[0]?.score ?? 0) + p.mu_multi * sections.slice(1, p.multi_sections).reduce((sum, s) => sum + s.score, 0);
    const score = (unitTerms.reduce((sum, u) => sum + aggregate(u, metaScore), 0) + sectionScore)
      * (p.cov_floor + (1 - p.cov_floor) * coverage ** 2) * (titleAll ? p.title_bonus : 1);
    ranked.push({ doc, score, coverage, matchedUnits, fallbackUnits, sections });
  }
  ranked.sort((a, b) => Number(b.matchedUnits.length > 0) - Number(a.matchedUnits.length > 0)
    || b.score - a.score || comparePath(a.doc.path, b.doc.path));
  return { query: parsed, ranked, terms };
}
