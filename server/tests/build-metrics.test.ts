/**
 * 构建编排优化方案 S1/S2（切片 A）：
 * 1. build-metrics 纯函数（聚合 / 风险告警 / 角色同源判定）。
 * 2. AgentProcessPool build 通道 acquire 等待毫秒记录（不改准入语义）。
 * 3. LocalMapStore kb_builds.metrics_json additive 迁移与 updateKbBuild 往返。
 * 4. KbBuildDto.metrics 可选字段（向后兼容）。
 * 5. 端到端：编排流水与单进程流水 finish 时落 metrics_json（采集失败不阻断）。
 *
 * 隔离：FEISHU_SYNC_HOME 一律指向临时目录（CLAUDE.md 约定）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateBuildMetrics,
  computeRiskWarnings,
  sameProviderModel,
  OVERSIZED_UNIT_SHARE_THRESHOLD,
  POOL_CAPACITY_WARN_THRESHOLD,
  METRICS_PHASES_CAP,
} from '../src/kb/build-metrics.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { Config } from '../src/types/index.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { KbBuildMetrics } from '../src/types/agent-knowledge.js';

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------

describe('build-metrics：aggregateBuildMetrics', () => {
  it('单元规模分布与 maxWordsShare 按有效字数占比计算', () => {
    const metrics = aggregateBuildMetrics({
      units: [
        { unitId: 'u1', sources: 3, words: 800, bytes: 9000 },
        { unitId: 'u2', sources: 1, words: 200, bytes: 1000 },
      ],
      phaseSpans: [],
      queueWaits: { count: 2, totalMs: 150, maxMs: 100 },
      review: { blocking: 1, suggestion: 2, revisions: 3 },
      reviewerSameModelAsWriter: false,
    });
    expect(metrics.units.total).toBe(2);
    expect(metrics.units.perUnit).toEqual([
      { unitId: 'u1', sources: 3, words: 800, bytes: 9000 },
      { unitId: 'u2', sources: 1, words: 200, bytes: 1000 },
    ]);
    expect(metrics.units.maxWordsShare).toBe(0.8);
    expect(metrics.queueWaits).toEqual({ count: 2, totalMs: 150, maxMs: 100 });
    expect(metrics.review).toEqual({ blocking: 1, suggestion: 2, revisions: 3 });
    expect(metrics.reviewerSameModelAsWriter).toBe(false);
  });

  it('words 全 0（字数预算关闭）时 maxWordsShare 为 null，不退回 bytes 口径', () => {
    const metrics = aggregateBuildMetrics({
      units: [{ unitId: 'u1', sources: 2, words: 0, bytes: 5000 }],
      phaseSpans: [],
      queueWaits: { count: 0, totalMs: 0, maxMs: 0 },
      review: { blocking: 0, suggestion: 0, revisions: 0 },
      reviewerSameModelAsWriter: null,
    });
    expect(metrics.units.maxWordsShare).toBeNull();
  });

  it('phases 由 ISO 起止计算毫秒；非法时间戳按 0 而非 NaN', () => {
    const metrics = aggregateBuildMetrics({
      units: [],
      phaseSpans: [
        { unitId: 'u1', role: 'write', round: 1, startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:02.500Z' },
        { unitId: null, role: 'final', round: 0, startedAt: 'not-a-date', finishedAt: '2026-10-01T00:00:00.000Z' },
      ],
      queueWaits: { count: 0, totalMs: 0, maxMs: 0 },
      review: { blocking: 0, suggestion: 0, revisions: 0 },
      reviewerSameModelAsWriter: null,
    });
    expect(metrics.phases[0]).toMatchObject({ unitId: 'u1', role: 'write', round: 1, ms: 2500 });
    expect(metrics.phases[1].ms).toBe(0);
  });

  it('phases 截断暴露 phasesDropped（采集端 + 聚合侧求和）；未截断不带键（旧 metrics 兼容）', () => {
    const span = (i: number) => ({
      unitId: `u${i}`, role: 'write' as const, round: 1,
      startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z',
    });
    // 聚合侧截断：超出 METRICS_PHASES_CAP 的条数如实暴露
    const over = aggregateBuildMetrics({
      units: [],
      phaseSpans: Array.from({ length: METRICS_PHASES_CAP + 3 }, (_, i) => span(i)),
      queueWaits: { count: 0, totalMs: 0, maxMs: 0 },
      review: { blocking: 0, suggestion: 0, revisions: 0 },
      reviewerSameModelAsWriter: null,
    });
    expect(over.phases).toHaveLength(METRICS_PHASES_CAP);
    expect(over.phasesDropped).toBe(3);
    // 采集端已丢弃的条数与聚合侧求和
    const withCollectorDrops = aggregateBuildMetrics({
      units: [],
      phaseSpans: [span(0)],
      phasesDropped: 5,
      queueWaits: { count: 0, totalMs: 0, maxMs: 0 },
      review: { blocking: 0, suggestion: 0, revisions: 0 },
      reviewerSameModelAsWriter: null,
    });
    expect(withCollectorDrops.phasesDropped).toBe(5);
    // 未截断：不带键（旧 metrics_json 形状不变）
    const under = aggregateBuildMetrics({
      units: [],
      phaseSpans: [span(0), span(1)],
      queueWaits: { count: 0, totalMs: 0, maxMs: 0 },
      review: { blocking: 0, suggestion: 0, revisions: 0 },
      reviewerSameModelAsWriter: null,
    });
    expect('phasesDropped' in under).toBe(false);
  });

  it('tokenUsage 恒为 null（运行时事件无用量来源，禁止编造）', () => {
    const metrics = aggregateBuildMetrics({
      units: [], phaseSpans: [], queueWaits: { count: 0, totalMs: 0, maxMs: 0 },
      review: { blocking: 0, suggestion: 0, revisions: 0 }, reviewerSameModelAsWriter: null,
    });
    expect(metrics.tokenUsage).toBeNull();
  });
});

describe('build-metrics：computeRiskWarnings（S2 三类，均不阻断）', () => {
  const base = {
    units: [] as Array<{ unitId: string; words: number }>,
    workerCount: 1,
    orchestrated: false,
    reviewerSameModelAsWriter: null as boolean | null,
    totalCapacity: 5,
  };

  it('oversized_unit：占比≥50% 且 workerCount>1 才触发', () => {
    const units = [{ unitId: 'u1', words: 800 }, { unitId: 'u2', words: 200 }];
    expect(computeRiskWarnings({ ...base, units, workerCount: 2 }).map((w) => w.code)).toContain('oversized_unit');
    // 单 worker：并行无从退化
    expect(computeRiskWarnings({ ...base, units, workerCount: 1 }).map((w) => w.code)).not.toContain('oversized_unit');
    // 占比低于阈值（最大 40%）
    const balanced = [{ unitId: 'u1', words: 400 }, { unitId: 'u2', words: 300 }, { unitId: 'u3', words: 300 }];
    expect(computeRiskWarnings({ ...base, units: balanced, workerCount: 2 }).map((w) => w.code)).not.toContain('oversized_unit');
    // words 未统计（预算关闭）→ 无法计算，不告警
    const zero = [{ unitId: 'u1', words: 0 }];
    expect(computeRiskWarnings({ ...base, units: zero, workerCount: 2 }).map((w) => w.code)).not.toContain('oversized_unit');
    // 阈值边界：恰好 50% 触发
    const edge = [{ unitId: 'u1', words: 500 }, { unitId: 'u2', words: 500 }];
    expect(computeRiskWarnings({ ...base, units: edge, workerCount: 2 }).map((w) => w.code)).toContain('oversized_unit');
    expect(OVERSIZED_UNIT_SHARE_THRESHOLD).toBe(0.5);
  });

  it('reviewer_same_model：仅 orchestrated 且判定为同模型时触发；null 不触发', () => {
    expect(computeRiskWarnings({ ...base, orchestrated: true, reviewerSameModelAsWriter: true }).map((w) => w.code)).toContain('reviewer_same_model');
    expect(computeRiskWarnings({ ...base, orchestrated: true, reviewerSameModelAsWriter: false }).map((w) => w.code)).not.toContain('reviewer_same_model');
    expect(computeRiskWarnings({ ...base, orchestrated: true, reviewerSameModelAsWriter: null }).map((w) => w.code)).not.toContain('reviewer_same_model');
    expect(computeRiskWarnings({ ...base, orchestrated: false, reviewerSameModelAsWriter: true }).map((w) => w.code)).not.toContain('reviewer_same_model');
  });

  it('pool_capacity_high：N+M 超过阈值（默认 8）时触发', () => {
    expect(computeRiskWarnings({ ...base, totalCapacity: 9 }).map((w) => w.code)).toContain('pool_capacity_high');
    expect(computeRiskWarnings({ ...base, totalCapacity: 8 }).map((w) => w.code)).not.toContain('pool_capacity_high');
    expect(POOL_CAPACITY_WARN_THRESHOLD).toBe(8);
  });

  it('告警沿用 KbBuildWarning 结构（code/count/message）', () => {
    const warnings = computeRiskWarnings({ ...base, orchestrated: true, reviewerSameModelAsWriter: true, totalCapacity: 14 });
    for (const warning of warnings) {
      expect(typeof warning.code).toBe('string');
      expect(warning.count).toBe(1);
      expect(warning.message.length).toBeGreaterThan(0);
    }
  });
});

describe('build-metrics：sameProviderModel', () => {
  it('provider+model 全等才为 true；任一缺失返回 null', () => {
    expect(sameProviderModel({ modelId: 'm1', providerId: 'p1' }, { modelId: 'm1', providerId: 'p1' })).toBe(true);
    expect(sameProviderModel({ modelId: 'm1', providerId: 'p1' }, { modelId: 'm1', providerId: 'p2' })).toBe(false);
    expect(sameProviderModel({ modelId: 'm1' }, { modelId: 'm1' })).toBe(true); // 无 provider 的 pi 模型按空串比
    expect(sameProviderModel(null, { modelId: 'm1' })).toBeNull();
    expect(sameProviderModel({ modelId: 'm1' }, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. 进程池 build 通道等待统计（不改准入语义）
// ---------------------------------------------------------------------------

describe('AgentProcessPool：build 通道 acquire 等待毫秒记录', () => {
  it('满额排队→释放晋升记录等待；立即授予不计入；可重置', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, buildConcurrency: 1 });
    const first = await pool.acquire('build');
    expect(pool.buildAcquireWaitStats()).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    // 第二个 acquire 满额排队
    const secondPromise = pool.acquire('build');
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(pool.buildQueueDepth()).toBe(1);
    expect(pool.buildAcquireWaitStats().count).toBe(0); // 未授予前不产生样本
    first.release();
    const second = await secondPromise;
    const stats = pool.buildAcquireWaitStats();
    expect(stats.count).toBe(1);
    expect(stats.totalMs).toBeGreaterThanOrEqual(10);
    expect(stats.maxMs).toBe(stats.totalMs);
    // 取消路径不产生样本（未授予）
    pool.resetBuildAcquireWaitStats();
    expect(pool.buildAcquireWaitStats()).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    second.release();
    await pool.closeAll();
  });

  it('取消出队的等待者不计入统计', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, buildConcurrency: 1 });
    const first = await pool.acquire('build');
    const controller = new AbortController();
    const queued = pool.acquire('build', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.buildAcquireWaitStats()).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    first.release();
    await pool.closeAll();
  });
});

// ---------------------------------------------------------------------------
// 3. kb_builds.metrics_json additive 迁移 + updateKbBuild 往返
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 无 metrics_json（也无 S4/T2b 列）的历史 kb_builds 表。 */
const LEGACY_KB_BUILDS_DDL = `
  CREATE TABLE kb_builds (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK(mode IN ('incremental', 'full')),
    status TEXT NOT NULL CHECK(status IN ('queued','preflight','running','validating','publishing','published','failed','cancelled','interrupted')),
    base_release_id TEXT,
    release_id TEXT,
    model TEXT,
    source_total INTEGER NOT NULL DEFAULT 0,
    source_added INTEGER NOT NULL DEFAULT 0,
    source_changed INTEGER NOT NULL DEFAULT 0,
    source_removed INTEGER NOT NULL DEFAULT 0,
    docs_written INTEGER NOT NULL DEFAULT 0,
    docs_deleted INTEGER NOT NULL DEFAULT 0,
    no_changes INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
`;

