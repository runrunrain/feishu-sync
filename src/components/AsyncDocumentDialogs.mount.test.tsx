/** @vitest-environment jsdom */
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getCloudHistory: vi.fn(), getSourcePushLog: vi.fn(), reconcileUnknownRevert: vi.fn(), reconcileCloudMove: vi.fn(), previewMoveToDrive: vi.fn(), previewHistoryRevert: vi.fn() }));
vi.mock('../api/client', () => ({
  ...api, APIError: class extends Error {}, executeMoveToDrive: vi.fn(), getCloudMove: vi.fn(),
  executeHistoryRevert: vi.fn(),
}));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { CloudHistoryDrawer } from './source-history/CloudHistoryDrawer';
import { MoveOutModal } from './move-out/MoveOutModal';
import { HistoryRevertModal } from './source-history/HistoryRevertModal';
import { SourcePushLogDrawer } from './source-history/SourcePushLogDrawer';
import { CloudMovesSection } from './move-out/CloudMovesSection';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
document.body.appendChild(host);
let root = createRoot(host);
afterEach(() => {
  act(() => root.unmount());
  api.getCloudHistory.mockReset();
  api.getSourcePushLog.mockReset();
  api.reconcileUnknownRevert.mockReset();
  api.reconcileCloudMove.mockReset();
  api.previewMoveToDrive.mockReset();
  api.previewHistoryRevert.mockReset();
  root = createRoot(host);
});

it('切换回滚目标后忽略旧预览，StrictMode 下仍可加载', async () => {
  const old = deferred<unknown>();
  const plan = (id: string) => ({ source: 'history', blockedReason: null, warnings: [], target: { historyVersionId: id, createdAt: null, editorIds: [], editorName: null } });
  api.previewHistoryRevert.mockImplementation((_token: string, target: { historyVersionId: string }) =>
    target.historyVersionId === 'old' ? old.promise : Promise.resolve(plan(target.historyVersionId)));
  const oldTarget = { historyVersionId: 'old', sourceLabel: '旧' };
  const newTarget = { historyVersionId: 'new', sourceLabel: '新' };
  const render = (target: typeof oldTarget) => <StrictMode><HistoryRevertModal open objToken="doc" target={target} onClose={() => {}} onReverted={() => {}} /></StrictMode>;
  await act(async () => { root.render(render(oldTarget)); });
  await act(async () => { root.render(render(newTarget)); });
  await act(async () => { old.resolve(plan('old')); });
  expect(host.querySelector('[data-testid="revert-target-id"]')?.textContent).toBe('new');
  expect((host.querySelector('[data-testid="revert-confirm-input"]') as HTMLInputElement).value).toBe('REVERT_CLOUD:new');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('切换文档后历史抽屉忽略旧请求，并支持 StrictMode 重挂载', async () => {
  const old = deferred<unknown>();
  api.getCloudHistory.mockImplementation((token: string) => token === 'old' ? old.promise : Promise.resolve({
    entries: [{ historyVersionId: 'new-version', revisionId: 1, editTime: null, editorIds: [], type: 2 }],
    truncated: false, hasMore: false, nextPageToken: null,
  }));
  const render = (token: string) => <StrictMode><CloudHistoryDrawer open objToken={token} onClose={() => {}} onRequestRevert={() => {}} /></StrictMode>;
  await act(async () => { root.render(render('old')); });
  await act(async () => { root.render(render('new')); });
  expect(host.textContent).toContain('new-version');
  await act(async () => { old.resolve({ entries: [{ historyVersionId: 'old-version', revisionId: 1, editTime: null, editorIds: [], type: 2 }], truncated: false }); });
  expect(host.textContent).toContain('new-version');
  expect(host.textContent).not.toContain('old-version');
});

it('切换移出目标后旧预览不能覆盖新文档的确认信息', async () => {
  const old = deferred<unknown>();
  const plan = (token: string) => ({ objToken: token, title: token, nodeToken: `node-${token}`, watchedRootLabel: '库', target: { label: '个人空间根' }, consequences: [], blockedReason: null });
  api.previewMoveToDrive.mockImplementation((token: string) => token === 'old' ? old.promise : Promise.resolve(plan(token)));
  const render = (token: string) => <MoveOutModal open objToken={token} target={{ objToken: token, title: token }} onClose={() => {}} onMoved={() => {}} />;
  await act(async () => { root.render(render('old')); });
  await act(async () => { root.render(render('new')); });
  await act(async () => { old.resolve(plan('old')); });
  expect(host.querySelector('[data-testid="moveout-title"]')?.textContent).toBe('new');
  expect((host.querySelector('[data-testid="moveout-confirm-input"]') as HTMLInputElement).value).toBe('MOVE_OUT:node-new');
});

it('写回记录切换文档时屏蔽旧响应，并在 StrictMode 下加载', async () => {
  const old = deferred<unknown>();
  api.getSourcePushLog.mockImplementation((token: string) => token === 'old' ? old.promise : Promise.resolve({ logs: [] }));
  const render = (token: string) => <StrictMode><SourcePushLogDrawer open objToken={token} localBody={null} onClose={() => {}} onRequestRevert={() => {}} onRequestCompare={() => {}} /></StrictMode>;
  await act(async () => { root.render(render('old')); });
  await act(async () => { root.render(render('new')); });
  await act(async () => { old.resolve({ logs: [{ id: 'old', mode: 'append', actor: '旧文档', outcome: 'pushed', anchorHistoryId: null, revertState: null, createdAt: '' }] }); });
  expect(host.textContent).toContain('暂无写回记录');
  expect(host.textContent).not.toContain('旧文档');
});

it('无任务号的未知回滚必须人工确认后才能请求解除保护', async () => {
  const row = { id: 'log1', mode: 'revert', actor: 'ui', outcome: 'unknown', anchorHistoryId: null, revertState: 'unknown', revertTaskId: null, createdAt: '' };
  api.getSourcePushLog.mockResolvedValue({ logs: [row] });
  api.reconcileUnknownRevert.mockResolvedValue({ state: 'resolved', reason: null });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  await act(async () => { root.render(<SourcePushLogDrawer open objToken="doc" localBody={null} onClose={() => {}} onRequestRevert={() => {}} onRequestCompare={() => {}} />); });
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('人工确认任务已结束'))!;
  await act(async () => { button.click(); });
  expect(api.reconcileUnknownRevert).not.toHaveBeenCalled();
  await act(async () => { button.click(); });
  expect(api.reconcileUnknownRevert).toHaveBeenCalledWith('doc', 'log1', 'REVERT_SETTLED:log1');
  confirm.mockRestore();
});

it('未知移出人工核对必须先确认，且向服务端传递选定去向', async () => {
  const move = { id: 'mv1', objToken: 'doc', state: 'unknown', taskId: null, actor: 'ui', targetFolderToken: null, createdAt: '', updatedAt: '' } as never;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  api.reconcileCloudMove.mockResolvedValue({ state: 'failed', reason: null });
  const changed = vi.fn();
  await act(async () => { root.render(<CloudMovesSection moves={[move]} onChanged={changed} />); });
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('确认已结束且未移出'))!;
  await act(async () => { button.click(); });
  expect(api.reconcileCloudMove).not.toHaveBeenCalled();
  await act(async () => { button.click(); });
  expect(api.reconcileCloudMove).toHaveBeenCalledWith('mv1', 'MOVE_SETTLED_NOT_MOVED:mv1');
  expect(changed).toHaveBeenCalledOnce();
  confirm.mockRestore();
});
