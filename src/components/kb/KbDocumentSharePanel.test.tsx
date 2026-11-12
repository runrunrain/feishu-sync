// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { KbTreeNode } from '../../types/agent';

const api = vi.hoisted(() => ({
  createKbWebShare: vi.fn(), downloadKbDocuments: vi.fn(), getKbWebShares: vi.fn(),
  resumeKbWebShares: vi.fn(), revokeKbWebShare: vi.fn(),
}));
vi.mock('../../api/client', () => api);
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { KbDocumentSharePanel } from './KbDocumentSharePanel';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const nodes: KbTreeNode[] = [
  { type: 'doc', name: '入口.md', title: '入口', path: '目录/入口.md', docId: 'base' },
  { type: 'doc', name: '说明.md', title: '说明', path: '说明.md', docId: 'second' },
];
const status = { running: true, port: 47392, shares: [{ id: 'share-id', title: '入口', createdAt: '2026-11-12T00:00:00Z', docCount: 2, urls: ['http://192.168.1.2:47392/s/test/0.html'] }] };
const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.includes(text))!;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  api.getKbWebShares.mockResolvedValue({ running: false, port: 47392, shares: [] });
  api.createKbWebShare.mockResolvedValue(status);
  api.revokeKbWebShare.mockResolvedValue({ running: false, port: 47392, shares: [] });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (releaseId = 'r1', selectedDocId = 'base') => {
  await act(async () => root.render(<KbDocumentSharePanel releaseId={releaseId} nodes={nodes} selectedDocId={selectedDocId} />));
};

it('shares the explicit document selection and base, then revokes its link', async () => {
  await render();
  expect((button('导出单篇') as HTMLButtonElement).disabled).toBe(false);
  await act(async () => (host.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement).click());
  expect((button('导出单篇') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => button('创建内网分享').click());
  expect(api.createKbWebShare).toHaveBeenCalledWith({ releaseId: 'r1', docIds: ['base', 'second'], baseDocId: 'base' });
  expect((host.querySelector('input[readonly]') as HTMLInputElement).value).toBe(status.shares[0].urls[0]);
  await act(async () => button('停止分享').click());
  expect(api.revokeKbWebShare).toHaveBeenCalledWith('share-id');
  expect(host.querySelector('input[readonly]')).toBeNull();
});

it('never submits a removed base or a stale version selection', async () => {
  await render();
  await act(async () => button('全选').click());
  await act(async () => (host.querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement).click());
  expect((host.querySelector('select') as HTMLSelectElement).value).toBe('second');
  await act(async () => button('创建内网分享').click());
  expect(api.createKbWebShare).toHaveBeenLastCalledWith({ releaseId: 'r1', docIds: ['second'], baseDocId: 'second' });
  await render('r2');
  expect((host.querySelector('select') as HTMLSelectElement).value).toBe('base');
  await act(async () => button('清空').click());
  expect((button('创建内网分享') as HTMLButtonElement).disabled).toBe(true);
});

it('shows failures and allows retrying', async () => {
  api.createKbWebShare.mockRejectedValueOnce(new Error('分享端口已被占用'));
  await render();
  await act(async () => button('创建内网分享').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('分享端口已被占用');
  expect((button('创建内网分享') as HTMLButtonElement).disabled).toBe(false);
});
