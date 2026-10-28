/**
 * SourceEditService — 原始库正文受控编辑通道（S11，设计 §7.2–§7.4）。
 *
 * 这是「原始库只读」不变量的显式受控扩展（设计 §9.1 修订 1）：第三类
 * 登记写者（SyncEngine 云→地、源生命周期只移动/删除之外）——用户或经
 * 批准的 Agent 对 docx 正文的编辑。核心安全语义：
 *
 *   1. header 字节保全：编辑只作用于 feishu_sync 注释块之后的正文区；
 *      写回 = 原 header 字节 + 新正文，写后用 IndexScanner.parseMetadata
 *      复核元数据逐字段一致，不一致立即恢复并报 500。
 *   2. 本地 OCC：编辑前正文 sha256 必须等于调用方提供的 baseHash，
 *      否则 409 source_edit_conflict（编辑面已过期）。
 *   3. 原子写 + 备份：atomicWriteFile（同目录临时文件+rename）；首次
 *      编辑把同步版正文存 base.md，每次编辑前的正文存 <seq>.md（保留
 *      最近 20 份）；审计追加 <dataRoot>/agent/audit/source-edits.jsonl。
 *   4. 构建活跃（标准库构建 running/queued）→ 409 kb_build_active；
 *      pushing 状态 → 409 source_push_in_progress（S12 推送中）。
 *   5. 全程持 SourceWriteLock(objToken)，与 SyncEngine 提交互斥；
 *      dirty/pushing/conflict 行由 SyncEngine 产出 local_edit_pending
 *      blocker（见 sync-engine.ts），绝不覆盖本地文件或推进基线。
 *
 * 不含飞书写回（S12：push-planner/FeishuWriteService）；不含 UI（S13）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInside, atomicWriteFile, PathGuardError } from '../agent/path-guard.js';
import { IndexScanner, type ParsedMetadata } from '../modules/index-scanner.js';
import type {
  SourceEditActor,
  SourceEditOp,
  SourceEditRecord,
  SourceEditState,
  SourceEditStateDto,
} from '../types/index.js';
import { SourceWriteLock, sharedSourceWriteLock } from './source-write-lock.js';

/** 保留的编辑前快照份数（base.md 之外）。 */
const MAX_SEQ_BACKUPS = 20;

/** 服务级错误：code/status 对齐设计 §8 错误码表（响应体 {error,message}）。 */
export class SourceEditError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SourceEditError';
  }
}

export interface SourceEditServiceDeps {
  /** ConfigManager：读 knowledgeBaseRoot（只读使用，不写配置）。 */
  config: {
    getConfig?: () => { knowledgeBaseRoot?: string } | undefined;
    load?: () => Promise<{ knowledgeBaseRoot?: string }>;
  };
  /** LocalMapStore：documents 行 + source_edits 行。 */
  store: any;
  /** 与 SyncEngine 共享的 per-token 锁；缺省回落到进程级共享实例。 */
  locks?: SourceWriteLockLikeShim;
  /** 构建活跃探针（接线：kbBuildService.activeBuild(store) != null）。 */
  kbBuild: { isActive(): boolean };
  /** 数据根（备份 source-edits/ 与审计 agent/audit/ 的落点）。 */
  dataRoot: string;
}

type SourceWriteLockLikeShim = {
  withLock<T>(objToken: string, fn: () => T | Promise<T>): Promise<T>;
};

/** parseMetadata 输出的规范化键集合（round-trip 逐字段比较用）。 */
type NormalizedMeta = Record<string, string | null>;

export class SourceEditService {
  private readonly scanner = new IndexScanner({} as never);

  constructor(private readonly deps: SourceEditServiceDeps) {
    if (!deps.locks) {
      // 构造方未注入时与 SyncEngine 使用同一进程级实例，保证互斥生效。
      (this.deps as { locks?: SourceWriteLockLikeShim }).locks = sharedSourceWriteLock;
    }
  }

  private get locks(): SourceWriteLockLikeShim {
    return this.deps.locks ?? sharedSourceWriteLock;
  }

