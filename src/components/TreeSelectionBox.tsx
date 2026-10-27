import { useEffect, useRef } from 'react';
import type { SelectionModifiers } from '../utils/treeSelection';
export interface TreeSelectionProps { selected: number; total: number; onChange: (modifiers: SelectionModifiers) => void }
export function TreeSelectionBox({ title, selected, total, onChange }: TreeSelectionProps & { title: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = selected > 0 && selected < total; }, [selected, total]);
  return <input ref={ref} type="checkbox" aria-label={`选择文档：${title}`} checked={total > 0 && selected === total} onClick={(e) => { e.stopPropagation(); onChange(e); }} onChange={() => { /* Controlled via click so mouse/Space modifiers are retained. */ }} className="shrink-0 accent-[#9e2b25]" />;
}
