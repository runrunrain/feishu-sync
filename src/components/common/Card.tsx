/**
 * Card component - 宣纸风格卡片
 * 饱满布局，水墨风格，柔和阴影
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
    <div className={`${variantClasses[variant]} rounded-lg ${className} relative overflow-hidden`}>
      {/* 角落水墨晕染装饰（仅在 elevated 时显示） */}
      {variant === 'elevated' && (
        <div className="absolute -top-12 -left-12 w-24 h-24 bg-jade/8 rounded-full blur-xl pointer-events-none" />
      )}
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
    <div className={`px-5 py-4 border-b border-line ${className}`}>
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
    <div className={`p-5 ${className}`}>
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
    <div className={`px-5 py-4 border-t border-line ${className}`}>
      {children}
    </div>
  );
}
