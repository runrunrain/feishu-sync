/**
 * Modal - 居中弹窗（2026-10 首次配置引导引入）
 *
 * 项目此前只有 Drawer（侧滑）与 window.confirm；「弹窗跳转引导」需要居中
 * 模态承载多动作按钮（如：前往设置 / 使用默认路径并继续 / 取消），
 * confirm 的确定/取消两键不够表达。
 *
 * 样式对齐 Card（宣纸风：bg-card-bg + border-line + rounded-md + shadow）；
 * overlay 半透明纸色遮罩；open=false 不渲染（而非 display:none，避免
 * 表单状态/焦点残留）。ESC 关闭（onClose 可选，缺省不响应）。
 */

import { useEffect } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  onClose?: () => void;
  children: React.ReactNode;
  /** 内容区最大宽度（Tailwind class），缺省 max-w-md。 */
  contentClassName?: string;
}

export function Modal({ open, title, onClose, children, contentClassName = 'max-w-md' }: ModalProps) {
  useEffect(() => {
    if (!open || !onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-[2px] p-4"
      onMouseDown={(e) => {
        // 仅点遮罩空白处关闭；弹窗内容区内冒泡的 mousedown 不触发。
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${contentClassName} bg-card-bg border border-line rounded-md shadow-lg`}
      >
        <div className="px-6 py-4 border-b border-line">
          <h3 className="text-base font-kai font-medium text-ink">{title}</h3>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
