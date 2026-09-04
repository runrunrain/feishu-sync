/**
 * OrphanFilesCard - 孤立本地文件清理（2026-09-04）
 *
 * 场景：同步根 URL 从配置移除后，其 <localDir>/ 与散档仍留在知识库
 * 根目录（DB 数据已由保存时级联清理）。本卡片 dry-run 扫描孤立项
 * （含 feishu_sync 头的同步产物才列出，用户自有内容不碰），点击
 * 「清理到回收站」移动到 .trash-bin/orphan-<ts>/，可恢复。
 */

import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Loader2, Trash2 } from 'lucide-react';
import { scanOrphanFiles, cleanupOrphanFiles, type OrphanFileItem } from '../api/client';
import { Card } from './common/Card';
import { Button } from './common/Button';
import { useToast } from './common/Toast';

export function OrphanFilesCard() {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [items, setItems] = useState<OrphanFileItem[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await scanOrphanFiles();
      setItems(result.items);
    } catch (err) {
      toast.push({
        type: 'error',
        message: '孤立文件扫描失败',
        hint: err instanceof Error ? err.message : '',
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCleanup = async () => {
    if (items.length === 0) return;
    setCleaning(true);
    try {
      const result = await cleanupOrphanFiles(items, 'APPLY');
      if (result.failed.length > 0) {
        toast.push({
          type: 'warning',
          message: `清理完成：${result.moved.length} 项成功，${result.failed.length} 项失败`,
          hint: result.failed.map((f) => `${f.relPath}（${f.error}）`).join('；'),
        });
      } else {
        toast.push({
          type: 'success',
          message: `已清理 ${result.moved.length} 项到回收站`,
          hint: `${result.trashDir}（可随时手动恢复）`,
        });
      }
      await refresh();
    } catch (err) {
      toast.push({
        type: 'error',
        message: '孤立文件清理失败',
        hint: err instanceof Error ? err.message : '',
      });
    } finally {
      setCleaning(false);
    }
  };

  return (
    <Card variant="elevated">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-base font-medium text-ink">孤立文件清理</h2>
          <p className="text-xs text-ink-faint mt-1 leading-relaxed">
            同步根被移除后残留在本地的同步产物目录/散档（含 feishu_sync 头）；
            与任何已配置同步根、自定义归档有对应关系的内容不会列出。清理为
            移动到 <code className="text-[11px]">.trash-bin/orphan-*</code> 回收站，可恢复。
          </p>
        </div>
        <Button variant="ghost" onClick={() => void refresh()} loading={loading}>
          重新扫描
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-line bg-paper-2/40 px-4 py-6 text-center text-xs text-ink-faint">
          {loading ? '扫描中…' : '未发现孤立文件'}
        </div>
      ) : (
        <>
          <ul className="max-h-64 overflow-y-auto scrollbar-thin rounded-md border border-line divide-y divide-line/60 bg-card-bg">
            {items.map((item) => (
              <li key={item.relPath} className="flex items-center gap-2 px-3 py-2 text-xs">
                <FolderOpen className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
                <span className="truncate text-ink-soft" title={item.relPath}>
                  {item.relPath}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-ink-faint font-sans-ui">
                  {item.type === 'dir' ? '目录' : '文件'}
                  {item.evidence ? ` · 证据 ${item.evidence}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between mt-3">
            <span className="text-[11px] text-ink-faint">
              共 {items.length} 项，全部移动到回收站（不删除）
            </span>
            <Button variant="danger" onClick={() => void handleCleanup()} loading={cleaning}>
              {cleaning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              清理到回收站
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
