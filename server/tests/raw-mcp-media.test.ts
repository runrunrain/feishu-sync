/** Isolated workbook, images and reference graph; no production data or cloud access. */
import { beforeAll, beforeEach, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import ExcelJS from 'exceljs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeRawCatalog } from '../src/kb/raw-mcp-catalog.js';
import { RawQueryService } from '../src/kb/raw-query-service.js';
import type { SourceReferenceRow } from '../src/modules/local-map-store.js';
import type { DocumentRecord } from '../src/types/index.js';

let root: string, raw: string, catalog: string, records: DocumentRecord[], png: Buffer;
beforeAll(async () => { const { bundleMcp, bundleGateway } = await import('../scripts/lib/mcp-bundle.mjs'); await bundleMcp(); await bundleGateway(); });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-mcp-media-')); raw = path.join(root, 'raw'); catalog = path.join(root, 'mcp/raw-catalog.json');
  fs.mkdirSync(path.join(raw, 'images'), { recursive: true }); records = [];
  png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1wAAAAASUVORK5CYII=', 'base64');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function fixture() {
  fs.writeFileSync(path.join(raw, 'images/diagram.png'), png);
  fs.writeFileSync(path.join(raw, '表格.md'), '<!--\nfeishu_sync:\n  source_workbook: "表格.xlsx"\n-->\n# 表格\n![战场示意](images/diagram.png)\n![缺失图](images/missing.png)\n');
  fs.writeFileSync(path.join(raw, '目标.md'), '# 目标\n正文');
  const wb = new ExcelJS.Workbook(), sheet = wb.addWorksheet('设计'), second = wb.addWorksheet('公式');
  sheet.getCell('A1').value = '字段'; sheet.getCell('B1').value = '数值'; sheet.getCell('A2').value = '攻击力';
  sheet.getCell('B2').value = 42.5; sheet.getCell('B2').numFmt = '0.00';
  sheet.getCell('C2').value = { formula: 'B2*2', result: 85 };
  sheet.getCell('D2').value = { text: '来源链接', hyperlink: 'https://example.test/doc' };
  sheet.getCell('A3').value = { richText: [{ text: '世界' }, { text: '规则' }] };
  sheet.mergeCells('A4:B4'); sheet.getCell('A4').value = '合并内容';
  second.getCell('A1').value = { formula: '1+1', result: 2 };
  const imageId = wb.addImage({ buffer: png, extension: 'png' });
  sheet.addImage(imageId, { tl: { col: 1, row: 5 }, ext: { width: 32, height: 32 } });
  await wb.xlsx.writeFile(path.join(raw, '表格.xlsx'));
  records = [
    { objToken: 'src', wikiNodeToken: 'wiki-src', title: '表格', localRelPath: '表格.md', objType: 'sheet', status: 'synced' },
    { objToken: 'dest', wikiNodeToken: 'wiki-dest', title: '目标', localRelPath: '目标.md', objType: 'docx', status: 'synced' },
  ] as DocumentRecord[];
  const hash = crypto.createHash('sha256').update(png).digest('hex');
  const bucket = path.join(root, 'agent/vision-cache', hash.slice(0, 2)); fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, `${hash}.json`), JSON.stringify({ imageHash: hash, text: '一张包含地形箭头的棋盘', createdAt: '2026-01-01T00:00:00Z' }));
  const edge: SourceReferenceRow = { srcObjToken: 'src', targetToken: 'wiki-dest', targetType: 'wiki', origin: 'body', kind: 'link', label: null, occurrences: 2, updatedAt: '2026-01-01' };
  writeRawCatalog(catalog, raw, records, () => [], (doc) => ({ out: doc.objToken === 'src' ? [edge] : [],
    in: doc.objToken === 'dest' ? [{ ...edge, srcTitle: '表格', srcLocalRelPath: '表格.md' }] : [] }));
  return { hash, workbook: path.join(raw, '表格.xlsx') };
}
const svc = () => new RawQueryService(catalog);

