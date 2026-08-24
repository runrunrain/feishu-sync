/**
 * CustomArchiveSettingsCard - 自定义归档管理卡片（设置-知识库与同步，2026-08）
 *
 * 背景：快捷添加的零散云文档与其分类文件夹此前只在 Dashboard 左侧树的
 * 「自定义归档」区块展示，没有任何管理入口（改名/删除/移出文档）。
 *
 * 能力（全部复用 /api/custom-folders 既有契约 + 新增 DELETE docs/:objToken）：
 *   - 新建文件夹（POST）
 *   - 重命名文件夹（PATCH，仅改 name 标签，localRelPath 不变、不动文件）
 *   - 删除文件夹（DELETE：文档归档归属置空、本地文件保留）——两步确认防误删
 *   - 文件夹展开查看文档：原文链接 + 移出归档（DELETE docs/:objToken，文件保留）
 */

import { useCallback, useEffect, useState } from 'react';
import {
  FolderArchive,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  ChevronRight,
  RefreshCw,
  FileText,
  Table,
  FileType,
  Check,
  X,
  ExternalLink,
} from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { useToast } from './common/Toast';
import {
  APIError,
  createCustomFolder,
  deleteCustomFolder,
  listCustomFolders,
  removeDocFromFolder,
  renameCustomFolder,
} from '../api/client';
import { appLogger } from '../utils/appLogger';
import type { CustomFolder } from '../types';

const DOC_TYPE_ICON: Record<string, typeof FileText> = {
  docx: FileText,
  sheet: Table,
  slides: FileType,
};

