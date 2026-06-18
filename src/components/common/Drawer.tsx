/**
 * Drawer - 右侧抽屉通用骨架（T9/T2，04 §7.2 #17/#18）
 *
 * 用于 LogDrawer 与 TrashDrawer（决策2）。从右侧滑入，宽 480px，
 * 覆盖主内容区但不阻挡 TopBar。点击遮罩或按 Esc 关闭。
 */

import { ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Optional footer (e.g. actions row). */
  footer?: ReactNode;
  widthClass?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  widthClass = 'w-[480px] max-w-[88vw]',
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[350] flex"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="关闭抽屉"
        onClick={onClose}
        className="flex-1 bg-ink/30 animate-fade-in"
      />

      {/* Panel */}
      <div
        className={`${widthClass} h-full bg-card-bg border-l border-line shadow-lg flex flex-col animate-drawer-in`}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-base font-kai font-medium text-ink truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-ink-faint mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="text-ink-faint hover:text-ink transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto scrollbar-thin">{children}</div>

        {footer && (
          <div className="border-t border-line px-5 py-3 bg-paper-2/50">{footer}</div>
        )}
      </div>
    </div>
  );
}
