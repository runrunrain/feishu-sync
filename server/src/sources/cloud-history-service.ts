/**
 * CloudHistoryService — 云端历史查询与回滚（P0-S4，lark-cli-newcaps-P0
 * §4.3/§4.4；U24/U25）。
 *
 * 写者边界：本服务不改任何本地 synced 基线——回滚是云端动作，本地收敛
 * 只经「触发单文档回拉」走 SyncEngine 正常同步流程（§4.2 不变量
 * 「synced_obj_edit_time 只由 SyncEngine 原子提交推进」不变）。
 *
 * 职责：
 *  - listCloudHistory：history-list 分页聚合（上游 page_token 恒存在、
 *    has_more 驱动续页；上限保护：缺省 3 页、硬上限 10 页——§4.3
 *    history_not_found 判定阈值即前 3 页 60 条，不翻全量）。显式
 *    pageToken 时单页透传（UI 云端历史抽屉 load-more）。
 *  - buildRevertPlan：回滚计划（§4.3 preview DTO）：门控 blockedReason +
 *    U23 警告（anchor_inexact / cloud_changed_since_push /
 *    cloud_time_unreadable）+ 目标版本信息。
 *  - revertToAnchor：执行回滚（destructive，逐次 confirm：
 *    `REVERT_CLOUD:<historyVersionId>`——锚点版本 id 必须出现在确认值中；
 *    3380002 实测语义「最新历史条目不可作目标」本地预校验直接拒）。
 *    执行走 `--wait-timeout-ms 0` 异步起步（任务书定值）；done 分支锁外
 *    回拉，running 分支交轮询器收敛。
 *  - 轮询器：revert-status 收敛（poll_after_ms 节奏，tick 5s，单行总上限
 *    10 分钟；done/failed/running/超时→unknown 四分支迁移）。server 进程
 *    内单例（index.ts 构造后 DI 注入 routes/feishu）。
 *
 * cloud_revert_running 互斥（§4.4；共享状态 = source_push_log.revert_state）：
 * 同一 objToken 存在 revert_state='running' 行 → 新回滚 409；
 * FeishuWriteService.push 同门（P0-S3 报告约束：不改其代码路径，仅最小
 * 追加门检查——见 feishu-write-service 的 hasRunningCloudRevert）；
 * P0-S9 标题同步同源消费。回滚启动门 local_edit_pending：source_edits 存在
 * dirty/pushing/conflict 行 → 409（回滚后的回拉会被本地脏状态阻断，
 * 设计 §4.3：用户须先写回或放弃本地修改）。
 *
 * 回滚行形态（§4.1/§4.4；T4b-10 修订）：INSERT mode='revert'、
 * outcome='started'，且**起步即初始化 revert_state='running'**（围栏在
 * revert 命令发出前落盘；写不进就不放行执行——insert 抛错直接失败，
 * 零云端调用），anchor_* 记回滚前最新历史（让回滚本身也有回退点
 * ——HP-2：revert 产生 type=3 新历史，回滚可再回滚）；revert 调用被
 * 云端接受 → outcome='pushed' + revert_task_id（关键持久化，失败时行保持
 * running 围栏并显式上报 persistWarning）/立即 'done'；明确业务错误 →
 * 'failed' + revert_error；子进程超时/输出不可解析/异步响应缺必要字段
 * （T4b-06，客户端层 incomplete_response）→ 'unknown'（revert 非幂等，
 * 绝不自动重试——UI 提示到飞书核对，只读刷新）。
 *
 * 审计：<dataRoot>/agent/audit/source-pushes.jsonl（与写回同文件），事件
 * history_revert_started|done|failed|unknown；字段 objToken / pushLogId /
 * historyVersionId / actor / approvalId? / taskId? / error? /
 * failedBlockTokens?（HP-2：部分块回滚失败必须上抛）。不记正文。
 */

import fs from 'node:fs';
import path from 'node:path';
import { LarkCliError } from '../modules/lark-cli-client.js';
import type { DocumentHistoryPage } from '../modules/lark-cli-client.js';
import type { SourceEditActor, SourcePushLogRecord } from '../types/index.js';
import { FEISHU_WRITE_SCOPES, computeAnchorExactSeconds } from './feishu-write-service.js';
import { sharedSourceWriteLock, type SourceWriteLockLike } from './source-write-lock.js';

/** 服务级错误：code/status 对齐设计 §8；响应体 { error, message, details? }。 */
export class CloudHistoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CloudHistoryError';
  }
}

// ---------------------------------------------------------------------------
// 常量与纯函数（命令表 confirmPlan 同源消费）
// ---------------------------------------------------------------------------

/** 回滚确认值基段（完整值 = `REVERT_CLOUD:<historyVersionId>`）。 */
export const REVERT_CONFIRM_BASE = 'REVERT_CLOUD';

/** 派生回滚确认值：锚点/目标 historyVersionId 必须出现在确认值中（任务书）。 */
export function deriveRevertConfirmValue(historyVersionId: string): string {
  return `${REVERT_CONFIRM_BASE}:${historyVersionId}`;
}

/** history-list 单页大小（CLI 上限 20，§4.3 路由 pageSize）。 */
const HISTORY_PAGE_SIZE = 20;
/** 目标检索页数（§4.3：不在前 3 页 60 条内即 history_not_found，不翻全量）。 */
export const HISTORY_LOOKUP_MAX_PAGES = 3;
/** 分页聚合硬上限（上限保护：防超长历史无界调用）。 */
const HISTORY_AGGREGATION_HARD_CAP_PAGES = 10;
/** 任务书定值：revert 异步起步（`--wait-timeout-ms 0`，交轮询器收敛）。 */
const REVERT_START_WAIT_MS = 0;