  private async knowledgeBaseRoot(): Promise<string> {
    const config = this.deps.config.getConfig?.() ?? await this.deps.config.load?.();
    const root = config?.knowledgeBaseRoot;
    if (!root || typeof root !== 'string' || !root.trim()) {
      throw new SourceEditError('knowledge_base_root_not_configured', '知识库根目录未设置，无法编辑源文档', 400);
    }
    return root;
  }

  private editsDir(objToken: string): string {
    return path.join(this.deps.dataRoot, 'source-edits', objToken);
  }

  private auditPath(): string {
    return path.join(this.deps.dataRoot, 'agent', 'audit', 'source-edits.jsonl');
  }

  private appendAudit(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath()), { recursive: true });
      fs.appendFileSync(this.auditPath(), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
      // 审计失败不阻断编辑（文件已原子落位、状态行已写），但要可见。
      console.error('[SourceEditService] audit append failed:', error);
    }
  }

  /** documents 行解析：objType/cloud_deleted/路径等入口校验。 */
  private requireDocument(objToken: string): Record<string, any> {
    const doc = this.deps.store?.getDocumentByObjToken?.(objToken);
    if (!doc) {
      throw new SourceEditError('source_not_found', `文档不存在：${objToken}`, 404);
    }
    return doc;
  }

  private requireEditableDocument(objToken: string): { relPath: string; title: string } {
    const doc = this.requireDocument(objToken);
    if (doc.objType !== 'docx') {
      throw new SourceEditError(
        'source_edit_unsupported_type',
        `仅支持编辑 docx 源文档（当前 ${doc.objType ?? 'unknown'} 是导出投影，不可受控编辑）`,
        422,
      );
    }
    if (doc.cloudDeleted === 1 || doc.cloudDeleted === true) {
      throw new SourceEditError('source_not_editable', '文档已在回收站中，请先恢复后再编辑', 409);
    }
    const relPath: string | undefined = doc.localRelPath || doc.localMdPath;
    if (!relPath) {
      throw new SourceEditError('source_not_editable', '文档没有本地文件路径，无法编辑', 409);
    }
    return { relPath, title: doc.title ?? '' };
  }

  private rejectWhenBuildActive(): void {
    if (this.deps.kbBuild?.isActive()) {
      throw new SourceEditError('kb_build_active', '标准库构建进行中，暂不能编辑源文档（构建结束或取消后再试）', 409);
    }
  }

  private rejectWhenPushing(state: SourceEditRecord | null): void {
    if (state?.state === 'pushing') {
      throw new SourceEditError('source_push_in_progress', '该文档正在写回飞书，请等待推送结束后再编辑', 409);
    }
  }

  /**
   * P0-S9（S4 遗留补挂，lark-cli-newcaps-P0 §4.4 cloud_revert_running 互斥）：
   * 云端回滚进行中禁止新建本地脏编辑/放弃本地修改——回滚后的回拉会被
   * 本地脏状态阻断（local_edit_pending blocker）。与 FeishuWriteService.push /
   * CloudHistoryService 同源消费 source_push_log.revert_state='running'；
   * 访问器缺失（旧测试替身）按无回滚容错，不影响既有链路。
   */
  private hasRunningCloudRevert(objToken: string): boolean {
    try {
      return this.deps.store?.getRunningRevertPushLog?.(objToken) != null;
    } catch {
      return false;
    }
  }

  private rejectWhenCloudRevertRunning(objToken: string): void {
    if (this.hasRunningCloudRevert(objToken)) {
      throw new SourceEditError(
        'cloud_revert_running',
        '该文档有进行中的云端回滚，暂不能编辑或放弃本地修改（回滚完成后再操作）',
        409,
      );
    }
  }

  /**
   * P2-S6（lark-cli-newcaps-P2 §3.4/§3.5 云端移出互斥；T4b-05 修订）：
   * 移出进行中（cloud_moves 存在 pending/moving 行）或结果未知（unknown
   * ——超时/不可解析/重启对账，云端可能仍在执行或已执行）禁止新建本地
   * 脏编辑/放弃本地修改——cloud_move_running；移出已完成（最近一行
   * moved）本地编辑与写回一律拒绝 source_moved_out（文档已离开受管树，
   * 写回后的回拉收敛路径不再成立）。unknown 只经权威核对
   * （CloudMoveService.reconcileUnknownMove）证明未移出后解除。与
   * hasRunningCloudRevert 同风格：访问器缺失（旧测试替身）按无移出容错，
   * 不影响既有链路；围栏状态源与写回/回滚/移出四方共用同一解释。
   */
  private rejectWhenCloudMoveBlocking(objToken: string): void {
    try {
      const active = this.deps.store?.getActiveCloudMove?.(objToken) ?? null;
      if (active != null) {
        throw new SourceEditError(
          'cloud_move_running',
          '该文档有进行中或结果未知的移出到云空间，暂不能编辑或放弃本地修改：请先在移出记录完成权威核对（确认未移出后再操作）',
          409,
        );
      }
      const latest = this.deps.store?.getLatestCloudMove?.(objToken) ?? null;
      if (latest?.state === 'moved') {
        throw new SourceEditError(
          'source_moved_out',
          '该文档已移出到云空间（不再受知识库管理）：本地文件保留但不再支持编辑与写回',
          409,
        );
      }
    } catch (error) {
      if (error instanceof SourceEditError) throw error;
      // 访问器缺失/查询异常按无移出容错（与 hasRunningCloudRevert 同口径）。
    }
  }

  /** 解析绝对路径（write 意图，含路径逃逸/符号链接守卫）。 */
  private resolveTarget(root: string, relPath: string): string {
    try {
      return resolveInside(root, relPath, 'write');
    } catch (error) {
      if (error instanceof PathGuardError) {
        if (error.code === 'not_found') {
          throw new SourceEditError('source_not_found', `源文件不存在：${relPath}`, 404);
        }
        throw new SourceEditError('invalid_source_path', `源路径不可写：${error.message}`, 400);
      }
      throw error;
    }
  }

  /**
   * 切分 header 与正文：当前规范格式 = 文件首部 `<!--\nfeishu_sync:\n…\n-->`。
   * 历史头格式（legacy_html_zh/blockquote/bold_kv）→ 422（下次同步会升级头）。
   */
  private splitHeaderBody(content: string): { header: string; body: string } {
    const commentEnd = content.indexOf('-->');
    if (!content.startsWith('<!--') || commentEnd === -1) {
      throw new SourceEditError(
        'source_header_unsupported',
        '文件缺少 feishu_sync 头部注释块，无法受控编辑（重新同步可升级为当前格式）',
        422,
      );
    }
    // 规范头结束符含分隔空行（generateHtmlHeader 返回 lines.join('\n')
    // + '\n\n'，即 `-->\n\n` 属于 header 字节）；仅吞并精确的规范分隔，
    // 其他间距保持为正文首字符，避免误吞正文缩进。
    let headerEnd = commentEnd + 3;
    if (content.slice(headerEnd, headerEnd + 2) === '\n\n') headerEnd += 2;
    const header = content.slice(0, headerEnd);
    const body = content.slice(headerEnd);
    if (!/feishu_sync\s*:/.test(header)) {
      throw new SourceEditError(
        'source_header_unsupported',
        '文件头部是历史格式（非当前 feishu_sync 规范），暂不支持编辑（重新同步可升级）',
        422,
      );
    }
    return { header, body };
  }

  private requireIdentity(content: string, objToken: string): NormalizedMeta {
    const meta = this.scanner.parseMetadata(content);
    if (!meta || meta.header_format !== 'yaml_html') {
      throw new SourceEditError('source_header_unsupported', '文件头部无法按当前规范解析，拒绝编辑', 422);
    }
    if (meta.obj_token !== objToken) {
      throw new SourceEditError(
        'source_header_unsupported',
        `头部 obj_token（${meta.obj_token ?? '空'}）与请求文档不符，拒绝编辑`,
        422,
      );
    }
    return normalizeMeta(meta);
  }

  /** 读当前编辑视图：正文 + 哈希 + 状态（无编辑行时 state 为 null）。 */
  async read(objToken: string): Promise<{
    relPath: string;
    title: string;
    header: string;
    body: string;
    bodyHash: string;
    state: SourceEditStateDto | null;
  }> {
    const root = await this.knowledgeBaseRoot();
    const { relPath, title } = this.requireEditableDocument(objToken);
    const abs = this.resolveTarget(root, relPath);
    if (!fs.existsSync(abs)) {
      throw new SourceEditError('source_not_found', `源文件不存在：${relPath}`, 404);
    }
    const content = fs.readFileSync(abs, 'utf-8');
    const { header, body } = this.splitHeaderBody(content);
    const state = this.deps.store.getSourceEdit?.(objToken) ?? null;
    return {
      relPath,
      title,
      header,
      body,
      bodyHash: sha256(body),
      state: state ? this.toStateDto(state, title, relPath) : null,
    };
  }

  /**
   * 受控编辑（设计 §7.2 写入顺序）。ops 为单 op 或顺序应用的操作数组，
   * baseHash 对第一版正文校验（本地 OCC）。
   */
  async edit(
    objToken: string,
    ops: SourceEditOp | SourceEditOp[],
    opts: { baseHash: string; actor: SourceEditActor },
  ): Promise<{ bodyHash: string; state: SourceEditStateDto }> {
    const opList = Array.isArray(ops) ? ops : [ops];
    if (opList.length === 0) {
      throw new SourceEditError('invalid_edit_op', '至少需要一个编辑操作', 400);
    }
    return this.locks.withLock(objToken, async () => this.editLocked(objToken, opList, opts));
  }

  private async editLocked(
    objToken: string,
    opList: SourceEditOp[],
    opts: { baseHash: string; actor: SourceEditActor },
  ): Promise<{ bodyHash: string; state: SourceEditStateDto }> {
    this.rejectWhenBuildActive();
    const existing: SourceEditRecord | null = this.deps.store.getSourceEdit?.(objToken) ?? null;
    this.rejectWhenPushing(existing);
    this.rejectWhenCloudRevertRunning(objToken);
    this.rejectWhenCloudMoveBlocking(objToken);
    const { relPath, title } = this.requireEditableDocument(objToken);
    // 同步屏蔽名单内的文档冻结编辑（生命周期操作同样拒绝，见守卫接线）。
    const root = await this.knowledgeBaseRoot();
    if (typeof this.deps.store.isSyncBlocked === 'function'
      && this.deps.store.isSyncBlocked(root, objToken)) {
      throw new SourceEditError('source_not_editable', '文档已被移入同步屏蔽名单，暂不能编辑', 409);
    }

    const abs = this.resolveTarget(root, relPath);
    if (!fs.existsSync(abs)) {
      throw new SourceEditError('source_not_found', `源文件不存在：${relPath}`, 404);
    }
    const originalContent = fs.readFileSync(abs, 'utf-8');
    const { header, body } = this.splitHeaderBody(originalContent);
    const metaBefore = this.requireIdentity(originalContent, objToken);

    // 本地 OCC：baseHash 必须等于当前正文哈希。
    const currentHash = sha256(body);
    if (currentHash !== opts.baseHash) {
      throw new SourceEditError(
        'source_edit_conflict',
        '正文已被其他编辑修改（baseHash 过期），请刷新后重试',
        409,
        { currentBodyHash: currentHash },
      );
    }

    // 应用操作序列（纯函数，任一失败即 400，不落盘）。
    let newBody = body;
    for (const op of opList) {
      newBody = applyOp(newBody, op);
    }

    const editsDir = this.editsDir(objToken);
    const nextSeq = (existing?.editCount ?? 0) + 1;

    // 备份：首次编辑存同步版正文 base.md（覆盖式：revert 后重新首编时
    // base.md 必须重新对齐当前同步版）；每次编辑前正文存 <seq>.md。
    fs.mkdirSync(editsDir, { recursive: true });
    const createdRow = !existing;
    if (createdRow) {
      fs.writeFileSync(path.join(editsDir, 'base.md'), body);
      const doc = this.requireDocument(objToken);
      // 首次编辑先建 count=0 的基线行，随后与后续编辑同一 markDirty 语句
      // 收敛到 count=1（设计 §7.2 步骤 4→6）。
      this.deps.store.createSourceEdit({
        objToken,
        localRelPath: relPath,
        baseObjEditTime: doc.syncedObjEditTime ?? null,
        baseBodyHash: currentHash,
        currentBodyHash: currentHash,
        lastActor: opts.actor,
      });
    }
    fs.writeFileSync(path.join(editsDir, `${String(nextSeq).padStart(6, '0')}.md`), body);
    pruneSeqBackups(editsDir, MAX_SEQ_BACKUPS);

    // 写入 = 原 header 字节 + 新正文；写后重读复核 round-trip。
    const newContent = header + newBody;
    let newHash: string;
    try {
      atomicWriteFile(abs, newContent);
      const reread = fs.readFileSync(abs, 'utf-8');
      const metaAfter = this.scanner.parseMetadata(reread);
      if (!metaAfter || !metaEquals(normalizeMeta(metaAfter), metaBefore)) {
        throw new Error('header round-trip mismatch');
      }
      if (!reread.startsWith(header)) {
        throw new Error('header bytes mutated');
      }
      newHash = sha256(reread.slice(header.length));
    } catch (error) {
      // 恢复编辑前内容（header + 原正文），报告 500；状态行不推进。
      try {
        atomicWriteFile(abs, originalContent);
      } catch (restoreError) {
        console.error('[SourceEditService] restore after roundtrip failure failed:', restoreError);
      }
      // 本次调用新建的基线行一并回滚：文件未变，不应残留 dirty 行阻断同步。
      if (createdRow && typeof this.deps.store.clearSourceEdit === 'function') {
        try {
          this.deps.store.clearSourceEdit(objToken);
        } catch (clearError) {
          console.error('[SourceEditService] rollback of created row failed:', clearError);
        }
      }
      this.appendAudit({
        actor: opts.actor, objToken, relPath, op: summarizeOps(opList),
        beforeHash: currentHash, afterHash: null, bytes: Buffer.byteLength(newContent, 'utf-8'),
        result: 'error', errorCode: 'source_header_roundtrip_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new SourceEditError(
        'source_header_roundtrip_failed',
        '写回后头部元数据校验失败，已恢复编辑前内容',
        500,
      );
    }

    this.deps.store.markSourceEditDirty(objToken, { currentBodyHash: newHash, lastActor: opts.actor });
    this.appendAudit({
      actor: opts.actor, objToken, relPath, op: summarizeOps(opList),
      beforeHash: currentHash, afterHash: newHash, bytes: Buffer.byteLength(newContent, 'utf-8'),
      result: 'edited',
    });

    const state = this.deps.store.getSourceEdit(objToken);
    return { bodyHash: newHash, state: this.toStateDto(state, title, relPath) };
  }

  /**
   * 放弃修改：以 base.md（首次编辑前的同步版正文）恢复正文并删除
   * source_edits 行（清 dirty）。备份目录保留（回滚章节：回拉成功前保留；
   * 本地留档便于事后追溯）。
   */
  async revert(objToken: string, actor: SourceEditActor): Promise<void> {
    return this.locks.withLock(objToken, async () => this.revertLocked(objToken, actor));
  }

  private async revertLocked(objToken: string, actor: SourceEditActor): Promise<void> {
    this.rejectWhenBuildActive();
    const existing: SourceEditRecord | null = this.deps.store.getSourceEdit?.(objToken) ?? null;
    if (!existing) {
      throw new SourceEditError('source_edit_not_found', '该文档没有未写回的本地修改', 404);
    }
    this.rejectWhenPushing(existing);
    this.rejectWhenCloudRevertRunning(objToken);
    this.rejectWhenCloudMoveBlocking(objToken);
    const { relPath } = this.requireEditableDocument(objToken);
    const root = await this.knowledgeBaseRoot();
    const abs = this.resolveTarget(root, relPath);

    const baseFile = path.join(this.editsDir(objToken), 'base.md');
    if (!fs.existsSync(baseFile)) {
      throw new SourceEditError(
        'source_revert_failed',
        `找不到首次编辑前备份（${baseFile}），请手动恢复或重新同步覆盖`,
        500,
      );
    }
    const baseBody = fs.readFileSync(baseFile, 'utf-8');
    const originalContent = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
    if (originalContent !== null) {
      const metaBefore = this.requireIdentity(originalContent, objToken);
      const { header } = this.splitHeaderBody(originalContent);
      try {
        atomicWriteFile(abs, header + baseBody);
        const reread = fs.readFileSync(abs, 'utf-8');
        const metaAfter = this.scanner.parseMetadata(reread);
        if (!metaAfter || !metaEquals(normalizeMeta(metaAfter), metaBefore)) {
          throw new Error('header round-trip mismatch');
        }
      } catch (error) {
        try {
          if (originalContent !== null) atomicWriteFile(abs, originalContent);
        } catch (restoreError) {
          console.error('[SourceEditService] restore after revert failure failed:', restoreError);
        }
        this.appendAudit({
          actor, objToken, relPath, op: 'revert', result: 'error',
          errorCode: 'source_header_roundtrip_failed',
          error: error instanceof Error ? error.message : String(error),
        });
        throw new SourceEditError('source_header_roundtrip_failed', '恢复备份后头部校验失败，已恢复编辑后内容', 500);
      }
    }
    // 文件缺失（外部删除）时仅清状态行——正文已不在，恢复无从谈起。

    this.deps.store.clearSourceEdit(objToken);
    this.appendAudit({ actor, objToken, relPath, op: 'revert', result: 'reverted' });
  }

  /** 列出全部编辑行（含 pushed，S12 推送后回拉成功前仍可见）。 */
  async listEdits(): Promise<SourceEditStateDto[]> {
    const rows: SourceEditRecord[] = this.deps.store.listSourceEdits?.() ?? [];
    return rows.map((row) => {
      const doc = this.deps.store.getDocumentByObjToken?.(row.objToken);
      return this.toStateDto(row, doc?.title ?? '', row.localRelPath);
    });
  }

  /** 单文档编辑状态（含当前正文哈希，供预览面板取 baseHash）。 */
  async editStatus(objToken: string): Promise<{
    objToken: string;
    relPath: string;
    title: string;
    bodyHash: string;
    editState: SourceEditStateDto | null;
  }> {
    const root = await this.knowledgeBaseRoot();
    const { relPath, title } = this.requireEditableDocument(objToken);
    const abs = this.resolveTarget(root, relPath);
    if (!fs.existsSync(abs)) {
      throw new SourceEditError('source_not_found', `源文件不存在：${relPath}`, 404);
    }
    const content = fs.readFileSync(abs, 'utf-8');
    const { body } = this.splitHeaderBody(content);
    const row = this.deps.store.getSourceEdit?.(objToken) ?? null;
    return {
      objToken,
      relPath,
      title,
      bodyHash: sha256(body),
      editState: row ? this.toStateDto(row, title, relPath) : null,
    };
  }

  /**
   * 写回推送成功 + 回拉同步成功后，由 SyncEngine 调用：删除 pushed 行
   * 与备份目录（设计 §7.3）。独立导出供测试与 S12 复用。
   */
  static cleanupPushedEdit(dataRoot: string, store: any, objToken: string): void {
    const row = store.getSourceEdit?.(objToken);
    if (!row || row.state !== 'pushed') return;
    try {
      store.clearSourceEdit(objToken);
    } catch (error) {
      console.warn(`[SourceEditService] 清除 pushed 行失败（${objToken}）:`, error);
      return;
    }
    try {
      fs.rmSync(path.join(dataRoot, 'source-edits', objToken), { recursive: true, force: true });
    } catch (error) {
      console.warn(`[SourceEditService] 清理备份目录失败（${objToken}）:`, error);
    }
  }

  private toStateDto(row: SourceEditRecord, title: string, relPath: string): SourceEditStateDto {
    return {
      objToken: row.objToken,
      relPath,
      title,
      state: row.state as SourceEditState,
      bodyHash: row.currentBodyHash,
      baseBodyHash: row.baseBodyHash,
      editCount: row.editCount,
      lastActor: row.lastActor,
      error: row.lastErrorCode
        ? { code: row.lastErrorCode, message: row.lastErrorMessage ?? '' }
        : null,
      updatedAt: row.updatedAt,
    };
  }
}

