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
import { DocPreviewPanel } from './DocPreviewPanel';
import { WorkbookCanvas, WorkbookView } from './preview/WorkbookView';

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

it('独立画板可用 Ctrl＋滚轮连续缩放，并保留光标下的位置', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  api.getWorkbookPreview.mockResolvedValue({ sheets: [{ index: 0, name: 'Sheet1', state: 'visible' }], sheet: {
    index: 0, name: 'Sheet1', rows: [800], columns: [900], cells: [], merges: [], images: [], showGridLines: false, warnings: [],
  } });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  try {
    await act(async () => root.render(<WorkbookView objToken="s1" fileName="s.xlsx" />));
    const viewport = container.querySelector<HTMLDivElement>('[aria-label="Sheet1 Excel 画板"]')!;
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Excel 缩放比例"]')!;
    expect(select.selectedOptions[0].textContent).toBe('100%');
    expect(viewport.querySelector('[style*="scale(1)"]')).not.toBeNull();
    await act(async () => { select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(select.selectedOptions[0].textContent).toBe('自动（67%）');
    expect(viewport.querySelector('[style*="scale(0.6666666666666666)"]')).not.toBeNull();
    await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    Object.defineProperties(viewport, { clientWidth: { value: 200 }, clientHeight: { value: 150 } });
    viewport.scrollLeft = 80;
    viewport.scrollTop = 70;
    const wheel = (ctrlKey: boolean) => viewport.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, ctrlKey, deltaY: -20, clientX: 100, clientY: 50,
    }));
    await act(async () => { expect(wheel(false)).toBe(true); });
    expect(viewport.scrollLeft).toBe(80);
    await act(async () => {
      expect(wheel(true)).toBe(false);
      expect(wheel(true)).toBe(false);
    });
    const zoom = Number(select.value);
    expect(zoom).toBeGreaterThan(1.05);
    expect(zoom).toBeLessThan(1.15);
    expect((viewport.scrollLeft + 100) / zoom).toBeCloseTo(180);
    expect((viewport.scrollTop + 50) / zoom).toBeCloseTo(120);
    expect(select.selectedOptions[0].textContent).toBe(`${Math.round(zoom * 100)}%`);
    expect(container.textContent).toContain('下载 Excel');
  } finally { act(() => root.unmount()); container.remove(); width.mockRestore(); vi.unstubAllGlobals(); }
});

it('点击画板图片可在独立窗口拖动和滚轮缩放，关闭后回到图片', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const pointer = (target: Element, type: string, clientX: number, clientY: number) =>
    target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      clientX, clientY, pointerId: 4, pointerType: 'mouse', isPrimary: true, button: 0,
    }));
  try {
    const src = 'data:image/png;base64,AA==';
    await act(async () => root.render(<WorkbookCanvas sheet={{
      index: 0, name: '画板', rows: [80], columns: [90], cells: [], merges: [],
      images: [{ id: 'img', x: 0, y: 0, width: 60, height: 40, dataUrl: src }], showGridLines: false, warnings: [],
    }} />));
    const opener = container.querySelector<HTMLButtonElement>('[aria-label="查看画板 图片 1"]')!;
    await act(async () => opener.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const viewport = dialog.querySelector<HTMLDivElement>('[aria-label="图片查看区域"]')!;
    const image = viewport.querySelector('img')!;
    expect(image.getAttribute('src')).toBe(src);
    Object.defineProperties(image, {
      naturalWidth: { value: 1600 }, naturalHeight: { value: 1200 },
      clientWidth: { value: 800 }, clientHeight: { value: 600 },
    });
    await act(async () => image.dispatchEvent(new Event('load')));
    expect(dialog.querySelector('output')?.textContent).toBe('50%');
    Object.defineProperty(viewport, 'setPointerCapture', { value: vi.fn() });
    await act(async () => {
      pointer(viewport, 'pointerdown', 20, 30);
      pointer(viewport, 'pointermove', 40, 60);
      pointer(viewport, 'pointerup', 40, 60);
      pointer(viewport, 'pointermove', 70, 80);
    });
    expect(image.style.transform).toBe('translate(20px, 30px) scale(1)');
    await act(async () => {
      expect(viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -50 }))).toBe(false);
    });
    expect(Number(dialog.querySelector('output')?.textContent?.replace('%', ''))).toBeGreaterThan(50);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it('按住画板双轴平移，取消捕获后移动鼠标不再滚动', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const pointer = (target: Element, type: string, clientX: number, clientY: number) =>
    target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      clientX, clientY, pointerId: 4, pointerType: 'mouse', isPrimary: true, button: 0,
    }));
  try {
    await act(async () => root.render(<WorkbookCanvas zoom={0.5} sheet={{
      index: 0, name: '画板', rows: [800], columns: [900], cells: [], merges: [],
      images: [], showGridLines: false, warnings: [],
    }} />));
    const viewport = container.querySelector<HTMLDivElement>('[aria-label="画板 Excel 画板"]')!;
    Object.defineProperties(viewport, {
      clientWidth: { value: 200 }, clientHeight: { value: 150 },
      scrollWidth: { value: 450 }, scrollHeight: { value: 400 },
      setPointerCapture: { value: vi.fn() },
    });
    viewport.scrollLeft = 20;
    viewport.scrollTop = 30;
    pointer(viewport.firstElementChild!, 'pointerdown', 150, 130);
    pointer(viewport, 'pointermove', 110, 70);
    expect(viewport.setPointerCapture).toHaveBeenCalledWith(4);
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([60, 90]);
    pointer(viewport, 'lostpointercapture', 110, 70);
    pointer(viewport, 'pointermove', 50, 50);
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([60, 90]);
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
