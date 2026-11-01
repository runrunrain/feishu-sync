/**
 * BuildLeaderSupervisor —— 重构 v2《基于Agent基座与工作流插件的构建重构设计》
 * 的 Pi + amagi-pi 模式 Leader 监督闭环（设计 §5/§8/§9）。
 *
 * 本模块是纯监督状态机（不持有运行适配层、不解析原始 RPC）：
 * - 运行层契约（BuildRunSpec/RuntimeBinding/RuntimeEvent/CancelResult）以
 *   agent/build-runtime/contracts.ts 为唯一规范，宿主（build-runtime-host）
 *   负责启动/续接 Leader、合并事件流并在事件转换后喂给本模块。
 * - 首个 agent_end（round_ended）不是构建结束：自触发轮次持续监督；空闲
 *   超宽限先发一次收口提示（只陈述现状），再次空闲以 leader_idle 中断。
 * - 发布终局只认真实工具回执：Leader 经 build_request_publish 工具触发
 *   应用发布校验管线，宿主把管线结果转成 publish_completed 事件——本模块
 *   不再自造 publish_requested，也不重复校验 revision（管线内已锁候选）。
 * - 取消顺序（设计 §9）：先撤代次凭据（知识写入立即停止）→ 关闭 Leader
 *   stdin 宽限终止（默认 10s，覆盖 amagi 2s 清理窗口）→ 残留核实与上报。
 * - 恢复：会话级（原 leaderSessionId 同 agentDir 续接）或成果级（新
 *   Leader + 成果清单）二选一且必须显式；运行版本冻结不一致拒绝会话
 *   恢复；旧 Leader 进程仍存活时拒绝启动第二个 Leader；未知绝不伪造。
 *
 * 宿主喂入的事件类型（RuntimeEvent.type；payload 字段约定）：
 * - round_started{trigger?} / round_ended{aborted?}——RPC 轮次（宿主经
 *   PiRpcProcess round_started/round_settled 事件转出）。
 * - task_created{nativeTaskId,role,requestedRole?,parentTaskId?}——宿主
 *   已在 BuildActorStore.registerTaskCreation 登记成功（真实原生创建结果，
 *   非 RPC 参数推断）；task_resumed{nativeTaskId,role,parentTaskId} 同理。
 * - task_state{nativeTaskId,status}——完成通知/状态观测（amagi 注入的
 *   用户消息解析；短 id 由宿主回解全 id）。
 * - task_activity{nativeTaskId}——桥接工具活动（actorStore 事件）。
 * - publish_window_opened{requestId,candidateRevision} / publish_completed
 *   {requestId,accepted,candidateRevision,summary,status,publication?}——
 *   发布窗口与真实管线结果（rejected 后监督继续，Leader 可修订重试）。
 * - process_exit{code,signal?}——Leader 进程退出（非取消路径=失败）。
 * - leader_usage{input,output}——Leader 末次轮次用量（非累计）。
 * - leader_prompt_failed{message}——初始/续接 prompt 失败（=运行失败）。
 * - leader_abandoned{reason}——Leader 经工具报告无法完成。
 */
import type {
  BuildRunSpec,
  CancelResult,
  RuntimeBinding,
  RuntimeEvent,
} from '../agent/build-runtime/contracts.js';
import type {
  LeaderActorRecord,
  LeaderRunCheckpointState,
  LeaderRunMaterial,
  LeaderRunProgressDto,
} from '../types/agent-knowledge.js';
import type { AgentProcessPool, PoolSlot } from '../agent/agent-process-pool.js';
import { ToolError } from '../agent/agent-tool-service.js';