// ============================================================================
// 纯函数与共享守卫（生命周期操作接线用）
// ============================================================================

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** 顺序应用一个编辑操作；非法输入抛 400（SourceEditError）。 */
export function applyOp(body: string, op: SourceEditOp): string {
  if (!op || typeof op !== 'object' || typeof op.mode !== 'string') {
    throw new SourceEditError('invalid_edit_op', '编辑操作必须是 { mode, ... } 对象', 400);
  }
  const mode = op.mode as string;
  if (op.mode === 'replace_body') {
    if (typeof op.body !== 'string') {
      throw new SourceEditError('invalid_edit_op', 'replace_body.body 必须是字符串', 400);
    }
    return op.body;
  }
  if (op.mode === 'str_replace') {
    if (typeof op.old !== 'string' || typeof op.new !== 'string') {
      throw new SourceEditError('invalid_edit_op', 'str_replace.old/new 必须是字符串', 400);
    }
    if (op.old.length === 0) {
      throw new SourceEditError('invalid_edit_op', 'str_replace.old 不能为空字符串', 400);
    }
    const first = body.indexOf(op.old);
    if (first === -1) {
      throw new SourceEditError('invalid_edit_op', 'str_replace.old 在正文中未找到', 400);
    }
    if (op.replaceAll === true) {
      return body.split(op.old).join(op.new);
    }
    if (body.indexOf(op.old, first + 1) !== -1) {
      throw new SourceEditError(
        'invalid_edit_op',
        'str_replace.old 在正文中出现多次；请提供更长的上下文或使用 replaceAll',
        400,
      );
    }
    return body.slice(0, first) + op.new + body.slice(first + op.old.length);
  }
  throw new SourceEditError('invalid_edit_op', `未知编辑操作 mode：${mode}`, 400);
}

