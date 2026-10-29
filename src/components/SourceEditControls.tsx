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
  Anchor,
  CloudUpload,
  FileClock,
  FilePenLine,
  GitCompare,
  History,
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
  fetchCloudContent,
  getSourceEditStatus,
  previewSourcePush,
  pushSourceToFeishu,
  revertSourceEdit,
} from '../api/client';
import { appLogger } from '../utils/appLogger';
import type { SourceEditStatus, SourcePushPlan, SourcePushResult } from '../types';
import { CloudDiffModal, type CloudDiffSide } from './source-history/CloudDiffModal';
import { CloudHistoryDrawer } from './source-history/CloudHistoryDrawer';
import { HistoryRevertModal, type RevertTarget } from './source-history/HistoryRevertModal';
import { SourcePushLogDrawer } from './source-history/SourcePushLogDrawer';
import { formatTime, shortHistoryId } from './source-history/labels';

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
  // P0-S3：overwrite 取不到云端历史锚点（force 不可越过）。
  rollback_anchor_unavailable:
    '云端历史暂不可读，取不到覆盖写回必需的回退锚点（覆盖前必须有回退点）。可稍后重试；追加写回不受影响',
  // P0-S4：回滚互斥门。
  cloud_revert_running: '该文档有进行中的云端回滚：等待回滚完成（可在「写回记录」查看状态）后再写回',
};

/** 冲突对比弹窗：云端侧正文真实拉取失败时的降级文案（T4b-08 起通道已
 * 接入，只剩真实失败才进入此态——如实展示失败原因，不冒充不可接入）。 */
const cloudBodyUnavailable = (face: { code: string; message: string }): string =>
  `云端当前正文读取失败${face.code ? `（${face.code}）` : ''}：${face.message}。可先打开飞书文档核对云端内容，稍后重试对比。`;

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

/**
 * 冲突对比上下文构建（T4b-08 消费链）：真实调用只读正文 API 拉取**云端
 * 当前正文**（不带 revisionId 的最新版），左侧云端/右侧本地；只有真实
 * 失败才降级为不可读态（原因如实展示）。导出供宿主级回归测试直接
 * 断言发出的 fetch 请求（URL 不含 revisionId）与两侧真实数据。
 */
