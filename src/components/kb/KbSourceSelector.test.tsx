// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ included: new Set(['a']), build: vi.fn() }));
vi.mock('../../api/client', () => ({
  getKbSourceTree: async () => ({ root: 'root', total: 2, nodes: [{ id: 'folder', title: '目录', children: ['a', 'b'].map((id) => ({ id, title: id, children: [], source: { objToken: id, title: id, relPath: `${id}.md`, included: state.included.has(id), pending: 'unchanged' } })) }] }),
  setKbSourcesSelection: async (_root: string, tokens: string[], action: string) => { for (const token of tokens) { if (action === 'include') state.included.add(token); else state.included.delete(token); } },
  cleanupKbSources: vi.fn(),
}));
import { KbSourceSelector } from './KbSourceSelector';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('构建当前选择，全选和取消全选后使用最新的数量', async () => {
  state.included = new Set(['a']); state.build.mockClear();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
  try {
    await act(async () => root.render(<KbSourceSelector running={false} nonce={0} canBuild onBuild={state.build} onChanged={() => {}} onOpenSource={() => {}} />));
    expect(container.querySelector('[aria-label="参与构建：a"]')).not.toBeNull();
    await act(async () => button('构建所选文档').click());
    expect(state.build).toHaveBeenLastCalledWith(1);
    await act(async () => button('全选').click());
    await act(async () => button('构建所选文档').click());
    expect(state.build).toHaveBeenLastCalledWith(2);
    await act(async () => button('取消全选').click());
    expect(button('构建所选文档').disabled).toBe(true);
  } finally { act(() => root.unmount()); container.remove(); }
});
