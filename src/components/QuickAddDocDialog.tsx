/**
 * QuickAddDocDialog - 快捷添加云文档对话框（自定义文件夹归档）
 *
 * 入口：Dashboard 左侧树区域顶部「快捷添加云文档」按钮。
 *
 * 流程：
 *   1. 多行文本框粘贴飞书链接（每行一个，docx/sheet/slides/wiki 链接原样透传后端解析）
 *   2. 选择目标自定义文件夹，或切换「新建文件夹」输入名称（先 POST 创建再作为目标）
 *   3. 确认 → POST /api/custom-folders/:id/docs（前端先校验 ≤20 条）
 *   4. 逐条结果反馈：成功 / already_exists（附归属）/ unsupported_type /
 *      parse_failed / fetch_failed / permission_denied，均为友好中文文案
 *
 * 契约字段名见 src/types/index.ts Custom Folder 区块，勿改。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Link2, FolderPlus, CheckCircle, AlertCircle, RefreshCw, FileText, Table, FileType } from 'lucide-react';
import { Button } from './common/Button';
import { useToast } from './common/Toast';
import { APIError, addLinksToFolder, createCustomFolder } from '../api/client';
import { appLogger } from '../utils/appLogger';
import type { AddLinkToFolderResult, CustomFolder } from '../types';

const MAX_LINKS_PER_BATCH = 20;

/** 新建文件夹在目标下拉框中的占位 value（不会与真实 id 冲突）。 */
const NEW_FOLDER_VALUE = '__new__';

