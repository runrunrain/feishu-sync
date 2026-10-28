/**
 * SourceEditControls —— 源文档编辑/写回控件（S13，设计 §7.6）
 *
 * 预览面板（DocPreviewPanel / RawSourceDrawer）共用的操作条：
 *   - 「编辑」→ 正文编辑器 Modal（feishu_sync 头部不可见不可改；保存走
 *     S11 edit API，baseHash OCC，409 冲突在编辑器内呈现并引导重载）
 *   - 状态徽标（dirty 本地有修改 / pushed 已写回待回拉 / conflict 冲突）
 *   - 「放弃修改」（revert，恢复上次同步正文，带确认）
 *   - 「写回飞书」（S12 push preview → 按确认级别二次确认 → push；
 *     409 云端冲突引导 force 选项；未启用/缺 scope 时给出设置引导）
 *
 * 正文切分与 S11 SourceEditService.splitHeaderBody 同规则：仅 `-->\n\n`
 * 精确规范分隔计入头部字节，其他间距保持为正文首字符。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CloudUpload,
  FilePenLine,
  Loader2,
  RefreshCw,
  RotateCcw,
  UploadCloud,
} from 'lucide-react';
import { Button } from './common/Button';
import { Modal } from './common/Modal';
import { StatusBadge } from './common/StatusBadge';
import { useToast } from './common/Toast';
import {
  APIError,
  editSourceDocument,
  getSourceEditStatus,
  previewSourcePush,
  pushSourceToFeishu,
  revertSourceEdit,
} from '../api/client';
import { appLogger } from '../utils/appLogger';
import type { SourceEditStatus, SourcePushPlan, SourcePushResult } from '../types';

/** 与 S11 splitHeaderBody 同规则：规范分隔 `-->\n\n` 计入头部；无法识别返回 null。 */
export function splitFeishuSyncHeader(content: string): { header: string; body: string } | null {
  const commentEnd = content.indexOf('-->');
  if (!content.startsWith('<!--') || commentEnd === -1) return null;
  let headerEnd = commentEnd + 3;
  if (content.slice(headerEnd, headerEnd + 2) === '\n\n') headerEnd += 2;
  const header = content.slice(0, headerEnd);
  if (!/feishu_sync\s*:/.test(header)) return null;
  return { header, body: content.slice(headerEnd) };
}

interface SourceEditControlsProps {
  objToken: string;
  /** 'docx' 才有编辑面（sheet/slides 导出投影编辑会 422）；null 按未知放行由服务端裁决。 */
  objType?: string | null;
  /** 本地 md 全文（含头部）；null=未同步到本地（不渲染）。 */
  mdContent: string | null;
  /** 512KB 预览截断标记：截断时禁止编辑（整文替换会丢尾部内容）。 */
  mdTruncated?: boolean;
  /** 编辑/放弃/写回成功后通知父组件重载预览内容。 */
  onContentChanged?: () => void;
}

const PUSH_BLOCKED_TEXT: Record<string, string> = {
  no_changes: '本地正文与上次同步版本一致，没有可写回的修改',
  overwrite_required: '正文修改不是纯追加，需要允许覆盖云端后才能写回',
  overwrite_unsupported: '当前环境不支持覆盖写回（仅追加可用）',
  images_in_append: '追加内容包含本地图片引用，云端无法解析（先移除图片再写回）',
  images_in_overwrite: '正文包含本地图片引用，云端无法解析（先移除图片再写回）',
  write_disabled: '写回飞书未开启：前往「设置 → 飞书认证 → 飞书写入」开启后重试',
  write_scope_missing: '缺少文档写入权限：前往「设置 → 飞书认证 → 飞书写入 → 授权写入权限」',
};

function errorFace(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof APIError) {
    const body = (error.response ?? {}) as { error?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof body.error === 'string' ? body.error : '',
      message: error.message,
      details: (body.details && typeof body.details === 'object'
        ? body.details as Record<string, unknown>
        : undefined),
    };
  }
  return { code: '', message: error instanceof Error ? error.message : String(error) };
}

