/**
 * WP-F（kb-build-speedup）：pi-amagi 编排构建度量（kb_builds.metrics_json
 * 的 orchestration 段）。
 *
 * 1. aggregateLeaderOrchestrationMetrics 纯函数（轮数/首审率/分位/并发区间/
 *    缺源降级与 notes——不得编造）。
 * 2. collectLeaderOrchestrationMetricsFromDisk 磁盘读取（staging build-actors
 *    账本 + epoch journal + dispatch-rejections.jsonl；旧布局回退；全缺 → null）。
 * 3. BuildRuntimeHost.parseDispatchRejectionCode 拒绝码提取。
 * 4. toDto 对含 orchestration 的 metrics_json 向后兼容透传。
 *
 * 隔离：FEISHU_SYNC_HOME 一律指向临时目录；不触真实模型/真实生产资料。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateLeaderOrchestrationMetrics,
  type LeaderOrchestrationSources,
} from '../src/kb/build-metrics.js';
import { collectLeaderOrchestrationMetricsFromDisk, KbBuildService } from '../src/kb/kb-build-service.js';
import { BuildRuntimeHost } from '../src/kb/build-runtime-host.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import type { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { Config } from '../src/types/index.js';

const BASE = Date.parse('2026-11-07T06:00:00.000Z');
const at = (offsetMs: number): number => BASE + offsetMs;
const iso = (offsetMs: number): string => new Date(at(offsetMs)).toISOString();

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 手工构造的完整来源夹具（各断言的期望值见用例内注释）。 */
function fullSources(): LeaderOrchestrationSources {
  return {
    startedAtMs: at(0),
    finishedAtMs: at(50 * 60_000),
    collectedAtMs: at(60 * 60_000),
    docsWritten: 3,
    sourcesTotal: 12,
    actors: {
      status: 'ok',
      records: [
        { role: 'luban' }, { role: 'luban' }, { role: 'luban' },
        { role: 'diting' }, { role: 'diting' },
        { role: 'baize' },
        { role: 'custom-x' },
      ],
    },
    reviews: {
      status: 'ok',
      records: [
        { scopePaths: ['A.md'], verdict: 'pass', createdAtMs: at(10 * 60_000) },
        { scopePaths: ['B.md'], verdict: 'needs_revision', createdAtMs: at(12 * 60_000) },
        { scopePaths: ['B.md'], verdict: 'pass', createdAtMs: at(20 * 60_000) },
        { scopePaths: ['C.md'], verdict: 'needs_revision', createdAtMs: at(15 * 60_000) },
        { scopePaths: ['C.md'], verdict: 'needs_revision', createdAtMs: at(25 * 60_000) },
        { scopePaths: ['C.md'], verdict: 'pass', createdAtMs: at(30 * 60_000) },
      ],
    },
    legacyUnscopedReviews: 1,
    firstDrafts: {
      status: 'ok',
      records: [
        { path: 'A.md', atMs: at(5 * 60_000) },
        { path: 'B.md', atMs: at(6 * 60_000) },
        { path: 'C.md', atMs: at(8 * 60_000) },
      ],
    },
    publishSettledAtMs: at(50 * 60_000),
    rejectedPublishReasons: { status: 'ok', records: ['kb_publish_blocked', 'kb_validation_failed', ''] },
    dispatchRejectionCodes: {
      status: 'ok',
      records: ['dispatch_inflight_write_exhausted', 'dispatch_inflight_write_exhausted', 'kb_output_owned_by_other_task'],
    },
    journal: { status: 'ok', hasDispatchWithoutSessions: false },
    ledgerEvents: { status: 'ok' },
    // 运行区间（session→settle；相对 BASE 毫秒）：peak=4、area=41000、窗口 20000 → avg=2.05
    runningIntervals: [
      { startMs: at(0), endMs: at(10_000) },
      { startMs: at(5_000), endMs: at(8_000) },
      { startMs: at(5_000), endMs: at(20_000) },
      { startMs: at(7_000), endMs: null }, // 无 settle → 按窗口末端截断
    ],
    runningDerivation: 'journal-session',
    runningUnterminated: 1,
    // 在途区间（dispatch→最终 settle，含排队）：peak=2、area=32k、窗口 30k → avg=1.07
    submittedIntervals: [
      { startMs: at(0), endMs: at(30_000) },
      { startMs: at(2_000), endMs: at(4_000) },
    ],
    submittedUnterminated: 0,
  };
}

