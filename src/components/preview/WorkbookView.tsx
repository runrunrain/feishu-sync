import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { getWorkbookBlob, getWorkbookPreview } from '../../api/client';
import type { WorkbookCell, WorkbookFont, WorkbookPreview, WorkbookSheetLayout } from '../../types/workbook';
import { prepareWorkbookLayout } from './workbook-layout';

function fontStyle(font: WorkbookFont): CSSProperties {
  return {
    fontFamily: `${font.name ? `"${font.name.replace(/["\\]/g, '')}", ` : ''}"Microsoft YaHei", Calibri, sans-serif`,
    fontSize: font.size ?? 14.67, color: font.color ?? '#000',
    fontWeight: font.bold ? 700 : 400, fontStyle: font.italic ? 'italic' : 'normal',
    textDecoration: [font.underline ? 'underline' : '', font.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
  };
}

function borderStyle(cell: WorkbookCell): CSSProperties {
  const style: CSSProperties = {};
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    const border = cell.borders[edge];
    if (!border) continue;
    const width = border.style === 'thick' ? 3 : border.style.startsWith('medium') || border.style === 'double' ? 2 : 1;
    const line = border.style === 'double' ? 'double' : /dash/i.test(border.style) ? 'dashed' : border.style === 'dotted' ? 'dotted' : 'solid';
    const key = `border${edge[0].toUpperCase()}${edge.slice(1)}` as keyof CSSProperties;
    Object.assign(style, { [key]: `${width}px ${line} ${border.color}` });
  }
  return style;
}

