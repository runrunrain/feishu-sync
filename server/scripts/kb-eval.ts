#!/usr/bin/env node
/** E0 offline evaluator. No database/model/API access and no writes to input releases.
 * See docs/kb-evaluation.md. lex-v1 deliberately fails until P1 is wired on resume.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isPathInside } from '../src/agent/path-guard.js';
import { loadQueries, loadRelease, sha256 } from './lib/kb-eval-io.js';
import { createBaselineRanker, type EvalRanker, type RankerName } from './lib/kb-eval-rankers.js';
import { collectMemory, compareReport, evaluate, reportMarkdown } from './lib/kb-eval-runner.js';
import { BENCH_QUERIES, fixtureDir, materializeSynthetic, SYNTHETIC_SEED } from './lib/kb-eval-synthetic.js';

export const HELP = `KB evaluation (offline; writes only --out and owned temporary synthetic files)
  --release <release-dir> --queries <jsonl> --ranker l0|l1|lex-v1 --out <new-dir>
  --synthetic-fixture --ranker l0|l1 --out <new-dir> [--compare <report.json>]
  --synthetic-mb 10|30 --ranker l0|l1 --out <new-dir>
  --compare <report.json>  Add per-query metric deltas (same corpus and query hashes only).
lex-v1 is explicitly not ready until P1 KbQueryService is connected; no fake metrics.
Synthetic scales are exact MiB of UTF-8 BODY, performance/memory only (no quality gates).
`;
export interface CliOptions {
  release?: string; queries?: string; ranker: RankerName; out: string;
  syntheticMb?: 10 | 30; syntheticFixture?: boolean; compare?: string;
}
export function parseArgs(argv: string[]): CliOptions {
  const flags = new Map<string, string>();
  const valued = new Set(['--release', '--queries', '--ranker', '--out', '--synthetic-mb', '--compare']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (flags.has(key)) throw new Error(`usage: duplicate ${key}`);
    if (key === '--synthetic-fixture') { flags.set(key, 'true'); continue; }
    if (!valued.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`usage: invalid or missing value: ${key}`);
    flags.set(key, argv[++i]);
  }
  const ranker = flags.get('--ranker');
  const out = flags.get('--out');
  if (!ranker || !['l0', 'l1', 'lex-v1'].includes(ranker) || !out) throw new Error('usage: --ranker l0|l1|lex-v1 and --out required');
  const syntheticMb = flags.get('--synthetic-mb');
  const syntheticFixture = flags.has('--synthetic-fixture');
  if (syntheticMb !== undefined && !['10', '30'].includes(syntheticMb)) throw new Error('usage: --synthetic-mb must be 10 or 30');
  const synthetic = syntheticMb !== undefined || syntheticFixture;
  if ((synthetic && (flags.has('--release') || flags.has('--queries'))) || (syntheticMb && (syntheticFixture || flags.has('--compare')))) {
    throw new Error('usage: synthetic modes are exclusive; performance-only cannot compare quality');
  }
  if (!synthetic && (!flags.has('--release') || !flags.has('--queries'))) throw new Error('usage: --release and --queries required');
  return {
    ranker: ranker as RankerName, out: path.resolve(out), release: flags.get('--release'), queries: flags.get('--queries'),
    syntheticMb: syntheticMb ? Number(syntheticMb) as 10 | 30 : undefined,
    syntheticFixture, compare: flags.get('--compare'),
  };
}

/** Exported real CLI entry for isolated integration tests; shared engine seam is evaluate(). */
export async function runCli(options: CliOptions): Promise<void> {
  if (options.ranker === 'lex-v1') {
    // Fail before creating any output or data, including in synthetic mode.
    createBaselineRanker('lex-v1', { releaseId: '', docs: [], readBody: () => '' });
  }
  let temporary: string | undefined;
  let ranker: EvalRanker | undefined;
  try {
    let releaseDir = options.release;
    if (options.syntheticFixture || options.syntheticMb) {
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-eval-synthetic-'));
      releaseDir = path.join(temporary, 'release');
      materializeSynthetic(releaseDir, options.syntheticMb, (message) => process.stderr.write(message + '\n'));
    }
    if (!releaseDir) throw new Error('release_required');
    const memoryBefore = collectMemory();
    const start = performance.now();
    const release = loadRelease(releaseDir);
    let ancestor = options.out;
    const missing: string[] = [];
    while (!fs.existsSync(ancestor)) {
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
    const plannedOut = path.join(fs.realpathSync(ancestor), ...missing);
    if (isPathInside(release.dir, plannedOut)) throw new Error('out_inside_release: input is immutable');
    ranker = createBaselineRanker(options.ranker, release);
    const preparationMs = performance.now() - start;
    const queryFile = options.syntheticFixture ? path.join(fixtureDir, 'synthetic-queries.jsonl') : options.queries;
    const queries = options.syntheticMb ? [] : loadQueries(queryFile!, release);
    const report = await evaluate({ release, ranker, queries, preparationMs, memoryBefore,
      queriesHash: queryFile ? sha256(fs.readFileSync(queryFile)) : undefined, queriesFile: queryFile,
      benchmarkQueries: options.syntheticMb ? BENCH_QUERIES : undefined,
    });
    if (options.syntheticMb) report.benchmark = { seed: SYNTHETIC_SEED, mib: options.syntheticMb, queries: BENCH_QUERIES };
    if (options.compare) compareReport(report, options.compare);
    // Reports cannot be placed inside a release; preserve previous evidence on reruns.
    if (fs.existsSync(options.out) && fs.readdirSync(options.out).length) throw new Error('out_not_empty: choose a new report directory');
    fs.mkdirSync(options.out, { recursive: true });
    const outReal = fs.realpathSync(options.out);
    if (isPathInside(release.dir, outReal)) throw new Error('out_inside_release: input is immutable');
    fs.writeFileSync(path.join(outReal, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(outReal, 'report.md'), reportMarkdown(report), { flag: 'wx' });
    process.stdout.write(`${report.dataset} ${report.mode} ${report.ranker}: ${path.join(options.out, 'report.json')}\n`);
  } finally {
    try { await ranker?.close?.(); }
    finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') process.stdout.write(HELP);
  else {
    Promise.resolve().then(() => parseArgs(process.argv.slice(2))).then(runCli).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(message + '\n');
      process.exitCode = message.startsWith('usage:') ? 2 : 1;
    });
  }
}
