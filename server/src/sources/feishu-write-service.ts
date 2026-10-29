/**
 * FeishuWriteService — 飞书写回推送（S12，设计 §7.5 / S0-write-probe 修订）。
 *
 * 安全协议（S0 D5 反例直接后果——stale overwrite 会被静默接受并造成
 * 正文重复损坏），overwrite 采用**三段式**：
 *
 *   ① fetch 最新 revision（docx v1 documents API，写后即时可读，S0 D6）
 *   ② 同一流程内立即 overwrite（revision 用 fetch 值——**仅防未来值**，
 *      ≤当前的旧 revision 会被静默接受，因此该值不是并发控制承诺）
 *   ③ 写后回读校验：fetch 正文 → 转义归一化（push-planner）→ 与预期
 *      比对；失配 → 置 conflict 停止，**绝不重试旧 revision**。
 *
 * U20①（obj_edit_time 前置比较）是唯一竞态防线（存在 TOCTOU 窗口）：
 * 云端 obj_edit_time 已越过 base_obj_edit_time 且非 force → 状态 conflict、
 * 409 source_push_conflict；`force + confirm:'OVERWRITE_CLOUD'` 越过。
 *
 * P0-S3（lark-cli-newcaps-P0 §4.2，修订升级设计 §7.5 步骤 2–4）：写回
 * 执行前经 listDocumentHistory 取云端最新历史条目作为回退锚点，连同
 * push 计划写入 source_push_log（outcome='started'）；成功 → pushed +
 * post_revision_id；失败 → conflict/failed/unknown（push_outcome_unknown
 * 类置 unknown，与 source_edits 状态迁移对应）；回拉成功后把 synced 值
 * 抄进 post_obj_edit_time。**overwrite 无锚（history-list 空/失败）→
 * blocked(rollback_anchor_unavailable)，拒绝执行——force 唯一不能越过
 * 的门（force 语义是接受覆盖云端新改动，不是放弃回退点）；append 无锚
 * → anchor_error 记原因照常推送（U22 尽力而为）**。锁与 source_edits
 * 状态机不变（仅增加取锚步骤间的状态回退）。
 *
 * T3b-03（fail-closed）：非 force 推送时云端 obj_edit_time（或本地基线
 * 时间）不可读 → 拒绝写入（cloud_time_unreadable，保留 dirty，不写不
 * 回拉）——写后回读无法补救写前已覆盖的远端内容，唯一前置防线失效时
 * 不得继续；force + OVERWRITE_CLOUD 仍可越过（显式用户决策）。preview
 * 同语义：不可读 → blocked(cloud_time_unreadable)；T3e-R3-01 起 preview
 * 接受 {force}（与实际执行同参）——force 时时间门是唯一可越过的
 * blocker（降为 warning 返回原计划），权限/内容类 blocker 不可越过。
 *
 * append 非幂等、不重试；结果未知（超时/回读校验读不回）→ conflict
 * （last_error_code='push_outcome_unknown'），由用户核对云端后重推。
 *
 * 状态机对接 S11：push 前置 dirty/conflict → pushing；成功 → pushed
 * （markSourceEditPushed）；随后在锁外发起单文档回拉（SyncEngine
 * apply 链，由路由注入 pullSync），回拉成功由 SyncEngine
 * finalizePushedSourceEdit 清行删备份——本服务不自行清行。
 *
 * 审计：`<dataRoot>/agent/audit/source-pushes.jsonl`（与 S11 的
 * source-edits.jsonl 并列；字段为设计 §7.2 审计要求的推送超集）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { LarkCliError } from '../modules/lark-cli-client.js';
import type { SourceEditActor, SourceEditRecord, SourceEditStateDto } from '../types/index.js';
import { sharedSourceWriteLock, type SourceWriteLockLike } from './source-write-lock.js';
import {
  escapeLiteralAngleBracketsForWrite,
  normalizeForCompare,
  planPush,
} from './push-planner.js';

/** 服务级错误：code/status 对齐设计 §8；响应体 {error, message, details?}。 */
export class FeishuWriteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FeishuWriteError';
  }
}

export interface FeishuWriteServiceDeps {
  /** ConfigManager 面：读 feishuWrite.enabled / knowledgeBaseRoot。 */
  config: {
    getConfig?: () => Record<string, any> | undefined | null;
    load?: () => Promise<Record<string, any>>;
  };
  /** LocalMapStore：documents 行 + source_edits 行 + 状态原语。 */
  store: any;
  /** LarkCliClient：写方法（S12 新增）+ metas + checkAuthReady + fetchDocumentMarkdown。 */
  larkCliClient: any;
  /** 构建活跃探针（接线同 S11：kbBuildService.activeBuild != null）。 */
  kbBuild: { isActive(): boolean };
  /** 数据根（base.md 与审计落点）。 */
  dataRoot: string;
  /** 当前编辑视图读取（SourceEditService.read 的 duck-type；S12 只用 body/state/relPath/title）。 */
  readEditView(objToken: string): Promise<{
    relPath: string;
    title: string;
    header: string;
    body: string;
    bodyHash: string;
    state: SourceEditStateDto | null;
  }>;
  /** 单文档回拉（SyncEngine apply 链；推送成功且置 pushed 后调用）。 */
  pullSync(objToken: string): Promise<{ ok: boolean; status: string; message?: string }>;
  /** 与 SyncEngine / SourceEditService 共享的 per-token 锁；缺省进程级共享实例。 */
  locks?: SourceWriteLockLike;
  /** S0 D4 定稿 true；测试可注入。 */
  overwriteSupported?: boolean;
}

