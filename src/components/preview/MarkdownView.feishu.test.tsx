// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { MarkdownView } from './MarkdownView';

const api = vi.hoisted(() => ({ getSyncedReference: vi.fn(), getMediaBlobUrl: vi.fn() }));
vi.mock('../../api/client', () => api);
const sample = '<title>200-系统框架&amp;数据结构</title>\n\n正文\n<synced_reference src-block-id="Block1" src-token="Source1"></synced_reference>\n\n后文';

it('renders title and structured reference without exposing raw tags or dropping neighboring content', () => {
  const html = renderToStaticMarkup(<MarkdownView content={sample} />);
  expect(html).toContain('<h1'); expect(html).toContain('200-系统框架&amp;数据结构');
  expect(html).toContain('正文'); expect(html).toContain('后文');
  expect(html).toContain('同步引用'); expect(html).toContain('加载引用内容');
  expect(html).not.toContain('&lt;title&gt;'); expect(html).not.toContain('&lt;synced_reference');
});

it('preserves code examples, HTML table cell paragraphs and grid content', () => {
  const text = '```xml\n<title>原文</title>\n<synced_reference src-token="t"/>\n```\n\n`<title>示例</title>`\n\n<grid><column>列一</column><column>列二</column></grid>\n\n<h2>章节</h2><p>说明</p>\n\n<table><tr><td><p>表格内容</p></td></tr></table>';
  const html = renderToStaticMarkup(<MarkdownView content={text} />);
  expect(html).toContain('&lt;title&gt;原文&lt;/title&gt;');
  expect(html).toContain('&lt;title&gt;示例&lt;/title&gt;');
  expect(html).toContain('列一'); expect(html).toContain('列二'); expect(html).not.toContain('&lt;grid');
  expect(html).toContain('章节'); expect(html).toContain('说明'); expect(html).toContain('表格内容');
});

it('preserves already embedded reference content and shows a clear placeholder for unavailable whiteboards', () => {
  const html = renderToStaticMarkup(<MarkdownView content={'<synced_reference src-token="Source1">实际正文</synced_reference>\n\n<whiteboard token="MissingToken"></whiteboard>'} />);
  expect(html).toContain('实际正文');
  expect(html).not.toContain('&lt;synced_reference');
  expect(html).toContain('此白板尚未同步到本地');
  expect(html).not.toContain('&lt;whiteboard');
});

it('renders exported HTML headings and nested ordered and unordered lists', () => {
  const html = renderToStaticMarkup(<MarkdownView content={'<h2>快速获取</h2><p>说明</p><ol><li seq="2">第一项 `代码`<ul><li>子项</li></ul></li><li>第二项</li></ol>'} />);
  expect(html).toContain('<h2'); expect(html).toContain('<ol start="2"');
  expect(html).toContain('<ul'); expect(html).toContain('第一项'); expect(html).toContain('代码'); expect(html).toContain('子项'); expect(html).toContain('第二项');
  expect(html).not.toContain('&lt;li');
});

it('does not issue cloud reads for untrusted Markdown until explicitly requested', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.getSyncedReference.mockReset().mockResolvedValue({ content: '引用内容' });
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => root.render(<MarkdownView content={sample} />));
    expect(api.getSyncedReference).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '加载引用内容')!.click());
    expect(api.getSyncedReference).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('引用内容');
  } finally { act(() => root.unmount()); }
});

it('renders referenced content, and lets the user retry after a read error', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.getSyncedReference.mockReset().mockRejectedValueOnce(new Error('permission')).mockResolvedValueOnce({ content: '<fragment><synced-source id="b">引用正文</synced-source></fragment>', baseDir: 'source' });
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => root.render(<MarkdownView content={sample} resolveSyncedReferences />));
    expect(api.getSyncedReference).toHaveBeenCalledWith('Source1', 'Block1');
    expect(container.textContent).toContain('无法加载引用内容');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '重试')!.click());
    expect(container.textContent).toContain('引用正文');
    expect(container.textContent).not.toContain('<fragment');
    expect(container.textContent).not.toContain('<synced-source');
  } finally { act(() => root.unmount()); }
});
