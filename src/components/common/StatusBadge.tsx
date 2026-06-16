/**
 * Status badge component
 * Displays status with color coding
 */

interface StatusBadgeProps {
  status: 'success' | 'warning' | 'error' | 'neutral' | 'loading';
  children: React.ReactNode;
  className?: string;
}

export function StatusBadge({ status, children, className = '' }: StatusBadgeProps) {
  const baseClasses = 'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium';

  const statusClasses = {
    success: 'bg-success/10 text-success border border-success/20',
    warning: 'bg-warning/10 text-warning border border-warning/20',
    error: 'bg-error/10 text-error border border-error/20',
    neutral: 'bg-bg-surface text-text-secondary border border-border-subtle',
    loading: 'bg-accent/10 text-accent border border-accent/20',
  };

  const dotColor = {
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    neutral: 'bg-text-tertiary',
    loading: 'bg-accent animate-pulse',
  };

  return (
    <span className={`${baseClasses} ${statusClasses[status]} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor[status]}`} />
      {children}
    </span>
  );
}
