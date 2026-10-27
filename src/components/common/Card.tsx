/**
 * Card component - 宣纸风格卡片
 * T1 R2.5-AC1/AC2: corner-blur decoration removed; rounded-md (6px) unified;
 * softened shadows (theme.css shadow-sm/md/lg).
 *
 * 卡片使用 16px 内边距，标题与操作区使用 12px 纵向间距。
 */

interface CardProps {
  children: React.ReactNode;
  className?: string;
  variant?: 'default' | 'elevated' | 'sunken';
}

export function Card({ children, className = '', variant = 'default' }: CardProps) {
  const variantClasses = {
    default: 'bg-card-bg border border-line shadow-sm',
    elevated: 'bg-card-bg border border-line shadow-md',
    sunken: 'bg-paper-2 border border-line',
  };

  return (
    <div className={`${variantClasses[variant]} rounded-md ${className}`}>
      {children}
    </div>
  );
}

interface CardHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function CardHeader({ children, className = '' }: CardHeaderProps) {
  return (
    <div className={`px-4 py-3 border-b border-line ${className}`}>
      {children}
    </div>
  );
}

interface CardBodyProps {
  children: React.ReactNode;
  className?: string;
}

export function CardBody({ children, className = '' }: CardBodyProps) {
  return (
    <div className={`p-4 ${className}`}>
      {children}
    </div>
  );
}

interface CardFooterProps {
  children: React.ReactNode;
  className?: string;
}

export function CardFooter({ children, className = '' }: CardFooterProps) {
  return (
    <div className={`px-4 py-3 border-t border-line ${className}`}>
      {children}
    </div>
  );
}
