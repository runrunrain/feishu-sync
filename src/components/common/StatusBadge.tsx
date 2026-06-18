/**
 * Status badge component - 中国风水墨徽标
 * 统一状态视觉：success/warning/error/neutral/loading/seal
 * T5 R2.3 / 04 §6.5.1: 扩展 added/modified/deleted 三态变更徽章
 *   - added    = jade #6b8e8a (脉动)
 *   - modified = seal #9e2b25 (脉动)
 *   - deleted  = ink-faint #7d7668 (静态)
 * 字体改为 sans-ui 以提升小字号徽章的可读性（04 §6.2 决策）。
 */

type BadgeStatus =
  | 'success'
  | 'warning'
  | 'error'
  | 'neutral'
  | 'loading'
  | 'seal'
  | 'added'
  | 'modified'
  | 'deleted';

interface StatusBadgeProps {
  status: BadgeStatus;
  children: React.ReactNode;
  className?: string;
  size?: 'sm' | 'md';
  /** Hide the leading dot (used by change-state badges that already carry an icon). */
  hideDot?: boolean;
}

export function StatusBadge({
  status,
  children,
  className = '',
  size = 'md',
  hideDot = false,
}: StatusBadgeProps) {
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs gap-1',
    md: 'px-2.5 py-1 text-xs gap-1.5',
  };

  const dotSize = {
    sm: 'w-1 h-1',
    md: 'w-1.5 h-1.5',
  };

  // sans-ui per 04 §6.2: clearer at small sizes than serif.
  const baseClasses = `inline-flex items-center rounded-md font-sans-ui border ${sizeClasses[size]}`;

  const statusClasses: Record<BadgeStatus, string> = {
    success: 'bg-jade/10 text-jade border-jade/20',
    warning: 'bg-seal/10 text-seal border-seal/20',
    error: 'bg-seal-2/10 text-seal-2 border-seal-2/20',
    neutral: 'bg-paper text-ink-faint border-line',
    loading: 'bg-jade/10 text-jade border-jade/20',
    seal: 'bg-seal/10 text-seal border-seal/20',
    // 04 §6.5.1: change-state palette (reuses jade/seal/ink-faint).
    added: 'border-jade/20 text-jade',
    modified: 'border-seal/20 text-seal',
    deleted: 'border-[rgba(125,118,104,0.20)] text-ink-faint',
  };

  // added/modified need subtle bg tint for visual weight.
  if (status === 'added') statusClasses.added = 'bg-[rgba(107,142,138,0.10)] border-jade/20 text-jade';
  if (status === 'modified') statusClasses.modified = 'bg-[rgba(158,43,37,0.06)] border-seal/20 text-seal';
  if (status === 'deleted') statusClasses.deleted = 'bg-[rgba(125,118,104,0.08)] border-[rgba(125,118,104,0.20)] text-ink-faint';

  const dotColor: Record<BadgeStatus, string> = {
    success: 'bg-jade',
    warning: 'bg-seal',
    error: 'bg-seal-2',
    neutral: 'bg-ink-faint',
    loading: 'bg-jade animate-pulse',
    seal: 'bg-seal animate-pulse-seal',
    added: 'bg-jade animate-pulse',
    modified: 'bg-seal animate-pulse-seal',
    deleted: 'bg-ink-faint',
  };

  return (
    <span className={`${baseClasses} ${statusClasses[status]} ${className}`}>
      {!hideDot && (
        <span className={`rounded-sm ${dotSize[size]} ${dotColor[status]}`} />
      )}
      {children}
    </span>
  );
}
