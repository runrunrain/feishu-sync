import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { stageSourceWorkbook, readWorkbookPreview } from '../src/modules/sheet-workbook.js';
import { reconstructWorkbookFromReads, type WorkbookReadClient } from '../src/modules/sheet-read-reconstruction.js';
import { LarkCliClient, LarkCliError } from '../src/modules/lark-cli-client.js';
import { syncSheetToCustomFolder } from '../src/modules/custom-doc-sync.js';
import { commitDocumentContent } from '../src/modules/content-commit.js';
import { computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { contentRoutes } from '../src/routes/content.js';
import { cleanupSources } from '../src/kb/source-cleanup.js';
import { exportTestWorkbook } from './helpers/workbook.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const dirs: string[] = [];
function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbook-test-'));
  dirs.push(directory);
  return directory;
}
afterEach(() => { for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function readClient() {
  const calls: string[] = [];
  const client: WorkbookReadClient & { exportWorkbook: typeof exportTestWorkbook } = {
    exportWorkbook: async () => { throw new LarkCliError('no export permission', 'permission', false, '1069902'); },
    getWorkbookInfo: async () => ({ data: { revision: 41, sheets: [{
      sheet_id: 's1', sheet_name: '画板', row_count: 6, column_count: 5,
      float_image_count: 1, merged_cells_count: 1, chart_count: 0, pivot_table_count: 0, resource_type: 'sheet',
    }] } }),
    getSheetLayout: async () => ({ data: { revision: 41,
      row_heights: [{ rows: '1:2', height: 24 }, { rows: '3:6', height: 32 }],
      column_widths: [{ cols: 'A:B', width: 80 }, { cols: 'C:E', width: 120 }],
      hidden_rows: ['6'], hidden_columns: ['E'],
      merged_cells: [{ range: 'B5:C5' }], row_groups: [], column_groups: [],
    } }),
    getSheetCells: async (options) => {
      calls.push(`${options.range}:${Boolean(options.formulas)}`);
      const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(options.range)!;
      const left = match[1].charCodeAt(0) - 64, right = match[3].charCodeAt(0) - 64;
      const top = Number(match[2]), bottom = Number(match[4]);
      const content: Record<string, any> = {
        A1: { value: '完整说明文字', cell_styles: { font_family: 'Microsoft YaHei', font_size: 10.5, font_weight: 'bold', background_color: '#DDEEFF', font_color: '#112233' } },
        B2: { value: options.formulas ? '=2+2' : 4 },
        C2: { value: '=literal text' },
        B3: { value: '上行\n下行', cell_styles: { word_wrap: 'auto-wrap' } },
        D4: { value: 0 }, E4: { value: '链接', rich_text: [{ type: 'link', text: '链接', link: 'https://example.com/reference' }] },
        B5: { value: '局部横向合并' },
      };
      return { data: { revision: 41, has_more: false, ranges: [{
        range: options.range, actual_range: options.range, truncated: false,
        row_indices: Array.from({ length: bottom - top + 1 }, (_, i) => top + i),
        col_indices: Array.from({ length: right - left + 1 }, (_, i) => String.fromCharCode(64 + left + i)),
        cells: Array.from({ length: bottom - top + 1 }, (_, r) => Array.from({ length: right - left + 1 }, (_, c) => content[`${String.fromCharCode(64 + left + c)}${top + r}`] ?? {})),
      }] } };
    },
    getSheetFloatImages: async () => ({ data: { revision: 41, total: 1, sheets: [{ sheet_id: 's1', float_images: [{
      float_image_id: 'image1', image_token: 'token1', address: 'D2',
      position: { col: 'D', row: 1 }, offset: { col_offset: 7, row_offset: 9 }, size: { width: 80, height: 48 }, z_index: 1,
    }] }] } }),
    downloadMedia: async (_token, outputPath) => { fs.writeFileSync(`${outputPath}.png`, PNG); return `${outputPath}.png`; },
    previewMedia: async () => { throw new Error('preview should not be used'); },
  };
  return { client, calls };
}

describe('native workbook source and authorized read reconstruction', () => {
  it('reads 1024 rows in eight requests instead of the former 32 without dropping data', async () => {
    const { client, calls } = readClient(); const info = client.getWorkbookInfo; const layout = client.getSheetLayout;
    client.getWorkbookInfo = async () => { const result = await info('token'); result.data.sheets[0].row_count = 1024; return result; };
    client.getSheetLayout = async (options) => { const result = await layout(options); result.data.row_heights = [{ rows: '1:1024', height: 24 }]; return result; };
    const manifest = await reconstructWorkbookFromReads(client, 'token', path.join(temporary(), 'large.xlsx'));
    expect(calls).toHaveLength(8); expect(manifest.sheets[0].cells).toBe(7); expect(manifest.sheets[0].rows).toBe(1024);
  });
  it('uses the controlled export cwd and keeps comma-separated include flags in a single argument', async () => {
    const directory = temporary(), client = new LarkCliClient({ requiredScopes: [] });
    const calls: Array<{ args: string[]; options: any }> = [];
    (client as any).execute = async (args: string[], _api: string, options: any) => {
      calls.push({ args, options });
      if (args[1] === '+workbook-export') {
        await exportTestWorkbook('token', path.join(options.cwd, args[args.indexOf('--output-path') + 1]));
      }
      return { ok: true, data: {} };
    };
    expect(await client.exportWorkbook('token', path.join(directory, '原件.xlsx'))).toBe(path.join(directory, '原件.xlsx'));
    expect(calls[0].options).toMatchObject({ cwd: directory, timeoutMs: 120_000 });
    expect(calls[0].args).toContain('原件.xlsx');
    await client.getSheetLayout({ spreadsheetToken: 'token', sheetId: 's1' });
    await client.getSheetCells({ spreadsheetToken: 'token', sheetId: 's1', range: 'A1:B2', formulas: true });
    expect(calls[1].args).toContain('merges,row_heights,col_widths,hidden_rows,hidden_cols,groups,frozen');
    expect(calls[2].args).toContain('value,formula,style');
    expect(calls[2].args).toContain('--skip-hidden=false');
    (client as any).execute = async () => ({ ok: true, data: { status: 'running' } });
    await expect(client.exportWorkbook('token', path.join(directory, 'pending.xlsx'))).rejects.toThrow('尚未导出完成');
  });

  it('preserves the native archive bytes, writes provenance, and rejects manual-file collisions', async () => {
    const directory = temporary();
    let bytes: Buffer | undefined;
    const source = await stageSourceWorkbook({ exportWorkbook: async (token, outputPath) => {
      await exportTestWorkbook(token, outputPath);
      bytes = fs.readFileSync(outputPath);
      return outputPath;
    } }, 'token', directory, path.join(directory, 'Doc.md'));
    expect(fs.readFileSync(source.absolutePath)).toEqual(bytes);
    expect(source.mode).toBe('native');
    expect(JSON.parse(fs.readFileSync(source.metadataPath, 'utf-8')).sha256).toHaveLength(64);
    fs.unlinkSync(source.metadataPath);
    await expect(stageSourceWorkbook({ exportWorkbook: exportTestWorkbook }, 'token', directory, path.join(directory, 'Doc.md'))).rejects.toThrow('未纳管');
  });

  it('rebuilds a workbook without export permission, keeping geometry, values, formulas, styles and image bytes', async () => {
    const directory = temporary();
    const { client } = readClient();
    const source = await stageSourceWorkbook(client, 'token', directory, path.join(directory, '画板.md'));
    expect(source.mode).toBe('read-reconstruction');
    const manifest = JSON.parse(fs.readFileSync(source.metadataPath, 'utf-8'));
    expect(manifest.sheets[0]).toMatchObject({ rows: 6, columns: 5, cells: 7, merges: 1, images: 1 });
    const preview = await readWorkbookPreview(source.absolutePath, 0);
    expect(preview.sheet.rows.slice(0, 6)).toEqual([24, 24, 32, 32, 32, 0]);
    expect(preview.sheet.columns.slice(0, 5)).toEqual([80, 80, 120, 120, 0]);
    expect(preview.sheet.merges).toEqual([{ top: 4, left: 1, bottom: 4, right: 2 }]);
    expect(preview.sheet.images[0]).toMatchObject({ x: 287, y: 33, width: 80, height: 48 });
    expect(preview.sheet.images[0].dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(preview.sheet.cells.find((cell) => cell.address === 'A1')).toMatchObject({ text: '完整说明文字', fill: '#DDEEFF', font: { size: 14, color: '#112233', bold: true } });
    expect(preview.sheet.cells.find((cell) => cell.address === 'B2')).toMatchObject({ text: '4', formula: '2+2' });
    expect(preview.sheet.cells.find((cell) => cell.address === 'C2')?.formula).toBeUndefined();
    expect(preview.sheet.cells.find((cell) => cell.address === 'D4')?.text).toBe('0');
    const saved = new ExcelJS.Workbook();
    await saved.xlsx.readFile(source.absolutePath);
    expect(saved.worksheets[0].getCell('E4').hyperlink).toBe('https://example.com/reference');
  });

  it('reconstructs an embedded cell image with its bytes, anchor and dimensions', async () => {
    const { client } = readClient();
    const get = client.getSheetCells;
    client.getSheetCells = async (options) => {
      const result = await get(options);
      result.data.ranges[0].cells[0][0] = { rich_text: [{ type: 'embed-image', text: '',
        image_token: 'embedded-token', image_width: 80, image_height: 48 }] };
      return result;
    };
    const directory = temporary();
    const result = await stageSourceWorkbook(client, 'token', directory, path.join(directory, 'Doc.md'));
    const manifest = JSON.parse(fs.readFileSync(result.metadataPath, 'utf-8'));
    expect(manifest.sheets[0].images).toBe(2);
    expect(manifest.approximations).toContainEqual({ sheet: '画板', cell: 'A1', kind: 'embedded-cell-image-drawing', detail: { width: 80, height: 48 } });
    const preview = await readWorkbookPreview(result.absolutePath, 0);
    expect(preview.sheet.images).toHaveLength(2);
    expect(preview.sheet.images.find((image) => image.x === 0 && image.y === 0)).toMatchObject({
      width: 80, height: 48, dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    });
  });

  it('retains mixed rich text, inline link targets and mention identities', async () => {
    const { client } = readClient();
    const get = client.getSheetCells;
    client.getSheetCells = async (options) => {
      const result = await get(options);
      result.data.ranges[0].cells[0][0] = { value: '查看资料和设计', note: '原有批注', rich_text: [
        { type: 'text', text: '查看' },
        { type: 'link', text: '资料', link: 'https://example.com/reference' },
        { type: 'text', text: '和' },
        { type: 'mention', text: '设计', mention_token: 'author', mention_type: 3 },
      ] };
      return result;
    };
    const directory = temporary();
    const result = await stageSourceWorkbook(client, 'token', directory, path.join(directory, 'Doc.md'));
    const manifest = JSON.parse(fs.readFileSync(result.metadataPath, 'utf-8'));
    expect(manifest.approximations).toContainEqual(expect.objectContaining({ cell: 'A1', kind: 'inline-link-metadata', detail: expect.objectContaining({ link: 'https://example.com/reference', text: '资料' }) }));
    expect(manifest.approximations).toContainEqual(expect.objectContaining({ cell: 'A1', kind: 'mention', detail: expect.objectContaining({ mention_token: 'author' }) }));
    const preview = await readWorkbookPreview(result.absolutePath, 0);
    expect(preview.sheet.cells.find((cell) => cell.address === 'A1')?.text).toBe('查看资料和设计');
    expect(preview.sheet.cells.find((cell) => cell.address === 'A1')?.richText?.map((run) => run.text)).toEqual(['查看', '资料', '和', '设计']);
    const saved = new ExcelJS.Workbook(); await saved.xlsx.readFile(result.absolutePath);
    expect(saved.worksheets[0].getCell('A1').note).toContain('原有批注');
    expect(saved.worksheets[0].getCell('A1').note).toContain('https://example.com/reference');
  });

  it('does not create a workbook when an embedded image cannot be downloaded', async () => {
    const { client } = readClient();
    const get = client.getSheetCells;
    client.getSheetCells = async (options) => {
      const result = await get(options);
      result.data.ranges[0].cells[0][0] = { rich_text: [{ type: 'embed-image', text: '',
        image_token: 'embedded-token', image_width: 80, image_height: 48 }] };
      return result;
    };
    client.downloadMedia = async (token, outputPath) => {
      if (token === 'embedded-token') throw new Error('图片不可用');
      fs.writeFileSync(`${outputPath}.png`, PNG);
      return `${outputPath}.png`;
    };
    const directory = temporary(), output = path.join(directory, 'rejected.xlsx');
    await expect(reconstructWorkbookFromReads(client, 'token', output)).rejects.toThrow();
    expect(fs.existsSync(output)).toBe(false);
  });

  it('preserves link text and records unavailable targets instead of rejecting the workbook', async () => {
    const { client } = readClient(), get = client.getSheetCells;
    client.getSheetCells = async (options) => {
      const result = await get(options);
      result.data.ranges[0].cells[0][0] = { value: '迁移到草稿', rich_text: [
        { type: 'text', text: '迁移到' }, { type: 'link', text: '草稿' },
      ] };
      result.data.ranges[0].cells[0][1] = { value: '日志', rich_text: [{ type: 'link', text: '日志', link: '' }] };
      return result;
    };
    const file = path.join(temporary(), 'links.xlsx');
    const manifest = await reconstructWorkbookFromReads(client, 'token', file);
    expect(manifest.approximations?.filter((a) => a.kind === 'link-target-unavailable')).toHaveLength(2);
    const saved = new ExcelJS.Workbook(); await saved.xlsx.readFile(file);
    expect(saved.worksheets[0].getCell('A1').text).toBe('迁移到草稿');
    expect(saved.worksheets[0].getCell('A1').note).toContain('未返回跳转地址');
    expect(saved.worksheets[0].getCell('B1').text).toBe('日志');
    expect(saved.worksheets[0].getCell('B1').hyperlink).toBeUndefined();
    fs.writeFileSync(`${file}.metadata.json`, JSON.stringify(manifest));
    expect((await readWorkbookPreview(file, 0)).sheet.warnings).toContain('部分内部链接未返回跳转地址，已保留文字；跳转请查看飞书原文。');
  });

  it('maps zero row heights and column widths to hidden dimensions without losing cells', async () => {
    const { client } = readClient(), layout = client.getSheetLayout;
    client.getSheetLayout = async (options) => {
      const result = await layout(options);
      result.data.row_heights[0].height = 0;
      result.data.column_widths[0].width = 0;
      result.data.hidden_rows = [3]; result.data.hidden_columns = [3];
      return result;
    };
    const file = path.join(temporary(), 'hidden.xlsx');
    await reconstructWorkbookFromReads(client, 'token', file);
    const preview = await readWorkbookPreview(file, 0);
    expect(preview.sheet.rows.slice(0, 3)).toEqual([0, 0, 32]);
    expect(preview.sheet.columns.slice(0, 3)).toEqual([0, 0, 120]);
    expect(preview.sheet.rows[3]).toBe(0);
    expect(preview.sheet.columns[3]).toBe(0);
    const saved = new ExcelJS.Workbook(); await saved.xlsx.readFile(file);
    expect(saved.worksheets[0].getCell('A1').text).toBe('完整说明文字');
    expect(saved.worksheets[0].getCell('B2').formula).toBe('2+2');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('still rejects invalid dimension %s', async (size) => {
    const { client } = readClient(), layout = client.getSheetLayout;
    client.getSheetLayout = async (options) => { const result = await layout(options); result.data.row_heights[0].height = size; return result; };
    await expect(reconstructWorkbookFromReads(client, 'token', path.join(temporary(), 'invalid.xlsx'))).rejects.toThrow('行高信息');
  });

  it('does not silently omit an attachment when neither download nor preview has the source bytes', async () => {
    const { client } = readClient();
    const get = client.getSheetCells;
    client.getSheetCells = async (options) => {
      const result = await get(options);
      result.data.ranges[0].cells[0][0] = { value: '数据.json', rich_text: [
        { type: 'attachment', text: '数据.json', attachment_token: 'file-token', file_size: 10, mime_type: 'application/json' },
      ] };
      return result;
    };
    const output = path.join(temporary(), 'rejected.xlsx');
    await expect(reconstructWorkbookFromReads(client, 'token', output)).rejects.toThrow('附件“数据.json”未完整获取');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('commits verified source attachments alongside custom workbooks and exposes local links', async () => {
    const { client } = readClient(), get = client.getSheetCells, download = client.downloadMedia;
    const bytes = Buffer.from('{"data":"附件内容"}');
    client.getSheetCells = async (options) => {
      const result = await get(options);
      const attachment = { type: 'attachment', text: '数据.json', attachment_token: 'file-token', file_size: bytes.length, mime_type: 'application/json' };
      result.data.ranges[0].cells[0][0] = { value: '数据.json', rich_text: [attachment] };
      result.data.ranges[0].cells[0][1] = { value: '参见数据.json', note: '原始批注', rich_text: [{ type: 'text', text: '参见' }, attachment] };
      return result;
    };
    client.downloadMedia = async (token, target, type) => {
      if (token === 'file-token') throw new Error('export denied');
      return download(token, target, type);
    };
    client.previewMedia = vi.fn(async (_token, target) => { fs.writeFileSync(`${target}.json`, bytes); return `${target}.json`; });
    const root = temporary();
    const result = await syncSheetToCustomFolder({
      larkCliClient: { ...client, getSheetCsv: vi.fn() }, knowledgeBaseRoot: root, operationDirectory: temporary(),
      localMdPath: path.join(root, 'Doc.md'), objToken: 'token', wikiNodeToken: null, title: 'Doc', originalLink: null, objEditTime: 41, spaceId: null,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'Doc.xlsx.metadata.json'), 'utf8'));
    const attachment = manifest.attachments[0];
    expect(manifest.attachments).toHaveLength(2);
    expect(client.previewMedia).toHaveBeenCalledTimes(1);
    expect(attachment.acquisition).toBe('preview');
    const localAttachment = path.join(root, ...attachment.relativePath.split('/'));
    expect(fs.readFileSync(localAttachment)).toEqual(bytes);
    expect(result.committedFiles).toContain(localAttachment);
    expect(result.committedFiles.filter((file) => file === localAttachment)).toHaveLength(1);
    expect(fs.readFileSync(result.localMdPath, 'utf8')).toContain('## 表格附件');
    const saved = new ExcelJS.Workbook(); await saved.xlsx.readFile(path.join(root, 'Doc.xlsx'));
    expect(saved.worksheets[0].getCell('A1').hyperlink).toBe(attachment.relativePath);
    expect(saved.worksheets[0].getCell('B1').text).toBe('参见数据.json');
    expect(saved.worksheets[0].getCell('B1').note).toContain('原始批注');
    expect(saved.worksheets[0].getCell('B1').note).toContain(attachment.relativePath);
    const originalHash = computeSourceHash(result.localMdPath, [], root);
    fs.appendFileSync(localAttachment, 'changed');
    expect(computeSourceHash(result.localMdPath, [], root)).not.toBe(originalHash);
    fs.unlinkSync(localAttachment);
    expect(() => computeSourceHash(result.localMdPath, [], root)).toThrow();
  });

  it('splits truncated read windows and accepts only complete row/column coordinates', async () => {
    const { client, calls } = readClient();
    const get = client.getSheetCells;
    client.getSheetCells = async (options) => {
      const result = await get(options);
      if (result.data.ranges[0].row_indices.length > 1) result.data.has_more = true;
      return result;
    };
    const report = await reconstructWorkbookFromReads(client, 'token', path.join(temporary(), 'split.xlsx'));
    expect(report.sheets[0].cells).toBe(7);
    expect(calls).toContain('A6:E6:false');
    expect(calls).toContain('A1:E1:true');
  });

  it('retains mention text and identity and rebuilds a supported pie chart with source references', async () => {
    const { client } = readClient();
    const info = client.getWorkbookInfo;
    client.getWorkbookInfo = async (token) => { const result = await info(token); result.data.sheets[0].chart_count = 1; result.data.sheets[0].float_image_count = 0; return result; };
    client.getSheetFloatImages = async () => ({ data: { revision: 41, total: 0, sheets: [] } });
    const get = client.getSheetCells;
    client.getSheetCells = async (options) => {
      const result = await get(options);
      result.data.ranges[0].cells[0][0] = { value: '设计 ', rich_text: [{ type: 'mention', text: '设计', mention_token: 'abc', mention_type: 22 }, { type: 'text', text: ' ' }] };
      return result;
    };
    client.getSheetCharts = async () => ({ data: { revision: 41, sheets: [{ sheet_id: 's1', charts: [{ chart_id: 'c1', details: {
      position: { col: 'B', row: 1 }, size: { width: 400, height: 300 },
      snapshot: { data: { refs: [{ value: "'画板'!C1:D5" }], direction: 'column', isStaticData: false,
        dim1: { serie: { index: 1 } }, dim2: { series: [{ index: 2 }] } }, plotArea: { plot: { type: 'pie' } }, title: { text: '数量' } },
    } }] }] } });
    const file = path.join(temporary(), 'result.xlsx');
    const report = await reconstructWorkbookFromReads(client, 'token', file);
    expect(report.approximations).toContainEqual(expect.objectContaining({ kind: 'mention', cell: 'A1', detail: { type: 'mention', text: '设计', mention_token: 'abc', mention_type: 22 } }));
    expect(report.approximations).toContainEqual(expect.objectContaining({ kind: 'chart-approximate-pie' }));
    const saved = new ExcelJS.Workbook(); await saved.xlsx.readFile(file);
    expect(saved.worksheets[0].getCell('A1').text).toBe('设计 ');
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const chart = await zip.file('xl/charts/chart-fs1.xml')!.async('string');
    expect(chart).toContain('&apos;画板&apos;!$C$2:$C$5');
    expect(chart).toContain('&apos;画板&apos;!$D$2:$D$5');
    expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<drawing');
  });

  it('preserves unsupported chart details in the reconstruction manifest', async () => {
    const { client } = readClient();
    const info = client.getWorkbookInfo;
    client.getWorkbookInfo = async (token) => { const result = await info(token); result.data.sheets[0].chart_count = 1; return result; };
    const chart = { chart_id: 'c1', details: { snapshot: { plotArea: { plot: { type: 'bar' } } } } };
    client.getSheetCharts = async () => ({ data: { revision: 41, sheets: [{ sheet_id: 's1', charts: [chart] }] } });
    const report = await reconstructWorkbookFromReads(client, 'token', path.join(temporary(), 'chart.xlsx'));
    expect(report.approximations).toContainEqual({ sheet: '画板', kind: 'chart-metadata-only', detail: chart });
  });

  it.each(['version', 'missing-image', 'missing-layout', 'single-cell-truncated', 'wrong-coordinates', 'unsupported-object'])(
    'rejects %s instead of committing an incomplete workbook', async (kind) => {
      const { client } = readClient();
      if (kind === 'version') client.getSheetLayout = async () => ({ data: { revision: 42 } });
      if (kind === 'missing-image') client.getSheetFloatImages = async () => ({ data: { revision: 41, total: 0, sheets: [] } });
      if (kind === 'missing-layout') {
        const get = client.getSheetLayout;
        client.getSheetLayout = async (options) => { const result = await get(options); result.data.row_heights = []; return result; };
      }
      if (['single-cell-truncated', 'wrong-coordinates', 'unsupported-object'].includes(kind)) {
        const get = client.getSheetCells;
        client.getSheetCells = async (options) => {
          const result = await get(options);
          if (kind === 'single-cell-truncated') result.data.has_more = true;
          else if (kind === 'wrong-coordinates') result.data.ranges[0].row_indices[0] += 1;
          else result.data.ranges[0].cells[0][0] = { rich_text: [{ type: 'embed-image' }], value: '图像' };
          return result;
        };
      }
      const directory = temporary(), output = path.join(directory, 'rejected.xlsx');
      await expect(reconstructWorkbookFromReads(client, 'token', output)).rejects.toThrow();
      expect(fs.existsSync(output)).toBe(false);
    },
  );

  it('rolls the workbook back together with Markdown after a failed DB commit', async () => {
    const root = temporary(), stage = temporary(), ops = temporary();
    const mdPath = path.join(root, 'Doc.md'), xlsxPath = path.join(root, 'Doc.xlsx');
    fs.writeFileSync(mdPath, 'old text'); fs.writeFileSync(xlsxPath, 'old workbook');
    const replacement = path.join(stage, 'Doc.xlsx');
    await exportTestWorkbook('token', replacement);
    const commit = commitDocumentContent({
      operationId: 'workbook-rollback', knowledgeBaseRoot: root, operationDirectory: ops, localMdPath: mdPath,
      ir: { objToken: 'token', objType: 'sheet', wikiNodeToken: null, spaceId: null, title: 'Doc', originalLink: null,
        observedObjEditTime: 41, bodyMarkdown: '# Doc', images: [], attachments: [], sheets: [], workbook: { relativePath: 'Doc.xlsx' } },
      extraFiles: [{ relativePath: 'Doc.xlsx', absoluteSource: replacement }], failAfterFileCommit: true,
    });
    expect(commit.ok).toBe(false);
    expect(fs.readFileSync(mdPath, 'utf-8')).toBe('old text');
    expect(fs.readFileSync(xlsxPath, 'utf-8')).toBe('old workbook');
  });

  it('archives a read-only reconstructed workbook through the shipped custom-folder commit pipeline', async () => {
    const root = temporary(), ops = temporary(), { client } = readClient();
    const csvRead = vi.fn(async () => { throw new Error('duplicate CSV request'); });
    const download = vi.spyOn(client, 'downloadMedia');
    const result = await syncSheetToCustomFolder({
      larkCliClient: { ...client, getSheetCsv: csvRead },
      knowledgeBaseRoot: root, operationDirectory: ops, localMdPath: path.join(root, '画板.md'),
      objToken: 'token', wikiNodeToken: null, title: '画板', originalLink: null, objEditTime: 41, spaceId: null,
    });
    expect(result.committedFiles).toContain(path.join(root, '画板.xlsx'));
    expect(result.committedFiles).toContain(path.join(root, '画板.xlsx.metadata.json'));
    const markdown = fs.readFileSync(result.localMdPath, 'utf-8');
    expect(markdown).toContain('source_workbook: "画板.xlsx"');
    expect(markdown).toContain('source_acquisition: "read-reconstruction"');
    expect((await readWorkbookPreview(path.join(root, '画板.xlsx'), 0)).sheet.images).toHaveLength(1);
    expect(csvRead).not.toHaveBeenCalled(); expect(download).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, '画板.csv-data', '画板.csv'), 'utf8')).toContain('完整说明文字');
  });

  it('falls back to CSV and retains the previous managed workbook when reconstruction is unsupported', async () => {
    const root = temporary(), ops = temporary(), { client } = readClient();
    const mdPath = path.join(root, '画板.md'), xlsxPath = path.join(root, '画板.xlsx');
    await exportTestWorkbook('token', xlsxPath);
    const original = fs.readFileSync(xlsxPath);
    fs.writeFileSync(mdPath, '<!--\nfeishu_sync:\n  source_workbook: "画板.xlsx"\n-->\n# old');
    fs.writeFileSync(`${xlsxPath}.metadata.json`, JSON.stringify({ objToken: 'token', mode: 'native' }));
    const info = client.getWorkbookInfo;
    client.getWorkbookInfo = async (token) => { const value = await info(token); value.data.sheets[0].chart_count = 1; return value; };
    await syncSheetToCustomFolder({
      larkCliClient: { ...client, getSheetCsv: async () => ({ data: { annotated_csv: '说明,数值\n新内容,1\n', has_more: false, actual_range: 'A1:E6', revision: 41 } }) },
      knowledgeBaseRoot: root, operationDirectory: ops, localMdPath: mdPath,
      objToken: 'token', wikiNodeToken: null, title: '画板', originalLink: null, objEditTime: 41, spaceId: null,
    });
    expect(fs.readFileSync(xlsxPath)).toEqual(original);
    expect(fs.readFileSync(mdPath, 'utf8')).toContain('source_acquisition: "csv-fallback"');
    expect(fs.readFileSync(mdPath, 'utf8')).toContain('previous_workbook: "画板.xlsx"');
    expect(fs.readFileSync(path.join(root, '画板.csv-data', '画板.csv'), 'utf8')).toContain('新内容');
  });

  it('leaves existing files unchanged if the CSV fallback fails or changes revision', async () => {
    for (const revisionChanges of [false, true]) {
      const root = temporary(), ops = temporary(), { client } = readClient();
      const mdPath = path.join(root, '画板.md'); fs.writeFileSync(mdPath, 'original');
      let calls = 0;
      const info = client.getWorkbookInfo;
      client.getWorkbookInfo = async (token) => {
        const value = await info(token); value.data.sheets[0].chart_count = 1;
        if (revisionChanges && ++calls >= 4) value.data.revision = 42;
        return value;
      };
      const input = { larkCliClient: { ...client, getSheetCsv: async () => {
        if (!revisionChanges) throw new Error('CSV unavailable');
        return { data: { annotated_csv: '表头\n数据\n', has_more: false, actual_range: 'A1:E6', revision: 41 } };
      } }, knowledgeBaseRoot: root, operationDirectory: ops, localMdPath: mdPath,
      objToken: 'token', wikiNodeToken: null, title: '画板', originalLink: null, objEditTime: 41, spaceId: null };
      await expect(syncSheetToCustomFolder(input)).rejects.toThrow();
      expect(fs.readFileSync(mdPath, 'utf8')).toBe('original');
      expect(fs.existsSync(path.join(root, '画板.csv-data', '画板.csv'))).toBe(false);
    }
  });

  it('rejects a truncated CSV fallback without replacing the old markdown', async () => {
    const root = temporary(), ops = temporary(), { client } = readClient();
    const mdPath = path.join(root, '画板.md'); fs.writeFileSync(mdPath, 'original');
    const info = client.getWorkbookInfo;
    client.getWorkbookInfo = async (token) => { const value = await info(token); value.data.sheets[0].chart_count = 1; return value; };
    await expect(syncSheetToCustomFolder({
      larkCliClient: { ...client, getSheetCsv: async () => ({ data: { annotated_csv: '部分内容', has_more: true, actual_range: 'A1:E6', revision: 41 } }) },
      knowledgeBaseRoot: root, operationDirectory: ops, localMdPath: mdPath,
      objToken: 'token', wikiNodeToken: null, title: '画板', originalLink: null, objEditTime: 41, spaceId: null,
    })).rejects.toThrow('完整性无法确认');
    expect(fs.readFileSync(mdPath, 'utf8')).toBe('original');
  });

  it('pins image/layout-only changes in raw-source integrity hashes', async () => {
    const root = temporary(), mdPath = path.join(root, 'Doc.md'), workbookPath = path.join(root, 'Doc.xlsx');
    fs.writeFileSync(mdPath, '<!--\nfeishu_sync:\n  source_workbook: "Doc.xlsx"\n-->\n# Doc');
    await exportTestWorkbook('token', workbookPath);
    const first = computeSourceHash(mdPath, [], root);
    fs.appendFileSync(workbookPath, 'layout changed');
    expect(computeSourceHash(mdPath, [], root)).not.toBe(first);
    fs.unlinkSync(workbookPath);
    expect(() => computeSourceHash(mdPath, [], root)).toThrow();
  });

  it('recycles the canonical workbook with its derivative and ownership metadata', async () => {
    const root = temporary(), mdPath = path.join(root, 'Doc.md');
    fs.writeFileSync(mdPath, '<!--\nfeishu_sync:\n  source_workbook: "Doc.xlsx"\n-->\n# Doc');
    await exportTestWorkbook('token', path.join(root, 'Doc.xlsx'));
    fs.writeFileSync(path.join(root, 'Doc.xlsx.metadata.json'), '{"mode":"native"}');
    const record = { objToken: 'token', objType: 'sheet', localRelPath: 'Doc.md', localMdPath: mdPath, status: 'synced' };
    const result = cleanupSources({ getAllDocuments: () => [record], getSheetSheets: () => [], deleteDocumentsByTokens: () => {} } as any,
      root, [{ objToken: 'token', relPath: 'Doc.md' }]);
    expect(result.movedFiles).toBe(3);
    expect(fs.existsSync(path.join(root, 'Doc.xlsx'))).toBe(false);
    expect(fs.existsSync(path.join(result.trashDir, 'files', 'Doc.xlsx'))).toBe(true);
  });
});

describe('workbook content routes', () => {
  async function setup() {
    const root = temporary(), mdPath = path.join(root, 'Doc.md');
    fs.writeFileSync(mdPath, '# Doc');
    await exportTestWorkbook('token', path.join(root, 'Doc.xlsx'));
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as any).configManager = { getConfig: () => ({ knowledgeBaseRoot: root }) };
      (c as any).localMapStore = { getDocumentByObjToken: (token: string) => token === 'token' ? { objToken: token, objType: 'sheet', title: 'Doc', localMdPath: mdPath } : null };
      await next();
    });
    app.route('/', contentRoutes);
    return { root, app };
  }

  it('discovers the canonical file, serves one sheet, and downloads original bytes', async () => {
    const { root, app } = await setup();
    const content = await (await app.request('/api/mapping/content/token')).json();
    expect(content.workbook.path).toBe('Doc.xlsx');
    const preview = await (await app.request('/api/mapping/workbook/token?sheet=0')).json();
    expect(preview.sheets).toHaveLength(1);
    expect(preview.sheet.cells.find((cell: any) => cell.address === 'A2').text).toBe('1');
    const response = await app.request('/api/mapping/workbook/token/file');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(path.join(root, 'Doc.xlsx')));
    expect(response.headers.get('Content-Type')).toContain('spreadsheetml.sheet');
    expect((await app.request('/api/mapping/workbook/token?sheet=-1')).status).toBe(400);
    expect((await app.request('/api/mapping/workbook/token?sheet=7')).status).toBe(404);
  });

  it('reports a retained workbook as older when the latest successful sync used CSV fallback', async () => {
    const { root, app } = await setup();
    fs.writeFileSync(path.join(root, 'Doc.md'), '<!--\nfeishu_sync:\n  source_acquisition: "csv-fallback"\n  previous_workbook: "Doc.xlsx"\n-->\n# Doc');
    fs.mkdirSync(path.join(root, 'Doc.csv-data'));
    fs.writeFileSync(path.join(root, 'Doc.csv-data', 'Sheet.csv'), 'value\n1\n');
    const content = await (await app.request('/api/mapping/content/token')).json();
    expect(content.sheetStatus).toMatchObject({ acquisition: 'csv-fallback', workbookMayBeOlder: true });
    expect(content.workbook.path).toBe('Doc.xlsx');
    expect(content.csvTables).toHaveLength(1);
  });

  it('rejects symlinks escaping the knowledge base and unknown document tokens', async () => {
    const { root, app } = await setup();
    const outside = path.join(temporary(), 'outside.xlsx');
    await exportTestWorkbook('token', outside);
    fs.unlinkSync(path.join(root, 'Doc.xlsx'));
    fs.symlinkSync(outside, path.join(root, 'Doc.xlsx'));
    expect((await app.request('/api/mapping/workbook/token/file')).status).toBe(404);
    expect((await app.request('/api/mapping/workbook/unknown')).status).toBe(404);
    expect((await (await app.request('/api/mapping/content/token')).json()).workbook).toBeNull();
  });
});