/** Virtualized read-only canvas. Cells retain native geometry at every zoom. */
export function WorkbookCanvas({ sheet, zoom = 1 }: { sheet: WorkbookSheetLayout; zoom?: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, top: 0, width: 1200, height: 600 });
  const layout = useMemo(() => prepareWorkbookLayout(sheet), [sheet]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setView({ left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  const left = view.left / zoom - 100, top = view.top / zoom - 100;
  const right = (view.left + view.width) / zoom + 100, bottom = (view.top + view.height) / zoom + 100;
  const visible = layout.cells.filter((item) => item.width > 0 && item.height > 0 && item.x < right && item.x + item.textWidth > left && item.y < bottom && item.y + item.height > top);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={viewport}
        className="min-h-[320px] flex-1 overflow-auto bg-white scrollbar-thin"
        style={{ height: 'min(62vh, 680px)' }}
        aria-label={`${sheet.name} Excel 画板`}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          setView({ left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight });
        }}
      >
        <div style={{ position: 'relative', width: layout.width * zoom, height: layout.height * zoom }}>
          <div style={{ position: 'absolute', width: layout.width, height: layout.height, transform: `scale(${zoom})`, transformOrigin: 'top left', color: '#000', background: '#fff' }}>
            {sheet.showGridLines && (
              <svg aria-hidden style={{ position: 'absolute', inset: 0, width: layout.width, height: layout.height, pointerEvents: 'none' }}>
                <g stroke="#e2e5e9" strokeWidth="0.6">
                  {layout.xs.filter((x) => x >= left && x <= right).map((x, index) => <line key={`x${index}`} x1={x} y1={Math.max(0, top)} x2={x} y2={Math.min(layout.height, bottom)} />)}
                  {layout.ys.filter((y) => y >= top && y <= bottom).map((y, index) => <line key={`y${index}`} x1={Math.max(0, left)} y1={y} x2={Math.min(layout.width, right)} y2={y} />)}
                </g>
              </svg>
            )}
            {visible.map(({ cell, x, y, width, height }) => (
              <div key={`${cell.address}-background`} style={{ position: 'absolute', left: x, top: y, width, height, background: cell.fill ?? (sheet.merges.some((merge) => merge.top === cell.row && merge.left === cell.column) ? '#fff' : undefined), boxSizing: 'border-box', ...borderStyle(cell) }} />
            ))}
            {visible.filter(({ cell }) => cell.text).map(({ cell, x, y, width, height, textWidth }) => (
              <div
                key={cell.address}
                data-cell={cell.address}
                title={`${cell.address}${cell.formula ? ` · =${cell.formula}` : ''}\n${cell.text}`}
                style={{
                  position: 'absolute', zIndex: 1, left: x, top: y, width: textWidth, height,
                  overflow: 'hidden', display: 'flex',
                  alignItems: cell.vertical === 'top' ? 'flex-start' : cell.vertical === 'middle' ? 'center' : 'flex-end',
                  justifyContent: cell.horizontal === 'right' ? 'flex-end' : cell.horizontal === 'center' ? 'center' : 'flex-start',
                  padding: `1px 3px 1px ${3 + (cell.indent ?? 0) * 12}px`, boxSizing: 'border-box',
                  ...fontStyle(cell.font),
                }}
              >
                <span style={{ whiteSpace: cell.wrap ? 'pre-wrap' : 'pre', overflowWrap: cell.wrap ? 'anywhere' : undefined, lineHeight: 1.15, flexShrink: 0, maxWidth: cell.wrap ? width - 6 : undefined, transform: cell.rotation ? `rotate(${-cell.rotation}deg)` : undefined }}>
                  {cell.richText ? cell.richText.map((run, index) => <span key={index} style={fontStyle(run.font)}>{run.text}</span>) : cell.text}
                </span>
              </div>
            ))}
            {sheet.images.filter((image) => image.x < right && image.x + image.width > left && image.y < bottom && image.y + image.height > top).map((image, index) => (
              <img key={image.id} alt={`${sheet.name} 图片 ${index + 1}`} src={image.dataUrl} draggable={false} style={{ position: 'absolute', zIndex: 2, left: image.x, top: image.y, width: image.width, height: image.height, maxWidth: 'none', objectFit: 'fill' }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function WorkbookView({ objToken, fileName, toolbarTarget }: { objToken: string; fileName: string; toolbarTarget?: HTMLElement | null }) {
  const [preview, setPreview] = useState<WorkbookPreview | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>(1);
  const panel = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(800);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!panel.current) return;
    const element = panel.current;
    const update = () => setPanelWidth(element.clientWidth);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  const canvasWidth = useMemo(() => preview ? prepareWorkbookLayout(preview.sheet).width : 800, [preview]);
  const actualZoom = zoom === 'fit' ? Math.min(2, Math.max(0.05, (panelWidth - 18) / canvasWidth)) : zoom;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getWorkbookPreview(objToken, sheetIndex, controller.signal).then((data) => {
      if (!controller.signal.aborted) setPreview(data);
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Excel 预览失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [objToken, sheetIndex, retry]);
  const download = async () => {
    setDownloading(true);
    try {
      const blob = await getWorkbookBlob(objToken);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName.split(/[\\/]/).pop() || '画板.xlsx';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError(err instanceof Error ? err.message : 'Excel 原件下载失败'); }
    finally { setDownloading(false); }
  };
  const toolbar = (
      <div className="flex items-center justify-end gap-3 text-xs text-ink-soft">
        <label className="flex items-center gap-1.5">缩放
          <select aria-label="Excel 缩放比例" value={zoom} onChange={(e) => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value))} className="rounded border border-line bg-card-bg px-1 py-1">
            <option value="fit">适合宽度</option>
            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value * 100}%</option>)}
          </select>
        </label>
        <button type="button" disabled={downloading} onClick={() => void download()} className="inline-flex items-center gap-1.5 hover:text-seal disabled:opacity-50">
          {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}下载 Excel
        </button>
      </div>
  );
  return (
    <div ref={panel} className="flex min-h-[460px] h-full flex-col">
      {toolbarTarget === undefined
        ? <div className="shrink-0 border-b border-line bg-paper/60 px-3 py-2">{toolbar}</div>
        : toolbarTarget ? createPortal(toolbar, toolbarTarget) : null}
      {error ? <div role="alert" className="px-4 py-6 text-xs text-seal">{error}<button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-3 inline-flex items-center gap-1"><RefreshCw className="h-3 w-3" />重试</button></div> : null}
      {loading ? <div className="flex min-h-[320px] flex-1 items-center justify-center gap-2 text-xs text-ink-faint"><Loader2 className="h-4 w-4 animate-spin" />正在读取 Excel 布局…</div> : preview && !error ? (
        <>
          {preview.sheet.warnings.length > 0 && <div className="shrink-0 max-h-24 overflow-auto border-b border-line bg-paper px-3 py-2 text-[11px] text-ink-soft">{preview.sheet.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
          <WorkbookCanvas key={`${objToken}-${sheetIndex}-${retry}`} sheet={preview.sheet} zoom={actualZoom} />
        </>
      ) : null}
      {preview && <div className="flex shrink-0 overflow-x-auto gap-1 border-t border-line bg-paper/70 px-2 py-1.5" role="tablist" aria-label="Excel 工作表">
        {preview.sheets.map((sheet) => <button key={sheet.index} type="button" role="tab" aria-selected={sheet.index === sheetIndex} onClick={() => setSheetIndex(sheet.index)} className={`shrink-0 rounded-sm border px-3 py-1.5 text-xs ${sheet.index === sheetIndex ? 'border-jade/40 bg-jade/10 text-jade' : 'border-transparent text-ink-soft hover:bg-card-bg'}`}>{sheet.name}{sheet.state !== 'visible' ? '（隐藏）' : ''}</button>)}
      </div>}
    </div>
  );
}
