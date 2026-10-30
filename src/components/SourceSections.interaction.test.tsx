// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { DocumentContent } from '../types';

vi.mock('../api/client', () => ({
  getDocumentComments: async (objToken: string) => ({
    objToken, collected: true, total: 1, truncated: false, updatedAt: '',
    comments: [{ commentRef: 'c1', text: `评论内容 ${objToken}`, quote: null, author: null, createdAtCloud: null, solved: null }],
  }),
}));
import { DocReferenceSection } from './DocReferenceSection';
import { SourceCommentsSection } from './SourceCommentsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('引用与评论独立展开收起，切换文档时恢复默认收起', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = async (token: string) => {
    const content: DocumentContent = {
      objToken: token, title: token, objType: 'docx', mdPath: `${token}.md`, mdContent: '', mdTruncated: false, csvTables: [],
      references: [{ direction: 'out', token: 'other', targetType: 'docx', origin: 'body', kind: 'link', title: `引用内容 ${token}`, occurrences: 1, objToken: 'other', localRelPath: 'other.md', synced: true }],
    };
    await act(async () => root.render(<>
      <DocReferenceSection key={`references-${token}`} content={content} />
      <SourceCommentsSection key={`comments-${token}`} objToken={token} />
    </>));
  };
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text))!;
  try {
    await render('a');
    expect(button('引用关系').getAttribute('aria-expanded')).toBe('false');
    expect(button('评论 1 条').getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('引用内容 a');
    expect(container.textContent).not.toContain('评论内容 a');
    await act(async () => button('评论 1 条').click());
    expect(button('评论 1 条').getAttribute('aria-expanded')).toBe('true');
    expect(button('引用关系').getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('评论内容 a');
    await act(async () => button('引用关系').click());
    expect(container.textContent).toContain('引用内容 a');
    await act(async () => button('评论 1 条').click());
    expect(container.textContent).not.toContain('评论内容 a');
    expect(container.textContent).toContain('引用内容 a');
    await act(async () => button('评论 1 条').click());
    await render('b');
    expect(button('引用关系').getAttribute('aria-expanded')).toBe('false');
    expect(button('评论 1 条').getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('引用内容 b');
    expect(container.textContent).not.toContain('评论内容 b');
  } finally { act(() => root.unmount()); container.remove(); }
});
