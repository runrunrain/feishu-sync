// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { MarkdownView } from './MarkdownView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows one page of a large imported table and lets readers reach the final rows', async () => {
  const markdown = ['| 编号 | 内容 |', '| --- | --- |',
    ...Array.from({ length: 205 }, (_, i) => `| ${i + 1} | 记录 ${i + 1} |`)].join('\n');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MarkdownView content={markdown} variant="reading" />));
    const rows = () => host.querySelectorAll('tbody tr');
    const next = () => [...host.querySelectorAll('button')].find((button) => button.textContent === '下一页')!;
    expect(rows()).toHaveLength(100);
    expect(host.textContent).toContain('第 1/3 页');
    expect(host.textContent).not.toContain('记录 205');
    await act(async () => next().click());
    expect(rows()).toHaveLength(100);
    expect(host.textContent).toContain('第 2/3 页');
    await act(async () => next().click());
    expect(rows()).toHaveLength(5);
    expect(host.textContent).toContain('记录 205');
    expect((next() as HTMLButtonElement).disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