/** 宿主回调（build-runtime-host 提供；全部真实实现，无脚本假件语义）。 */
export interface LeaderSupervisorCallbacks {
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 进程池（Leader 占 build 通道 1 槽；子任务由 amagi 启动不入池）。 */
  pool: AgentProcessPool;
  /** 检查点持久化（监督状态经构建 entry 随检查点原子落盘）。 */
  persistCheckpoint: () => void;
  /** 撤销当前代次全部应用侧凭据（令牌 + 身份账本代次；知识写入立即停止）。 */
  revokeCredentials: (reason: string) => void;
  /** 换代递增时同步账本/宿主代次（凭据/账本/监督三者同代次；未接线则
   * 工具侧 credential_generation_revoked 全拒——e2e 实测教训）。 */
  rotateGeneration?: (generation: number, reason: string) => void;
  /** 启动（fresh/rebuild）或原会话续接（session）Leader；宿主完成探测、
   * 工具上下文签发与初始 prompt 注入后返回绑定。 */
  startLeader: (input: { spec: BuildRunSpec; resumeMode: 'fresh' | 'session' | 'rebuild' }) => Promise<RuntimeBinding>;
  /** 终止 Leader 进程（宽限）并返回运行层真实取消结果。 */
  cancelLeader: (binding: RuntimeBinding | null) => Promise<CancelResult | null>;
  /** 订阅合并事件流（leader-rpc + tool-service 两来源；宿主转换后喂入）。 */
  events: (binding: RuntimeBinding) => AsyncIterable<RuntimeEvent>;
  /** 空闲收口提示注入（可失败；缺失时仍按 leader_idle 执法）。 */
  nudge: (binding: RuntimeBinding | null, message: string) => Promise<void>;
  /** 当前运行环境冻结值（会话恢复比对；宿主探测产出）。 */
  currentRuntimeFreeze: () => { piVersion: string; amagiContentHash: string; agentDirConfigHash: string; workflowRevision: string };
  /** 成果账本快照计数（进度 DTO 汇总；真相在 BuildActorStore）。 */
  actorSnapshot: () => { acceptedDocumentCount: number; openBlockingCount: number; activeAssignments: number };
  /** 检查点导出钩子（同步 actorStore 全量载荷进检查点；可选）。 */
  exportActorPayload?: () => LeaderRunCheckpointState['actorPayload'];
}

/** 监督终局：publish-accepted 携带真实发布管线结果交回流水线收尾。 */
export type LeaderRunOutcome =
  | {
    kind: 'publish-accepted';
    candidateRevision: string;
    summary: string;
    /** 发布管线结果：published（已发布）/ awaiting_release（confirm 模式停在候选确认） */
    publication: { status: 'published' | 'awaiting_release'; releaseId: string | null; candidateHash: string; result: Record<string, unknown> };
  }
  | { kind: 'leader-abandoned'; reason: string }
  | { kind: 'leader-idle' }
  | { kind: 'leader-failed'; reason: string }
  | { kind: 'cancelled' };

export interface LeaderRunOptions {
  spec: BuildRunSpec;
  signal: AbortSignal;
  /** 空闲判定宽限（无运行轮次 + 已知子任务全部收到完成通知 + 桥接无活动） */
  idleGraceMs?: number;
  /** 恢复方式：fresh=新运行；session=原会话续接；rebuild=成果级重建。 */
  resumeMode?: 'fresh' | 'session' | 'rebuild';
}

/** Leader 终止宽限缺省 10s（运行层同值；此处仅兜底展示）。 */
export const DEFAULT_LEADER_TERMINATE_GRACE_MS = 10_000;
/** 空闲宽限缺省 3 分钟（仅影响收口节奏不影响正确性）。 */
export const DEFAULT_LEADER_IDLE_GRACE_MS = 180_000;

/** 活动子任务判定的非终态 exec 值（其余视为已收到完成通知）。 */
const ACTIVE_EXEC_STATES = new Set(['queued', 'running', 'pending', 'blocked', '']);

/** 进程存活探测（同机同用户；ESRCH=不存在，EPERM=存在但无权限）。 */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 会话恢复的运行冻结比对（设计 §9 恢复第 1 步）：skill 哈希 / Pi 版本 /
 * amagi 包内容哈希 / agentDir 配置哈希——任一不一致拒绝原会话续接。
 */
