/**
 * BuildOrchestrationProgress —— 构建编排流水进度（T5b，B 案 §4/§5/附录 B）
 *
 * 数据源：GET /api/kb/builds/:id/orchestration（T2b，同一份 BuildOrchestration
 * 数据源派生）。轮询对齐 KbBuildPanel 的 2.5s 轻量节拍：非终态构建（含
 * awaiting_release——它不是终态）持续轮询；终态定格后补拉一次展示收束结果。
 * 旧式构建（无 orchestration 数据，端点 404）降级显示说明行，不报错。
 *
 * awaiting_release 确认交互（B 案 §7）：候选摘要取自构建 DTO counts 与
 * orchestration reviewSummary（已审/沿用范围）；确认调 POST release-confirm。
 * 服务端绑定候选哈希复核 staging——内容变化返回 409 kb_confirm_stale，前端
 * 明确提示「候选内容已变化，确认失效」并引导刷新（重拉编排进度；构建 DTO
 * 由父层轮询自行收敛）。
 */

import { useEffect, useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../common/Button';
import { APIError, confirmKbRelease, getKbBuildOrchestration } from '../../api/client';
import { THINKING_LABELS } from '../settings/BuildOrchestrationSettings';
import type {
  KbBuildDto,
  KbBuildOrchestrationDto,
  KbBuildOrchestrationTaskDto,
} from '../../types/agent';

interface BuildOrchestrationProgressProps {
  build: KbBuildDto;
  /** 确认发布成功后把新构建 DTO 交回父层（KnowledgeView setBuild，触发发布后刷新链）。 */
  onBuildUpdated?: (dto: KbBuildDto) => void;
}

/** 终态判定与 KnowledgeView.TERMINAL_BUILD 同口径（awaiting_release 是进行中）。 */
const TERMINAL_STATUSES = new Set(['published', 'failed', 'cancelled', 'interrupted']);

/** 与 KbBuildPanel.PROGRESS_POLL_INTERVAL_MS 同节拍。 */
const ORCHESTRATION_POLL_INTERVAL_MS = 2_500;

/** 角色分组顺序（server BuildRole；无任务的分组不渲染）。 */
const ROLE_GROUPS: Array<{ key: string; label: string }> = [
  { key: 'plan', label: '规划' },
  { key: 'write', label: '撰写' },
  { key: 'review', label: '审查' },
  { key: 'integrate', label: '整合' },
  { key: 'final_review', label: '最终复核' },
];

export const ORCH_EXEC_LABEL: Record<string, string> = {
  queued: '排队', running: '执行中', done: '完成', failed: '失败', cancelled: '已取消',
};
export const ORCH_ARTIFACT_LABEL: Record<string, string> = {
  pending: '待生成', available: '可用', missing: '缺失', incomplete: '不完整',
};
export const ORCH_ACCEPTANCE_LABEL: Record<string, string> = {
  unreviewed: '待审', needs_revision: '需修订', passed: '通过', pending_decision: '待裁定',
};

type BadgeTone = 'muted' | 'active' | 'good' | 'warn' | 'bad';
const TONE_CLASS: Record<BadgeTone, string> = {
  muted: 'bg-paper-2 text-ink-faint',
  active: 'bg-[rgba(158,43,37,0.08)] text-seal',
  good: 'bg-jade/10 text-jade',
  warn: 'bg-[rgba(191,144,4,0.10)] text-[#bf9004]',
  bad: 'bg-seal-2/10 text-seal-2',
};

function execTone(state: string): BadgeTone {
  if (state === 'running') return 'active';
  if (state === 'done') return 'good';
  if (state === 'failed') return 'bad';
  return 'muted';
}
function artifactTone(state: string): BadgeTone {
  if (state === 'available') return 'good';
  if (state === 'missing' || state === 'incomplete') return 'bad';
  return 'muted';
}
function acceptanceTone(state: string): BadgeTone {
  if (state === 'passed') return 'good';
  if (state === 'needs_revision') return 'warn';
  if (state === 'pending_decision') return 'bad';
  return 'muted';
}

/** 等待原因三分类（依赖未满足=waitingOn 非空；名额等待=就绪未获槽；等待人工=待裁定）。 */
export function waitingReasonOf(
  task: Pick<KbBuildOrchestrationTaskDto, 'execState' | 'acceptanceState' | 'waitingOn'>,
): { label: string; tone: BadgeTone; kind: 'dependency' | 'capacity' | 'human' } | null {
  if (task.acceptanceState === 'pending_decision') {
    return { label: '等待人工裁定', tone: 'bad', kind: 'human' };
  }
  if (task.waitingOn.length > 0) {
    return { label: `依赖未满足（${task.waitingOn.length}）`, tone: 'warn', kind: 'dependency' };
  }
  if (task.execState === 'queued') {
    return { label: '等待构建名额', tone: 'muted', kind: 'capacity' };
  }
  return null;
}

/** 角色模型显示：''=跟随活跃预设；thinking off/缺省不显示。 */
export function orchModelLabel(model: { modelPresetId: string; thinking?: string }): string {
  const preset = model.modelPresetId === '' ? '跟随活跃预设' : model.modelPresetId;
  const thinking = model.thinking && model.thinking !== 'off'
    ? `（${THINKING_LABELS[model.thinking as keyof typeof THINKING_LABELS] ?? model.thinking}）`
    : '';
  return `${preset}${thinking}`;
}

function unitLabelOf(task: KbBuildOrchestrationTaskDto): string {
  if (task.unitId) return task.unitId;
  if (task.role === 'integrate' || task.role === 'final_review') return '全部单元';
  if (task.role === 'plan') return '组织计划';
  return task.taskId;
}

export function BuildOrchestrationProgress({ build, onBuildUpdated }: BuildOrchestrationProgressProps) {
  const [data, setData] = useState<KbBuildOrchestrationDto | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<{ code: string | null; message: string } | null>(null);
  const [confirmDone, setConfirmDone] = useState<string | null | undefined>(undefined); // undefined=未确认过

  const terminal = TERMINAL_STATUSES.has(build.status);

  // 切换构建时重置全部本地状态（同一构建内 status 变化不重置）。
  useEffect(() => {
    setData(null);
    setLegacy(false);
    setConfirmError(null);
    setConfirmBusy(false);
    setConfirmDone(undefined);
  }, [build.id]);

  // 轮询：非终态（含 awaiting_release）持续；终态补拉一次定格收束。404 = 旧式构建。
  useEffect(() => {
    if (legacy) return;
    let disposed = false;
    const load = () => {
      void getKbBuildOrchestration(build.id)
        .then((dto) => { if (!disposed && dto.buildId === build.id) setData(dto); })
        .catch((err: unknown) => {
          if (disposed) return;
          if (err instanceof APIError && err.statusCode === 404) {
            setLegacy(true);
            return;
          }
          /* 其他失败静默保持上一帧（KbBuildPanel 轮询同法）。 */
        });
    };
    load();
    if (terminal) return () => { disposed = true; };
    const timer = window.setInterval(load, ORCHESTRATION_POLL_INTERVAL_MS);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [build.id, terminal, legacy]);

  const refreshOrchestration = () => {
    setConfirmError(null);
    void getKbBuildOrchestration(build.id).then(setData).catch(() => undefined);
  };

  const confirmRelease = async () => {
    if (confirmBusy || confirmDone !== undefined) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      const dto = await confirmKbRelease(build.id);
      setConfirmDone(dto.releaseId ?? '');
      onBuildUpdated?.(dto);
    } catch (err: unknown) {
      const code = err instanceof APIError
        ? ((err.response as { error?: string } | undefined)?.error ?? null)
        : null;
      setConfirmError({
        code,
        message: err instanceof Error ? err.message : '确认发布失败',
      });
    } finally {
      setConfirmBusy(false);
    }
  };

  // ---- 旧式构建降级 -------------------------------------------------------
  if (legacy) {
    return (
      <p
        className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-ink-faint shrink-0"
        data-testid="kb-orch-legacy"
      >
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        旧式构建（未启用编排流水）：按单模型流水生成，无审查/整合任务视图。
      </p>
    );
  }

  const awaiting = build.status === 'awaiting_release' || confirmDone !== undefined;
  const stale = confirmError?.code === 'kb_confirm_stale';
  const summary = data?.reviewSummary;
  const counts = build.counts;

  return (
    <div
      className="shrink-0 border-b border-line/60 px-3 py-2 space-y-1.5"
      data-testid="kb-orch-progress"
      data-orch-ended={data ? String(data.ended) : undefined}
    >
      {/* awaiting_release 确认面板（B 案 §7） */}
      {awaiting ? (
        <div
          className={`rounded-md border px-3 py-2 space-y-1.5 ${stale ? 'border-seal-2/40 bg-seal-2/5' : 'border-seal/30 bg-[rgba(158,43,37,0.04)]'}`}
          data-testid="kb-orch-awaiting"
        >
          <p className="flex items-center gap-1.5 text-xs font-kai font-medium text-ink">
            {stale ? <AlertCircle className="w-4 h-4 text-seal-2" /> : <Check className="w-4 h-4 text-jade" />}
            候选就绪 · 等待确认发布
          </p>
          {confirmDone === undefined ? (
            <>
              <ul className="space-y-0.5 text-[11px] text-ink-soft leading-snug">
                <li data-testid="kb-orch-candidate-docs">
                  候选文档：本轮写入 <b className="text-ink">{counts.docsWritten}</b> 篇
                  {summary && summary.integration.carriedOverDocs > 0 ? (
                    <>，沿用未改动 <b className="text-ink">{summary.integration.carriedOverDocs}</b> 篇</>
                  ) : null}
                </li>
                <li data-testid="kb-orch-candidate-changes">
                  变更说明：新增 {counts.added} · 变更 {counts.changed} · 移除 {counts.removed}
                  {counts.docsDeleted > 0 ? ` · 删除文档 ${counts.docsDeleted} 篇` : ''}
                </li>
                <li data-testid="kb-orch-candidate-review">
                  审查范围：单元验收通过 {summary?.unitsReviewed ?? '—'}/{summary?.unitsWritten ?? '—'}，
                  最终复核{summary?.integration.finalReviewDone ? '已完成' : '未完成'}
                </li>
              </ul>
              <p className="text-[10px] text-ink-faint">确认后执行原子发布并更新标准库版本；确认失败不影响当前已发布版本。</p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => void confirmRelease()} loading={confirmBusy}>
                  确认发布
                </Button>
              </div>
            </>
          ) : (
            <p className="text-[11px] text-jade" data-testid="kb-orch-confirm-done">
              已确认发布{confirmDone ? `：${confirmDone}` : ''}。
            </p>
          )}
          {stale ? (
            <div role="alert" className="text-[11px] text-seal-2 leading-snug space-y-1" data-testid="kb-orch-confirm-stale">
              <p>候选内容已变化，确认失效：请刷新后重新确认，或重新构建。</p>
              <button
                type="button"
                onClick={refreshOrchestration}
                className="inline-flex items-center gap-1 text-seal underline"
              >
                <RefreshCw className="w-3 h-3" /> 刷新候选状态
              </button>
            </div>
          ) : confirmError ? (
            <p role="alert" className="text-[11px] text-seal-2" data-testid="kb-orch-confirm-error">
              确认失败：{confirmError.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* reviewSummary 四计数 + 整合/最终复核标记 */}
      {data ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" data-testid="kb-orch-summary">
          <span className="text-ink-soft">已写 <b className="text-ink font-mono">{summary?.unitsWritten ?? 0}</b></span>
          <span className="text-ink-soft">已审 <b className="text-ink font-mono">{summary?.unitsReviewed ?? 0}</b></span>
          <span className={summary && summary.unitsPendingRevision > 0 ? 'text-seal' : 'text-ink-faint'}>
            待修订 <b className="font-mono">{summary?.unitsPendingRevision ?? 0}</b>
          </span>
          <span className="text-ink-soft">沿用 <b className="text-ink font-mono">{summary?.integration.carriedOverDocs ?? 0}</b> 篇</span>
          {summary?.integration.integratePassed ? (
            <span className="inline-flex items-center gap-0.5 text-jade"><Check className="w-3 h-3" />整合通过</span>
          ) : null}
          {summary?.integration.finalReviewDone ? (
            <span className="inline-flex items-center gap-0.5 text-jade"><Check className="w-3 h-3" />最终复核完成</span>
          ) : null}
        </div>
      ) : null}

      {/* spec 摘要：发布方式 / N 路 / 角色模型（冻结 BuildSpec） */}
      {data ? (
        <p className="text-[10px] text-ink-faint leading-relaxed break-all" data-testid="kb-orch-spec">
          发布 {data.spec.publishMode === 'confirm' ? '候选就绪人工确认一次' : '自动整版发布'}
          {' · '}并发 {data.spec.concurrency} 路
          {' · '}撰写 {orchModelLabel(roleModelOf(data, 'write'))}
          {' · '}审查 {orchModelLabel(roleModelOf(data, 'review'))}
          {data.tasks.some((task) => task.role === 'integrate')
            ? ` · 整合 ${orchModelLabel(roleModelOf(data, 'integrate'))}` : ''}
          {data.ended ? ` · 已收束${data.endReason ? `（${data.endReason}）` : ''}` : ''}
          {data.interfaceRetryTotal > 0 ? ` · 接口重试 ${data.interfaceRetryTotal}` : ''}
          {data.lateReceiptCount > 0 ? ` · 迟到回执 ${data.lateReceiptCount}` : ''}
        </p>
      ) : (
        <p className="text-[10px] text-ink-faint">编排进度加载中…</p>
      )}

      {/* 任务流水（按角色分组；三轴徽标分色） */}
      {data ? (
        <div data-testid="kb-orch-tasks">
          <button
            type="button"
            onClick={() => setTasksOpen((value) => !value)}
            aria-expanded={tasksOpen}
            className="flex items-center gap-1 text-[11px] text-ink-soft hover:text-ink transition-colors"
            data-testid="kb-orch-tasks-toggle"
          >
            {tasksOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            任务流水 · {data.tasks.length} 项
          </button>
          {tasksOpen ? (
            <div className="mt-1 space-y-1.5 max-h-[180px] overflow-auto scrollbar-thin">
              {ROLE_GROUPS.map((group) => {
                const tasks = data.tasks
                  .filter((task) => task.role === group.key)
                  .sort((a, b) => (a.unitId ?? 'zz').localeCompare(b.unitId ?? 'zz') || a.round - b.round || a.attempt - b.attempt);
                if (tasks.length === 0) return null;
                return (
                  <div key={group.key} data-role-group={group.key}>
                    <p className="text-[10px] text-ink-faint font-medium">
                      {group.label}
                      <span className="font-mono"> · {tasks.length}</span>
                      <span className="ml-1 font-normal break-all">{orchModelLabel(tasks[0].model)}</span>
                    </p>
                    <ul className="mt-0.5 space-y-1">
                      {tasks.map((task) => <TaskRow key={task.taskId} task={task} />)}
                    </ul>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 取某角色首个任务的冻结模型（无任务返回跟随活跃预设占位）。 */
function roleModelOf(
  data: KbBuildOrchestrationDto,
  role: string,
): { modelPresetId: string; thinking?: string } {
  const task = data.tasks.find((item) => item.role === role);
  return task ? task.model : { modelPresetId: '' };
}

function TaskRow({ task }: { task: KbBuildOrchestrationTaskDto }) {
  const waiting = waitingReasonOf(task);
  const budget = task.revisionBudget;
  return (
    <li
      className="flex flex-wrap items-center gap-1 text-[10px] leading-snug"
      data-task-id={task.taskId}
      data-exec={task.execState}
      data-artifact={task.artifactState}
      data-acceptance={task.acceptanceState}
      data-waiting={waiting?.kind}
    >
      <span className="font-mono text-ink shrink-0">{unitLabelOf(task)}</span>
      {task.round > 0 ? (
        <span className="px-1 rounded bg-[rgba(191,144,4,0.10)] text-[#bf9004]" title={`审查/修订轮次 r${task.round}（尝试 #${task.attempt}）`}>
          修订 r{task.round}
        </span>
      ) : null}
      <AxisBadge axis="执行" label={ORCH_EXEC_LABEL[task.execState] ?? task.execState} tone={execTone(task.execState)} />
      <AxisBadge axis="产物" label={ORCH_ARTIFACT_LABEL[task.artifactState] ?? task.artifactState} tone={artifactTone(task.artifactState)} />
      <AxisBadge axis="验收" label={ORCH_ACCEPTANCE_LABEL[task.acceptanceState] ?? task.acceptanceState} tone={acceptanceTone(task.acceptanceState)} />
      {task.execState === 'running' ? <Loader2 className="w-3 h-3 animate-spin text-seal shrink-0" /> : null}
      {waiting ? (
        <span
          className={`px-1 rounded ${TONE_CLASS[waiting.tone]}`}
          title={task.waitingOn.length > 0 ? task.waitingOn.join('\n') : waiting.label}
        >
          {waiting.label}
        </span>
      ) : null}
      {task.blockingIssues > 0 ? (
        <span className="px-1 rounded bg-seal-2/10 text-seal-2" title="最新审查报告中未关闭的阻断问题数">
          阻断 {task.blockingIssues}
        </span>
      ) : null}
      {budget ? (
        <span className="text-ink-faint font-mono" title="自动修订预算（已用/上限）">
          修订 {budget.usedAutoRevisions}/{budget.maxAutoRevisions}
        </span>
      ) : null}
    </li>
  );
}

function AxisBadge({ axis, label, tone }: { axis: string; label: string; tone: BadgeTone }) {
  return (
    <span className={`inline-flex items-center gap-0.5 px-1 rounded ${TONE_CLASS[tone]}`}>
      <span className="opacity-70">{axis}</span>
      {label}
    </span>
  );
}
