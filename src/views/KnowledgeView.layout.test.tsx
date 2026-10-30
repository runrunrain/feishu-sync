// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  included: new Set(['a']),
  hasCurrent: true,
  listBuilds: vi.fn(),
  createBuild: vi.fn(),
  toast: { push: vi.fn(), dismiss: vi.fn(), toasts: [] },
  agent: { status: { code: 'ready' }, unreachable: false, loading: false, rechecking: false, recheck: vi.fn(), refresh: vi.fn() },
}));

vi.mock('../hooks/useAgentStatus', () => ({ useAgentStatus: () => state.agent }));
vi.mock('../components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../components/preview/MarkdownView', () => ({ MarkdownView: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('../components/kb/RawSourceDrawer', () => ({ RawSourceDrawer: () => null }));
vi.mock('../components/kb/KbPublishModal', () => ({ KbPublishModal: () => null }));
vi.mock('../components/kb/KbPublishPanel', () => ({ KbPublishPanel: () => <p>发布面板</p> }));
vi.mock('../api/client', () => {
  const changes = [{ key: 'a', title: '来源 A', path: '来源 A.md', kind: 'changed', beforeAvailable: true, patch: '-旧\n+新', additions: 1, deletions: 1, truncated: false }];
  const build = {
    id: 'build-1', status: 'published', noChanges: false, mode: 'full', releaseId: 'r1', baseReleaseId: null,
    counts: { sourceTotal: 2, added: 0, changed: 1, removed: 0, docsWritten: 1, docsDeleted: 0 },
    progress: { batchIndex: 0, batchTotal: 0, stage: null, units: { total: 0, completed: 0 }, workers: [], images: { total: 0, completed: 0 } },
    parallelism: 1, warnings: [], error: null,
  };
  class APIError extends Error { statusCode = 500; response = {}; }
  return {
    APIError,
    getKbStatus: async () => ({ current: state.hasCurrent ? { releaseId: 'r1', docCount: 2, sourceCount: 2 } : null, pending: { added: 0, changed: 1, removed: 0 }, activeBuild: null }),
    getKbTree: async () => ({ releaseId: 'r1', nodes: [{ name: '分类', path: '分类', type: 'dir', children: [
      { name: '第一篇', title: '第一篇', path: '分类/第一篇.md', type: 'doc', docId: 'first' },
      { name: '第二篇', title: '第二篇', path: '分类/第二篇.md', type: 'doc', docId: 'second' },
    ] }] }),
    getKbDoc: async (id: string) => ({ docId: id, title: id === 'first' ? '第一篇' : '第二篇', path: `分类/${id}.md`, summary: '', tags: [], markdown: `${id} 正文`, releaseId: 'r1', sources: [] }),
    listKbPublications: async () => ({ publications: [] }),
    getKbSourceTree: async () => ({ root: 'root', total: 2, nodes: [{ id: 'folder', title: '源目录', children: ['a', 'b'].map((id) => ({
      id, title: `来源 ${id.toUpperCase()}`, children: [], source: { objToken: id, title: `来源 ${id.toUpperCase()}`, relPath: `${id}.md`, included: state.included.has(id), pending: 'changed' },
    })) }] }),
    setKbSourcesSelection: async (_root: string, tokens: string[], action: string) => { for (const token of tokens) { if (action === 'include') state.included.add(token); else state.included.delete(token); } },
    cleanupKbSources: vi.fn(),
    getKbChanges: async () => ({ sources: changes, affectedDocs: [], baseReleaseId: 'r1' }),
    listKbVersions: async () => ({ retainReleases: 3, versions: [{ releaseId: 'r1', publishedAt: '2026-10-29T00:00:00Z', docCount: 2 }] }),
    getKbVersion: async () => ({ releaseId: 'r1', baseReleaseId: null, summary: '', docChanges: changes, sourceChanges: [] }),
    listKbBuilds: state.listBuilds.mockResolvedValue({ builds: [build] }),
    getKbBuild: async () => build,
    createKbBuild: state.createBuild.mockResolvedValue(build),
    cancelKbBuild: vi.fn(), getSseAuth: vi.fn(), searchKb: vi.fn(),
  };
});

import { KnowledgeView } from './KnowledgeView';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

it('左侧目录保持可用，构建、差异、版本和进度从右侧直接访问', async () => {
  state.hasCurrent = true; state.included = new Set(['a']); state.listBuilds.mockClear(); state.createBuild.mockClear();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const label = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)!;
  const click = async (element: HTMLElement) => act(async () => element.click());
  try {
    await act(async () => root.render(<KnowledgeView />));
    expect(container.querySelector('[data-testid="kb-directory-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kb-sidebar"]')).toBeNull();
    expect([...container.querySelectorAll('[data-sidebar-trigger]')].map((el) => el.getAttribute('data-sidebar-trigger')))
      .toEqual(['sources', 'publish', 'build', 'progress']);

    await click(button('第二篇'));
    expect(container.querySelector('[data-testid="kb-directory-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kb-reading-body"]')?.textContent).toContain('second 正文');
    expect(button('第二篇').getAttribute('aria-current')).toBe('true');

    await click(label('收起目录'));
    expect(container.querySelector('[data-testid="kb-directory-panel"]')).toBeNull();
    await click(label('打开目录'));
    expect(button('第二篇').getAttribute('aria-current')).toBe('true');

    await click(label('打开构建标准库'));
    expect(container.querySelector('[data-testid="kb-build-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(state.listBuilds).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="参与构建：来源 A"]')).not.toBeNull();
    await click(button('全选'));
    await click(button('构建所选文档'));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('2 篇源文档');
    await click(button('开始构建'));
    expect(state.createBuild).toHaveBeenCalledWith('full');
    expect(container.querySelector('[data-testid="kb-build-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="标准库构建进度"]')).toBeNull();

    await click(button('待更新差异'));
    expect(container.textContent).toContain('来源 A.md');
    await click(button('按这些变更更新'));
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('确认按变更更新');
    await click(button('查看源文档差异与影响范围'));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(button('待更新差异').getAttribute('aria-selected')).toBe('true');
    await click(button('按这些变更更新'));
    await click(button('开始按变更更新'));
    expect(state.createBuild).toHaveBeenCalledWith('incremental');

    await click(button('版本记录'));
    expect(container.querySelector('[aria-label="选择标准库版本"]')).not.toBeNull();
    await click(label('打开构建进度'));
    expect(container.querySelector('[data-testid="kb-build-sidebar"]')).toBeNull();
    expect(container.querySelector('[aria-label="标准库构建进度"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="收起标准库侧栏"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="收起进度面板"]')).toBeNull();
    expect(container.querySelector('[data-testid="kb-directory-panel"]')).not.toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});

it('所选文档可选择重新生成图片描述，取消重置并在启动失败后保留选择', async () => {
  state.hasCurrent = true; state.included = new Set(['a']); state.createBuild.mockClear();
  state.createBuild.mockRejectedValueOnce(new Error('构建启动失败'));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)!;
  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')!;
  const checkbox = () => dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const click = async (element: HTMLElement) => act(async () => element.click());
  try {
    await act(async () => root.render(<KnowledgeView />));
    await click(container.querySelector<HTMLButtonElement>('[aria-label="打开构建标准库"]')!);
    await click(button('构建所选文档'));
    expect(dialog().textContent).toContain('重新生成所选文档的图片描述');
    expect(checkbox().checked).toBe(false);
    await click(checkbox());
    await click(button('取消'));
    await click(button('构建所选文档'));
    expect(checkbox().checked).toBe(false);
    await click(checkbox());
    await click(button('开始构建'));
    expect(state.createBuild).toHaveBeenLastCalledWith('full', { refreshImages: true });
    expect(checkbox().checked).toBe(true);
    await click(button('开始构建'));
    expect(state.createBuild).toHaveBeenCalledTimes(2);
    expect(state.createBuild).toHaveBeenLastCalledWith('full', { refreshImages: true });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});

it('首次构建入口打开源选择，进度入口按需加载最近的记录', async () => {
  state.hasCurrent = false; state.included = new Set(['a']); state.listBuilds.mockClear();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<KnowledgeView />));
    expect(container.textContent).toContain('尚未发布标准知识库');
    await act(async () => button('选择源文档').click());
    expect(container.querySelector('[data-testid="kb-build-sidebar"]')).not.toBeNull();
    expect(button('构建所选文档').disabled).toBe(false);
    expect(state.listBuilds).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开构建进度"]')!.click());
    expect(state.listBuilds).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="标准库构建进度"]')?.textContent).toContain('已发布');
  } finally { act(() => root.unmount()); container.remove(); state.hasCurrent = true; }
});
