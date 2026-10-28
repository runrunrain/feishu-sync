/**
 * SourceTitleService — 在飞书重命名文档标题（P0-S9，lark-cli-newcaps-P0
 * §6 / U31）。
 *
 * 语义边界（§6.1）：
 *  - 只做「本地发起 → 飞书改名」：drive +update-title 调用一次，成功后
 *    触发单文档回拉（SyncEngine 正常同步链更新 header 与树展示）。
 *  - **本地文件名/路径不变**：回拉走 path-resolver existing-mapping 分支，
 *    不产生 move blocker；用户如需文件名跟随，走既有「按飞书结构重排
 *    路径」能力，改名不隐式移动文件。
 *  - **不改本地任何状态**：无 source_edits 行、不动 header（header 仍只
 *    由 SyncEngine 生成）；不推进任何 synced 基线（不变量 2）。
 *  - **不从正文推断标题**：正文 H1 改动不经写回同步标题——push 预览的
 *    title_change_not_pushed 警告引导用户用本服务改名（feishu-write-service）。
 *
 * type 派生（§6.2 / P0-S2 契约）：有 wiki_node_token → node token +
 * `--type wiki`（节点与文档标题双向同步；底层 obj token 不被接受）；
 * 否则 obj_token + 实际 objType，只接受 docx/sheet/slides/bitable。
 * 981003（type_mismatch）**不自动换另一种 type 重试**——本地映射可能已
 * 过期，应先重新检测（U31）；981004 → no_edit_permission（S2 未并入
 * classifyError 码表，此处按 upstreamCode 服务层映射）。
 *
 * cloud_revert_running 互斥（§4.4；S4 报告遗留补挂的同源消费）：同一
 * objToken 存在 revert_state='running' 行 → 409（改名成功后的回拉会与
 * 回滚后的回拉交错）。门控与 CloudHistoryService 同序：
 * not_found → title_invalid → write_disabled → scope_missing →
 * kb_build_active → local_edit_pending → cloud_revert_running →
 * unsupported_type → title_unchanged。
 *
 * 风险级与确认（§6.3 任务书定级沿设计）：remote_write，confirm='RENAME'
 * （设计定级非 destructive，确认值不含新标题；新标题由 preview 的
 * planKey=`${target.type}|${to}` 约束——批准期间目标类型或标题变化 →
 * 计划过期重新批准）。CLI 需 --yes；app_command 逐次批准（U15）。
 *
 * 审计：<dataRoot>/agent/audit/source-pushes.jsonl，事件 source_rename，
 * 字段 objToken / from / to / target{token,type} / actor / approvalId? /
 * url?。不记正文。
 */

import fs from 'node:fs';
import path from 'node:path';
import { LarkCliError } from '../modules/lark-cli-client.js';
import type { SourceEditActor } from '../types/index.js';
import { FEISHU_WRITE_SCOPES } from './feishu-write-service.js';
import { sharedSourceWriteLock, type SourceWriteLockLike } from './source-write-lock.js';

/** 服务级错误：code/status 对齐设计 §6.2/§8；响应体 { error, message, details? }。 */
export class SourceTitleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SourceTitleError';
  }
}

/** 改名确认值（remote_write 逐次确认；§6.3 任务书定级沿设计 remote_write）。 */
export const RENAME_CONFIRM_VALUE = 'RENAME';

/** 标题字节上限（§3：标题经 argv 传递，>800 字节拒绝）。 */
export const TITLE_MAX_BYTES = 800;

export type TitleRenameBlockedReason =
  | 'not_found'
  | 'title_invalid'
  | 'write_disabled'
  | 'scope_missing'
  | 'local_edit_pending'
  | 'kb_build_active'
  | 'cloud_revert_running'
  | 'unsupported_type'
  | 'title_unchanged';

export type RenameTargetType = 'wiki' | 'docx' | 'sheet' | 'slides' | 'bitable';

export interface TitleRenamePlan {
  objToken: string;
  /** §6.2 preview DTO target；not_found / unsupported_type 时为 null。 */
  target: { token: string; type: RenameTargetType } | null;
  from: string;
  to: string;
  blockedReason: TitleRenameBlockedReason | null;
  warnings: string[];
}