export function runtimeFreezeMismatches(
  frozen: BuildRunSpec,
  current: { piVersion: string; amagiContentHash: string; agentDirConfigHash: string; workflowRevision: string },
): string[] {
  const mismatches: string[] = [];
  if (frozen.workflowRevision !== current.workflowRevision) {
    mismatches.push(`构建 skill 已变化（${frozen.workflowRevision.slice(0, 12)}… → ${current.workflowRevision.slice(0, 12)}…）`);
  }
  if (frozen.piVersion !== current.piVersion) {
    mismatches.push(`Pi 版本已变化（${frozen.piVersion || '未知'} → ${current.piVersion || '未知'}）`);
  }
  if (frozen.amagiPackage.contentHash !== current.amagiContentHash) {
    mismatches.push('amagi-pi 包内容哈希已变化');
  }
  if (frozen.agentDirConfigHash !== current.agentDirConfigHash) {
    mismatches.push('构建 agentDir 配置哈希已变化');
  }
  return mismatches;
}

/** 初始监督状态（新构建；generation 从 1 起）。 */
export function freshLeaderRunState(spec: BuildRunSpec, material: LeaderRunMaterial): LeaderRunCheckpointState {
  return {
    schemaVersion: 2,
    orchestrationMode: 'pi-amagi',
    generation: spec.generation,
    spec,
    material,
    binding: null,
    eventCursor: {},
    actors: [],
    actorPayload: null,
    idleRemindedAt: null,
    publishRequest: null,
    lastUsage: null,
    endedReason: null,
    updatedAt: new Date().toISOString(),
  };
}

export class BuildLeaderSupervisor {
  private roundsStarted = 0;
  private roundsEnded = 0;
  private roundActive = false;
  private lastActivityAt = Date.now();
  private cancelRequested = false;
  private cancelResult: CancelResult | null = null;
  private cancelPromise: Promise<CancelResult | null> | null = null;
  private slot: PoolSlot | null = null;
  private activeBinding: RuntimeBinding | null = null;
  private credentialsRevoked = false;
  private readonly idleGraceMs: number;
  private readonly idleTickMs: number;

  constructor(
    private readonly cb: LeaderSupervisorCallbacks,
    /** 监督状态（随构建 entry 共享引用；恢复时传入检查点还原）。 */
    public state: LeaderRunCheckpointState,
    options: { idleGraceMs?: number; idleTickMs?: number } = {},
  ) {
    this.idleGraceMs = options.idleGraceMs ?? DEFAULT_LEADER_IDLE_GRACE_MS;
    this.idleTickMs = options.idleTickMs ?? 1_000;
  }

  /** 旧 Leader 是否仍存活（恢复前守卫：活着即拒绝第二个 Leader）。 */
  isOldLeaderAlive(): boolean {
    return isPidAlive(this.state.binding?.leaderPid ?? null);
  }

  /** 恢复级别投影（runtime BuildResumeCapability → UI 三态）。 */
  private static resumeLevelOf(binding: RuntimeBinding | null): 'session' | 'artifact' | 'none' {
    if (!binding) return 'none';
    if (binding.resumeCapability.session) return 'session';
    if (binding.resumeCapability.artifact) return 'artifact';
    return 'none';
  }

  /** 进度 DTO（侧栏/诊断；来源=监督状态 + 宿主成果快照，不虚构字段）。 */
  progress(): LeaderRunProgressDto {
    const snapshot = this.cb.actorSnapshot();
    return {
      buildId: this.state.spec.buildId,
      orchestrationMode: 'pi-amagi',
      generation: this.state.generation,
      leader: this.state.binding
        ? {
          sessionId: this.state.binding.leaderSessionId,
          pid: this.state.binding.leaderPid,
          resumeCapability: BuildLeaderSupervisor.resumeLevelOf(this.state.binding),
        }
        : null,
      tasks: this.state.actors.map((actor) => ({
        nativeTaskId: actor.nativeTaskId,
        role: actor.role,
        parentTaskId: actor.parentTaskId,
        status: actor.status,
        execState: actor.execState,
        lastEventAt: actor.lastEventAt,
      })),
      rounds: { started: this.roundsStarted, ended: this.roundsEnded },
      idle: { remindedAt: this.state.idleRemindedAt, lastActivityAt: new Date(this.lastActivityAt).toISOString() },
      publishRequest: this.state.publishRequest,
      summary: {
        acceptedDocumentCount: snapshot.acceptedDocumentCount,
        openBlockingCount: snapshot.openBlockingCount,
        activeAssignments: snapshot.activeAssignments,
        queueReason: null,
        lastUsage: this.state.lastUsage,
        cumulativeUsage: null,
      },
      endedReason: this.state.endedReason,
      termination: this.cancelRequested ? 'cancelling' : this.state.endedReason ? 'finished' : 'none',
      skill: { path: this.state.spec.workflowSkillPath, revision: this.state.spec.workflowRevision },
      eventCursor: { ...this.state.eventCursor },
      updatedAt: this.state.updatedAt,
    };
  }

