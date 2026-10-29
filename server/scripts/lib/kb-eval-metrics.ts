/** Metrics consume returned product hits only; never infer sections from a retrieved body. */
import type { EvalHit, GrepMatch } from './kb-eval-rankers.js';

export interface EvalQuery {
  id: string;
  category: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6';
  query: string;
  consumer: 'planner' | 'programmer';
  releaseId: string;
  relevant: Array<{ path: string; section: string; grade: 1 | 2 }>;
  exhaustive?: GrepMatch[];
  provenance: { kind: 'synthetic' | 'human'; source: string; annotator?: string; reference?: string };
}
export interface Metrics {
  docRecallAt10: number | null;
  sectionHitAt5: number | null;
  mrrAt10: number | null;
  ndcgAt10: number | null;
  grepCompleteness: number | null;
}
export const METRIC_KEYS: Array<keyof Metrics> = [
  'docRecallAt10', 'sectionHitAt5', 'mrrAt10', 'ndcgAt10', 'grepCompleteness',
];
export const locationKey = (item: GrepMatch) => JSON.stringify([item.path, item.line]);

export function scoreQuery(query: EvalQuery, results: EvalHit[], grep?: GrepMatch[], supportsSections = false): Metrics {
  // Document grade = max chapter grade. A document can contribute at most once.
  const grades = new Map<string, number>();
  for (const rel of query.relevant) grades.set(rel.path, Math.max(grades.get(rel.path) ?? 0, rel.grade));
  const seen = new Set<string>();
  const top = results.filter((hit) => !seen.has(hit.path) && !!seen.add(hit.path)).slice(0, 10);
  const relevant = top.filter((hit) => grades.has(hit.path));
  const rank = top.findIndex((hit) => grades.has(hit.path));
  const dcg = (values: number[]) => values.reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...grades.values()].sort((a, b) => b - a).slice(0, 10));
  const direct = query.relevant.filter((rel) => rel.grade === 2);
  const sectionHit = top.slice(0, 5).some((hit) => direct.some((rel) =>
    hit.path === rel.path && hit.hits?.some((section) =>
      section.anchor === `${rel.path}#${rel.section}` || (!rel.section && section.anchor === rel.path) ||
      (!section.anchor && section.heading === rel.section))));
  const expected = new Set(query.exhaustive?.map(locationKey));
  const actual = new Set(grep?.map(locationKey));
  return {
    docRecallAt10: grades.size ? relevant.length / grades.size : null,
    sectionHitAt5: direct.length && supportsSections ? Number(sectionHit) : null,
    mrrAt10: grades.size ? (rank < 0 ? 0 : 1 / (rank + 1)) : null,
    ndcgAt10: ideal ? dcg(top.map((hit) => grades.get(hit.path) ?? 0)) / ideal : null,
    // Empty exhaustive labels are not evidence of complete enumeration.
    grepCompleteness: expected.size && grep !== undefined
      ? [...expected].filter((key) => actual.has(key)).length / expected.size : null,
  };
}

export function aggregate(rows: Array<{ metrics: Metrics }>) {
  return Object.fromEntries(METRIC_KEYS.map((key) => {
    const values = rows.map((row) => row.metrics[key]).filter((n): n is number => n !== null);
    return [key, { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, count: values.length }];
  }));
}

/** Nearest rank percentile; reproducible also for small samples. */
export function percentile(values: number[], p = 0.95): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
