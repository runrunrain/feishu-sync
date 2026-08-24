/**
 * ColumnResizer - 分栏拖拽把手（v0.2.9 布局增强）
 *
 * 左栏与中栏之间的 12px 命中区（视觉上是 2px 分隔线），按住拖动调整
 * 左栏像素宽度；双击恢复默认。仅 lg 及以上渲染（窄屏为纵向堆叠布局，
 * 不存在左右分栏）。拖拽期间给 body 加 col-resize 光标并禁止文本选择。
 */

import { useCallback, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';

interface ColumnResizerProps {
  /** 当前左栏宽度（px）。 */
  width: number;
  min?: number;
  max?: number;
  defaultWidth: number;
  onResize: (width: number) => void;
}

export function ColumnResizer({
  width,
  min = 240,
  max = 560,
  defaultWidth,
  onResize,
}: ColumnResizerProps) {
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const handleMove = (ev: PointerEvent) => {
        const state = dragState.current;
        if (!state) return;
        const next = Math.round(state.startWidth + (ev.clientX - state.startX));
        onResize(Math.min(max, Math.max(min, next)));
      };
      const handleUp = () => {
        dragState.current = null;
        setDragging(false);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        target.removeEventListener('pointermove', handleMove);
        target.removeEventListener('pointerup', handleUp);
        target.removeEventListener('pointercancel', handleUp);
      };
      target.addEventListener('pointermove', handleMove);
      target.addEventListener('pointerup', handleUp);
      target.addEventListener('pointercancel', handleUp);
    },
    [width, min, max, onResize],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整左栏宽度，双击恢复默认"
      title="拖拽调整宽度 · 双击恢复默认"
      onPointerDown={handlePointerDown}
      onDoubleClick={() => onResize(defaultWidth)}
      className={`group hidden lg:flex w-3 shrink-0 cursor-col-resize select-none items-stretch justify-center ${
        dragging ? '' : ''
      }`}
    >
      <span
        className={`w-0.5 rounded-full transition-colors ${
          dragging ? 'bg-seal/70' : 'bg-line/60 group-hover:bg-seal/40'
        }`}
      />
      <GripVertical
        className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 transition-opacity ${
          dragging ? 'text-seal opacity-100' : 'text-ink-faint opacity-0 group-hover:opacity-100'
        }`}
      />
    </div>
  );
}