  /** 取消入口（幂等）：撤凭据 → 宽限终止 → 残留核实。run() 观察结果收尾。 */
  requestCancel(): Promise<CancelResult | null> {
    if (this.cancelPromise) return this.cancelPromise;
    this.cancelRequested = true;
    this.cancelPromise = (async () => {
      // 1. 先撤代次凭据：知识写入立即停止（设计 §9）。
      this.revokeCredentials('取消');
      // 2. 关闭 Leader stdin 宽限终止 + 子进程回收（运行层按 spec.limits 执法）。
      const binding = this.activeBinding ?? this.state.binding;
      try {
        this.cancelResult = await this.cb.cancelLeader(binding);
      } catch (error) {
        this.cb.log('error', `Leader 终止异常：${error instanceof Error ? error.message : String(error)}`);
        this.cancelResult = {
          leaderExit: null,
          credentialsRevoked: false,
          residualNote: `终止异常：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (this.cancelResult && !this.cancelResult.credentialsRevoked) {
        this.cb.log('warn', `运行层报告凭据未确认撤销（${this.cancelResult.residualNote}）；应用侧令牌已先行撤销`);
      }
      return this.cancelResult;
    })();
    return this.cancelPromise;
  }

  private revokeCredentials(reason: string): void {
    if (this.credentialsRevoked) return;
    this.credentialsRevoked = true;
    try {
      this.cb.revokeCredentials(reason);
      this.cb.log('info', `已撤销第 ${this.state.generation} 代凭据（${reason}）：知识写入通道立即关闭`);
    } catch (error) {
      this.cb.log('error', `撤凭据失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private touch(activity: boolean): void {
    this.state.updatedAt = new Date().toISOString();
    if (activity) this.lastActivityAt = Date.now();
  }

  private persist(critical: boolean): void {
    this.touch(false);
    if (critical) {
      try {
        this.cb.persistCheckpoint();
      } catch (error) {
        this.cb.log('warn', `监督检查点保存失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 会话级恢复前置校验：冻结比对 + 第二 Leader 守卫（不通过抛 ToolError）。 */
  private prepareResume(options: LeaderRunOptions): void {
    if (options.resumeMode === 'fresh') return;
    if (this.isOldLeaderAlive()) {
      throw new ToolError('kb_leader_alive', `上一个 Leader 进程（pid=${this.state.binding?.leaderPid ?? '未知'}）仍在运行，不得启动第二个 Leader；请先取消旧构建或等待其退出`, 409);
    }
    if (options.resumeMode === 'session') {
      const binding = this.state.binding;
      if (!binding || !binding.leaderSessionId || !binding.resumeCapability.session) {
        throw new ToolError('kb_resume_unsupported', '该运行的运行时绑定不支持原会话续接（会话 ID 缺失或能力不足）；请选择成果级恢复或重新构建', 409);
      }
      const mismatches = runtimeFreezeMismatches(this.state.spec, this.cb.currentRuntimeFreeze());
      if (mismatches.length > 0) {
        throw new ToolError('kb_resume_runtime_changed', `运行环境冻结项与检查点不一致，拒绝原会话续接（可显式选择成果级恢复）：${mismatches.join('；')}`, 409);
      }
    }
    // 恢复换代：旧代次凭据撤销 + 代次递增（会话级与成果级一致；成果级
    // 另携带成果清单，由流水线在 spec 之外交代，不伪造会话记忆）。
    this.revokeCredentials('恢复换代');
    const generation = this.state.generation + 1;
    // 原地变更（不替换对象）：entry.leaderRun 与本监督器状态保持同一引用，
    // 服务侧直写（发布快照/结算锁）与检查点持久化始终看到最新状态。
    this.state.generation = generation;
    this.state.spec = { ...this.state.spec, generation };
    this.state.endedReason = null;
    this.state.idleRemindedAt = null;
    options.spec = { ...options.spec, generation };
    this.cb.rotateGeneration?.(generation, '恢复换代（账本/宿主同步 rotate）');
    this.credentialsRevoked = false; // 新代次凭据由宿主在 startLeader 签发
  }

  /** 监督主循环。终局前撤凭据；任何路径都释放进程池槽位。 */
  async run(options: LeaderRunOptions): Promise<LeaderRunOutcome> {
    const signal = options.signal;
    const resumeMode = options.resumeMode ?? 'fresh';
    let outcome: LeaderRunOutcome | null = null;
    const onAbort = () => { void this.requestCancel(); };
    if (signal.aborted) void this.requestCancel();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      // 1. 恢复守卫（会话级冻结比对 + 第二 Leader 守卫 + 换代）。
      this.prepareResume(options);

      // 2. Leader 占进程池 build 通道 1 个槽位（子任务由 amagi 启动，不入池）。
      this.slot = await this.acquireSlot(signal);

      // 3. 启动/续接 Leader（宿主：探测 + 上下文签发 + 初始 prompt）。
      this.revokeCredentials(resumeMode === 'fresh' ? '启动新代次前兜底' : '恢复换代');
      this.credentialsRevoked = false;
      this.activeBinding = await this.cb.startLeader({ spec: options.spec, resumeMode });
      this.state.binding = this.activeBinding;
      this.lastActivityAt = Date.now();
      this.cb.log('info', `Leader 已启动（${resumeMode === 'session' ? `原会话续接 ${this.activeBinding.leaderSessionId}` : resumeMode === 'rebuild' ? '成果级重建' : '新会话'}，pid=${this.activeBinding.leaderPid ?? '未知'}，agentDir=${this.activeBinding.agentDir}）`);
      this.persist(true);

      // 4. 事件监督循环。
      outcome = await this.supervise(signal);
    } finally {
      signal.removeEventListener('abort', onAbort);
      // 终局撤凭据：发布申请后进入校验/发布，不再接受任何模型写入。
      this.revokeCredentials('监督结束');
      // Leader 进程一并关闭（任何终局——含发布成功——都不再需要它；
      // 宽限终止幂等；已走 requestCancel 的路径不重复）。
      if (this.activeBinding && !this.cancelResult) {
        try {
          await this.cb.cancelLeader(this.activeBinding);
        } catch { /* 已尽力：残留由取消结果如实暴露 */ }
      }
      this.state.endedReason = this.state.endedReason ?? (outcome ? outcome.kind : 'error');
      // 原地更新（保引用）：entry.leaderRun 与服务侧直写始终可见同一对象。
      this.state.binding = this.activeBinding ?? this.state.binding;
      this.state.actorPayload = this.exportActorPayloadForCheckpoint();
      this.persist(true);
      this.slot?.release();
      this.slot = null;
    }
    return outcome ?? { kind: 'cancelled' };
  }

  /** 进程池槽位获取（build 通道 1 槽）。 */
  protected async acquireSlot(signal: AbortSignal): Promise<PoolSlot> {
    return this.cb.pool.acquire('build', { signal });
  }

  /** 检查点导出钩子（宿主注入；同步 actorStore 全量载荷进检查点）。 */
  protected exportActorPayloadForCheckpoint(): LeaderRunCheckpointState['actorPayload'] {
    return this.cb.exportActorPayload ? this.cb.exportActorPayload() : this.state.actorPayload;
  }

  /** 去重缓存（本代次内重放事件；cap 后淘汰最旧）。 */
  private readonly processedEventIds = new Map<string, true>();
  private static readonly EVENT_DEDUP_CAP = 4096;

  private rememberEvent(dedupKey: string): void {
    this.processedEventIds.set(dedupKey, true);
    if (this.processedEventIds.size > BuildLeaderSupervisor.EVENT_DEDUP_CAP) {
      const oldest = this.processedEventIds.keys().next().value;
      if (oldest !== undefined) this.processedEventIds.delete(oldest);
    }
  }

  private upsertActor(record: Partial<Omit<LeaderActorRecord, 'generation' | 'lastEventAt'>> & { nativeTaskId: string }): void {
    const now = new Date().toISOString();
    const existing = this.state.actors.find((actor) => actor.nativeTaskId === record.nativeTaskId);
    if (existing) {
      existing.role = record.role ?? existing.role;
      existing.parentTaskId = record.parentTaskId ?? existing.parentTaskId;
      existing.status = record.status ?? existing.status;
      existing.execState = record.execState ?? existing.execState;
      existing.lastEventAt = now;
      return;
    }
    this.state.actors.push({
      nativeTaskId: record.nativeTaskId,
      parentTaskId: record.parentTaskId ?? null,
      generation: this.state.generation,
      role: record.role ?? 'unknown',
      status: record.status ?? 'pending',
      execState: record.execState ?? null,
      lastEventAt: now,
    });
  }

  /** 应用单条运行事件（轮次/身份/终局判定）。 */
  private applyEvent(event: RuntimeEvent): { critical: boolean; outcome: LeaderRunOutcome | null } {
    // 去重键含代次：跨代次重启后 runtime 事件序号重新从 e1 起，不复用旧键。
    const dedupKey = event.eventId ? `${event.generation}:${event.source}:${event.eventId}` : null;
    if (dedupKey) {
      if (this.processedEventIds.has(dedupKey)) return { critical: false, outcome: null };
      this.rememberEvent(dedupKey);
    }
    const cursorValue = event.eventId ?? event.nativeEventId;
    if (cursorValue) this.state.eventCursor[event.source] = cursorValue;
    this.touch(true);
    const payload = event.payload ?? {};
    const taskId = typeof payload.nativeTaskId === 'string' ? payload.nativeTaskId : event.taskId ?? null;
    switch (event.type) {
      case 'round_started':
        this.roundActive = true;
        this.roundsStarted += 1;
        return { critical: false, outcome: null };
      case 'round_ended':
        // 首个 agent_end 不代表构建结束（后台完成会触发 Leader 新一轮）。
        this.roundActive = false;
        this.roundsEnded += 1;
        this.cb.log('info', `Leader 第 ${this.roundsEnded} 轮结束（agent_end ≠ 构建结束），继续监督`);
        return { critical: true, outcome: null };
      case 'task_created': {
        if (!taskId) return { critical: false, outcome: null };
        this.upsertActor({
          nativeTaskId: taskId,
          role: typeof payload.role === 'string' ? payload.role : 'unknown',
          parentTaskId: typeof payload.parentTaskId === 'string' ? payload.parentTaskId : null,
          status: 'confirmed',
          execState: 'running',
        });
        return { critical: true, outcome: null };
      }
      case 'task_resumed': {
        if (!taskId) return { critical: false, outcome: null };
        // 续接：新任务 ID 按父链继承角色；原任务写资格由成果账本撤销。
        const parent = typeof payload.parentTaskId === 'string' ? payload.parentTaskId : null;
        const parentRole = parent ? this.state.actors.find((actor) => actor.nativeTaskId === parent)?.role : undefined;
        this.upsertActor({
          nativeTaskId: taskId,
          role: typeof payload.role === 'string' ? payload.role : parentRole ?? 'unknown',
          parentTaskId: parent,
          status: 'confirmed',
          execState: 'running',
        });
        if (parent) {
          const parentActor = this.state.actors.find((actor) => actor.nativeTaskId === parent);
          if (parentActor) parentActor.status = 'revoked';
        }
        return { critical: true, outcome: null };
      }
      case 'task_state':
      case 'task_activity': {
        if (!taskId) return { critical: false, outcome: null };
        const status = typeof payload.status === 'string' ? payload.status : null;
        const actor = this.state.actors.find((candidate) => candidate.nativeTaskId === taskId);
        if (actor) {
          if (status) actor.execState = status;
          actor.lastEventAt = new Date().toISOString();
        } else if (status) {
          // 桥接先于创建事件到达：待确认身份（设计 §4.1；登记真相在账本）。
          this.upsertActor({ nativeTaskId: taskId, role: 'unknown', status: 'pending', execState: status });
        }
        const terminal = status === 'done' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
        return { critical: terminal, outcome: null };
      }
      case 'publish_window_opened': {
        const candidateRevision = typeof payload.candidateRevision === 'string' ? payload.candidateRevision : '';
        this.state.publishRequest = {
          requestId: typeof payload.requestId === 'string' ? payload.requestId : null,
          candidateRevision,
          summary: typeof payload.summary === 'string' ? payload.summary : '',
          accepted: false,
          status: 'pending',
          decidedAt: new Date().toISOString(),
        };
        this.cb.log('info', `Leader 申请发布（候选 ${candidateRevision.slice(0, 12)}…），发布校验管线锁定候选执行中`);
        return { critical: true, outcome: null };
      }
      case 'publish_completed': {
        const candidateRevision = typeof payload.candidateRevision === 'string' ? payload.candidateRevision : '';
        const accepted = payload.accepted === true;
        const status = typeof payload.status === 'string' ? payload.status : accepted ? 'accepted' : 'rejected';
        this.state.publishRequest = {
          requestId: typeof payload.requestId === 'string' ? payload.requestId : null,
          candidateRevision,
          summary: typeof payload.summary === 'string' ? payload.summary : '',
          accepted,
          status: status as 'accepted' | 'rejected' | 'not_wired' | 'pending',
          decidedAt: new Date().toISOString(),
        };
        if (accepted && payload.publication && typeof payload.publication === 'object') {
          const publication = payload.publication as { status?: unknown; releaseId?: unknown; candidateHash?: unknown; result?: unknown };
          const pubStatus = publication.status === 'awaiting_release' ? 'awaiting_release' : 'published';
          this.cb.log('info', `发布校验管线接受候选 ${candidateRevision.slice(0, 12)}…（${pubStatus}），交回流水线收尾`);
          return {
            critical: true,
            outcome: {
              kind: 'publish-accepted',
              candidateRevision,
              summary: typeof payload.summary === 'string' ? payload.summary : '',
              publication: {
                status: pubStatus,
                releaseId: typeof publication.releaseId === 'string' ? publication.releaseId : null,
                candidateHash: typeof publication.candidateHash === 'string' ? publication.candidateHash : candidateRevision,
                result: (publication.result && typeof publication.result === 'object' ? publication.result : {}) as Record<string, unknown>,
              },
            },
          };
        }
        this.cb.log('warn', `发布申请被拒（${status}）：${typeof payload.reason === 'string' ? payload.reason : '候选校验未通过'}；Leader 可修订后重新申请`);
        return { critical: true, outcome: null };
      }
      case 'leader_usage': {
        const input = typeof payload.input === 'number' ? payload.input : null;
        const output = typeof payload.output === 'number' ? payload.output : null;
        if (input !== null || output !== null) {
          this.state.lastUsage = { inputTokens: input ?? 0, outputTokens: output ?? 0, at: new Date().toISOString() };
        }
        return { critical: false, outcome: null };
      }
      case 'leader_abandoned': {
        const reason = typeof payload.reason === 'string' ? payload.reason : 'Leader 报告无法完成';
        this.cb.log('warn', `Leader 报告无法完成：${reason}`);
        return { critical: true, outcome: { kind: 'leader-abandoned', reason } };
      }
      case 'leader_prompt_failed': {
        const reason = `Leader prompt 失败：${typeof payload.message === 'string' ? payload.message : '未知错误'}`;
        this.cb.log('error', reason);
        return { critical: true, outcome: { kind: 'leader-failed', reason } };
      }
      case 'process_exit': {
        if (this.cancelRequested) return { critical: false, outcome: null };
        const code = payload.code;
        const reason = `Leader 进程异常退出${typeof code === 'number' ? `（code=${code}）` : ''}`;
        this.cb.log('error', reason);
        return { critical: true, outcome: { kind: 'leader-failed', reason } };
      }
      default:
        return { critical: false, outcome: null };
    }
  }

  /** 空闲判定（设计 §5.4）：无运行轮次 + 已知子任务都已收到完成通知 +
   * 桥接无活动，持续超过宽限。首次只提醒一次；再次空闲 → leader_idle。 */
  private evaluateIdle(): LeaderRunOutcome | null {
    if (this.roundActive) return null;
    const activeActors = this.state.actors.filter(
      (actor) => actor.status !== 'revoked' && ACTIVE_EXEC_STATES.has(actor.execState ?? ''),
    );
    if (activeActors.length > 0) return null;
    if (Date.now() - this.lastActivityAt < this.idleGraceMs) return null;
    if (!this.state.idleRemindedAt) {
      this.state.idleRemindedAt = new Date().toISOString();
      // 提示只陈述现状，不指定下一项任务（设计 §5.4）。
      const message = '当前没有运行中的轮次，已知子任务均已收到完成通知，且尚未申请发布。请收口：申请发布具体候选版本，或经工具报告无法完成的原因。';
      this.lastActivityAt = Date.now();
      void this.cb.nudge(this.activeBinding, message).catch((error) => {
        this.cb.log('warn', `收口提示注入失败：${error instanceof Error ? error.message : String(error)}`);
      });
      this.cb.log('warn', 'Leader 空闲宽限已过，已发送一次收口提示；再次空闲将按 leader_idle 结束');
      this.persist(true);
      return null;
    }
    this.cb.log('warn', 'Leader 提示后仍空闲，按 leader_idle 中断（候选与问题清单已保留在检查点）');
    return { kind: 'leader-idle' };
  }

  /** 事件监督循环：单条 pending next 跨 tick 复用（不重复调用迭代器）。 */
  private async supervise(signal: AbortSignal): Promise<LeaderRunOutcome | null> {
    const iterator = this.cb.events(this.activeBinding!)[Symbol.asyncIterator]();
    const IDLE_TICK_MS = this.idleTickMs;
    let pending: Promise<IteratorResult<RuntimeEvent>> | null = null;
    let outcome: LeaderRunOutcome | null = null;
    while (!outcome && !signal.aborted) {
      if (this.cancelRequested) {
        await this.cancelPromise;
        outcome = { kind: 'cancelled' };
        break;
      }
      if (!pending) pending = iterator.next();
      const raced = await Promise.race([
        pending.then(
          (result) => ({ kind: 'event' as const, result }),
          (error: unknown) => ({ kind: 'stream-error' as const, error }),
        ),
        new Promise<{ kind: 'tick' }>((resolve) => {
          const timer = setTimeout(() => resolve({ kind: 'tick' }), IDLE_TICK_MS);
          (timer as NodeJS.Timeout & { unref?: () => void }).unref?.();
        }),
      ]);
      if (raced.kind === 'stream-error') {
        if (!this.cancelRequested) {
          const reason = `运行事件流异常：${raced.error instanceof Error ? raced.error.message : String(raced.error)}`;
          this.cb.log('error', reason);
          outcome = { kind: 'leader-failed', reason };
        }
        break;
      }
      if (raced.kind === 'event') {
        pending = null;
        if (raced.result.done) {
          // 事件流结束且非取消路径：按 Leader 失败处理（不伪造会话状态）。
          if (!this.cancelRequested) {
            this.cb.log('error', '运行事件流提前结束（Leader 或适配层异常）');
            outcome = { kind: 'leader-failed', reason: '运行事件流提前结束' };
          }
          break;
        }
        const { critical, outcome: eventOutcome } = this.applyEvent(raced.result.value);
        if (eventOutcome) outcome = eventOutcome;
        else this.persist(critical);
      } else {
        const idleOutcome = this.evaluateIdle();
        if (idleOutcome) outcome = idleOutcome;
      }
    }
    if (!outcome && signal.aborted) {
      await this.cancelPromise;
      outcome = { kind: 'cancelled' };
    }
    // 关闭事件流（宿主释放订阅资源）。轮询型生成器可能长期不 yield，
    // return() 不设无限等待——限时后放行，不在收尾上悬挂监督终局。
    if (iterator.return) {
      await Promise.race([
        Promise.resolve(iterator.return()).then((closed) => closed),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          (timer as NodeJS.Timeout & { unref?: () => void }).unref?.();
        }),
      ]).catch(() => undefined);
    }
    return outcome;
  }
}
