/**
 * BuildMetricsPanel —— 构建度量只读面板（S1/S2/WP-F）
 *
 * 数据源：构建 DTO 的 metrics.orchestration 段（kb_builds.metrics_json，
 * 构建收口时由服务端写入并透传）+ warnings_json 中的 S2 风险告警。
 * 展示契约对齐 docs/build-operations.md §3 字段表与
 * server/scripts/build-metrics-report.ts 的输出口径：
 * - 字段缺失/null 一律显示「—」或「采集不可得」，绝不把 null 冒充 0
 *   （R5-02：不可得 ≠ 真实空；真实 0 如实显示 0）。
 * - 无 orchestration 段（旧采集或非 pi-amagi 构建）→ 降级说明行。
 * 只读：本面板不发起任何请求，全部内容来自父层传入的构建 DTO。
 */

import { AlertTriangle, Gauge } from 'lucide-react';
import type { KbBuildDto } from '../../types/agent';

interface BuildMetricsPanelProps {
  build: KbBuildDto;
}

/** S2 风险告警 code → 中文主题（详情文案用 DTO 自带 message）。 */
const METRICS_RISK_WARNING_LABEL: Record<string, string> = {
  oversized_unit: '最大单元占比过高',
  reviewer_same_model: '审查与撰写同模型',
  pool_capacity_high: '进程总容量偏高',
};

/** 耗时友好格式（与 server build-metrics-report.ts fmtMs 同口径：54m20s / 1h05m20s）。 */
export function formatMetricsDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** 首审通过率（0-1 小数 → 百分比；null 不冒充 0%）。 */
function formatPassRate(rate: number | null): string {
  if (rate === null) return '—';
  const pct = rate * 100;
  return `${Number.isInteger(pct) ? pct : Math.round(pct * 10) / 10}%`;
}

/** 拒绝计数 → 「原因 ×次数」降序列表（并列按原因名稳定排序）。 */
function topReasons(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.map(([reason, count]) => `${reason} ×${count}`).join('，');
}

/** 并发推导口径说明（server pool.derivation 的三态）。 */
const POOL_DERIVATION_LABEL: Record<string, string> = {
  'journal-session': '口径：journal 会话区间（session→settle）',
  'actor-events': '口径：账本事件近似（含排队间隙）',
  none: '口径：无来源，未推导',
};

