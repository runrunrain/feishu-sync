/**
 * SourceCommentsSection - 文档评论区（P2-S4 评论溯源，只读列表）
 *
 * 预览面板（DocPreviewPanel）底部评论区：显示「评论 n 条（可能不完整）」
 * 与同步时采集的飞书评论列表（作者/内容/时间/已解决/划词原文）。
 *
 * 数据契约（GET /api/mapping/comments/:objToken，设计 §5.1）：
 *   - collected=false（从未采集：非 docx 或未成功同步过）→ 整体不渲染；
 *   - truncated=true（云端 comments.tips 截断）→ 标题显示「可能不完整」，
 *     不尝试补全（设计裁定：逐文档分页补全代价与同步等同）。
 *
 * 只读组件：无回复/解决入口（设计 §5.1「评论写操作不提供」）。
 */

import { useEffect, useState } from 'react';
import { MessageSquare, CheckCircle2, Circle } from 'lucide-react';
import { getDocumentComments } from '../api/client';
import { appLogger } from '../utils/appLogger';
import type { DocumentComments } from '../types';

interface SourceCommentsSectionProps {
  objToken: string;
}

/** 头部文案：n 条 + 截断提示（「评论 3 条（可能不完整）」，设计 §5.1）。 */
export function commentsHeaderLabel(data: Pick<DocumentComments, 'total' | 'truncated'>): string {
  return `评论 ${data.total} 条${data.truncated ? '（可能不完整）' : ''}`;
}

export function SourceCommentsSection({ objToken }: SourceCommentsSectionProps) {
  const [data, setData] = useState<DocumentComments | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setLoading(true);
    getDocumentComments(objToken)
      .then((result) => {
        if (cancelled) return;
        setData(result);
      })
      .catch((err) => {
        if (cancelled) return;
        appLogger.error('source-comments', 'getDocumentComments failed', err);
        setError(err instanceof Error ? err.message : '评论加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [objToken]);

  // 加载失败不吞：评论区是溯源辅助信息，失败显示一行错误、不阻断预览。
  if (error) {
    return (
      <div className="shrink-0 border-t border-line/60 bg-paper/40 px-4 py-2">
        <p className="text-[11px] text-ink-faint font-sans-ui">评论加载失败：{error}</p>
      </div>
    );
  }
  if (loading || !data) return null;
  // 从未采集（非 docx 或未成功同步过）→ 不渲染（与「没有评论」区分）。
  if (!data.collected) return null;

  return <SourceCommentsList data={data} />;
}

/**
 * 纯展示列表（SSR 可锚定，SourceEditControls.test 同法）：已采集数据 →
 * 头部「评论 n 条（可能不完整）」+ 逐条评论（作者/时间/已解决/划词/正文）。
 */
export function SourceCommentsList({ data }: { data: DocumentComments }) {
  return (
    <div className="shrink-0 border-t border-line/60 bg-paper/40" data-testid="source-comments-section">
      <div className="flex items-center gap-1.5 px-4 pt-2 pb-1">
        <MessageSquare className="w-3 h-3 text-ink-faint" />
        <p className="text-[11px] text-ink-soft font-sans-ui font-medium">
          {commentsHeaderLabel(data)}
        </p>
      </div>
      <div className="max-h-56 overflow-y-auto scrollbar-thin px-4 pb-2.5 space-y-2">
        {data.comments.length === 0 ? (
          <p className="text-[11px] text-ink-faint font-sans-ui py-1">暂无评论</p>
        ) : (
          data.comments.map((comment) => (
            <div
              key={comment.commentRef}
              className="rounded-sm border border-line/50 bg-card-bg px-3 py-2"
              data-testid={`source-comment-${comment.commentRef}`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-sans-ui">
                <span className="text-ink-soft font-medium">
                  {comment.author ?? '未知作者'}
                </span>
                {comment.createdAtCloud && (
                  <span className="text-ink-faint">{comment.createdAtCloud}</span>
                )}
                {comment.solved === true && (
                  <span className="inline-flex items-center gap-0.5 text-seal">
                    <CheckCircle2 className="w-3 h-3" />已解决
                  </span>
                )}
                {comment.solved === false && (
                  <span className="inline-flex items-center gap-0.5 text-ink-faint">
                    <Circle className="w-3 h-3" />未解决
                  </span>
                )}
              </div>
              {comment.quote && (
                <blockquote className="mt-1 border-l-2 border-line pl-2 text-[11px] text-ink-faint font-sans-ui">
                  {comment.quote}
                </blockquote>
              )}
              <p className="mt-1 text-xs text-ink leading-relaxed font-sans-ui whitespace-pre-wrap break-words">
                {comment.text}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
