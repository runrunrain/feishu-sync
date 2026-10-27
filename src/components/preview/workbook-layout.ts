import type { WorkbookCell, WorkbookSheetLayout } from '../../types/workbook';

export function cumulativeSizes(sizes: number[]): number[] {
  const result = [0];
  for (const size of sizes) result.push(result[result.length - 1] + size);
  return result;
}

export interface PositionedWorkbookCell {
  cell: WorkbookCell;
  x: number;
  y: number;
  width: number;
  height: number;
  textWidth: number;
}

/** Layout is independent of the viewport, so scrolling cannot change overflow. */
export function prepareWorkbookLayout(sheet: WorkbookSheetLayout) {
  const columns = [...sheet.columns];
  const originalXs = cumulativeSizes(columns);
  let desiredWidth = originalXs[originalXs.length - 1];
  for (const cell of sheet.cells) {
    if (cell.wrap || cell.horizontal !== 'left') continue;
    const estimated = Array.from(cell.text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 1 : 0.62), 0) * (cell.font.size ?? 14.67);
    desiredWidth = Math.max(desiredWidth, (originalXs[cell.column] ?? 0) + estimated + 12);
  }
  for (const image of sheet.images) desiredWidth = Math.max(desiredWidth, image.x + image.width);
  while (columns.length < 1024 && columns.reduce((a, b) => a + b, 0) < desiredWidth) columns.push(64);
  const xs = cumulativeSizes(columns), ys = cumulativeSizes(sheet.rows);
  const width = xs[xs.length - 1];
  const height = Math.max(ys[ys.length - 1], ...sheet.images.map((image) => image.y + image.height));
  const merges = new Map(sheet.merges.map((merge) => [`${merge.top}:${merge.left}`, merge]));
  const occupied = new Map<number, Array<{ left: number; right: number }>>();
  const occupy = (row: number, left: number, right: number) => {
    const list = occupied.get(row) ?? [];
    list.push({ left, right });
    occupied.set(row, list);
  };
  for (const cell of sheet.cells) {
    if (cell.text || cell.fill) occupy(cell.row, cell.column, cell.column);
  }
  for (const merge of sheet.merges) {
    for (let row = merge.top; row <= Math.min(merge.bottom, sheet.rows.length - 1); row++) occupy(row, merge.left, merge.right);
  }
  for (const list of occupied.values()) list.sort((a, b) => a.left - b.left);
  const cells: PositionedWorkbookCell[] = sheet.cells.map((cell) => {
    const merge = merges.get(`${cell.row}:${cell.column}`);
    const x = xs[cell.column], y = ys[cell.row];
    const right = Math.min((merge?.right ?? cell.column) + 1, xs.length - 1);
    const bottom = Math.min((merge?.bottom ?? cell.row) + 1, ys.length - 1);
    const cellWidth = xs[right] - x;
    let textWidth = cellWidth;
    if (!merge && !cell.wrap && cell.horizontal === 'left') {
      const blockers = occupied.get(cell.row) ?? [];
      let low = 0, high = blockers.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (blockers[mid].left <= cell.column) low = mid + 1;
        else high = mid;
      }
      textWidth = (blockers[low] ? xs[blockers[low].left] : width) - x;
    }
    return { cell, x, y, width: cellWidth, height: ys[bottom] - y, textWidth };
  });
  return { xs, ys, width, height, cells };
}
