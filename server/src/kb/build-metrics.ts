/**
 * build-metrics — 构建度量聚合与风险告警（构建编排优化方案 §3 S1/S2）
 *
 * 纯函数模块：无 IO、无 SQLite、不依赖运行时状态。输入由
 * kb-build-service 在构建期采集（emit 挂点 + 进程池等待统计），输出
 * 直接落 kb_builds.metrics_json / 并入 warnings_json。任何采集/聚合失败
 * 由调用方 try/catch 降级为 null，不影响构建语义。
 *
 * 口径说明：
 * - words 仅在 buildBatchWordBudget > 0 时统计（P2-S2 有效字数）；预算
 *   关闭（旧配置/测试夹具）时 words 全 0，占比不可计算 → maxWordsShare
 *   为 null、oversized_unit 不告警（不退回 bytes 口径，避免口径漂移）。
 * - queueWaits 只统计真正入队等待的 acquire（立即授予不计入）。
 * - tokenUsage 当前恒为 null：运行时事件不携带用量（事实清单 Q2），
 *   在出现真实来源之前不得填入估计值。
 */

import type { KbBuildMetrics, KbBuildMetricsOrchestration, KbBuildMetricsPhaseRole, KbBuildWarning, KbBuildMetricsPrecheck } from '../types/agent-knowledge.js';

/** S2：最大单元 words 占比告警阈值（≥ 即并行度可能退化）。 */
export const OVERSIZED_UNIT_SHARE_THRESHOLD = 0.5;

/** S2：进程总容量（N+M）告警阈值（超过即提示资源风险）。 */
export const POOL_CAPACITY_WARN_THRESHOLD = 8;

/** phases 记录上限（防御性：异常巨构不把 metrics_json 撑爆；正常构建
 * 单元×轮次远低于此）。 */
export const METRICS_PHASES_CAP = 2000;

/** 单元规模输入（与 KbBuildMetricsUnit 同形，聚合前形态）。 */
export interface BuildMetricsUnitSize {
  unitId: string;
  sources: number;
  words: number;
  bytes: number;
}

/** 阶段起止输入（ms 由聚合函数计算，采集端不重复实现口径）。 */
export interface BuildMetricsPhaseSpan {
  unitId: string | null;
  role: KbBuildMetricsPhaseRole;
  round: number;
  startedAt: string;
  finishedAt: string;
}

