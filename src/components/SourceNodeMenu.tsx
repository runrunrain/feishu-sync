import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LogOut, ShieldCheck, Trash2 } from 'lucide-react';
export interface SourceMenuTarget {
  objToken: string;
  title: string;
  x: number;
  y: number;
  /**
   * P2-S7 移出入口可见性（菜单层本地判断：watchedRoot 成员叶子；
   * 服务端八分支门控兜底）。仅按需携带，旧调用方不传即不显示移出项。
   */
  moveOutEligible?: boolean;
}
export function SourceNodeMenu({ target, onClose, onDelete, onBlock, onMoveOut, count = 1 }: {
  target: SourceMenuTarget | null;
  onClose: () => void;
  onDelete: (doc: { objToken: string; title: string }) => void;
  onBlock?: () => void;
  /** P2-S7：移出到云空间入口（两段确认弹窗由宿主挂载）。 */
  onMoveOut?: (doc: { objToken: string; title: string }) => void;
  count?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!target) return;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', escape); window.addEventListener('blur', onClose); window.addEventListener('scroll', onClose, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape); window.removeEventListener('blur', onClose); window.removeEventListener('scroll', onClose, true); };
  }, [target, onClose]);
  if (!target) return null;
  // 菜单高度估算（定位夹取用）：删除 + 屏蔽 + 移出各一行 ~40px + 边距。
  const menuHeight = 48 + (onBlock ? 40 : 0) + (onMoveOut && target.moveOutEligible ? 40 : 0);
  return createPortal(<div ref={ref} role="menu" aria-label={`${target.title}的操作`} style={{ position: 'fixed', left: Math.max(8, Math.min(target.x, window.innerWidth - 224)), top: Math.max(8, Math.min(target.y, window.innerHeight - menuHeight)), zIndex: 100 }} className="w-52 rounded border border-line bg-card-bg shadow-lg p-1">
    <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-seal-2 hover:bg-seal/5 focus:bg-seal/5 outline-none" onClick={() => { onClose(); onDelete(target); }}><Trash2 className="w-4 h-4" />{count > 1 ? `删除所选 ${count} 篇…` : '删除文档…'}</button>
    {onBlock ? <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-ink hover:bg-paper-2 focus:bg-paper-2 outline-none" onClick={() => { onClose(); onBlock(); }}><ShieldCheck className="w-4 h-4" />{count > 1 ? `屏蔽所选 ${count} 篇…` : '移入屏蔽名单…'}</button> : null}
    {/* P2-S7：移出到云空间（仅 watchedRoot 成员叶子；两段确认弹窗在宿主）。 */}
    {onMoveOut && target.moveOutEligible ? <button role="menuitem" data-testid="menu-move-out" className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-ink hover:bg-paper-2 focus:bg-paper-2 outline-none" onClick={() => { onClose(); onMoveOut(target); }}><LogOut className="w-4 h-4" />移出到云空间…</button> : null}
  </div>, document.body);
}
