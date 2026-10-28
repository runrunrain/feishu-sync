/**
 * DocReferenceSection —— 文档详情的「引用 / 被引用」折叠区（P1 §2.4 UI）
 *
 * 消费 GET /api/mapping/content 的 references（出边，P1-S4）与
 * referencedBy（入边，P1-S3）：标题 + 方向 + 类型的最小列表；
 * 未解析到本地文档的出边目标标「未纳入同步」。两侧皆空时不渲染。
 */

import { useState } from 'react';
import { ArrowUpRight, ArrowDownLeft, ChevronRight } from 'lucide-react';
import type { DocumentContent } from '../types';

const TYPE_LABEL: Record<string, string> = {
  docx: '文档',
  wiki: '文档',
  sheet: '表格',
  bitable: '多维表格',
  slides: '幻灯片',
  mindnote: '思维笔记',
  file: '文件',
  unknown: '未知',
};

function typeLabel(targetType: string): string {
  return TYPE_LABEL[targetType] ?? targetType;
}

export function DocReferenceSection({ content, defaultOpen = false }: { content: DocumentContent; defaultOpen?: boolean }) {
  const out = content.references ?? [];
  const incoming = content.referencedBy ?? [];
  const [open, setOpen] = useState(defaultOpen);
  if (out.length === 0 && incoming.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-line/60 bg-paper/40 px-4 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11px] font-sans-ui text-ink-soft hover:text-ink"
      >
        <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        引用关系
        <span className="text-ink-faint">
          （引用 {out.length} · 被引用 {incoming.length}）
        </span>
      </button>
      {open ? (
        <div className="mt-2 max-h-44 space-y-3 overflow-y-auto scrollbar-thin">
          {out.length > 0 ? (
            <div>
              <p className="mb-1 text-[11px] text-ink-faint">本文档引用</p>
              <ul className="space-y-1" aria-label="出边引用列表">
                {out.map((ref, i) => (
                  <li key={`${ref.token}-${ref.kind}-${i}`} className="flex items-center gap-1.5 text-[11px] leading-relaxed">
                    <ArrowUpRight className="w-3 h-3 shrink-0 text-seal/70" aria-hidden />
                    <span className="min-w-0 truncate text-ink-soft" title={ref.title ?? ref.token}>
                      {ref.title ?? ref.token}
                    </span>
                    <span className="shrink-0 text-ink-faint">{typeLabel(ref.targetType)}</span>
                    {ref.objToken == null || !ref.synced ? (
                      <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-ink-faint">未纳入同步</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {incoming.length > 0 ? (
            <div>
              <p className="mb-1 text-[11px] text-ink-faint">引用本文档</p>
              <ul className="space-y-1" aria-label="被引用列表">
                {incoming.map((ref, i) => (
                  <li key={`${ref.srcObjToken}-${ref.kind}-${i}`} className="flex items-center gap-1.5 text-[11px] leading-relaxed">
                    <ArrowDownLeft className="w-3 h-3 shrink-0 text-seal/70" aria-hidden />
                    <span className="min-w-0 truncate text-ink-soft" title={ref.srcTitle ?? ref.srcObjToken}>
                      {ref.srcTitle ?? ref.srcObjToken}
                    </span>
                    <span className="shrink-0 text-ink-faint">{typeLabel(ref.targetType)}</span>
                    {ref.srcLocalRelPath == null ? (
                      <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-ink-faint">源已删除</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