/** 阶段时长：ISO 起止差；非法/缺失时间戳按 0（不抛错、不产生 NaN）。 */
function spanMs(span: BuildMetricsPhaseSpan): number {
  const started = Date.parse(span.startedAt);
  const finished = Date.parse(span.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

/**
 * 聚合构建度量（S1）。输入均为构建期已采集的原始记录；输出即
 * metrics_json 的对象形状。
 */
export function aggregateBuildMetrics(input: {
  units: ReadonlyArray<BuildMetricsUnitSize>;
  phaseSpans: ReadonlyArray<BuildMetricsPhaseSpan>;
  /** 采集端达到 METRICS_PHASES_CAP 已丢弃的条数（Minor-2：与聚合侧截断
   * 丢弃数求和后暴露为 phasesDropped；未截断不带键，旧 metrics 兼容） */
  phasesDropped?: number;
  queueWaits: { count: number; totalMs: number; maxMs: number };
  review: { blocking: number; suggestion: number; revisions: number };
  reviewerSameModelAsWriter: boolean | null;
  /** S3 切片 C：机械预检发现计数（每审查主体一条）。可选：开关关闭时
   * 不传/空数组 → 输出形状与旧版完全一致（不带 precheck 键）。 */
  precheck?: ReadonlyArray<KbBuildMetricsPrecheck>;
}): KbBuildMetrics {
  const perUnit = input.units.map((unit) => ({
    unitId: unit.unitId,
    sources: unit.sources,
    words: unit.words,
    bytes: unit.bytes,
  }));
  const totalWords = perUnit.reduce((sum, unit) => sum + unit.words, 0);
  const maxWords = perUnit.reduce((max, unit) => Math.max(max, unit.words), 0);
  const maxWordsShare = totalWords > 0 ? Math.round((maxWords / totalWords) * 10000) / 10000 : null;
  const phases = input.phaseSpans.slice(0, METRICS_PHASES_CAP).map((span) => ({
    unitId: span.unitId,
    role: span.role,
    round: span.round,
    startedAt: span.startedAt,
    finishedAt: span.finishedAt,
    ms: spanMs(span),
  }));
  // Minor-2：采集端 + 聚合侧两段截断的丢弃总数；为 0 不带键（旧形状不变）
  const phasesDropped = Math.max(0, input.phaseSpans.length - METRICS_PHASES_CAP)
    + Math.max(0, input.phasesDropped ?? 0);
  return {
    units: { total: perUnit.length, perUnit, maxWordsShare },
    phases,
    queueWaits: {
      count: input.queueWaits.count,
      totalMs: input.queueWaits.totalMs,
      maxMs: input.queueWaits.maxMs,
    },
    review: {
      blocking: input.review.blocking,
      suggestion: input.review.suggestion,
      revisions: input.review.revisions,
    },
    // 运行时事件当前不携带用量：如实为 null，有真实来源后再接入。
    tokenUsage: null,
    reviewerSameModelAsWriter: input.reviewerSameModelAsWriter,
    // S3 切片 C：空/未采集不带键（旧 metrics_json 形状不变）
    ...(input.precheck && input.precheck.length > 0 ? { precheck: [...input.precheck] } : {}),
    ...(phasesDropped > 0 ? { phasesDropped } : {}),
  };
}

/**
 * S2 风险告警（三类，均不阻断构建，沿用 KbBuildWarning 结构）：
 * - oversized_unit：最大单元 words 占比 ≥ 50% 且 workerCount > 1
 *   （LPT 排序下大单元先启动，但其余 worker 可能长期空转）。
 * - reviewer_same_model：orchestrated 流水下 writer 与 reviewer 同
 *   provider+model（独立审查效力减弱的自审盲区）。
 * - pool_capacity_high：构建 N + 非构建 M 合计超过阈值（默认 8）。
 */
export function computeRiskWarnings(input: {
  units: ReadonlyArray<{ unitId: string; words: number }>;
  workerCount: number;
  orchestrated: boolean;
  reviewerSameModelAsWriter: boolean | null;
  totalCapacity: number;
}): KbBuildWarning[] {
  const warnings: KbBuildWarning[] = [];
  const totalWords = input.units.reduce((sum, unit) => sum + unit.words, 0);
  if (input.units.length > 0 && totalWords > 0 && input.workerCount > 1) {
    const maxWords = input.units.reduce((max, unit) => Math.max(max, unit.words), 0);
    const share = maxWords / totalWords;
    if (share >= OVERSIZED_UNIT_SHARE_THRESHOLD) {
      warnings.push({
        code: 'oversized_unit',
        count: 1,
        message: `最大单元占工作集有效字数 ${Math.round(share * 100)}%（并行 ${input.workerCount} 路），其余 worker 可能长期空转、并行度退化为单路；建议检查单元划分或调整构建范围`,
      });
    }
  }
  if (input.orchestrated && input.reviewerSameModelAsWriter === true) {
    warnings.push({
      code: 'reviewer_same_model',
      count: 1,
      message: '审查者与撰写者解析为相同 provider+model，独立审查的自审盲区风险（同模型同偏见）；建议为 reviewer 配置不同模型预设',
    });
  }
  if (input.totalCapacity > POOL_CAPACITY_WARN_THRESHOLD) {
    warnings.push({
      code: 'pool_capacity_high',
      count: 1,
      message: `进程总容量 N+M=${input.totalCapacity} 超过 ${POOL_CAPACITY_WARN_THRESHOLD}（构建 N 路与非构建 M 路可同时存活的进程上限），低内存机器可能超出预期；请检查 buildConcurrency 与 maxConcurrentProcesses 配置`,
    });
  }
  return warnings;
}

/**
 * writer/reviewer 是否解析为同一 provider+model。任一侧缺失（无冻结
 * resolvedRoles、claude-code 基座、预设不可解析）返回 null = 无法判定，
 * 不猜测。
 */
export function sameProviderModel(
  a: { modelId: string; providerId?: string } | null | undefined,
  b: { modelId: string; providerId?: string } | null | undefined,
): boolean | null {
  if (!a || !b) return null;
  return a.modelId === b.modelId && (a.providerId ?? '') === (b.providerId ?? '');
}

// ============================================================================
// WP-F（kb-build-speedup）：pi-amagi 编排构建度量聚合（纯函数）
//
// 输入为已从权威落盘记录读出的原始事实（毫秒时间戳已解析、目录已扫）；
// 磁盘读取在 kb-build-service 的 collectLeaderOrchestrationMetricsFromDisk。
// 口径约束：无法推导的字段省略/置 null 并写入 notes，禁止编造。
// ============================================================================

/**
 * WP-F（R5-02）：单来源文件的读取结果三态——ok（存在且解析成功，
 * records 可为真实空数组=0/无）/ missing（文件不存在）/ corrupt（存在但
 * 内容不可解析）。不可得绝不冒充 0：对应指标置 null/省略并写入 notes。
 */
export type LeaderSource<T> =
  | { status: 'ok'; records: T[] }
  | { status: 'missing' | 'corrupt'; file: string };

function sourceOk<T>(source: LeaderSource<T>): source is { status: 'ok'; records: T[] } {
  return source.status === 'ok';
}

function sourceGapWord(status: 'missing' | 'corrupt'): string {
  return status === 'missing' ? '缺失' : '损坏';
}

/** WP-F：聚合输入（原始事实；各来源携带三态可用性）。 */
export interface LeaderOrchestrationSources {
  /** kb_builds.started_at / finished_at（null=缺失）；collectedAt=采集时刻 */
  startedAtMs: number | null;
  finishedAtMs: number | null;
  collectedAtMs: number;
  docsWritten: number;
  sourcesTotal: number;
  /** build-actors/actors.json（全代次；只关注 role） */
  actors: LeaderSource<{ role: string }>;
  /** build-actors/reviews.json（scopePaths 缺省的旧回执单独计数） */
  reviews: LeaderSource<{ scopePaths?: string[] | null; verdict: string; createdAtMs: number }>;
  /** 无 scopePaths 的旧审查回执条数（不计入每篇口径；仅 reviews ok 时有意义） */
  legacyUnscopedReviews: number;
  /** build-actors/receipts.json 中 write_doc/edit_doc 的每篇最早回执毫秒 */
  firstDrafts: LeaderSource<{ path: string; atMs: number }>;
  /** 发布结算时刻（publish_settled 事件 / accepted settledAt / published 行
   * finished_at）；未到达发布 → null */
  publishSettledAtMs: number | null;
  /** publish-requests.json 中 status=rejected 的 reason 列表 */
  rejectedPublishReasons: LeaderSource<string>;
  /** dispatch-rejections.jsonl 的 code 列表 */
  dispatchRejectionCodes: LeaderSource<string>;
  /** amagi dispatch journal（dispatch.jsonl，跨 epoch 合并后的可用性） */
  journal: { status: 'ok' | 'missing' | 'corrupt'; /** ok 但有派发无 session 事件（运行区间不可推导） */ hasDispatchWithoutSessions: boolean };
  /** 账本 events.jsonl 可用性（actor-events 回退与 publish_settled 扫描） */
  ledgerEvents: { status: 'ok' | 'missing' | 'corrupt' };
  /** 运行并发区间（session 起跑→同任务下一次 settle）；null = 无区间来源 */
  runningIntervals: ReadonlyArray<{ startMs: number; endMs: number | null }> | null;
  /** 区间推导口径（与 runningIntervals 配套） */
  runningDerivation: 'journal-session' | 'actor-events' | 'none';
  /** 无 settle/handoff 终点的运行区间数（按窗口末端截断） */
  runningUnterminated: number;
  /** 派发在途区间（dispatch→最终 settle，含排队；仅 journal 可得）。
   * null = 无 journal，省略 submitted* 字段。 */
  submittedIntervals: ReadonlyArray<{ startMs: number; endMs: number | null }> | null;
  /** 无最终 settle 的在途区间数（按窗口末端截断） */
  submittedUnterminated: number;
}

/** nearest-rank 百分位（p∈(0,1]；升序数组；空数组 → null）。 */
function percentileNearestRank(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sortedAsc.length));
  return sortedAsc[rank - 1];
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
}

