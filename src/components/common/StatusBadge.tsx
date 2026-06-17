/**
 * Status badge component - 中国风水墨徽标
 * 统一状态视觉：success/warning/error/loading/seal
 * 水墨青为主，朱红印章色为强调
 */

interface StatusBadgeProps {
  status: 'success' | 'warning' | 'error' | 'neutral' | 'loading' | 'seal';
  children: React.ReactNode;
  className?: string;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, children, className = '', size = 'md' }: StatusBadgeProps) {
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs gap-1',
    md: 'px-2.5 py-1 text-xs gap-1.5',
  };

  const dotSize = {
    sm: 'w-1 h-1',
    md: 'w-1.5 h-1.5',
  };

  const baseClasses = `inline-flex items-center rounded-md font-serif border ${sizeClasses[size]}`;

  const statusClasses = {
    success: 'bg-jade/10 text-jade border-jade/20',
    warning: 'bg-seal/10 text-seal border-seal/20',
    error: 'bg-seal-2/10 text-seal-2 border-seal-2/20',
    neutral: 'bg-paper text-ink-faint border-line',
    loading: 'bg-jade/10 text-jade border-jade/20',
    seal: 'bg-seal/10 text-seal border-seal/20',
  };

  const dotColor = {
    success: 'bg-jade',
    warning: 'bg-seal',
    error: 'bg-seal-2',
    neutral: 'bg-ink-faint',
    loading: 'bg-jade animate-pulse',
    seal: 'bg-seal animate-pulse-seal',
  };

  return (
    <span className={`${baseClasses} ${statusClasses[status]} ${className}`}>
      <span className={`rounded-sm ${dotSize[size]} ${dotColor[status]}`} />
      {children}
    </span>
  );
}