describe('LocalMapStore：kb_builds.metrics_json additive 迁移', () => {
  it('旧库（无 metrics_json）initialize 后补列，旧行保留，updateKbBuild 往返', () => {
    const dir = tempDir('kbm-store-legacy-');
    const dbPath = path.join(dir, 'feishu-sync.db');
    const raw = new Database(dbPath);
    raw.exec(LEGACY_KB_BUILDS_DDL);
    raw.prepare(`INSERT INTO kb_builds (id, mode, status, created_at) VALUES ('b-old', 'full', 'published', '2026-10-01T00:00:00.000Z')`).run();
    raw.close();

    const store = new LocalMapStore(dbPath);
    store.initialize();
    const db = new Database(dbPath);
    const names = ((db.pragma('table_info(kb_builds)') as Array<{ name: string }>).map((c) => c.name));
    expect(names).toContain('metrics_json');
    const oldRow = db.prepare('SELECT id, status FROM kb_builds WHERE id = ?').get('b-old');
    expect(oldRow).toMatchObject({ id: 'b-old', status: 'published' });
    db.close();

    const metrics: KbBuildMetrics = {
      units: { total: 1, perUnit: [{ unitId: 'u1', sources: 2, words: 10, bytes: 20 }], maxWordsShare: 1 },
      phases: [{ unitId: 'u1', role: 'write', round: 1, startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z', ms: 1000 }],
      queueWaits: { count: 1, totalMs: 5, maxMs: 5 },
      review: { blocking: 0, suggestion: 0, revisions: 0 },
      tokenUsage: null,
      reviewerSameModelAsWriter: null,
    };
    store.createKbBuild({ id: 'b-new', mode: 'full', status: 'queued', baseReleaseId: null, model: null, createdAt: '2026-10-02T00:00:00.000Z' });
    store.updateKbBuild('b-new', { metricsJson: JSON.stringify(metrics) });
    const stored = store.getKbBuild('b-new');
    expect(JSON.parse(String(stored!.metrics_json))).toEqual(metrics);
    // 未传 patch 字段不动既有值
    store.updateKbBuild('b-new', { status: 'failed' });
    expect(store.getKbBuild('b-new')!.metrics_json).toBe(JSON.stringify(metrics));
    // 显式 null（采集失败降级）可写回
    store.updateKbBuild('b-new', { metricsJson: null });
    expect(store.getKbBuild('b-new')!.metrics_json).toBeNull();
    store.close();
  });

  it('新库（getCreateTablesDDL）直接含 metrics_json 列', () => {
    const dir = tempDir('kbm-store-fresh-');
    const dbPath = path.join(dir, 'feishu-sync.db');
    const store = new LocalMapStore(dbPath);
    store.initialize();
    const db = new Database(dbPath);
    const names = ((db.pragma('table_info(kb_builds)') as Array<{ name: string }>).map((c) => c.name));
    db.close();
    expect(names).toContain('metrics_json');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// 4./5. 服务层：DTO 兼容 + 端到端 metrics 落库
// ---------------------------------------------------------------------------

const FAT = '规则的详细说明段落，包含定义、流程、边界与示例，用于把原始源体积撑到足以覆盖产出文档的校验阈值。'.repeat(8);

function stubResolver(): PiRuntimeResolver {
  return {
    resolveRuntime: async () => ({ nodePath: '/bin/true', piCliPath: '/bin/true', piPackageRoot: '' }),
    checkReadiness: async () => ({ code: 'ready', message: '', model: { model: 'fake/model', available: [] } }),
  } as unknown as PiRuntimeResolver;
}

/** 最小假 pi：批次写文档、审查提交 pass 报告、整合/收尾调 kb_finish。 */
class FakeRpc extends EventEmitter {
  exited = false;
  private readonly pending: Array<(value: unknown) => void> = [];
  constructor(
    private readonly toolService: AgentToolService,
    private readonly token: string,
    private readonly prompts: string[],
  ) { super(); }
  isExited(): boolean { return this.exited; }
  async start(): Promise<void> {}
  async sendCommand(): Promise<{ success: boolean }> { return { success: true }; }
  async abort(): Promise<void> {
    for (const resolve of this.pending.splice(0)) resolve({ outcome: 'aborted' });
  }
  async terminate(): Promise<void> {
    await this.abort();
    if (!this.exited) { this.exited = true; this.emit('exit'); }
  }
  async prompt(message: string): Promise<unknown> {
    this.prompts.push(message);
    return await new Promise((resolve) => {
      void this.act(message).then(resolve, (error) => resolve({ outcome: 'failed', error: { code: 'fake_script_error', message: String(error) } }));
    });
  }
  private async act(message: string): Promise<unknown> {
    if (message.includes('【单元审查')) {
      const unitId = /【单元审查 (u\d+)】/.exec(message)?.[1] ?? '';
      await this.call('kb_submit_review', {
        unitId, coverage: { sourceRefs: ['tok-any'] }, checkedDimensions: ['事实与数值'],
        issues: [], uncheckedScope: [], conclusion: 'pass',
      });
      return { outcome: 'completed' };
    }
    if (message.includes('【最终复核】')) {
      await this.call('kb_submit_review', {
        coverage: { sourceRefs: ['tok-any'] }, checkedDimensions: ['事实与数值'],
        issues: [], uncheckedScope: [], conclusion: 'pass',
      });
      return { outcome: 'completed' };
    }
    if ((message.includes('【单元') || message.includes('【批次')) && message.includes('请处理以下')) {
      const unitId = /【单元 (u\d+)/.exec(message)?.[1] ?? '';
      const tokens = [...message.matchAll(/^\| (tok\S+) \|/gm)].map((match) => match[1]);
      for (const token of tokens) {
        await this.call('kb_write_doc', {
          path: `主题/${unitId || 'u'}-${token}.md`, title: '规则主题',
          markdown: `规则的完整说明：第一段定义，第二段流程与边界（v1）。${FAT}`,
          sources: [token], summary: '规则主题的概要说明',
        });
      }
      if (unitId) await this.call('kb_unit_done', { summary: `单元 ${unitId} 完成`, skipped: [] });
      return { outcome: 'completed' };
    }
    if (message.includes('kb_finish')) {
      await this.call('kb_finish', { summary: '整体完成（fixture）', skipped: [] });
      return { outcome: 'completed' };
    }
    return { outcome: 'completed' };
  }
  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return await this.toolService.executeTool(this.token, tool, args);
  }
}

describe('KbBuildService：metrics 采集端到端', () => {
  let home: string;
  let previousHome: string | undefined;
  let dataRoot: string;
  let kbRoot: string;
  let outputRoot: string;
  let store: LocalMapStore;
  const documents: DocumentRecord[] = [];
  const prompts: string[] = [];

  function writeRaw(rel: string, content: string): void {
    const full = path.join(kbRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function docRecord(token: string, rel: string): DocumentRecord {
    return {
      wikiNodeToken: null, objType: 'docx', objToken: token, title: token,
      localRelPath: rel, localMdPath: path.join(kbRoot, rel),
      lastSyncedModifyTime: '', lastSyncedAt: new Date().toISOString(), status: 'synced',
    } as DocumentRecord;
  }

  function makeConfig(overrides: { buildRoles?: Config['standardKb']['buildRoles']; parallelism?: number }): Config {
    return {
      llm: {
        openAiCompatBaseUrl: '', apiKey: '', model: '', temperature: 0.2, primaryChannel: 'direct', fallbackOnFailure: false,
        providers: [{
          id: 'pf1', name: 'PF', enabled: true, apiKey: 'sk-fixture',
          openAiCompatBaseUrl: 'https://pf.example/v1', protocol: 'openai-completions',
          models: [{ id: 'same-model', name: 'SM', openAiModel: 'fake-model', enabled: true }],
        }],
      },
      agent: {
        runtime: {},
        model: { source: 'pi-agent-dir', piModel: 'fake/model', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
        vision: { enabled: false, concurrency: 1, maxImageBytes: 5 * 1024 * 1024, maxImagesPerBuild: 10, timeoutMs: 10000 },
        maxConcurrentProcesses: 3, idleTimeoutMinutes: 10, workspaces: [],
      },
      standardKb: {
        outputRoot, retainReleases: 3, buildBatchSize: 10, buildBatchWordBudget: 0,
        promptTimeoutMinutes: 15, buildTimeoutMinutes: 30,
        buildParallelism: overrides.parallelism ?? 1, autoBuildAfterSync: false,
        buildRoles: overrides.buildRoles,
        reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
        publishMode: 'auto',
      },
      pollIntervalMinutes: 30,
      knowledgeBaseRoot: kbRoot,
      watchedRoots: [], watchedRootUrls: [], requiredScopes: [],
    } as unknown as Config;
  }

  function makeService(config: Config): { service: KbBuildService; pool: AgentProcessPool; close: () => Promise<void> } {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, idleTimeoutMinutes: 10 });
    const toolService = new AgentToolService({ dataRoot, documentsProvider: () => documents, sheetCsvPaths: () => [] });
    const service = new KbBuildService({
      dataRoot, pool, toolService, resolver: stubResolver(),
      configProvider: () => config, documentsProvider: () => documents,
      excludedSourcesProvider: () => [], sheetCsvPaths: () => [],
      internalBaseUrl: () => 'http://127.0.0.1:39999', extensionPath: () => null,
      promptAssets: () => null,
      processFactory: (options) => new FakeRpc(toolService, String(options.env.FEISHU_SYNC_AGENT_RUN_TOKEN ?? ''), prompts) as unknown as PiRpcProcess,
    });
    return { service, pool, close: async () => { await pool.closeAll(); } };
  }

  async function waitForTerminal(buildId: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = store.getKbBuild(buildId);
      if (row && !['queued', 'preflight', 'running', 'validating', 'publishing', 'awaiting_release'].includes(String(row.status))) return row;
      if (Date.now() > deadline) throw new Error(`构建未进入终态: ${row ? row.status : 'missing'} ${row ? String(row.error_message) : ''}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  beforeAll(() => {
    home = tempDir('kbm-home-');
    previousHome = process.env.FEISHU_SYNC_HOME;
    process.env.FEISHU_SYNC_HOME = home;
    dataRoot = tempDir('kbm-data-');
    kbRoot = tempDir('kbm-kb-');
    outputRoot = path.join(dataRoot, 'standard-kb');
    fs.mkdirSync(path.join(dataRoot, 'agent'), { recursive: true });
    store = new LocalMapStore(path.join(dataRoot, 'feishu-sync.db'));
    store.initialize();
  });

  afterAll(() => {
    store.close();
    if (previousHome === undefined) delete process.env.FEISHU_SYNC_HOME;
    else process.env.FEISHU_SYNC_HOME = previousHome;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('toDto：metrics 可选——无列为 undefined，有列则透传（向后兼容）', () => {
    const { service, close } = makeService(makeConfig({}));
    const row = { id: 'b-dto', mode: 'full', status: 'published', no_changes: 0, created_at: '2026-10-01T00:00:00.000Z', parallelism: 1 };
    const plain = service.toDto(row as Record<string, unknown>);
    expect('metrics' in plain).toBe(false);
    const metrics: KbBuildMetrics = {
      units: { total: 0, perUnit: [], maxWordsShare: null }, phases: [],
      queueWaits: { count: 0, totalMs: 0, maxMs: 0 }, review: { blocking: 0, suggestion: 0, revisions: 0 },
      tokenUsage: null, reviewerSameModelAsWriter: null,
    };
    const withMetrics = service.toDto({ ...row, metrics_json: JSON.stringify(metrics) } as Record<string, unknown>);
    expect(withMetrics.metrics).toEqual(metrics);
    // 损坏 JSON → null 不抛错
    const corrupt = service.toDto({ ...row, metrics_json: '{broken' } as Record<string, unknown>);
    expect('metrics' in corrupt).toBe(false);
    void close();
  });

  it('编排流水：finish 落 metrics_json（phases 覆盖 write/review/integrate/final）+ reviewer_same_model 告警', async () => {
    documents.length = 0;
    writeRaw('A/a.md', `a ${FAT}`);
    documents.push(docRecord('tokA', 'A/a.md'));
    // writer 与 reviewer 显式同 provider+model → orchestrated + 同源告警
    const roles = { writer: { modelPresetId: 'same-model', providerId: 'pf1' }, reviewer: { modelPresetId: 'same-model', providerId: 'pf1' }, plannerEnabled: false };
    const { service, close } = makeService(makeConfig({ buildRoles: roles, parallelism: 2 }));
    const dto = await service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status), String(row.error_message)).toBe('published');

    const metrics = JSON.parse(String(row.metrics_json)) as KbBuildMetrics;
    expect(metrics.units.total).toBe(1);
    expect(metrics.units.perUnit[0]).toMatchObject({ unitId: expect.stringMatching(/^u/), sources: 1 });
    expect(metrics.units.maxWordsShare).toBeNull(); // buildBatchWordBudget=0 → words 未统计
    const rolesSeen = metrics.phases.map((phase) => phase.role);
    for (const role of ['write', 'review', 'integrate', 'final']) expect(rolesSeen).toContain(role);
    for (const phase of metrics.phases) {
      expect(phase.ms).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(Date.parse(phase.startedAt))).toBe(true);
      expect(Number.isFinite(Date.parse(phase.finishedAt))).toBe(true);
    }
    expect(metrics.review).toEqual({ blocking: 0, suggestion: 0, revisions: 0 });
    expect(metrics.tokenUsage).toBeNull();
    expect(metrics.reviewerSameModelAsWriter).toBe(true);
    expect(typeof metrics.queueWaits.count).toBe('number');
    // S2 告警：同源审查（单 worker 并行无从退化 / N+M=5 未超限 → 无另两类）
    const warnings = JSON.parse(String(row.warnings_json)) as Array<{ code: string }>;
    expect(warnings.map((w) => w.code)).toContain('reviewer_same_model');
    expect(warnings.map((w) => w.code)).not.toContain('oversized_unit');
    expect(warnings.map((w) => w.code)).not.toContain('pool_capacity_high');
    // DTO 透出 metrics
    const listDto = service.toDto(store.getKbBuild(dto.id)!);
    expect(listDto.metrics).toEqual(metrics);
    await close();
  });

  it('单进程流水（legacy）：finish 同样落 metrics_json（write 批次 + final）且无告警', async () => {
    documents.length = 0;
    prompts.length = 0;
    writeRaw('B/b.md', `b ${FAT}`);
    documents.push(docRecord('tokB', 'B/b.md'));
    const { service, close } = makeService(makeConfig({ parallelism: 1 }));
    const dto = await service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status), String(row.error_message)).toBe('published');

    const metrics = JSON.parse(String(row.metrics_json)) as KbBuildMetrics;
    expect(metrics.units.total).toBe(0); // 单进程路径无单元语义
    const roles = metrics.phases.map((phase) => phase.role);
    expect(roles).toContain('write'); // 批次（round=1）
    expect(roles).toContain('final');  // kb_finish 收尾轮
    expect(metrics.phases.find((phase) => phase.role === 'write')?.round).toBe(1);
    // legacy 也冻结 resolvedRoles：writer/reviewer 都跟随活跃模型 → 同源为
    // true（指标如实记录；reviewer_same_model 告警仅 orchestrated 才发）
    expect(metrics.reviewerSameModelAsWriter).toBe(true);
    const warnings = JSON.parse(String(row.warnings_json ?? '[]')) as Array<{ code: string }>;
    expect(warnings.map((w) => w.code)).not.toContain('reviewer_same_model');
    await close();
  });
});
