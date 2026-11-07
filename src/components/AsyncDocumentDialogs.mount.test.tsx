/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ reconcileCloudMove: vi.fn() }));
vi.mock('../api/client', () => ({ ...api, APIError: class extends Error {} }));
import { CloudMovesSection } from './move-out/CloudMovesSection';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
document.body.appendChild(host);
let root = createRoot(host);
afterEach(() => {
  act(() => root.unmount());
  api.reconcileCloudMove.mockReset();
  root = createRoot(host);
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
