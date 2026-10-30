import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import type { LoadedRelease } from './kb-eval-io.js';
import type { EvalRanker, EvalHit } from './kb-eval-rankers.js';
import { aggregate, METRIC_KEYS, percentile, scoreQuery, type EvalQuery, type Metrics } from './kb-eval-metrics.js';

export interface EvalRow {
  id: string; category: string; consumer: string; query: string;
  relevant: EvalQuery['relevant']; provenance: EvalQuery['provenance']; results: EvalHit[]; metrics: Metrics;
  missingRelevantDocs: string[]; latencyMs: number[]; resultChars: number;
  grep?: { expected: number; returned: number };
  delta?: Record<string, number | null>;
  previousPaths?: string[];
}
export interface EvalReport {
  schemaVersion: 1;
  mode: 'quality' | 'performance-only';
  dataset: 'synthetic' | 'human-labeled';
  gateStatus: 'not-assessed';
  ranker: string; implementation: string;
  releaseId: string; manifestHash: string; queriesHash: string | null;
  inputs: { releaseDir: string; queriesFile: string | null; compareFile?: string };
  generatedAt: string;
  runtime: { node: string; platform: string; arch: string; cpu: string };
  corpus: { docs: number; bodyBytes: number };
  capabilities: { sections: boolean; grep: boolean };
  warnings: string[];
  performance: {
    preparationMs: number; searchP95Ms: number | null; grepP95Ms: number | null;
    resultCharsP95: number | null; samples: number; rounds: number;
    memory: { gcAvailable: boolean; before: NodeJS.MemoryUsage; after: NodeJS.MemoryUsage; heapDelta: number; rssDelta: number; processMaxRssKiB: number };
  };
  overall: ReturnType<typeof aggregate> | null;
  groups: Record<string, { queries: number; metrics: ReturnType<typeof aggregate> }> | null;
  rows: EvalRow[];
  benchmark?: { seed: number; mib: number; queries: string[] };
  comparison?: { ranker: string; implementation: string };
}
export function collectMemory(): NodeJS.MemoryUsage {
  // Use node --expose-gc --import tsx for comparable samples. Without forced GC,
  // heapDelta is observational (may even be negative), never a steady-state claim.
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
  return process.memoryUsage();
}
export interface RunOptions {
  release: LoadedRelease; ranker: EvalRanker; queries: EvalQuery[];
  benchmarkQueries?: string[]; queriesHash?: string; queriesFile?: string; preparationMs: number;
  memoryBefore: NodeJS.MemoryUsage; rounds?: number;
}
export async function evaluate(options: RunOptions): Promise<EvalReport> {
  const { release, ranker, queries, benchmarkQueries } = options;
  const rounds = options.rounds ?? 3;
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('invalid_rounds');
  const perfOnly = benchmarkQueries !== undefined;
  const texts = benchmarkQueries ?? queries.map((q) => q.query);
  const searchTimes: number[] = [];
  const grepTimes: number[] = [];
  const chars: number[] = [];
  const rows: EvalRow[] = [];
  // A full unmeasured pass warms filesystem/page cache and JIT. No dropped samples
  // within measured rounds; nearest-rank p95 across every query × 3 rounds.
  for (const query of texts) await ranker.search(query, 10);
  if (ranker.grep) for (const query of texts) await ranker.grep(query);
  for (let i = 0; i < texts.length; i++) {
    let results: EvalHit[] = [];
    let grep: Awaited<ReturnType<NonNullable<EvalRanker['grep']>>> | undefined;
    const latencyMs: number[] = [];
    let firstFingerprint: string | undefined;
    for (let round = 0; round < rounds; round++) {
      const started = performance.now();
      results = await ranker.search(texts[i], 10);
      const elapsed = performance.now() - started;
      searchTimes.push(elapsed); latencyMs.push(elapsed);
      const fingerprint = JSON.stringify(results);
      if (firstFingerprint !== undefined && fingerprint !== firstFingerprint) throw new Error(`nondeterministic_ranker: ${texts[i]}`);
      firstFingerprint = fingerprint;
      chars.push(fingerprint.length);
      if (ranker.grep && (perfOnly || queries[i].exhaustive)) {
        const grepStarted = performance.now();
        grep = await ranker.grep(texts[i]);
        grepTimes.push(performance.now() - grepStarted);
      }
    }
    if (!perfOnly) {
      const q = queries[i];
      const paths = new Set(results.slice(0, 10).map((hit) => hit.path));
      rows.push({
        id: q.id, category: q.category, consumer: q.consumer, query: q.query,
        relevant: q.relevant, provenance: q.provenance, results, metrics: scoreQuery(q, results, grep, ranker.supportsSections),
        missingRelevantDocs: [...new Set(q.relevant.map((r) => r.path))].filter((p) => !paths.has(p)),
        latencyMs, resultChars: JSON.stringify(results).length,
        ...(grep ? { grep: { expected: q.exhaustive?.length ?? 0, returned: grep.length } } : {}),
      });
    }
  }
  const after = collectMemory();
  const groups: NonNullable<EvalReport['groups']> = {};
  for (const category of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']) {
    const subset = rows.filter((row) => row.category === category);
    groups[category] = { queries: subset.length, metrics: aggregate(subset) };
  }
  const warnings = [
    'No real-data acceptance gate is evaluated by this script; human provenance must be independently reviewed.',
    'Baseline preparation is verified release loading, NOT a lex-v1 index build.',
    'L0/L1 warm search includes disk reads, realpath and integrity hashing on every call; not pure CPU timing.',
    'resultChars measures the ranker result DTO, NOT MCP tool response size.',
  ];
  if (perfOnly || release.synthetic || queries.some((q) => q.provenance.kind === 'synthetic')) warnings.push('SYNTHETIC: not a real 80-query benchmark; quality gates cannot pass from these results.');
  if (!ranker.supportsSections) warnings.push('SectionHit@5=null: this ranker does not return section hits.');
  if (!ranker.grep) warnings.push('GrepCompleteness=null: no product grep exists in L0/L1; reference scanning is NOT substituted.');
  if (perfOnly) warnings.push('PERFORMANCE ONLY: no quality metrics or qrels are generated for expanded corpus.');
  return {
    schemaVersion: 1, mode: perfOnly ? 'performance-only' : 'quality',
    dataset: perfOnly || release.synthetic || queries.some((q) => q.provenance.kind === 'synthetic') ? 'synthetic' : 'human-labeled',
    gateStatus: 'not-assessed', ranker: ranker.name, implementation: ranker.implementation,
    releaseId: release.releaseId, manifestHash: release.manifestHash, queriesHash: options.queriesHash ?? null,
    inputs: { releaseDir: release.dir, queriesFile: options.queriesFile ?? null },
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown' },
    corpus: { docs: release.docs.length, bodyBytes: release.bodyBytes },
    capabilities: { sections: ranker.supportsSections, grep: !!ranker.grep }, warnings,
    performance: {
      preparationMs: options.preparationMs, searchP95Ms: percentile(searchTimes), grepP95Ms: percentile(grepTimes),
      resultCharsP95: percentile(chars), samples: searchTimes.length, rounds,
      memory: { gcAvailable: typeof (globalThis as { gc?: unknown }).gc === 'function', before: options.memoryBefore, after,
        heapDelta: after.heapUsed - options.memoryBefore.heapUsed, rssDelta: after.rss - options.memoryBefore.rss,
        processMaxRssKiB: process.resourceUsage().maxRSS },
    },
    overall: perfOnly ? null : aggregate(rows), groups: perfOnly ? null : groups, rows,
  };
}

