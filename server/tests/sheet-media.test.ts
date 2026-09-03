/**
 * Sheet float-image pipeline tests.
 *
 * Covers the sheet-media module contract (probe / parse / three-tier
 * download / CSV annotation / markdown appendix) plus the two integration
 * wirings it was built for:
 *   - custom-doc-sync.syncSheetToCustomFolder (custom-folder sheet archive)
 *   - SyncEngine.syncDocuments sheet path (structure-tree main pipeline)
 *
 * Algorithm-layer style (mirrors change-detector.test.ts): in-memory fakes
 * for the lark-cli surface, real temp directories for staging/KB so the
 * atomic-commit path is exercised for the image files.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  annotateCsvWithImages,
  downloadSheetMedia,
  parseSheetFloatImages,
  probeSheetFloatImages,
  renderSheetMediaAppendix,
  type SheetFloatImage,
  type SheetMediaItem,
} from '../src/modules/sheet-media.js';
import { syncSheetToCustomFolder } from '../src/modules/custom-doc-sync.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { LayoutReconstructor } from '../src/modules/layout-reconstructor.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import type { ChangedDocument } from '../src/types/index.js';

const temps: string[] = [];

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function makeFloatImage(overrides: Partial<SheetFloatImage> = {}): SheetFloatImage {
  return {
    floatImageId: 'fip123',
    imageToken: 'tok123',
    address: 'A2',
    col: 0,
    row: 1,
    width: 320,
    height: 240,
    url: null,
    ...overrides,
  };
}

function makeMediaItem(overrides: Partial<SheetMediaItem> = {}): SheetMediaItem {
  return {
    token: 'tok123',
    floatImageId: 'fip123',
    address: 'A2',
    localPath: '/tmp/staging/images/主表_A2_fip123.png',
    localRelPath: 'images/主表_A2_fip123.png',
    subSheetTitle: '主表',
    width: 320,
    height: 240,
    ...overrides,
  };
}

/** Fake download surface: writes `<outputPath>.png` and returns the path. */
function makeDownloadClient(options: {
  downloadFails?: boolean;
  previewFails?: boolean;
  emptyBytes?: boolean;
} = {}) {
  return {
    downloadCalls: [] as Array<{ token: string; outputPath: string; type?: string }>,
    previewCalls: [] as Array<{ token: string; outputPath: string }>,
    async downloadMedia(token: string, outputPath: string, type?: string): Promise<string> {
      this.downloadCalls.push({ token, outputPath, type });
      if (options.downloadFails) throw new Error('media-download 403');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const target = `${outputPath}.png`;
      fs.writeFileSync(target, options.emptyBytes ? '' : `png-bytes-${token}`);
      return target;
    },
    async previewMedia(token: string, outputPath: string): Promise<string> {
      this.previewCalls.push({ token, outputPath });
      if (options.previewFails) throw new Error('media-preview failed');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const target = `${outputPath}.png`;
      fs.writeFileSync(target, `preview-bytes-${token}`);
      return target;
    },
  };
}

// =========================================================================
// parseSheetFloatImages
// =========================================================================
describe('parseSheetFloatImages', () => {
  it('parses the canonical sheets[].float_images snake_case payload', () => {
    const response = {
      ok: true,
      data: {
        revision_id: -1,
        sheets: [
          {
            sheet_id: 's1',
            float_images: [
              {
                float_image_id: 'fip1',
                image_token: 'tok1',
                address: 'A7',
                col: 0,
                row: 6,
                width: 100,
                height: 50,
              },
            ],
          },
        ],
      },
    };
    const images = parseSheetFloatImages(response);
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      floatImageId: 'fip1',
      imageToken: 'tok1',
      address: 'A7',
      col: 0,
      row: 6,
      width: 100,
      height: 50,
      url: null,
    });
  });

  it('accepts camelCase keys and a bare data payload without the ok wrapper', () => {
    const images = parseSheetFloatImages({
      data: {
        sheets: [
          { sheetId: 's1', floatImages: [{ floatImageId: 'f1', imageToken: 't1', address: 'B2' }] },
        ],
      },
    });
    expect(images).toHaveLength(1);
    expect(images[0].imageToken).toBe('t1');
    expect(images[0].address).toBe('B2');
  });

  it('derives an address from 0-based col/row when address is missing', () => {
    const images = parseSheetFloatImages({
      data: { sheets: [{ float_images: [{ float_image_id: 'f1', image_token: 't1', col: 2, row: 3 }] }] },
    });
    expect(images[0].address).toBe('C4');
  });

  it('drops entries without an image token and tolerates malformed input', () => {
    expect(parseSheetFloatImages({
      data: { sheets: [{ float_images: [{ float_image_id: 'no-token' }] }] },
    })).toEqual([]);
    expect(parseSheetFloatImages(null)).toEqual([]);
    expect(parseSheetFloatImages('oops')).toEqual([]);
    expect(parseSheetFloatImages({ data: { sheets: 'not-array' } })).toEqual([]);
  });

  it('accepts a top-level float_images array without the per-sheet wrap', () => {
    const images = parseSheetFloatImages({
      data: { float_images: [{ float_image_id: 'f1', image_token: 't1', address: 'A1' }] },
    });
    expect(images).toHaveLength(1);
    expect(images[0].imageToken).toBe('t1');
  });
});