function summarizeOps(ops: SourceEditOp[]): string {
  return ops.map((op) => (op.mode === 'replace_body' ? 'replace_body' : `str_replace${op.replaceAll ? '(all)' : ''}`)).join('+');
}

/** 只保留 <seq>.md 最近 maxKeep 份（base.md 不动）。 */
export function pruneSeqBackups(editsDir: string, maxKeep: number): void {
  let seqFiles: string[] = [];
  try {
    seqFiles = fs.readdirSync(editsDir)
      .filter((name) => /^\d{6}\.md$/.test(name))
      .sort();
  } catch {
    return;
  }
  const excess = seqFiles.length - maxKeep;
  if (excess <= 0) return;
  for (const name of seqFiles.slice(0, excess)) {
    try {
      fs.unlinkSync(path.join(editsDir, name));
    } catch {
      /* 清理失败无害：下次编辑会再尝试 */
    }
  }
}

function normalizeMeta(meta: ParsedMetadata): NormalizedMeta {
  const out: NormalizedMeta = { header_format: meta.header_format };
  const record = meta as unknown as Record<string, unknown>;
  for (const key of ['obj_token', 'wiki_node_token', 'space_id', 'obj_type', 'original_link', 'fetch_date', 'last_synced_modify_time']) {
    const value = record[key];
    out[key] = typeof value === 'string' ? value : null;
  }
  return out;
}

