/**
 * KbBuildPanel —— 构建进度面板（KnowledgeView 底部抽屉）
 *
 * 数据源：GET /api/kb/builds/:id 轮询 + SSE 事件（§9.2）：
 *   build_status（阶段推进）、build_log（分级日志）、tool（工具调用行）、
 *   assistant_delta（模型说明文字，非文档正文）。
 * 失败态：error.code 中文 + 校验 issues 列表 + 「当前发布版本未变化」
 * 明示（原子发布契约 §6.5：任何失败不移动 CURRENT 指针）。
 */

import { useEffect, useRef } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDot,
  Info,
  Loader2,
  Square,
  Wrench,
} from 'lucide-react';
import { Button } from '../common/Button';
import { KB_BUILD_ACTIVE_STEPS, KB_BUILD_STATUS_LABEL } from '../../utils/agentReadiness';
import type { KbBuildDto, KbBuildIssue } from '../../types/agent';

export interface BuildLogLine {
  id: number;
  kind: 'info' | 'warn' | 'error' | 'tool-start' | 'tool-end' | 'assistant';
  text: string;
  at?: string;
}

interface KbBuildPanelProps {
  open: boolean;
  build: KbBuildDto | null;
  issues: KbBuildIssue[];
  logs: BuildLogLine[];
  onCollapse: () => void;
  onCancel: () => void;
  cancelling: boolean;
  layout?: 'bottom' | 'sidebar';
}

const STEP_LABEL: Record<string, string> = {
  queued: '排队',
  preflight: '预检',
  running: '生成',
  validating: '校验',
  publishing: '发布',
};

const TERMINAL_STATUSES = new Set(['published', 'failed', 'cancelled', 'interrupted']);