// ---------------------------------------------------------------------------
// DTO（routes/feishu + P0-S5 UI 消费；types/index.ts 不动——并行任务写面）
// ---------------------------------------------------------------------------

export type HistoryRevertBlockedReason =
  | 'write_disabled'
  | 'scope_missing'
  | 'local_edit_pending'
  | 'kb_build_active'
  | 'cloud_revert_running'
  /** P2-S6：云端移出进行中（cloud_moves pending/moving）——回滚互斥。 */
  | 'cloud_move_running'
  | 'anchor_missing'
  | 'history_not_found'
  /** 任务书增补（P0-S1 实测 3380002 语义）：最新历史条目不可作目标。 */
  | 'invalid_target';

export type HistoryRevertWarning =
  | 'anchor_inexact'
  | 'cloud_changed_since_push'
  | 'cloud_time_unreadable';

export interface HistoryRevertPlan {
  objToken: string;
  target: {
    historyVersionId: string;
    createdAt: string | null;
    /** 上游无姓名字段（P0-S1 HP-1：仅 editor_ids open_id）；v1 恒 null。 */
    editorName: string | null;
    editorIds: string[];
  };
  source: 'push_log' | 'history';
  /** 仅 source='push_log'（U23 锚点精确性）；history 源为 null。 */
  anchorExact: boolean | null;
  warnings: HistoryRevertWarning[];
  blockedReason: HistoryRevertBlockedReason | null;
}

export interface CloudHistoryListResult extends DocumentHistoryPage {
  /** true = 因页数上限截断（nextPageToken 非空，可继续翻页）。 */
  truncated: boolean;
}

export interface RevertExecutionResult {
  state: 'done' | 'running';
  pushLogId: string;
  taskId: string | null;
  targetHistoryVersionId: string;
  /** 仅 state='done'（锁外回拉结果；失败只记 warning，交检测链收敛）。 */
  pull: { ok: boolean; status: string; message?: string } | null;
  /**
   * T4b-10：关键互斥/任务标识字段的持久化降级说明（例如 running/taskId
   * 写入遇瞬时 DB 异常——行至少保持 running 围栏 + 进程内轮询继续；
   * 重启对账会收敛为 unknown）。缺省无此字段＝全部关键写入已落盘。
   */
  persistWarning?: string;
}

export interface CloudHistoryServiceDeps {
  /** ConfigManager 面：读 feishuWrite.enabled。 */
  config: {
    getConfig?: () => Record<string, any> | undefined | null;
  };
  /** LocalMapStore：documents 行 + source_edits 行 + source_push_log 行。 */
  store: any;
  /** LarkCliClient：listDocumentHistory / revertDocumentHistory / revertDocumentHistoryStatus。 */
  larkCliClient: any;
  /** 构建活跃探针（接线同写回链：kbBuildService.activeBuild != null）。 */
  kbBuild: { isActive(): boolean };
  /** 数据根（审计落点）。 */
  dataRoot: string;
  /** 与 SyncEngine / 写回链共享的 per-token 锁；缺省进程级共享实例。 */
  locks?: SourceWriteLockLike;
  /** 单文档回拉（与写回同一入口；回滚后触发，不改任何基线字段）。 */
  pullSync(objToken: string): Promise<{ ok: boolean; status: string; message?: string }>;
  /** 轮询器节奏（测试注入；缺省 tick 5s / 单行间隔 5s / 单行上限 10 分钟）。 */
  poller?: {
    tickMs?: number;
    defaultIntervalMs?: number;
    deadlineMs?: number;
    now?: () => number;
  };
}

/** 轮询器跟踪中的回滚行（进程内存活；重启经 resumeRunningReverts 重建）。 */
interface TrackedRevert {
  pushLogId: string;
  objToken: string;
  taskId: string;
  intervalMs: number;
  firstSeenAt: number;
  nextPollAt: number;
}

export class CloudHistoryService {
  private readonly pollerTickMs: number;
  private readonly pollerDefaultIntervalMs: number;
  private readonly pollerDeadlineMs: number;
  private readonly now: () => number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tracked = new Map<string, TrackedRevert>();

