/**
 * Button component - 中国风水墨按钮
 * 朱红印章色为主，水墨青为辅，宣纸底
 * 所有状态：默认/悬停/点击/禁用/加载
 */

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'seal';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
  ...props
}: ButtonProps) {
  const baseClasses = 'inline-flex items-center justify-center gap-2 rounded-md font-serif font-medium transition-all duration-fast focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed';

  const variantClasses = {
    primary: 'bg-seal text-white hover:bg-seal-2 active:bg-seal/90 shadow-sm',
    secondary: 'bg-paper text-ink border border-line hover:bg-card-bg hover:border-ink-faint active:bg-paper-2 shadow-sm',
    ghost: 'text-ink hover:bg-paper-2 active:bg-paper',
    danger: 'bg-seal-2 text-white hover:bg-seal active:bg-seal/90 shadow-sm',
    seal: 'bg-seal text-white hover:bg-seal-2 active:bg-seal/90 shadow-sm glow-seal',
  };

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm min-h-[32px]',
    md: 'px-4 py-2 text-md min-h-[38px]',
    lg: 'px-6 py-2.5 text-lg min-h-[44px]',
  };

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      )}
      {children}
    </button>
  );
}
