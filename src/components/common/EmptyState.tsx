/**
 * Empty state component - 宣纸风格空状态
 * 统一空状态视觉，层次分明
 */

import { Button } from './Button';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      {icon && (
        <div className="text-ink-faint mb-5 p-4 rounded-full bg-paper border border-line">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-kai font-medium text-ink mb-2">{title}</h3>
      {description && (
        <p className="text-sm text-ink-soft max-w-md mb-5 leading-relaxed">{description}</p>
      )}
      {action && (
        <Button
          size="md"
          variant="secondary"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
