/**
 * TrashDrawer - 回收站抽屉（T10，决策2：右侧抽屉形态，04 §4.2 / §7.2 #18）
 *
 * 与 LogDrawer 视觉一致（同 Drawer 骨架，宽 480px 右滑动画）。
 * 操作：恢复（cloud_deleted=0 + 移回原路径）/ 永久清理（fs.unlink）/
 *      批量清空。
 *
 * 消费 P2 软删除 API：
 *   GET    /api/trash                  — 列表
 *   POST   /api/trash/restore          — 恢复单条
 *   DELETE /api/trash/purge?obj_token= — 永久清理单条
 *   DELETE /api/trash/purge?all=1      — 清空全部
 *
 * 【阻塞说明】后端 server/src/routes/mapping.ts 当前仅有 tree/diff/index/
 * refresh-index/reorder 五个端点，**没有回收站端点**（截至 HEAD 43121ef）。
 * 前端按预期契约实现 UI + 调用；缺失端点时 Toast 提示并保留空态。
 * Leader 需派鲁班补端点，本组件无需修改。
 */

import { useCallback, useEffect, useState } from 'react';
import { Trash2, RotateCcw, AlertTriangle, Inbox } from 'lucide-react';
import { Drawer } from './common/Drawer';
import { Button } from './common/Button';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { listTrashedDocs, restoreTrashedDoc, purgeTrashedDoc, clearTrash, APIError } from '../api/client';
import type { TrashedDoc } from '../types';

interface TrashDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Notify parent after a successful restore/purge so the change list refreshes. */
  onChanged?: () => void;
}

function isEndpointMissing(err: unknown): boolean {
  return err instanceof APIError && (err.statusCode === 404 || err.statusCode === 405);
}

export function TrashDrawer({ open, onClose, onChanged }: TrashDrawerProps) {
  const [items, setItems] = useState<TrashedDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // obj_token or 'all'
  const [endpointMissing, setEndpointMissing] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listTrashedDocs();
      setItems(data);
      setEndpointMissing(false);
    } catch (err) {
      if (isEndpointMissing(err)) {
        setEndpointMissing(true);
        setItems([]);
      } else {
        appLogger.error('trash', 'listTrashedDocs failed', err);
        toast.push({ type: 'error', message: '回收站列表加载失败', hint: err instanceof Error ? err.message : '' });
      }
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleRestore = async (item: TrashedDoc) => {
    setBusy(item.obj_token);
    try {
      await restoreTrashedDoc(item.obj_token);
      setItems((prev) => prev.filter((x) => x.obj_token !== item.obj_token));
      toast.push({ type: 'success', message: '已恢复', hint: item.title });
      onChanged?.();
    } catch (err) {
      if (isEndpointMissing(err)) {
        toast.push({ type: 'warning', message: '后端尚未实现回收站端点', hint: '请联系开发者补充 /api/trash/* 路由' });
      } else {
        appLogger.error('trash', 'restore failed', err);
        toast.push({ type: 'error', message: '恢复失败', hint: err instanceof Error ? err.message : '' });
      }
    } finally {
      setBusy(null);
    }
  };

  const handlePurge = async (item: TrashedDoc) => {
    if (!window.confirm(`永久清理「${item.title}」？该操作不可撤销。`)) return;
    setBusy(item.obj_token);
    try {
      await purgeTrashedDoc(item.obj_token);
      setItems((prev) => prev.filter((x) => x.obj_token !== item.obj_token));
      toast.push({ type: 'info', message: '已永久清理', hint: item.title });
      onChanged?.();
    } catch (err) {
      if (isEndpointMissing(err)) {
        toast.push({ type: 'warning', message: '后端尚未实现回收站端点', hint: '请联系开发者补充 /api/trash/* 路由' });
      } else {
        appLogger.error('trash', 'purge failed', err);
        toast.push({ type: 'error', message: '清理失败', hint: err instanceof Error ? err.message : '' });
      }
    } finally {
      setBusy(null);
    }
  };

  const handleClearAll = async () => {
    if (items.length === 0) return;
    if (!window.confirm(`清空回收站中全部 ${items.length} 项？该操作不可撤销。`)) return;
    setBusy('all');
    try {
      const res = await clearTrash();
      setItems([]);
      toast.push({ type: 'info', message: `已清空 ${res.purged} 项` });
      onChanged?.();
    } catch (err) {
      if (isEndpointMissing(err)) {
        toast.push({ type: 'warning', message: '后端尚未实现回收站端点', hint: '请联系开发者补充 /api/trash/* 路由' });
      } else {
        appLogger.error('trash', 'clearAll failed', err);
        toast.push({ type: 'error', message: '清空失败', hint: err instanceof Error ? err.message : '' });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="回收站"
      subtitle={endpointMissing ? '后端端点缺失 · 仅展示' : `${items.length} 项软删除文档`}
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-faint font-sans-ui">
            恢复 = 移回原路径 · 清理 = 永久删除
          </span>
          <Button
            size="sm"
            variant="danger"
            onClick={handleClearAll}
            disabled={items.length === 0 || busy !== null || endpointMissing}
            loading={busy === 'all'}
          >
            <Trash2 className="w-3.5 h-3.5" />
            清空回收站
          </Button>
        </div>
      }
    >
      {endpointMissing && (
        <div className="m-4 p-3 rounded-md border border-seal/30 bg-seal/5 text-xs text-ink-soft">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-seal shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-ink">后端尚未实现回收站端点</p>
              <p className="mt-1">
                前端已按预期契约调用 <code className="font-mono text-seal">GET /api/trash</code>、
                <code className="font-mono text-seal"> POST /api/trash/restore</code>、
                <code className="font-mono text-seal"> DELETE /api/trash/purge</code>。
                请由开发者补齐路由后即可恢复使用。
              </p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin h-5 w-5 border-2 border-seal border-t-transparent rounded-full" />
        </div>
      ) : items.length === 0 && !endpointMissing ? (
        <div className="flex flex-col items-center justify-center py-16 text-center px-4">
          <Inbox className="w-10 h-10 text-ink-faint mb-3" />
          <p className="text-sm text-ink-soft">回收站为空</p>
          <p className="text-xs text-ink-faint mt-1">无软删除的文档。</p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.obj_token} className="px-5 py-3">
              <p className="text-sm text-ink truncate">{item.title}</p>
              <p className="text-[11px] text-ink-faint font-mono mt-0.5 truncate">{item.local_path}</p>
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => handleRestore(item)}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-ink-soft border border-line rounded bg-card-bg hover:bg-paper-2 font-sans-ui disabled:opacity-50"
                >
                  <RotateCcw className="w-3 h-3" />
                  恢复
                </button>
                <button
                  type="button"
                  onClick={() => handlePurge(item)}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-seal-2 border border-seal-2/40 rounded bg-card-bg hover:bg-seal-2/5 font-sans-ui disabled:opacity-50"
                >
                  <Trash2 className="w-3 h-3" />
                  永久清理
                </button>
                {item.deleted_at && (
                  <span className="text-[10px] text-ink-faint ml-auto font-mono">
                    {new Date(item.deleted_at).toLocaleString('zh-CN', { hour12: false })}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