it('reads actual worksheet cells, formulas, values, links, merges and verifies workbook changes', async () => {
  const { workbook } = await fixture();
  const listed: any = await svc().call('raw_list_sheets', { objToken: 'src', limit: 1 }, 6000);
  expect(listed.sheets).toMatchObject([{ name: '设计', imageCount: 1 }]); expect(listed.nextOffset).toBe(1);
  const second: any = await svc().call('raw_list_sheets', { objToken: 'src', offset: 1, contentHash: listed.contentHash }, 6000);
  expect(second.sheets[0].name).toBe('公式');
  const page: any = await svc().call('raw_read_sheet', { objToken: 'src', sheet: '设计', endRow: 5, endColumn: 5, limit: 100 }, 6000);
  expect(page.cells).toEqual(expect.arrayContaining([
    expect.objectContaining({ address: 'A2', text: '攻击力' }),
    expect.objectContaining({ address: 'B2', text: '42.50' }),
    expect.objectContaining({ address: 'C2', text: '85', formula: 'B2*2' }),
    expect.objectContaining({ address: 'D2', text: '来源链接', hyperlink: 'https://example.test/doc' }),
    expect.objectContaining({ address: 'A3', text: '世界规则' }),
    expect.objectContaining({ address: 'B4', mergedInto: 'A4' }),
  ]));
  const searched: any = await svc().call('raw_search_sheet', { objToken: 'src', query: '攻击力' }, 6000);
  expect(searched).toMatchObject({ complete: true, cells: [{ sheet: '设计', address: 'A2', text: '攻击力' }] });
  const formula: any = await svc().call('raw_search_sheet', { objToken: 'src', query: 'b2*2', sheet: '设计' }, 6000);
  expect(formula.cells).toMatchObject([{ address: 'C2', formula: 'B2*2' }]);
  await expect(svc().call('raw_read_sheet', { objToken: 'src', sheet: '不存在' }, 6000)).rejects.toMatchObject({ code: 'raw_not_found' });
  await expect(svc().call('raw_list_sheets', { objToken: 'dest' }, 6000)).rejects.toMatchObject({ code: 'raw_workbook_unavailable' });
  const next = new ExcelJS.Workbook(); await next.xlsx.readFile(workbook); next.getWorksheet('设计')!.getCell('A1').value = '已变化'; await next.xlsx.writeFile(workbook);
  await expect(svc().call('raw_read_sheet', { objToken: 'src', sheet: '设计', contentHash: page.contentHash }, 6000)).rejects.toMatchObject({ code: 'raw_changed' });
});

it('finds cached descriptions, reads document and XLSX images, rejects missing or unreferenced paths', async () => {
  const { hash } = await fixture();
  const listed: any = await svc().call('raw_list_images', { objToken: 'src' }, 6000);
  expect(listed.workbookStatus).toBe('checked');
  expect(listed.images).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: 'images/diagram.png', available: true, imageHash: hash, description: '一张包含地形箭头的棋盘' }),
    expect.objectContaining({ src: 'images/missing.png', available: false }),
    expect.objectContaining({ src: 'workbook:0:0', origin: 'workbook', sheet: '设计', imageHash: hash }),
  ]));
  const found: any = await svc().call('raw_search_images', { query: '棋盘', maxSources: 1 }, 6000);
  expect(found.images).toEqual(expect.arrayContaining([expect.objectContaining({ src: 'images/diagram.png' }),
    expect.objectContaining({ src: 'workbook:0:0', origin: 'workbook' })])); expect(found.nextSourceOffset).toBe(1);
  const image: any = await svc().call('raw_read_image', { objToken: 'src', src: 'workbook:0:0', imageHash: hash }, 6000);
  expect(Buffer.from(image.data, 'base64')).toEqual(png); expect(image.image.mimeType).toBe('image/png');
  await expect(svc().call('raw_read_image', { objToken: 'src', src: 'images/missing.png' }, 6000)).rejects.toMatchObject({ code: 'raw_image_unavailable' });
  await expect(svc().call('raw_read_image', { objToken: 'src', src: '../secret.png' }, 6000)).rejects.toMatchObject({ code: 'raw_image_unavailable' });
  await expect(svc().call('raw_read_image', { objToken: 'src', src: 'images/diagram.png', imageHash: 'f'.repeat(64) }, 6000)).rejects.toMatchObject({ code: 'raw_changed' });
});

it('reuses the cached description of an image above the inline size limit without returning its bytes', async () => {
  await fixture();
  const large = Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]), hash = crypto.createHash('sha256').update(large).digest('hex');
  fs.writeFileSync(path.join(raw, 'images/large.png'), large);
  fs.appendFileSync(path.join(raw, '表格.md'), '\n![大型白板](images/large.png)');
  const bucket = path.join(root, 'agent/vision-cache', hash.slice(0, 2)); fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, `${hash}.json`), JSON.stringify({ imageHash: hash, text: '已缓存的大图说明' }));
  const listed: any = await svc().call('raw_list_images', { objToken: 'src' }, 6000);
  expect(listed.images).toEqual(expect.arrayContaining([expect.objectContaining({ src: 'images/large.png', reason: 'too_large', description: '已缓存的大图说明' })]));
  const description: any = await svc().call('raw_read_image', { objToken: 'src', src: 'images/large.png', includeImage: false, imageHash: hash }, 6000);
  expect(description).not.toHaveProperty('data'); expect(description.image.description).toBe('已缓存的大图说明');
  await expect(svc().call('raw_read_image', { objToken: 'src', src: 'images/large.png' }, 6000)).rejects.toMatchObject({ code: 'raw_image_unavailable' });
});

it('reports a missing managed workbook rather than treating it as a document without one', async () => {
  const { workbook } = await fixture(); fs.unlinkSync(workbook);
  await expect(svc().call('raw_list_sheets', { objToken: 'src' }, 6000)).rejects.toMatchObject({ code: 'raw_workbook_unreadable' });
  const images: any = await svc().call('raw_list_images', { objToken: 'src' }, 6000);
  expect(images.workbookStatus).toBe('unreadable');
  expect(images.images).toEqual(expect.arrayContaining([expect.objectContaining({ src: 'images/diagram.png', available: true })]));
  const search: any = await svc().call('raw_search_images', { query: '棋盘', maxSources: 1 }, 6000);
  expect(search.unreadableWorkbooks).toBe(1);
});

