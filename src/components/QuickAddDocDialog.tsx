/**
 * QuickAddDocDialog - 快捷添加云文档对话框（双模式统一入口）
 *
 * 入口：Dashboard 左侧树区域顶部「+ 添加」按钮。
 *
 * 模式一「零散云文档」（原有能力）：
 *   1. 多行文本框粘贴飞书链接（每行一个，docx/sheet/slides/wiki 链接原样透传后端解析）
 *   2. 选择目标自定义文件夹，或切换「新建文件夹」输入名称（先 POST 创建再作为目标）
 *   3. 确认 → POST /api/custom-folders/:id/docs（前端先校验 ≤20 条）
 *   4. 逐条结果反馈：成功 / already_exists（附归属）/ unsupported_type /
 *      parse_failed / fetch_failed / permission_denied，均为友好中文文案
 *
 * 模式二「同步根目录」（2026-08 新增）：
 *   粘贴根 URL + 本地目录 + 布局 → 追加 config.watchedRoots（与设置页
 *   WatchedRootsCard 同一契约）；URL 输入即做合法性/重复检测，已存在或添加
 *   成功均提供「跳转查看」（onNavigate → NodeTreeView focusRequest 定位）。
 *
 * 契约字段名见 src/types/index.ts Custom Folder 区块，勿改。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Link2, FolderPlus, CheckCircle, AlertCircle, RefreshCw, FileText, Table, FileType, Cloud, ArrowRight } from 'lucide-react';
import { Button } from './common/Button';
import { useToast } from './common/Toast';
import { APIError, addLinksToFolder, createCustomFolder } from '../api/client';
import { appLogger } from '../utils/appLogger';
import { useConfig } from '../hooks/useConfig';
import { normalizeFeishuUrl, extractWikiRootId } from '../utils/feishu-url';
import { LAYOUT_OPTIONS } from './WatchedRootsCard';
import type { AddLinkToFolderResult, CustomFolder, LayoutProfile, TreeNavTarget } from '../types';

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
  /** 跳转导航（2026-08）：添加成功/链接已存在时「跳转查看」定位到左侧树。 */
  onNavigate?: (target: TreeNavTarget) => void;
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
  onNavigate,
}: QuickAddDocDialogProps) {
  const toast = useToast();
  // 双模式：docs = 零散云文档入自定义归档；root = 添加同步根目录（原设置页独占入口，
  // 2026-08 起快捷添加同样支持）。
  const [mode, setMode] = useState<'docs' | 'root'>('docs');
  const [linksText, setLinksText] = useState('');
  const [targetValue, setTargetValue] = useState<string>('');
  const [newFolderName, setNewFolderName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<AddLinkToFolderResult[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // 上次成功提交的目标文件夹 id（跳转定位用；新建文件夹模式提交后落定为真实 id）。
  const [lastSubmitFolderId, setLastSubmitFolderId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ---- 同步根目录模式 ----
  const { config, updateConfig } = useConfig();
  const [rootUrl, setRootUrl] = useState('');
  const [rootLocalDir, setRootLocalDir] = useState('');
  const [rootLayout, setRootLayout] = useState<LayoutProfile>('directory-readme');
  const [rootSubmitting, setRootSubmitting] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootAdded, setRootAdded] = useState<{ url: string; localDir: string } | null>(null);

  // URL 输入即解析：合法性与「是否已存在」实时反馈。
  const rootParsed = useMemo(() => {
    const normalized = normalizeFeishuUrl(rootUrl);
    const id = normalized.isValid ? extractWikiRootId(normalized.canonical) : null;
    return { canonical: normalized.canonical, id };
  }, [rootUrl]);
  const existingRoot = useMemo(
    () =>
      rootParsed.id
        ? (config?.watchedRoots ?? []).find((r) => r.id === rootParsed.id) ?? null
        : null,
    [config, rootParsed.id],
  );

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
    setLastSubmitFolderId(null);
    setMode('docs');
    setRootUrl('');
    setRootLocalDir('');
    setRootLayout('directory-readme');
    setRootError(null);
    setRootAdded(null);
    setRootSubmitting(false);
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
      setLastSubmitFolderId(folderId);
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

  // 添加同步根目录：追加到 watchedRoots（与设置页 WatchedRootsCard 同一契约），
  // 重复/非法输入在提交前拦截；成功后给出「跳转查看」。
  const handleAddRoot = async () => {
    setRootError(null);
    if (!rootUrl.trim()) {
      setRootError('请粘贴飞书知识库根 URL');
      return;
    }
    if (!rootParsed.id) {
      setRootError('必须是 https://<租户>.feishu.cn/wiki/<token> 形式的根 URL');
      return;
    }
    if (existingRoot) {
      setRootError('该同步根目录已存在，可直接「跳转查看」');
      return;
    }
    const localDir = rootLocalDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (
      !localDir ||
      localDir.startsWith('/') ||
      /^[A-Za-z]:\//.test(localDir) ||
      localDir.split('/').some((seg) => !seg || seg === '.' || seg === '..')
    ) {
      setRootError('本地目录必须是知识库根目录下的相对路径（如：技术 - Dev）');
      return;
    }
    if ((config?.watchedRoots ?? []).some((r) => r.localDir === localDir)) {
      setRootError(`本地目录「${localDir}」已被其他同步根目录占用`);
      return;
    }
    setRootSubmitting(true);
    try {
      const roots = [
        ...(config?.watchedRoots ?? []),
        {
          id: rootParsed.id,
          url: rootParsed.canonical,
          localDir,
          layoutProfile: rootLayout,
          enabled: true,
        },
      ];
      await updateConfig({ watchedRoots: roots });
      setRootAdded({ url: rootParsed.canonical, localDir });
      appLogger.info('quick-add', 'add watched root ok', { url: rootParsed.canonical, localDir });
      toast.push({
        type: 'success',
        message: '已添加同步根目录',
        hint: '执行「立即检测」后该分组将出现在左侧树中',
      });
      onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRootError(message);
      appLogger.error('quick-add', 'add watched root failed', e);
      toast.push({ type: 'error', message: '添加同步根目录失败', hint: message });
    } finally {
      setRootSubmitting(false);
    }
  };

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

        {/* 模式切换：零散云文档 / 同步根目录（2026-08：根 URL 添加不再只能去设置页） */}
        <div className="px-5 pt-3 pb-0 flex items-center gap-1.5 border-b border-line">
          {([
            { key: 'docs', label: '零散云文档', icon: FileText },
            { key: 'root', label: '同步根目录', icon: Cloud },
          ] as const).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setMode(tab.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-sans-ui rounded-t-md border-b-2 transition-colors ${
                mode === tab.key
                  ? 'border-seal text-seal bg-seal/5'
                  : 'border-transparent text-ink-faint hover:text-ink-soft'
              }`}
            >
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto scrollbar-thin px-5 py-4 space-y-4">
          {mode === 'root' ? (
            <>
              {/* 同步根目录：URL + 本地目录 + 布局；已存在时给出跳转 */}
              <div>
                <label htmlFor="quick-add-root-url" className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
                  知识库根 URL
                </label>
                <input
                  id="quick-add-root-url"
                  type="text"
                  value={rootUrl}
                  onChange={(e) => { setRootUrl(e.target.value); setRootError(null); setRootAdded(null); }}
                  disabled={rootSubmitting}
                  placeholder="https://xxx.feishu.cn/wiki/<token>"
                  className="w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint font-mono focus:outline-none focus:border-seal focus:ring-2 focus:ring-seal/20 disabled:opacity-60"
                />
                {rootUrl.trim() && !rootParsed.id && (
                  <p className="mt-1.5 text-xs text-seal-2 font-sans-ui">
                    无法识别为知识库根 URL（需 https://&lt;租户&gt;.feishu.cn/wiki/&lt;token&gt;）
                  </p>
                )}
                {existingRoot && (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2">
                    <p className="min-w-0 flex-1 text-xs text-ink-soft font-sans-ui truncate">
                      该根目录已存在（本地目录：{existingRoot.localDir}）
                    </p>
                    {onNavigate && (
                      <button
                        type="button"
                        onClick={() => onNavigate({ kind: 'group', key: existingRoot.url })}
                        className="inline-flex items-center gap-1 text-xs text-seal hover:underline shrink-0 font-sans-ui"
                      >
                        跳转查看
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label htmlFor="quick-add-root-dir" className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
                  本地目录（知识库根目录下的相对路径）
                </label>
                <input
                  id="quick-add-root-dir"
                  type="text"
                  value={rootLocalDir}
                  onChange={(e) => setRootLocalDir(e.target.value)}
                  disabled={rootSubmitting}
                  placeholder="例如：技术 - Dev"
                  className="w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint font-sans-ui focus:outline-none focus:border-seal focus:ring-2 focus:ring-seal/20 disabled:opacity-60"
                />
              </div>

              <div>
                <label htmlFor="quick-add-root-layout" className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
                  目录布局
                </label>
                <select
                  id="quick-add-root-layout"
                  value={rootLayout}
                  onChange={(e) => setRootLayout(e.target.value as LayoutProfile)}
                  disabled={rootSubmitting}
                  className="w-full text-sm text-ink bg-paper border border-line rounded-md px-3 py-2 font-sans-ui focus:outline-none focus:border-seal cursor-pointer disabled:opacity-60"
                >
                  {LAYOUT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-ink-faint font-sans-ui">
                  与设置页「同步根目录与布局」同一契约；添加后执行「立即检测」即可在左侧树看到该分组。
                </p>
              </div>

              {rootError && (
                <p role="alert" className="text-sm text-seal-2 font-sans-ui">{rootError}</p>
              )}

              {rootAdded && (
                <div className="rounded-md border border-jade/50 bg-jade/5 px-3 py-2.5 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-jade shrink-0" />
                  <p className="min-w-0 flex-1 text-xs text-ink-soft font-sans-ui">
                    已添加：{rootAdded.localDir}
                  </p>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => onNavigate({ kind: 'group', key: rootAdded.url })}
                      className="inline-flex items-center gap-1 text-xs text-seal hover:underline shrink-0 font-sans-ui"
                    >
                      跳转查看
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
          <>
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
                  // 跳转目标文件夹：刚添加成功的用本次提交目标；already_exists 的按
                  // objToken 在现有文件夹中反查归属。
                  const jumpFolderId = r.ok
                    ? lastSubmitFolderId
                    : r.error?.code === 'already_exists' && r.objToken
                      ? folders.find((f) => f.docs.some((d) => d.objToken === r.objToken))?.id ?? null
                      : null;
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
                      {onNavigate && r.objToken && jumpFolderId && (
                        <button
                          type="button"
                          onClick={() => onNavigate({ kind: 'custom-doc', folderId: jumpFolderId, objToken: r.objToken! })}
                          className="inline-flex items-center gap-1 text-[11px] text-seal hover:underline shrink-0 font-sans-ui mt-0.5"
                        >
                          跳转
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          </>
          )}
        </div>

        <div className="border-t border-line px-5 py-3 bg-paper-2/50 flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting || rootSubmitting}>
            {results || rootAdded ? '完成' : '取消'}
          </Button>
          {mode === 'root' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={handleAddRoot}
              loading={rootSubmitting}
              disabled={!rootUrl.trim() || !!rootAdded}
            >
              添加根目录
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              loading={submitting}
              disabled={links.length === 0 || foldersLoading}
            >
              添加{links.length > 0 ? `（${links.length} 条）` : ''}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
