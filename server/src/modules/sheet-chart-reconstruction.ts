import JSZip from 'jszip';

type Chart = Record<string, any>;
const esc = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Add a simple, data-linked pie chart to a sheet without a pre-existing drawing.
 * All unsupported charts stay in the sidecar, never silently discarded. */
export async function addPieChart(zip: JSZip, sheetIndex: number, chart: Chart): Promise<boolean> {
  const d = chart.details, snap = d?.snapshot, data = snap?.data;
  const plot = snap?.plotArea?.plot;
  const ref = data?.refs?.[0]?.value;
  const match = typeof ref === 'string' && /^('(?:[^']|'')+'|[^!]+)!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(ref);
  if (plot?.type !== 'pie' || data?.direction !== 'column' || data?.isStaticData !== false || data?.refs?.length !== 1
    || !match || Number(match[3]) >= Number(match[5]) || data?.dim1?.serie?.index !== 1
    || data?.dim2?.series?.length !== 1 || data.dim2.series[0].index !== 2
    || [...match[4]].reduce((n: number, c: string) => n * 26 + c.charCodeAt(0) - 64, 0) !== [...match[2]].reduce((n: number, c: string) => n * 26 + c.charCodeAt(0) - 64, 0) + 1
    || !d.position || !d.size
    || !/^[A-Z]+$/.test(d.position.col) || !Number.isInteger(d.position.row)
    || !Number.isFinite(d.size.width) || !Number.isFinite(d.size.height) || d.size.width <= 0 || d.size.height <= 0) return false;
  const sheetFile = `xl/worksheets/sheet${sheetIndex}.xml`;
  const sheet = zip.file(sheetFile);
  if (!sheet) return false;
  let xml = await sheet.async('string');
  if (/<(?:\w+:)?drawing\b/.test(xml)) return false;
  const relsPath = `xl/worksheets/_rels/sheet${sheetIndex}.xml.rels`;
  let rels = zip.file(relsPath) ? await zip.file(relsPath)!.async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const rid = `rId${Math.max(0, ...ids) + 1}`;
  const suffix = `fs${sheetIndex}`;
  const col = [...d.position.col].reduce((n: number, c: string) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const row = d.position.row;
  const offsetX = Math.round(Number(d.offset?.col_offset ?? 0) * 9525), offsetY = Math.round(Number(d.offset?.row_offset ?? 0) * 9525);
  if (row < 0 || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return false;
  const drawing = `xl/drawings/drawing-${suffix}.xml`, chartPath = `xl/charts/chart-${suffix}.xml`;
  if (zip.file(drawing) || zip.file(chartPath)) return false;
  const range = (column: string) => `${match[1]}!$${column}$${Number(match[3]) + 1}:$${column}$${match[5]}`;
  const legend = ['right', 'left', 'top', 'bottom'].includes(snap.legend?.position) ? ({ right: 'r', left: 'l', top: 't', bottom: 'b' } as Record<string, string>)[snap.legend.position] : 'r';
  const title = esc(snap.title?.text ?? '');
  zip.file(chartPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/><c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strRef><c:f>${esc(range(match[2]))}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${esc(range(match[4]))}</c:f></c:numRef></c:val></c:ser></c:pieChart></c:plotArea><c:legend><c:legendPos val="${legend}"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="${data.includeHiddenOrFilter ? 0 : 1}"/></c:chart></c:chartSpace>`);
  zip.file(drawing, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${offsetX}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${offsetY}</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(d.size.width * 9525)}" cy="${Math.round(d.size.height * 9525)}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="1" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`);
  zip.file(`xl/drawings/_rels/drawing-${suffix}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart-${suffix}.xml"/></Relationships>`);
  rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing-${suffix}.xml"/></Relationships>`);
  xml = xml.replace('</worksheet>', `<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/></worksheet>`);
  const types = await zip.file('[Content_Types].xml')!.async('string');
  zip.file('[Content_Types].xml', types.replace('</Types>', `<Override PartName="/${drawing}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/${chartPath}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`));
  zip.file(sheetFile, xml); zip.file(relsPath, rels);
  return true;
}
