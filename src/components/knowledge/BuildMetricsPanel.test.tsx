/**
 * BuildMetricsPanel 组件测试 —— jsdom 渲染锚定：
 * 1. 完整 orchestration 数据：墙钟/产出/派发/审查轮数与首审率/拒绝 Top
 *    原因/并发口径/首稿→发布分位/notes/风险告警全部落值。
 * 2. null 字段：不可得一律「—/采集不可得」，绝不冒充 0/无。
 * 3. 无 orchestration 段（旧采集或非 pi-amagi）→ 降级说明行。
 * 4. 空 notes → 口径说明区不渲染。
 *
 * 夹具形状取自 server/tests/build-metrics-pi-amagi.test.ts fullSources()
 * 经 aggregateLeaderOrchestrationMetrics 产出的真实度量（期望值见该用例注释）。
 */

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BuildMetricsPanel } from './BuildMetricsPanel';
import type { KbBuildDto, KbBuildMetrics, KbBuildMetricsOrchestration } from '../../types/agent';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
document.body.appendChild(host);
let root: Root;

beforeEach(() => {
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.appendChild(host);
});

function render(build: KbBuildDto): void {
  act(() => { root.render(<BuildMetricsPanel build={build} />); });
}

function textOf(testId: string): string {
  const el = host.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`element not found: ${testId}`);
  return el.textContent ?? '';
}

function makeBuild(over: Partial<KbBuildDto> = {}): KbBuildDto {
  return {
    id: 'kb-b1',
    mode: 'incremental',
    status: 'published',
    noChanges: false,
    baseReleaseId: null,
    releaseId: 'rel-1',
    model: 'glm-4.7',
    counts: { sourceTotal: 12, added: 3, changed: 0, removed: 0, docsWritten: 3, docsDeleted: 0 },
    progress: {
      batchIndex: 1, batchTotal: 1, stage: null,
      units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 },
      workers: [], images: { total: 0, described: 0, cached: 0, unavailable: 0 },
    },
    parallelism: 2,
    warnings: [],
    error: null,
    createdAt: '2026-11-07T06:00:00Z',
    startedAt: '2026-11-07T06:00:00Z',
    finishedAt: '2026-11-07T06:50:00Z',
    ...over,
  };
}

/** 完整 orchestration 段（server/tests/build-metrics-pi-amagi.test.ts 同形状）。 */
function fullOrchestration(): KbBuildMetricsOrchestration {
  return {
    wallClockMs: 50 * 60_000,
    docsPublished: 3,
    sourcesTotal: 12,
    authorDispatches: 3,
    reviewDispatches: 2,
    researchDispatches: 1,
    revisionRounds: {
      docsReviewed: 3,
      totalReviews: 6,
      roundsMedian: 2,
      roundsMax: 3,
      firstVerdicts: { pass: 1, needs_revision: 2, insufficient_material: 0, fail: 0 },
      firstPassRate: 0.3333,
    },
    publishRejections: { kb_publish_blocked: 1, kb_validation_failed: 1, unknown: 1 },
    dispatchRejections: { dispatch_inflight_write_exhausted: 2, kb_output_owned_by_other_task: 1 },
    pool: {
      peakInflight: 4, avgInflight: 2.05, derivation: 'journal-session',
      submittedPeakInflight: 2, submittedAvgInflight: 1.07,
    },
    firstDraftToPublish: { count: 3, p50Ms: 44 * 60_000, p90Ms: 45 * 60_000, maxMs: 45 * 60_000 },
    notes: [
      '未识别角色派发：custom-x×1',
      '1 条无 scopePaths 的旧审查回执不计入每篇口径',
      '1 个运行区间无 settle 终点，按窗口末端截断',
    ],
  };
}

function metricsOf(orchestration?: KbBuildMetricsOrchestration): KbBuildMetrics {
  return {
    units: { total: 0, perUnit: [], maxWordsShare: null },
    phases: [],
    queueWaits: { count: 0, totalMs: 0, maxMs: 0 },
    review: { blocking: 0, suggestion: 0, revisions: 0 },
    tokenUsage: null,
    reviewerSameModelAsWriter: null,
    ...(orchestration ? { orchestration } : {}),
  };
}

describe('BuildMetricsPanel：完整数据', () => {
  it('墙钟/产出/派发/审查轮数与首审率/拒绝原因/并发口径/首稿→发布/notes/风险告警全部渲染', () => {
    render(makeBuild({
      metrics: metricsOf(fullOrchestration()),
      warnings: [
        { code: 'oversized_unit', count: 1, message: '最大单元占工作集有效字数 60%（并行 2 路）' },
        { code: 'images_unavailable', count: 2, message: '与度量无关的告警不进本面板' },
      ],
    }));

    expect(host.querySelector('[data-testid="kb-build-metrics"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kb-build-metrics-empty"]')).toBeNull();
    // 墙钟 50m → 「50m00s」（与 server fmtMs 同口径）
    expect(textOf('kb-metrics-wallclock')).toContain('50m00s');
    expect(textOf('kb-metrics-docs')).toContain('3');
    expect(textOf('kb-metrics-sources')).toContain('12');
    expect(textOf('kb-metrics-dispatches')).toContain('3 / 2 / 1');
    expect(textOf('kb-metrics-review-rounds')).toContain('2 / 3');
    expect(textOf('kb-metrics-first-pass')).toContain('33.3%');
    expect(textOf('kb-metrics-review-rounds')).toContain('pass 1');
    // 拒绝 Top 原因 ×次数（降序）
    expect(textOf('kb-metrics-publish-rejections')).toContain('kb_publish_blocked ×1');
    expect(textOf('kb-metrics-dispatch-rejections')).toContain('dispatch_inflight_write_exhausted ×2');
    // 并发 peak/avg + 口径标注
    expect(textOf('kb-metrics-pool')).toContain('4 / 2.05');
    expect(textOf('kb-metrics-pool')).toContain('journal 会话区间');
    expect(textOf('kb-metrics-pool')).toContain('2 / 1.07');
    // 首稿→发布分位
    expect(textOf('kb-metrics-first-draft')).toContain('3 篇');
    expect(textOf('kb-metrics-first-draft')).toContain('p50 44m00s');
    expect(textOf('kb-metrics-first-draft')).toContain('p90 45m00s');
    expect(textOf('kb-metrics-first-draft')).toContain('max 45m00s');
    // notes 口径说明
    const notes = host.querySelector('[data-testid="kb-metrics-notes"]');
    expect(notes?.textContent).toContain('未识别角色派发：custom-x×1');
    // 风险告警：只收 S2 三码（images_unavailable 不进面板）
    const warnings = host.querySelector('[data-testid="kb-metrics-warnings"]');
    expect(warnings?.textContent).toContain('最大单元占比过高');
    expect(warnings?.textContent).toContain('最大单元占工作集有效字数 60%');
    expect(warnings?.textContent).not.toContain('images_unavailable');
  });
});