  constructor(private readonly deps: CloudHistoryServiceDeps) {
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

  /** 审计追加（与 FeishuWriteService.appendAudit 同容错：失败只记控制台）。 */
  private appendAudit(event: string, entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath()), { recursive: true });
      fs.appendFileSync(
        this.auditPath(),
        `${JSON.stringify({ time: new Date().toISOString(), event, ...entry })}\n`,
      );
    } catch (error) {
      console.error('[CloudHistoryService] audit append failed:', error);
    }
  }

  // =========================================================================
  // 门槛与云端读取
  // =========================================================================

  private feishuWriteEnabled(): boolean {
    const config = this.deps.config.getConfig?.() ?? null;
    return config?.feishuWrite?.enabled === true;
  }

  /** 写 scope 已授予判定（与 FeishuWriteService 同口径；history scope 并入写授权面）。 */
  private async writeScopesGranted(): Promise<{ granted: boolean; missingScopes: string[] }> {
    const readiness = await this.deps.larkCliClient.checkAuthReady({ verify: false });
    const grantedSet = new Set<string>(readiness?.currentScopes ?? []);
    const missing = FEISHU_WRITE_SCOPES.filter((scope) => !grantedSet.has(scope));
    return { granted: missing.length === 0, missingScopes: missing };
  }

  /** 单文档云端 obj_edit_time（drive metas batch，与写回链同通道；失败容错 null）。 */
  private async fetchCloudObjEditTime(objToken: string): Promise<number | null> {
    try {
      const result = await this.deps.larkCliClient.getDocumentMetas([
        { docToken: objToken, docType: 'docx' },
      ]);
      const meta = result?.metas?.[0];
      const time = meta?.latestModifyTime;
      return typeof time === 'number' && Number.isFinite(time) ? time : null;
    } catch {
      return null;
    }
  }

  /** cloud_revert_running 互斥判定（§4.4）：共享状态 = revert_state='running' 行。 */
  private hasRunningRevert(objToken: string): SourcePushLogRecord | null {
    try {
      return this.deps.store.getRunningRevertPushLog?.(objToken) ?? null;
    } catch {
      return null;
    }
  }

  /** 门控评估（§4.3 blockedReason 语义；执行路径同判定复用——§4.4 步骤 1 复核）。 */
  private async evaluateGates(objToken: string): Promise<{
    blockedReason: HistoryRevertBlockedReason | null;
    missingScopes?: string[];
  }> {
    if (!this.feishuWriteEnabled()) return { blockedReason: 'write_disabled' };
    const scopes = await this.writeScopesGranted();
    if (!scopes.granted) return { blockedReason: 'scope_missing', missingScopes: scopes.missingScopes };
    if (this.deps.kbBuild?.isActive()) return { blockedReason: 'kb_build_active' };
    const edit = this.deps.store.getSourceEdit?.(objToken) ?? null;
    if (edit && (edit.state === 'dirty' || edit.state === 'pushing' || edit.state === 'conflict')) {
      return { blockedReason: 'local_edit_pending' };
    }
    if (this.hasRunningRevert(objToken) != null) return { blockedReason: 'cloud_revert_running' };
    // P2-S6（lark-cli-newcaps-P2；T4b-05 修订）：云端移出进行中（pending/
    // moving）或结果未知（unknown）→ 回滚拒（同一文档的云端互斥动作；
    // 任务书「移出进行中→源编辑/写回/回滚拒绝」；unknown 云端可能仍在
    // 执行或已执行，同样持续围栏，只经权威核对解除）。访问器缺失按无
    // 移出容错。
    try {
      if (this.deps.store.getActiveCloudMove?.(objToken) != null) {
        return { blockedReason: 'cloud_move_running' };
      }
    } catch {
      // 旧测试替身无访问器：容错，不影响既有链路。
    }
    return { blockedReason: null };
  }

  private blockedError(
    reason: HistoryRevertBlockedReason,
    detail?: { missingScopes?: string[] },
  ): CloudHistoryError {
    switch (reason) {
      case 'write_disabled':
        return new CloudHistoryError(
          'write_disabled',
          '飞书写回未开启：请在「设置 → 飞书写入」中开启后再回滚云端历史',
          403,
        );
      case 'scope_missing':
        return new CloudHistoryError(
          'scope_missing',
          `缺少写回权限（${(detail?.missingScopes ?? []).join(', ')}）：请发起一次「写入权限」授权（scopeSet=write）后再回滚`,
          403,
          { missingScopes: detail?.missingScopes ?? [] },
        );
      case 'kb_build_active':
        return new CloudHistoryError(
          'kb_build_active',
          '标准库构建进行中，暂不能回滚云端历史（构建结束或取消后再试）',
          409,
        );
      case 'local_edit_pending':
        return new CloudHistoryError(
          'local_edit_pending',
          '该文档有未写回的本地修改：请先写回或放弃本地修改，再回滚云端历史（否则回滚后的回拉会被本地脏状态阻断）',
          409,
        );
      case 'cloud_revert_running':
        return new CloudHistoryError(
          'cloud_revert_running',
          '该文档有进行中的云端回滚，请等待完成（或状态收敛为 unknown）后再操作',
          409,
        );
      case 'cloud_move_running':
        return new CloudHistoryError(
          'cloud_move_running',
          '该文档有进行中或结果未知的移出到云空间，暂不能回滚云端历史：请先在移出记录完成权威核对（确认未移出后再操作）',
          409,
        );
      case 'anchor_missing':
        return new CloudHistoryError(
          'anchor_missing',
          '该写回记录没有可用的回退锚点（写回时未取得云端历史锚点），无法回滚到写回前',
          422,
        );
      case 'history_not_found':
        return new CloudHistoryError(
          'history_not_found',
          '目标历史版本不在云端历史前 3 页（60 条）内：版本过旧或已被清理，无法回滚',
          422,
        );
      case 'invalid_target':
        return new CloudHistoryError(
          'invalid_target',
          '最新历史条目不可作回滚目标（3380002）：请选择更早的历史版本',
          422,
        );
    }
  }

  // =========================================================================
  // listCloudHistory —— 分页聚合（§4.3）
  // =========================================================================

  /**
   * 云端历史列表。显式 pageToken → 单页透传（UI 抽屉分页）；缺省 → 从
   * 第一页聚合续翻（has_more + page_token 驱动；has_more=true 而 page_token
   * 缺失时终止防死循环），页数上限 maxPages（缺省 3，硬钳 10）——到达
   * 上限时 truncated=true 且 nextPageToken 指向下一页（可继续翻）。
   */
  async listCloudHistory(
    objToken: string,
    opts?: { pageToken?: string; pageSize?: number; maxPages?: number },
  ): Promise<CloudHistoryListResult> {
    if (typeof objToken !== 'string' || objToken.trim().length === 0) {
      throw new CloudHistoryError('invalid_body', 'objToken 必须是非空字符串', 400);
    }
    const pageSize = Math.min(20, Math.max(1, Math.floor(opts?.pageSize ?? HISTORY_PAGE_SIZE)));
    if (opts?.pageToken) {
      const page = await this.deps.larkCliClient.listDocumentHistory(objToken, {
        pageToken: opts.pageToken,
        pageSize,
      });
      return { ...page, truncated: false };
    }
    const maxPages = Math.min(
      HISTORY_AGGREGATION_HARD_CAP_PAGES,
      Math.max(1, Math.floor(opts?.maxPages ?? HISTORY_LOOKUP_MAX_PAGES)),
    );
    const entries: DocumentHistoryPage['entries'] = [];
    let pageToken: string | null = null;
    let last: DocumentHistoryPage | null = null;
    let pages = 0;
    do {
      last = await this.deps.larkCliClient.listDocumentHistory(objToken, {
        ...(pageToken ? { pageToken } : {}),
        pageSize,
      });
      const current = last as DocumentHistoryPage;
      pages += 1;
      entries.push(...current.entries);
      pageToken = current.hasMore ? current.nextPageToken : null;
      if (current.hasMore && !pageToken) break; // 上游形态异常：终止防死循环
    } while (pageToken !== null && pages < maxPages);
    const finalPage: DocumentHistoryPage = last!;
    return {
      entries,
      hasMore: finalPage.hasMore,
      nextPageToken: pageToken,
      truncated: pageToken !== null,
    };
  }

  // =========================================================================
  // fetchCloudRevision —— 只读云端正文（当前版或历史 revision；P0-S5 对比弹窗）
  // =========================================================================

  /**
   * 只读云端正文（`docs +fetch`，P0-S1 HP-3 实测 revision_id 空间=revision
   * 数值）。revisionId 缺省（null）＝**云端当前正文**（不带 --revision-id
   * 的最新版，T4b-08：对比弹窗「对比云端当前」的真实数据源）；显式
   * revisionId 按历史版本读取。只读：不碰任何本地基线/文件；返回
   * { revisionId, content }（当前版 revisionId=null）。fetch 失败/正文
   * 缺失原样抛 CloudHistoryError（history_content_unavailable）——UI
   * 呈诚实「不可读」态（P0-S5 双态）。
   */
  async fetchCloudRevision(
    objToken: string,
    revisionId: number | null,
  ): Promise<{ revisionId: number | null; content: string }> {
    if (typeof objToken !== 'string' || objToken.trim().length === 0) {
      throw new CloudHistoryError('invalid_body', 'objToken 必须是非空字符串', 400);
    }
    if (revisionId != null && (!Number.isFinite(revisionId) || Math.floor(revisionId) < 0)) {
      throw new CloudHistoryError('invalid_body', 'revisionId 必须是非负数值', 400);
    }
    try {
      const result = await this.deps.larkCliClient.fetchDocumentMarkdown(
        objToken,
        revisionId == null ? {} : { revisionId: Math.floor(revisionId) },
      );
      const document = result?.data?.document ?? {};
      const content = typeof document.content === 'string' ? document.content : '';
      if (content === '') {
        throw new CloudHistoryError(
          'history_content_unavailable',
          '云端正文不可读（fetch 响应无 content）',
          502,
        );
      }
      return { revisionId: revisionId == null ? null : Math.floor(revisionId), content };
    } catch (error) {
      if (error instanceof CloudHistoryError) throw error;
      throw new CloudHistoryError(
        'history_content_unavailable',
        `云端正文读取失败：${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }
  }

  // =========================================================================
  // buildRevertPlan —— 回滚计划（§4.3 preview DTO）
  // =========================================================================

  /** 目标解析：pushLogId（写回锚点）或 historyVersionId（用户指定）二选一。 */
  private resolveTarget(objToken: string, ref: { pushLogId?: unknown; historyVersionId?: unknown }): {
    source: 'push_log' | 'history';
    historyVersionId: string | null;
    anchorExact: boolean | null;
    pushLog: SourcePushLogRecord | null;
  } {
    const pushLogId = typeof ref.pushLogId === 'string' && ref.pushLogId !== '' ? ref.pushLogId : null;
    const historyVersionId = typeof ref.historyVersionId === 'string' && ref.historyVersionId !== ''
      ? ref.historyVersionId : null;
    if ((pushLogId != null) === (historyVersionId != null)) {
      throw new CloudHistoryError(
        'invalid_body',
        '回滚目标必须且只提供 pushLogId 或 historyVersionId 之一',
        400,
      );
    }
    if (pushLogId != null) {
      const row: SourcePushLogRecord | null = this.deps.store.getSourcePushLog?.(pushLogId) ?? null;
      if (!row || row.objToken !== objToken) {
        throw new CloudHistoryError(
          'push_log_not_found',
          `写回记录不存在或不属于该文档：${pushLogId}`,
          404,
        );
      }
      return {
        source: 'push_log',
        historyVersionId: typeof row.anchorHistoryId === 'string' && row.anchorHistoryId !== ''
          ? row.anchorHistoryId : null,
        anchorExact: row.anchorExact === true,
        pushLog: row,
      };
    }
    return { source: 'history', historyVersionId, anchorExact: null, pushLog: null };
  }

  async buildRevertPlan(
    objToken: string,
    ref: { pushLogId?: unknown; historyVersionId?: unknown },
  ): Promise<HistoryRevertPlan> {
    const resolved = this.resolveTarget(objToken, ref);
    const gates = await this.evaluateGates(objToken);
    let blockedReason = gates.blockedReason;
    const warnings: HistoryRevertWarning[] = [];
    const target: HistoryRevertPlan['target'] = {
      historyVersionId: resolved.historyVersionId ?? '',
      createdAt: null,
      editorName: null,
      editorIds: [],
    };
    // 警告只在未阻断时计算（阻断即不发起后续云端调用——与 §4.2「时间门
    // 失败不浪费 history 调用」同哲学）。
    // push_log 源无锚点（写回时未取得）→ anchor_missing（门控之外的目标缺失形态）。
    if (blockedReason == null && resolved.source === 'push_log' && resolved.historyVersionId == null) {
      blockedReason = 'anchor_missing';
    }
    if (blockedReason == null && resolved.pushLog != null) {
      if (resolved.pushLog.anchorExact !== true) warnings.push('anchor_inexact');
      const cloudTime = await this.fetchCloudObjEditTime(objToken);
      // 写回后基线优先 post_obj_edit_time（回拉成功后抄录的 synced 值），
      // 缺失回落 pre_obj_edit_time（写前云端时间）。
      const baselineRaw = resolved.pushLog.postObjEditTime ?? resolved.pushLog.preObjEditTime;
      const baseline = baselineRaw != null ? Number(baselineRaw) : null;
      if (cloudTime == null || !Number.isFinite(cloudTime)) {
        warnings.push('cloud_time_unreadable');
      } else if (baseline != null && Number.isFinite(baseline) && cloudTime > baseline) {
        warnings.push('cloud_changed_since_push');
      }
    }
    if (blockedReason == null && resolved.historyVersionId != null) {
      const page = await this.listCloudHistory(objToken, { maxPages: HISTORY_LOOKUP_MAX_PAGES });
      const found = page.entries.find((entry) => entry.historyVersionId === resolved.historyVersionId);
      if (!found) {
        blockedReason = 'history_not_found';
      } else if (page.entries[0]?.historyVersionId === resolved.historyVersionId) {
        blockedReason = 'invalid_target';
      } else {
        target.createdAt = found.editTime;
        target.editorIds = found.editorIds;
      }
    }
    return {
      objToken,
      target,
      source: resolved.source,
      anchorExact: resolved.anchorExact,
      warnings,
      blockedReason,
    };
  }

  // =========================================================================
  // revertToAnchor —— 执行回滚（§4.4；destructive 逐次确认）
  // =========================================================================

  async revertToAnchor(
    objToken: string,
    ref: { pushLogId?: unknown; historyVersionId?: unknown },
    options: { confirmValue: unknown; actor?: SourceEditActor; approvalId?: string },
  ): Promise<RevertExecutionResult> {
    const resolved = this.resolveTarget(objToken, ref);
    if (resolved.historyVersionId == null) {
      throw this.blockedError('anchor_missing');
    }
    const targetId = resolved.historyVersionId;
    if (typeof options.confirmValue !== 'string' || options.confirmValue !== deriveRevertConfirmValue(targetId)) {
      throw new CloudHistoryError(
        'confirmation_required',
        `回滚云端历史需要 confirm: "${deriveRevertConfirmValue(targetId)}"（确认值必须包含目标 historyVersionId）`,
        400,
        { expected: deriveRevertConfirmValue(targetId) },
      );
    }
    const actor: SourceEditActor = options.actor === 'cli' || options.actor === 'agent' ? options.actor : 'ui';
    // 锁外快检（fail fast）；全量门控复核在锁内（批准与执行之间状态可能变化）。
    const gates = await this.evaluateGates(objToken);
    if (gates.blockedReason) throw this.blockedError(gates.blockedReason, { missingScopes: gates.missingScopes });
    const outcome = await this.locks.withLock(objToken, () =>
      this.revertLocked(objToken, targetId, actor, options.approvalId));
    if (outcome.state === 'done') {
      // 锁外回拉：与写回同一入口（SyncEngine apply 链）；回拉失败只记
      // warning，交检测链自然收敛——本服务不改任何 synced 基线字段。
      try {
        outcome.pull = await this.deps.pullSync(objToken);
      } catch (error) {
        outcome.pull = {
          ok: false,
          status: 'pull_failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return outcome;
  }

  private async revertLocked(
    objToken: string,
    targetId: string,
    actor: SourceEditActor,
    approvalId?: string,
  ): Promise<RevertExecutionResult> {
    // §4.4 步骤 1：复核全部门控（与 preview 同判定——批准与执行之间
    // 状态可能变化；cloud_revert_running 在锁内读 DB 权威）。
    const gates = await this.evaluateGates(objToken);
    if (gates.blockedReason) throw this.blockedError(gates.blockedReason, { missingScopes: gates.missingScopes });
    // 目标校验（本地预校验，§4.3/任务书）：不在前 3 页 → history_not_found；
    // 最新条目 → invalid_target（3380002 实测语义，直接拒，不起子进程）。
    const page = await this.listCloudHistory(objToken, { maxPages: HISTORY_LOOKUP_MAX_PAGES });
    const found = page.entries.find((entry) => entry.historyVersionId === targetId);
    if (!found) throw this.blockedError('history_not_found');
    if (page.entries[0]?.historyVersionId === targetId) throw this.blockedError('invalid_target');
    // §4.4 步骤 2：取回滚前锚点（第 1 页最新条目——目标已排除最新，故
    // entries[0] 即回滚前最新历史）→ 新行 mode='revert'。
    const anchor = page.entries[0];
    const preCloudTime = await this.fetchCloudObjEditTime(objToken);
    // T4b-09：统一秒级口径（与写回链共用同一判定函数——
    // computeAnchorExactSeconds；latestModifyTime 通道本就是秒，不得再除
    // 1000）：早 1 秒=false、相等=true、任一侧不可读=false。
    const anchorExact = computeAnchorExactSeconds(anchor.editTime, preCloudTime);
    const relPath = this.deps.store.getDocumentByObjToken?.(objToken)?.localRelPath ?? '';
    // T4b-10：起步即落 cloud_revert_running 围栏（revertState:'running' 在
    // revert 命令发出**之前**落盘；insert 抛错直接失败，零云端调用——
    // 写不进 running 就不放行执行）。后续 taskId 等关键写失败时行至少
    // 保持 running，围栏不丢（重启对账收敛为 unknown）。
    const pushLogId: string = this.deps.store.insertSourcePushLog({
      objToken,
      localRelPath: typeof relPath === 'string' ? relPath : '',
      mode: 'revert',
      actor,
      preObjEditTime: preCloudTime,
      anchorHistoryId: anchor.historyVersionId,
      anchorHistoryTime: anchor.editTime,
      anchorExact,
      revertState: 'running',
    });
    // §4.4 步骤 3：审计 started；随后 revert 异步起步（--wait-timeout-ms 0）。
    this.appendAudit('history_revert_started', { objToken, pushLogId, historyVersionId: targetId, actor, approvalId });
    try {
      const result = await this.deps.larkCliClient.revertDocumentHistory(objToken, targetId, {
        waitTimeoutMs: REVERT_START_WAIT_MS,
      });
      if (result.status === 'done') {
        // 同步完成（罕见形态）：立即终态 + 锁外回拉（调用方处理）。
        // outcome='pushed' 属审计级字段（best-effort）；终态 done 是围栏
        // 释放写——失败时行保持 running（fail-closed），交重启对账收敛。
        this.safeUpdate(pushLogId, (store) => store.updateSourcePushLog(pushLogId, { outcome: 'pushed' }));
        const persisted = this.criticalUpdate(pushLogId, (store) => store.updateSourcePushLogRevert(pushLogId, {
          revertState: 'done',
          revertHistoryId: targetId,
          revertTaskId: result.taskId,
          revertedAt: new Date().toISOString(),
        }));
        this.appendAudit('history_revert_done', {
          objToken, pushLogId, historyVersionId: targetId, actor, approvalId, taskId: result.taskId,
        });
        return {
          state: 'done', pushLogId, taskId: result.taskId, targetHistoryVersionId: targetId, pull: null,
          ...(persisted ? {} : {
            persistWarning: '回滚已同步完成，但终态落盘失败：行保持 running 围栏，重启对账会收敛为 unknown；期间编辑/写回/新回滚仍被拒绝',
          }),
        };
      }
      // 异步起步：云端已接受 → outcome='pushed'（审计级，best-effort）+
      // revert_task_id（关键：重启续查依据；客户端层已保证 running 形态
      // 必带 task_id）。写失败时行保持 running 围栏 + 进程内轮询照常收敛。
      this.safeUpdate(pushLogId, (store) => store.updateSourcePushLog(pushLogId, { outcome: 'pushed' }));
      const taskPersisted = this.criticalUpdate(pushLogId, (store) => store.updateSourcePushLogRevert(pushLogId, {
        revertHistoryId: targetId,
        revertTaskId: result.taskId,
      }));
      this.appendAudit('history_revert_moving', {
        objToken, pushLogId, historyVersionId: targetId, actor, approvalId, taskId: result.taskId,
        ...(taskPersisted ? {} : { persistWarning: 'revert_task_id_persist_failed' }),
      });
      this.trackRevert({
        pushLogId,
        objToken,
        taskId: result.taskId ?? '',
        intervalMs: result.pollAfterMs ?? this.pollerDefaultIntervalMs,
      });
      return {
        state: 'running', pushLogId, taskId: result.taskId, targetHistoryVersionId: targetId, pull: null,
        ...(taskPersisted ? {} : {
          persistWarning: '回滚任务已受理且轮询继续，但 task_id 落盘失败：行保持 running 围栏；重启后按无 task_id 对账为 unknown，请到飞书核对',
        }),
      };
    } catch (error) {
      // revert 非幂等、绝不重试：命令发出后结果不确定（timeout/输出不可
      // 解析/响应不完整缺必要字段——T4b-06，客户端层 incomplete_response）
      // → unknown；写前校验已在前面抛出，权威业务拒绝（3380002/10020 等）
      // → failed。状态写本身也走 criticalUpdate：失败时行保持 running 围栏
      // （fail-closed，宁可过拦），交重启对账收敛。
      const larkError = error instanceof LarkCliError ? error : null;
      const rawCode = larkError ? (larkError.upstreamCode ?? larkError.code) : (error instanceof Error ? error.message : String(error));
      const unknownOutcome = larkError?.code === 'timeout'
        || larkError?.code === 'parse'
        || larkError?.code === 'incomplete_response';
      const state: 'failed' | 'unknown' = unknownOutcome ? 'unknown' : 'failed';
      this.safeUpdate(pushLogId, (store) => store.updateSourcePushLog(pushLogId, { outcome: state }));
      this.criticalUpdate(pushLogId, (store) => store.updateSourcePushLogRevert(pushLogId, {
        revertState: state,
        revertHistoryId: targetId,
        revertError: String(rawCode).slice(0, 500),
      }));
      this.appendAudit(`history_revert_${state}`, {
        objToken, pushLogId, historyVersionId: targetId, actor, approvalId, error: String(rawCode).slice(0, 500),
      });
      if (larkError?.upstreamCode === '3380002' || larkError?.code === 'invalid_target') {
        throw this.blockedError('invalid_target');
      }
      if (larkError?.upstreamCode === '10020' || larkError?.code === 'conflict') {
        throw new CloudHistoryError(
          'cloud_revert_conflict',
          '飞书端已有进行中的回滚任务（10020 并发单飞）：请稍后核对云端历史再操作',
          409,
          { pushLogId },
        );
      }
      throw new CloudHistoryError(
        unknownOutcome ? 'revert_outcome_unknown' : 'cloud_revert_failed',
        unknownOutcome
          ? `回滚调用超时/输出不可解析/响应不完整，云端状态未知（不会自动重试）：请到飞书核对历史，或经写回记录「刷新状态」`
          : `云端回滚失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 560),
        502,
        { pushLogId, ...(larkError ? { larkCode: rawCode } : {}) },
      );
    }
  }

  /** 行更新 best-effort：审计级字段（outcome 等）写失败只记控制台。 */
  private safeUpdate(_pushLogId: string, op: (store: any) => unknown): void {
    try {
      op(this.deps.store);
    } catch (error) {
      console.error('[CloudHistoryService] source_push_log update failed:', error);
    }
  }

  /**
   * 关键互斥/任务标识状态写入（T4b-10）：异常与 false 返回都不得按成功
   * 已持久化处理。返回 true=已落盘；false=写失败（调用方保持 fail-closed
   * 围栏——行不再推进终态，交进程内轮询重试或重启对账收敛，并显式
   * 上报 persistWarning / 审计事件）。
   */
  private criticalUpdate(pushLogId: string, op: (store: any) => boolean | unknown): boolean {
    try {
      const result = op(this.deps.store);
      if (result === false) return false;
      return true;
    } catch (error) {
      console.error('[CloudHistoryService] critical state persist failed (fence kept):', error);
      this.appendAudit('history_revert_state_persist_failed', { pushLogId, error: String(error).slice(0, 300) });
      return false;
    }
  }

  // =========================================================================
  // 轮询器（§4.4：进程内单例；tick 节奏扫描 tracked 行，poll_after_ms
  // 控制单行间隔，单行总上限 deadline；四分支 done/failed/running/超时→unknown）
  // =========================================================================

  /** 启动轮询定时器（幂等；unref——server 由 HTTP 句柄保活，进程可退出）。 */
  startPoller(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        console.error('[CloudHistoryService] poll tick failed:', error);
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

  /** 登记需轮询的回滚行（revert 异步起步 / 启动对账续查）。 */
  private trackRevert(row: { pushLogId: string; objToken: string; taskId: string; intervalMs: number }): void {
    const now = this.now();
    this.tracked.set(row.pushLogId, {
      ...row,
      intervalMs: Math.max(1_000, Math.floor(row.intervalMs || this.pollerDefaultIntervalMs)),
      firstSeenAt: now,
      nextPollAt: now + Math.max(1_000, Math.floor(row.intervalMs || this.pollerDefaultIntervalMs)),
    });
    this.startPoller();
  }

  /**
   * 启动对账（§4.1）：revert_state='running' 且有 revert_task_id → 交轮询器
   * 续查（10 分钟窗口自续查起算）；无 task_id → unknown（云端状态不确定，
   * 不自动重试）。T4b-10：置 unknown 的状态写失败时行保持 running 围栏
   *（fail-closed），不计入已收敛数（下次重启重试）。server 启动时调用一次。
   */
  resumeRunningReverts(): { resumed: number; markedUnknown: number } {
    const rows: SourcePushLogRecord[] = this.deps.store.listRunningRevertPushLogs?.() ?? [];
    let resumed = 0;
    let markedUnknown = 0;
    for (const row of rows) {
      if (row.revertTaskId) {
        this.trackRevert({
          pushLogId: row.id,
          objToken: row.objToken,
          taskId: row.revertTaskId,
          intervalMs: this.pollerDefaultIntervalMs,
        });
        resumed += 1;
      } else {
        this.safeUpdate(row.id, (store) => store.updateSourcePushLog(row.id, { outcome: 'unknown' }));
        const marked = this.criticalUpdate(row.id, (store) => store.updateSourcePushLogRevert(row.id, {
          revertState: 'unknown',
          revertError: 'revert_task_id_missing_after_restart',
        }));
        this.appendAudit('history_revert_unknown', {
          objToken: row.objToken, pushLogId: row.id, error: 'revert_task_id_missing_after_restart',
          ...(marked ? {} : { persistWarning: 'unknown_mark_persist_failed_fence_running_kept' }),
        });
        if (marked) markedUnknown += 1;
      }
    }
    return { resumed, markedUnknown };
  }

  /** 单轮扫描（定时器入口；测试直调）。只处理到期行（poll_after_ms 节奏）。 */
  async pollOnce(): Promise<void> {
    const now = this.now();
    for (const row of [...this.tracked.values()]) {
      if (row.nextPollAt > now) continue;
      await this.pollRow(row, now);
    }
  }

  private async pollRow(row: TrackedRevert, now: number): Promise<void> {
    let status: { status: 'done' | 'running' | 'failed'; failedBlockTokens: string[] | null };
    try {
      status = await this.deps.larkCliClient.revertDocumentHistoryStatus(row.objToken, row.taskId);
    } catch (error) {
      // 状态查询是只读调用，失败不判终态：按节奏续查直至总上限 → unknown。
      console.error('[CloudHistoryService] revert status poll failed:', error);
      this.scheduleNextOrExpire(row, now);
      return;
    }
    if (status.status === 'done') {
      this.finalizeDone(row, status);
      return;
    }
    if (status.status === 'failed') {
      this.finalizeFailed(row, status);
      return;
    }
    // running（含未知取值归一 running，P0-S2 契约）：续查或超限。
    this.scheduleNextOrExpire(row, now);
  }

  private scheduleNextOrExpire(row: TrackedRevert, now: number): void {
    if (now - row.firstSeenAt >= this.pollerDeadlineMs) {
      this.finalizeUnknown(row, 'poll_deadline_exceeded');
      return;
    }
    row.nextPollAt = now + row.intervalMs;
  }

  /**
   * done 收敛：revert_state='done' + reverted_at（部分块失败记入 revert_error，
   * HP-2 必须上抛）；锁外触发回拉（best-effort，不改任何基线）。
   * T4b-10：终态写失败时不删除 tracked——下轮重试（围栏保持 running
   * fail-closed，直到落盘成功或重启对账）。
   */
  private finalizeDone(row: TrackedRevert, status: { failedBlockTokens: string[] | null }): void {
    const partial = status.failedBlockTokens != null && status.failedBlockTokens.length > 0
      ? `partial_blocks_failed:${status.failedBlockTokens.join(',')}` : null;
    const persisted = this.criticalUpdate(row.pushLogId, (store) => store.updateSourcePushLogRevert(row.pushLogId, {
      revertState: 'done',
      revertTaskId: row.taskId,
      revertedAt: new Date().toISOString(),
      ...(partial != null ? { revertError: partial } : {}),
    }));
    if (!persisted) {
      row.nextPollAt = this.now() + row.intervalMs;
      return;
    }
    this.tracked.delete(row.pushLogId);
    this.appendAudit('history_revert_done', {
      objToken: row.objToken, pushLogId: row.pushLogId, taskId: row.taskId,
      ...(partial != null ? { failedBlockTokens: status.failedBlockTokens } : {}),
    });
    void Promise.resolve(this.deps.pullSync(row.objToken)).catch((error) => {
      console.error('[CloudHistoryService] post-revert pull failed (detection chain will converge):', error);
    });
  }

  private finalizeFailed(row: TrackedRevert, status: { failedBlockTokens: string[] | null }): void {
    const detail = status.failedBlockTokens != null && status.failedBlockTokens.length > 0
      ? `partial_blocks_failed:${status.failedBlockTokens.join(',')}` : 'revert_failed_upstream';
    this.safeUpdateBoolean(row.pushLogId, (store) =>
      store.updateSourcePushLog(row.pushLogId, { outcome: 'failed' }));
    const persisted = this.criticalUpdate(row.pushLogId, (store) => store.updateSourcePushLogRevert(row.pushLogId, {
      revertState: 'failed',
      revertTaskId: row.taskId,
      revertError: detail,
    }));
    if (!persisted) {
      row.nextPollAt = this.now() + row.intervalMs;
      return;
    }
    this.tracked.delete(row.pushLogId);
    this.appendAudit('history_revert_failed', {
      objToken: row.objToken, pushLogId: row.pushLogId, taskId: row.taskId, error: detail,
    });
  }

  private finalizeUnknown(row: TrackedRevert, reason: string): void {
    this.safeUpdateBoolean(row.pushLogId, (store) =>
      store.updateSourcePushLog(row.pushLogId, { outcome: 'unknown' }));
    const persisted = this.criticalUpdate(row.pushLogId, (store) => store.updateSourcePushLogRevert(row.pushLogId, {
      revertState: 'unknown',
      revertTaskId: row.taskId,
      revertError: reason,
    }));
    if (!persisted) {
      // T4b-10：unknown 标记落盘失败——保持 tracked 每轮重试（围栏保持
      // running fail-closed），不静默丢弃。
      row.nextPollAt = this.now() + row.intervalMs;
      return;
    }
    this.tracked.delete(row.pushLogId);
    this.appendAudit('history_revert_unknown', {
      objToken: row.objToken, pushLogId: row.pushLogId, taskId: row.taskId, error: reason,
    });
  }

  /** outcome 字段写入（审计级 best-effort，但返回布尔供审计事件门控）。 */
  private safeUpdateBoolean(_pushLogId: string, op: (store: any) => boolean | unknown): boolean {
    try {
      const result = op(this.deps.store);
      return result !== false;
    } catch (error) {
      console.error('[CloudHistoryService] source_push_log outcome update failed:', error);
      return false;
    }
  }
}
