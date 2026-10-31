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

import type { KbBuildMetrics, KbBuildMetricsPhaseRole, KbBuildWarning, KbBuildMetricsPrecheck } from '../types/agent-knowledge.js';

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
