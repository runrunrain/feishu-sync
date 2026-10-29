import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
export interface SourceMenuTarget {
  objToken: string;
  title: string;
  x: number;
  y: number;
  localPath?: string | null;
  canSync?: boolean;
  /**
   * P2-S7 移出入口可见性（菜单层本地判断：watchedRoot 成员叶子；
   * 服务端八分支门控兜底）。仅按需携带，旧调用方不传即不显示移出项。
   */
}
export function SourceNodeMenu({ target, onClose, onDelete, onSyncNode, onOpenFolder, count = 1 }: {
  target: SourceMenuTarget | null;
  onClose: () => void;
  onDelete: (doc: { objToken: string; title: string }) => void;
  /** P2-S7：移出到云空间入口（两段确认弹窗由宿主挂载）。 */
  onSyncNode?: (objToken: string) => void;
  onOpenFolder?: (localPath: string | null) => void;
  count?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!target) return;
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', escape); window.addEventListener('blur', onClose); window.addEventListener('scroll', onClose, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape); window.removeEventListener('blur', onClose); window.removeEventListener('scroll', onClose, true); };
  }, [target, onClose]);
  if (!target) return null;
  // 菜单高度估算（定位夹取用）：删除及可选操作各一行约 40px。
  const menuHeight = 48 + (onSyncNode ? 40 : 0) + (onOpenFolder ? 40 : 0);
  return createPortal(<div ref={ref} role="menu" aria-label={`${target.title}的操作`} style={{ position: 'fixed', left: Math.max(8, Math.min(target.x, window.innerWidth - 224)), top: Math.max(8, Math.min(target.y, window.innerHeight - menuHeight)), zIndex: 100 }} className="w-52 max-h-[calc(100vh-16px)] overflow-y-auto rounded border border-line bg-card-bg shadow-lg p-1">
    {onSyncNode ? <button type="button" role="menuitem" disabled={!target.canSync} className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-ink hover:bg-paper-2 focus:bg-paper-2 outline-none disabled:opacity-40 disabled:cursor-not-allowed" onClick={() => { onClose(); onSyncNode(target.objToken); }}><RefreshCw className="w-4 h-4" />同步此节点</button> : null}
    {onOpenFolder ? <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-ink hover:bg-paper-2 focus:bg-paper-2 outline-none" onClick={() => { onClose(); onOpenFolder(target.localPath ?? null); }}><FolderOpen className="w-4 h-4" />在文件夹中打开</button> : null}
    <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-seal-2 hover:bg-seal/5 focus:bg-seal/5 outline-none" onClick={() => { onClose(); onDelete(target); }}><Trash2 className="w-4 h-4" />{count > 1 ? `删除所选 ${count} 篇…` : '删除文档…'}</button>
    {/* P2-S7：移出到云空间（仅 watchedRoot 成员叶子；两段确认弹窗在宿主）。 */}
  </div>, document.body);
}
