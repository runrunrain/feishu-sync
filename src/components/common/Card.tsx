/**
 * Card component - 宣纸风格卡片
 * T1 R2.5-AC1/AC2: corner-blur decoration removed; rounded-md (6px) unified;
 * softened shadows (theme.css shadow-sm/md/lg).
 *
 * 布局重构（2026-06-19）：
 *   - Card padding 5→6（20→24px），与外部 section spacing（space-y-6）匹配
 *   - CardHeader px-5→px-6, py-4→py-4 + 增加底部留白
 *   - 建立清晰的"外部呼吸(24px) > 卡片内边距(24px) > 元素组间距(16px)"层次
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
    <div className={`px-6 py-4 border-b border-line ${className}`}>
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
    <div className={`p-6 ${className}`}>
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
    <div className={`px-6 py-4 border-t border-line ${className}`}>
      {children}
    </div>
  );
}