export function compareReport(report: EvalReport, file: string): void {
  const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as EvalReport;
  if (previous.schemaVersion !== 1 || previous.mode !== 'quality' || report.mode !== 'quality' ||
    previous.releaseId !== report.releaseId || previous.manifestHash !== report.manifestHash || previous.queriesHash !== report.queriesHash ||
    previous.dataset !== report.dataset || previous.rows.length !== report.rows.length) throw new Error('incomparable_reports: corpus/queries/mode differ');
  const byId = new Map(previous.rows.map((row) => [row.id, row]));
  for (const row of report.rows) {
    const old = byId.get(row.id);
    if (!old || old.query !== row.query) throw new Error(`incomparable_query: ${row.id}`);
    row.delta = Object.fromEntries(METRIC_KEYS.map((key) => [key,
      row.metrics[key] === null || old.metrics[key] === null ? null : row.metrics[key]! - old.metrics[key]!,
    ]));
    row.previousPaths = old.results.map((hit) => hit.path);
  }
  report.comparison = { ranker: previous.ranker, implementation: previous.implementation };
  report.inputs.compareFile = file;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const number = (n: unknown) => typeof n === 'number' ? n.toFixed(4) : 'N/A';
export function reportMarkdown(report: EvalReport): string {
  const lines = [
    `# KB evaluation — ${report.ranker} (${report.dataset}, ${report.mode})`, '',
    `Release: \`${report.releaseId}\`; implementation: \`${report.implementation}\`; gate: **not-assessed**.`, '',
    ...report.warnings.map((w) => `- ${w}`), '',
    '## Performance', '',
    `- Corpus: ${report.corpus.docs} documents / ${report.corpus.bodyBytes} UTF-8 body bytes.`,
    `- Verified preparation: ${number(report.performance.preparationMs)} ms; warm search p95: ${number(report.performance.searchP95Ms)} ms (${report.performance.samples} samples).`,
    `- Grep p95: ${number(report.performance.grepP95Ms)} ms; DTO chars p95: ${number(report.performance.resultCharsP95)}.`,
    `- Heap delta: ${report.performance.memory.heapDelta} bytes; RSS delta: ${report.performance.memory.rssDelta} bytes; forced GC: ${report.performance.memory.gcAvailable}.`,
    `- Node ${report.runtime.node}, ${report.runtime.platform}/${report.runtime.arch}; ${report.runtime.cpu}.`, '',
  ];
  if (report.groups && report.overall) {
    lines.push('## Quality (macro means; N/A excluded, denominators in JSON)', '',
      '| Group | Queries | Doc Recall@10 | SectionHit@5 | MRR@10 | nDCG@10 | GrepCompleteness |',
      '|---|---:|---:|---:|---:|---:|---:|---:|');
    const all = { All: { queries: report.rows.length, metrics: report.overall }, ...report.groups };
    for (const [key, value] of Object.entries(all)) lines.push(`| ${key} | ${value.queries} | ${METRIC_KEYS.map((metric) => number(value.metrics[metric].mean)).join(' | ')} |`);
    lines.push('', '## Per-query results', '');
    for (const row of report.rows) {
      lines.push(`### ${row.id} (${row.category}, ${row.consumer})`, '',
        `Query: ${cell(row.query)}`, '',
        `Metrics: ${METRIC_KEYS.map((key) => `${key}=${number(row.metrics[key])}`).join(', ')}`, '',
        `Top paths: ${row.results.map((hit) => cell(hit.path)).join(' → ') || '(none)'}`, '',
        `Missed relevant documents: ${row.missingRelevantDocs.map(cell).join(', ') || '(none)'}`, '');
      if (row.delta) lines.push(`Delta vs ${report.comparison?.ranker}: ${METRIC_KEYS.map((key) => `${key}=${number(row.delta![key])}`).join(', ')}`, '',
        `Previous paths: ${row.previousPaths?.map(cell).join(' → ') || '(none)'}`, '');
    }
  }
  return lines.join('\n') + '\n';
}