/** 文件夹名前端预检（后端为权威校验，这里只提前给出可读反馈）。 */
const INVALID_NAME_CHARS = /[/\\:*?"<>|\u0000-\u001f]/;

/** POST /docs 逐条 error.code → 用户可读中文文案。 */
const LINK_ERROR_TEXT: Record<string, string> = {
  parse_failed: '链接无法解析，请确认是飞书云文档或知识库链接',
  already_exists: '文档已在库中',
  unsupported_type: '暂不支持该类型的文档（当前支持 docx / sheet）',
  fetch_failed: '拉取云端内容失败，请稍后重试',
  permission_denied: '无访问权限，请先在飞书中为该应用授权',
};

const DOC_TYPE_ICON: Record<string, typeof FileText> = {
  docx: FileText,
  sheet: Table,
  slides: FileType,
};

interface QuickAddDocDialogProps {
  open: boolean;
  onClose: () => void;
  /** 已有自定义文件夹（GET /api/custom-folders）。 */
  folders: CustomFolder[];
  foldersLoading: boolean;
  /** 添加完成后刷新树与文件夹列表。 */
  onChanged: () => void;
}

function parseLinks(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function friendlyLinkError(result: AddLinkToFolderResult): string {
  const err = result.error;
  if (!err) return '添加失败';
  const base = LINK_ERROR_TEXT[err.code] ?? (err.message || '添加失败');
  const owner = err.owner ?? err.existingLocation;
  if (err.code === 'already_exists' && owner) {
    return `${base}（归属：${owner}）`;
  }
  return base;
}

export function QuickAddDocDialog({
  open,
  onClose,
  folders,
  foldersLoading,
  onChanged,
}: QuickAddDocDialogProps) {
  const toast = useToast();
  const [linksText, setLinksText] = useState('');
  const [targetValue, setTargetValue] = useState<string>('');
  const [newFolderName, setNewFolderName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<AddLinkToFolderResult[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const links = useMemo(() => parseLinks(linksText), [linksText]);
  const isNewFolderMode = targetValue === NEW_FOLDER_VALUE;

  // 仅在「打开」这一转换时重置表单并聚焦；提交成功后 folders 刷新
  // 不得清空逐条结果反馈（results 需保留给用户查看）。
  useEffect(() => {
    if (!open) return;
    setLinksText('');
    setNewFolderName('');
    setResults(null);
    setFormError(null);
    setSubmitting(false);
    setTargetValue(''); // 由下方 effect 按最新 folders 落定默认值
    // 等对话框渲染完成后再聚焦。
    const timer = setTimeout(() => textareaRef.current?.focus(), 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 目标文件夹默认值落定：仅当尚未选定（刚打开 / 无有效选择）时，
  // 取第一个文件夹；无文件夹则进入「新建文件夹」引导态。folders 刷新时
  // 保留用户当前选择（文件夹 id 在刷新后稳定）。
  useEffect(() => {
    if (!open) return;
    setTargetValue((cur) => {
      if (cur === NEW_FOLDER_VALUE) return cur;
      if (cur && folders.some((f) => f.id === cur)) return cur;
      return folders.length > 0 ? folders[0].id : NEW_FOLDER_VALUE;
    });
  }, [open, folders]);

  // Esc 关闭（提交中不允许误关）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const validate = (): string | null => {
    if (links.length === 0) return '请至少粘贴一个飞书链接（每行一个）';
    if (links.length > MAX_LINKS_PER_BATCH) {
      return `单次最多添加 ${MAX_LINKS_PER_BATCH} 条链接，当前 ${links.length} 条，请分批添加`;
    }
    if (isNewFolderMode) {
      const name = newFolderName.trim();
      if (!name) return '请输入新文件夹名称';
      if (name.length > 100) return '文件夹名称过长（最多 100 字符）';
      if (INVALID_NAME_CHARS.test(name)) return '文件夹名称不能包含 / \\ : * ? " < > | 等字符';
      if (folders.some((f) => f.name === name)) return '已存在同名文件夹，请直接选择或更换名称';
    } else if (!targetValue) {
      return '请选择目标文件夹';
    }
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setSubmitting(true);
    setResults(null);
    try {
      let folderId = targetValue;
      if (isNewFolderMode) {
        const folder = await createCustomFolder(newFolderName.trim());
        folderId = folder.id;
      }
      const res = await addLinksToFolder(folderId, links);
      setResults(res);
      const okCount = res.filter((r) => r.ok).length;
      const failCount = res.length - okCount;
      if (okCount > 0) {
        toast.push({
          type: failCount > 0 ? 'warning' : 'success',
          message: `已添加 ${okCount} 篇文档${failCount > 0 ? `，${failCount} 条未成功` : ''}`,
        });
        onChanged();
      } else {
        toast.push({ type: 'warning', message: '没有链接添加成功，请查看逐条反馈' });
      }
      appLogger.info('quick-add', 'add links done', { total: res.length, okCount, failCount });
    } catch (e) {
      const apiErr = e instanceof APIError ? e : null;
      let message = '添加失败，请稍后重试';
      if (apiErr?.statusCode === 400) {
        message = '文件夹名称无效（为空、超长或含非法字符）';
      } else if (apiErr?.statusCode === 409) {
        message = '已存在同名文件夹，请直接选择或更换名称';
      } else if (apiErr?.message) {
        message = apiErr.message;
      }
      setFormError(message);
      appLogger.error('quick-add', 'add links failed', e);
      toast.push({ type: 'error', message: '快捷添加失败', hint: message });
    } finally {
      setSubmitting(false);
    }
  };

  const okCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <div
      className="fixed inset-0 z-[350] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="快捷添加云文档"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="关闭对话框"
        onClick={() => {
          if (!submitting) onClose();
        }}
        className="absolute inset-0 bg-ink/30 animate-fade-in"
      />

      {/* Panel */}
      <div className="relative w-[520px] max-w-full max-h-[85vh] bg-card-bg border border-line rounded-lg shadow-lg flex flex-col animate-drawer-in">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <div className="flex items-center gap-2 min-w-0">
            <Link2 className="w-4 h-4 text-seal shrink-0" />
            <h2 className="text-base font-kai font-medium text-ink truncate">快捷添加云文档</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="关闭"
            className="text-ink-faint hover:text-ink transition-colors shrink-0 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto scrollbar-thin px-5 py-4 space-y-4">
          {/* 链接输入 */}
          <div>
            <label htmlFor="quick-add-links" className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
              飞书链接（每行一个）
            </label>
            <textarea
              ref={textareaRef}
              id="quick-add-links"
              value={linksText}
              onChange={(e) => setLinksText(e.target.value)}
              disabled={submitting}
              rows={5}
              placeholder={'https://xxx.feishu.cn/docx/...\nhttps://xxx.feishu.cn/wiki/...'}
              className="w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint font-mono focus:outline-none focus:border-seal focus:ring-2 focus:ring-seal/20 disabled:opacity-60 resize-y"
            />
            <p className="mt-1.5 text-xs text-ink-faint font-sans-ui">
              支持 docx / sheet / slides 与知识库 wiki 链接，单次最多 {MAX_LINKS_PER_BATCH} 条
              {links.length > 0 && `（当前 ${links.length} 条）`}
            </p>
          </div>

          {/* 目标文件夹 */}
          <div>
            <label htmlFor="quick-add-folder" className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
              归档到文件夹
            </label>
            {foldersLoading ? (
              <div className="flex items-center gap-2 text-sm text-ink-faint font-sans-ui py-2">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                加载文件夹列表…
              </div>
            ) : (
              <select
                id="quick-add-folder"
                value={isNewFolderMode ? NEW_FOLDER_VALUE : targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                disabled={submitting}
                className="w-full text-sm text-ink bg-paper border border-line rounded-md px-3 py-2 font-sans-ui focus:outline-none focus:border-seal cursor-pointer disabled:opacity-60"
              >
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}（{f.docs.length} 篇）
                  </option>
                ))}
                <option value={NEW_FOLDER_VALUE}>+ 新建文件夹…</option>
              </select>
            )}
            {isNewFolderMode && !foldersLoading && (
              <div className="mt-2">
                <div className="relative flex items-center">
                  <FolderPlus className="absolute left-3 w-3.5 h-3.5 text-ink-faint pointer-events-none" />
                  <input
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    disabled={submitting}
                    placeholder="新文件夹名称"
                    aria-label="新文件夹名称"
                    className="w-full rounded-md border border-line bg-paper pl-9 pr-3 py-2 text-sm text-ink placeholder:text-ink-faint font-sans-ui focus:outline-none focus:border-seal focus:ring-2 focus:ring-seal/20 disabled:opacity-60"
                  />
                </div>
                {folders.length === 0 && (
                  <p className="mt-1.5 text-xs text-ink-faint font-sans-ui">
                    还没有自定义归档文件夹，先创建一个再添加链接
                  </p>
                )}
              </div>
            )}
          </div>

          {formError && (
            <p role="alert" className="text-sm text-seal-2 font-sans-ui">{formError}</p>
          )}

          {/* 逐条结果 */}
          {results && (
            <div className="rounded-md border border-line bg-paper-2/40">
              <p className="px-3 py-2 text-xs text-ink-soft font-sans-ui border-b border-line/60">
                添加结果：{okCount} 成功 / {results.length - okCount} 未成功
              </p>
              <ul className="max-h-[180px] overflow-auto scrollbar-thin divide-y divide-line/40">
                {results.map((r, idx) => {
                  const TypeIcon = (r.objType && DOC_TYPE_ICON[r.objType]) || FileText;
                  return (
                    <li key={`${r.link}-${idx}`} className="px-3 py-2 flex items-start gap-2">
                      {r.ok ? (
                        <CheckCircle className="w-4 h-4 text-jade shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-seal-2 shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        {r.ok ? (
                          <p className="text-sm text-ink font-sans-ui flex items-center gap-1.5">
                            <TypeIcon className="w-3.5 h-3.5 text-ink-soft shrink-0" />
                            <span className="truncate" title={r.title}>{r.title || r.objToken}</span>
                          </p>
                        ) : (
                          <>
                            <p className="text-sm text-ink font-sans-ui break-all">{friendlyLinkError(r)}</p>
                            <p className="text-[11px] text-ink-faint font-mono truncate" title={r.link}>{r.link}</p>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <div className="border-t border-line px-5 py-3 bg-paper-2/50 flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {results ? '完成' : '取消'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            loading={submitting}
            disabled={links.length === 0 || foldersLoading}
          >
            添加{links.length > 0 ? `（${links.length} 条）` : ''}
          </Button>
        </div>
      </div>
    </div>
  );
}