function metaEquals(a: NormalizedMeta, b: NormalizedMeta): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  return true;
}

/**
 * 生命周期守卫（设计 §7.3「回收站/源清理/孤立清理」）：目标文档存在
 * source_edits 非 pushed 行时，对应操作必须拒绝。duck-typed：store 无
 * 该方法（旧测试替身）时返回空数组，守卫静默放行。
 */
export function pendingLocalEditTokens(
  store: { getSourceEdit?: (objToken: string) => SourceEditRecord | null },
  objTokens: string[],
): string[] {
  if (typeof store?.getSourceEdit !== 'function') return [];
  const pending: string[] = [];
  for (const token of objTokens) {
    const row = store.getSourceEdit(token);
    if (row && row.state !== 'pushed') pending.push(token);
  }
  return pending;
}

/** 未写回修改的正文相对路径集合（孤立文件清理按路径前缀排除用）。 */
export function pendingLocalEditRelPaths(
  store: { listPendingSourceEdits?: () => SourceEditRecord[] },
): string[] {
  if (typeof store?.listPendingSourceEdits !== 'function') return [];
  try {
    return (store.listPendingSourceEdits() ?? []).map((row) => row.localRelPath);
  } catch {
    return [];
  }
}

export { SourceWriteLock, sharedSourceWriteLock };
