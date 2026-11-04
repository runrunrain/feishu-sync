// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { AgentMessageDto } from '../../types/agent';
const calls = vi.hoisted(() => ({ markdown: vi.fn() }));
vi.mock('../preview/MarkdownView', () => ({ MarkdownView: ({ content }: { content: string }) => { calls.markdown(content); return <div>{content}</div>; } }));
import { MessageStream } from './MessageStream';

it('does not rerender unchanged Markdown during tool updates and mounts history in readable pages', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  const host = document.createElement('div'); const root = createRoot(host);
  const messages: AgentMessageDto[] = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, at: '', role: 'user', text: `message ${i}` }));
  const render = (index: number) => root.render(<MessageStream sessionId="s" messages={messages} loading={false} streamErrors={[]}
    draft={{ runId: 'r', text: 'same rich response', tools: [{ callId: 't', name: 'read', argsSummary: `arg${index}`, phase: 'start' }] }} />);
  try {
    await act(async () => render(0));
    for (let i = 1; i < 20; i++) await act(async () => render(i));
    expect(calls.markdown).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('[data-role="user"]')).toHaveLength(80);
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    expect(host.querySelectorAll('[data-role="user"]')).toHaveLength(160);
    expect(host.textContent).toContain('message 499');
    await act(async () => root.render(<MessageStream sessionId="other" messages={messages} loading={false} draft={null} streamErrors={[]} />));
    expect(host.querySelectorAll('[data-role="user"]')).toHaveLength(80);
  } finally { act(() => root.unmount()); }
});

it('combines invocation/result cards without losing arguments, including reused call IDs in later rounds', () => {
  const messages: AgentMessageDto[] = [
    { id: 'a1', role: 'assistant', at: '', toolCalls: [{ id: 'call', name: 'read', argsSummary: 'first-path' }] },
    { id: 't1', role: 'tool', at: '', tool: { callId: 'call', name: 'read', resultSummary: 'first-result', isError: false } },
    { id: 'a2', role: 'assistant', at: '', toolCalls: [{ id: 'call', name: 'read', argsSummary: 'second-path' }] },
    { id: 't2', role: 'tool', at: '', tool: { callId: 'call', name: 'read', resultSummary: 'second-result', isError: false } },
  ];
  const host = document.createElement('div'); host.innerHTML = renderToStaticMarkup(<MessageStream messages={messages} draft={null} streamErrors={[]} loading={false} />);
  expect(host.querySelectorAll('[data-tool="read"]')).toHaveLength(2);
  const rows = host.querySelectorAll('[data-role="tool"]');
  expect(rows[0].textContent).toContain('first-path'); expect(rows[0].textContent).not.toContain('second-path');
  expect(rows[1].textContent).toContain('second-path'); expect(rows[1].textContent).toContain('second-result');
});