// =========================================================================
// probeSheetFloatImages
// =========================================================================
describe('probeSheetFloatImages', () => {
  it('returns [] when the client does not implement getSheetFloatImages', async () => {
    const images = await probeSheetFloatImages({}, {
      spreadsheetToken: 'st',
      sheetId: 's1',
      sheetTitle: '主表',
    });
    expect(images).toEqual([]);
  });

  it('soft-fails to [] when the probe call throws (CSV pipeline must survive)', async () => {
    const images = await probeSheetFloatImages(
      {
        async getSheetFloatImages() {
          throw new Error('sheet_ai tool unavailable');
        },
      },
      { spreadsheetToken: 'st', sheetId: 's1', sheetTitle: '主表' },
    );
    expect(images).toEqual([]);
  });

  it('probes and parses through the client', async () => {
    const images = await probeSheetFloatImages(
      {
        async getSheetFloatImages(options: { spreadsheetToken: string; sheetId: string }) {
          expect(options).toEqual({ spreadsheetToken: 'st', sheetId: 's1' });
          return { ok: true, data: { sheets: [{ float_images: [{ float_image_id: 'f1', image_token: 't1', address: 'A1' }] }] } };
        },
      },
      { spreadsheetToken: 'st', sheetId: 's1', sheetTitle: '主表' },
    );
    expect(images).toHaveLength(1);
    expect(images[0].imageToken).toBe('t1');
  });
});

// =========================================================================
// downloadSheetMedia
// =========================================================================
describe('downloadSheetMedia', () => {
  it('downloads via media-download with the documented file naming', async () => {
    const dir = makeTempDir('sheet-media-dl-');
    const client = makeDownloadClient();
    const items = await downloadSheetMedia({
      client,
      floatImages: [makeFloatImage()],
      imagesDir: path.join(dir, 'images'),
      subSheetTitle: '主表',
    });
    expect(items).toHaveLength(1);
    expect(items[0].localPath.endsWith('主表_A2_fip123.png')).toBe(true);
    expect(items[0].localRelPath).toBe('images/主表_A2_fip123.png');
    expect(items[0].subSheetTitle).toBe('主表');
    expect(items[0].width).toBe(320);
    expect(fs.statSync(items[0].localPath).size).toBeGreaterThan(0);
    expect(client.downloadCalls[0]?.type).toBe('media');
  });

  it('falls back to media-preview when media-download fails', async () => {
    const dir = makeTempDir('sheet-media-dl-');
    const client = makeDownloadClient({ downloadFails: true });
    const items = await downloadSheetMedia({
      client,
      floatImages: [makeFloatImage({ url: null })],
      imagesDir: path.join(dir, 'images'),
      subSheetTitle: '主表',
    });
    expect(items).toHaveLength(1);
    expect(fs.readFileSync(items[0].localPath, 'utf-8')).toBe('preview-bytes-tok123');
  });

  it('tries the direct url first when present, then falls through on failure', async () => {
    const dir = makeTempDir('sheet-media-dl-');
    const client = makeDownloadClient();
    const items = await downloadSheetMedia({
      client,
      // Port 1 is never listening: the fetch tier fails fast.
      floatImages: [makeFloatImage({ url: 'http://127.0.0.1:1/img.png' })],
      imagesDir: path.join(dir, 'images'),
      subSheetTitle: '主表',
    });
    expect(items).toHaveLength(1);
    expect(client.downloadCalls).toHaveLength(1);
  });

  it('throws when all three tiers fail', async () => {
    const dir = makeTempDir('sheet-media-dl-');
    const client = makeDownloadClient({ downloadFails: true, previewFails: true });
    await expect(downloadSheetMedia({
      client,
      floatImages: [makeFloatImage({ url: null })],
      imagesDir: path.join(dir, 'images'),
      subSheetTitle: '主表',
    })).rejects.toThrow(/三层下载全部失败/);
  });

  it('throws on a zero-byte download (non-empty validation)', async () => {
    const dir = makeTempDir('sheet-media-dl-');
    const client = makeDownloadClient({ emptyBytes: true });
    await expect(downloadSheetMedia({
      client,
      floatImages: [makeFloatImage()],
      imagesDir: path.join(dir, 'images'),
      subSheetTitle: '主表',
    })).rejects.toThrow(/下载失败或为空/);
  });

  it('sanitizes hostile sub-sheet titles in filenames', async () => {
    const dir = makeTempDir('sheet-media-dl-');
    const client = makeDownloadClient();
    const items = await downloadSheetMedia({
      client,
      floatImages: [makeFloatImage()],
      imagesDir: path.join(dir, 'images'),
      subSheetTitle: '资产/配置:表<v2>',
    });
    const name = path.basename(items[0].localPath);
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
    expect(name.endsWith('_A2_fip123.png')).toBe(true);
  });
});

