// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Dashboard } from './Dashboard';

const config = { watchedRootUrls: ['https://example.feishu.cn/wiki/root'] };
vi.mock('../hooks/useConfig', () => ({ useConfig: () => ({ config }) }));
vi.mock('../components/common/Toast', () => ({ useToast: () => toast }));
const toast = { push: vi.fn() };
vi.mock('../api/client', () => ({
  getStoredMappingDiff: async () => ({ added: [], modified: [
    { objToken: 'mapped', objType: 'docx', title: '已有文档', changeType: 'modified' },
    { objToken: 'missing', objType: 'sheet', title: '未在树中的表格', changeType: 'modified', localMdPath: 'old.md' },
  ], deleted: [] }),
  getMappingIndex: async () => ({ orphan_files: [] }),
  getMappingTreeDetailed: async () => ({ nodes: [{ obj_token: 'mapped', title: '已有文档', obj_type: 'docx', local_path: 'mapped.md' }] }),
  listCustomFolders: async () => [], listCloudMoves: async () => ({ moves: [] }),
  manualDeleteDoc: vi.fn(), previewSourceBatch: vi.fn(),
}));
vi.mock('../components/DocPreviewPanel', () => ({ DocPreviewPanel: ({ node }: any) => <div data-testid="preview">{node?.obj_token ?? 'none'}:{node?.local_path}</div> }));
vi.mock('../components/NodeTreeView', () => ({ NodeTreeView: () => null }));
vi.mock('../components/GlobalStatusBar', () => ({ GlobalStatusBar: () => null }));
vi.mock('../components/VersionUpdateAlert', () => ({ VersionUpdateAlert: () => null }));
vi.mock('../components/QuickAddDocDialog', () => ({ QuickAddDocDialog: () => null }));
vi.mock('../components/NodeDetailCard', () => ({ NodeDetailCard: () => null }));
vi.mock('../components/OrphanFileAlert', () => ({ OrphanFileAlert: () => null }));
vi.mock('../components/SourceBatchDialog', () => ({ SourceBatchDialog: () => null }));

it('opens recent items in preview, including documents absent from the tree; view all still opens sync', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  localStorage.setItem('feishu.layout.rightCollapsed', '0');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); const jump = vi.fn();
  try {
    await act(async () => { root.render(<Dashboard onJumpToSync={jump} />); });
    const button = (name: string) => [...container.querySelectorAll('button')].find((element) => element.textContent?.includes(name))!;
    await act(async () => button('已有文档').click());
    expect(container.querySelector('[data-testid="preview"]')?.textContent).toBe('mapped:mapped.md');
    await act(async () => button('未在树中的表格').click());
    expect(container.querySelector('[data-testid="preview"]')?.textContent).toBe('missing:old.md');
    expect(jump).not.toHaveBeenCalled();
    await act(async () => button('查看全部').click());
    expect(jump).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); container.remove(); localStorage.removeItem('feishu.layout.rightCollapsed'); vi.unstubAllGlobals(); }
});