function countByCode(codes: ReadonlyArray<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of [...codes].sort()) counts[code] = (counts[code] ?? 0) + 1;
  return counts;
}

/** 区间序列→（peak，时间加权 avg）。空区间=真实零并发（peak 0，avg 无窗口
 * 不可推导 → null）；零窗口 → avg=null。 */
function sweepConcurrency(intervals: ReadonlyArray<{ startMs: number; endMs: number | null }>): {
  peak: number | null;
  avg: number | null;
} {
  if (intervals.length === 0) return { peak: 0, avg: null };
  const windowStart = Math.min(...intervals.map((span) => span.startMs));
  const ends = intervals.map((span) => span.endMs).filter((end): end is number => end !== null);
  const windowEnd = ends.length > 0 ? Math.max(...ends) : windowStart;
  const sweep: Array<{ atMs: number; delta: number }> = [];
  for (const span of intervals) {
    sweep.push({ atMs: span.startMs, delta: 1 });
    sweep.push({ atMs: span.endMs ?? windowEnd, delta: -1 });
  }
  sweep.sort((a, b) => a.atMs - b.atMs || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  let area = 0;
  let lastAt = windowStart;
  for (const point of sweep) {
    area += current * (point.atMs - lastAt);
    lastAt = point.atMs;
    current += point.delta;
    if (current > peak) peak = current;
  }
  const windowMs = windowEnd - windowStart;
  return { peak, avg: windowMs > 0 ? Math.round((area / windowMs) * 100) / 100 : null };
}

/**
 * 聚合 pi-amagi 编排度量（WP-F）。所有输入均为权威记录事实；返回 null
 * 表示任何来源都不可得（调用方应省略 orchestration 键，而不是写空壳）。
 */
export function aggregateLeaderOrchestrationMetrics(input: LeaderOrchestrationSources): KbBuildMetricsOrchestration | null {
  const notes: string[] = [];
  // 任何来源可读（含真实空）即产出；全部不可得才返回 null（R5-02：全缺降级
  // null 语义保持，但“可读且为空”不再与“不可得”混淆）。
  const hasAnySource = sourceOk(input.actors) || sourceOk(input.reviews) || sourceOk(input.firstDrafts)
    || sourceOk(input.rejectedPublishReasons) || sourceOk(input.dispatchRejectionCodes)
    || input.runningIntervals !== null;
  if (!hasAnySource) return null;

  // 墙钟：未收口终态（如 interrupted 的 finished_at=null）按采集时刻，注明。
  let wallClockMs = 0;
  if (input.startedAtMs !== null) {
    wallClockMs = Math.max(0, (input.finishedAtMs ?? input.collectedAtMs) - input.startedAtMs);
    if (input.finishedAtMs === null) notes.push('finished_at 为空（未收口终态），墙钟按采集时刻计算');
  } else {
    notes.push('started_at 缺失，wallClockMs 置 0');
  }

  // 派发计数（按角色；未识别角色如实注明）。actors.json 不可得 → 三计数
  // 全部 null（R5-02：不冒充 0）。
  let authorDispatches: number | null = null;
  let reviewDispatches: number | null = null;
  let researchDispatches: number | null = null;
  if (sourceOk(input.actors)) {
    authorDispatches = 0;
    reviewDispatches = 0;
    researchDispatches = 0;
    const unknownRoles = new Map<string, number>();
    for (const actor of input.actors.records) {
      if (actor.role === 'luban') authorDispatches += 1;
      else if (actor.role === 'diting') reviewDispatches += 1;
      else if (actor.role === 'baize') researchDispatches += 1;
      else unknownRoles.set(actor.role, (unknownRoles.get(actor.role) ?? 0) + 1);
    }
    if (unknownRoles.size > 0) {
      notes.push(`未识别角色派发：${[...unknownRoles.entries()].map(([role, count]) => `${role}×${count}`).join(', ')}`);
    }
  } else {
    notes.push(`${input.actors.file}${sourceGapWord(input.actors.status)}，派发计数不可推导`);
  }

  // 每篇审查轮数与首审结论（scopePaths 归组；同刻并列按数组序稳定）。
  // reviews.json 不可得 → 整段 null（不冒充 0 轮/0 通过率）。
  let revisionRounds: KbBuildMetricsOrchestration['revisionRounds'] = null;
  if (sourceOk(input.reviews)) {
    const perDoc = new Map<string, Array<{ atMs: number; verdict: string }>>();
    for (const review of input.reviews.records) {
      const paths = Array.isArray(review.scopePaths) ? review.scopePaths : null;
      if (!paths || paths.length === 0) continue;
      for (const docPath of paths) {
        const list = perDoc.get(docPath) ?? [];
        list.push({ atMs: review.createdAtMs, verdict: review.verdict });
        perDoc.set(docPath, list);
      }
    }
    if (input.legacyUnscopedReviews > 0) {
      notes.push(`${input.legacyUnscopedReviews} 条无 scopePaths 的旧审查回执不计入每篇口径`);
    }
    const roundsPerDoc = [...perDoc.values()].map((list) => list.length);
    const firstVerdicts = { pass: 0, needs_revision: 0, insufficient_material: 0, fail: 0 };
    for (const list of perDoc.values()) {
      const first = [...list].sort((a, b) => a.atMs - b.atMs)[0];
      if (first && first.verdict in firstVerdicts) {
        (firstVerdicts as Record<string, number>)[first.verdict] += 1;
      }
    }
    const docsReviewed = perDoc.size;
    const firstPassCount = firstVerdicts.pass;
    revisionRounds = {
      docsReviewed,
      totalReviews: roundsPerDoc.reduce((sum, count) => sum + count, 0),
      roundsMedian: medianOf(roundsPerDoc),
      roundsMax: roundsPerDoc.length > 0 ? Math.max(...roundsPerDoc) : null,
      firstVerdicts,
      firstPassRate: docsReviewed > 0 ? Math.round((firstPassCount / docsReviewed) * 10000) / 10000 : null,
    };
  } else {
    notes.push(`${input.reviews.file}${sourceGapWord(input.reviews.status)}，审查轮数与首审通过率不可推导`);
  }

  // 发布拒绝：publish-requests.json 不可得 → null（不冒充“无拒绝”）。
  let publishRejections: Record<string, number> | null = null;
  if (sourceOk(input.rejectedPublishReasons)) {
    publishRejections = countByCode(input.rejectedPublishReasons.records.map((reason) => reason || 'unknown'));
  } else {
    notes.push(`${input.rejectedPublishReasons.file}${sourceGapWord(input.rejectedPublishReasons.status)}，发布拒绝计数不可推导`);
  }

  // 模型池并发：运行并发（session→settle）为主口径；在途（含排队）为补充口径
  const running = input.runningIntervals !== null ? sweepConcurrency(input.runningIntervals) : { peak: null, avg: null };
  if (input.runningUnterminated > 0) {
    notes.push(`${input.runningUnterminated} 个运行区间无 settle 终点，按窗口末端截断`);
  }
  const submitted = input.submittedIntervals !== null ? sweepConcurrency(input.submittedIntervals) : null;
  if (submitted && input.submittedUnterminated > 0) {
    notes.push(`${input.submittedUnterminated} 个派发无最终 settle，在途区间按窗口末端截断`);
  }
  if (input.runningDerivation === 'actor-events') {
    // 回退口径只在 journal 不可得时使用；corrupt 与缺失如实区分。
    const journalWord = input.journal.status === 'corrupt' ? '损坏' : '缺失';
    notes.push(`dispatch journal（dispatch.jsonl）${journalWord}，运行并发按账本 actor_confirmed→handoff_submitted 近似（含排队间隙）`);
  } else if (input.runningDerivation === 'none') {
    if (input.journal.status === 'ok' && input.journal.hasDispatchWithoutSessions) {
      notes.push('dispatch journal 有派发记录但无 session 事件（旧版 amagi？），运行并发不可推导');
    } else if (input.journal.status !== 'ok' && input.ledgerEvents.status !== 'ok') {
      notes.push(`dispatch journal（dispatch.jsonl）${sourceGapWord(input.journal.status)}且账本 events.jsonl${sourceGapWord(input.ledgerEvents.status)}，运行并发未推导`);
    } else if (input.journal.status !== 'ok') {
      notes.push(`dispatch journal（dispatch.jsonl）${sourceGapWord(input.journal.status)}且账本无可用身份事件，运行并发未推导`);
    }
  }
  const pool: KbBuildMetricsOrchestration['pool'] = {
    peakInflight: running.peak,
    avgInflight: running.avg,
    derivation: input.runningDerivation,
    ...(submitted !== null ? { submittedPeakInflight: submitted.peak, submittedAvgInflight: submitted.avg } : {}),
  };

  // 每篇首稿→发布结算分布：receipts.json 可读且到达发布才产出（可读且为空
  // = 真实 count 0）；receipts 不可得或未发布 → 省略并注明缺口/原因。
  let firstDraftToPublish: KbBuildMetricsOrchestration['firstDraftToPublish'] | undefined;
  if (input.publishSettledAtMs !== null && sourceOk(input.firstDrafts)) {
    const durations = input.firstDrafts.records
      .map((draft) => Math.max(0, input.publishSettledAtMs! - draft.atMs))
      .sort((a, b) => a - b);
    firstDraftToPublish = {
      count: durations.length,
      p50Ms: percentileNearestRank(durations, 0.5) ?? 0,
      p90Ms: percentileNearestRank(durations, 0.9) ?? 0,
      maxMs: durations[durations.length - 1] ?? 0,
    };
  } else if (input.publishSettledAtMs === null && sourceOk(input.firstDrafts) && input.firstDrafts.records.length > 0) {
    notes.push('未到达发布结算，firstDraftToPublish 省略');
  } else if (input.publishSettledAtMs !== null && !sourceOk(input.firstDrafts)) {
    notes.push(`${input.firstDrafts.file}${sourceGapWord(input.firstDrafts.status)}，首稿→发布分布不可推导`);
  }

  // dispatch 拒绝审计：文件可读才产出（空 = 真实无拒绝）；不可得省略键并注明。
  let dispatchRejections: Record<string, number> | undefined;
  if (sourceOk(input.dispatchRejectionCodes)) {
    dispatchRejections = countByCode(input.dispatchRejectionCodes.records);
  } else if (input.dispatchRejectionCodes.status === 'missing') {
    notes.push(`${input.dispatchRejectionCodes.file}缺失，派发拒绝不可推导（WP-F 之前的构建无此审计文件）`);
  } else {
    notes.push(`${input.dispatchRejectionCodes.file}损坏，派发拒绝不可推导`);
  }

  const metrics: KbBuildMetricsOrchestration = {
    wallClockMs,
    docsPublished: input.docsWritten,
    sourcesTotal: input.sourcesTotal,
    authorDispatches,
    reviewDispatches,
    researchDispatches,
    revisionRounds,
    publishRejections,
    ...(dispatchRejections !== undefined ? { dispatchRejections } : {}),
    pool,
    ...(firstDraftToPublish ? { firstDraftToPublish } : {}),
    ...(notes.length > 0 ? { notes: [...notes] } : {}),
  };
  return metrics;
}
