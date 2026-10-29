/**
 * CloudMoveService — 安全移出（wiki → 云空间，P2-S6，lark-cli-newcaps-P2
 * §3.1/§3.4/§3.5/§3.6）。
 *
 * 用途与边界（§3.1）：移出到云空间是删除的安全替代——文档仍在，权限变
 * 为云空间模型。本应用只提供「单篇、叶子、人发起」的移出；移回知识库、
 * 批量移出、整子树移出不提供。命令面三条命令全部 agentExposed=false
 * （仅人工，Agent 工具面不可见——见 ops/command-table 的 cloud.move_*）。
 *
 * 状态机（§3.6，任务书命名；与设计 §3.3 状态列的映射：
 * pending=started / moving=running / moved=done）：
 *
 *   pending ──CLI 同步完成──▶ moved ──▶ 触发一次变更检测（只推进观测字段）
 *      ├──异步任务──▶ moving ──轮询 done──▶ moved
 *      │                 ├──轮询 failed──▶ failed（可重新发起；新发起是新行）
 *      │                 └──超 10 分钟/丢失 task_id──▶ unknown
 *      ├──业务错误──▶ failed
 *      └──子进程超时/不可解析/重启──▶ unknown
 *
 * 本地语义（§3.5，移出仅云端动作）：documents 行与本地文件不动；标准库
 * 快照照常包含该源；不自动转归档。moved 后该 objToken 的本地编辑与写回
 * 一律拒绝 source_moved_out（SourceEditService / FeishuWriteService 入口
 * 门）；pending/moving **以及 unknown**（T4b-05：超时/不可解析/重启对账
 * ——云端可能仍在执行或已执行）期间一律拒绝 cloud_move_running，与
 * cloud_revert_running 同风格互斥，共享状态源 = cloud_moves.state；
 * unknown 只经 reconcileUnknownMove 权威核对（真实查询任务状态或节点
 * 归属证明未移出）后解除。检测链按既有语义观察文档不在树中，展示层
 * 语义不在本切片。
 *
 * 轮询器（§3.4）：tick 5s 扫描 tracked 行（poll_after_ms 优先，缺省间隔
 * 5s），单行总上限 10 分钟，超限 → unknown；状态查询失败不判终态按节奏
 * 续查。进程内单例（index.ts 构造 + DI 注入 routes/feishu），重启经
 * resumeRunningMoves 对账：pending → unknown；moving 有 task_id → 续查
 * （10 分钟窗口自续查起算）；moving 无 task_id → unknown。
 *
 * 审计：<dataRoot>/agent/audit/source-pushes.jsonl（与写回/回滚同文件），
 * 事件 move_to_drive_started|moving|moved|failed|unknown（T4b-06：命令
 * 发出后输出不可解析/异步响应缺必要字段 → unknown，不重发；T4b-10：
 * 关键互斥/任务标识状态写失败 → state_persist_failed 审计 + persistWarning，
 * 行保持 pending/moving 围栏 fail-closed，进程内轮询照常收敛、重启对账
 * 兜底）。不记正文。
 *
 * 【待 S5 实测校正】moveWikiNodeToDrive / getDriveTaskResult 的真实输出
 * 字段（task_id 形态、state 键名、poll 间隔建议）按通用异步模式实现，
 * S5 实测后校正（见 lark-cli-client 两方法的同名标注）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { LarkCliError } from '../modules/lark-cli-client.js';
import type { SourceEditActor } from '../types/index.js';
import { sharedSourceWriteLock, type SourceWriteLockLike } from './source-write-lock.js';

/** 服务级错误：code/status 对齐设计 §8；响应体 { error, message, details? }。 */
export class CloudMoveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CloudMoveError';
  }
}

// ---------------------------------------------------------------------------
// 常量与纯函数（命令表 confirmPlan 同源消费）
// ---------------------------------------------------------------------------

/** 移出确认值基段（完整值 = `MOVE_OUT:<wikiNodeToken>`）。 */
export const MOVE_OUT_CONFIRM_BASE = 'MOVE_OUT';

/**
 * 派生移出确认值：wiki node token 必须出现在确认值中（任务书）。
 * CLI 内部转发（actor='cli'）允许基值 MOVE_OUT——服务端用 documents 行
 * 权威 nodeToken 升级；CLI 通道已过本地 --yes 门（退出码 4）与
 * /api/cli/:command 确认门（422）双重显式确认，不降低确认强度。
 */
export function deriveMoveOutConfirmValue(nodeToken: string): string {
  return `${MOVE_OUT_CONFIRM_BASE}:${nodeToken}`;
}

/** 移出后果固定文案（设计 §3.4：预览与确认弹窗原样展示）。 */
export function moveOutConsequences(watchedRootLabel: string): string[] {
  return [
    `文档将离开知识库「${watchedRootLabel}」`,
    '知识库成员将不再通过知识库权限访问它',
    '本应用将停止同步该文档，本地文件与标准库内容保持不变',
    '本应用不提供移回',
  ];
}

