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
    /** 透传给 Button：动作不可用时置灰（如跨入口共享的检测运行态）。 */
    disabled?: boolean;
  };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 sm:py-10 px-4 text-center">
      {icon && (
        <div className="text-ink-faint mb-3 p-3 rounded-full bg-paper border border-line">
          {icon}
        </div>
      )}
      <h3 className="text-base font-kai font-medium text-ink mb-2">{title}</h3>
      {description && (
        <p className="text-sm text-ink-soft max-w-md mb-3 leading-relaxed">{description}</p>
      )}
      {action && (
        <Button
          size="md"
          variant="secondary"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