it('resolves out/in references using object and wiki identity, and distinguishes unavailable index from zero links', async () => {
  await fixture();
  const out: any = await svc().call('raw_links', { objToken: 'src', direction: 'out' }, 6000);
  expect(out).toMatchObject({ outCount: 1, inCount: 0, links: [{ direction: 'out', objToken: 'dest', localRelPath: '目标.md', occurrences: 2, synced: true }] });
  const incoming: any = await svc().call('raw_links', { objToken: 'dest', direction: 'in' }, 6000);
  expect(incoming).toMatchObject({ inCount: 1, links: [{ direction: 'in', objToken: 'src', title: '表格' }] });
  writeRawCatalog(catalog, raw, records, () => []);
  await expect(svc().call('raw_links', { objToken: 'src' }, 6000)).rejects.toMatchObject({ code: 'raw_references_unavailable' });
});

it('keeps Pi worksheet pages within its byte budget while returning every requested cell', async () => {
  const { workbook } = await fixture();
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(workbook);
  for (let i = 10; i < 70; i++) wb.getWorksheet('设计')!.getCell(`A${i}`).value = `第${i}项` + '内容'.repeat(100);
  await wb.xlsx.writeFile(workbook);
  const client = new Client({ name: 'pi', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp/kb-mcp.cjs'), '--kb-root', path.join(root, 'standard'), '--raw-catalog', catalog], stderr: 'pipe' }));
    let offset = 0, contentHash: string | undefined, pages = 0; const addresses: string[] = [];
    do {
      const result = await client.callTool({ name: 'raw_read_sheet', arguments: { objToken: 'src', sheet: '设计', startRow: 10, endRow: 69,
        endColumn: 1, offset, ...(contentHash ? { contentHash } : {}) } });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(20_000);
      const data = JSON.parse(text); contentHash = data.contentHash; addresses.push(...data.cells.map((cell: { address: string }) => cell.address));
      offset = data.nextOffset; pages++; expect(pages).toBeLessThan(20);
    } while (offset !== null);
    expect(pages).toBeGreaterThan(1); expect(addresses).toHaveLength(60); expect(new Set(addresses).size).toBe(60);
  } finally { await client.close(); }
});

it('real bundled stdio and LAN gateway return identical workbooks, images and references', async () => {
  const { hash } = await fixture();
  const server = net.createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>((resolve) => server.close(() => resolve()));
  const token = 'fskb_' + 'a'.repeat(43), digest = crypto.createHash('sha256').update(token).digest('hex');
  const gateway: ChildProcess = spawn(process.execPath, [path.resolve('dist/mcp/kb-mcp-gateway.cjs'), '--kb-root', path.join(root, 'standard'),
    '--raw-catalog', catalog, '--host', '127.0.0.1', '--port', String(port)], { env: { KB_LAN_TOKEN_SHA256: digest }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; gateway.stdout!.on('data', (chunk: Buffer) => { logs += chunk.toString(); }); gateway.stderr!.resume();
  const local = new Client({ name: 'media-parity', version: '1' }), remote = new Client({ name: 'media-parity', version: '1' });
  try {
    await new Promise<void>((resolve, reject) => {
      const start = Date.now(); const tick = () => { if (logs.includes('"type":"ready"')) resolve();
        else if (gateway.exitCode !== null || Date.now() - start > 8000) reject(new Error('gateway failed to start')); else setTimeout(tick, 25); }; tick();
    });
    await local.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp/kb-mcp.cjs'), '--kb-root', path.join(root, 'standard'), '--raw-catalog', catalog], stderr: 'pipe' }));
    await remote.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    expect((await local.listTools()).tools).toEqual((await remote.listTools()).tools);
    for (const [name, args] of [
      ['raw_list_sheets', { objToken: 'src' }], ['raw_search_sheet', { objToken: 'src', query: '攻击力' }], ['raw_read_sheet', { objToken: 'src', sheet: '设计', endRow: 5, endColumn: 5 }],
      ['raw_list_images', { objToken: 'src' }], ['raw_search_images', { query: '棋盘' }],
      ['raw_read_image', { objToken: 'src', src: 'workbook:0:0', imageHash: hash }], ['raw_links', { objToken: 'dest' }],
    ] as const) {
      const request = { name, arguments: args }, a = await local.callTool(request), b = await remote.callTool(request);
      expect(a.isError, name).not.toBe(true); expect(a, name).toEqual(b);
      if (name === 'raw_read_image') expect((a.content as Array<{ type: string }>).map((item) => item.type)).toEqual(['text', 'image']);
    }
  } finally {
    await local.close(); await remote.close();
    if (gateway.exitCode === null && gateway.signalCode === null) { gateway.kill(); await new Promise<void>((resolve) => gateway.once('close', () => resolve())); }
  }
}, 20000);