describe('BuildMetricsPanel：null 字段（不可得 ≠ 0）', () => {
  it('派发/审查/发布拒绝 null、派发拒绝省略、并发无来源、首稿分布省略 → 采集不可得/—，不出现冒充值', () => {
    render(makeBuild({
      metrics: metricsOf({
        ...fullOrchestration(),
        authorDispatches: null,
        reviewDispatches: null,
        researchDispatches: null,
        revisionRounds: null,
        publishRejections: null,
        dispatchRejections: undefined,
        pool: { peakInflight: null, avgInflight: null, derivation: 'none' },
        firstDraftToPublish: undefined,
        notes: ['reviews.json缺失，审查轮数与首审通过率不可推导'],
      }),
    }));

    expect(host.querySelector('[data-testid="kb-build-metrics"]')).not.toBeNull();
    expect(textOf('kb-metrics-dispatches')).toContain('采集不可得');
    expect(textOf('kb-metrics-dispatches')).not.toContain('0 / 0 / 0');
    expect(textOf('kb-metrics-review-rounds')).toContain('采集不可得');
    expect(textOf('kb-metrics-first-pass')).toContain('采集不可得');
    expect(textOf('kb-metrics-publish-rejections')).toContain('采集不可得');
    // 派发拒绝键省略 = 不可得（WP-F 前构建），不是「无」（真实零拒绝）
    expect(textOf('kb-metrics-dispatch-rejections')).toContain('采集不可得');
    expect(textOf('kb-metrics-dispatch-rejections')).not.toMatch(/派发拒绝无/);
    expect(textOf('kb-metrics-pool')).toContain('—');
    expect(textOf('kb-metrics-pool')).toContain('无来源');
    expect(textOf('kb-metrics-first-draft')).toContain('—');
    expect(textOf('kb-metrics-first-draft')).toContain('未发布或回执不可得');
  });

  it('真实空（0/无拒绝）如实显示，不写成采集不可得', () => {
    render(makeBuild({
      metrics: metricsOf({
        ...fullOrchestration(),
        authorDispatches: 0,
        reviewDispatches: 0,
        researchDispatches: 0,
        publishRejections: {},
        dispatchRejections: {},
        pool: { peakInflight: 0, avgInflight: null, derivation: 'journal-session' },
        firstDraftToPublish: { count: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 },
      }),
    }));

    expect(textOf('kb-metrics-dispatches')).toContain('0 / 0 / 0');
    expect(textOf('kb-metrics-publish-rejections')).toContain('无');
    expect(textOf('kb-metrics-dispatch-rejections')).toContain('无');
    // count 0 的分位不显示 0s（0 是空数组的哨兵值，非真实耗时）
    expect(textOf('kb-metrics-first-draft')).toContain('0 篇');
    expect(textOf('kb-metrics-first-draft')).not.toContain('0s');
  });
});

describe('BuildMetricsPanel：无 orchestration 段', () => {
  it('metrics 缺省（旧构建无 metrics_json）→ 降级说明行', () => {
    render(makeBuild());
    expect(host.querySelector('[data-testid="kb-build-metrics"]')).toBeNull();
    expect(textOf('kb-build-metrics-empty')).toContain('该构建无编排度量（旧采集或非 pi-amagi）');
  });

  it('metrics 存在但无 orchestration 段（legacy 流水 S1 采集）→ 同样降级', () => {
    render(makeBuild({ metrics: metricsOf() }));
    expect(host.querySelector('[data-testid="kb-build-metrics"]')).toBeNull();
    expect(textOf('kb-build-metrics-empty')).toContain('该构建无编排度量（旧采集或非 pi-amagi）');
  });

  it('metrics 为 null（服务端解析失败/空值缺省）→ 同样降级', () => {
    render(makeBuild({ metrics: null }));
    expect(textOf('kb-build-metrics-empty')).toContain('该构建无编排度量（旧采集或非 pi-amagi）');
  });
});

describe('BuildMetricsPanel：空 notes', () => {
  it('无缺口不带键 → 口径说明区不渲染', () => {
    render(makeBuild({ metrics: metricsOf({ ...fullOrchestration(), notes: undefined }) }));
    expect(host.querySelector('[data-testid="kb-metrics-notes"]')).toBeNull();
  });

  it('空数组同样不渲染', () => {
    render(makeBuild({ metrics: metricsOf({ ...fullOrchestration(), notes: [] }) }));
    expect(host.querySelector('[data-testid="kb-metrics-notes"]')).toBeNull();
  });
});
