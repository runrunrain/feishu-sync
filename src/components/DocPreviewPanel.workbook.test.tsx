// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { MappingNode } from '../types';

const api = vi.hoisted(() => ({
  getDocumentContent: vi.fn(), getWorkbookPreview: vi.fn(), getWorkbookBlob: vi.fn(),
}));
vi.mock('../api/client', () => ({ ...api, refreshSheet: vi.fn() }));
vi.mock('../hooks/useConfig', () => ({ useConfig: () => ({ config: null }) }));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('./SourceCommentsSection', () => ({ SourceCommentsSection: () => null }));
vi.mock('./SourceEditControls', () => ({ SourceEditControls: () => null }));
import { DocPreviewPanel } from './DocPreviewPanel';
import { WorkbookView } from './preview/WorkbookView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('将 Excel 操作放在格式页签行，切换格式后仍可缩放与下载', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn();
  const clickLink = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  api.getDocumentContent.mockResolvedValue({
    objToken: 's1', title: '表格', objType: 'sheet', mdPath: 's.md', mdContent: '# 文档', mdTruncated: false,
    csvTables: [{ name: '主表', path: 's.csv', content: 'x', truncated: false }],
    workbook: { path: 's.xlsx', size: 1, modifiedTime: '2026-10-29', mode: 'read-reconstruction' },
    sheetStatus: { acquisition: 'read-reconstruction', syncedAt: '2026-10-29', cloudEditTime: 1234567890, approximations: ['mention'] },
  });
  api.getWorkbookPreview.mockImplementation(async (_token: string, index: number) => ({
    sheets: [{ index: 0, name: 'Sheet1', state: 'visible' }, { index: 1, name: 'Sheet2', state: 'visible' }],
    sheet: { index, name: `Sheet${index + 1}`, rows: [20], columns: [80],
      cells: [{ address: 'A1', row: 0, column: 0, text: '单元格内容', font: {}, borders: {} }],
      merges: [], images: [], showGridLines: false, warnings: [] },
  }));
  api.getWorkbookBlob.mockResolvedValue(new Blob(['excel']));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!;
  try {
    await act(async () => root.render(<DocPreviewPanel node={{ obj_token: 's1', obj_type: 'sheet', title: '表格', local_path: 's.xlsx' } as MappingNode} />));
    const slot = container.querySelector('[data-testid="workbook-toolbar-slot"]')!;
    expect(slot.parentElement?.textContent).toContain('Excel 画板');
    expect(slot.querySelector('[aria-label="Excel 缩放比例"]')).not.toBeNull();
    expect(slot.textContent).toContain('下载 Excel');
    expect(container.textContent).not.toContain('同步时间');
    expect(container.textContent).not.toContain('只读接口重建');
    expect(container.textContent).not.toContain('点击单元格可查看并复制完整文字');
    expect(container.textContent).not.toContain('s.xlsx');
    expect(container.querySelector('[aria-label="Excel 工作表"]')).not.toBeNull();
    await act(async () => button('Sheet2').click());
    expect(api.getWorkbookPreview).toHaveBeenLastCalledWith('s1', 1, expect.any(AbortSignal));
    expect(container.querySelector('[aria-label="Sheet2 Excel 画板"]')).not.toBeNull();
    const select = slot.querySelector<HTMLSelectElement>('select')!;
    await act(async () => { select.value = '1.5'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('[aria-label="Sheet2 Excel 画板"] [style*="scale(1.5)"]')).not.toBeNull();
    vi.useFakeTimers();
    await act(async () => button('下载 Excel').click());
    expect(api.getWorkbookBlob).toHaveBeenCalledWith('s1');
    expect(clickLink).toHaveBeenCalledOnce();
    vi.runAllTimers(); vi.useRealTimers();
    await act(async () => button('CSV (1)').click());
    expect(container.querySelector('[data-testid="workbook-toolbar-slot"]')).toBeNull();
    expect(container.textContent).toContain('s.csv');
    await act(async () => button('Excel 画板').click());
    expect(container.querySelector('[data-testid="workbook-toolbar-slot"] select')).not.toBeNull();
  } finally {
    act(() => root.unmount()); container.remove(); clickLink.mockRestore();
    vi.useRealTimers(); URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl; vi.unstubAllGlobals();
  }
});

it('独立画板保留缩放和下载入口', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  api.getWorkbookPreview.mockResolvedValue({ sheets: [{ index: 0, name: 'Sheet1', state: 'visible' }], sheet: {
    index: 0, name: 'Sheet1', rows: [20], columns: [80], cells: [], merges: [], images: [], showGridLines: false, warnings: [],
  } });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WorkbookView objToken="s1" fileName="s.xlsx" />));
    expect(container.querySelector('[aria-label="Excel 缩放比例"]')).not.toBeNull();
    expect(container.textContent).toContain('下载 Excel');
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
