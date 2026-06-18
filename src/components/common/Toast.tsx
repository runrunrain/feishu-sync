/**
 * Toast - 全局轻量反馈层（T9 R2.6-AC2/AC3）
 *
 * 决策4：Toast 不展开堆栈；错误完整堆栈经 appLogger 写入应用日志，
 * Toast 仅显示用户可读摘要 + "错误详情见日志" 引导。
 *
 * 4 类型：success(3s) / error(5s) / warning(4s) / info(3s)。
 * 右下角堆叠，最多 3 条（超出最旧的自动消失）。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import type { ToastMessage, ToastType } from '../../types';
import { appLogger } from '../../utils/appLogger';

const MAX_VISIBLE = 3;

const DURATION_BY_TYPE: Record<ToastType, number> = {
  success: 3000,
  info: 3000,
  warning: 4000,
  error: 5000,
};

interface ToastContextValue {
  toasts: ToastMessage[];
  push: (toast: Omit<ToastMessage, 'id'>) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast: Omit<ToastMessage, 'id'>): string => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const next: ToastMessage = {
        id,
        durationMs: toast.durationMs ?? DURATION_BY_TYPE[toast.type],
        ...toast,
      };
      setToasts((prev) => {
        const merged = [...prev, next];
        // 决策：堆叠最多 3 条，超出最旧的丢弃。
        if (merged.length > MAX_VISIBLE) {
          const dropped = merged.slice(0, merged.length - MAX_VISIBLE);
          for (const d of dropped) {
            const t = timers.current.get(d.id);
            if (t) {
              clearTimeout(t);
              timers.current.delete(d.id);
            }
          }
          return merged.slice(merged.length - MAX_VISIBLE);
        }
        return merged;
      });

      // Auto-dismiss timer.
      const dur = next.durationMs ?? DURATION_BY_TYPE[next.type];
      if (dur > 0) {
        const timer = setTimeout(() => dismiss(id), dur);
        timers.current.set(id, timer);
      }

      // 决策4: 错误同时入应用日志（完整堆栈在调用方通过 hint 传入）。
      if (next.type === 'error' || next.type === 'warning') {
        appLogger[next.type === 'error' ? 'error' : 'warn'](
          'toast',
          next.message,
          next.hint,
        );
      } else {
        appLogger.info('toast', next.message);
      }

      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within <ToastProvider>');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

const ICON_BY_TYPE: Record<ToastType, ReactNode> = {
  success: <CheckCircle className="w-4 h-4 text-jade" />,
  error: <AlertCircle className="w-4 h-4 text-seal-2" />,
  warning: <AlertTriangle className="w-4 h-4 text-seal" />,
  info: <Info className="w-4 h-4 text-ink-soft" />,
};

const BORDER_BY_TYPE: Record<ToastType, string> = {
  success: 'border-jade/30',
  error: 'border-seal-2/40',
  warning: 'border-seal/40',
  info: 'border-line',
};

const BG_BY_TYPE: Record<ToastType, string> = {
  success: 'bg-card-bg',
  error: 'bg-card-bg',
  warning: 'bg-card-bg',
  info: 'bg-card-bg',
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed bottom-6 right-6 z-[400] flex flex-col gap-2 max-w-[360px]"
      role="region"
      aria-label="通知"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-toast-in flex items-start gap-2 rounded-md border shadow-md px-3 py-2.5 ${BG_BY_TYPE[t.type]} ${BORDER_BY_TYPE[t.type]}`}
          role={t.type === 'error' ? 'alert' : 'status'}
        >
          <div className="shrink-0 mt-0.5">{ICON_BY_TYPE[t.type]}</div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-ink font-sans-ui leading-snug break-words">
              {t.message}
            </p>
            {t.hint && (
              <p className="text-xs text-ink-faint mt-0.5 font-sans-ui">
                {t.hint}
              </p>
            )}
            {t.type === 'error' && !t.hint && (
              <p className="text-xs text-ink-faint mt-0.5 font-sans-ui">
                错误详情见日志
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            className="shrink-0 text-ink-faint hover:text-ink transition-colors"
            aria-label="关闭通知"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
