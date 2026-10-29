// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ included: new Set(['a']), build: vi.fn(), selection: vi.fn(), parentSource: false, unavailableParent: false }));
vi.mock('../../api/client', () => ({
  getKbSourceTree: async () => {
    const child = { id: 'b', title: '子文档', children: [], source: { objToken: 'b', title: '子文档', relPath: 'b.md', included: state.included.has('b'), pending: 'unchanged' } };
    if (state.unavailableParent) return { root: 'root', total: 1, nodes: [{ id: 'a', title: '父文档', sourceUnavailable: true, children: [child] }] };
    if (state.parentSource) return { root: 'root', total: 2, nodes: [{ id: 'a', title: '父文档', source: { objToken: 'a', title: '父文档', relPath: '旧标题.md', included: state.included.has('a'), pending: 'added', recovered: true }, children: [child] }] };
    return { root: 'root', total: 2, nodes: [{ id: 'folder', title: '目录', children: ['a', 'b'].map((id) => ({ id, title: id, children: [], source: { objToken: id, title: id, relPath: `${id}.md`, included: state.included.has(id), pending: 'unchanged' } })) }] };
  },
  setKbSourcesSelection: async (_root: string, tokens: string[], action: string) => { state.selection(tokens, action); for (const token of tokens) { if (action === 'include') state.included.add(token); else state.included.delete(token); } },
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

it('父节点自身也是源文档：预览、计数和批量勾选都包含父子', async () => {
  state.parentSource = true; state.included = new Set(['a', 'b']); state.build.mockClear(); state.selection.mockClear();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const checkbox = (title: string) => container.querySelector<HTMLInputElement>(`[aria-label="参与构建：${title}"]`)!;
  const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
  try {
    await act(async () => root.render(<KbSourceSelector running={false} nonce={0} canBuild onBuild={state.build} onChanged={() => {}} onOpenSource={() => {}} />));
    expect(container.textContent).toContain('2/2 篇');
    expect(container.querySelector('[aria-label="预览：父文档"]')).not.toBeNull();
    expect(container.textContent).toContain('本地');
    await act(async () => checkbox('父文档').click());
    expect(state.selection).toHaveBeenLastCalledWith(expect.arrayContaining(['a', 'b']), 'exclude');
    expect(button('构建所选文档').disabled).toBe(true);
    await act(async () => checkbox('父文档').click());
    expect(state.selection).toHaveBeenLastCalledWith(expect.arrayContaining(['a', 'b']), 'include');
    await act(async () => button('构建所选文档').click());
    expect(state.build).toHaveBeenLastCalledWith(2);
    await act(async () => checkbox('子文档').click());
    expect(checkbox('父文档').indeterminate).toBe(true);
    await act(async () => button('构建所选文档').click());
    expect(state.build).toHaveBeenLastCalledWith(1);
  } finally { act(() => root.unmount()); container.remove(); state.parentSource = false; }
});

it('父文档没有可用本地源时显示原因，只对有正文的子文档计数', async () => {
  state.unavailableParent = true; state.included = new Set(['b']); state.build.mockClear();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<KbSourceSelector running={false} nonce={0} canBuild onBuild={state.build} onChanged={() => {}} onOpenSource={() => {}} />));
    expect(container.textContent).toContain('源不可用');
    expect(container.textContent).toContain('1/1 篇');
    expect(container.querySelector('[aria-label="预览：父文档"]')).toBeNull();
    const build = [...container.querySelectorAll('button')].find((item) => item.textContent === '构建所选文档')!;
    await act(async () => build.click()); expect(state.build).toHaveBeenLastCalledWith(1);
  } finally { act(() => root.unmount()); container.remove(); state.unavailableParent = false; }
});