export function BuildMetricsPanel({ build }: BuildMetricsPanelProps) {
  const orch = build.metrics?.orchestration;

  // 无 orchestration 段：旧采集或非 pi-amagi 构建（含 legacy 流水的 S1 度量）。
  if (!orch) {
    return (
      <div className="shrink-0 border-b border-line/60 px-4 py-2" data-testid="kb-build-metrics-empty">
        <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <Gauge className="w-3.5 h-3.5 shrink-0" />
          构建度量：该构建无编排度量（旧采集或非 pi-amagi）。
        </p>
      </div>
    );
  }

  const riskWarnings = build.warnings.filter((warning) => warning.code in METRICS_RISK_WARNING_LABEL);
  const rounds = orch.revisionRounds;
  const draft = orch.firstDraftToPublish;

  return (
    <section
      className="shrink-0 border-b border-line/60 px-4 py-2.5 space-y-1.5"
      aria-label="构建度量"
      data-testid="kb-build-metrics"
    >
      <h4 className="flex items-center gap-1.5 text-xs font-kai font-medium text-ink">
        <Gauge className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
        构建度量
        <span className="text-[10px] font-sans-ui font-normal text-ink-faint">收口时采集，只读</span>
      </h4>

      {/* 墙钟 / 产出 / 工作集 */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]" data-testid="kb-metrics-overview">
        <span className="text-ink-soft" data-testid="kb-metrics-wallclock">
          墙钟 <b className="font-mono text-ink">{formatMetricsDuration(orch.wallClockMs)}</b>
        </span>
        <span className="text-ink-soft" data-testid="kb-metrics-docs">
          产出文档 <b className="font-mono text-ink">{orch.docsPublished}</b> 篇
        </span>
        <span className="text-ink-soft" data-testid="kb-metrics-sources">
          工作集源 <b className="font-mono text-ink">{orch.sourcesTotal}</b> 篇
        </span>
      </div>

      {/* 按角色派发次数（null = actors.json 不可得） */}
      <p className="text-[11px] text-ink-soft" data-testid="kb-metrics-dispatches">
        派发（作者/审查/调研）
        <b className="ml-1 font-mono text-ink">{formatCount(orch.authorDispatches)}</b>
        {' / '}
        <b className="font-mono text-ink">{formatCount(orch.reviewDispatches)}</b>
        {' / '}
        <b className="font-mono text-ink">{formatCount(orch.researchDispatches)}</b>
      </p>

      {/* 审查轮数与首审通过率（null = reviews.json 不可得） */}
      <p className="text-[11px] text-ink-soft" data-testid="kb-metrics-review-rounds">
        审查轮数（中位数/最大）
        <b className="ml-1 font-mono text-ink">
          {rounds ? `${rounds.roundsMedian ?? '—'} / ${rounds.roundsMax ?? '—'}` : '采集不可得'}
        </b>
        <span className="ml-2">首审通过率</span>
        <b className="ml-1 font-mono text-ink" data-testid="kb-metrics-first-pass">
          {rounds ? formatPassRate(rounds.firstPassRate) : '采集不可得'}
        </b>
        {rounds && rounds.docsReviewed > 0 ? (
          <span className="ml-1.5 text-ink-faint" title="每篇文档首审（最早回执）结论计数">
            （pass {rounds.firstVerdicts.pass} / 需修订 {rounds.firstVerdicts.needs_revision} / 材料不足 {rounds.firstVerdicts.insufficient_material} / 失败 {rounds.firstVerdicts.fail}，共 {rounds.docsReviewed} 篇）
          </span>
        ) : null}
      </p>

      {/* 发布拒绝 / 派发拒绝 Top 原因×次数 */}
      <p className="text-[11px] text-ink-soft" data-testid="kb-metrics-publish-rejections">
        发布拒绝
        <b className="ml-1 font-mono text-ink">{formatRejections(orch.publishRejections)}</b>
      </p>
      <p className="text-[11px] text-ink-soft" data-testid="kb-metrics-dispatch-rejections">
        派发拒绝
        <b className="ml-1 font-mono text-ink">
          {orch.dispatchRejections === undefined ? '采集不可得' : formatRejections(orch.dispatchRejections)}
        </b>
        {orch.dispatchRejections === undefined ? (
          <span className="ml-1.5 text-ink-faint">（WP-F 之前的构建无派发拒绝审计文件）</span>
        ) : null}
      </p>

      {/* 并发 peak/avg（标注推导口径） */}
      <p className="text-[11px] text-ink-soft" data-testid="kb-metrics-pool">
        运行并发 peak/avg
        <b className="ml-1 font-mono text-ink">{formatConcurrency(orch.pool.peakInflight, orch.pool.avgInflight)}</b>
        <span className="ml-1.5 text-ink-faint">{POOL_DERIVATION_LABEL[orch.pool.derivation] ?? orch.pool.derivation}</span>
        {orch.pool.submittedPeakInflight !== undefined || orch.pool.submittedAvgInflight !== undefined ? (
          <span className="ml-2" title="派发在途（dispatch→最终 settle，含排队与待修订间隙）并发——排队深度的直接度量">
            在途（含排队）peak/avg
            <b className="ml-1 font-mono text-ink">
              {formatConcurrency(orch.pool.submittedPeakInflight ?? null, orch.pool.submittedAvgInflight ?? null)}
            </b>
          </span>
        ) : null}
      </p>

      {/* 首稿→发布耗时分布（p50/p90/max；未发布或回执不可得时整体省略） */}
      <p className="text-[11px] text-ink-soft" data-testid="kb-metrics-first-draft">
        首稿→发布
        {draft ? (
          <>
            <b className="ml-1 font-mono text-ink">{draft.count}</b> 篇
            <span className="ml-1.5 font-mono">
              p50 {draft.count > 0 ? formatMetricsDuration(draft.p50Ms) : '—'}
              {' · '}p90 {draft.count > 0 ? formatMetricsDuration(draft.p90Ms) : '—'}
              {' · '}max {draft.count > 0 ? formatMetricsDuration(draft.maxMs) : '—'}
            </span>
          </>
        ) : (
          <b className="ml-1 font-mono text-ink">—</b>
        )}
        {!draft ? <span className="ml-1.5 text-ink-faint">（未发布或回执不可得）</span> : null}
      </p>

      {/* S2 风险告警（warnings_json；均不阻断构建） */}
      {riskWarnings.length > 0 ? (
        <div className="space-y-0.5" data-testid="kb-metrics-warnings">
          {riskWarnings.map((warning, i) => (
            <p key={`${warning.code}-${i}`} className="flex items-start gap-1.5 text-[11px] text-seal leading-snug" data-warning-code={warning.code}>
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                <span className="font-medium">{METRICS_RISK_WARNING_LABEL[warning.code] ?? warning.code}：</span>
                {warning.message}
              </span>
            </p>
          ))}
        </div>
      ) : null}

      {/* 口径说明（notes：哪些来源缺失/损坏、哪些字段因此不可推导） */}
      {orch.notes && orch.notes.length > 0 ? (
        <details className="text-[10px] text-ink-faint" data-testid="kb-metrics-notes">
          <summary className="cursor-pointer select-none hover:text-ink-soft">口径说明（{orch.notes.length} 条）</summary>
          <ul className="mt-1 ml-4 list-disc space-y-0.5 leading-snug">
            {orch.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** 计数展示：null = 来源不可得（不冒充 0）。 */
function formatCount(value: number | null): string {
  return value === null ? '采集不可得' : String(value);
}

/** 并发二元组：peak null → 「—」；avg null → 只给 peak（口径见 notes）。 */
function formatConcurrency(peak: number | null, avg: number | null): string {
  if (peak === null) return '—';
  return avg === null ? `${peak} / —` : `${peak} / ${avg}`;
}

/** 拒绝计数：null = 不可得；空对象 = 真实无拒绝。 */
function formatRejections(counts: Record<string, number> | null): string {
  if (counts === null) return '采集不可得';
  const entries = Object.entries(counts);
  if (entries.length === 0) return '无';
  return topReasons(counts);
}