export async function buildCloudDiffContext(
  objToken: string,
  context: { title: string; note: string },
  localBody: string,
  fetchImpl: (objToken: string) => Promise<{ content: string }> = (token) =>
    fetchCloudContent(token),
): Promise<{
  title: string;
  note: string;
  cloud: CloudDiffSide;
  local: CloudDiffSide;
}> {
  try {
    const cloud = await fetchImpl(objToken);
    return {
      ...context,
      cloud: { label: '云端当前正文', body: cloud.content },
      local: { label: '本地当前正文', body: localBody },
    };
  } catch (error) {
    const face = errorFace(error);
    return {
      ...context,
      cloud: { label: '云端当前正文', body: null, unavailableReason: cloudBodyUnavailable(face) },
      local: { label: '本地当前正文', body: localBody },
    };
  }
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
  const [unknownAcknowledged, setUnknownAcknowledged] = useState(false);
  const [plan, setPlan] = useState<SourcePushPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<{ code: string; message: string } | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<SourcePushResult | null>(null);
  const [pushError, setPushError] = useState<{ code: string; message: string; details?: Record<string, unknown> } | null>(null);

  const [reverting, setReverting] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // P0-S5：回滚收敛时不同步重载正文——重载会置空 content 导致本组件卸载，
  // 把展示中的回滚弹窗/抽屉一起销毁（真机实测）。正文刷新推迟到弹窗关闭后。
  const revertSettledRef = useRef(false);

  // P0-S5 回滚 UI：写回记录 / 云端历史抽屉 + 回滚弹窗 + 冲突对比弹窗。
  const [logDrawerOpen, setLogDrawerOpen] = useState(false);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [revertTarget, setRevertTarget] = useState<RevertTarget | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffContext, setDiffContext] = useState<{
    title: string;
    note: string;
    cloud: CloudDiffSide;
    local: CloudDiffSide;
  } | null>(null);

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
    const edit = status?.editState;
    const unknown = edit?.error?.code === 'push_outcome_unknown' || edit?.error?.code === 'push_interrupted';
    const confirmed = window.confirm(
      unknown
        ? '上次写回结果未知。请先确认上次操作已结束并核对飞书内容。确定已完成核对并放弃本地修改？本地正文将恢复为上次同步版本，之后同步可能更新本地内容。'
        : '确定放弃修改？本地正文将恢复为上次同步版本，本次编辑内容会被丢弃（可从编辑备份找回）。',
    );
    if (!confirmed) return;
    setReverting(true);
    revertSourceEdit(objToken, unknown ? edit?.updatedAt : undefined)
      .then(async () => {
        if (!mountedRef.current) return;
        toast.push({ type: 'success', message: '已放弃修改，正文恢复为上次同步版本' });
        await refreshStatus();
        onContentChanged?.();
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        toast.push({ type: 'error', message: errorFace(error).message || '放弃修改失败' });
        void refreshStatus();
      })
      .finally(() => {
        if (mountedRef.current) setReverting(false);
      });
  };

  const openPush = () => {
    setUnknownAcknowledged(false);
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
      const result = await pushSourceToFeishu(objToken, {
        ...opts,
        acknowledgedUnknownUpdatedAt: unknownAcknowledged ? plan?.unknownPushUpdatedAt ?? undefined : undefined,
      });
      if (!mountedRef.current) return;
      setPushResult(result);
      await refreshStatus();
      onContentChanged?.();
    } catch (error) {
      if (!mountedRef.current) return;
      setPushError(errorFace(error));
      setUnknownAcknowledged(false);
      try {
        const next = await previewSourcePush(objToken);
        if (mountedRef.current) setPlan(next);
      } catch { /* 保留原错误；用户可重新打开预览 */ }
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

  /** 本地当前正文（去 feishu_sync 头）——冲突对比右侧。 */
  const localBody = splitFeishuSyncHeader(mdContent!)?.body ?? mdContent!;

  /**
   * 冲突对比弹窗（设计 §4.5；T4b-08：真实拉取云端当前正文）。先开弹窗呈
   * 读取中态，拉取完成后回填两侧行级差异；只有真实失败才降级不可读态。
   */
  const openCloudDiff = (context: { title: string; note: string }) => {
    setDiffContext({
      ...context,
      cloud: { label: '云端当前正文', body: null, loading: true },
      local: { label: '本地当前正文', body: localBody },
    });
    setDiffOpen(true);
    void buildCloudDiffContext(objToken, context, localBody).then((next) => {
      if (!mountedRef.current) return;
      setDiffContext(next);
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
      {/* P0-S5：写回记录 / 云端历史入口（回滚安全网，与编辑同门槛渲染） */}
      <button
        type="button"
        onClick={() => setLogDrawerOpen(true)}
        title="写回记录：每次写回的锚点与结果，可回滚到写回前"
        className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1.5 text-[11px] text-ink-soft font-sans-ui transition-colors hover:bg-paper-2 hover:text-ink"
        data-testid="open-push-log"
      >
        <FileClock className="w-3 h-3" />
        <span className="hidden xl:inline">写回记录</span>
      </button>
      <button
        type="button"
        onClick={() => setHistoryDrawerOpen(true)}
        title="云端历史：飞书文档历史版本列表，可回滚到任一历史版本"
        className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1.5 text-[11px] text-ink-soft font-sans-ui transition-colors hover:bg-paper-2 hover:text-ink"
        data-testid="open-cloud-history"
      >
        <History className="w-3 h-3" />
        <span className="hidden xl:inline">云端历史</span>
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
                  {(plan.blockedReason === 'rollback_anchor_unavailable' || plan.anchorBlockedReason === 'rollback_anchor_unavailable') && (
                    <button
                      type="button"
                      onClick={() =>
                        openCloudDiff({
                          title: '对比云端与本地 · 覆盖被阻断',
                          note: '覆盖写回被阻断：云端历史不可读，无法建立回退锚点。可先核对云端当前与本地正文的差异再决定是否稍后重试。',
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2.5 py-1.5 text-[11px] text-ink-soft transition-colors hover:bg-paper-2 hover:text-ink"
                    >
                      <GitCompare className="w-3 h-3" />
                      对比云端与本地
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {plan.unknownPushUpdatedAt && (
                    <label className="flex items-start gap-2 rounded-md border border-seal-2/40 bg-seal-2/5 p-3 text-xs text-seal-2 leading-relaxed">
                      <input type="checkbox" checked={unknownAcknowledged} onChange={(event) => setUnknownAcknowledged(event.target.checked)} />
                      我已确认上次写回操作结束，并核对飞书内容确实需要再次写回；重复追加可能产生重复内容。
                    </label>
                  )}
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
                    {/* P0-S3 写前回退锚点（U23）：覆盖/追加均展示；近似锚点明示风险 */}
                    {plan.rollbackAnchor != null ? (
                      <p
                        className={`flex items-start gap-1.5 text-xs leading-relaxed ${plan.rollbackAnchor.exact ? 'text-jade' : 'text-seal-2'}`}
                        title={`锚点版本 ${plan.rollbackAnchor.historyVersionId}`}
                      >
                        <Anchor className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        {plan.rollbackAnchor.exact
                          ? `写回锚点 ${shortHistoryId(plan.rollbackAnchor.historyVersionId)}（${formatTime(plan.rollbackAnchor.historyTime)}）：精确，写回后可回滚到写前状态`
                          : `写回锚点 ${shortHistoryId(plan.rollbackAnchor.historyVersionId)}（${formatTime(plan.rollbackAnchor.historyTime)}）：近似，回滚点早于写前状态，回滚会一并撤销此期间的云端修改`}
                      </p>
                    ) : (
                      plan.mode === 'append' && (
                        <p className="flex items-start gap-1.5 text-xs text-ink-faint leading-relaxed">
                          <Anchor className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          本次追加无回退锚点（云端历史不可读）：如需撤销请到飞书核对处理
                        </p>
                      )
                    )}
                    {plan.warnings.map((w) => (
                      <p key={w} className="text-xs text-ink-faint leading-relaxed">· {w}</p>
                    ))}
                  </div>

                  {pushError && (
                    <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-2">
                      <p className="text-sm text-seal-2 font-medium">写回未完成</p>
                      <p className="text-xs text-ink-soft leading-relaxed">{pushError.message}</p>
                      {pushError.code === 'source_push_conflict' && pushError.details?.lastErrorCode !== 'push_outcome_unknown' && (
                        <>
                          <p className="text-xs text-seal-2 leading-relaxed">
                            云端已有更新的修改（云端编辑时间 {String(pushError.details?.cloudObjEditTime ?? '未知')}）。
                            可选择「强制覆盖」（将丢弃云端的新修改），或取消后先在飞书核对云端内容。
                          </p>
                          <button
                            type="button"
                            onClick={() =>
                              openCloudDiff({
                                title: '对比云端与本地 · 写回冲突',
                                note: '云端正文在本地基线之后有新修改（时间门拦截）。核对两侧差异后决定：强制覆盖（丢弃云端新修改）或先把本地改动合入云端版本。',
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2.5 py-1.5 text-[11px] text-ink-soft transition-colors hover:bg-paper-2 hover:text-ink"
                          >
                            <GitCompare className="w-3 h-3" />
                            对比云端与本地
                          </button>
                        </>
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
                      <Button variant="primary" size="sm" onClick={() => void doPush({ confirm: 'PUSH' })} loading={pushing} disabled={!!plan.unknownPushUpdatedAt && !unknownAcknowledged}>
                        <UploadCloud className="w-3.5 h-3.5" />
                        确认追加写回
                      </Button>
                    )}
                    {plan.mode === 'append' && plan.conflict && (
                      <Button variant="danger" size="sm" onClick={() => void doPush({ force: true, confirm: 'OVERWRITE_CLOUD' })} loading={pushing} disabled={!!plan.unknownPushUpdatedAt && !unknownAcknowledged}>
                        <AlertTriangle className="w-3.5 h-3.5" />
                        强制追加（覆盖云端新修改）
                      </Button>
                    )}
                    {plan.mode === 'overwrite' && (
                      <Button variant="danger" size="sm" onClick={() => void doPush({ allowOverwrite: true, confirm: 'OVERWRITE_CLOUD' })} loading={pushing} disabled={!!plan.unknownPushUpdatedAt && !unknownAcknowledged}>
                        <AlertTriangle className="w-3.5 h-3.5" />
                        我已了解风险，覆盖云端
                      </Button>
                    )}
                    {/* 冲突 + overwrite：同样走 force+OVERWRITE_CLOUD */}
                    {pushError?.code === 'source_push_conflict' && pushError.details?.lastErrorCode !== 'push_outcome_unknown' && (
                      <Button variant="danger" size="sm" onClick={() => void doPush({ allowOverwrite: plan.mode === 'overwrite', force: true, confirm: 'OVERWRITE_CLOUD' })} loading={pushing} disabled={!!plan.unknownPushUpdatedAt && !unknownAcknowledged}>
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

      {/* ── P0-S5 回滚安全网：写回记录 / 云端历史 / 回滚弹窗 / 冲突对比 ── */}
      <SourcePushLogDrawer
        open={logDrawerOpen}
        onClose={() => setLogDrawerOpen(false)}
        objToken={objToken}
        localBody={localBody}
        onRequestRevert={(target) => setRevertTarget({ pushLogId: target.pushLogId, sourceLabel: target.sourceLabel })}
        onRequestCompare={(log) =>
          openCloudDiff({
            title: `对比云端与本地 · 写回${log.outcome === 'conflict' ? '冲突' : '结果未知'}`,
            note:
              log.outcome === 'conflict'
                ? `该次${log.mode === 'append' ? '追加' : log.mode === 'overwrite' ? '覆盖' : '回滚'}写回因冲突未写入云端（${formatTime(log.createdAt)}）。核对本地正文与云端当前内容后决定：重新写回或放弃本地修改。`
                : `该次写回结果不确定（${formatTime(log.createdAt)}）：写入是否已落到云端未知，请先对比核对。`,
          })
        }
        onLogsChanged={() => {
          void refreshStatus(true);
        }}
      />
      <CloudHistoryDrawer
        open={historyDrawerOpen}
        onClose={() => setHistoryDrawerOpen(false)}
        objToken={objToken}
        onRequestRevert={(target) => setRevertTarget({ historyVersionId: target.historyVersionId, sourceLabel: target.sourceLabel })}
      />
      <HistoryRevertModal
        open={revertTarget != null}
        onClose={() => {
          setRevertTarget(null);
          if (revertSettledRef.current) {
            revertSettledRef.current = false;
            onContentChanged?.();
          }
        }}
        objToken={objToken}
        target={revertTarget}
        onReverted={() => {
          // 回滚已收敛：只刷编辑状态；正文重载推迟到弹窗关闭（防卸载连锁）。
          revertSettledRef.current = true;
          void refreshStatus(true);
        }}
      />
      {diffContext && (
        <CloudDiffModal
          open={diffOpen}
          onClose={() => setDiffOpen(false)}
          title={diffContext.title}
          note={diffContext.note}
          left={diffContext.cloud}
          right={diffContext.local}
        />
      )}
    </div>
  );
}
