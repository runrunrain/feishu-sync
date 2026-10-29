/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ previewKbPublish: vi.fn(), executeKbPublish: vi.fn() }));
vi.mock('../../api/client', () => ({ ...api, APIError: class extends Error {} }));
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { KbPublishModal } from './KbPublishModal';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
document.body.appendChild(host);
let root = createRoot(host);
afterEach(() => { act(() => root.unmount()); api.previewKbPublish.mockReset(); api.executeKbPublish.mockReset(); root = createRoot(host); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const plan = {
  releaseId: 'rel1', planKey: 'plan1', target: { kind: 'drive_folder', token: 'folder', label: '测试' },
  items: [{ kbPath: 'a.md', title: 'A', action: 'create', contentHash: 'hash', warnings: [], state: null, cloudToken: null, cloudUrl: null, cloudEdited: false }],
  removed: [], gates: { feishuWriteEnabled: true, writeScopesGranted: true, missingScopes: [], publishEnabled: true, targetConfigured: true }, confirmRequired: 'PUBLISH',
};
const nodes = [{ name: 'a.md', path: 'a.md', type: 'doc' as const, docId: 'a', title: 'A' }];
const render = (open: boolean) => <KbPublishModal open={open} initialTab="publish" onClose={() => {}} nodes={nodes} publications={[]} publicationsLoading={false} onPublicationsChanged={() => {}} />;
function button(label: string) { return [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!; }

it('执行使用实际预览时的选项，并接受确认值两端空格', async () => {
  const pending = deferred<typeof plan>();
  api.previewKbPublish.mockReturnValue(pending.promise);
  api.executeKbPublish.mockResolvedValue({ items: [], removedMarked: [], counts: { created: 1, updated: 0, skipped: 0, blocked: 0, failed: 0, secondPass: 0 } });
  await act(async () => { root.render(render(true)); });
  await act(async () => { button('生成发布计划').click(); });
  const force = [...host.querySelectorAll('input[type="checkbox"]')].at(-1)! as HTMLInputElement;
  await act(async () => { force.click(); });
  await act(async () => { pending.resolve(plan); });
  const input = host.querySelector('input[aria-label="发布确认值"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' PUBLISH ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { button('执行发布').click(); });
  expect(api.executeKbPublish).toHaveBeenCalledWith({ kbPaths: ['a.md'], confirm: 'PUBLISH', planKey: 'plan1' });
});

it('关闭并重新打开后不会显示旧发布计划', async () => {
  const pending = deferred<typeof plan>();
  api.previewKbPublish.mockReturnValue(pending.promise);
  await act(async () => { root.render(render(true)); });
  await act(async () => { button('生成发布计划').click(); });
  await act(async () => { root.render(render(false)); });
  await act(async () => { root.render(render(true)); });
  await act(async () => { pending.resolve(plan); });
  expect(host.querySelector('[data-publish-step="select"]')).not.toBeNull();
  expect(host.querySelector('[data-publish-step="preview"]')).toBeNull();
});
