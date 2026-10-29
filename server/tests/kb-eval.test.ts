/** Synthetic tests only. No production KB, query logs, database or network used. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBaselineRanker, l1Units, rankL0, rankL1, type EvalCorpus, type EvalHit, type EvalRanker } from '../scripts/lib/kb-eval-rankers.js';
import { aggregate, percentile, scoreQuery, type EvalQuery } from '../scripts/lib/kb-eval-metrics.js';
import { loadQueries, loadRelease, sha256 } from '../scripts/lib/kb-eval-io.js';
import { collectMemory, compareReport, evaluate, reportMarkdown } from '../scripts/lib/kb-eval-runner.js';
import { fixtureDir, materializeSynthetic } from '../scripts/lib/kb-eval-synthetic.js';
import { parseArgs, runCli } from '../scripts/kb-eval.js';
import { l1SearchDocs } from '../src/kb/kb-search.js';

const temporary: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-eval-test-')); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = path.join(temp(), 'release');
  materializeSynthetic(dir);
  const release = loadRelease(dir);
  const queryFile = path.join(fixtureDir, 'synthetic-queries.jsonl');
  return { release, queryFile, queries: loadQueries(queryFile, release) };
}
function corpus(entries: Array<{ path: string; title?: string; summary?: string; headings?: string[]; body?: string }>): EvalCorpus {
  return {
    releaseId: 'synthetic-unit',
    docs: entries.map((entry, i) => ({
      docId: `synthetic-${i}`, path: entry.path, title: entry.title ?? '', summary: entry.summary ?? '', headings: entry.headings ?? [],
      tags: [], sources: [], contentHash: '', updatedInBuild: '',
    })),
    readBody: (doc) => entries[Number(doc.docId.split('-')[1])].body ?? '',
  };
}
const hit = (p: string, section?: string): EvalHit => ({
  docId: p, path: p, title: p, summary: '', snippet: '',
  ...(section === undefined ? {} : { hits: [{ anchor: `${p}#${section}`, heading: section }] }),
});

// Hand-computed qrels are unit-test data, not a fabricated real benchmark.
const metricQuery: EvalQuery = {
  id: 'synthetic-metric', category: 'Q2', query: 'q', consumer: 'planner', releaseId: 'synthetic-unit',
  relevant: [{ path: 'a', section: 'direct', grade: 2 }, { path: 'a', section: 'other', grade: 1 }, { path: 'b', section: 'context', grade: 1 }],
  exhaustive: [{ path: 'a', line: 1 }, { path: 'b', line: 2 }],
  provenance: { kind: 'synthetic', source: 'unit-test' },
};

describe('frozen L0 / product L1', () => {
  it('reproduces L0 weights, prefix, case, all-document sorting and fallback snippet', () => {
    const input = corpus([
      { path: 'z.md', title: 'Token' },           // 150
      { path: 'a.md', title: 'xx TOKEN' },        // 100
      { path: 'b.md', body: 'TOKEN' },            // 60
      { path: 'c.md', headings: ['TOKEN'] },      // 40
      { path: 'token.md', summary: 'TOKEN' },     // 50
      { path: 'd.md', summary: 'TOKEN summary' }, // 20
    ]);
    expect(rankL0(input, ' token ').map((h) => h.path)).toEqual(['z.md', 'a.md', 'b.md', 'token.md', 'c.md', 'd.md']);
    expect(rankL0(input, 'token', 1)[0].snippet).toBe('Token');
    expect(rankL0(input, 'token', 0)).toHaveLength(1);
    expect(rankL0(input, '  ')).toEqual([]);
    expect(rankL0(input, 'ＴＯＫＥＮ')).toEqual([]); // L0 did not NFKC normalize
  });
  it('preserves exact body snippet boundaries, tie locale ordering and limit=50 cap', () => {
    const body = 'x'.repeat(70) + 'TOKEN\n\n' + 'y'.repeat(180);
    const input = corpus([{ path: 'z.md', body }, { path: 'a.md', body }]);
    expect(rankL0(input, 'token')[0]).toMatchObject({ path: 'a.md', snippet: '…' + body.slice(10, 195).replace(/\n+/g, ' ') + '…' });
    const many = corpus(Array.from({ length: 70 }, (_, i) => ({ path: `${i}.md`, body: 'q' })));
    expect(rankL0(many, 'q', 1000)).toHaveLength(50);
  });
  it('L1 restores multiword recall, deduplicates units and rewards coverage', () => {
    const input = corpus([{ path: 'a.md', body: '宠物 升星以外的话题' }, { path: 'b.md', body: '宠物从一星升星，消耗星尘' }]);
    expect(rankL0(input, '宠物 升星 消耗')).toEqual([]);
    expect(rankL1(input, '宠物 升星 消耗')[0].path).toBe('b.md');
    expect(rankL1(input, '宠物，宠物；升星!消耗')).toEqual(rankL1(input, '宠物 升星 消耗'));
    expect(l1Units('skill_id hp+10% v1.2 a-b #tag')).toEqual(['skill_id', 'hp+10%', 'v1.2', 'a-b', '#tag']);
    expect(l1Units('a b c d e f g h i')).toHaveLength(9);
    expect(l1Units('宠物 "升星 消耗" 「旧 称」')).toEqual(['宠物', '升星 消耗', '旧 称']);
    expect(rankL1(input, '宠物 升星 消耗')).toEqual(l1SearchDocs(input.docs, '宠物 升星 消耗', 20, (doc) => input.readBody(input.docs.find((entry) => entry.docId === doc.docId)!)));
    expect(rankL1(input, '暴击伤害结算顺序')).toEqual([]); // no invented fallback
  });
  it('does not silently substitute a baseline for lex-v1', () => {
    expect(() => createBaselineRanker('lex-v1', corpus([]))).toThrow('ranker_not_ready');
  });
});

describe('hand-computed metrics', () => {
  it('maxes grades by document, computes MRR and graded DCG, excludes duplicate docs', () => {
    const metrics = scoreQuery(metricQuery, [hit('irrelevant'), hit('b'), hit('b')]);
    expect(metrics.docRecallAt10).toBe(0.5);
    expect(metrics.mrrAt10).toBe(0.5);
    expect(metrics.ndcgAt10).toBeCloseTo((1 / Math.log2(3)) / (3 + 1 / Math.log2(3)));
    expect(metrics.sectionHitAt5).toBeNull();
    expect(metrics.grepCompleteness).toBeNull();
  });
  it('uses actual top-5 section hits, grade=2 only; supported empty results score zero', () => {
    expect(scoreQuery(metricQuery, [hit('a', 'other')], undefined, true).sectionHitAt5).toBe(0);
    expect(scoreQuery(metricQuery, [hit('a', 'direct')], undefined, true).sectionHitAt5).toBe(1);
    expect(scoreQuery(metricQuery, [...Array.from({ length: 5 }, (_, i) => hit(`x${i}`)), hit('a', 'direct')], undefined, true).sectionHitAt5).toBe(0);
    expect(scoreQuery(metricQuery, [], undefined, true)).toMatchObject({ docRecallAt10: 0, mrrAt10: 0, ndcgAt10: 0, sectionHitAt5: 0 });
  });
  it('grep uses a set, accepts supersets, and reports partial coverage correctly', () => {
    expect(scoreQuery(metricQuery, [], [{ path: 'a', line: 1 }, { path: 'a', line: 1 }]).grepCompleteness).toBe(0.5);
    expect(scoreQuery(metricQuery, [], [...metricQuery.exhaustive!, { path: 'c', line: 9 }]).grepCompleteness).toBe(1);
    expect(scoreQuery({ ...metricQuery, exhaustive: [] }, [], []).grepCompleteness).toBeNull();
  });
  it('null is not zero; aggregations report usable denominators and nearest-rank p95', () => {
    const a = scoreQuery(metricQuery, []);
    const b = scoreQuery(metricQuery, [hit('a', 'direct')], metricQuery.exhaustive, true);
    expect(aggregate([{ metrics: a }, { metrics: b }]).sectionHitAt5).toEqual({ mean: 1, count: 1 });
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(percentile([])).toBeNull();
  });
});

describe('pinned, verified release and annotations', () => {
  it('materializes only synthetic fixture, checks header-relative qrels including fenced headings', () => {
    const { release, queries } = fixture();
    expect(release.synthetic).toBe(true);
    expect(queries).toHaveLength(12);
    expect(new Set(queries.map((q) => q.category)).size).toBe(6);
    for (const q of queries.filter((q) => q.category === 'Q4')) {
      const actual = release.docs.flatMap((d) => release.readBody(d).split('\n').flatMap((line, i) => line.includes(q.query) ? [{ path: d.path, line: i + 1 }] : []));
      expect(actual).toEqual(expect.arrayContaining(q.exhaustive!));
      expect(actual).toHaveLength(q.exhaustive!.length);
    }
    const bad = path.join(temp(), 'bad.jsonl');
    fs.writeFileSync(bad, JSON.stringify({ ...queries[0], relevant: [{ path: '战斗/伤害.md', section: '假标题', grade: 2 }] }));
    expect(() => loadQueries(bad, release)).toThrow('invalid_qrel');
  });
  it('rejects hash mismatch, missing docs, path traversal, and symlink escape', () => {
    const { release } = fixture();
    const file = path.join(release.dir, 'docs', release.docs[0].path);
    fs.appendFileSync(file, 'tamper');
    expect(() => loadRelease(release.dir)).toThrow('integrity_error');
    expect(() => release.readBody(release.docs[0])).toThrow('integrity_error');
    fs.unlinkSync(file);
    expect(() => loadRelease(release.dir)).toThrow();
    fs.symlinkSync(path.join(fixtureDir, 'synthetic-corpus.json'), file);
    expect(() => loadRelease(release.dir)).toThrow('越出');
    fs.unlinkSync(file);
    const manifest = { ...release.manifest, docs: [{ ...release.docs[0], path: '../outside.md' }] };
    fs.writeFileSync(path.join(release.dir, 'manifest.json'), JSON.stringify(manifest));
    expect(() => loadRelease(release.dir)).toThrow('..');
  });
  it('rejects mismatched release, duplicate queries, invalid lines and missing human provenance', () => {
    const { release, queries } = fixture();
    const file = path.join(temp(), 'queries.jsonl');
    for (const invalid of [
      [{ ...queries[0], releaseId: 'other' }], [queries[0], queries[0]],
      [{ ...queries[6], exhaustive: [{ path: '战斗/伤害.md', line: 900 }] }],
      [{ ...queries[0], provenance: { kind: 'human', source: 'llm' } }],
      [{ ...queries[0], provenance: undefined }],
    ]) {
      fs.writeFileSync(file, invalid.map((q) => JSON.stringify(q)).join('\n'));
      expect(() => loadQueries(file, release)).toThrow();
    }
  });
  it('generates exact deterministic 10 MiB body size and content hashes, with no quality labels', () => {
    const root = temp();
    materializeSynthetic(path.join(root, 'one'), 10);
    materializeSynthetic(path.join(root, 'two'), 10);
    const one = loadRelease(path.join(root, 'one'));
    const two = loadRelease(path.join(root, 'two'));
    expect(one.bodyBytes).toBe(10 * 1024 * 1024);
    expect(one.manifestHash).toBe(two.manifestHash);
    expect(one.docs.map((d) => d.contentHash)).toEqual(two.docs.map((d) => d.contentHash));
    expect(() => materializeSynthetic(path.join(root, 'one'))).toThrow('not_empty');
  });
});

describe('runner and real CLI', () => {
  it('runs L0/L1 grouped baselines and validates comparable per-query deltas', async () => {
    const { release, queries, queryFile } = fixture();
    const args = { release, queries, queriesHash: sha256(fs.readFileSync(queryFile)), preparationMs: 0, memoryBefore: collectMemory() };
    const l0 = await evaluate({ ...args, ranker: createBaselineRanker('l0', release) });
    const l1 = await evaluate({ ...args, ranker: createBaselineRanker('l1', release) });
    const previous = path.join(temp(), 'previous.json');
    fs.writeFileSync(previous, JSON.stringify(l0));
    compareReport(l1, previous);
    expect(l0.groups!.Q2.metrics.docRecallAt10.mean).toBe(0);
    expect(l1.groups!.Q2.metrics.docRecallAt10.mean).toBe(1);
    expect(l1.rows.find((row) => row.id === 'synthetic-q2a')!.delta!.docRecallAt10).toBe(1);
    expect(l1.overall!.sectionHitAt5.count).toBe(0);
    expect(l1.overall!.grepCompleteness.count).toBe(0);
    expect(reportMarkdown(l1)).toContain('SYNTHETIC');
    expect(l1.gateStatus).toBe('not-assessed');
    expect(l1.performance.samples).toBe(36);
    l1.queriesHash = 'different';
    expect(() => compareReport(l1, previous)).toThrow('incomparable');
  });
  it('can consume a future shared adapter without manufacturing section/grep results', async () => {
    const { release, queries } = fixture();
    const q = queries[6];
    // Unit-test adapter only: validates the seam, not evidence of P1 integration.
    const adapter: EvalRanker = { name: 'lex-v1', implementation: 'synthetic-unit-adapter', supportsSections: true,
      search: () => [hit('战斗/伤害.md', '暴击 › 技能表'), hit('公会/商店.md', '兑换')], grep: () => q.exhaustive! };
    const report = await evaluate({ release, queries: [q], ranker: adapter, preparationMs: 0, memoryBefore: collectMemory() });
    expect(report.overall!.sectionHitAt5.mean).toBe(1);
    expect(report.overall!.grepCompleteness.mean).toBe(1);
    const perf = await evaluate({ release, queries: [], benchmarkQueries: ['1001'], ranker: adapter, preparationMs: 0, memoryBefore: collectMemory() });
    expect(perf.overall).toBeNull(); expect(perf.groups).toBeNull(); expect(perf.rows).toEqual([]);
  });
  it('rejects changing results across measured rounds', async () => {
    const { release, queries } = fixture();
    let count = 0;
    const ranker: EvalRanker = { name: 'l0', implementation: 'synthetic-unit-adapter', supportsSections: false,
      search: () => [hit(String(++count))] };
    await expect(evaluate({ release, queries: queries.slice(0, 1), ranker, preparationMs: 0, memoryBefore: collectMemory() })).rejects.toThrow('nondeterministic');
  });
  it('rejects invalid CLI modes and rankers', () => {
    for (const argv of [[], ['--ranker', 'bad', '--out', '/tmp/x'], ['--ranker', 'l0', '--out', '/tmp/x', '--synthetic-mb', '11'],
      ['--ranker', 'l0', '--out', '/tmp/x', '--synthetic-fixture', '--release', '/tmp/r'],
      ['--ranker', 'l0', '--ranker', 'l1', '--out', '/tmp/x'], ['--unknown']]) {
      expect(() => parseArgs(argv)).toThrow('usage:');
    }
  });
  it('CLI writes JSON/Markdown for baselines and the real shared lex-v1 facade', () => {
    const root = temp();
    const script = fileURLToPath(new URL('../scripts/kb-eval.ts', import.meta.url));
    const run = (ranker: string) => spawnSync(process.execPath, ['--import', 'tsx', script, '--synthetic-fixture', '--ranker', ranker, '--out', path.join(root, ranker)], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, FEISHU_SYNC_HOME: root },
    });
    const success = run('l0');
    expect(success.stderr).toBe(''); expect(success.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'l0/report.json'), 'utf8'));
    expect(report.dataset).toBe('synthetic'); expect(report.rows).toHaveLength(12);
    expect(fs.readFileSync(path.join(root, 'l0/report.md'), 'utf8')).toContain('Q6');
    const pinned = path.join(root, 'release');
    materializeSynthetic(pinned);
    const pinnedRun = spawnSync(process.execPath, ['--import', 'tsx', script,
      '--release', pinned, '--queries', path.join(fixtureDir, 'synthetic-queries.jsonl'),
      '--ranker', 'l1', '--compare', path.join(root, 'l0/report.json'), '--out', path.join(root, 'pinned')], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, FEISHU_SYNC_HOME: root },
    });
    expect(pinnedRun.stderr).toBe(''); expect(pinnedRun.status).toBe(0);
    const pinnedReport = JSON.parse(fs.readFileSync(path.join(root, 'pinned/report.json'), 'utf8'));
    expect(pinnedReport.inputs.releaseDir).toBe(fs.realpathSync(pinned));
    expect(pinnedReport.rows[0].provenance.kind).toBe('synthetic');
    expect(pinnedReport.comparison.ranker).toBe('l0');
    // Refuse overwriting report evidence.
    expect(run('l0').stderr).toContain('out_not_empty');
    const lexical = run('lex-v1');
    expect(lexical.status).toBe(0); expect(lexical.stderr).toBe('');
    const lexicalReport = JSON.parse(fs.readFileSync(path.join(root, 'lex-v1/report.json'), 'utf8'));
    expect(lexicalReport.implementation).toBe('product-KbQueryService/lex-v1');
    expect(lexicalReport.overall.grepCompleteness).toEqual({ mean: 1, count: 2 });
    expect(lexicalReport.overall.sectionHitAt5.count).toBeGreaterThan(0);
    expect(lexicalReport.gateStatus).toBe('not-assessed');
  });
  it('never writes into release, including a new nested output or symlink alias', async () => {
    const { release, queryFile } = fixture();
    const alias = path.join(temp(), 'alias');
    fs.symlinkSync(release.dir, alias);
    for (const root of [release.dir, alias]) {
      const out = path.join(root, 'new/nested-report');
      await expect(runCli({ ranker: 'l0', release: release.dir, queries: queryFile, out })).rejects.toThrow('out_inside_release');
      expect(fs.existsSync(path.join(release.dir, 'new'))).toBe(false);
    }
  });
});