export interface TitleRenameResult {
  objToken: string;
  target: { token: string; type: RenameTargetType };
  from: string;
  to: string;
  /** 上游回显标题（不可读为 null）。 */
  updatedTitle: string | null;
  url: string | null;
  /** 锁外单文档回拉结果（best-effort；失败交检测链自然收敛）。 */
  pull: { ok: boolean; status: string; message?: string } | null;
}

export interface SourceTitleServiceDeps {
  /** ConfigManager 面：读 feishuWrite.enabled。 */
  config: {
    getConfig?: () => Record<string, any> | undefined | null;
  };
  /** LocalMapStore：documents 行 + source_edits 行 + source_push_log 行。 */
  store: any;
  /** LarkCliClient：updateDocumentTitle + checkAuthReady。 */
  larkCliClient: any;
  /** 构建活跃探针（接线同写回链：kbBuildService.activeBuild != null）。 */
  kbBuild: { isActive(): boolean };
  /** 数据根（审计落点）。 */
  dataRoot: string;
  /** 单文档回拉（与写回/回滚同一 SyncEngine 入口；不改任何基线字段）。 */
  pullSync(objToken: string): Promise<{ ok: boolean; status: string; message?: string }>;
  /** 与 SyncEngine / 写回链共享的 per-token 锁；缺省进程级共享实例。 */
  locks?: SourceWriteLockLike;
}

/**
 * 标题合法性（§3）：非空（trim 后）、无换行、无 NUL、≤800 字节（UTF-8）。
 * 纯函数，路由/命令层与服务层同源消费。
 */
export function isInvalidRenameTitle(title: unknown): boolean {
  if (typeof title !== 'string') return true;
  if (title.trim().length === 0) return true;
  if (/[\n\r\u0000]/.test(title)) return true;
  return Buffer.byteLength(title, 'utf-8') > TITLE_MAX_BYTES;
}

export class SourceTitleService {
  constructor(private readonly deps: SourceTitleServiceDeps) {}

  private get locks(): SourceWriteLockLike {
    return this.deps.locks ?? sharedSourceWriteLock;
  }

  private auditPath(): string {
    return path.join(this.deps.dataRoot, 'agent', 'audit', 'source-pushes.jsonl');
  }

