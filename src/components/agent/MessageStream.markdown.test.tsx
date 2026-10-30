// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { AgentMessageDto } from '../../types/agent';

const api = vi.hoisted(() => ({ getSyncedReference: vi.fn(), getMediaBlobUrl: vi.fn() }));
vi.mock('../../api/client', () => api);
import { MessageStream } from './MessageStream';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const richReply = [
  '### 一、标准知识库中的正式定义',
  '',
  '在设计文档中，**大营**有明确的定义。',
  '',
  '- **实体性质**：宏观指挥中枢',
  '- 编制规则：多个部队的集合',
  '',
  '| 项目 | 内容 |',
  '| --- | --- |',
  '| 位置 | 营地 |',
  '',
  '```ts',
  'const camp = 1;',
  '```',
  '',
  '[飞书原文](https://example.com/wiki/123)',
].join('\n');

it('历史助手回复使用文档渲染器，用户消息和模型信息保持原样', () => {
  const messages: AgentMessageDto[] = [
    { id: 'user', role: 'user', at: '', text: '# 用户输入 **不改写**' },
    { id: 'assistant', role: 'assistant', at: '', text: richReply, model: 'fixture/model' },
  ];
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<MessageStream messages={messages} draft={null} loading={false} streamErrors={[]} />);

  const user = container.querySelector('[data-role="user"]')!;
  const reply = container.querySelector('[data-role="assistant"]')!;
  expect(user.textContent).toBe('# 用户输入 **不改写**');
  expect(user.querySelector('h1, strong')).toBeNull();
  expect(reply.querySelector('.markdown-body.markdown-preview h3')?.textContent).toBe('一、标准知识库中的正式定义');
  expect(reply.querySelector('strong')?.textContent).toBe('大营');
  expect(reply.querySelectorAll('ul li')).toHaveLength(2);
  expect(reply.querySelector('table tbody td')?.textContent).toBe('位置');
  expect(reply.querySelector('pre code')?.textContent).toBe('const camp = 1;');
  expect(reply.querySelector('a')?.getAttribute('href')).toBe('https://example.com/wiki/123');
  expect(reply.textContent).toContain('fixture/model');
});

it('流式回复随着内容增长重新渲染，交给历史消息后保留同样的排版', async () => {
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  const container = document.createElement('div');
  const root = createRoot(container);
  const draft = (text: string) => ({ runId: 'r', text, tools: [] });
  try {
    await act(async () => root.render(<MessageStream messages={[]} draft={draft('### 规则\n\n**重')} loading={false} streamErrors={[]} />));
    expect(container.querySelector('[data-testid="agent-live-draft"] h3')?.textContent).toBe('规则');
    expect(container.textContent).toContain('**重');
    await act(async () => root.render(<MessageStream messages={[]} draft={draft('### 规则\n\n**重点**\n\n```ts\nlet n = 1;')} loading={false} streamErrors={[]} />));
    expect(container.querySelector('[data-testid="agent-live-draft"] strong')?.textContent).toBe('重点');
    expect(container.querySelector('[data-testid="agent-live-draft"] pre code')?.textContent).toBe('let n = 1;');
    const finalText = '### 规则\n\n**重点**\n\n```ts\nlet n = 1;\n```';
    const messages: AgentMessageDto[] = [{ id: 'a', role: 'assistant', at: '', text: finalText }];
    await act(async () => root.render(<MessageStream messages={messages} draft={null} loading={false} streamErrors={[]} />));
    expect(container.querySelector('[data-testid="agent-live-draft"]')).toBeNull();
    expect(container.querySelector('[data-role="assistant"] strong')?.textContent).toBe('重点');
    expect(container.querySelector('[data-role="assistant"] pre code')?.textContent).toBe('let n = 1;');
  } finally {
    act(() => root.unmount());
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
    else delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  }
});

it('助手回复不会自动加载远程图片或云端引用，也不会执行不安全链接', async () => {
  api.getSyncedReference.mockReset();
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  const container = document.createElement('div');
  const root = createRoot(container);
  const text = '![远程图片](https://images.example/figure.png)\n\n[危险链接](javascript:alert(1))\n\n<synced_reference src-token="Source1" src-block-id="Block1"></synced_reference>';
  const messages: AgentMessageDto[] = [{ id: 'a', role: 'assistant', at: '', text }];
  try {
    await act(async () => root.render(<MessageStream messages={messages} draft={null} loading={false} streamErrors={[]} />));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('外部图片（images.example）不会自动加载');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.textContent).toContain('危险链接');
    expect(api.getSyncedReference).not.toHaveBeenCalled();
    const load = [...container.querySelectorAll('button')].find((button) => button.textContent === '点击加载')!;
    await act(async () => load.click());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://images.example/figure.png');
    expect(api.getSyncedReference).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
    else delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  }
});