export interface PushExecutionOptions {
  allowOverwrite?: boolean;
  force?: boolean;
  acknowledgedUnknownUpdatedAt?: string;
  confirm: string;
  actor?: SourceEditActor;
}

const PUSH_CONFIRM = 'PUSH';
const OVERWRITE_CONFIRM = 'OVERWRITE_CLOUD';

// =========================================================================
// P0-S9 §6.1：title_change_not_pushed 警告（push 预览）
// =========================================================================

/** 警告码（UI warning 面板消费的机器可读锚点；§6.1）。 */
export const TITLE_CHANGE_NOT_PUSHED_CODE = 'title_change_not_pushed';

/** 提取正文首个一级标题文本（无 H1 → null）。 */
export function firstH1Title(body: string): string | null {
  for (const line of body.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * 警告文案（前端 warning 面板消费的文案常量同源；码前缀供机器匹配）。
 * 改名受 local_edit_pending 门（U31：有未写回本地修改时拒绝）——文案
 * 引导「推送完成后」再改名，与门序一致。
 */
export function titleChangeNotPushedMessage(localTitle: string, syncedTitle: string): string {
  return `${TITLE_CHANGE_NOT_PUSHED_CODE}: 本地标题「${localTitle}」与飞书标题「${syncedTitle || '（空）'}」不一致，推送正文不会同步标题；推送完成后可在文档预览「在飞书重命名」同步标题`;
}

/**
 * 警告判定（§6.1）：「本地正文首个 H1 与标题不同 **且基线中二者相同**」
 * ——分叉由本次本地编辑引入（基线本就分叉的同步态不警告）。标题取
 * documents 行（最近一次同步的云端标题；改名回拉一致后警告自然消除）。
 */
export function computeTitleChangeNotPushed(input: {
  syncedTitle: string;
  currentBody: string;
  baseBody: string;
}): { localTitle: string; syncedTitle: string } | null {
  const local = firstH1Title(input.currentBody);
  if (local == null || local === input.syncedTitle) return null;
  if (firstH1Title(input.baseBody) !== input.syncedTitle) return null;
  return { localTitle: local, syncedTitle: input.syncedTitle };
}

/** v1 写 scope 集（S0 §③ 定值；lark-cli-manager.ts 同名常量的服务侧只读镜像）。 */
export const FEISHU_WRITE_SCOPES: readonly string[] = ['docx:document:write_only'];

/**
 * anchor_exact（U23；T4b-09 统一秒级口径，写回链与回滚链共用）：
 * 锚点历史时间（ISO 字符串，毫秒）≥ 云端 obj_edit_time（**秒**，
 * getDocumentMetas.latestModifyTime 通道本就是秒——不得再除 1000）。
 * 秒级取整比较（飞书历史按秒取整）：早 1 秒 → false；相等 → true；
 * 任一侧不可读/非有限数值 → false（保守，UI 明示「回滚点早于写前
 * 状态，会一并撤销此期间的云端修改」）。
 */
export function computeAnchorExactSeconds(
  anchorHistoryTime: string | null,
  cloudObjEditTimeSec: number | null,
): boolean {
  if (anchorHistoryTime == null || cloudObjEditTimeSec == null) return false;
  const anchorMs = Date.parse(anchorHistoryTime);
  if (!Number.isFinite(anchorMs) || !Number.isFinite(cloudObjEditTimeSec)) return false;
  return Math.floor(anchorMs / 1000) >= Math.floor(cloudObjEditTimeSec);
}

export class FeishuWriteService {
  constructor(private readonly deps: FeishuWriteServiceDeps) {}

  private get locks(): SourceWriteLockLike {
    return this.deps.locks ?? sharedSourceWriteLock;
  }

  /**
   * P0-S4（§4.4 cloud_revert_running 互斥）：该 objToken 是否有进行中的
   * 云端回滚（source_push_log.revert_state='running'，共享状态源由 S4
   * CloudHistoryService 同步写入）。访问器缺失（旧桩）按无回滚处理，
   * 不影响既有链路。
   */
  private hasRunningCloudRevert(objToken: string): boolean {
    return this.deps.store.getRunningRevertPushLog?.(objToken) != null;
  }

  /**
   * P2-S6（lark-cli-newcaps-P2 §3.4/§3.5 云端移出互斥；T4b-05 修订）：
   * 移出进行中（pending/moving）、已移出（最近一行 moved）或结果未知
   * （unknown——超时/不可解析/重启对账，云端可能仍在执行或已执行）——
   * 进行中/未知拒 cloud_move_running，已移出拒 source_moved_out（文档
   * 已离开受管树，写回后的回拉收敛路径不再成立）。unknown 只经权威
   * 核对（CloudMoveService.reconcileUnknownMove）证明未移出后解除。
   * 与 hasRunningCloudRevert 同风格容错；围栏状态源 =
   * store.getActiveCloudMove / getLatestCloudMove（四方共用同一解释）。
   */
  private cloudMoveBlockReason(objToken: string): 'cloud_move_running' | 'source_moved_out' | null {
    const active = this.deps.store.getActiveCloudMove?.(objToken) ?? null;
    if (active != null) return 'cloud_move_running';
    const latest = this.deps.store.getLatestCloudMove?.(objToken) ?? null;
    return latest?.state === 'moved' ? 'source_moved_out' : null;
  }

  private get overwriteSupported(): boolean {
    return this.deps.overwriteSupported !== false;
  }

  private editsDir(objToken: string): string {
    return path.join(this.deps.dataRoot, 'source-edits', objToken);
  }

  private auditPath(): string {
    return path.join(this.deps.dataRoot, 'agent', 'audit', 'source-pushes.jsonl');
  }

  private appendAudit(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath()), { recursive: true });
      fs.appendFileSync(this.auditPath(), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
      console.error('[FeishuWriteService] audit append failed:', error);
    }
  }

  // =========================================================================
  // 门槛：feishuWrite.enabled + write scopes
  // =========================================================================

  private feishuWriteEnabled(): boolean {
    const config = this.deps.config.getConfig?.() ?? null;
    return config?.feishuWrite?.enabled === true;
  }

  /** 写 scope 已授予判定（scopeSet:'write' device flow 授予后为真）。 */
  async writeScopesGranted(): Promise<{ granted: boolean; missingScopes: string[] }> {
    const readiness = await this.deps.larkCliClient.checkAuthReady({ verify: false });
    const grantedSet = new Set<string>(readiness?.currentScopes ?? []);
    const missing = FEISHU_WRITE_SCOPES.filter((scope) => !grantedSet.has(scope));
    return { granted: missing.length === 0, missingScopes: missing };
  }

  private async requireWriteGates(): Promise<void> {
    if (!this.feishuWriteEnabled()) {
      throw new FeishuWriteError(
        'feishu_write_disabled',
        '飞书写回未开启：请在「设置 → 飞书写入」中开启后再推送',
        403,
      );
    }
    const scopes = await this.writeScopesGranted();
    if (!scopes.granted) {
      throw new FeishuWriteError(
        'feishu_write_scope_missing',
        `缺少写回权限（${scopes.missingScopes.join(', ')}）：请发起一次「写入权限」授权（scopeSet=write）后再推送`,
        403,
        { missingScopes: scopes.missingScopes },
      );
    }
  }

  // =========================================================================
  // 云端读取（T3b-03：obj_edit_time 读取失败一律按不可读处理，非 force
  // 推送 fail-closed；revision 容错不变——overwrite 前置读取自会拒绝）
  // =========================================================================

  /** 单文档云端 obj_edit_time（drive metas batch，ChangeDetector 同通道）。 */
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

  /** docx v1 documents API 读取当前 revision（S0 D6：写后即时可读）。 */
  private async fetchRevision(objToken: string): Promise<number | null> {
    const result = await this.deps.larkCliClient.fetchDocumentRevision(objToken);
    const revision = result?.revisionId ?? result?.revision_id ?? null;
    return typeof revision === 'number' && Number.isFinite(revision) ? revision : null;
  }

  /** docs +fetch 正文（写后回读校验用）。 */
  private async fetchCloudBody(objToken: string): Promise<string> {
    const result = await this.deps.larkCliClient.fetchDocumentMarkdown(objToken);
    const document = result?.data?.document ?? {};
    return typeof document.content === 'string' ? document.content : '';
  }

  // =========================================================================
  // P0-S3 §4.2：写前回退锚点（history-list 第 1 页最新条目）
  // =========================================================================

  /**
   * 取回退锚点（U22/U23）：listDocumentHistory(objToken, {pageSize:5})
   * 第 1 页最新条目（历史异步定型，不保证覆盖写前全部修改——anchor_exact
   * 判定交由 UI 明示）。取锚失败容错为空锚（historyVersionId=null +
   * error 记原因），是否阻断由调用方按 mode 裁定（§4.2 步骤 3）。
   */
  private async fetchRollbackAnchor(objToken: string): Promise<{
    historyVersionId: string | null;
    revisionId: number | null;
    historyTime: string | null;
    error: string | null;
  }> {
    try {
      const page = await this.deps.larkCliClient.listDocumentHistory(objToken, { pageSize: 5 });
      const entry = page?.entries?.[0];
      if (typeof entry?.historyVersionId === 'string' && entry.historyVersionId !== '') {
        return {
          historyVersionId: entry.historyVersionId,
          revisionId: typeof entry.revisionId === 'number' ? entry.revisionId : null,
          historyTime: typeof entry.editTime === 'string' ? entry.editTime : null,
          error: null,
        };
      }
      return { historyVersionId: null, revisionId: null, historyTime: null, error: 'history_list_empty' };
    } catch (error) {
      const code = error instanceof LarkCliError ? (error.upstreamCode ?? error.code) : 'history_list_failed';
      return { historyVersionId: null, revisionId: null, historyTime: null, error: String(code) };
    }
  }

  /**
   * anchor_exact（U23；T4b-09 起为纯函数 computeAnchorExactSeconds 的
   * 委托，与回滚链共用同一判定）。语义见导出函数注释。
   */
  private computeAnchorExact(anchorHistoryTime: string | null, preObjEditTime: number | null): boolean {
    return computeAnchorExactSeconds(anchorHistoryTime, preObjEditTime);
  }

  /**
   * 锚点行状态更新（§4.2 步骤 6/7）——best-effort：主写入（云端 append/
   * overwrite 与 source_edits 状态机）已完成，日志更新失败只记控制台
   * 错误，不改变已发生的推送结果（与 appendAudit 同容错模式）。
   */
  private safeUpdatePushLog(
    pushLogId: string | null,
    patch: {
      outcome?: 'started' | 'pushed' | 'conflict' | 'failed' | 'unknown';
      postRevisionId?: string | null;
      postObjEditTime?: string | null;
    },
  ): void {
    if (!pushLogId) return;
    try {
      this.deps.store.updateSourcePushLog(pushLogId, patch);
    } catch (error) {
      console.error('[FeishuWriteService] source_push_log update failed:', error);
    }
  }

  // =========================================================================
  // preview（计划态，不改 source_edits）
  // =========================================================================

  async preview(objToken: string, options?: { force?: boolean }): Promise<{
    mode: 'append' | 'overwrite' | 'blocked';
    blockedReason?: string;
    appendMarkdown?: string;
    bytes: number;
    cloud: { objEditTime: string | null; revisionId: number | null };
    conflict: boolean;
    warnings: string[];
    /** P0-S3 §4.2：写前回退锚点（无锚为 null；字段语义见 SourcePushPlanDto）。 */
    rollbackAnchor: {
      historyVersionId: string;
      revisionId: number | null;
      historyTime: string | null;
      exact: boolean;
    } | null;
    anchorBlockedReason?: 'rollback_anchor_unavailable';
    /** P0-S9 §6.1：本地编辑引入的 H1/标题分叉（无分叉为 null；改名后回拉一致即消除）。 */
    titleChangeNotPushed: { localTitle: string; syncedTitle: string } | null;
    unknownPushUpdatedAt: string | null;
  }> {
    const warnings: string[] = [];
    const { baseBody } = this.requireEditBaseline(objToken);
    const view = await this.deps.readEditView(objToken);
    // P0-S9 §6.1：本地编辑改了首个 H1（与标题分叉）→ title_change_not_pushed
    // 警告——推送正文不会同步标题，引导用户推送后用「在飞书重命名」。
    // 无论后续门控/计划形态如何都先算出来（只读本地比对，零成本）。
    const titleChangeNotPushed = computeTitleChangeNotPushed({
      syncedTitle: view.title,
      currentBody: view.body,
      baseBody,
    });
    if (titleChangeNotPushed != null) {
      warnings.push(
        titleChangeNotPushedMessage(titleChangeNotPushed.localTitle, titleChangeNotPushed.syncedTitle),
      );
    }

    let mode: 'append' | 'overwrite' | 'blocked';
    let blockedReason: string | undefined;
    let appendMarkdown: string | undefined;
    if (!this.feishuWriteEnabled()) {
      mode = 'blocked';
      blockedReason = 'write_disabled';
    } else {
      const scopes = await this.writeScopesGranted();
      if (!scopes.granted) {
        mode = 'blocked';
        blockedReason = 'write_scope_missing';
        warnings.push(`缺少写回权限：${scopes.missingScopes.join(', ')}（发起 scopeSet=write 授权）`);
      } else if (this.hasRunningCloudRevert(objToken)) {
        // P0-S4：云端回滚进行中 → blocked(cloud_revert_running)（§4.3
        // blockedReason 语义；批准前暴露）。
        mode = 'blocked';
        blockedReason = 'cloud_revert_running';
      } else {
        // P2-S6：云端移出互斥（§3.4/§3.5）——进行中 / 已移出（写回链
        // 后的回拉收敛不再成立），批准前暴露。
        const moveBlock = this.cloudMoveBlockReason(objToken);
        if (moveBlock != null) {
          mode = 'blocked';
          blockedReason = moveBlock;
        } else {
        // preview 以能力上限规划（allowOverwrite=true）：覆盖与否最终由
        // push 请求体 allowOverwrite + confirm 门决定。
        const plan = planPush({
          baseBody,
          currentBody: view.body,
          allowOverwrite: true,
          overwriteSupported: this.overwriteSupported,
        });
        mode = plan.mode;
        blockedReason = plan.blockedReason;
        appendMarkdown = plan.appendMarkdown;
        }
      }
    }

    const cloudTime = await this.fetchCloudObjEditTime(objToken);
    const row: SourceEditRecord | null = this.deps.store.getSourceEdit?.(objToken) ?? null;
    const baseTime = row?.baseObjEditTime != null ? Number(row.baseObjEditTime) : null;
    const cloudTimeReadable = cloudTime != null && Number.isFinite(cloudTime);
    const baseTimeReadable = baseTime != null && Number.isFinite(baseTime);
    // T3b-03：云端时间不可读 → fail-closed（预览同步 blocked；不再按
    //「无前置冲突」放行——三段式回读补救不了写前已覆盖的远端内容）。
    // T3e-R3-01：时间门是唯一可由显式强推越过的 blocker——preview 携带
    // force（与实际执行同参）时降为 warning、保留 append/overwrite 计划
    //（与 pushLocked 的 force 契约一致）；权限/内容类 blocker（write_
    // disabled/write_scope_missing/no_changes 等）不可越过，语义不变。
    const force = options?.force === true;
    if (!cloudTimeReadable) {
      warnings.push(force
        ? '云端 obj_edit_time 不可读：按显式强推（force）越过时间门，覆盖前请核对云端可能的并发修改'
        : '云端 obj_edit_time 不可读：写回已阻断（fail-closed）。请稍后重试，或核对云端后以 force + OVERWRITE_CLOUD 确认覆盖');
    }
    if (mode !== 'blocked' && (!cloudTimeReadable || !baseTimeReadable) && !force) {
      mode = 'blocked';
      blockedReason = 'cloud_time_unreadable';
      appendMarkdown = undefined;
    }
    const revisionId = await this.fetchRevision(objToken).catch(() => null);
    const conflict = cloudTimeReadable && baseTimeReadable && (cloudTime as number) > (baseTime as number);
    if (mode === 'overwrite') warnings.push('覆盖将丢失云端评论锚点/协作块等页面级内容');

    // P0-S3 §4.2：预览也实际调用一次 history-list（只读）——overwrite 无锚
    // 的 blocked 在批准前暴露；append 无锚仅警告（U22 尽力而为）。锚点
    // 规则不因 force 豁免（force 唯一不能越过的门）。
    const anchor = await this.fetchRollbackAnchor(objToken);
    const rollbackAnchor = anchor.historyVersionId != null ? {
      historyVersionId: anchor.historyVersionId,
      revisionId: anchor.revisionId,
      historyTime: anchor.historyTime,
      exact: this.computeAnchorExact(anchor.historyTime, cloudTimeReadable ? (cloudTime as number) : null),
    } : null;
    let anchorBlockedReason: 'rollback_anchor_unavailable' | undefined;
    if (rollbackAnchor == null) {
      if (mode === 'overwrite') {
        mode = 'blocked';
        blockedReason = 'rollback_anchor_unavailable';
        anchorBlockedReason = 'rollback_anchor_unavailable';
        appendMarkdown = undefined;
      } else if (mode === 'append') {
        warnings.push(
          `写回锚点不可用（${anchor.error ?? 'history_list_empty'}）：本次追加无回退锚点，如需撤销请到飞书云端核对处理`,
        );
      }
    }

    return {
      mode,
      blockedReason,
      appendMarkdown,
      bytes: Buffer.byteLength(
        mode === 'append' && appendMarkdown !== undefined ? appendMarkdown : view.body,
        'utf-8',
      ),
      cloud: {
        objEditTime: cloudTime != null ? String(cloudTime) : null,
        revisionId,
      },
      conflict,
      warnings,
      rollbackAnchor,
      titleChangeNotPushed,
      unknownPushUpdatedAt: row && (row.lastErrorCode === 'push_outcome_unknown' || row.lastErrorCode === 'push_interrupted') ? row.updatedAt : null,
      ...(anchorBlockedReason !== undefined ? { anchorBlockedReason } : {}),
    };
  }

  // =========================================================================
  // push（执行态）
  // =========================================================================

  async push(
    objToken: string,
    options: PushExecutionOptions,
  ): Promise<{
    state: string;
    mode: 'append' | 'overwrite';
    revisionId: number | null;
    /** 本次写回的锚点行 id（P0-S3；预览/UI/回滚服务消费）。 */
    pushLogId: string | null;
    pull: { ok: boolean; status: string; message?: string };
  }> {
    if (this.deps.kbBuild?.isActive()) {
      throw new FeishuWriteError('kb_build_active', '标准库构建进行中，暂不能写回飞书（构建结束或取消后再试）', 409);
    }
    // P0-S4（§4.2 步骤 1 新增门）：云端回滚进行中 → 409 cloud_revert_running
    //（回滚后的回拉会与写回交错；回滚与写回对同一 objToken 互斥）。
    if (this.hasRunningCloudRevert(objToken)) {
      throw new FeishuWriteError(
        'cloud_revert_running',
        '该文档有进行中的云端回滚，暂不能写回飞书（回滚完成后再试）',
        409,
      );
    }
    // P2-S6（lark-cli-newcaps-P2 §3.4/§3.5；T4b-05 修订）：云端移出互斥
    // ——进行中/结果未知拒 cloud_move_running；已移出拒 source_moved_out
    // （文档已离开受管树，写回后的回拉收敛路径不再成立）。
    const moveBlock = this.cloudMoveBlockReason(objToken);
    if (moveBlock === 'cloud_move_running') {
      throw new FeishuWriteError(
        'cloud_move_running',
        '该文档有进行中或结果未知的移出到云空间，暂不能写回飞书：请先在移出记录完成权威核对（确认未移出后再操作）',
        409,
      );
    }
    if (moveBlock === 'source_moved_out') {
      throw new FeishuWriteError(
        'source_moved_out',
        '该文档已移出到云空间（不再受知识库管理）：本地文件保留但不再支持写回',
        409,
      );
    }
    await this.requireWriteGates();
    const actor: SourceEditActor = options.actor === 'cli' || options.actor === 'agent' ? options.actor : 'ui';

    // pushLocked 仅在「写成功 + 置 pushed」后返回；失败语义（conflict /
    // dirty + FeishuWriteError）由其内部抛出，此处不重复校验状态（避免把
    // 返回后的并发新编辑误判为推送失败）。
    const outcome = await this.locks.withLock(objToken, () => this.pushLocked(objToken, options, actor));

    // 回拉在锁外执行：SyncEngine 提交会自行获取同一把 per-token 锁
    //（SourceWriteLock 无重入，锁内调用会自死锁）。pushed 行不阻断同步；
    // 回拉成功由 SyncEngine.finalizePushedSourceEdit 清行删备份。
    let pull: { ok: boolean; status: string; message?: string };
    try {
      pull = await this.deps.pullSync(objToken);
    } catch (error) {
      pull = {
        ok: false,
        status: 'pull_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    // P0-S3 §4.2 步骤 7：回拉成功后把 SyncEngine 推进的 synced 值抄进
    // 锚点行 post_obj_edit_time（只读抄录，失败不改变推送结果）。
    if (pull.ok) {
      try {
        const synced = this.deps.store.getDocumentByObjToken?.(objToken)?.syncedObjEditTime ?? null;
        if (synced != null) {
          this.safeUpdatePushLog(outcome.pushLogId, { postObjEditTime: String(synced) });
        }
      } catch {
        // documents 行缺失/读失败：post_obj_edit_time 留空（仅诊断字段）。
      }
    }
    return {
      state: (this.deps.store.getSourceEdit?.(objToken) ?? null)?.state ?? 'pushed',
      mode: outcome.mode,
      revisionId: outcome.revisionId,
      pushLogId: outcome.pushLogId,
      pull,
    };
  }

  /** 基线读取：source_edits 行 + base.md（缺失即数据完整性故障，拒绝推送）。 */
  private requireEditBaseline(objToken: string): { row: SourceEditRecord; baseBody: string } {
    const row: SourceEditRecord | null = this.deps.store.getSourceEdit?.(objToken) ?? null;
    if (!row) {
      throw new FeishuWriteError('source_edit_not_found', '该文档没有未写回的本地修改，无需推送', 404);
    }
    const baseFile = path.join(this.editsDir(objToken), 'base.md');
    let baseBody: string;
    try {
      baseBody = fs.readFileSync(baseFile, 'utf-8');
    } catch {
      throw new FeishuWriteError(
        'push_base_missing',
        `找不到首次编辑前备份（${baseFile}）：请放弃修改后重新编辑，或手动恢复备份`,
        500,
      );
    }
    return { row, baseBody };
  }

  private async pushLocked(
    objToken: string,
    options: PushExecutionOptions,
    actor: SourceEditActor,
  ): Promise<{ mode: 'append' | 'overwrite'; revisionId: number | null; pushLogId: string | null }> {
    // 锁外的授权检查可能等待云端；等待期间回滚或移出可能已经启动。
    if (this.deps.kbBuild?.isActive()) throw new FeishuWriteError('kb_build_active', '标准库构建进行中，暂不能写回', 409);
    if (this.hasRunningCloudRevert(objToken)) throw new FeishuWriteError('cloud_revert_running', '云端回滚进行中或结果未知，请先核对', 409);
    const moveBlock = this.cloudMoveBlockReason(objToken);
    if (moveBlock) throw new FeishuWriteError(moveBlock, '云端移出正在进行、结果未知或已经完成，不能写回', 409);
    const { row, baseBody } = this.requireEditBaseline(objToken);
    if (row.state === 'pushing') {
      throw new FeishuWriteError('source_push_in_progress', '该文档正在写回飞书，请等待推送结束后再操作', 409);
    }
    if ((row.lastErrorCode === 'push_outcome_unknown' || row.lastErrorCode === 'push_interrupted')
        && (!row.updatedAt || options.acknowledgedUnknownUpdatedAt !== row.updatedAt)) {
      throw new FeishuWriteError('source_push_unknown_unconfirmed', '上次写回结果未知。请先确认上次操作已结束，并核对飞书内容确实需要再次写回', 409);
    }
    const view = await this.deps.readEditView(objToken);

    const plan = planPush({
      baseBody,
      currentBody: view.body,
      allowOverwrite: options.allowOverwrite === true,
      overwriteSupported: this.overwriteSupported,
    });
    if (plan.mode === 'blocked') {
      throw new FeishuWriteError(
        'source_push_blocked',
        `当前修改形态不可推送（${plan.blockedReason}）`,
        422,
        { reason: plan.blockedReason },
      );
    }

    // confirm 门（设计 §7.4）：overwrite 或 force → OVERWRITE_CLOUD；否则 PUSH。
    const requiredConfirm = plan.mode === 'overwrite' || options.force === true
      ? OVERWRITE_CONFIRM
      : PUSH_CONFIRM;
    if (options.confirm !== requiredConfirm) {
      throw new FeishuWriteError(
        'confirmation_required',
        `写回飞书需要 confirm: "${requiredConfirm}"`,
        400,
      );
    }

    this.deps.store.markSourceEditPushing(objToken);

    // U20① + T3b-03：obj_edit_time 前置比较（唯一竞态防线）。云端或基线
    // 时间不可读 → fail-closed 拒绝（不写、不回拉、保留 dirty）；force +
    // OVERWRITE_CLOUD 可越过（显式用户决策）。
    let preCloudTime: number | null = null;
    if (options.force !== true) {
      const cloudTime = await this.fetchCloudObjEditTime(objToken);
      const baseTime = row.baseObjEditTime != null ? Number(row.baseObjEditTime) : null;
      const timeReadable = cloudTime != null && Number.isFinite(cloudTime)
        && baseTime != null && Number.isFinite(baseTime);
      if (!timeReadable) {
        const message = '无法取得可信的云端 obj_edit_time（或本地基线时间），已拒绝写回以保护云端可能的并发修改：请稍后重试，或核对云端后以 force + OVERWRITE_CLOUD 确认覆盖';
        this.deps.store.markSourceEditPushAborted(objToken, { code: 'cloud_time_unreadable', message });
        this.appendAudit({ actor, objToken, relPath: row.localRelPath, op: 'push', mode: plan.mode, result: 'error', errorCode: 'cloud_time_unreadable' });
        throw new FeishuWriteError('cloud_time_unreadable', message, 502);
      }
      if ((cloudTime as number) > (baseTime as number)) {
        const message = `云端文档在本地编辑后有新的修改（obj_edit_time ${row.baseObjEditTime} → ${cloudTime}）：请先回拉同步并核对，或以 force + ${OVERWRITE_CONFIRM} 确认覆盖云端`;
        this.deps.store.markSourceEditConflict(objToken, { code: 'source_push_conflict', message });
        this.appendAudit({ actor, objToken, relPath: row.localRelPath, op: 'push', mode: plan.mode, result: 'conflict', errorCode: 'source_push_conflict' });
        throw new FeishuWriteError('source_push_conflict', message, 409, { cloudObjEditTime: cloudTime });
      }
      preCloudTime = cloudTime;
    }

    // P0-S3 §4.2 步骤 3：取回退锚点（在时间门之后——时间门失败时不浪费
    // 一次 history 调用，也不留无意义锚点）。overwrite 无锚（history-list
    // 空/失败）→ 回退 pushing→进入时状态并拒绝执行；append 无锚 →
    // anchor_error 记原因照常推送（U22 尽力而为）。锚点规则不因 force
    // 豁免：force 的语义是「接受覆盖云端新改动」，不是「放弃回退点」。
    const anchor = await this.fetchRollbackAnchor(objToken);
    if (plan.mode === 'overwrite' && anchor.historyVersionId == null) {
      const message = `无法取得云端历史回退锚点（${anchor.error ?? 'history_list_empty'}）：覆盖会改写云端块结构，无回退点时拒绝执行（force 也不可越过）。请稍后重试，或到飞书云端手动核对`;
      // 回退 pushing → 进入时状态（§4.2：原 dirty → dirty；原 conflict → conflict）。
      if (row.state === 'conflict') {
        this.deps.store.markSourceEditConflict(objToken, { code: 'rollback_anchor_unavailable', message });
      } else {
        this.deps.store.markSourceEditPushAborted(objToken, { code: 'rollback_anchor_unavailable', message });
      }
      this.appendAudit({
        actor, objToken, relPath: row.localRelPath, op: 'push', mode: plan.mode,
        result: 'blocked', errorCode: 'rollback_anchor_unavailable', error: anchor.error ?? undefined,
      });
      throw new FeishuWriteError('source_push_blocked', message, 422, { reason: 'rollback_anchor_unavailable' });
    }

    // §4.2 步骤 4：连同 push 计划写入锚点行（outcome='started'；进程中断
    // 由启动对账置 unknown）。pre_obj_edit_time：时间门已读值优先；force
    // 越过时间门时尽力补读（失败可空——force 语义）。anchor_exact = 锚点
    // 历史时间 ≥ 写前云端 obj_edit_time（秒级取整，U23；任一侧不可读 →
    // false 保守）。日志写入失败 → fail-closed 拒绝写回（锚点记不下来时
    // overwrite 没有可用的回退点记录；append 同样拒绝——基础设施故障
    // 时 source_edits 状态机也已不可信，宁可不写）。
    if (preCloudTime == null) {
      preCloudTime = await this.fetchCloudObjEditTime(objToken);
    }
    let pushLogId: string | null = null;
    try {
      pushLogId = this.deps.store.insertSourcePushLog({
        objToken,
        localRelPath: row.localRelPath,
        mode: plan.mode,
        actor,
        preObjEditTime: preCloudTime,
        anchorHistoryId: anchor.historyVersionId,
        anchorHistoryTime: anchor.historyTime,
        anchorExact: this.computeAnchorExact(anchor.historyTime, preCloudTime),
        anchorError: anchor.error,
      });
    } catch (logError) {
      const message = `写前锚点日志写入失败，已拒绝写回（云端未做任何修改）：${logError instanceof Error ? logError.message : String(logError)}`;
      this.deps.store.markSourceEditPushAborted(objToken, { code: 'push_log_unavailable', message });
      this.appendAudit({
        actor, objToken, relPath: row.localRelPath, op: 'push', mode: plan.mode,
        result: 'error', errorCode: 'push_log_unavailable', error: message.slice(0, 200),
      });
      throw new FeishuWriteError('push_log_unavailable', message, 500);
    }

    let writeCompleted = false;
    try {
      const outcome = plan.mode === 'append'
        ? await this.executeAppend(objToken, plan.appendMarkdown ?? '')
        : await this.executeOverwrite(objToken, view.body);
      writeCompleted = true;
      this.deps.store.markSourceEditPushed(objToken, {
        pushMode: outcome.mode,
        pushRevisionId: outcome.revisionId != null ? String(outcome.revisionId) : null,
      });
      // §4.2 步骤 6：成功 → 锚点行 outcome='pushed' + 写后 revision。
      this.safeUpdatePushLog(pushLogId, {
        outcome: 'pushed',
        postRevisionId: outcome.revisionId != null ? String(outcome.revisionId) : null,
      });
      this.appendAudit({
        actor,
        objToken,
        relPath: row.localRelPath,
        op: 'push',
        mode: outcome.mode,
        bytes: outcome.bytes,
        revisionId: outcome.revisionId,
        result: 'pushed',
      });
      return { ...outcome, pushLogId };
    } catch (error) {
      if (writeCompleted) {
        const message = '云端写入已完成，但本地状态保存失败：请核对云端内容，切勿直接重推';
        this.safeUpdatePushLog(pushLogId, { outcome: 'unknown' });
        try { this.deps.store.markSourceEditConflict(objToken, { code: 'push_outcome_unknown', message }); } catch { /* 保留 pushing 围栏供启动对账 */ }
        throw new FeishuWriteError('source_push_conflict', message, 409, { lastErrorCode: 'push_outcome_unknown' });
      }
      // 失败分类（设计 §7.5 步骤 5）：conflict 类置 conflict；其余回 dirty，
      // 原始错误码保留在 last_error_* 与响应 details。
      // P0-S3：锚点行同步迁移——conflict 类 → conflict；
      // push_outcome_unknown（写入结果未知）→ unknown；其余 → failed。
      if (error instanceof FeishuWriteError) {
        const lastErrorCode = String(error.details?.lastErrorCode ?? error.code);
        this.deps.store.markSourceEditConflict(objToken, {
          code: lastErrorCode,
          message: error.message,
        });
        this.safeUpdatePushLog(pushLogId, {
          outcome: lastErrorCode === 'push_outcome_unknown' ? 'unknown' : 'conflict',
        });
        this.appendAudit({
          actor, objToken, relPath: row.localRelPath, op: 'push', mode: plan.mode,
          result: 'conflict', errorCode: lastErrorCode,
        });
        throw error;
      }
      const larkCode = error instanceof LarkCliError ? error.upstreamCode ?? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.markSourceEditPushAborted(objToken, {
        code: larkCode != null ? `lark_${larkCode}` : 'feishu_write_failed',
        message: message.slice(0, 500),
      });
      this.safeUpdatePushLog(pushLogId, { outcome: 'failed' });
      this.appendAudit({
        actor, objToken, relPath: row.localRelPath, op: 'push', mode: plan.mode,
        result: 'error', errorCode: larkCode ?? 'feishu_write_failed', error: message.slice(0, 500),
      });
      throw new FeishuWriteError('feishu_write_failed', `飞书写回失败：${message}`.slice(0, 560), 502, {
        ...(larkCode != null ? { larkCode } : {}),
      });
    }
  }

  /** append：非幂等，不重试；超时/结果未知 → conflict(push_outcome_unknown)。 */
  private async executeAppend(
    objToken: string,
    appendMarkdown: string,
  ): Promise<{ mode: 'append'; revisionId: number | null; bytes: number }> {
    const payload = escapeLiteralAngleBracketsForWrite(appendMarkdown);
    try {
      const result = await this.deps.larkCliClient.updateDocumentAppend(objToken, payload);
      return {
        mode: 'append',
        revisionId: this.readRevisionId(result),
        bytes: Buffer.byteLength(payload, 'utf-8'),
      };
    } catch (error) {
      throw this.classifyWriteError(error, 'append');
    }
  }

  /**
   * overwrite 三段式（S0 §④-1）：fetch revision → 立即 overwrite → 写后
   * 回读校验（归一化比对，失配即 conflict，绝不重试旧 revision）。
   */
  private async executeOverwrite(
    objToken: string,
    body: string,
  ): Promise<{ mode: 'overwrite'; revisionId: number | null; bytes: number }> {
    // ① fetch 最新 revision。
    let revision: number | null;
    try {
      revision = await this.fetchRevision(objToken);
    } catch (error) {
      throw this.classifyWriteError(error, 'overwrite_fetch');
    }
    if (revision == null) {
      // 未写入任何内容：按「其他错误」回 dirty（设计 §7.5 步骤 5），
      // 不占 conflict 语义。
      throw new Error('无法读取云端文档 revision（overwrite 前置条件缺失），本次未写入任何内容');
    }

    // ② 同一流程内立即 overwrite（revision 仅防未来值，不防过期——S0 D5）。
    const payload = escapeLiteralAngleBracketsForWrite(body);
    let writtenRevision: number | null;
    try {
      const result = await this.deps.larkCliClient.overwriteDocument(objToken, payload, revision);
      writtenRevision = this.readRevisionId(result) ?? revision;
    } catch (error) {
      throw this.classifyWriteError(error, 'overwrite');
    }

    // ③ 写后回读校验：fetch 正文归一化后与预期比对。
    let fetchedBody: string;
    try {
      fetchedBody = await this.fetchCloudBody(objToken);
    } catch (error) {
      // 写已发生、校验读不回 → 结果未知，置 conflict 交用户核对。
      void error;
      throw new FeishuWriteError(
        'source_push_conflict',
        '覆盖已提交但回读校验失败（无法读取云端正文）：请核对云端内容后重推或放弃修改',
        409,
        { lastErrorCode: 'push_outcome_unknown', revisionId: writtenRevision },
      );
    }
    if (normalizeForCompare(fetchedBody) !== normalizeForCompare(body)) {
      throw new FeishuWriteError(
        'source_push_conflict',
        '覆盖后回读校验失配（云端内容与预期不一致，可能存在并发写入）：请回拉核对云端内容，切勿直接重试覆盖',
        409,
        { lastErrorCode: 'push_readback_mismatch', revisionId: writtenRevision },
      );
    }
    return {
      mode: 'overwrite',
      revisionId: writtenRevision,
      bytes: Buffer.byteLength(payload, 'utf-8'),
    };
  }

  /**
   * 写命令错误分类：
   *   - 4000002（revision 未来值）→ conflict(push_revision_conflict)；
   *   - timeout → 结果未知 → conflict(push_outcome_unknown)（append/overwrite
   *     均非幂等，不重试）；
   *   - 其余 → 原样包装（pushLocked 落 dirty）。
   */
  private classifyWriteError(error: unknown, phase: string): Error {
    if (error instanceof LarkCliError) {
      if (error.upstreamCode === '4000002') {
        return new FeishuWriteError(
          'source_push_conflict',
          '飞书拒绝写入：revision 为未来值（云端版本与预期不符）。请回拉核对云端内容后重试',
          409,
          { lastErrorCode: 'push_revision_conflict' },
        );
      }
      if (phase !== 'overwrite_fetch' && (error.code === 'timeout' || error.code === 'parse' || error.code === 'incomplete_response')) {
        return new FeishuWriteError(
          'source_push_conflict',
          `飞书写回响应不可确定（${phase}，${error.code}），写入结果未知：请核对云端内容后重推或放弃修改，不会自动重试`,
          409,
          { lastErrorCode: 'push_outcome_unknown' },
        );
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /** update 响应的 revision 容错读取（client 归一 camelCase / S0 D4 顶层蛇形）。 */
  private readRevisionId(result: any): number | null {
    const revision = result?.revisionId
      ?? result?.revision_id
      ?? result?.data?.revision_id
      ?? result?.data?.revisionId
      ?? result?.data?.document?.revision_id;
    return typeof revision === 'number' && Number.isFinite(revision) ? revision : null;
  }
}
