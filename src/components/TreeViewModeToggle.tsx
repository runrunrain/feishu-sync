/**
 * Shared view-mode selector for both sides of the dashboard tree.
 *
 * The selector must live in both the Feishu and local tree headers. The
 * dashboard swaps those components on mode change, so leaving it only in
 * NodeTreeView made the local mode a dead end with no way back.
 */

import { Cloud, FolderTree } from 'lucide-react';

export type TreeViewMode = 'feishu' | 'local';

interface TreeViewModeToggleProps {
  view: TreeViewMode;
  onViewChange: (view: TreeViewMode) => void;
}

export function TreeViewModeToggle({ view, onViewChange }: TreeViewModeToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="节点树视图"
      className="inline-flex items-center rounded-md border border-line bg-paper p-0.5 text-xs font-sans-ui"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === 'feishu'}
        onClick={() => onViewChange('feishu')}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[5px] transition-colors ${
          view === 'feishu'
            ? 'bg-seal text-white shadow-sm'
            : 'text-ink-soft hover:text-ink'
        }`}
      >
        <Cloud className="w-3.5 h-3.5" />
        飞书视图
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'local'}
        onClick={() => onViewChange('local')}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[5px] transition-colors ${
          view === 'local'
            ? 'bg-seal text-white shadow-sm'
            : 'text-ink-soft hover:text-ink'
        }`}
      >
        <FolderTree className="w-3.5 h-3.5" />
        本地视图
      </button>
    </div>
  );
}
