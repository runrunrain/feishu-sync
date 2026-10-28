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
 * T3b-03（fail-closed）：非 force 推送时云端 obj_edit_time（或本地基线
 * 时间）不可读 → 拒绝写入（cloud_time_unreadable，保留 dirty，不写不
 * 回拉）——写后回读无法补救写前已覆盖的远端内容，唯一前置防线失效时
 * 不得继续；force + OVERWRITE_CLOUD 仍可越过（显式用户决策）。preview
 * 同语义：不可读 → blocked(cloud_time_unreadable)。
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
  confirm: string;
  actor?: SourceEditActor;
}

const PUSH_CONFIRM = 'PUSH';
const OVERWRITE_CONFIRM = 'OVERWRITE_CLOUD';

/** v1 写 scope 集（S0 §③ 定值；lark-cli-manager.ts 同名常量的服务侧只读镜像）。 */
export const FEISHU_WRITE_SCOPES: readonly string[] = ['docx:document:write_only'];

export class FeishuWriteService {
  constructor(private readonly deps: FeishuWriteServiceDeps) {}

  private get locks(): SourceWriteLockLike {
    return this.deps.locks ?? sharedSourceWriteLock;
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
  // preview（计划态，不改 source_edits）
  // =========================================================================

  async preview(objToken: string): Promise<{
    mode: 'append' | 'overwrite' | 'blocked';
    blockedReason?: string;
    appendMarkdown?: string;
    bytes: number;
    cloud: { objEditTime: string | null; revisionId: number | null };
    conflict: boolean;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const { baseBody } = this.requireEditBaseline(objToken);
    const view = await this.deps.readEditView(objToken);

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

    const cloudTime = await this.fetchCloudObjEditTime(objToken);
    const row: SourceEditRecord | null = this.deps.store.getSourceEdit?.(objToken) ?? null;
    const baseTime = row?.baseObjEditTime != null ? Number(row.baseObjEditTime) : null;
    const cloudTimeReadable = cloudTime != null && Number.isFinite(cloudTime);
    const baseTimeReadable = baseTime != null && Number.isFinite(baseTime);
    // T3b-03：云端时间不可读 → fail-closed（预览同步 blocked；不再按
    //「无前置冲突」放行——三段式回读补救不了写前已覆盖的远端内容）。
    if (!cloudTimeReadable) {
      warnings.push('云端 obj_edit_time 不可读：写回已阻断（fail-closed）。请稍后重试，或核对云端后以 force + OVERWRITE_CLOUD 确认覆盖');
    }
    if (mode !== 'blocked' && (!cloudTimeReadable || !baseTimeReadable)) {
      mode = 'blocked';
      blockedReason = 'cloud_time_unreadable';
      appendMarkdown = undefined;
    }
    const revisionId = await this.fetchRevision(objToken).catch(() => null);
    const conflict = cloudTimeReadable && baseTimeReadable && (cloudTime as number) > (baseTime as number);
    if (mode === 'overwrite') warnings.push('覆盖将丢失云端评论锚点/协作块等页面级内容');

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
    pull: { ok: boolean; status: string; message?: string };
  }> {
    if (this.deps.kbBuild?.isActive()) {
      throw new FeishuWriteError('kb_build_active', '标准库构建进行中，暂不能写回飞书（构建结束或取消后再试）', 409);
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
    return {
      state: (this.deps.store.getSourceEdit?.(objToken) ?? null)?.state ?? 'pushed',
      mode: outcome.mode,
      revisionId: outcome.revisionId,
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
  ): Promise<{ mode: 'append' | 'overwrite'; revisionId: number | null }> {
    const { row, baseBody } = this.requireEditBaseline(objToken);
    if (row.state === 'pushing') {
      throw new FeishuWriteError('source_push_in_progress', '该文档正在写回飞书，请等待推送结束后再操作', 409);
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
    }

    try {
      const outcome = plan.mode === 'append'
        ? await this.executeAppend(objToken, plan.appendMarkdown ?? '')
        : await this.executeOverwrite(objToken, view.body);
      this.deps.store.markSourceEditPushed(objToken, {
        pushMode: outcome.mode,
        pushRevisionId: outcome.revisionId != null ? String(outcome.revisionId) : null,
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
      return outcome;
    } catch (error) {
      // 失败分类（设计 §7.5 步骤 5）：conflict 类置 conflict；其余回 dirty，
      // 原始错误码保留在 last_error_* 与响应 details。
      if (error instanceof FeishuWriteError) {
        this.deps.store.markSourceEditConflict(objToken, {
          code: String(error.details?.lastErrorCode ?? error.code),
          message: error.message,
        });
        this.appendAudit({
          actor, objToken, relPath: row.localRelPath, op: 'push', mode: plan.mode,
          result: 'conflict', errorCode: String(error.details?.lastErrorCode ?? error.code),
        });
        throw error;
      }
      const larkCode = error instanceof LarkCliError ? error.upstreamCode ?? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.markSourceEditPushAborted(objToken, {
        code: larkCode != null ? `lark_${larkCode}` : 'feishu_write_failed',
        message: message.slice(0, 500),
      });
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
      if (error.code === 'timeout') {
        return new FeishuWriteError(
          'source_push_conflict',
          `飞书写回超时（${phase}），写入结果未知：请核对云端内容后重推或放弃修改，不会自动重试`,
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
