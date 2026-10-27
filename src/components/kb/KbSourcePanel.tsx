/**
 * KbSourcePanel —— 标准文档来源面板（KnowledgeView 右栏）
 *
 * 展示 KbDocDto.sources（§9.2）：标题、原始库相对路径、state 徽标
 * （current/changed/missing）。changed/missing 以警示呈现——标准文档
 * 可能已过时（§11.2）。点击来源 → 父级打开原始文档抽屉。
 */

import { AlertTriangle, FileSearch, Link2, FolderOpen } from 'lucide-react';
import { KB_SOURCE_STATE_LABEL } from '../../utils/agentReadiness';
import type { KbDocSourceRef } from '../../types/agent';

interface KbSourcePanelProps {
  docTitle: string;
  sources: KbDocSourceRef[];
  onOpenSource: (source: KbDocSourceRef) => void;
}

const STATE_BADGE: Record<string, string> = {
  current: 'bg-jade/10 text-jade border-jade/20',
  changed: 'bg-[rgba(180,83,9,0.10)] text-[#92580c] border-[rgba(180,83,9,0.35)]',
  missing: 'bg-seal-2/10 text-seal-2 border-seal-2/20',
  excluded: 'bg-paper-2 text-ink-faint border-line',
};

export function KbSourcePanel({ docTitle, sources, onOpenSource }: KbSourcePanelProps) {
  const stale = sources.filter((s) => s.state !== 'current').length;
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-line/60 shrink-0">
        <h3 className="text-sm font-kai font-medium text-ink flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5 text-jade" />
          来源追溯
        </h3>
        <p className="mt-1 text-[11px] leading-snug text-ink-faint">
          {sources.length} 个原始来源{stale > 0 ? ` · ${stale} 个已变动，正文可能过时` : ' · 均为当前版本'}
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-auto scrollbar-thin p-3 space-y-2">
        {sources.map((s) => (
          <button
            key={s.objToken}
            type="button"
            onClick={() => onOpenSource(s)}
            className="w-full text-left px-3 py-2.5 rounded-md border border-line/70 bg-card-bg hover:border-jade/40 hover:shadow-sm transition-all group"
            title={`打开原始文档：${s.relPath}`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs font-medium text-ink leading-snug break-all">{s.title || '未命名文档'}</span>
              <span
                className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border font-sans ${STATE_BADGE[s.state] ?? STATE_BADGE.current}`}
              >
                {s.state !== 'current' ? <AlertTriangle className="w-2.5 h-2.5" /> : null}
                {KB_SOURCE_STATE_LABEL[s.state] ?? s.state}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-ink-faint">
              <FolderOpen className="w-3 h-3 shrink-0" />
              <span className="truncate font-mono">{s.relPath}</span>
            </div>
            <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-faint opacity-0 group-hover:opacity-100 transition-opacity">
              <FileSearch className="w-3 h-3" />
              查看原始内容
            </div>
          </button>
        ))}
        {sources.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-ink-faint">该文档未声明来源</p>
        ) : null}
      </div>
      <div className="px-4 py-2.5 border-t border-line/60 shrink-0">
        <p className="text-[11px] text-ink-faint leading-snug">
          来源即追溯链：标准文档由 AI 依据上述来源生成，正文主张以来源原文为准（{docTitle.slice(0, 24)}
          {docTitle.length > 24 ? '…' : ''}）。
        </p>
      </div>
    </div>
  );
}
