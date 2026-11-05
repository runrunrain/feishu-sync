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
import { AlertCircle, Check, ChevronDown, ChevronRight, CornerUpRight, FileCheck2, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../common/Button';
import { APIError, confirmKbRelease, getKbBuildLeaderProgress, getKbBuildOrchestration } from '../../api/client';
import { THINKING_LABELS } from '../settings/BuildOrchestrationSettings';
import type {
  KbBuildDto,
  KbBuildOrchestrationDto,
  KbBuildOrchestrationTaskDto,
  KbLeaderRunProgressDto,
  KbLeaderRunTaskDto,
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

// ---------------------------------------------------------------------------
// v2（设计 v2 §12）：Leader 监督运行进度（GET /api/kb/builds/:id/leader，
// 集成切片真实端点）。任务数=当前计划快照（非可信总数，不显示百分比）；
// 用量/排队原因细分/成果计数未随端点提供：如实标未知，不虚构。
// ---------------------------------------------------------------------------

/** amagi 执行状态已知值中文映射；未知值原样展示（不猜测语义）。
 *  'error' 为真实链路实测出现的 native 状态（子进程/执行异常终态）。 */
export const LEADER_EXEC_STATE_LABEL: Record<string, string> = {
  queued: '排队', running: '已派发', done: '完成', failed: '失败', cancelled: '已取消', error: '异常',
};

/** 任务身份状态（ActorBinding 监督快照）。 */
export const LEADER_ACTOR_STATUS_LABEL: Record<string, string> = {
  pending: '身份待确认', confirmed: '已确认', revoked: '已撤销',
};

/** 恢复能力三态（集成侧 resumeCapability：session/artifact/none）。 */
export const LEADER_RESUME_CAPABILITY_LABEL: Record<string, string> = {
  session: '可原会话续接',
  artifact: '成果级恢复（重建剩余工作）',
  none: '不支持恢复',
};

/** amagi 角色中文名（未知角色原样展示）。 */
export const LEADER_ROLE_LABEL: Record<string, string> = {
  luban: '鲁班（写作）', diting: '谛听（审查）', baize: '白泽（调研）',
};

/** 发布申请裁定状态（集成侧 LeaderPublishRequestSnapshot.status）。 */
export const LEADER_PUBLISH_STATUS_LABEL: Record<string, string> = {
  pending: '待裁定', accepted: '已接受', rejected: '已拒绝', not_wired: '发布管线未接线',
};

/** 角色分组顺序（server BuildRole）。 */
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

/** 同一单元的修订轮次与接口重试属于历史，角色总览只统计最新任务。 */
function latestTasksOf(tasks: KbBuildOrchestrationTaskDto[]): KbBuildOrchestrationTaskDto[] {
  const latest = new Map<string, KbBuildOrchestrationTaskDto>();
  for (const task of tasks) {
    const key = task.unitId ?? task.role;
    const previous = latest.get(key);
    if (!previous || task.revision > previous.revision
      || task.revision === previous.revision && (task.round > previous.round
        || task.round === previous.round && task.attempt >= previous.attempt)) {
      latest.set(key, task);
    }
  }
  return [...latest.values()];
}

export function BuildOrchestrationProgress({ build, onBuildUpdated }: BuildOrchestrationProgressProps) {
  // v2 分支：pi-amagi 构建渲染 Leader 监督运行进度（GET …/leader），
  // 不再请求 B 案 orchestration 数据（两者数据源不同）。保留 legacy 原视图。
  const mode = build.orchestrationMode ?? 'legacy';
  if (mode === 'pi-amagi') {
    return <BuildRuntimeProgress build={build} />;
  }
  return <LegacyOrchestrationProgress build={build} onBuildUpdated={onBuildUpdated} />;
}

/** v2 Leader 监督运行进度（设计 v2 §12；集成切片真实端点消费）。 */
export function BuildRuntimeProgress({ build }: { build: KbBuildDto }) {
  const [data, setData] = useState<KbLeaderRunProgressDto | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const terminal = TERMINAL_STATUSES.has(build.status);

  // 轮询：非终态持续；终态补拉一次定格；404（非 pi-amagi/不存在）→ 如实降级。
  useEffect(() => {
    if (unavailable) return;
    let disposed = false;
    const load = () => {
      void getKbBuildLeaderProgress(build.id)
        .then((dto) => { if (!disposed && dto.buildId === build.id) setData(dto); })
        .catch((err: unknown) => {
          if (disposed) return;
          if (err instanceof APIError && err.statusCode === 404) {
            // 构建启动窗口 leaderRun 尚未建立时会短暂 404（真实实测：POST
            // 返回后立即拉取 404，数秒后端点就绪）。非终态保持轮询等数据
            // 就绪（界面维持「加载中」，不定格）；终态构建 404 = 确无监督
            // 数据，才降级为不可用（不五回推测进度）。
            if (terminal) setUnavailable(true);
            return;
          }
          /* 其他失败静默保持上一帧。 */
        });
    };
    load();
    if (terminal) return () => { disposed = true; };
    const timer = window.setInterval(load, ORCHESTRATION_POLL_INTERVAL_MS);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [build.id, terminal, unavailable]);

  if (unavailable) {
    return (
      <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-ink-faint shrink-0" data-testid="kb-runtime-unavailable">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        Leader 监督进度暂不可用：该构建无 Leader 监督运行数据（非 pi-amagi 构建或无检查点），不显示推测进度。
      </p>
    );
  }

  const leader = data?.leader;
  const summary = data?.summary;
  const processUnconfirmed = data?.termination === 'termination-unconfirmed' || data?.processTermination?.state === 'unconfirmed';
  const runtimeEnded = terminal || data?.termination === 'finished' || Boolean(data?.endedReason) || processUnconfirmed;
  const currentTasks = data?.tasks.filter((task) => !isHistoricalRuntimeTask(task, data)) ?? [];
  // task_created records dispatch acceptance, not a started Pi process.
  // amagi can keep many accepted handles waiting behind its admission pool.
  const unfinishedCount = currentTasks.filter((task) => ['queued', 'running', 'pending', 'blocked'].includes(task.execState ?? '')).length;
  /** 真实回执计数；进程并发没有进入此 DTO，不从任务句柄猜测。 */
  const acceptedDocs = summary?.acceptedDocumentCount ?? null;
  const openBlocking = summary?.openBlockingCount ?? null;
  const cancelling = data?.termination === 'cancelling';

  return (
    <div className="shrink-0 border-b border-line/60 px-4 py-3 space-y-3" data-testid="kb-runtime-progress">
      {processUnconfirmed ? (
        <div role="alert" className="rounded border border-seal/30 bg-paper-2 px-3 py-2 text-xs text-seal break-words" data-testid="kb-runtime-termination-unconfirmed">
          后台终止未确认：凭据已撤销，但尚未确认所有进程退出；恢复会先重新对账，未确认前不启动新 Leader。
          {data?.processTermination?.note ? <p className="mt-1">{data.processTermination.note}</p> : null}
        </div>
      ) : null}
      {/* 取消后台终止中（集成侧 termination=cancelling：凭据已失效、后台仍在终止） */}
      {cancelling ? (
        <div
          className="flex items-center gap-1.5 rounded-md border border-[#bf9004]/40 bg-[rgba(191,144,4,0.06)] px-3 py-2 text-xs text-[#8a6a00]"
          role="status"
          data-testid="kb-runtime-cancelling"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          已请求取消：凭据已失效，仍在终止后台任务（Leader 与子进程退出后收束）…
        </div>
      ) : null}

      {/* 汇总：已接受文档 / 未解决阻断 / 未结束任务（不推测进程并发） */}
      {data ? (
        <div className="grid grid-cols-3 gap-2" data-testid="kb-runtime-summary">
          <Metric label="已接受文档" value={acceptedDocs ?? '未知'} alert={openBlocking != null && openBlocking > 0 ? false : false} hint={acceptedDocs == null ? '回执数据未提供' : '应用回执去重'} />
          <Metric label="未解决阻断" value={openBlocking ?? '未知'} alert={Boolean(openBlocking && openBlocking > 0)} hint={openBlocking == null ? '问题清单未提供' : undefined} />
          <Metric label={runtimeEnded ? '末次观测未结任务' : '已派发未结任务'} value={unfinishedCount} hint={runtimeEnded ? '历史观测，非当前活跃；后台残留以终止核验为准' : `含等待准入的任务；实际进程并发未知${summary?.activeAssignments != null ? ` · 活动分配 ${summary.activeAssignments}` : ''}`} />
        </div>
      ) : (
        <p className="text-[10px] text-ink-faint">运行进度加载中…</p>
      )}

      {/* Leader 行：会话/代次/轮次/末次用量/恢复能力（口径全部来自监督状态） */}
      {data && leader ? (
        <div className="rounded-md border border-line bg-paper/45 px-3 py-2 space-y-1" data-testid="kb-runtime-leader">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink">
            <span className="font-kai font-medium">Leader 会话</span>
            <span className={`px-1 rounded ${data.endedReason || data.termination === 'finished' ? 'bg-paper-2 text-ink-faint' : 'bg-[rgba(158,43,37,0.08)] text-seal'}`}>
              {processUnconfirmed ? '终止未确认' : data.endedReason || data.termination === 'finished' ? `已结束（${data.endedReason ?? 'finished'}）` : '监督中'}
            </span>
            <span className="text-[11px] text-ink-faint">代次 {data.generation}</span>
            <span className="text-[11px] text-ink-faint">轮次 {data.rounds?.started ?? '未知'}/{data.rounds?.ended ?? '未知'}（启/收）</span>
            {leader.sessionId ? (
              <span className="text-[10px] font-mono text-ink-faint break-all" title={`${leader.sessionId}${leader.pid != null ? ` · pid ${leader.pid}` : ''}`}>
                {leader.sessionId.slice(0, 14)}…
              </span>
            ) : null}
          </p>
          {data.idle.remindedAt ? (
            <p className="text-[11px] text-[#bf9004]" data-testid="kb-runtime-idle-reminded">
              空闲提醒已发送（收口判定中；再空闲将按 leader_idle 中断）
            </p>
          ) : null}
          <p className="text-[11px] text-ink-soft" data-testid="kb-runtime-leader-usage">
            {summary?.lastUsage
              ? `末次轮次用量：入 ${summary.lastUsage.inputTokens} / 出 ${summary.lastUsage.outputTokens}（累计未知：父子去重后不可得，不假累加）`
              : 'Leader 用量未知（末次轮次数据未提供；累计未知）'}
          </p>
          <p className="text-[11px] text-ink-soft" data-testid="kb-runtime-resume-capability">
            恢复能力：{processUnconfirmed ? '需先确认后台终止' : LEADER_RESUME_CAPABILITY_LABEL[leader.resumeCapability] ?? leader.resumeCapability}
            <span className="ml-1">（{processUnconfirmed ? '重新对账前不承诺可续接' : '中断后按此方式续接'}）</span>
          </p>
          {data.skill ? (
            <p className="text-[10px] text-ink-faint font-mono break-all" title={data.skill.path} data-testid="kb-runtime-skill">
              skill {data.skill.revision.slice(0, 16)}…
            </p>
          ) : null}
          {data.publishRequest ? (
            <p className="flex flex-wrap items-center gap-1 text-[11px]" data-testid="kb-runtime-publish-request">
              {data.publishRequest.accepted
                ? <Check className="w-3 h-3 text-jade shrink-0" />
                : <FileCheck2 className="w-3 h-3 text-[#bf9004] shrink-0" />}
              <span className="text-ink-soft">发布申请 {data.publishRequest.candidateRevision}：{data.publishRequest.summary}</span>
              <span className={data.publishRequest.accepted ? 'text-jade' : 'text-[#bf9004]'}>{LEADER_PUBLISH_STATUS_LABEL[data.publishRequest.status ?? ''] ?? data.publishRequest.status ?? ''}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* 任务：当前计划快照（身份/执行/续接链；无百分比） */}
      {data ? (
        <div className="space-y-2" data-testid="kb-runtime-tasks">
          <p className="flex items-center justify-between text-xs">
            <span className="font-kai font-medium text-ink">子任务</span>
            <span className="text-[11px] text-ink-faint" data-testid="kb-runtime-plan-count">
              当前计划 {currentTasks.length} 项（随 Leader 分解变化，非总数）{data.tasks.length > currentTasks.length ? ` · 历史 ${data.tasks.length - currentTasks.length} 项` : ''}
            </span>
          </p>
          {data.tasks.length === 0 ? (
            <p className="text-[11px] text-ink-faint">尚无子任务；等待 Leader 拆分主题并派发。</p>
          ) : (
            <ul className="max-h-[280px] space-y-1.5 overflow-y-auto scrollbar-thin">
              {data.tasks.map((task) => (
                <RuntimeTaskRow
                  key={task.nativeTaskId}
                  task={task}
                  successor={task.status === 'revoked' ? data.tasks.find((candidate) => candidate.parentTaskId === task.nativeTaskId) : undefined}
                  terminal={runtimeEnded || isHistoricalRuntimeTask(task, data)}
                  historical={isHistoricalRuntimeTask(task, data)}
                  processUnconfirmed={processUnconfirmed}
                  queueReason={data.summary.queueReason}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* 未观测信息诚实声明：端点不提供的数据不虚构（累计用量恒未知） */}
      <p className="text-[10px] text-ink-faint" data-testid="kb-runtime-mode-note">
        已接受/阻断计数与应用回执同步（缺失时标未知）；
        累计用量父子去重后不可得（恒未知，不假累加）；任务计划随 Leader 分解变化，不显示百分比。
      </p>
    </div>
  );
}

function isHistoricalRuntimeTask(task: KbLeaderRunTaskDto, data: KbLeaderRunProgressDto): boolean {
  return task.status === 'revoked' || (task.runtimeEpoch != null && data.runtimeEpoch != null && task.runtimeEpoch !== data.runtimeEpoch)
    || (task.generation != null && task.generation !== data.generation);
}

function RuntimeTaskRow({ task, successor, terminal, queueReason, historical = false, processUnconfirmed = false }: {
  task: KbLeaderRunTaskDto; successor?: KbLeaderRunTaskDto; terminal: boolean; queueReason?: string | null; historical?: boolean; processUnconfirmed?: boolean;
}) {
  const exec = task.execState;
  const execLabel = exec === null ? '未观测' : LEADER_EXEC_STATE_LABEL[exec] ?? exec;
  const stopped = terminal && (exec === 'queued' || exec === 'running');
  const stateTone = stopped ? (processUnconfirmed ? 'warn' : 'muted') : exec === 'running' ? 'active' : exec === 'failed' || exec === 'error' ? 'bad'
    : exec === 'done' ? 'good' : 'muted';
  const actorTone = successor ? 'muted' : task.status === 'confirmed' ? 'good' : task.status === 'revoked' ? 'bad' : 'warn';
  return (
    <li
      className="rounded border border-line bg-card-bg px-2.5 py-2 text-[11px] leading-snug"
      data-testid="kb-runtime-task"
      data-task-id={task.nativeTaskId}
      data-exec={stopped ? (processUnconfirmed ? 'termination-unconfirmed' : 'stopped') : (exec ?? 'unknown')}
      data-actor-status={task.status}
    >
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs text-ink break-all" title={task.nativeTaskId}>{shortId(task.nativeTaskId)}</span>
        <span
          className={`px-1 rounded ${TONE_CLASS[stateTone]}`}
          title={stopped ? (processUnconfirmed ? '这是最后观测；后台清理未确认，不表示进程已退出或任务完成' : '运行时已结束；这是最后观测到的执行状态（未观测到 native 终态，不虚构 done）') : undefined}
        >{successor && stopped ? '已被接替' : stopped ? (processUnconfirmed ? '终止未确认' : '已停止') : execLabel}</span>
        {historical ? <span className="text-ink-faint">历史任务</span> : null}
        <span className={`px-1 rounded ${TONE_CLASS[actorTone]}`}>{successor ? '已续接' : LEADER_ACTOR_STATUS_LABEL[task.status] ?? task.status}</span>
        {exec === 'queued' && !terminal ? (
          <span
            className="px-1 rounded bg-paper-2 text-ink-faint"
            title={queueReason ?? '排队原因细分不可观测（amagi 准入内部）'}
          >
            {queueReason ? `排队（${queueReason}）` : '排队（原因未细分）'}
          </span>
        ) : null}
        {exec === 'running' && !terminal ? <span className="text-ink-faint" title="已派发；是否已获运行名额未观测">待完成</span> : null}
      </span>
      <span className="mt-1 flex flex-col gap-0.5 text-ink-faint">
        <span>
          {LEADER_ROLE_LABEL[task.role] ?? task.role}
          <span className="ml-1.5">· 子任务用量不经 Leader 事件（未知）</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {successor ? <span title={`续接任务 ${successor.nativeTaskId}`}>由 {shortId(successor.nativeTaskId)} 继续处理</span> : null}
          {task.parentTaskId ? (
            <span className="inline-flex items-center gap-0.5" title={`续接自 ${task.parentTaskId}`}>
              <CornerUpRight className="w-3 h-3" />续接 {shortId(task.parentTaskId)}
            </span>
          ) : null}
          {task.lastEventAt ? <span title={task.lastEventAt}>最近事件 {new Date(task.lastEventAt).toLocaleTimeString()}</span> : null}
        </span>
      </span>
    </li>
  );
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

/** 旧版（B 案）编排流水进度：原实现整体保留。 */
function LegacyOrchestrationProgress({ build, onBuildUpdated }: BuildOrchestrationProgressProps) {
  const [data, setData] = useState<KbBuildOrchestrationDto | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
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
    setSelectedRole(null);
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
  const roleTasks = ROLE_GROUPS.map((group) => {
    const tasks = (data?.tasks ?? [])
      .filter((task) => task.role === group.key)
      .sort((a, b) => (a.unitId ?? 'zz').localeCompare(b.unitId ?? 'zz') || a.round - b.round || a.attempt - b.attempt);
    return { ...group, tasks, latest: latestTasksOf(tasks) };
  });
  const effectiveRole = selectedRole ?? roleTasks.find((group) => group.latest.some((task) => task.execState === 'running'))?.key
    ?? roleTasks.find((group) => group.latest.some((task) => task.execState === 'queued'))?.key
    ?? roleTasks.find((group) => group.tasks.length > 0)?.key ?? 'write';
  const selected = roleTasks.find((group) => group.key === effectiveRole)!;

  return (
    <div
      className="shrink-0 border-b border-line/60 px-4 py-3 space-y-4"
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
        <div data-testid="kb-orch-summary">
          <div className="grid grid-cols-3 gap-2">
            <Metric label="已写单元" value={summary?.unitsWritten ?? 0} />
            <Metric label="已审通过" value={summary?.unitsReviewed ?? 0} />
            <Metric label="待修订" value={summary?.unitsPendingRevision ?? 0} alert={Boolean(summary?.unitsPendingRevision)} />
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            沿用 {summary?.integration.carriedOverDocs ?? 0} 篇
            {summary?.integration.integratePassed ? ' · 整合通过' : ''}
            {summary?.integration.finalReviewDone ? ' · 最终复核完成' : ''}
          </p>
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

      {/* 角色总览与所选角色的真实任务明细。 */}
      {data ? (
        <div className="space-y-3" data-testid="kb-orch-tasks">
          <div>
            <h4 className="text-xs font-kai font-medium text-ink">编排角色</h4>
            <p className="mt-0.5 text-[11px] text-ink-faint">点击角色查看任务与单元状态</p>
          </div>
          <div className="space-y-1.5" data-testid="kb-orch-roles">
            {roleTasks.map((group) => {
              const done = group.latest.filter((task) => task.execState === 'done').length;
              const running = group.latest.some((task) => task.execState === 'running');
              const failed = group.latest.some((task) => task.execState === 'failed');
              const needsDecision = group.latest.some((task) => task.acceptanceState === 'pending_decision');
              const needsRevision = group.latest.some((task) => task.acceptanceState === 'needs_revision');
              const stopped = terminal && group.latest.some((task) => task.execState !== 'done' && task.execState !== 'failed');
              const state = failed ? '失败' : stopped ? '已停止' : running ? '进行中' : needsDecision ? '待裁定' : needsRevision ? '待修订' : group.latest.length === 0 ? '未创建任务'
                : done === group.latest.length ? '已完成' : '等待中';
              return <button key={group.key} type="button" data-role-group={group.key}
                aria-pressed={effectiveRole === group.key} onClick={() => { setSelectedRole(group.key); setTasksOpen(true); }}
                className={`w-full rounded-md border px-3 py-2.5 text-left transition-colors ${effectiveRole === group.key ? 'border-seal/35 bg-seal/5' : 'border-line bg-card-bg hover:bg-paper'}`}>
                <span className="flex items-center gap-2">
                  {running && !terminal ? <Loader2 className="w-3.5 h-3.5 animate-spin text-seal shrink-0" />
                    : done === group.latest.length && done > 0 ? <Check className="w-3.5 h-3.5 text-jade shrink-0" />
                    : <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${failed || needsDecision ? 'bg-seal-2' : 'bg-line'}`} />}
                  <span className="font-kai text-sm font-medium text-ink flex-1">{group.label}</span>
                  <span className={`text-[11px] ${failed || needsDecision || stopped ? 'text-seal-2' : running || needsRevision ? 'text-seal' : 'text-ink-faint'}`}>{state}</span>
                  <span className="text-[11px] font-mono text-ink-faint">{done}/{group.latest.length}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-ink-faint" />
                </span>
                {group.tasks.length > 0 ? <span className="block mt-1 ml-5 text-[11px] text-ink-faint truncate">{orchModelLabel(group.tasks[0].model)}</span> : null}
              </button>;
            })}
          </div>
          <div className="rounded-md border border-line bg-paper/45 p-3" data-testid="kb-orch-role-detail" data-selected-role={effectiveRole}>
            <div className="flex items-center justify-between gap-2">
              <h5 className="font-kai text-sm font-medium text-ink">{selected.label} · 任务明细</h5>
              <span className="text-[11px] text-ink-faint">{selected.latest.filter((task) => task.execState === 'done').length}/{selected.latest.length} 完成</span>
            </div>
            <p className="mt-1 text-[11px] text-ink-soft break-all">模型：{selected.tasks.length ? orchModelLabel(selected.tasks[0].model) : '任务尚未创建'}</p>
            {selected.latest.some((task) => task.blockingIssues > 0) ? <p className="mt-1 text-[11px] text-seal-2">未关闭阻断问题 {selected.latest.reduce((sum, task) => sum + task.blockingIssues, 0)} 项</p> : null}
            <button
              type="button"
              onClick={() => setTasksOpen((value) => !value)}
              aria-expanded={tasksOpen}
              className="mt-3 flex w-full items-center gap-1 border-t border-line/60 pt-2 text-xs text-ink-soft hover:text-ink"
              data-testid="kb-orch-tasks-toggle"
            >
              {tasksOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              任务流水 · {selected.tasks.length} 项
            </button>
            {tasksOpen ? selected.tasks.length ? (
              <ul className="mt-2 max-h-[320px] space-y-2 overflow-y-auto scrollbar-thin">
                {selected.tasks.map((task) => <TaskRow key={task.taskId} task={task} terminal={terminal} />)}
              </ul>
            ) : <p className="mt-2 text-xs text-ink-faint">此角色尚无任务，等待编排生成。</p> : null}
          </div>
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

function Metric({ label, value, alert = false, hint }: { label: string; value: number | string; alert?: boolean; hint?: string }) {
  return <div className={`rounded-md border px-2.5 py-2 ${alert ? 'border-seal/25 bg-seal/5' : 'border-line bg-card-bg'}`}>
    <p className="text-[11px] text-ink-faint">{label}</p>
    <p className={`mt-1 font-mono text-xl leading-none ${alert ? 'text-seal' : typeof value === 'number' ? 'text-ink' : 'text-ink-faint'}`}>{value}</p>
    {hint ? <p className="mt-1 text-[10px] text-ink-faint leading-snug">{hint}</p> : null}
  </div>;
}

function TaskRow({ task, terminal }: { task: KbBuildOrchestrationTaskDto; terminal: boolean }) {
  const waiting = terminal && (task.execState === 'queued' || task.execState === 'running') ? null : waitingReasonOf(task);
  const budget = task.revisionBudget;
  return (
    <li
      className="rounded border border-line bg-card-bg px-2.5 py-2 text-[11px] leading-snug"
      data-task-id={task.taskId}
      data-exec={task.execState}
      data-artifact={task.artifactState}
      data-acceptance={task.acceptanceState}
      data-waiting={waiting?.kind}
    >
      <span className="block mb-1 font-mono text-xs text-ink break-all">{unitLabelOf(task)}</span>
      <span className="flex flex-wrap items-center gap-1">
      {task.round > 0 ? (
        <span className="px-1 rounded bg-[rgba(191,144,4,0.10)] text-[#bf9004]" title={`审查/修订轮次 r${task.round}（尝试 #${task.attempt}）`}>
          修订 r{task.round}
        </span>
      ) : null}
      <AxisBadge axis="执行" label={terminal && (task.execState === 'queued' || task.execState === 'running') ? '已停止' : ORCH_EXEC_LABEL[task.execState] ?? task.execState}
        tone={terminal && (task.execState === 'queued' || task.execState === 'running') ? 'bad' : execTone(task.execState)} />
      <AxisBadge axis="产物" label={ORCH_ARTIFACT_LABEL[task.artifactState] ?? task.artifactState} tone={artifactTone(task.artifactState)} />
      <AxisBadge axis="验收" label={ORCH_ACCEPTANCE_LABEL[task.acceptanceState] ?? task.acceptanceState} tone={acceptanceTone(task.acceptanceState)} />
      {task.execState === 'running' && !terminal ? <Loader2 className="w-3 h-3 animate-spin text-seal shrink-0" /> : null}
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
      </span>
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