// ---------------------------------------------------------------------------
// DTO（routes/feishu 消费；types/index.ts 不动——并行任务写面）
// ---------------------------------------------------------------------------

export type CloudMoveBlockedReason =
  | 'not_watched_root'
  | 'has_children'
  | 'node_not_found'
  | 'local_edit_pending'
  | 'cloud_revert_running'
  | 'cloud_move_running'
  | 'kb_build_active';

export interface MoveOutPreview {
  objToken: string;
  title: string;
  nodeToken: string;
  watchedRootId: string | null;
  watchedRootLabel: string;
  hasChildren: boolean;
  target: { folderToken: string | null; label: string };
  consequences: string[];
  blockedReason: CloudMoveBlockedReason | null;
}

export interface MoveOutResult {
  /** 同步完成 moved / 异步起步 moving（HTTP 202）。 */
  state: 'moved' | 'moving';
  moveId: string;
  taskId: string | null;
  nodeToken: string;
  /**
   * T4b-10：关键状态（moving/taskId）持久化降级说明（瞬时 DB 异常等
   * ——行保持 pending 围栏 + 进程内轮询继续；重启对账收敛为 unknown）。
   * 缺省无此字段＝关键写入已落盘。
   */
  persistWarning?: string;
}

export interface CloudMoveServiceDeps {
  /** ConfigManager 面：读 watchedRoots（label 解析）。 */
  config: {
    getConfig?: () => Record<string, any> | undefined | null;
  };
  /** LocalMapStore：documents 行 + cloud_moves 行 + source_edits/source_push_log 门源。 */
  store: any;
  /** LarkCliClient：getNode / moveWikiNodeToDrive / getDriveTaskResult。 */
  larkCliClient: any;
  /** 构建活跃探针（接线同写回链）。 */
  kbBuild: { isActive(): boolean };
  /** 数据根（审计落点）。 */
  dataRoot: string;
  /** 与 SyncEngine / 写回链共享的 per-token 锁；缺省进程级共享实例。 */
  locks?: SourceWriteLockLike;
  /**
   * moved 收尾（§3.4 锁外）：触发该 watchedRoot 的一次既有变更检测
   * （只推进观测字段）。best-effort——失败只记控制台，交检测链自然收敛。
   */
  detectRoot?(watchedRootId: string): Promise<unknown>;
  /** 轮询器节奏（测试注入；缺省 tick 5s / 单行间隔 5s / 单行上限 10 分钟）。 */
  poller?: {
    tickMs?: number;
    defaultIntervalMs?: number;
    deadlineMs?: number;
    now?: () => number;
  };
}

/** 轮询器跟踪中的移出行（进程内存活；重启经 resumeRunningMoves 重建）。 */
interface TrackedMove {
  moveId: string;
  objToken: string;
  watchedRootId: string | null;
  taskId: string;
  intervalMs: number;
  firstSeenAt: number;
  nextPollAt: number;
}

export class CloudMoveService {
  private readonly pollerTickMs: number;
  private readonly pollerDefaultIntervalMs: number;
  private readonly pollerDeadlineMs: number;
  private readonly now: () => number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tracked = new Map<string, TrackedMove>();
  private polling = false;

  constructor(private readonly deps: CloudMoveServiceDeps) {
    this.pollerTickMs = deps.poller?.tickMs ?? 5_000;
    this.pollerDefaultIntervalMs = deps.poller?.defaultIntervalMs ?? 5_000;
    this.pollerDeadlineMs = deps.poller?.deadlineMs ?? 600_000;
    this.now = deps.poller?.now ?? Date.now;
  }

  private get locks(): SourceWriteLockLike {
    return this.deps.locks ?? sharedSourceWriteLock;
  }

  private auditPath(): string {
    return path.join(this.deps.dataRoot, 'agent', 'audit', 'source-pushes.jsonl');
  }