/** 全部来源不可得的输入（R5-02：全缺 → null 保持）。 */
function allMissingSources(): LeaderOrchestrationSources {
  return {
    startedAtMs: null, finishedAtMs: null, collectedAtMs: at(0),
    docsWritten: 0, sourcesTotal: 0,
    actors: { status: 'missing', file: 'actors.json' },
    reviews: { status: 'missing', file: 'reviews.json' },
    legacyUnscopedReviews: 0,
    firstDrafts: { status: 'missing', file: 'receipts.json' },
    publishSettledAtMs: null,
    rejectedPublishReasons: { status: 'missing', file: 'publish-requests.json' },
    dispatchRejectionCodes: { status: 'missing', file: 'dispatch-rejections.jsonl' },
    journal: { status: 'missing', hasDispatchWithoutSessions: false },
    ledgerEvents: { status: 'missing' },
    runningIntervals: null, runningDerivation: 'none', runningUnterminated: 0,
    submittedIntervals: null, submittedUnterminated: 0,
  };
}

describe('aggregateLeaderOrchestrationMetrics：完整来源', () => {
  it('墙钟/产出/派发/审查轮数/首审率/发布拒绝/派发拒绝/并发区间/分位全部落值', () => {
    const metrics = aggregateLeaderOrchestrationMetrics(fullSources())!;
    expect(metrics).not.toBeNull();
    expect(metrics.wallClockMs).toBe(50 * 60_000);
    expect(metrics.docsPublished).toBe(3);
    expect(metrics.sourcesTotal).toBe(12);
    expect(metrics.authorDispatches).toBe(3);
    expect(metrics.reviewDispatches).toBe(2);
    expect(metrics.researchDispatches).toBe(1);
    // 每篇轮数 [1,2,3]：median 2 / max 3；首审 pass=1（A）、needs_revision=2（B,C）
    expect(metrics.revisionRounds).toMatchObject({
      docsReviewed: 3, totalReviews: 6, roundsMedian: 2, roundsMax: 3,
      firstVerdicts: { pass: 1, needs_revision: 2, insufficient_material: 0, fail: 0 },
      firstPassRate: 0.3333,
    });
    // 缺 reason 的拒绝计 unknown；计数按 code 聚合
    expect(metrics.publishRejections).toEqual({ kb_publish_blocked: 1, kb_validation_failed: 1, unknown: 1 });
    expect(metrics.dispatchRejections).toEqual({
      dispatch_inflight_write_exhausted: 2, kb_output_owned_by_other_task: 1,
    });
    expect(metrics.pool).toEqual({
      peakInflight: 4, avgInflight: 2.05, derivation: 'journal-session',
      submittedPeakInflight: 2, submittedAvgInflight: 1.07,
    });
    // 首稿→发布：A=45m / B=44m / C=42m → nearest-rank p50=44m、p90=45m
    expect(metrics.firstDraftToPublish).toEqual({
      count: 3, p50Ms: 44 * 60_000, p90Ms: 45 * 60_000, maxMs: 45 * 60_000,
    });
    // 缺口说明如实存在（未识别角色 / 旧无范围回执 / 无终点截断）
    expect(metrics.notes).toEqual([
      '未识别角色派发：custom-x×1',
      '1 条无 scopePaths 的旧审查回执不计入每篇口径',
      '1 个运行区间无 settle 终点，按窗口末端截断',
    ]);
  });
});