// =========================================================================
// annotateCsvWithImages
// =========================================================================
describe('annotateCsvWithImages', () => {
  it('appends the image marker after existing cell text with RFC 4180 quoting', () => {
    const csv = '名称,数量\n苹果,3\n';
    const out = annotateCsvWithImages(csv, [makeMediaItem({ address: 'B2' })]);
    expect(out).toBe('名称,数量\n苹果,"3\n![图片: B2](images/主表_A2_fip123.png)"\n');
  });

  it('writes directly into an empty cell and pads short rows', () => {
    const csv = '名称,数量\n\n香蕉\n';
    // B3: row 3, col 1 — the "香蕉" row only has one cell.
    const out = annotateCsvWithImages(csv, [makeMediaItem({ address: 'B3' })]);
    expect(out).toBe('名称,数量\n\n香蕉,![图片: B3](images/主表_A2_fip123.png)\n');
  });

  it('supports [row=N] prefixed lines, matching by N and preserving the prefix', () => {
    const csv = '[row=1]名称,数量\n[row=2]苹果,3\n';
    const out = annotateCsvWithImages(csv, [makeMediaItem({ address: 'A2' })]);
    expect(out).toBe(
      '[row=1]名称,数量\n' +
      '[row=2]"苹果\n![图片: A2](images/主表_A2_fip123.png)",3\n',
    );
  });

  it('leaves untouched records byte-identical, including quoted cells with commas', () => {
    const csv = 'a,"b,c"\n"d, e",f\n';
    const out = annotateCsvWithImages(csv, [makeMediaItem({ address: 'A2' })]);
    expect(out.startsWith('a,"b,c"\n')).toBe(true);
    expect(out).toBe(
      'a,"b,c"\n' +
      '"d, e\n![图片: A2](images/主表_A2_fip123.png)",f\n',
    );
  });

  it('skips images anchored beyond the CSV row range (appendix still shows them)', () => {
    const csv = 'a,b\n1,2\n';
    const out = annotateCsvWithImages(csv, [makeMediaItem({ address: 'C9' })]);
    expect(out).toBe(csv);
  });

  it('appends multiple images in the same cell sequentially', () => {
    const csv = 'a,b\n1,2\n';
    const out = annotateCsvWithImages(csv, [
      makeMediaItem({ address: 'A2', localRelPath: 'images/x1.png' }),
      makeMediaItem({ floatImageId: 'fip9', address: 'A2', localRelPath: 'images/x9.png' }),
    ]);
    expect(out).toBe(
      'a,b\n"1\n![图片: A2](images/x1.png)\n![图片: A2](images/x9.png)",2\n',
    );
  });

  it('returns the input unchanged for empty images or empty csv', () => {
    expect(annotateCsvWithImages('a,b\n', [])).toBe('a,b\n');
    expect(annotateCsvWithImages('', [makeMediaItem()])).toBe('');
  });
});

// =========================================================================
// renderSheetMediaAppendix
// =========================================================================
describe('renderSheetMediaAppendix', () => {
  it('renders the documented appendix block with size', () => {
    const block = renderSheetMediaAppendix('主表', [makeMediaItem({ address: 'A7' })]);
    expect(block).toBe(
      '### 子表图片资源 (主表)\n\n' +
      '- **单元格 A7 浮动图片** (320×240)：\n' +
      '  ![主表 A7 浮动图片](images/主表_A2_fip123.png)\n',
    );
  });

  it('omits the size suffix when dimensions are unknown', () => {
    const block = renderSheetMediaAppendix('主表', [
      makeMediaItem({ width: null, height: null }),
    ]);
    expect(block).toContain('- **单元格 A2 浮动图片**：\n');
  });

  it('returns an empty string for no images', () => {
    expect(renderSheetMediaAppendix('主表', [])).toBe('');
  });
});

