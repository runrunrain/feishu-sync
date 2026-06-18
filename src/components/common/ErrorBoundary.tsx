/**
 * ErrorBoundary - 全局渲染错误边界（T9 R2.6-AC1）
 *
 * 捕获 React 渲染期异常，显示「应用出错」重试 UI。
 * 完整错误（message + stack）经 appLogger 写入应用日志，UI 仅显示
 * 简短摘要（决策4：不展开堆栈）。
 *
 * 注意：错误边界不捕获事件回调、异步错误、SSR 错误——这些由各自
 * 的 try/catch + useToast().push 处理。
 */

import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { appLogger } from '../../utils/appLogger';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || '未知错误' };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 决策4：完整堆栈入日志，UI 仅显示摘要。
    appLogger.error('render', error?.message || '渲染异常', {
      stack: error?.stack,
      componentStack: info?.componentStack,
    });
  }

  private handleReload = () => {
    // 重置状态并触发刷新；先 reset 以便重新挂载时干净。
    this.setState({ hasError: false, message: '' });
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-paper p-6">
        <div className="max-w-md w-full bg-card-bg border border-seal/30 rounded-md shadow-md p-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-seal/10 mb-4">
            <AlertTriangle className="w-6 h-6 text-seal" />
          </div>
          <h2 className="text-lg font-kai font-medium text-ink mb-2">应用出错</h2>
          <p className="text-sm text-ink-soft mb-1">渲染异常，请尝试刷新应用。</p>
          <p className="text-xs text-ink-faint mb-4 break-all font-sans-ui">
            {this.state.message}
          </p>
          <p className="text-xs text-ink-faint mb-4">错误详情见日志。</p>
          <button
            type="button"
            onClick={this.handleReload}
            className="inline-flex items-center justify-center px-4 py-2 rounded-md bg-seal text-white text-sm font-sans-ui hover:bg-seal-2 transition-colors"
          >
            刷新应用
          </button>
        </div>
      </div>
    );
  }
}