describe('aggregateLeaderOrchestrationMetrics：缺源降级（不得编造）', () => {
  it('全部来源不可得 → null（调用方省略 orchestration 键；全缺降级语义保持）', () => {
    expect(aggregateLeaderOrchestrationMetrics(allMissingSources())).toBeNull();
  });

  it('R5-02：仅 actors 可读 → 派发计数有值；reviews/publish-requests 缺失 → 整段 null + notes 指名文件；不再冒充 0', () => {
    const metrics = aggregateLeaderOrchestrationMetrics({
      ...fullSources(),
      reviews: { status: 'missing', file: 'reviews.json' },
      legacyUnscopedReviews: 0,
      firstDrafts: { status: 'missing', file: 'receipts.json' },
      rejectedPublishReasons: { status: 'missing', file: 'publish-requests.json' },
      dispatchRejectionCodes: { status: 'missing', file: 'dispatch-rejections.jsonl' },
      runningIntervals: null, runningDerivation: 'none', runningUnterminated: 0,
      submittedIntervals: null, submittedUnterminated: 0,
      journal: { status: 'missing', hasDispatchWithoutSessions: false },
      ledgerEvents: { status: 'missing' },
    })!;
    // 可读源：真实计数
    expect(metrics.authorDispatches).toBe(3);
    expect(metrics.reviewDispatches).toBe(2);
    expect(metrics.researchDispatches).toBe(1);
    // 不可得源：null / 省略，绝不冒充 0/{}
    expect(metrics.revisionRounds).toBeNull();
    expect(metrics.publishRejections).toBeNull();
    expect('dispatchRejections' in metrics).toBe(false);
    expect('firstDraftToPublish' in metrics).toBe(false);
    // notes 逐个指名缺口文件与影响
    for (const note of [
      'reviews.json缺失，审查轮数与首审通过率不可推导',
      'receipts.json缺失，首稿→发布分布不可推导',
      'publish-requests.json缺失，发布拒绝计数不可推导',
      'dispatch-rejections.jsonl缺失，派发拒绝不可推导（WP-F 之前的构建无此审计文件）',
      'dispatch journal（dispatch.jsonl）缺失且账本 events.jsonl缺失，运行并发未推导',
    ] as const) {
      expect(metrics.notes).toContain(note);
    }
  });

  it('R5-02：可读且真实空数组 = 0/无（与不可得严格区分）', () => {
    const metrics = aggregateLeaderOrchestrationMetrics({
      ...fullSources(),
      actors: { status: 'ok', records: [] },
      reviews: { status: 'ok', records: [] },
      legacyUnscopedReviews: 0,
      firstDrafts: { status: 'ok', records: [] },
      rejectedPublishReasons: { status: 'ok', records: [] },
      dispatchRejectionCodes: { status: 'ok', records: [] },
      runningIntervals: [], runningDerivation: 'journal-session', runningUnterminated: 0,
      submittedIntervals: [], submittedUnterminated: 0,
      journal: { status: 'ok', hasDispatchWithoutSessions: false },
    })!;
    expect(metrics.authorDispatches).toBe(0);
    expect(metrics.reviewDispatches).toBe(0);
    expect(metrics.researchDispatches).toBe(0);
    expect(metrics.revisionRounds).toMatchObject({
      docsReviewed: 0, totalReviews: 0, roundsMedian: null, roundsMax: null, firstPassRate: null,
    });
    expect(metrics.publishRejections).toEqual({});
    expect(metrics.dispatchRejections).toEqual({});
    // 可读空首稿 + 已发布 → count 0（真实零，非省略）
    expect(metrics.firstDraftToPublish).toEqual({ count: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 });
    // 空运行区间 = 真实零并发；avg 无窗口不可推导
    expect(metrics.pool).toEqual({
      peakInflight: 0, avgInflight: null, derivation: 'journal-session',
      submittedPeakInflight: 0, submittedAvgInflight: null,
    });
  });

  it('R5-02：损坏（corrupt）与缺失分开注明', () => {
    const metrics = aggregateLeaderOrchestrationMetrics({
      ...fullSources(),
      reviews: { status: 'corrupt', file: 'reviews.json' },
      legacyUnscopedReviews: 0,
      rejectedPublishReasons: { status: 'corrupt', file: 'publish-requests.json' },
      dispatchRejectionCodes: { status: 'corrupt', file: 'dispatch-rejections.jsonl' },
      journal: { status: 'corrupt', hasDispatchWithoutSessions: false },
      ledgerEvents: { status: 'corrupt' },
      runningIntervals: null, runningDerivation: 'none', runningUnterminated: 0,
      submittedIntervals: null, submittedUnterminated: 0,
    })!;
    expect(metrics.revisionRounds).toBeNull();
    expect(metrics.publishRejections).toBeNull();
    expect('dispatchRejections' in metrics).toBe(false);
    expect(metrics.notes).toContain('reviews.json损坏，审查轮数与首审通过率不可推导');
    expect(metrics.notes).toContain('publish-requests.json损坏，发布拒绝计数不可推导');
    expect(metrics.notes).toContain('dispatch-rejections.jsonl损坏，派发拒绝不可推导');
    expect(metrics.notes).toContain('dispatch journal（dispatch.jsonl）损坏且账本 events.jsonl损坏，运行并发未推导');
  });

  it('dispatchRejectionCodes 不可得 → 键省略；无区间 → peak/avg null + derivation none', () => {
    const metrics = aggregateLeaderOrchestrationMetrics({
      ...fullSources(), dispatchRejectionCodes: { status: 'missing', file: 'dispatch-rejections.jsonl' },
      runningIntervals: null, runningDerivation: 'none', runningUnterminated: 0,
      submittedIntervals: null, submittedUnterminated: 0,
      journal: { status: 'ok', hasDispatchWithoutSessions: false },
      ledgerEvents: { status: 'ok' },
    })!;
    expect('dispatchRejections' in metrics).toBe(false);
    expect(metrics.pool).toEqual({ peakInflight: null, avgInflight: null, derivation: 'none' });
    // submitted 键同理省略（无 journal）
    expect('submittedPeakInflight' in metrics.pool).toBe(false);
  });

  it('finishedAt 为空（未收口终态）→ 墙钟按采集时刻并注明', () => {
    const metrics = aggregateLeaderOrchestrationMetrics({ ...fullSources(), finishedAtMs: null })!;
    expect(metrics.wallClockMs).toBe(60 * 60_000);
    expect(metrics.notes).toContain('finished_at 为空（未收口终态），墙钟按采集时刻计算');
  });

  it('未到达发布 → firstDraftToPublish 省略并注明', () => {
    const metrics = aggregateLeaderOrchestrationMetrics({ ...fullSources(), publishSettledAtMs: null })!;
    expect('firstDraftToPublish' in metrics).toBe(false);
    expect(metrics.notes).toContain('未到达发布结算，firstDraftToPublish 省略');
  });

  it('无范围审查（reviews 可读但无 scopePaths 记录）→ 轮数分布真实零', () => {
    const metrics = aggregateLeaderOrchestrationMetrics({
      ...fullSources(), reviews: { status: 'ok', records: [] }, legacyUnscopedReviews: 0,
    })!;
    expect(metrics.revisionRounds).toMatchObject({
      docsReviewed: 0, totalReviews: 0, roundsMedian: null, roundsMax: null, firstPassRate: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 磁盘读取（staging build-actors + epochs journal + dispatch-rejections）
// ---------------------------------------------------------------------------

interface DiskFixture {
  home: string;
  outputRoot: string;
  dataRoot: string;
  buildId: string;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file: string, records: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

/** 模拟一个真实形状的最小构建现场（journal 区间 + 账本 + 拒绝审计）。 */
function buildDiskFixture(withJournal: boolean): DiskFixture {
  const home = tempDir('kbmf-home-');
  const outputRoot = path.join(home, 'standard-kb');
  const buildId = 'b_fixture_20261107';
  const actorsDir = path.join(outputRoot, '.staging', buildId, 'build-actors');
  writeJson(path.join(actorsDir, 'actors.json'), [
    { nativeTaskId: 't1', role: 'luban', status: 'confirmed' },
    { nativeTaskId: 't2', role: 'luban', status: 'superseded' },
    { nativeTaskId: 'r1', role: 'diting', status: 'confirmed' },
  ]);
  writeJson(path.join(actorsDir, 'reviews.json'), [
    { reviewId: 'krev_1', reviewerTaskId: 'r1', scopePaths: ['X.md'], verdict: 'needs_revision', createdAt: iso(20 * 60_000) },
    { reviewId: 'krev_2', reviewerTaskId: 'r1', scopePaths: ['X.md'], verdict: 'pass', createdAt: iso(30 * 60_000) },
    { reviewId: 'krev_3', reviewerTaskId: 'r1', scopePaths: ['Y.md'], verdict: 'pass', createdAt: iso(31 * 60_000) },
  ]);
  writeJson(path.join(actorsDir, 'receipts.json'), [
    { kind: 'write_doc', createdAt: iso(5 * 60_000), result: { paths: ['X.md'] } },
    { kind: 'edit_doc', createdAt: iso(6 * 60_000), result: { paths: ['X.md'] } },
    { kind: 'write_doc', createdAt: iso(7 * 60_000), result: { paths: ['Y.md'] } },
    { kind: 'delete_doc', createdAt: iso(8 * 60_000), result: { paths: ['Z.md'] } },
  ]);
  writeJson(path.join(actorsDir, 'publish-requests.json'), [
    { requestId: 'pub_1', status: 'rejected', result: { reason: 'kb_validation_failed' }, settledAt: iso(40 * 60_000) },
    { requestId: 'pub_2', status: 'accepted', result: { status: 'published' }, settledAt: iso(50 * 60_000) },
  ]);
  writeJsonl(path.join(actorsDir, 'events.jsonl'), [
    { eventId: 'e1', type: 'publish_settled', receivedAt: iso(50 * 60_000), payload: { requestId: 'pub_2', status: 'accepted' } },
  ]);
  const epochRoot = path.join(home, 'agent', 'builds', buildId, 'epochs', 'e1');
  if (withJournal) {
    writeJsonl(path.join(epochRoot, 'home', 'amagi', 'data', 'journal', 'dispatch.jsonl'), [
      { type: 'dispatch', taskId: 't1', agent: 'luban', at: at(10_000), pid: 1 },
      { type: 'session', taskId: 't1', sessionId: 's1', at: at(12_000) },
      { type: 'settle', taskId: 't1', status: 'done', at: at(60_000) },
      { type: 'dispatch', taskId: 't2', agent: 'luban', at: at(20_000), pid: 1 },
      { type: 'session', taskId: 't2', sessionId: 's2', at: at(22_000) },
      { type: 'settle', taskId: 't2', status: 'done', at: at(90_000) },
    ]);
  } else {
    writeJsonl(path.join(actorsDir, 'events.jsonl'), [
      { eventId: 'e0', type: 'actor_confirmed', taskId: 't1', receivedAt: iso(10_000), payload: {} },
      { eventId: 'e1', type: 'handoff_submitted', taskId: 't1', receivedAt: iso(60_000), payload: {} },
      { eventId: 'e2', type: 'actor_confirmed', taskId: 't2', receivedAt: iso(20_000), payload: {} },
      { eventId: 'e3', type: 'handoff_submitted', taskId: 't2', receivedAt: iso(90_000), payload: {} },
      { eventId: 'e4', type: 'publish_settled', receivedAt: iso(50 * 60_000), payload: { requestId: 'pub_2', status: 'accepted' } },
    ]);
  }
  writeJsonl(path.join(epochRoot, 'dispatch-rejections.jsonl'), [
    { schemaVersion: 1, at: iso(30_000), tool: 'task_submit', agent: 'luban', code: 'dispatch_inflight_write_exhausted', message: 'x（dispatch_inflight_write_exhausted）' },
    { schemaVersion: 1, at: iso(31_000), tool: 'task_submit', agent: 'diting', code: 'dispatch_inflight_pool_saturated', message: 'y（dispatch_inflight_pool_saturated）' },
  ]);
  return { home, outputRoot, dataRoot: home, buildId };
}

function fixtureRow(): Record<string, unknown> {
  return {
    id: 'b_fixture_20261107', status: 'published', orchestration_mode: 'pi-amagi',
    started_at: iso(0), finished_at: iso(50 * 60_000),
    docs_written: 2, source_total: 9,
  };
}

describe('collectLeaderOrchestrationMetricsFromDisk：磁盘读取', () => {
  it('journal 存在 → 精确区间（peak=2）+ 账本聚合 + 拒绝审计计数', () => {
    const fixture = buildDiskFixture(true);
    const metrics = collectLeaderOrchestrationMetricsFromDisk({
      buildId: fixture.buildId, row: fixtureRow(), outputRoot: fixture.outputRoot, dataRoot: fixture.dataRoot,
    })!;
    expect(metrics).not.toBeNull();
    expect(metrics.wallClockMs).toBe(50 * 60_000);
    expect(metrics.docsPublished).toBe(2);
    expect(metrics.sourcesTotal).toBe(9);
    expect(metrics.authorDispatches).toBe(2);
    expect(metrics.reviewDispatches).toBe(1);
    // X.md 两轮（首审 needs_revision）、Y.md 一轮（pass）→ 首审通过率 1/2
    expect(metrics.revisionRounds).toMatchObject({
      docsReviewed: 2, totalReviews: 3, firstPassRate: 0.5,
      firstVerdicts: { pass: 1, needs_revision: 1, insufficient_material: 0, fail: 0 },
    });
    expect(metrics.publishRejections).toEqual({ kb_validation_failed: 1 });
    expect(metrics.dispatchRejections).toEqual({
      dispatch_inflight_pool_saturated: 1, dispatch_inflight_write_exhausted: 1,
    });
    // 运行区间 [12k,60k] 与 [22k,90k]：窗口 78s、面积 116s → peak=2、avg=1.49；
    // 在途区间 [10k,60k] 与 [20k,90k]：窗口 80s、面积 120s → peak=2、avg=1.5
    expect(metrics.pool.derivation).toBe('journal-session');
    expect(metrics.pool.peakInflight).toBe(2);
    expect(metrics.pool.avgInflight).toBe(1.49);
    expect(metrics.pool.submittedPeakInflight).toBe(2);
    expect(metrics.pool.submittedAvgInflight).toBe(1.5);
    // 首稿 X@5m（edit@6m 不覆盖首稿）、Y@7m → 发布 50m：45m / 43m → p50=43m p90=45m
    expect(metrics.firstDraftToPublish).toEqual({
      count: 2, p50Ms: 43 * 60_000, p90Ms: 45 * 60_000, maxMs: 45 * 60_000,
    });
  });

  it('journal 缺失 → 账本事件近似（actor_confirmed→handoff_submitted）并注明口径', () => {
    const fixture = buildDiskFixture(false);
    const metrics = collectLeaderOrchestrationMetricsFromDisk({
      buildId: fixture.buildId, row: fixtureRow(), outputRoot: fixture.outputRoot, dataRoot: fixture.dataRoot,
    })!;
    expect(metrics.pool.derivation).toBe('actor-events');
    expect(metrics.pool.peakInflight).toBe(2);
    expect(metrics.pool.submittedPeakInflight).toBeUndefined();
    expect(metrics.notes).toContain('dispatch journal（dispatch.jsonl）缺失，运行并发按账本 actor_confirmed→handoff_submitted 近似（含排队间隙）');
  });

  it('现场全缺（无账本无 epoch）→ null；不抛错', () => {
    const home = tempDir('kbmf-empty-');
    const metrics = collectLeaderOrchestrationMetricsFromDisk({
      buildId: 'b_nope', row: { status: 'failed', started_at: iso(0), finished_at: iso(1) },
      outputRoot: path.join(home, 'standard-kb'), dataRoot: home,
    });
    expect(metrics).toBeNull();
  });

  it('损坏的账本/日志文件不抛错（降级为缺源）', () => {
    const home = tempDir('kbmf-corrupt-');
    const buildId = 'b_corrupt';
    const actorsDir = path.join(home, 'standard-kb', '.staging', buildId, 'build-actors');
    fs.mkdirSync(actorsDir, { recursive: true });
    fs.writeFileSync(path.join(actorsDir, 'actors.json'), '{broken');
    fs.writeFileSync(path.join(actorsDir, 'events.jsonl'), '{not-json}\n{"type":"publish_settled","receivedAt":"not-a-date","payload":{}}\n');
    const metrics = collectLeaderOrchestrationMetricsFromDisk({
      buildId, row: { status: 'failed', started_at: iso(0), finished_at: iso(1), docs_written: 0, source_total: 0 },
      outputRoot: path.join(home, 'standard-kb'), dataRoot: home,
    });
    expect(metrics).toBeNull();
  });
});

describe('collectLeaderOrchestrationMetricsFromDisk：R5-02 三态（不可得 ≠ 真实空）', () => {
  it('仅 actors.json 存在 → 派发计数真实；reviews/publish-requests 等缺失 → null + notes 指名文件（不冒充 0）', () => {
    const home = tempDir('kbmf-actors-only-');
    const outputRoot = path.join(home, 'standard-kb');
    const buildId = 'b_actors_only';
    writeJson(path.join(outputRoot, '.staging', buildId, 'build-actors', 'actors.json'), [
      { nativeTaskId: 't1', role: 'luban', status: 'confirmed' },
      { nativeTaskId: 'r1', role: 'diting', status: 'confirmed' },
    ]);
    const metrics = collectLeaderOrchestrationMetricsFromDisk({
      buildId, row: { status: 'failed', started_at: iso(0), finished_at: iso(60_000), docs_written: 1, source_total: 5 },
      outputRoot, dataRoot: home,
    })!;
    expect(metrics).not.toBeNull();
    expect(metrics.authorDispatches).toBe(1);
    expect(metrics.reviewDispatches).toBe(1);
    expect(metrics.researchDispatches).toBe(0);
    expect(metrics.revisionRounds).toBeNull();
    expect(metrics.publishRejections).toBeNull();
    expect('dispatchRejections' in metrics).toBe(false);
    expect(metrics.pool).toEqual({ peakInflight: null, avgInflight: null, derivation: 'none' });
    for (const note of [
      'reviews.json缺失，审查轮数与首审通过率不可推导',
      'publish-requests.json缺失，发布拒绝计数不可推导',
      'dispatch-rejections.jsonl缺失，派发拒绝不可推导（WP-F 之前的构建无此审计文件）',
      'dispatch journal（dispatch.jsonl）缺失且账本 events.jsonl缺失，运行并发未推导',
    ] as const) {
      expect(metrics.notes).toContain(note);
    }
    // failed 构建 + publish-requests 缺失 → 无发布结算，首稿分布因“未发布”省略；
    // receipts 缺失的缺口注记仅在“已到达发布但回执不可读”时才有意义，不在此处喿声。
    expect('firstDraftToPublish' in metrics).toBe(false);
    expect(metrics.notes).not.toContain('receipts.json缺失，首稿→发布分布不可推导');
  });

  it('reviews.json 损坏 → revisionRounds null + 损坏注记；其余源正常', () => {
    const fixture = buildDiskFixture(true);
    fs.writeFileSync(path.join(fixture.outputRoot, '.staging', fixture.buildId, 'build-actors', 'reviews.json'), '{broken');
    const metrics = collectLeaderOrchestrationMetricsFromDisk({
      buildId: fixture.buildId, row: fixtureRow(), outputRoot: fixture.outputRoot, dataRoot: fixture.dataRoot,
    })!;
    expect(metrics.revisionRounds).toBeNull();
    expect(metrics.notes).toContain('reviews.json损坏，审查轮数与首审通过率不可推导');
    // 其余可读源不受影响
    expect(metrics.authorDispatches).toBe(2);
    expect(metrics.publishRejections).toEqual({ kb_validation_failed: 1 });
    expect(metrics.pool.derivation).toBe('journal-session');
  });

  it('publish-requests.json 缺失 → publishRejections null；发布结算回退 finished_at', () => {
    const fixture = buildDiskFixture(true);
    fs.rmSync(path.join(fixture.outputRoot, '.staging', fixture.buildId, 'build-actors', 'publish-requests.json'));
    const metrics = collectLeaderOrchestrationMetricsFromDisk({
      buildId: fixture.buildId, row: fixtureRow(), outputRoot: fixture.outputRoot, dataRoot: fixture.dataRoot,
    })!;
    expect(metrics.publishRejections).toBeNull();
    expect(metrics.notes).toContain('publish-requests.json缺失，发布拒绝计数不可推导');
    // events.jsonl 仍在：无 publish_settled（fixture 事件在）……本夹具 events 有 accepted
    // publish_settled，发布结算仍可得；首稿分布不受影响。
    expect(metrics.firstDraftToPublish).toMatchObject({ count: 2 });
  });

  it('真实空文件 = 0/无（与不可得严格对照）', () => {
    const home = tempDir('kbmf-empty-files-');
    const outputRoot = path.join(home, 'standard-kb');
    const buildId = 'b_empty_files';
    const actorsDir = path.join(outputRoot, '.staging', buildId, 'build-actors');
    writeJson(path.join(actorsDir, 'actors.json'), []);
    writeJson(path.join(actorsDir, 'reviews.json'), []);
    writeJson(path.join(actorsDir, 'receipts.json'), []);
    writeJson(path.join(actorsDir, 'publish-requests.json'), []);
    fs.mkdirSync(actorsDir, { recursive: true });
    fs.writeFileSync(path.join(actorsDir, 'events.jsonl'), '');
    const metrics = collectLeaderOrchestrationMetricsFromDisk({
      buildId, row: { status: 'published', started_at: iso(0), finished_at: iso(60_000), docs_written: 0, source_total: 0 },
      outputRoot, dataRoot: home,
    })!;
    expect(metrics.authorDispatches).toBe(0);
    expect(metrics.reviewDispatches).toBe(0);
    expect(metrics.revisionRounds).toMatchObject({ docsReviewed: 0, totalReviews: 0, firstPassRate: null });
    expect(metrics.publishRejections).toEqual({});
    expect(metrics.firstDraftToPublish).toEqual({ count: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 });
    // journal 缺失 + 账本可读但无身份事件 → 运行并发未推导（缺 journal 注记）
    expect(metrics.pool.derivation).toBe('none');
    expect(metrics.notes).toContain('dispatch journal（dispatch.jsonl）缺失且账本无可用身份事件，运行并发未推导');
    // 不存在“不可得”误当 0：dispatchRejections 键省略（文件不存在）
    expect('dispatchRejections' in metrics).toBe(false);
  });
});

describe('BuildRuntimeHost.parseDispatchRejectionCode', () => {
  it('尾部括号码 / 前缀 code: / [code] / 不可识别 → unknown', () => {
    expect(BuildRuntimeHost.parseDispatchRejectionCode('在途写作已达容量上限（dispatch_inflight_write_exhausted）')).toBe('dispatch_inflight_write_exhausted');
    expect(BuildRuntimeHost.parseDispatchRejectionCode('kb_output_owned_by_other_task: 文档由他人持有')).toBe('kb_output_owned_by_other_task');
    expect(BuildRuntimeHost.parseDispatchRejectionCode('[amagi-mcp] 任务参数无效')).toBe('amagi-mcp');
    expect(BuildRuntimeHost.parseDispatchRejectionCode('随便一段没有码的文字')).toBe('unknown');
    expect(BuildRuntimeHost.parseDispatchRejectionCode('')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// toDto 兼容：含 orchestration 的 metrics_json 透传
// ---------------------------------------------------------------------------

describe('KbBuildService.toDto：orchestration 段透传（向后兼容）', () => {
  let previousHome: string | undefined;

  beforeAll(() => {
    previousHome = process.env.FEISHU_SYNC_HOME;
    process.env.FEISHU_SYNC_HOME = tempDir('kbmf-feishu-home-');
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.FEISHU_SYNC_HOME;
    else process.env.FEISHU_SYNC_HOME = previousHome;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('含 orchestration 的 metrics_json 解析后原样透传；不含时 DTO 无 metrics 键', async () => {
    const home = tempDir('kbmf-dto-');
    const outputRoot = path.join(home, 'standard-kb');
    fs.mkdirSync(outputRoot, { recursive: true });
    const config = {
      standardKb: { outputRoot },
      knowledgeBaseRoot: path.join(home, 'kb'),
    } as unknown as Config;
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const toolService = new AgentToolService({ dataRoot: home, documentsProvider: () => [], sheetCsvPaths: () => [] });
    const service = new KbBuildService({
      dataRoot: home, pool, toolService,
      resolver: {
        resolveRuntime: async () => ({ nodePath: '/bin/true', piCliPath: '/bin/true', piPackageRoot: '' }),
      } as unknown as PiRuntimeResolver,
      configProvider: () => config, documentsProvider: () => [], sheetCsvPaths: () => [],
      internalBaseUrl: () => 'http://127.0.0.1:39999', extensionPath: () => null, promptAssets: () => null,
    });
    const base = {
      id: 'b-dto-orch', mode: 'full', status: 'published', no_changes: 0,
      created_at: '2026-11-07T00:00:00.000Z', parallelism: 1, orchestration_mode: 'pi-amagi',
    };
    const plain = service.toDto({ ...base } as Record<string, unknown>);
    expect('metrics' in plain).toBe(false);

    const orchestration = aggregateLeaderOrchestrationMetrics(fullSources())!;
    const metricsJson = JSON.stringify({
      units: { total: 0, perUnit: [], maxWordsShare: null }, phases: [],
      queueWaits: { count: 0, totalMs: 0, maxMs: 0 }, review: { blocking: 0, suggestion: 0, revisions: 0 },
      tokenUsage: null, reviewerSameModelAsWriter: true,
      orchestration,
    });
    const dto = service.toDto({ ...base, metrics_json: metricsJson } as Record<string, unknown>);
    expect(dto.metrics?.orchestration).toEqual(orchestration);
    await pool.closeAll();
  });
});