export function CustomArchiveSettingsCard() {
  const toast = useToast();
  const [folders, setFolders] = useState<CustomFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // 行内重命名：editingId + 草稿；保存走 PATCH。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // 删除两步确认：第一次点击进入确认态，5 秒未确认自动复位。
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await listCustomFolders();
      setFolders(list);
    } catch (e) {
      appLogger.error('custom-archive-settings', 'list failed', e);
      toast.push({ type: 'error', message: '加载自定义归档失败' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = setTimeout(() => setConfirmDeleteId(null), 5000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createCustomFolder(name);
      setNewName('');
      toast.push({ type: 'success', message: `已创建文件夹「${name}」` });
      await reload();
    } catch (e) {
      const status = e instanceof APIError ? e.statusCode : 0;
      toast.push({
        type: 'error',
        message: '创建文件夹失败',
        hint: status === 409 ? '已存在同名文件夹' : status === 400 ? '名称无效（为空、超长或含非法字符）' : undefined,
      });
    } finally {
      setCreating(false);
    }
  };

  const startRename = (folder: CustomFolder) => {
    setEditingId(folder.id);
    setEditName(folder.name);
  };

  const handleRename = async (folder: CustomFolder) => {
    const name = editName.trim();
    if (!name || name === folder.name) {
      setEditingId(null);
      return;
    }
    setBusyId(folder.id);
    try {
      await renameCustomFolder(folder.id, name);
      toast.push({ type: 'success', message: `已重命名为「${name}」` });
      setEditingId(null);
      await reload();
    } catch (e) {
      const status = e instanceof APIError ? e.statusCode : 0;
      toast.push({
        type: 'error',
        message: '重命名失败',
        hint: status === 409 ? '已存在同名文件夹' : undefined,
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteFolder = async (folder: CustomFolder) => {
    setBusyId(folder.id);
    try {
      await deleteCustomFolder(folder.id);
      toast.push({
        type: 'success',
        message: `已删除文件夹「${folder.name}」`,
        hint: folder.docs.length > 0 ? `${folder.docs.length} 篇文档的本地文件保留，仅解除归档归属` : undefined,
      });
      setConfirmDeleteId(null);
      await reload();
    } catch (e) {
      appLogger.error('custom-archive-settings', 'delete folder failed', e);
      toast.push({ type: 'error', message: '删除文件夹失败' });
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveDoc = async (folder: CustomFolder, objToken: string, title: string) => {
    setBusyId(`${folder.id}:${objToken}`);
    try {
      await removeDocFromFolder(folder.id, objToken);
      toast.push({ type: 'success', message: `已把「${title}」移出归档`, hint: '本地文件保留' });
      await reload();
    } catch (e) {
      appLogger.error('custom-archive-settings', 'remove doc failed', e);
      toast.push({ type: 'error', message: '移出文档失败' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <FolderArchive className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">自定义归档</h2>
          <span className="text-xs text-ink-faint font-sans-ui">
            零散云文档与分类文件夹管理；删除/移出均保留本地文件
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* 新建文件夹 */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 flex items-center">
            <FolderPlus className="absolute left-3 w-3.5 h-3.5 text-ink-faint pointer-events-none" />
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
              placeholder="新建文件夹名称"
              aria-label="新建文件夹名称"
              className="w-full rounded-md border border-line bg-paper pl-9 pr-3 py-2 text-sm text-ink placeholder:text-ink-faint font-sans-ui focus:outline-none focus:border-seal focus:ring-2 focus:ring-seal/20"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleCreate()}
            loading={creating}
            disabled={!newName.trim()}
          >
            创建
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-ink-faint font-sans-ui py-4">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            加载归档文件夹…
          </div>
        ) : folders.length === 0 ? (
          <p className="rounded-md border border-dashed border-line bg-paper-2/40 px-4 py-6 text-center text-xs text-ink-faint font-sans-ui">
            还没有自定义归档文件夹。在左侧树点「+ 添加」可把零散云文档归入此处管理的文件夹。
          </p>
        ) : (
          <ul className="divide-y divide-line/50 rounded-md border border-line">
            {folders.map((folder) => {
              const expanded = expandedIds.has(folder.id);
              const renaming = editingId === folder.id;
              const confirming = confirmDeleteId === folder.id;
              const busy = busyId === folder.id;
              return (
                <li key={folder.id}>
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => toggleExpand(folder.id)}
                      aria-expanded={expanded}
                      aria-label={expanded ? `收起 ${folder.name}` : `展开 ${folder.name}`}
                      className="text-ink-faint hover:text-ink transition-colors shrink-0"
                    >
                      <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                    </button>
                    <Folder className="w-4 h-4 text-seal shrink-0" />
                    {renaming ? (
                      <div className="flex-1 flex items-center gap-1.5 min-w-0">
                        <input
                          type="text"
                          value={editName}
                          autoFocus
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRename(folder);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          aria-label="文件夹新名称"
                          className="flex-1 min-w-0 rounded-sm border border-seal/50 bg-paper px-2 py-1 text-sm text-ink font-sans-ui focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void handleRename(folder)}
                          disabled={busy}
                          aria-label="确认重命名"
                          className="text-jade hover:text-seal transition-colors shrink-0 disabled:opacity-50"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          aria-label="取消重命名"
                          className="text-ink-faint hover:text-ink transition-colors shrink-0"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-ink font-sans-ui truncate">{folder.name}</p>
                          <p className="text-[11px] text-ink-faint font-mono truncate" title={folder.localRelPath}>
                            {folder.localRelPath} · {folder.docs.length} 篇
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => startRename(folder)}
                          aria-label={`重命名 ${folder.name}`}
                          title="重命名（仅改标签，本地目录不变）"
                          className="text-ink-faint hover:text-seal transition-colors shrink-0"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirming) {
                              void handleDeleteFolder(folder);
                            } else {
                              setConfirmDeleteId(folder.id);
                            }
                          }}
                          disabled={busy}
                          aria-label={confirming ? `确认删除 ${folder.name}` : `删除 ${folder.name}`}
                          title={confirming ? '再次点击确认删除' : '删除文件夹（文档文件保留）'}
                          className={`inline-flex items-center gap-1 transition-colors shrink-0 ${
                            confirming
                              ? 'text-seal-2 font-medium text-xs font-sans-ui'
                              : 'text-ink-faint hover:text-seal-2'
                          } disabled:opacity-50`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {confirming && '确认删除？'}
                        </button>
                      </>
                    )}
                  </div>
                  {expanded && (
                    <ul className="border-t border-line/40 bg-paper-2/30">
                      {folder.docs.length === 0 ? (
                        <li className="px-10 py-2.5 text-[11px] text-ink-faint font-sans-ui">
                          （空文件夹）
                        </li>
                      ) : (
                        folder.docs.map((doc) => {
                          const TypeIcon = DOC_TYPE_ICON[doc.objType] ?? FileType;
                          const docBusy = busyId === `${folder.id}:${doc.objToken}`;
                          return (
                            <li key={doc.objToken} className="flex items-center gap-2 pl-10 pr-3 py-1.5">
                              <TypeIcon className="w-3.5 h-3.5 text-ink-soft shrink-0" />
                              <span className="min-w-0 flex-1 truncate text-xs text-ink font-sans-ui" title={doc.localRelPath}>
                                {doc.title}
                              </span>
                              {doc.originalLink && (
                                <a
                                  href={doc.originalLink}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`在飞书中打开 ${doc.title}`}
                                  className="text-ink-faint hover:text-seal transition-colors shrink-0"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleRemoveDoc(folder, doc.objToken, doc.title)}
                                disabled={docBusy}
                                title="移出归档（本地文件保留）"
                                className="text-[11px] text-ink-faint hover:text-seal-2 transition-colors shrink-0 font-sans-ui disabled:opacity-50"
                              >
                                移出
                              </button>
                            </li>
                          );
                        })
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-xs text-ink-faint font-serif">
          删除文件夹仅解除文档的归档归属；「移出」把单篇文档移出归档。两者都保留本地文件与同步基线，
          重新添加同一链接时会识别为已存在。
        </p>
      </CardBody>
    </Card>
  );
}