  /** 审计追加（与 FeishuWriteService/CloudHistoryService 同容错：失败只记控制台）。 */
  private appendAudit(event: string, entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath()), { recursive: true });
      fs.appendFileSync(
        this.auditPath(),
        `${JSON.stringify({ time: new Date().toISOString(), event, ...entry })}\n`,
      );
    } catch (error) {
      console.error('[SourceTitleService] audit append failed:', error);
    }
  }

  // =========================================================================
  // 门槛与目标派生
  // =========================================================================

  private feishuWriteEnabled(): boolean {
    const config = this.deps.config.getConfig?.() ?? null;
    return config?.feishuWrite?.enabled === true;
  }

  /** 写 scope 已授予判定（与 FeishuWriteService/CloudHistoryService 同口径）。 */
  private async writeScopesGranted(): Promise<{ granted: boolean; missingScopes: string[] }> {
    const readiness = await this.deps.larkCliClient.checkAuthReady({ verify: false });
    const grantedSet = new Set<string>(readiness?.currentScopes ?? []);
    const missing = FEISHU_WRITE_SCOPES.filter((scope) => !grantedSet.has(scope));
    return { granted: missing.length === 0, missingScopes: missing };
  }

  /** cloud_revert_running 互斥判定（§4.4）：revert_state='running' 行为共享状态源。 */
  private hasRunningRevert(objToken: string): boolean {
    try {
      return this.deps.store.getRunningRevertPushLog?.(objToken) != null;
    } catch {
      return false;
    }
  }

  /**
   * type 派生（§6.2 / P0-S2 契约）：wiki 成员 → node token + 'wiki'
   *（节点与文档标题双向同步）；drive 文档 → objToken + 实际 objType
   *（只接受 docx/sheet/slides/bitable）。不可派生 → null（unsupported_type）。
   */
  private deriveTarget(objToken: string, doc: Record<string, any>): {
    token: string;
    type: RenameTargetType;
  } | null {
    const wikiNodeToken = typeof doc.wikiNodeToken === 'string' && doc.wikiNodeToken !== ''
      ? doc.wikiNodeToken : null;
    if (wikiNodeToken) return { token: wikiNodeToken, type: 'wiki' };
    const objType = typeof doc.objType === 'string' ? doc.objType : '';
    if (objType === 'docx' || objType === 'sheet' || objType === 'slides' || objType === 'bitable') {
      return { token: objToken, type: objType };
    }
    return null;
  }

  private blockedError(
    reason: TitleRenameBlockedReason,
    detail?: { missingScopes?: string[] },
  ): SourceTitleError {
    switch (reason) {
      case 'not_found':
        return new SourceTitleError('not_found', '文档不存在：未登记的 objToken，无法改名', 404);
      case 'title_invalid':
        return new SourceTitleError(
          'title_invalid',
          `新标题非法：必须非空、不含换行/NUL 且不超过 ${TITLE_MAX_BYTES} 字节（UTF-8）`,
          422,
        );
      case 'write_disabled':
        return new SourceTitleError(
          'write_disabled',
          '飞书写回未开启：请在「设置 → 飞书写入」中开启后再在飞书改名',
          403,
        );
      case 'scope_missing':
        return new SourceTitleError(
          'scope_missing',
          `缺少写回权限（${(detail?.missingScopes ?? []).join(', ')}）：请发起一次「写入权限」授权（scopeSet=write）后再改名`,
          403,
          { missingScopes: detail?.missingScopes ?? [] },
        );
      case 'kb_build_active':
        return new SourceTitleError(
          'kb_build_active',
          '标准库构建进行中，暂不能在飞书改名（构建结束或取消后再试）',
          409,
        );
      case 'local_edit_pending':
        return new SourceTitleError(
          'local_edit_pending',
          '该文档有未写回的本地修改：请先写回或放弃本地修改，再在飞书改名（否则改名后的回拉会被本地脏状态阻断）',
          409,
        );
      case 'cloud_revert_running':
        return new SourceTitleError(
          'cloud_revert_running',
          '该文档有进行中的云端回滚，暂不能在飞书改名（回滚完成后再试）',
          409,
        );
      case 'unsupported_type':
        return new SourceTitleError(
          'unsupported_type',
          '该文档类型不支持改名（仅 docx/sheet/slides/bitable 或 wiki 成员）',
          422,
        );
      case 'title_unchanged':
        return new SourceTitleError('title_unchanged', '新标题与当前标题相同，无需改名', 422);
    }
  }

  // =========================================================================
  // buildRenamePlan —— 改名计划（§6.2 preview；不调用任何远端写）
  // =========================================================================

  async buildRenamePlan(objToken: string, title: unknown): Promise<TitleRenamePlan> {
    if (typeof objToken !== 'string' || objToken.trim().length === 0) {
      throw new SourceTitleError('invalid_body', 'objToken 必须是非空字符串', 400);
    }
    const doc = this.deps.store.getDocumentByObjToken?.(objToken) ?? null;
    const to = typeof title === 'string' ? title : '';
    if (!doc) {
      return { objToken, target: null, from: '', to, blockedReason: 'not_found', warnings: [] };
    }
    const from = typeof doc.title === 'string' ? doc.title : '';
    const blocked = (reason: TitleRenameBlockedReason): TitleRenamePlan => ({
      objToken,
      target: this.deriveTarget(objToken, doc),
      from,
      to,
      blockedReason: reason,
      warnings: [],
    });
    // 标题合法性是最便宜的本地校验，先于任何授权调用报告。
    if (isInvalidRenameTitle(title)) return blocked('title_invalid');
    if (!this.feishuWriteEnabled()) return blocked('write_disabled');
    const scopes = await this.writeScopesGranted();
    if (!scopes.granted) return blocked('scope_missing');
    if (this.deps.kbBuild?.isActive()) return blocked('kb_build_active');
    const edit = this.deps.store.getSourceEdit?.(objToken) ?? null;
    if (edit && (edit.state === 'dirty' || edit.state === 'pushing' || edit.state === 'conflict')) {
      return blocked('local_edit_pending');
    }
    if (this.hasRunningRevert(objToken)) return blocked('cloud_revert_running');
    const target = this.deriveTarget(objToken, doc);
    if (target == null) return blocked('unsupported_type');
    if (to === from) return blocked('title_unchanged');
    return { objToken, target, from, to, blockedReason: null, warnings: [] };
  }

  // =========================================================================
  // renameCloudTitle —— 执行改名（remote_write 逐次确认）
  // =========================================================================

  async renameCloudTitle(
    objToken: string,
    title: unknown,
    options: { confirmValue: unknown; actor?: SourceEditActor; approvalId?: string },
  ): Promise<TitleRenameResult> {
    if (typeof options.confirmValue !== 'string' || options.confirmValue !== RENAME_CONFIRM_VALUE) {
      throw new SourceTitleError(
        'confirmation_required',
        `在飞书改名需要 confirm: "${RENAME_CONFIRM_VALUE}"`,
        400,
        { expected: RENAME_CONFIRM_VALUE },
      );
    }
    const actor: SourceEditActor = options.actor === 'cli' || options.actor === 'agent' ? options.actor : 'ui';
    // 锁外快检（fail fast）；全量门控复核在锁内（批准与执行之间状态可能变化）。
    const plan = await this.buildRenamePlan(objToken, title);
    if (plan.blockedReason != null || plan.target == null) {
      throw this.blockedError(plan.blockedReason ?? 'unsupported_type');
    }
    const outcome = await this.locks.withLock(objToken, () =>
      this.renameLocked(objToken, plan.target!, plan.from, plan.to, actor, options.approvalId));
    // 锁外回拉：与写回/回滚同一入口（SyncEngine apply 链）；回拉失败只记
    // 结果交检测链自然收敛——本服务不改任何 synced 基线字段。
    try {
      outcome.pull = await this.deps.pullSync(objToken);
    } catch (error) {
      outcome.pull = {
        ok: false,
        status: 'pull_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return outcome;
  }

  private async renameLocked(
    objToken: string,
    target: { token: string; type: RenameTargetType },
    from: string,
    to: string,
    actor: SourceEditActor,
    approvalId?: string,
  ): Promise<TitleRenameResult> {
    // 门控锁内复核（批准与执行之间状态可能变化；cloud_revert_running 与
    // local_edit_pending 在锁内读 DB 权威）。
    const plan = await this.buildRenamePlan(objToken, to);
    if (plan.blockedReason != null || plan.target == null) {
      throw this.blockedError(plan.blockedReason ?? 'unsupported_type');
    }
    try {
      const result = await this.deps.larkCliClient.updateDocumentTitle(target.token, to, {
        type: target.type,
      });
      this.appendAudit('source_rename', {
        objToken, from, to, target, actor,
        ...(approvalId != null ? { approvalId } : {}),
        ...(result?.url != null ? { url: result.url } : {}),
      });
      return {
        objToken,
        target,
        from,
        to,
        updatedTitle: typeof result?.title === 'string' ? result.title : null,
        url: typeof result?.url === 'string' ? result.url : null,
        pull: null,
      };
    } catch (error) {
      // 981003 → type_mismatch（不自动换 type 重试——本地映射可能已过期，
      // 应先重新检测，U31）；981004 → no_edit_permission（S2 未入码表，
      // 按 upstreamCode 服务层映射）；其余 → feishu_rename_failed（改名
      // 幂等可重试，无需 outcome-unknown 保守态）。
      if (error instanceof LarkCliError) {
        if (error.code === 'type_mismatch' || error.upstreamCode === '981003') {
          throw new SourceTitleError(
            'type_mismatch',
            '改名类型错配（981003）：本地映射可能已过期，请先重新检测变更后再改名（不会自动换类型重试）',
            422,
            { larkCode: '981003' },
          );
        }
        if (error.upstreamCode === '981004') {
          throw new SourceTitleError(
            'no_edit_permission',
            '没有该文档的编辑权限（981004），无法在飞书改名',
            403,
            { larkCode: '981004' },
          );
        }
        throw new SourceTitleError(
          'feishu_rename_failed',
          `飞书改名失败：${error.message}`.slice(0, 560),
          502,
          { larkCode: error.upstreamCode ?? error.code },
        );
      }
      throw new SourceTitleError(
        'feishu_rename_failed',
        `飞书改名失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 560),
        502,
      );
    }
  }
}