  /** 审计追加（与写回/回滚同文件同容错：失败只记控制台）。 */
  private appendAudit(event: string, entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath()), { recursive: true });
      fs.appendFileSync(
        this.auditPath(),
        `${JSON.stringify({ time: new Date().toISOString(), event, ...entry })}\n`,
      );
    } catch (error) {
      console.error('[CloudMoveService] audit append failed:', error);
    }
  }

  // safeUpdate 已在 T4b-10 修复中移除：cloud_moves 的全部状态写都是互斥/
  // 任务标识关键写，统一走 criticalUpdate（异常与 false 返回都不按成功处理）。

  // =========================================================================
  // 门槛与身份
  // =========================================================================

  /** watchedRoot 可读名（watchedRoots 无 label 字段，用 localDir；缺失回退 id）。 */
  private watchedRootLabel(watchedRootId: string): string {
    const roots = this.deps.config.getConfig?.()?.watchedRoots;
    const root = Array.isArray(roots) ? roots.find((item: any) => item?.id === watchedRootId) : null;
    return typeof root?.localDir === 'string' && root.localDir !== '' ? root.localDir : watchedRootId;
  }

  private blockedError(reason: CloudMoveBlockedReason): CloudMoveError {
    switch (reason) {
      case 'not_watched_root':
        return new CloudMoveError(
          'not_watched_root',
          '只有结构树（watchedRoot）成员且带 wiki 节点身份的文档才能移出：归档文档/无节点身份不支持',
          422,
        );
      case 'has_children':
        return new CloudMoveError(
          'has_children',
          '该节点有子节点，只支持移出单篇叶子文档（请先处理子节点）',
          422,
        );
      case 'node_not_found':
        return new CloudMoveError(
          'node_not_found',
          '知识库中已不存在该节点（可能已被移动或删除），无法移出',
          422,
        );
      case 'local_edit_pending':
        return new CloudMoveError(
          'local_edit_pending',
          '该文档有未写回的本地修改：请先写回或放弃本地修改，再移出到云空间',
          409,
        );
      case 'cloud_revert_running':
        return new CloudMoveError(
          'cloud_revert_running',
          '该文档的云端回滚进行中或结果未知，请在写回记录中核对任务状态后再移出',
          409,
        );
      case 'cloud_move_running':
        return new CloudMoveError(
          'cloud_move_running',
          '该文档已有进行中或结果未知的移出（pending/moving/unknown 均围栏）：请先在移出记录完成权威核对（确认未移出后再操作）',
          409,
        );
      case 'kb_build_active':
        return new CloudMoveError(
          'kb_build_active',
          '标准库构建进行中，暂不能移出到云空间（构建结束或取消后再试）',
          409,
        );
    }
  }

  /** 结构身份（§3.4 门控前提）：documents 行有 watched_root_id 与 wiki_node_token。 */
  private requireIdentity(objToken: string): {
    nodeToken: string;
    watchedRootId: string;
    title: string;
  } {
    const doc = this.deps.store.getDocumentByObjToken?.(objToken) ?? null;
    if (!doc) {
      throw new CloudMoveError('source_not_found', `文档不在库中：${objToken}`, 404);
    }
    const nodeToken = typeof doc.wikiNodeToken === 'string' && doc.wikiNodeToken !== ''
      ? doc.wikiNodeToken : null;
    const watchedRootId = typeof doc.watchedRootId === 'string' && doc.watchedRootId !== ''
      ? doc.watchedRootId : null;
    if (!nodeToken || !watchedRootId) throw this.blockedError('not_watched_root');
    return { nodeToken, watchedRootId, title: doc.title ?? '' };
  }

  /** 实时取节点信息（§3.4 步骤 2）：has_child → blocked；取不到 → not_found。 */
  private async fetchNodeState(nodeToken: string, objToken: string): Promise<{ hasChildren: boolean } | null> {
    try {
      const node = await this.deps.larkCliClient.getNode(nodeToken);
      if (!node || typeof node !== 'object') return null;
      // 不完整或身份不一致的响应不能证明目标是该文档的叶节点。
      if (node.obj_token !== objToken || typeof node.has_child !== 'boolean') return null;
      return { hasChildren: node.has_child };
    } catch (error) {
      // 节点不存在/无权限：getNode 抛 LarkCliError——移出面统一按
      // not_found 处理（原始错误进日志，不吞）。
      console.error('[CloudMoveService] getNode failed:', error);
      return null;
    }
  }

  /** 非云端门控（§3.4 步骤 1 的本地部分）。 */
  private evaluateLocalGates(objToken: string): CloudMoveBlockedReason | null {
    if (this.deps.kbBuild?.isActive()) return 'kb_build_active';
    const edit = this.deps.store.getSourceEdit?.(objToken) ?? null;
    if (edit && (edit.state === 'dirty' || edit.state === 'pushing' || edit.state === 'conflict')) {
      return 'local_edit_pending';
    }
    if (this.deps.store.getRunningRevertPushLog?.(objToken) != null) return 'cloud_revert_running';
    if (this.deps.store.getActiveCloudMove?.(objToken) != null) return 'cloud_move_running';
    return null;
  }

  /** 综合门控（preview 与执行复核同判定——批准与执行之间状态可能变化）。 */
  private async evaluateGates(objToken: string): Promise<{
    blockedReason: CloudMoveBlockedReason | null;
    identity: { nodeToken: string; watchedRootId: string; title: string } | null;
    hasChildren: boolean | null;
  }> {
    const identity = this.requireIdentity(objToken);
    const local = this.evaluateLocalGates(objToken);
    if (local != null) return { blockedReason: local, identity, hasChildren: null };
    const node = await this.fetchNodeState(identity.nodeToken, objToken);
    if (node == null) return { blockedReason: 'node_not_found', identity, hasChildren: null };
    if (node.hasChildren) return { blockedReason: 'has_children', identity, hasChildren: true };
    return { blockedReason: null, identity, hasChildren: false };
  }

  // =========================================================================
  // buildMoveOutPreview —— 移出预览（§3.4 preview DTO）
  // =========================================================================

  async buildMoveOutPreview(
    objToken: string,
    opts: { folderToken?: string | null } = {},
  ): Promise<MoveOutPreview> {
    const folderToken = this.normalizeFolderToken(opts.folderToken);
    const gates = await this.evaluateGates(objToken);
    const identity = gates.identity!;
    const label = this.watchedRootLabel(identity.watchedRootId);
    return {
      objToken,
      title: identity.title,
      nodeToken: identity.nodeToken,
      watchedRootId: identity.watchedRootId,
      watchedRootLabel: label,
      hasChildren: gates.hasChildren === true,
      target: {
        folderToken,
        label: folderToken ?? '个人空间根',
      },
      consequences: moveOutConsequences(label),
      blockedReason: gates.blockedReason,
    };
  }

  private normalizeFolderToken(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length !== 0 ? value.trim() : null;
  }

  // =========================================================================
  // moveToDrive —— 执行移出（§3.4；destructive 逐次确认）
  // =========================================================================

  async moveToDrive(
    objToken: string,
    options: { folderToken?: string | null; confirmValue: unknown; actor?: SourceEditActor },
  ): Promise<MoveOutResult> {
    const actor: SourceEditActor = options.actor === 'cli' || options.actor === 'agent' ? options.actor : 'ui';
    // 身份先行（确认值派生依赖 nodeToken）；锁外快检 fail fast。
    const identity = this.requireIdentity(objToken);
    const expected = deriveMoveOutConfirmValue(identity.nodeToken);
    const confirmOk = options.confirmValue === expected
      || (options.confirmValue === MOVE_OUT_CONFIRM_BASE && actor === 'cli');
    if (typeof options.confirmValue !== 'string' || !confirmOk) {
      throw new CloudMoveError(
        'confirmation_required',
        `移出到云空间需要 confirm: "${expected}"（确认值必须包含文档的 wiki node token）`,
        400,
        { expected },
      );
    }
    const folderToken = this.normalizeFolderToken(options.folderToken);
    const gates = await this.evaluateGates(objToken);
    if (gates.blockedReason) throw this.blockedError(gates.blockedReason);
    const outcome = await this.locks.withLock(objToken, () =>
      this.moveToDriveLocked(objToken, identity, folderToken, actor));
    if (outcome.state === 'moved') {
      // 锁外收尾（§3.4）：触发一次既有变更检测（只推进观测字段）。
      // best-effort——失败交检测链自然收敛，不影响移出结果。
      await this.triggerDetect({ ...outcome, watchedRootId: identity.watchedRootId });
    }
    return outcome;
  }

  private async moveToDriveLocked(
    objToken: string,
    identity: { nodeToken: string; watchedRootId: string; title: string },
    folderToken: string | null,
    actor: SourceEditActor,
  ): Promise<MoveOutResult> {
    // §3.4 步骤 1 复核：批准与执行之间状态可能变化，锁内读 DB 权威。
    const gates = await this.evaluateGates(objToken);
    if (gates.blockedReason) throw this.blockedError(gates.blockedReason);
    const latest = this.requireIdentity(objToken);
    if (gates.identity?.nodeToken !== identity.nodeToken || gates.identity.watchedRootId !== identity.watchedRootId
      || latest.nodeToken !== identity.nodeToken || latest.watchedRootId !== identity.watchedRootId) {
      throw new CloudMoveError('source_identity_changed', '文档节点或所属同步根已变化，请刷新预览后重新确认', 409);
    }
    // 步骤 3：INSERT pending 行 + 审计 started。
    const moveId: string = this.deps.store.insertCloudMove({
      objToken,
      wikiNodeToken: identity.nodeToken,
      watchedRootId: identity.watchedRootId,
      title: identity.title,
      targetFolderToken: folderToken,
      actor,
    });
    this.appendAudit('move_to_drive_started', {
      objToken, moveId, nodeToken: identity.nodeToken,
      watchedRootId: identity.watchedRootId, targetFolderToken: folderToken, actor,
    });
    // 步骤 4：move 起步（非幂等，绝不重试）。pending 围栏行已在步骤 3
    // 落盘（写不进就不放行执行——insert 抛错直接失败，零云端调用）。
    try {
      const result = await this.deps.larkCliClient.moveWikiNodeToDrive(identity.nodeToken, { folderToken });
      if (result.state === 'done') {
        // 终态 moved 是围栏释放写（T4b-10 critical）：失败时行保持
        // pending（fail-closed），交重启对账收敛。
        const persisted = this.criticalUpdate(moveId, (store) =>
          store.updateCloudMove(moveId, { state: 'moved' }));
        this.appendAudit('move_to_drive_moved', {
          objToken, moveId, nodeToken: identity.nodeToken, actor,
          ...(persisted ? {} : { persistWarning: 'moved_state_persist_failed_fence_pending_kept' }),
        });
        return {
          state: 'moved', moveId, taskId: result.taskId ?? null, nodeToken: identity.nodeToken,
          ...(persisted ? {} : {
            persistWarning: '移出已同步完成，但终态落盘失败：行保持 pending 围栏，重启对账会收敛为 unknown；期间编辑/写回/回滚/新移出仍被拒绝',
          }),
        };
      }
      // 异步起步：running → moving + task_id（T4b-10 关键持久化：重启续查
      // 依据；客户端层已保证 running 形态必带 task_id）。写失败时行保持
      // pending 围栏 + 进程内轮询照常收敛 + persistWarning 显式上报。
      const taskPersisted = this.criticalUpdate(moveId, (store) => store.updateCloudMove(moveId, {
        state: 'moving',
        taskId: result.taskId ?? undefined,
      }));
      this.appendAudit('move_to_drive_moving', {
        objToken, moveId, nodeToken: identity.nodeToken, actor, taskId: result.taskId ?? null,
        ...(taskPersisted ? {} : { persistWarning: 'moving_task_id_persist_failed_fence_pending_kept' }),
      });
      this.trackMove({
        moveId,
        objToken,
        watchedRootId: identity.watchedRootId,
        taskId: result.taskId ?? '',
        intervalMs: result.pollAfterMs ?? this.pollerDefaultIntervalMs,
      });
      return {
        state: 'moving', moveId, taskId: result.taskId ?? null, nodeToken: identity.nodeToken,
        ...(taskPersisted ? {} : {
          persistWarning: '移出任务已受理且轮询继续，但 task_id 落盘失败：行保持 pending 围栏；重启后按 pending 对账为 unknown，请到飞书核对节点归属',
        }),
      };
    } catch (error) {
      // 子进程超时/输出不可解析/异步响应缺必要字段（T4b-06，客户端层
      // incomplete_response）→ unknown（云端状态不确定，绝不重发——unknown
      // 行持续围栏，只经权威核对解除）；其余权威业务拒绝（含 3380002 类）
      // → failed + error。两种都落审计并上抛。
      const larkError = error instanceof LarkCliError ? error : null;
      const rawCode = larkError ? (larkError.upstreamCode ?? larkError.code)
        : error instanceof Error ? error.message : String(error);
      const unknownOutcome = larkError?.code === 'timeout'
        || larkError?.code === 'parse'
        || larkError?.code === 'incomplete_response';
      const state: 'failed' | 'unknown' = unknownOutcome ? 'unknown' : 'failed';
      // T4b-10：终态写本身也走 critical——失败时行保持 pending 围栏
      //（fail-closed，宁可过拦），交重启对账收敛。
      this.criticalUpdate(moveId, (store) => store.updateCloudMove(moveId, {
        state,
        error: String(rawCode).slice(0, 500),
      }));
      this.appendAudit(`move_to_drive_${state}`, {
        objToken, moveId, nodeToken: identity.nodeToken, actor,
        error: String(rawCode).slice(0, 500),
      });
      throw new CloudMoveError(
        state === 'unknown' ? 'cloud_move_outcome_unknown' : 'cloud_move_failed',
        state === 'unknown'
          ? '移出调用超时/输出不可解析/响应不完整，云端状态未知（不会自动重试）：请到飞书核对节点是否仍在知识库，核对后可在移出记录发起权威核对解除围栏'
          : `移出失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 560),
        502,
        { moveId, ...(larkError ? { larkCode: rawCode } : {}) },
      );
    }
  }

  /**
   * 关键互斥/任务标识状态写入（T4b-10）：异常与 false 返回都不得按成功
   * 已持久化处理。返回 true=已落盘；false=写失败（调用方保持 fail-closed
   * 围栏——行不推进，交进程内轮询重试或重启对账收敛，并显式上报
   * persistWarning / 审计事件）。
   */
  private criticalUpdate(moveId: string, op: (store: any) => boolean | unknown): boolean {
    try {
      const result = op(this.deps.store);
      if (result === false) return false;
      return true;
    } catch (error) {
      console.error('[CloudMoveService] critical state persist failed (fence kept):', error);
      this.appendAudit('move_to_drive_state_persist_failed', { moveId, error: String(error).slice(0, 300) });
      return false;
    }
  }

  /** 触发 watchedRoot 的一次既有变更检测（只推进观测字段）。 */
  private async triggerDetect(outcome: { watchedRootId?: string | null } & MoveOutResult): Promise<void> {
    const watchedRootId = outcome.watchedRootId ?? null;
    if (!watchedRootId || typeof this.deps.detectRoot !== 'function') return;
    try {
      await this.deps.detectRoot(watchedRootId);
    } catch (error) {
      console.error('[CloudMoveService] post-move detect failed (detection chain will converge):', error);
    }
  }

  // =========================================================================
  // 查询面（cloud.move_status / cloud.moves）
  // =========================================================================

  getMove(moveId: string): Record<string, unknown> {
    const row = this.deps.store.getCloudMove?.(moveId) ?? null;
    if (!row) {
      throw new CloudMoveError('cloud_move_not_found', `移出记录不存在：${moveId}`, 404);
    }
    return row;
  }

  listMoves(opts: { objToken?: string | null; limit?: number } = {}): { moves: unknown[] } {
    return {
      moves: this.deps.store.listCloudMoves?.(
        opts.objToken ?? undefined,
        opts.limit ?? 50,
      ) ?? [],
    };
  }

  // =========================================================================
  // reconcileUnknownMove —— unknown 围栏的权威核对解除（T4b-05）
  // =========================================================================

  /**
   * unknown 移出行的权威核对（只读查询 + 记录收敛；不发起任何写云端
   * 动作）：真实查询任务终态，或由用户确认任务结束与最终去向，才收敛。
   *
   *  - 有 task_id：drive +task_result 轮询——done → moved；failed →
   *    failed（释放）；running/查询失败 → 保持 unknown（reason 返回）。
   *  - 无法查询任务时：要求明确人工确认；确认未移出还需验证节点身份。
   *
   * 状态写走 criticalUpdate：失败时行保持 unknown 围栏（fail-closed）。
   */
  async reconcileUnknownMove(moveId: string, manualConfirm?: unknown): Promise<{
    moveId: string;
    objToken: string;
    /** 落盘后的最新状态；仍为 'unknown' = 无法证明，围栏保持。 */
    state: 'moved' | 'failed' | 'unknown';
    taskId: string | null;
    /** 保持 unknown 时的原因（task_still_running / node_lookup_inconclusive…）。 */
    reason: string | null;
  }> {
    const initial = this.deps.store.getCloudMove?.(moveId) ?? null;
    if (!initial) throw new CloudMoveError('cloud_move_not_found', `移出记录不存在：${moveId}`, 404);
    return this.locks.withLock(initial.objToken, () => this.reconcileUnknownMoveLocked(moveId, manualConfirm));
  }

  private async reconcileUnknownMoveLocked(moveId: string, manualConfirm?: unknown): Promise<{
    moveId: string; objToken: string; state: 'moved' | 'failed' | 'unknown'; taskId: string | null; reason: string | null;
  }> {
    const row = this.deps.store.getCloudMove?.(moveId) ?? null;
    if (!row) {
      throw new CloudMoveError('cloud_move_not_found', `移出记录不存在：${moveId}`, 404);
    }
    if (row.state !== 'unknown') {
      throw new CloudMoveError(
        'cloud_move_not_unknown',
        `仅结果未知（unknown）的移出记录需要权威核对，当前状态：${row.state}`,
        409,
      );
    }
    if (row.taskId) {
      let status: { state: 'done' | 'running' | 'failed'; message?: string | null } | null;
      try {
        status = await this.deps.larkCliClient.getDriveTaskResult(row.taskId);
      } catch (error) {
        // 只读查询失败：无法证明，围栏保持。
        this.appendAudit('move_to_drive_reconcile', {
          objToken: row.objToken, moveId, taskId: row.taskId,
          result: 'task_result_unreadable', error: String(error).slice(0, 300),
        });
        status = null;
      }
      if (status?.state === 'running') {
        this.appendAudit('move_to_drive_reconcile', {
          objToken: row.objToken, moveId, taskId: row.taskId, result: 'task_still_running',
        });
        return { moveId, objToken: row.objToken, state: 'unknown', taskId: row.taskId, reason: 'task_still_running' };
      }
      if (status) {
        const next: 'moved' | 'failed' = status.state === 'done' ? 'moved' : 'failed';
        const detail = next === 'failed' ? String(status.message ?? 'move_failed_upstream').slice(0, 500) : null;
        const persisted = this.criticalUpdate(moveId, (store) => store.resolveUnknownCloudMove(moveId, next, detail));
        this.appendAudit('move_to_drive_reconcile', {
          objToken: row.objToken, moveId, taskId: row.taskId,
          result: persisted ? next : `${next}_persist_failed`,
        });
        if (next === 'moved' && persisted) {
          void Promise.resolve(this.triggerDetect({
            state: 'moved', moveId, taskId: row.taskId, nodeToken: row.wikiNodeToken ?? '',
            watchedRootId: row.watchedRootId ?? null,
          })).catch(() => undefined);
        }
        return {
          moveId, objToken: row.objToken, state: persisted ? next : 'unknown', taskId: row.taskId,
          reason: persisted ? null : 'state_persist_failed',
        };
      }
    }
    // 节点仍在并不证明异步任务已停止；无可读终态时必须人工确认。
    if (manualConfirm !== `MOVE_SETTLED_NOT_MOVED:${moveId}` && manualConfirm !== `MOVE_SETTLED_MOVED:${moveId}`) {
      return { moveId, objToken: row.objToken, state: 'unknown', taskId: row.taskId ?? null, reason: row.taskId ? 'task_result_unreadable' : 'task_id_missing' };
    }
    if (manualConfirm === `MOVE_SETTLED_MOVED:${moveId}`) {
      const persisted = this.criticalUpdate(moveId, (store) => store.resolveUnknownCloudMove(moveId, 'moved', 'manual_confirmed_moved'));
      this.appendAudit('move_to_drive_reconcile', { objToken: row.objToken, moveId, result: persisted ? 'manual_moved' : 'state_persist_failed' });
      if (persisted) void Promise.resolve(this.triggerDetect({ state: 'moved', moveId, taskId: row.taskId ?? null, nodeToken: row.wikiNodeToken ?? '', watchedRootId: row.watchedRootId ?? null })).catch(() => undefined);
      return { moveId, objToken: row.objToken, state: persisted ? 'moved' : 'unknown', taskId: row.taskId ?? null, reason: persisted ? null : 'state_persist_failed' };
    }
    // 人工确认任务已结束且未移出后，再检查节点身份；无法查明则继续保护。
    try {
      const node = await this.deps.larkCliClient.getNode(row.wikiNodeToken);
      if (node && typeof node === 'object' && node.obj_token === row.objToken) {
        // 用户已确认任务停止，且节点仍指向同一文档。
        const persisted = this.criticalUpdate(moveId, (store) => store.resolveUnknownCloudMove(moveId, 'failed', 'manual_confirmed_not_moved'));
        this.appendAudit('move_to_drive_reconcile', {
          objToken: row.objToken, moveId, result: persisted ? 'failed' : 'failed_persist_failed',
          detail: 'manual_confirmed_not_moved',
        });
        return {
          moveId, objToken: row.objToken, state: persisted ? 'failed' : 'unknown', taskId: row.taskId ?? null,
          reason: persisted ? null : 'state_persist_failed',
        };
      }
      // 节点可查但归属不一致（可能已被移走/替换）：无法证明未移出，保持围栏。
      this.appendAudit('move_to_drive_reconcile', {
        objToken: row.objToken, moveId, result: 'node_lookup_inconclusive', detail: 'obj_token_mismatch',
      });
      return { moveId, objToken: row.objToken, state: 'unknown', taskId: row.taskId ?? null, reason: 'node_lookup_inconclusive' };
    } catch (error) {
      // 节点查不到（可能已移出/已删除，无法区分）或查询失败：不能证明
      // 未移出——围栏保持，交用户到飞书人工核对。
      this.appendAudit('move_to_drive_reconcile', {
        objToken: row.objToken, moveId, result: 'node_lookup_inconclusive',
        error: String(error).slice(0, 300),
      });
      return { moveId, objToken: row.objToken, state: 'unknown', taskId: row.taskId ?? null, reason: 'node_lookup_inconclusive' };
    }
  }

  // =========================================================================
  // 轮询器（§3.4：tick 5s；单行 poll_after_ms 节奏；单行总上限 10 分钟；
  // done/failed/running/超时→unknown 四分支）
  // =========================================================================

  /** 启动轮询定时器（幂等；unref——server 由 HTTP 句柄保活，进程可退出）。 */
  startPoller(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        console.error('[CloudMoveService] poll tick failed:', error);
      });
    }, this.pollerTickMs);
    this.pollTimer.unref?.();
  }

  stopPoller(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 登记需轮询的移出行（异步起步 / 启动对账续查）。 */
  private trackMove(row: {
    moveId: string;
    objToken: string;
    watchedRootId: string | null;
    taskId: string;
    intervalMs: number;
  }): void {
    const now = this.now();
    const intervalMs = Math.max(1_000, Math.floor(row.intervalMs || this.pollerDefaultIntervalMs));
    this.tracked.set(row.moveId, {
      ...row,
      intervalMs,
      firstSeenAt: now,
      nextPollAt: now + intervalMs,
    });
    this.startPoller();
  }

  /**
   * 启动对账（§3.3/§3.6）：pending → unknown（起步行未完成，云端状态
   * 不确定）；moving 有 task_id → 交轮询器续查（10 分钟窗口自续查起算）；
   * moving 无 task_id → unknown。T4b-10：置 unknown 的状态写失败时行保持
   * pending/moving 围栏（fail-closed），不计入已收敛数（下次重启重试）。
   * server 启动时调用一次。
   */
  resumeRunningMoves(): { resumed: number; markedUnknown: number } {
    let resumed = 0;
    let markedUnknown = 0;
    for (const row of this.deps.store.listPendingCloudMoves?.() ?? []) {
      const marked = this.criticalUpdate(row.id, (store) => store.updateCloudMove(row.id, {
        state: 'unknown',
        error: 'pending_unresolved_after_restart',
      }));
      this.appendAudit('move_to_drive_unknown', {
        objToken: row.objToken, moveId: row.id, error: 'pending_unresolved_after_restart',
        ...(marked ? {} : { persistWarning: 'unknown_mark_persist_failed_fence_kept' }),
      });
      if (marked) markedUnknown += 1;
    }
    for (const row of this.deps.store.listMovingCloudMoves?.() ?? []) {
      if (row.taskId) {
        this.trackMove({
          moveId: row.id,
          objToken: row.objToken,
          watchedRootId: row.watchedRootId,
          taskId: row.taskId,
          intervalMs: this.pollerDefaultIntervalMs,
        });
        resumed += 1;
      } else {
        const marked = this.criticalUpdate(row.id, (store) => store.updateCloudMove(row.id, {
          state: 'unknown',
          error: 'task_id_missing_after_restart',
        }));
        this.appendAudit('move_to_drive_unknown', {
          objToken: row.objToken, moveId: row.id, error: 'task_id_missing_after_restart',
          ...(marked ? {} : { persistWarning: 'unknown_mark_persist_failed_fence_kept' }),
        });
        if (marked) markedUnknown += 1;
      }
    }
    return { resumed, markedUnknown };
  }

  /** 单轮扫描（定时器入口；测试直调）。只处理到期行（poll_after_ms 节奏）。 */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = this.now();
      for (const row of [...this.tracked.values()]) {
        if (row.nextPollAt > now) continue;
        await this.pollRow(row, now);
      }
    } finally { this.polling = false; }
  }

  private async pollRow(row: TrackedMove, now: number): Promise<void> {
    let status: { state: 'done' | 'running' | 'failed'; message: string | null };
    try {
      status = await this.deps.larkCliClient.getDriveTaskResult(row.taskId);
    } catch (error) {
      // 状态查询是只读调用，失败不判终态：按节奏续查直至总上限 → unknown。
      console.error('[CloudMoveService] move status poll failed:', error);
      this.scheduleNextOrExpire(row, now);
      return;
    }
    if (status.state === 'done') {
      this.finalizeMoved(row);
      return;
    }
    if (status.state === 'failed') {
      this.finalizeFailed(row, status.message);
      return;
    }
    // running（含未知取值归一）：续查或超限。
    this.scheduleNextOrExpire(row, now);
  }

  private scheduleNextOrExpire(row: TrackedMove, now: number): void {
    if (now - row.firstSeenAt >= this.pollerDeadlineMs) {
      this.finalizeUnknown(row, 'poll_deadline_exceeded');
      return;
    }
    row.nextPollAt = now + row.intervalMs;
  }

  /** moved 收敛：state='moved' + 锁外触发一次变更检测（best-effort）。T4b-10：
   * 终态写失败时不删除 tracked——下轮重试（围栏保持，直到落盘或重启对账）。 */
  private finalizeMoved(row: TrackedMove): void {
    // T4b-10：终态写同时回填 task_id（起步写失败时行可能仍无 taskId——
    // COALESCE 语义下已写则保持；未写则补齐，重启后 reconcile 仍可查）。
    const persisted = this.criticalUpdate(row.moveId, (store) =>
      store.updateCloudMove(row.moveId, { state: 'moved', taskId: row.taskId }));
    if (!persisted) {
      row.nextPollAt = this.now() + row.intervalMs;
      return;
    }
    this.tracked.delete(row.moveId);
    this.appendAudit('move_to_drive_moved', {
      objToken: row.objToken, moveId: row.moveId, taskId: row.taskId,
    });
    void Promise.resolve(this.triggerDetect({ ...row, state: 'moved', moveId: row.moveId, taskId: row.taskId, nodeToken: '' }))
      .catch((error) => {
        console.error('[CloudMoveService] post-move detect failed:', error);
      });
  }

  private finalizeFailed(row: TrackedMove, message: string | null): void {
    const detail = message ?? 'move_failed_upstream';
    const persisted = this.criticalUpdate(row.moveId, (store) => store.updateCloudMove(row.moveId, {
      state: 'failed',
      taskId: row.taskId,
      error: detail.slice(0, 500),
    }));
    if (!persisted) {
      row.nextPollAt = this.now() + row.intervalMs;
      return;
    }
    this.tracked.delete(row.moveId);
    this.appendAudit('move_to_drive_failed', {
      objToken: row.objToken, moveId: row.moveId, taskId: row.taskId, error: detail.slice(0, 500),
    });
  }

  private finalizeUnknown(row: TrackedMove, reason: string): void {
    const persisted = this.criticalUpdate(row.moveId, (store) => store.updateCloudMove(row.moveId, {
      state: 'unknown',
      taskId: row.taskId,
      error: reason,
    }));
    if (!persisted) {
      // T4b-10：unknown 标记落盘失败——保持 tracked 每轮重试（围栏保持），
      // 不静默丢弃。
      row.nextPollAt = this.now() + row.intervalMs;
      return;
    }
    this.tracked.delete(row.moveId);
    this.appendAudit('move_to_drive_unknown', {
      objToken: row.objToken, moveId: row.moveId, taskId: row.taskId, error: reason,
    });
  }
}