export function KbBuildPanel({
  open,
  build,
  issues,
  logs,
  onCollapse,
  onCancel,
  cancelling,
  layout = 'bottom',
}: KbBuildPanelProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

  // 新日志到达时贴底滚动（用户上翻查看历史时不打扰：简单实现——仅当接近底部时贴底）。
  useEffect(() => {
    const el = logEndRef.current?.parentElement;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
      logEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [logs.length]);

  if (!open || !build) return null;

  const isTerminal = TERMINAL_STATUSES.has(build.status);
  const stepIndex = KB_BUILD_ACTIVE_STEPS.indexOf(build.status as (typeof KB_BUILD_ACTIVE_STEPS)[number]);
  const failed = build.status === 'failed';
  const batchTotal = build.progress.batchTotal;
  const batchIndex = build.progress.batchIndex;

  return (
    <section
      className={`${layout === 'sidebar' ? 'flex-1 min-h-0' : 'shrink-0 h-[240px] min-h-[180px] border-t border-line'} bg-card-bg flex flex-col animate-fade-in`}
      aria-label="标准库构建进度"
      data-build-status={build.status}
    >
      {/* 头部：状态 + 进度 + 操作 */}
      <header className="flex items-center flex-wrap gap-2 px-3 py-2 border-b border-line/60 shrink-0">
        <span
          className={`inline-flex items-center gap-1.5 text-sm font-kai font-medium ${
            failed ? 'text-seal-2' : build.status === 'published' ? 'text-jade' : 'text-ink'
          }`}
        >
          {!isTerminal ? <Loader2 className="w-4 h-4 animate-spin text-seal" /> : null}
          {failed ? <AlertCircle className="w-4 h-4" /> : null}
          {build.status === 'published' ? <Check className="w-4 h-4" /> : null}
          {build.status === 'cancelled' || build.status === 'interrupted' ? (
            <Square className="w-3.5 h-3.5 text-ink-faint" />
          ) : null}
          构建 · {KB_BUILD_STATUS_LABEL[build.status] ?? build.status}
        </span>
        <span className="text-[10px] text-ink-faint font-mono truncate max-w-full" title={build.id}>{build.id}</span>

        {!isTerminal && batchTotal > 0 ? (
          <span className="text-xs text-ink-soft">
            批次 {Math.min(batchIndex + 1, batchTotal)}/{batchTotal}
          </span>
        ) : null}
        {!isTerminal && batchTotal > 0 ? (
          <div className="flex-1 max-w-[280px] h-1.5 rounded-full bg-paper-2 overflow-hidden">
            <div
              className="h-full bg-seal/70 transition-all duration-500"
              style={{ width: `${Math.round(((batchIndex + 1) / batchTotal) * 100)}%` }}
            />
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {isTerminal ? (
          <span className="text-[11px] text-ink-faint">
            {build.counts.docsWritten > 0 ? `写入 ${build.counts.docsWritten} 篇` : ''}
            {build.counts.docsDeleted > 0 ? ` · 删除 ${build.counts.docsDeleted} 篇` : ''}
          </span>
        ) : null}

        {!isTerminal ? (
          <Button size="sm" variant="secondary" onClick={onCancel} loading={cancelling}>
            取消构建
          </Button>
        ) : null}
        <button
          type="button"
          onClick={onCollapse}
          className="text-ink-faint hover:text-ink transition-colors p-1"
          aria-label="收起构建面板"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      </header>

      {/* 阶段 stepper（终态定格在失败阶段/完成态） */}
      {!failed ? (
        <div className={`flex items-center gap-1 px-4 py-1.5 shrink-0 ${layout === 'sidebar' ? 'flex-wrap gap-y-2' : 'overflow-x-auto scrollbar-thin'}`}>
          {KB_BUILD_ACTIVE_STEPS.map((step, i) => {
            const active = step === build.status;
            const passed =
              (build.status === 'published' || i < stepIndex) && build.status !== 'cancelled';
            return (
              <div key={step} className="flex items-center gap-1 shrink-0">
                {i > 0 ? <span className={`w-4 h-px ${passed || active ? 'bg-jade/50' : 'bg-line'}`} /> : null}
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
                    active
                      ? 'bg-[rgba(158,43,37,0.08)] text-seal font-medium'
                      : passed
                        ? 'text-jade'
                        : 'text-ink-faint'
                  }`}
                >
                  {active ? <CircleDot className="w-3 h-3 animate-pulse" /> : passed ? <Check className="w-3 h-3" /> : null}
                  {STEP_LABEL[step]}
                </span>
              </div>
            );
          })}
          {build.status === 'published' ? (
            <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-jade font-medium">
              <Check className="w-3 h-3" />
              {build.noChanges ? '无变更，未新建发布' : '已发布'}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* 失败态：错误 + issues + 「当前发布版本未变」 */}
      {failed ? (
        <div className="px-4 py-2 shrink-0 border-b border-line/60 bg-[rgba(192,57,43,0.04)]">
          <p className="text-xs text-seal-2 leading-relaxed">
            构建失败{build.error ? `（${build.error.code}）：${build.error.message}` : ''}。
            <span className="text-ink-soft">当前已发布的标准库版本未受影响，仍可正常阅读。</span>
          </p>
          {issues.length > 0 ? (
            <ul className="mt-1.5 space-y-1 max-h-[72px] overflow-auto scrollbar-thin">
              {issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px] text-ink-soft leading-snug">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-seal" />
                  <span>
                    {issue.path || issue.objToken ? (
                      <span className="font-mono text-ink">{issue.path ?? issue.objToken}：</span>
                    ) : null}
                    {issue.message}
                    <span className="text-ink-faint">（{issue.code}）</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* 日志流 */}
      <div className="flex-1 min-h-0 overflow-auto scrollbar-thin px-4 py-2 space-y-0.5">
        {logs.length === 0 ? (
          <p className="text-[11px] text-ink-faint">{isTerminal ? '当前会话无实时日志；已发布内容的变化可在变更记录中查看。' : '等待构建事件…'}</p>
        ) : (
          logs.map((line) => <BuildLogRow key={line.id} line={line} />)
        )}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}

function BuildLogRow({ line }: { line: BuildLogLine }) {
  if (line.kind === 'assistant') {
    return (
      <p className="text-[11px] leading-relaxed text-ink-soft whitespace-pre-wrap border-l-2 border-jade/40 pl-2">
        {line.text}
      </p>
    );
  }
  if (line.kind === 'tool-start' || line.kind === 'tool-end') {
    const isError = line.kind === 'tool-end' && line.text.startsWith('✕');
    return (
      <p className="flex items-start gap-1.5 text-[11px] leading-snug text-ink-soft">
        {line.kind === 'tool-start' ? (
          <Loader2 className="w-3 h-3 mt-0.5 shrink-0 animate-spin text-jade" />
        ) : isError ? (
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0 text-seal-2" />
        ) : (
          <Check className="w-3 h-3 mt-0.5 shrink-0 text-jade" />
        )}
        <Wrench className="w-3 h-3 mt-0.5 shrink-0 text-ink-faint" />
        <span className="font-mono">{line.text}</span>
      </p>
    );
  }
  const color =
    line.kind === 'error' ? 'text-seal-2' : line.kind === 'warn' ? 'text-seal' : 'text-ink-faint';
  const Icon = line.kind === 'error' || line.kind === 'warn' ? AlertTriangle : Info;
  return (
    <p className={`flex items-start gap-1.5 text-[11px] leading-snug ${color}`}>
      <Icon className="w-3 h-3 mt-0.5 shrink-0" />
      <span className="whitespace-pre-wrap break-all">{line.text}</span>
    </p>
  );
}
