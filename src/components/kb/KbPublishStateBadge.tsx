/**
 * KbPublishStateBadge —— 反向发布状态徽标（P1-S9）。
 *
 * 统一四个消费位的状态视觉：目录树（compact/click——行容器是 button，
 * 不能嵌套 a，改 span+onClick 开窗）、文档详情、发布计划/结果表与发布
 * 历史（full/anchor——云端 URL 渲染为真实链接，新开标签）。
 */

import { ExternalLink } from 'lucide-react';
import { publishStateMeta, TREE_BADGE_STATES } from '../../utils/kbPublish';

export interface KbPublishStateBadgeProps {
  state: string;
  /** 窄场景（目录树行内）用短标签。 */
  compact?: boolean;
  /** 提供云端 URL 时渲染跳转（anchor=真实链接；click=span+开窗，用于嵌套 button 场景）。 */
  cloudUrl?: string | null;
  /** cloudUrl 的渲染形态；默认 anchor。 */
  linkVariant?: 'anchor' | 'click';
  /** 树上默认只显示四态（published/警告/冲突/未知）；显式显示全部状态。 */
  showAllStates?: boolean;
}

export function KbPublishStateBadge({
  state,
  compact = false,
  cloudUrl,
  linkVariant = 'anchor',
  showAllStates = false,
}: KbPublishStateBadgeProps) {
  if (!showAllStates && !TREE_BADGE_STATES.has(state)) return null;
  const meta = publishStateMeta(state);
  const label = compact ? meta.short : meta.label;
  const withIcon = (
    <>
      {label}
      {cloudUrl ? <ExternalLink className="w-2.5 h-2.5 shrink-0" aria-hidden="true" /> : null}
    </>
  );
  const className = `inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[10px] leading-4 ${toneClasses(meta.tone)}`;
  if (cloudUrl && linkVariant === 'click') {
    return (
      <span
        role="link"
        tabIndex={0}
        data-publish-state={state}
        title={`打开云端文档：${cloudUrl}`}
        onClick={(event) => {
          event.stopPropagation();
          window.open(cloudUrl, '_blank', 'noopener');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
            window.open(cloudUrl, '_blank', 'noopener');
          }
        }}
        className={`cursor-pointer hover:opacity-75 transition-opacity ${className}`}
      >
        {withIcon}
      </span>
    );
  }
  if (cloudUrl) {
    return (
      <a
        href={cloudUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-publish-state={state}
        aria-label={`${label}，打开云端文档`}
        className={`hover:opacity-75 transition-opacity ${className}`}
      >
        {withIcon}
      </a>
    );
  }
  return (
    <span data-publish-state={state} className={className}>
      {label}
    </span>
  );
}

function toneClasses(tone: string): string {
  switch (tone) {
    case 'success':
      return 'border-jade/40 bg-jade/5 text-jade';
    case 'warning':
      return 'border-[#b8860b]/40 bg-[#b8860b]/5 text-[#8a6508]';
    case 'error':
      return 'border-seal-2/40 bg-seal-2/5 text-seal-2';
    case 'loading':
      return 'border-line bg-paper text-ink-soft';
    default:
      return 'border-line bg-paper text-ink-faint';
  }
}