// =========================================================================
// custom-doc-sync integration
// =========================================================================
describe('syncSheetToCustomFolder with float images', () => {
  function makeSheetClient(csv: string) {
    const client = {
      ...makeDownloadClient(),
      async getWorkbookInfo() {
        return {
          data: {
            sheets: [{ sheet_id: 's1', sheet_name: '主表', row_count: 2, column_count: 2 }],
          },
        };
      },
      async getSheetCsv() {
        return { data: { annotated_csv: csv } };
      },
      async getSheetFloatImages() {
        return {
          ok: true,
          data: {
            sheets: [
              {
                sheet_id: 's1',
                float_images: [
                  {
                    float_image_id: 'fip123',
                    image_token: 'tok123',
                    address: 'A2',
                    col: 0,
                    row: 1,
                    width: 320,
                    height: 240,
                  },
                ],
              },
            ],
          },
        };
      },
    };
    return client;
  }

  it('archives CSV + image atomically with annotation and appendix', async () => {
    const root = makeTempDir('feishu-sheet-custom-');
    const ops = makeTempDir('feishu-sheet-custom-ops-');
    const mdPath = path.join(root, '_custom', 'f1', '表格.md');

    const result = await syncSheetToCustomFolder({
      larkCliClient: makeSheetClient('名称,数量\n苹果,3\n') as any,
      knowledgeBaseRoot: root,
      operationDirectory: ops,
      localMdPath: mdPath,
      objToken: 'shtToken000001',
      wikiNodeToken: null,
      title: '表格',
      originalLink: 'https://feishu.cn/sheets/shtToken000001',
      objEditTime: 1_700_000_000,
      spaceId: null,
    });

    expect(result.sheetsCount).toBe(1);
    expect(result.imagesCount).toBe(1);

    const md = fs.readFileSync(mdPath, 'utf-8');
    expect(md).toContain('## 子表: 主表');
    expect(md).toContain('### 子表图片资源 (主表)');
    expect(md).toContain('![主表 A2 浮动图片](images/主表_A2_fip123.png)');
    expect(md).toContain('[CSV 原始数据](表格.csv-data/主表.csv)');

    const csv = fs.readFileSync(
      path.join(root, '_custom', 'f1', '表格.csv-data', '主表.csv'),
      'utf-8',
    );
    expect(csv).toBe('名称,数量\n"苹果\n![图片: A2](images/主表_A2_fip123.png)",3\n');

    const image = fs.readFileSync(
      path.join(root, '_custom', 'f1', 'images', '主表_A2_fip123.png'),
    );
    expect(image.length).toBeGreaterThan(0);

    // committedFiles covers the image so a later DB failure can roll it back.
    expect(result.committedFiles).toContain(
      path.join(root, '_custom', 'f1', 'images', '主表_A2_fip123.png'),
    );
  });

  it('still syncs (image-free) when the client lacks getSheetFloatImages', async () => {
    const root = makeTempDir('feishu-sheet-custom-');
    const ops = makeTempDir('feishu-sheet-custom-ops-');
    const mdPath = path.join(root, '_custom', 'f1', '表格.md');
    const client = makeSheetClient('a,b\n');
    // Simulate an older injected client: no float-image capability at all.
    const legacyClient = {
      getWorkbookInfo: client.getWorkbookInfo,
      getSheetCsv: client.getSheetCsv,
      downloadMedia: client.downloadMedia,
      previewMedia: client.previewMedia,
    };

    const result = await syncSheetToCustomFolder({
      larkCliClient: legacyClient as any,
      knowledgeBaseRoot: root,
      operationDirectory: ops,
      localMdPath: mdPath,
      objToken: 'shtToken000002',
      wikiNodeToken: null,
      title: '表格',
      originalLink: null,
      objEditTime: null,
      spaceId: null,
    });

    expect(result.imagesCount).toBe(0);
    expect(fs.existsSync(path.join(root, '_custom', 'f1', 'images'))).toBe(false);
    expect(fs.readFileSync(mdPath, 'utf-8')).not.toContain('子表图片资源');
  });
});

