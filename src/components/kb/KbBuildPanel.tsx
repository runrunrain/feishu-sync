/**
 * KbBuildPanel —— 构建进度面板（KnowledgeView 底部抽屉 / 侧栏）
 *
 * 数据源：GET /api/kb/builds/:id 轮询 + SSE 事件（§9.2）：
 *   build_status（阶段推进）、build_log（分级日志）、tool（工具调用行）、
 *   assistant_delta（模型说明文字，非文档正文）。
 * S4/S5：构建中面板内追加 2.5s 轻量轮询拉取 progress DTO（units/workers/
 * images 细粒度进度只在运行中变化，DB status 不变时无 build_status 事件；
 * SSE build_worker/build_units 事件由 KnowledgeView 消费面接管，本面板
 * 在自己的写面内用轮询保持实时，父层 SSE 刷新优先于轮询快照）。
 * 失败态：error.code 中文 + 校验 issues 列表 + 「当前发布版本未变化」
 * 明示（原子发布契约 §6.5：任何失败不移动 CURRENT 指针）。
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDot,
  ImageIcon,
  Info,
  Layers,
  Loader2,
  Square,
  Wrench,
} from 'lucide-react';
import { Button } from '../common/Button';
import { getKbBuild } from '../../api/client';
import {
  KB_BUILD_ACTIVE_STEPS,
  KB_BUILD_STAGE_LABEL,
  KB_BUILD_STATUS_LABEL,
  KB_BUILD_WARNING_LABEL,
  KB_BUILD_WORKER_STATE_LABEL,
} from '../../utils/agentReadiness';
import type {
  KbBuildDto,
  KbBuildIssue,
  KbBuildWorkerProgress,
  KbBuildWarning,
} from '../../types/agent';

export interface BuildLogLine {
  id: number;
  kind: 'info' | 'warn' | 'error' | 'tool-start' | 'tool-end' | 'assistant';
  text: string;
  at?: string;
}

interface KbBuildPanelProps {
  open: boolean;
  build: KbBuildDto | null;
  issues: KbBuildIssue[];
  logs: BuildLogLine[];
  onCollapse: () => void;
  onCancel: () => void;
  cancelling: boolean;
  layout?: 'bottom' | 'sidebar';
}

const STEP_LABEL: Record<string, string> = {
  queued: '排队',
  preflight: '预检',
  running: '生成',
  validating: '校验',
  publishing: '发布',
};

const TERMINAL_STATUSES = new Set(['published', 'failed', 'cancelled', 'interrupted']);

/** S4/S5：非终态构建的 progress 轮询间隔（细粒度 stage/worker 变化不触发 DB status 事件）。 */
const PROGRESS_POLL_INTERVAL_MS = 2_500;