export function SourceEditControls({
  objToken,
  objType,
  mdContent,
  mdTruncated = false,
  onContentChanged,
}: SourceEditControlsProps) {
  const toast = useToast();
  const [status, setStatus] = useState<SourceEditStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // 编辑器
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorConflict, setEditorConflict] = useState(false);

  // 写回
  const [pushOpen, setPushOpen] = useState(false);
  const [plan, setPlan] = useState<SourcePushPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<{ code: string; message: string } | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<SourcePushResult | null>(null);
  const [pushError, setPushError] = useState<{ code: string; message: string; details?: Record<string, unknown> } | null>(null);

  const [reverting, setReverting] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const editableType = objType == null || objType === 'docx';
  const state = status?.editState?.state ?? null;

  const refreshStatus = useCallback(async (silent = false) => {
    if (!silent) setStatusError(null);
    try {
      const next = await getSourceEditStatus(objToken);
      if (!mountedRef.current) return;
      setStatus(next);
    } catch (error) {
      if (!mountedRef.current) return;
      // 文档缺失/不支持编辑属正常业务态：静默保留上次状态即可，不打扰预览。
      const face = errorFace(error);
      if (face.code === 'source_not_found' || face.code === 'source_edit_unsupported_type') {
        setStatus((prev) => prev);
        return;
      }
      appLogger.warn('source-edit', 'edit-status failed', error);
      if (!silent) setStatusError('编辑状态加载失败');
    }
  }, [objToken]);

  useEffect(() => {
    setStatus(null);
    setStatusError(null);
    if (objToken && mdContent != null) void refreshStatus(true);
  }, [objToken, mdContent, refreshStatus]);

  if (!objToken || mdContent == null || !editableType) return null;

  const headerEditable = mdTruncated
    ? { ok: false as const, reason: '文档超过预览大小上限，为防丢内容请直接编辑本地文件' }
    : splitFeishuSyncHeader(mdContent)
      ? { ok: true as const, reason: '' }
      : { ok: false as const, reason: '文档头部不是当前同步格式（重新同步后可编辑）' };

  const openEditor = () => {
    const split = headerEditable.ok ? splitFeishuSyncHeader(mdContent!) : null;
    setEditorText(split?.body ?? '');
    setEditorError(null);
    setEditorConflict(false);
    setEditorOpen(true);
  };

  const handleSave = async () => {
    if (!status) return;
    setSaving(true);
    setEditorError(null);
    setEditorConflict(false);
    try {
      await editSourceDocument(objToken, { newText: editorText, baseHash: status.bodyHash });
      if (!mountedRef.current) return;
      toast.push({ type: 'success', message: '已保存修改（本地有未写回的修改，同步将暂缓该文档）' });
      setEditorOpen(false);
      await refreshStatus();
      onContentChanged?.();
    } catch (error) {
      if (!mountedRef.current) return;
      const face = errorFace(error);
      if (face.code === 'source_edit_conflict') {
        setEditorConflict(true);
      } else {
        setEditorError(face.message || '保存失败');
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const handleRevert = () => {
    const confirmed = window.confirm(
      '确定放弃修改？本地正文将恢复为上次同步版本，本次编辑内容会被丢弃（可从编辑备份找回）。',
    );
    if (!confirmed) return;
    setReverting(true);
    revertSourceEdit(objToken)
      .then(async () => {
        if (!mountedRef.current) return;
        toast.push({ type: 'success', message: '已放弃修改，正文恢复为上次同步版本' });
        await refreshStatus();
        onContentChanged?.();
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        toast.push({ type: 'error', message: errorFace(error).message || '放弃修改失败' });
      })
      .finally(() => {
        if (mountedRef.current) setReverting(false);
      });
  };

  const openPush = () => {
    setPushOpen(true);
    setPlan(null);
    setPlanError(null);
    setPushResult(null);
    setPushError(null);
    setPlanLoading(true);
    previewSourcePush(objToken)
      .then((next) => {
        if (mountedRef.current) setPlan(next);
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        const face = errorFace(error);
        setPlanError({ code: face.code, message: face.message || '写回预览失败' });
      })
      .finally(() => {
        if (mountedRef.current) setPlanLoading(false);
      });
  };

  const doPush = async (opts: { allowOverwrite?: boolean; force?: boolean; confirm: 'PUSH' | 'OVERWRITE_CLOUD' }) => {
    setPushing(true);
    setPushError(null);
    try {
      const result = await pushSourceToFeishu(objToken, opts);
      if (!mountedRef.current) return;
      setPushResult(result);
      await refreshStatus();
      onContentChanged?.();
    } catch (error) {
      if (!mountedRef.current) return;
      setPushError(errorFace(error));
    } finally {
      if (mountedRef.current) setPushing(false);
    }
  };

  const retryPlan = () => {
    setPlanError(null);
    setPlanLoading(true);
    previewSourcePush(objToken)
      .then((next) => {
        if (mountedRef.current) setPlan(next);
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        const face = errorFace(error);
        setPlanError({ code: face.code, message: face.message || '写回预览失败' });
      })
      .finally(() => {
        if (mountedRef.current) setPlanLoading(false);
      });
  };

  const badge = (() => {
    if (state === 'dirty') return <span title="本地有未写回的修改"><StatusBadge status="warning" size="sm">本地已修改</StatusBadge></span>;
    if (state === 'conflict') return <span title="写回冲突，需人工核对云端内容"><StatusBadge status="error" size="sm">写回冲突</StatusBadge></span>;
    if (state === 'pushed') return <span title="已写回飞书，等待回拉同步收敛"><StatusBadge status="success" size="sm">已写回</StatusBadge></span>;
    if (state === 'pushing') return <StatusBadge status="loading" size="sm">写回中…</StatusBadge>;
    return null;
  })();

  return (
    <div className="inline-flex shrink-0 items-center gap-1.5">
      {badge}
      <button
        type="button"
        onClick={openEditor}
        disabled={!headerEditable.ok}
        title={headerEditable.ok ? '编辑正文（头部同步元数据不可改）' : headerEditable.reason}
        className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1.5 text-[11px] text-ink-soft font-sans-ui transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <FilePenLine className="w-3 h-3" />
        <span className="hidden xl:inline">编辑</span>
      </button>
      {(state === 'dirty' || state === 'conflict') && (
        <>
          <button
            type="button"
            onClick={handleRevert}
            disabled={reverting}
            title="放弃本地修改，恢复为上次同步版本"
            className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1.5 text-[11px] text-ink-soft font-sans-ui transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-3 h-3" />
            <span className="hidden xl:inline">放弃修改</span>
          </button>
          <button
            type="button"
            onClick={openPush}
            title="把本地修改写回飞书云端文档"
            className="inline-flex items-center gap-1 rounded-md border border-seal/40 bg-seal/5 px-2 py-1.5 text-[11px] text-seal font-sans-ui transition-colors hover:bg-seal/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <CloudUpload className="w-3 h-3" />
            <span className="hidden xl:inline">写回飞书</span>
          </button>
        </>
      )}
      {statusError && <span className="text-[10px] text-ink-faint">{statusError}</span>}

      {/* ── 正文编辑器（头部不可见不可改）────────────────────────────── */}
      <Modal
        open={editorOpen}
        title={`编辑正文 · ${status?.title ?? objToken}`}
        onClose={() => setEditorOpen(false)}
        contentClassName="max-w-3xl"
      >
        <div className="space-y-3">
          <p className="text-xs text-ink-faint leading-relaxed">
            只编辑正文部分；文件头部的同步元数据（feishu_sync 注释块）由同步链维护，不参与编辑。
            保存后文档将标记为「本地已修改」，在写回飞书前同步不会覆盖该文档。
          </p>
          <textarea
            value={editorText}
            onChange={(e) => setEditorText(e.target.value)}
            spellCheck={false}
            aria-label="正文编辑器"
            className="h-[52vh] w-full resize-none rounded-md border border-line bg-paper px-3 py-2.5 font-mono text-xs leading-relaxed text-ink focus:outline-none focus:border-seal/50"
          />
          {editorConflict && (
            <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-2">
              <p className="text-sm text-seal-2 font-medium">保存冲突：正文已被其他入口修改</p>
              <p className="text-xs text-ink-soft leading-relaxed">
                当前编辑基于的版本已过期（baseHash 不一致）。请关闭编辑器后重新点「编辑」加载最新正文；
                未保存的改动如需保留，请先复制到别处。
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    await refreshStatus();
                    onContentChanged?.();
                  }}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  刷新最新正文
                </Button>
              </div>
            </div>
          )}
          {editorError && (
            <p className="rounded-md border border-seal-2/40 bg-seal-2/5 p-2.5 text-xs text-seal-2 leading-relaxed">{editorError}</p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditorOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={() => void handleSave()} loading={saving} disabled={editorConflict}>
              保存修改
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── 写回飞书：preview → 确认 → 执行 → 结果 ──────────────────── */}
      <Modal
        open={pushOpen}
        title={`写回飞书 · ${status?.title ?? objToken}`}
        onClose={() => setPushOpen(false)}
        contentClassName="max-w-xl"
      >
        <div className="space-y-3">
          {planLoading && (
            <div className="flex items-center gap-2 py-6 text-ink-faint">
              <Loader2 className="w-4 h-4 animate-spin" />
              <p className="text-sm">正在生成写回计划…</p>
            </div>
          )}

          {planError && !planLoading && (
            <div className="space-y-2">
              <p className="text-sm text-seal-2">{planError.message}</p>
              {(planError.code === 'source_edit_not_found' || planError.code === 'source_not_found') && (
                <p className="text-xs text-ink-faint">该文档当前没有待写回的本地修改。</p>
              )}
              <Button variant="secondary" size="sm" onClick={retryPlan}>
                <RefreshCw className="w-3.5 h-3.5" />
                重试
              </Button>
            </div>
          )}

          {plan && !planLoading && !pushResult && (
            <div className="space-y-3">
              {plan.mode === 'blocked' ? (
                <div className="rounded-md border border-line bg-paper-2/60 p-3 space-y-2">
                  <p className="text-sm text-ink font-medium">暂不能写回</p>
                  <p className="text-xs text-ink-soft leading-relaxed">
                    {PUSH_BLOCKED_TEXT[plan.blockedReason ?? ''] ?? `原因：${plan.blockedReason ?? '未知'}`}
                  </p>
                  {(plan.blockedReason === 'write_disabled' || plan.blockedReason === 'write_scope_missing') && (
                    <p className="text-xs text-seal leading-relaxed">路径：设置 → 飞书认证 → 飞书写入（开关与「授权写入权限」入口都在该卡片）。</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="rounded-md border border-line bg-paper-2/60 p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-ink font-medium">
                        {plan.mode === 'append' ? '追加写回' : '覆盖写回'}
                      </span>
                      <StatusBadge status={plan.mode === 'append' ? 'success' : 'warning'} size="sm">
                        {plan.mode === 'append' ? '保留云端现有内容' : '整体替换云端正文'}
                      </StatusBadge>
                    </div>
                    <p className="text-xs text-ink-soft">
                      {plan.mode === 'append'
                        ? `本地新增内容将追加到云端文档尾部（约 ${plan.bytes} 字节）。`
                        : `本地正文将整体替换云端文档（约 ${plan.bytes} 字节）。云端评论锚点、协作块等可能失效，可用飞书文档历史版本回退。`}
                    </p>
                    {plan.conflict && (
                      <p className="flex items-start gap-1.5 text-xs text-seal-2 leading-relaxed">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        云端文档在本地修改之后有更新（云端时间 {plan.cloud.objEditTime ?? '未知'}）。直接写回会覆盖他人在云端的修改。
                      </p>
                    )}
                    {plan.warnings.map((w) => (
                      <p key={w} className="text-xs text-ink-faint leading-relaxed">· {w}</p>
                    ))}
                  </div>

                  {pushError && (
                    <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-2">
                      <p className="text-sm text-seal-2 font-medium">写回未完成</p>
                      <p className="text-xs text-ink-soft leading-relaxed">{pushError.message}</p>
                      {pushError.code === 'source_push_conflict' && (
                        <p className="text-xs text-seal-2 leading-relaxed">
                          云端已有更新的修改（云端编辑时间 {String(pushError.details?.cloudObjEditTime ?? '未知')}）。
                          可选择「强制覆盖」（将丢弃云端的新修改），或取消后先在飞书核对云端内容。
                        </p>
                      )}
                      {(pushError.code === 'feishu_write_disabled' || pushError.code === 'feishu_write_scope_missing') && (
                        <p className="text-xs text-seal leading-relaxed">
                          前往「设置 → 飞书认证 → 飞书写入」开启开关{pushError.code === 'feishu_write_scope_missing' ? '并完成「授权写入权限」' : ''}后重试。
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setPushOpen(false)} disabled={pushing}>
                      取消
                    </Button>
                    {plan.mode === 'append' && !plan.conflict && (
                      <Button variant="primary" size="sm" onClick={() => void doPush({ confirm: 'PUSH' })} loading={pushing}>
                        <UploadCloud className="w-3.5 h-3.5" />
                        确认追加写回
                      </Button>
                    )}
                    {plan.mode === 'append' && plan.conflict && (
                      <Button variant="danger" size="sm" onClick={() => void doPush({ force: true, confirm: 'OVERWRITE_CLOUD' })} loading={pushing}>
                        <AlertTriangle className="w-3.5 h-3.5" />
                        强制追加（覆盖云端新修改）
                      </Button>
                    )}
                    {plan.mode === 'overwrite' && (
                      <Button variant="danger" size="sm" onClick={() => void doPush({ allowOverwrite: true, confirm: 'OVERWRITE_CLOUD' })} loading={pushing}>
                        <AlertTriangle className="w-3.5 h-3.5" />
                        我已了解风险，覆盖云端
                      </Button>
                    )}
                    {/* 冲突 + overwrite：同样走 force+OVERWRITE_CLOUD */}
                    {pushError?.code === 'source_push_conflict' && (
                      <Button variant="danger" size="sm" onClick={() => void doPush({ allowOverwrite: plan.mode === 'overwrite', force: true, confirm: 'OVERWRITE_CLOUD' })} loading={pushing}>
                        <AlertTriangle className="w-3.5 h-3.5" />
                        强制覆盖云端
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {pushResult && (
            <div className="space-y-3">
              <div className="rounded-md border border-jade/30 bg-jade/5 p-3 space-y-1.5">
                <p className="text-sm text-jade font-medium">
                  写回成功（{pushResult.mode === 'append' ? '追加' : '覆盖'}
                  {pushResult.revisionId != null ? ` · revision ${pushResult.revisionId}` : ''}）
                </p>
                {pushResult.pull.ok ? (
                  <p className="text-xs text-ink-soft leading-relaxed">已回拉云端内容并更新本地文件，本地修改状态已清除。</p>
                ) : (
                  <p className="text-xs text-seal leading-relaxed">
                    回拉同步未完成（{pushResult.pull.status}）：{pushResult.pull.message ?? '请稍后在「贰 同步」手动同步该文档以收敛状态'}。
                  </p>
                )}
              </div>
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" onClick={() => setPushOpen(false)}>
                  关闭
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