// =========================================================================
// SyncEngine structure-tree sheet path
// =========================================================================
describe('SyncEngine sheet sync with float images', () => {
  it('commits annotated CSV + appendix + image through the atomic pipeline', async () => {
    const root = makeTempDir('feishu-sheet-engine-');
    const kb = path.join(root, 'kb');
    const ops = path.join(root, 'ops');
    fs.mkdirSync(kb, { recursive: true });
    fs.mkdirSync(ops, { recursive: true });

    const store = new LocalMapStore(path.join(root, 'map.db'));
    store.initialize();

    // ChangeDetector.upsertDocumentSeen normally writes the documents row
    // during detect (before the sync pipeline runs); sheet_sheets has an FK
    // on it, so mirror that precondition like sync-engine-atomic.test.ts.
    store.upsertDocument({
      objToken: 'shtEngine000001',
      wikiNodeToken: 'node-sheet',
      objType: 'sheet',
      title: '表格',
      localMdPath: path.join(kb, '策划 - Designer', '表格.md'),
      lastSyncedModifyTime: 'old',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      status: 'synced',
      localRelPath: '策划 - Designer/表格.md',
      watchedRootId: 'designer',
      syncedObjEditTime: 100,
      observedObjEditTime: 100,
      syncState: 'synced',
    } as any);

    const config = {
      knowledgeBaseRoot: kb,
      operationManifestDir: ops,
      watchedRoots: [
        {
          id: 'designer',
          url: 'https://example.feishu.cn/wiki/designer',
          localDir: '策划 - Designer',
          layoutProfile: 'mirror-title-file' as const,
          enabled: true,
        },
      ],
      watchedRootUrls: ['https://example.feishu.cn/wiki/designer'],
      llm: { temperature: 0.2, timeoutMs: 1000 },
    };

    const downloadClient = makeDownloadClient();
    const engine = new SyncEngine({
      larkCliClient: {
        ...downloadClient,
        async getWorkbookInfo() {
          return {
            data: {
              sheets: [{ sheet_id: 's1', sheet_name: '主表', row_count: 2, column_count: 2 }],
            },
          };
        },
        async getSheetCsv() {
          return { data: { annotated_csv: '名称,数量\n苹果,3\n' } };
        },
        async getSheetFloatImages() {
          return {
            ok: true,
            data: {
              sheets: [
                {
                  sheet_id: 's1',
                  float_images: [
                    {
                      float_image_id: 'fip123',
                      image_token: 'tok123',
                      address: 'A2',
                      col: 0,
                      row: 1,
                      width: 320,
                      height: 240,
                    },
                  ],
                },
              ],
            },
          };
        },
      },
      localMapStore: store,
      config,
      layoutReconstructor: new LayoutReconstructor(),
    });

    const doc: ChangedDocument = {
      objToken: 'shtEngine000001',
      objType: 'sheet',
      title: '表格',
      changeType: 'modified',
      cloudModifiedTime: '2026-07-17T00:00:00.000Z',
      localSyncedTime: null,
      localMdPath: path.join(kb, '策划 - Designer', '表格.md'),
      localRelPath: '策划 - Designer/表格.md',
      watchedRootId: 'designer',
      observedObjEditTime: 1_700_000_000,
    };

    const result = await engine.syncDocuments([doc], {
      enableLLM: false,
      fullSync: false,
      apply: true,
      confirmation: 'APPLY',
    });

    expect(result.success).toBe(true);
    expect(result.syncedDocuments[0].imagesCount).toBe(1);

    const mdPath = path.join(kb, '策划 - Designer', '表格.md');
    const md = fs.readFileSync(mdPath, 'utf-8');
    expect(md).toContain('## 子表: 主表');
    expect(md).toContain('### 子表图片资源 (主表)');
    expect(md).toContain('![主表 A2 浮动图片](images/主表_A2_fip123.png)');

    const csv = fs.readFileSync(
      path.join(kb, '策划 - Designer', '表格.csv-data', '主表.csv'),
      'utf-8',
    );
    expect(csv).toBe('名称,数量\n"苹果\n![图片: A2](images/主表_A2_fip123.png)",3\n');

    const image = fs.readFileSync(
      path.join(kb, '策划 - Designer', 'images', '主表_A2_fip123.png'),
    );
    expect(image.length).toBeGreaterThan(0);

    // Synced baseline advanced only after the full commit.
    const row = store.getDocumentByObjToken('shtEngine000001');
    expect(row?.syncedObjEditTime).toBe(1_700_000_000);
  });
});
