/**
 * SourceCommentsSection 组件测试（P2-S4）
 *
 * SSR + 纯函数锚定（SourceEditControls.test.tsx 同法：effects 不跑，
 * 数据态经纯展示 SourceCommentsList 锚定；容器异步流由 server 侧测试与
 * 真机浏览器验证覆盖）：
 *   - commentsHeaderLabel：n 条 / 截断「（可能不完整）」
 *   - 列表渲染：作者/时间/已解决徽章/划词引用/正文/空态
 *   - SSR 初始渲染：effects 不跑 → 容器输出为空（不闪评论区骨架）
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ getDocumentComments: vi.fn() }));
import {
  SourceCommentsSection,
  SourceCommentsList,
  commentsHeaderLabel,
} from './SourceCommentsSection';
import type { DocumentComments } from '../types';

function makeComments(overrides: Partial<DocumentComments> = {}): DocumentComments {
  return {
    objToken: 'doxcnComments00001',
    collected: true,
    total: 0,
    truncated: false,
    updatedAt: '2026-10-28T10:00:00.000Z',
    comments: [],
    ...overrides,
  };
}

describe('commentsHeaderLabel（设计 §5.1 文案）', () => {
  it('无截断：评论 2 条', () => {
    expect(commentsHeaderLabel({ total: 2, truncated: false })).toBe('评论 2 条');
  });

  it('截断：评论 3 条（可能不完整）', () => {
    expect(commentsHeaderLabel({ total: 3, truncated: true })).toBe('评论 3 条（可能不完整）');
  });

  it('零评论：评论 0 条（已采集、无截断提示）', () => {
    expect(commentsHeaderLabel({ total: 0, truncated: false })).toBe('评论 0 条');
  });
});

describe('SourceCommentsList 渲染', () => {
  it('完整评论：作者/时间/已解决/划词引用/正文', () => {
    const markup = renderToStaticMarkup(
      <SourceCommentsList
        data={makeComments({
          total: 2,
          comments: [
            {
              commentRef: 'c1',
              text: '这里的上限按自然日还是 24 小时滚动？',
              quote: '每日上限 3 次',
              author: '张三',
              createdAtCloud: '2026-09-12T08:21:00Z',
              solved: false,
            },
            {
              commentRef: 'c2',
              text: '已确认按自然日。',
              quote: null,
              author: '李四',
              createdAtCloud: null,
              solved: true,
            },
          ],
        })}
      />,
    );
    expect(markup).toContain('评论 2 条');
    expect(markup).not.toContain('可能不完整');
    expect(markup).toContain('张三');
    expect(markup).toContain('2026-09-12T08:21:00Z');
    expect(markup).toContain('每日上限 3 次');
    expect(markup).toContain('这里的上限按自然日还是 24 小时滚动？');
    expect(markup).toContain('未解决');
    expect(markup).toContain('已解决');
    expect(markup).toContain('李四');
    expect(markup).toContain('已确认按自然日。');
  });

  it('截断标注：truncated=true → 头部含「可能不完整」', () => {
    const markup = renderToStaticMarkup(
      <SourceCommentsList data={makeComments({ total: 50, truncated: true })} />,
    );
    expect(markup).toContain('评论 50 条（可能不完整）');
    expect(markup).toContain('暂无评论');
  });

  it('字段缺失容错：未知作者占位、无时间/解决态省略', () => {
    const markup = renderToStaticMarkup(
      <SourceCommentsList
        data={makeComments({
          total: 1,
          comments: [{
            commentRef: 'c1',
            text: '正文',
            quote: null,
            author: null,
            createdAtCloud: null,
            solved: null,
          }],
        })}
      />,
    );
    expect(markup).toContain('未知作者');
    expect(markup).not.toContain('已解决');
    expect(markup).not.toContain('未解决');
  });

  it('多行正文保留换行（whitespace-pre-wrap）', () => {
    const markup = renderToStaticMarkup(
      <SourceCommentsList
        data={makeComments({
          total: 1,
          comments: [{
            commentRef: 'c1',
            text: '第一行\n第二行',
            quote: null,
            author: null,
            createdAtCloud: null,
            solved: null,
          }],
        })}
      />,
    );
    expect(markup).toContain('whitespace-pre-wrap');
    expect(markup).toContain('第一行');
    expect(markup).toContain('第二行');
  });
});

describe('SourceCommentsSection 容器（SSR 初始态）', () => {
  it('effects 不跑：初始渲染输出为空（不闪骨架/错误）', () => {
    const markup = renderToStaticMarkup(<SourceCommentsSection objToken="doxcnComments00001" />);
    expect(markup).toBe('');
  });
});
