import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkbookCanvas } from './WorkbookView';
import { prepareWorkbookLayout } from './workbook-layout';
import type { WorkbookCell, WorkbookSheetLayout } from '../../types/workbook';

function fixture(): WorkbookSheetLayout {
  const cell = (address: string, row: number, column: number, text: string): WorkbookCell => ({ address, row, column, text, font: { size: 14 }, horizontal: 'left', borders: {} });
  return { index: 0, name: '画板', rows: [24, 24, 24, 24], columns: [80, 100, 120, 80],
    cells: [cell('A1', 0, 0, '完整长说明'.repeat(12)), cell('C1', 0, 2, '另一段文字'), cell('B3', 2, 1, '<script>alert(1)</script>')],
    merges: [{ top: 2, left: 1, bottom: 3, right: 2 }],
    images: [{ id: 'img1', x: 87, y: 33, width: 160, height: 90, dataUrl: 'data:image/png;base64,AA==' }], showGridLines: true, warnings: [] };
}

describe('Excel canvas geometry and safe rendering', () => {
  it('keeps merged cells and images at source coordinates and stops overflow at the next occupied cell', () => {
    const layout = prepareWorkbookLayout(fixture());
    expect(layout.cells[0].textWidth).toBe(180);
    expect(layout.cells[2]).toMatchObject({ x: 80, y: 48, width: 220, height: 48, textWidth: 220 });
    expect(layout.height).toBe(123);
  });

  it('extends the blank canvas for unwrapped prose without changing column sizes', () => {
    const sheet = fixture();
    sheet.cells = [sheet.cells[0]];
    const layout = prepareWorkbookLayout(sheet);
    expect(layout.width).toBeGreaterThan(700);
    expect(layout.xs.slice(0, 5)).toEqual([0, 80, 180, 300, 380]);
  });

  it('renders literal source text safely and overlays the original image at its stored position', () => {
    const html = renderToStaticMarkup(<WorkbookCanvas sheet={fixture()} />);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('left:87px;top:33px;width:160px;height:90px');
    expect(html).toContain('data-cell="B3"');
  });
});