export function KbBuildPanel({
  open,
  build,
  issues,
  logs,
  onCollapse,
  onCancel,
  cancelling,
  layout = 'bottom',
}: KbBuildPanelProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

  // 新日志到达时贴底滚动（用户上翻查看历史时不打扰：简单实现——仅当接近底部时贴底）。
  useEffect(() => {
    const el = logEndRef.current?.parentElement;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
      logEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [logs.length]);

  // 构建中轮询 progress：SSE build_status 只在 DB status 切换时携带完整 DTO，
  // worker/单元/图片计数在 running 内持续推进，需主动拉取；失败静默保持上一帧。
  const [polled, setPolled] = useState<KbBuildDto | null>(null);
  useEffect(() => {
    if (!open || !build || TERMINAL_STATUSES.has(build.status)) return;
    let disposed = false;
    const tick = () => {
      void getKbBuild(build.id)
        .then((dto) => { if (!disposed) setPolled(dto); })
        .catch(() => undefined);
    };
    const timer = window.setInterval(tick, PROGRESS_POLL_INTERVAL_MS);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [open, build]);

  if (!open || !build) return null;

  // 父层（SSE build_status）到达新终态时以父层为准，避免轮询残帧覆盖发布结果。
  const view = polled && polled.id === build.id && !TERMINAL_STATUSES.has(build.status) ? polled : build;
  const isTerminal = TERMINAL_STATUSES.has(view.status);
  const stepIndex = KB_BUILD_ACTIVE_STEPS.indexOf(view.status as (typeof KB_BUILD_ACTIVE_STEPS)[number]);
  const failed = view.status === 'failed';
  const progress = view.progress;
  const batchTotal = progress.batchTotal;
  const batchIndex = progress.batchIndex;
  const units = progress.units;
  const workers = progress.workers;
  const images = progress.images;
  const warnings = view.warnings;
  const showParallelStrip = units.total > 0 || workers.length > 0 || images.total > 0;

  return (
    <section
      className={`${layout === 'sidebar' ? 'flex-1 min-h-0' : 'shrink-0 h-[240px] min-h-[180px] border-t border-line'} bg-card-bg flex flex-col animate-fade-in`}
      aria-label="标准库构建进度"
      data-build-status={view.status}
    >
      {/* 头部：状态 + 进度 + 操作 */}
      <header className="flex items-center flex-wrap gap-2 px-3 py-2 border-b border-line/60 shrink-0">
        <span
          className={`inline-flex items-center gap-1.5 text-sm font-kai font-medium ${
            failed ? 'text-seal-2' : view.status === 'published' ? 'text-jade' : 'text-ink'
          }`}
        >
          {!isTerminal ? <Loader2 className="w-4 h-4 animate-spin text-seal" /> : null}
          {failed ? <AlertCircle className="w-4 h-4" /> : null}
          {view.status === 'published' ? <Check className="w-4 h-4" /> : null}
          {view.status === 'cancelled' || view.status === 'interrupted' ? (
            <Square className="w-3.5 h-3.5 text-ink-faint" />
          ) : null}
          构建 · {KB_BUILD_STATUS_LABEL[view.status] ?? view.status}
        </span>
        <span className="min-w-0 flex-1 text-[10px] text-ink-faint font-mono truncate" title={view.id}>{view.id}</span>

        {!isTerminal && progress.stage ? (
          <span className="text-xs text-ink-soft" data-testid="kb-build-stage">
            {KB_BUILD_STAGE_LABEL[progress.stage] ?? progress.stage}
          </span>
        ) : null}
        {!isTerminal && view.parallelism > 1 ? (
          <span className="text-xs text-ink-faint" title="实际生效并行度">并行 {view.parallelism}</span>
        ) : null}
        {!isTerminal && batchTotal > 0 ? (
          <span className="text-xs text-ink-soft">
            批次 {Math.min(batchIndex + 1, batchTotal)}/{batchTotal}
          </span>
        ) : null}
        {!isTerminal && batchTotal > 0 ? (
          <div className="flex-1 max-w-[280px] h-1.5 rounded-full bg-paper-2 overflow-hidden">
            <div
              className="h-full bg-seal/70 transition-all duration-500"
              style={{ width: `${Math.round(((batchIndex + 1) / batchTotal) * 100)}%` }}
            />
          </div>
        ) : (
          null
        )}

        {isTerminal ? (
          <span className="text-[11px] text-ink-faint">
            {view.counts.docsWritten > 0 ? `写入 ${view.counts.docsWritten} 篇` : ''}
            {view.counts.docsDeleted > 0 ? ` · 删除 ${view.counts.docsDeleted} 篇` : ''}
          </span>
        ) : null}

        {!isTerminal ? (
          <Button size="sm" variant="secondary" onClick={onCancel} loading={cancelling}>
            取消构建
          </Button>
        ) : null}
        <button
          type="button"
          onClick={onCollapse}
          className="text-ink-faint hover:text-ink transition-colors p-1"
          aria-label="收起构建面板"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      </header>

      {/* 阶段 stepper（终态定格在失败阶段/完成态） */}
      {!failed ? (
        <div className={`flex items-center gap-1 px-4 py-1.5 shrink-0 ${layout === 'sidebar' ? 'flex-wrap gap-y-2' : 'overflow-x-auto scrollbar-thin'}`}>
          {KB_BUILD_ACTIVE_STEPS.map((step, i) => {
            const active = step === view.status;
            const passed =
              (view.status === 'published' || i < stepIndex) && view.status !== 'cancelled';
            return (
              <div key={step} className="flex items-center gap-1 shrink-0">
                {i > 0 ? <span className={`w-4 h-px ${passed || active ? 'bg-jade/50' : 'bg-line'}`} /> : null}
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
                    active
                      ? 'bg-[rgba(158,43,37,0.08)] text-seal font-medium'
                      : passed
                        ? 'text-jade'
                        : 'text-ink-faint'
                  }`}
                >
                  {active ? <CircleDot className="w-3 h-3 animate-pulse" /> : passed ? <Check className="w-3 h-3" /> : null}
                  {STEP_LABEL[step]}
                </span>
              </div>
            );
          })}
          {view.status === 'published' ? (
            <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-jade font-medium">
              <Check className="w-3 h-3" />
              {view.noChanges ? '无变更，未新建发布' : '已发布'}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* S4/S5 并行进度：单元计数 + worker 列表 + 图片维度（有数据才渲染） */}
      {showParallelStrip ? (
        <div
          className={`px-4 py-1.5 shrink-0 border-b border-line/60 space-y-1.5 ${layout === 'sidebar' ? '' : 'flex flex-wrap items-center gap-x-4 gap-y-1.5'}`}
          data-testid="kb-build-parallel"
        >
          {units.total > 0 ? (
            <div className="flex items-center gap-2 min-w-[180px]" data-testid="kb-build-units">
              <Layers className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
              <span className="text-[11px] text-ink-soft shrink-0">
                单元 {units.done}/{units.total}
              </span>
              <div className="flex-1 min-w-[60px] h-1.5 rounded-full bg-paper-2 overflow-hidden">
                <div
                  className="h-full bg-seal/70 transition-all duration-500"
                  style={{ width: `${Math.round((units.done / units.total) * 100)}%` }}
                />
              </div>
              {units.running > 0 ? <span className="text-[11px] text-ink-faint">进行 {units.running}</span> : null}
              {units.retried > 0 ? <span className="text-[11px] text-seal">重试 {units.retried}</span> : null}
              {units.failed > 0 ? <span className="text-[11px] text-seal-2">失败 {units.failed}</span> : null}
            </div>
          ) : null}
          {workers.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-testid="kb-build-workers">
              {workers.map((worker) => (
                <WorkerChip key={worker.workerId} worker={worker} />
              ))}
            </div>
          ) : null}
          {images.total > 0 ? (
            <p className="flex items-center gap-1.5 text-[11px] text-ink-soft" data-testid="kb-build-images">
              <ImageIcon className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
              图片 已理解 {images.described + images.cached}/{images.total}（缓存 {images.cached}
              {images.unavailable > 0 ? (
                <span className="text-seal" title="图片理解未配置或部分失败，图片处已插入未理解标记">
                  {' · '}{images.unavailable} 张未理解
                </span>
              ) : ''}
              ）
            </p>
          ) : null}
        </div>
      ) : null}

      {/* S4/S5 构建警告（发布成功也可能携带，如 images_unavailable） */}
      {warnings.length > 0 ? (
        <div className="px-4 py-1.5 shrink-0 border-b border-line/60 bg-[rgba(191,144,4,0.05)] space-y-1" data-testid="kb-build-warnings">
          {warnings.map((warning, i) => (
            <WarningRow key={`${warning.code}-${i}`} warning={warning} />
          ))}
        </div>
      ) : null}

      {/* 失败态：错误 + issues + 「当前发布版本未变」 */}
      {failed ? (
        <div className="px-4 py-2 shrink-0 border-b border-line/60 bg-[rgba(192,57,43,0.04)]">
          <p className="text-xs text-seal-2 leading-relaxed">
            构建失败{view.error ? `（${view.error.code}）：${view.error.message}` : ''}。
            <span className="text-ink-soft">当前已发布的标准库版本未受影响，仍可正常阅读。</span>
          </p>
          {issues.length > 0 ? (
            <ul className="mt-1.5 space-y-1 max-h-[72px] overflow-auto scrollbar-thin">
              {issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px] text-ink-soft leading-snug">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-seal" />
                  <span>
                    {issue.path || issue.objToken ? (
                      <span className="font-mono text-ink">{issue.path ?? issue.objToken}：</span>
                    ) : null}
                    {issue.message}
                    <span className="text-ink-faint">（{issue.code}）</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* 日志流 */}
      <div className="flex-1 min-h-0 overflow-auto scrollbar-thin px-4 py-2 space-y-0.5">
        {logs.length === 0 ? (
          <p className="text-[11px] text-ink-faint">{isTerminal ? '当前会话无实时日志；已发布内容的变化可在变更记录中查看。' : '等待构建事件…'}</p>
        ) : (
          logs.map((line) => <BuildLogRow key={line.id} line={line} />)
        )}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}

function BuildLogRow({ line }: { line: BuildLogLine }) {
  if (line.kind === 'assistant') {
    return (
      <p className="text-[11px] leading-relaxed text-ink-soft whitespace-pre-wrap border-l-2 border-jade/40 pl-2">
        {line.text}
      </p>
    );
  }
  if (line.kind === 'tool-start' || line.kind === 'tool-end') {
    const isError = line.kind === 'tool-end' && line.text.startsWith('✕');
    return (
      <p className="flex items-start gap-1.5 text-[11px] leading-snug text-ink-soft">
        {line.kind === 'tool-start' ? (
          <Loader2 className="w-3 h-3 mt-0.5 shrink-0 animate-spin text-jade" />
        ) : isError ? (
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0 text-seal-2" />
        ) : (
          <Check className="w-3 h-3 mt-0.5 shrink-0 text-jade" />
        )}
        <Wrench className="w-3 h-3 mt-0.5 shrink-0 text-ink-faint" />
        <span className="font-mono">{line.text}</span>
      </p>
    );
  }
  const color =
    line.kind === 'error' ? 'text-seal-2' : line.kind === 'warn' ? 'text-seal' : 'text-ink-faint';
  const Icon = line.kind === 'error' || line.kind === 'warn' ? AlertTriangle : Info;
  return (
    <p className={`flex items-start gap-1.5 text-[11px] leading-snug ${color}`}>
      <Icon className="w-3 h-3 mt-0.5 shrink-0" />
      <span className="whitespace-pre-wrap break-all">{line.text}</span>
    </p>
  );
}

/** S4/S5：单个 worker 进度徽标（workerId · 单元 · 批次 · 状态）。 */
function WorkerChip({ worker }: { worker: KbBuildWorkerProgress }) {
  const stateLabel = KB_BUILD_WORKER_STATE_LABEL[worker.state] ?? worker.state;
  const tone =
    worker.state === 'running'
      ? 'bg-[rgba(158,43,37,0.08)] text-seal'
      : worker.state === 'finishing'
        ? 'bg-jade/10 text-jade'
        : 'bg-paper-2 text-ink-faint';
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${tone}`}
      data-worker-id={worker.workerId}
      data-worker-state={worker.state}
      title={`worker ${worker.workerId} · ${stateLabel}${worker.unitId ? ` · 单元 ${worker.unitId}` : ''}`}
    >
      {worker.state === 'running' ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : null}
      {worker.workerId}
      {worker.unitId ? <span>· {worker.unitId}</span> : null}
      {worker.state === 'running' && worker.unitBatchTotal > 0 ? (
        <span>
          · 批 {Math.min(worker.unitBatchIndex + 1, worker.unitBatchTotal)}/{worker.unitBatchTotal}
        </span>
      ) : null}
      <span className="font-sans">{stateLabel}</span>
    </span>
  );
}

/** S4/S5：构建警告行；images_unavailable 追加「去设置启用」引导。 */
function WarningRow({ warning }: { warning: KbBuildWarning }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-seal leading-snug" data-warning-code={warning.code}>
      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
      <span>
        <span className="font-medium">{KB_BUILD_WARNING_LABEL[warning.code] ?? warning.code}：</span>
        {warning.message}
        {warning.code === 'images_unavailable' ? (
          <span className="text-ink-soft">可在「设置 → Agent 运行时与模型 → 图片理解」启用并测试识图模型后消除。</span>
        ) : null}
      </span>
    </p>
  );
}
