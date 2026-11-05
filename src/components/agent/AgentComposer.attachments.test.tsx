// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentAttachmentDto, AgentSessionDto } from '../../types/agent';
const api = vi.hoisted(() => ({ uploadAgentAttachment: vi.fn(), removeAgentAttachment: vi.fn(), setSessionApprovalMode: vi.fn(), setSessionLocalResources: vi.fn() }));
vi.mock('../../api/client', () => api);
vi.mock('./ConversationModelPicker', () => ({ ConversationModelPicker: () => null }));
import { AgentComposer, type AgentComposerHandle } from './AgentComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const session = (id: string) => ({ id, state: 'idle', mode: 'discuss', backend: 'pi' }) as AgentSessionDto;
const attachment: AgentAttachmentDto = { id: 'att_test', name: '说明.md', size: 12, mimeType: 'text/plain', kind: 'document', lineCount: 1, textLength: 12 };
const send = vi.fn();
const ref = createRef<AgentComposerHandle>();
function render(id = 's-one') {
  root.render(<AgentComposer ref={ref} session={session(id)} agentStatus={{ code: 'ready' } as never} agentUnreachable={false} readiness={null}
    busy={false} sending={false} onSend={send} onStop={() => {}} onRecheck={() => {}} rechecking={false} onModelChanged={() => {}} />);
}
function inputFiles(files: File[]) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function inputText(value: string) {
  const input = host.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const sendButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!;
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.uploadAgentAttachment.mockReset().mockResolvedValue(attachment);
  api.removeAgentAttachment.mockReset().mockResolvedValue(undefined);
  send.mockReset().mockResolvedValue(true);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-image') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('本机插件仅显示在 Pi Work，会话运行时禁用并在切换失败时显示错误', async () => {
  const changed = vi.fn();
  const renderWork = (backend: 'pi' | 'claude-code', busy = false) => root.render(<AgentComposer session={{ ...session('s-one'), mode: 'work', backend }} agentStatus={{ code: 'ready' } as never} agentUnreachable={false} readiness={null} busy={busy} sending={false} onSend={send} onStop={() => {}} onRecheck={() => {}} rechecking={false} onModelChanged={changed} />);
  api.setSessionLocalResources.mockReset().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('切换失败'));
  await act(async () => renderWork('pi'));
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="本机插件"]')!.click());
  expect(api.setSessionLocalResources).toHaveBeenCalledWith('s-one', true); expect(changed).toHaveBeenCalledOnce();
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="本机插件"]')!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('切换失败');
  await act(async () => renderWork('pi', true)); expect(host.querySelector<HTMLInputElement>('[aria-label="本机插件"]')?.disabled).toBe(true);
  await act(async () => renderWork('claude-code')); expect(host.querySelector('[aria-label="本机插件"]')).toBeNull();
  await act(async () => render()); expect(host.querySelector('[aria-label="本机插件"]')).toBeNull();
});

it('plus opens the picker; uploads block send, attachment-only messages work, and failed sends retain the draft', async () => {
  let resolveUpload!: (value: AgentAttachmentDto) => void;
  api.uploadAgentAttachment.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
  await act(async () => render());
  const click = vi.spyOn(host.querySelector<HTMLInputElement>('input[type="file"]')!, 'click');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="添加图片或文件"]')!.click());
  expect(click).toHaveBeenCalled();
  const file = new File(['说明正文'], '说明.md', { type: 'text/markdown' });
  await act(async () => inputFiles([file]));
  expect(sendButton().disabled).toBe(true);
  expect(host.textContent).toContain('上传与解析中');
  await act(async () => resolveUpload(attachment));
  expect(sendButton().disabled).toBe(false);
  send.mockResolvedValueOnce(false);
  await act(async () => sendButton().click());
  expect(send).toHaveBeenLastCalledWith('', undefined, [attachment]);
  expect(host.querySelector('[aria-label="待发送附件"]')).not.toBeNull();
  await act(async () => sendButton().click());
  expect(host.querySelector('[aria-label="待发送附件"]')).toBeNull();
});

it('pasting images uses the same upload path; drafts and pending upload results stay with their own session', async () => {
  await act(async () => render());
  await act(async () => inputText('会话一草稿'));
  const file = new File(['image'], '截图.png', { type: 'image/png' });
  api.uploadAgentAttachment.mockResolvedValueOnce({ ...attachment, kind: 'image', name: file.name, mimeType: 'image/png' });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
  await act(async () => host.querySelector('textarea')!.dispatchEvent(paste));
  expect(paste.defaultPrevented).toBe(true);
  expect(api.uploadAgentAttachment).toHaveBeenCalledWith('s-one', file, expect.any(AbortSignal));
  await act(async () => render('s-two'));
  expect(host.querySelector('textarea')!.value).toBe('');
  expect(host.querySelector('[aria-label="待发送附件"]')).toBeNull();
  await act(async () => render('s-one'));
  expect(host.querySelector('textarea')!.value).toBe('会话一草稿');
  expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:test-image');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="移除附件 截图.png"]')!.click());
  expect(api.removeAgentAttachment).toHaveBeenCalledWith('s-one', attachment.id);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-image');
});

it('a rejected file remains visible with its cause and supports retry instead of silently sending text alone', async () => {
  api.uploadAgentAttachment.mockRejectedValueOnce(new Error('PDF 没有可提取的文字'));
  await act(async () => render());
  await act(async () => { inputText('阅读文件'); inputFiles([new File(['pdf'], '扫描件.pdf')]); });
  expect(host.textContent).toContain('PDF 没有可提取的文字');
  expect(sendButton().disabled).toBe(true);
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === '重试')!.click());
  expect(sendButton().disabled).toBe(false);
  await act(async () => sendButton().click());
  expect(send).toHaveBeenCalledWith('阅读文件', undefined, [attachment]);
});
