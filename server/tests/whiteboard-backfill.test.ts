/**
 * P0-S8 存量补齐 — SyncEngine.backfillWhiteboardBypass + custom-doc-sync
 * 旁路接入 + 命令表/路由登记测试。
 *
 * 设计依据：lark-cli-newcaps-P0.md §5.8 + P0-S6 报告（svg 主 + raw 降级）：
 * - 只新增 .wb.svg/.wb.raw.json——md 字节与 DB 基线字段（含
 *   synced_obj_edit_time / synced 状态）前后逐字段一致（硬验收）；
 * - 脏文档（source_edits 非 pushed 行）跳过（local_edit_pending）；
 * - 白板 token 取自 PNG 文件名主干 token 段；解析不出 → 跳过并计入报告；
 * - 导出链与 S6 完全同一函数（whiteboard-bypass.ts 共享）；
 * - 命令 sync.whiteboard_backfill（mutate + BACKFILL，CLI+app_command 双通道）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
const { Hono } = require('hono');
import {
  SyncEngine,
  extractLocalWhiteboardRefs,
} from '../src/modules/sync-engine.js';
import { syncDocxToCustomFolder } from '../src/modules/custom-doc-sync.js';
import { syncRoutes } from '../src/routes/sync.js';
import { cliRoutes } from '../src/routes/cli.js';
import { findOpsCommand } from '../src/ops/command-table.js';
import { buildCommandArgs } from '../src/cli/args.js';
import type { DocumentRecord } from '../src/types/index.js';

const WB_TOKEN = 'wbTkBackfill01';
const WB_TOKEN_2 = 'wbTkBackfill02';

/** +export 双产物 mock（与 S6 whiteboard-bypass.test 同形）。 */
class ExportMockClient {
  exportWhiteboardCalls: Array<{ token: string; outputType: string; timeoutMs?: number }> = [];
  svgBehavior: 'ok' | 'timeout' = 'ok';

  async exportWhiteboard(
    token: string,
    opts: { outputType: 'svg' | 'raw'; outputPath: string; timeoutMs?: number },
  ): Promise<string> {
    this.exportWhiteboardCalls.push({
      token,
      outputType: opts.outputType,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (opts.outputType === 'svg') {
      if (this.svgBehavior === 'timeout') throw new Error('svg export timed out');
      fs.writeFileSync(opts.outputPath, '<svg xmlns="http://www.w3.org/2000/svg"><text>存量白板文字</text></svg>');
      return opts.outputPath;
    }
    fs.writeFileSync(opts.outputPath, JSON.stringify({ nodes: [{ id: 'n1', text: { text: '节点文字' } }] }));
    return opts.outputPath;
  }
}

/** backfill 最小 store 替身：documents 读面 + source_edits + 构建探针。 */
class BackfillStore {
  records = new Map<string, DocumentRecord>();
  sourceEdits = new Map<string, { state: string }>();
  activeBuild: Record<string, unknown> | null = null;
  writes: string[] = [];

  getDocumentByObjToken(objToken: string): DocumentRecord | null {
    return this.records.get(objToken) ?? null;
  }
  getAllDocuments(): DocumentRecord[] {
    return [...this.records.values()];
  }
  getSourceEdit(objToken: string): { state: string } | null {
    return this.sourceEdits.get(objToken) ?? null;
  }
  getActiveKbBuild(): Record<string, unknown> | null {
    return this.activeBuild;
  }
  upsertDocument(): void {
    this.writes.push('upsertDocument');
  }
  markDocumentSynced(): void {
    this.writes.push('markDocumentSynced');
  }
}

const dirs: Array<[string, string]> = [];
function makeDirs(): { kbRoot: string; opDir: string } {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backfill-kb-'));
  const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backfill-ops-'));
  dirs.push([kbRoot, opDir]);
  return { kbRoot, opDir };
}
afterEach(() => {
  while (dirs.length > 0) {
    const [kbRoot, opDir] = dirs.pop()!;
    fs.rmSync(kbRoot, { recursive: true, force: true });
    fs.rmSync(opDir, { recursive: true, force: true });
  }
});

interface SeedOptions {
  objToken?: string;
  relPath?: string;
  mdBody?: string;
  files?: string[];
}

/** 播种一个 synced 文档行 + md + images 文件。 */
function seedSyncedDoc(
  store: BackfillStore,
  kbRoot: string,
  options: SeedOptions = {},
): { objToken: string; mdPath: string } {
  const objToken = options.objToken ?? 'docxArchDiagram01';
  const relPath = options.relPath ?? '架构图/战斗系统.md';
  const mdPath = path.join(kbRoot, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  const body = options.mdBody ?? `# 战斗系统\n\n![飞书白板](images/01-${WB_TOKEN}.png)\n\n正文。\n`;
  fs.writeFileSync(mdPath, body);
  for (const file of options.files ?? [`images/01-${WB_TOKEN}.png`]) {
    fs.mkdirSync(path.dirname(path.join(path.dirname(mdPath), ...file.split('/'))), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(mdPath), ...file.split('/')), 'png-preview-bytes');
  }
  const record: DocumentRecord = {
    objToken,
    wikiNodeToken: 'wikinode01',
    objType: 'docx',
    title: '战斗系统',
    localMdPath: mdPath,
    lastSyncedModifyTime: '2026-10-01T00:00:00.000Z',
    lastSyncedAt: '2026-10-01T00:00:00.000Z',
    status: 'synced',
    observedObjEditTime: 1760000000,
    syncedObjEditTime: 1760000000,
    syncState: 'synced',
    localRelPath: relPath,
  };
  store.records.set(objToken, record);
  return { objToken, mdPath };
}

function makeEngine(
  kbRoot: string,
  opDir: string,
  client: ExportMockClient,
  store: BackfillStore,
): SyncEngine {
  return new SyncEngine({
    larkCliClient: client,
    localMapStore: store,
    config: { knowledgeBaseRoot: kbRoot, operationManifestDir: opDir, watchedRoots: [] },
  } as any);
}

describe('extractLocalWhiteboardRefs（本地 md 白板引用解析）', () => {
  it('识别两种标签形态（飞书白板/白板预览）并去重保序', () => {
    const md =
      `![飞书白板](images/01-${WB_TOKEN}.png)\n` +
      `![图片](images/02-normalimg.png)\n` +
      `![白板预览](images/03-${WB_TOKEN_2}.jpg)\n` +
      `![飞书白板](images/01-${WB_TOKEN}.png)\n`;
    expect(extractLocalWhiteboardRefs(md)).toEqual([
      `images/01-${WB_TOKEN}.png`,
      `images/03-${WB_TOKEN_2}.jpg`,
    ]);
  });
});

describe('SyncEngine.backfillWhiteboardBypass（P0-S8 硬验收）', () => {
  it('导出期间出现旁路文件时保留已有文件，不覆盖', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    seedSyncedDoc(store, kbRoot);
    const target = path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.wb.svg`);
    const original = client.exportWhiteboard.bind(client);
    vi.spyOn(client, 'exportWhiteboard').mockImplementation(async (token, opts) => {
      const result = await original(token, opts);
      fs.writeFileSync(target, '另一个操作写入的内容');
      return result;
    });
    const result = await makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass();
    expect(result.exported).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('另一个操作写入的内容');
  });

  it('导出期间文档变脏时不提交旁路', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    const { objToken } = seedSyncedDoc(store, kbRoot);
    const original = client.exportWhiteboard.bind(client);
    vi.spyOn(client, 'exportWhiteboard').mockImplementation(async (token, opts) => {
      const result = await original(token, opts);
      store.sourceEdits.set(objToken, { state: 'dirty' });
      return result;
    });
    await expect(makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass()).rejects.toThrow('状态发生变化');
    expect(fs.existsSync(path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.wb.svg`))).toBe(false);
  });

  it('拒绝指向根目录外的图片目录符号链接', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    const { mdPath } = seedSyncedDoc(store, kbRoot);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-outside-'));
    try {
      fs.rmSync(path.join(path.dirname(mdPath), 'images'), { recursive: true });
      fs.writeFileSync(path.join(outside, `01-${WB_TOKEN}.png`), 'preview');
      fs.symlinkSync(outside, path.join(path.dirname(mdPath), 'images'), 'dir');
      const result = await makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass();
      expect(result.exported).toBe(0);
      expect(client.exportWhiteboardCalls).toEqual([]);
      expect(fs.existsSync(path.join(outside, `01-${WB_TOKEN}.wb.svg`))).toBe(false);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  it('补齐 .wb.svg：md 字节与 DB 基线字段前后逐字段一致，只新增旁路文件', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    const { objToken, mdPath } = seedSyncedDoc(store, kbRoot);
    const mdBefore = fs.readFileSync(mdPath);
    const rowBefore = JSON.parse(JSON.stringify(store.records.get(objToken)));

    const engine = makeEngine(kbRoot, opDir, client, store);
    const result = await engine.backfillWhiteboardBypass();

    expect(result.scanned).toBe(1);
    expect(result.exported).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.committedFiles).toEqual([`架构图/images/01-${WB_TOKEN}.wb.svg`]);
    const svg = path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.wb.svg`);
    expect(fs.existsSync(svg)).toBe(true);
    expect(fs.readFileSync(svg, 'utf-8')).toContain('<svg');

    // 硬验收 1：md 字节不变（contentHash 推导源不变）
    const mdAfter = fs.readFileSync(mdPath);
    expect(mdAfter.equals(mdBefore)).toBe(true);
    expect(crypto.createHash('sha256').update(mdAfter).digest('hex'))
      .toBe(crypto.createHash('sha256').update(mdBefore).digest('hex'));
    // 硬验收 2：DB 行逐字段不变（含 synced_obj_edit_time / status / sync_state）
    expect(JSON.parse(JSON.stringify(store.records.get(objToken)))).toEqual(rowBefore);
    // 未触达任何写路径
    expect(store.writes).toEqual([]);
    // 只新增旁路文件：目录内其余文件字节不变
    const png = path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.png`);
    expect(fs.readFileSync(png, 'utf-8')).toBe('png-preview-bytes');
  });

  it('svg 失败 → raw 降级落 .wb.raw.json（同 S6 导出链）', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    client.svgBehavior = 'timeout';
    const store = new BackfillStore();
    seedSyncedDoc(store, kbRoot);

    const result = await makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass();

    expect(result.exported).toBe(1);
    expect(result.committedFiles).toEqual([`架构图/images/01-${WB_TOKEN}.wb.raw.json`]);
    expect(client.exportWhiteboardCalls.map((call) => call.outputType)).toEqual(['svg', 'raw']);
    expect(fs.existsSync(path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.wb.svg`))).toBe(false);
  });

  it('脏文档跳过（local_edit_pending）：不导出、不写盘', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    const { objToken } = seedSyncedDoc(store, kbRoot);
    store.sourceEdits.set(objToken, { state: 'dirty' });

    const result = await makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass();

    expect(result).toMatchObject({ scanned: 1, exported: 0 });
    expect(result.skipped).toEqual([{ objToken, reason: 'local_edit_pending' }]);
    expect(client.exportWhiteboardCalls).toEqual([]);
    expect(fs.existsSync(path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.wb.svg`))).toBe(false);
  });

  it('编辑状态读取失败时阻断补齐，不导出或写入旁路文件', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    seedSyncedDoc(store, kbRoot);
    vi.spyOn(store, 'getSourceEdit').mockImplementation(() => { throw new Error('database unavailable'); });

    await expect(makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass())
      .rejects.toThrow('database unavailable');
    expect(client.exportWhiteboardCalls).toEqual([]);
    expect(fs.existsSync(path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.wb.svg`))).toBe(false);
  });

  it('选择性 docTokens：命中导出；not_found / not_synced / 无白板引用行为', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    const plain = seedSyncedDoc(store, kbRoot, {
      objToken: 'docxPlainNoBoard1',
      relPath: '普通/无白板.md',
      mdBody: '# 无白板\n\n![图片](images/01-img.png)\n',
      files: ['images/01-img.png'],
    });
    const wb = seedSyncedDoc(store, kbRoot, {
      objToken: 'docxBoardSecond2',
      relPath: '架构图/第二份.md',
      mdBody: `![飞书白板](images/05-${WB_TOKEN_2}.png)\n`,
      files: [`images/05-${WB_TOKEN_2}.png`],
    });
    store.records.set('docxChangedRow3', {
      ...store.records.get(plain.objToken)!,
      objToken: 'docxChangedRow3',
      status: 'changed',
      syncState: 'pending_modified',
      syncedObjEditTime: null,
    });

    const result = await makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass({
      docTokens: [wb.objToken, plain.objToken, 'docxNoSuchToken9', 'docxChangedRow3'],
    });

    expect(result.scanned).toBe(2); // 白板文档 + 无白板文档（changed 行不计）
    expect(result.exported).toBe(1);
    expect(result.committedFiles).toEqual([`架构图/images/05-${WB_TOKEN_2}.wb.svg`]);
    expect(result.skipped).toEqual([
      { objToken: 'docxNoSuchToken9', reason: 'not_found' },
      { objToken: 'docxChangedRow3', reason: 'not_synced' },
    ]);
    // 未选中的 synced 文档不被触碰
    expect(fs.existsSync(path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.wb.svg`))).toBe(false);
  });

  it('already_present / token_unresolvable / png_missing 计入 skipped 报告', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    const present = seedSyncedDoc(store, kbRoot, {
      objToken: 'docxAlreadySvg001',
      relPath: '已补/存在.md',
      mdBody: `![飞书白板](images/01-${WB_TOKEN}.png)\n`,
      files: [`images/01-${WB_TOKEN}.png`, `images/01-${WB_TOKEN}.wb.svg`],
    });
    const unresolvable = seedSyncedDoc(store, kbRoot, {
      objToken: 'docxNoTokenStem02',
      relPath: '异常/无token.md',
      mdBody: '![飞书白板](images/board.png)\n',
      files: ['images/board.png'],
    });
    const missing = seedSyncedDoc(store, kbRoot, {
      objToken: 'docxPngMissing003',
      relPath: '缺图/无png.md',
      mdBody: `![飞书白板](images/07-${WB_TOKEN_2}.png)\n`,
      files: [],
    });

    const result = await makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass();

    expect(result.exported).toBe(0);
    expect(result.skipped).toEqual([
      { objToken: present.objToken, reason: `already_present:01-${WB_TOKEN}` },
      { objToken: unresolvable.objToken, reason: 'token_unresolvable:board' },
      { objToken: missing.objToken, reason: `png_missing:07-${WB_TOKEN_2}` },
    ]);
    expect(client.exportWhiteboardCalls).toEqual([]);
  });

  it('whiteboardExport 显式关闭 → 抛错拒绝（无文件写入）', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    seedSyncedDoc(store, kbRoot);
    const engine = new SyncEngine({
      larkCliClient: client,
      localMapStore: store,
      config: {
        knowledgeBaseRoot: kbRoot,
        operationManifestDir: opDir,
        watchedRoots: [],
        sync: { whiteboardExport: { enabled: false } },
      },
    } as any);

    await expect(engine.backfillWhiteboardBypass()).rejects.toThrow(/whiteboard_export_disabled/);
    expect(client.exportWhiteboardCalls).toEqual([]);
  });

  it('本地 md 行只有 localRelPath 时可解析（旧行兼容）', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    const seeded = seedSyncedDoc(store, kbRoot);
    // 模拟旧 DB 行：仅 localRelPath，localMdPath 为空
    store.records.set(seeded.objToken, {
      ...store.records.get(seeded.objToken)!,
      localMdPath: '',
      localRelPath: '架构图/战斗系统.md',
    });
    const result = await makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass();
    expect(result.exported).toBe(1);
  });

  it('重复 docTokens 去重：同一文档只扫描/导出一次', async () => {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    const { objToken } = seedSyncedDoc(store, kbRoot);
    const result = await makeEngine(kbRoot, opDir, client, store).backfillWhiteboardBypass({
      docTokens: [objToken, objToken],
    });
    expect(result).toMatchObject({ scanned: 1, exported: 1, skipped: [] });
    expect(client.exportWhiteboardCalls).toHaveLength(1);
  });
});

describe('custom-doc-sync 白板旁路接入（P0-S6 报告 §五遗留）', () => {
  const WB_CUSTOM_TOKEN = 'wbTkCustomFolder01A';

  class CustomDocMockClient {
    async fetchDocumentMarkdown() {
      return {
        data: {
          document: {
            content: `# 归档文档\n\n<whiteboard token="${WB_CUSTOM_TOKEN}"></whiteboard>\n`,
          },
        },
      };
    }
    async downloadMedia(token: string, filepath: string, type: string) {
      expect(type).toBe('whiteboard');
      const target = `${filepath}.png`;
      fs.writeFileSync(target, 'png-preview-bytes');
      // custom-doc 链直接消费 LarkCliClient.downloadMedia 的字符串返回值
      //（SyncEngine 经 execMediaDownload 另包一层 data.saved_path）。
      return target;
    }
    async previewMedia() {
      throw new Error('whiteboard 不走 preview');
    }
    async exportWhiteboard(
      token: string,
      opts: { outputType: 'svg' | 'raw'; outputPath: string },
    ): Promise<string> {
      expect(token).toBe(WB_CUSTOM_TOKEN);
      expect(opts.outputType).toBe('svg');
      fs.writeFileSync(opts.outputPath, '<svg><text>归档白板文字</text></svg>');
      return opts.outputPath;
    }
  }

  function makeCustomDirs(): { kbRoot: string; opDir: string } {
    const made = makeDirs();
    fs.mkdirSync(path.join(made.kbRoot, '_custom', '收藏'), { recursive: true });
    return made;
  }

  it('归档提交后 images/ 内 PNG 与 .wb.svg 同主干，md 只引用 PNG', async () => {
    const { kbRoot, opDir } = makeCustomDirs();
    const result = await syncDocxToCustomFolder({
      larkCliClient: new CustomDocMockClient() as any,
      knowledgeBaseRoot: kbRoot,
      operationDirectory: opDir,
      localMdPath: path.join(kbRoot, '_custom', '收藏', '归档文档.md'),
      objToken: 'docxCustomFold001',
      wikiNodeToken: null,
      title: '归档文档',
      originalLink: 'https://example.feishu.cn/wiki/xyz',
      objEditTime: null,
      spaceId: null,
    });

    const imagesDir = path.join(kbRoot, '_custom', '收藏', 'images');
    expect(fs.readdirSync(imagesDir).sort())
      .toEqual([`01-${WB_CUSTOM_TOKEN}.png`, `01-${WB_CUSTOM_TOKEN}.wb.svg`].sort());
    const md = fs.readFileSync(result.localMdPath, 'utf-8');
    expect(md).toContain(`![飞书白板](images/01-${WB_CUSTOM_TOKEN}.png)`);
    expect(md).not.toContain('.wb.svg');
    // 旁路文件计入 committedFiles（DB 失败回滚面覆盖它）
    expect(result.committedFiles).toContain(path.join(imagesDir, `01-${WB_CUSTOM_TOKEN}.wb.svg`));
  });

  it('whiteboardExport.enabled=false → 归档照常提交且零 +export 调用', async () => {
    const { kbRoot, opDir } = makeCustomDirs();
    const client = new CustomDocMockClient();
    const result = await syncDocxToCustomFolder({
      larkCliClient: client as any,
      knowledgeBaseRoot: kbRoot,
      operationDirectory: opDir,
      localMdPath: path.join(kbRoot, '_custom', '收藏', '归档文档.md'),
      objToken: 'docxCustomFold002',
      wikiNodeToken: null,
      title: '归档文档',
      originalLink: null,
      objEditTime: null,
      spaceId: null,
      whiteboardExport: { enabled: false },
    });
    expect(result.committedFiles).toHaveLength(2); // md + png，无旁路
    expect(fs.readdirSync(path.join(kbRoot, '_custom', '收藏', 'images')))
      .toEqual([`01-${WB_CUSTOM_TOKEN}.png`]);
  });
});

describe('命令表与 CLI 登记（sync.whiteboard_backfill）', () => {
  it('风险级/确认值/双通道登记与设计 §5.8 一致（agentExposed 按任务书双通道）', () => {
    const def = findOpsCommand('sync.whiteboard_backfill')!;
    expect(def).toBeDefined();
    expect(def.risk).toBe('mutate');
    expect(def.agentExposed).toBe(true);
    expect(def.confirm).toEqual({ field: 'confirm', value: 'BACKFILL' });
  });

  it('request()：缺省全量 body 只带 confirm；docTokens 透传', () => {
    const def = findOpsCommand('sync.whiteboard_backfill')!;
    expect(def.request({})).toEqual([
      { method: 'POST', path: '/api/sync/whiteboard-backfill', body: { confirm: 'BACKFILL' } },
    ]);
    expect(def.request({ docTokens: ['a', 'b'] })).toEqual([
      {
        method: 'POST',
        path: '/api/sync/whiteboard-backfill',
        body: { confirm: 'BACKFILL', docTokens: ['a', 'b'] },
      },
    ]);
  });

  it('CLI 位置参数：多 token 全量收集为 docTokens 数组', () => {
    const def = findOpsCommand('sync.whiteboard_backfill')!;
    expect(buildCommandArgs(def, ['tokA', 'tokB'])).toEqual({ docTokens: ['tokA', 'tokB'] });
    expect(buildCommandArgs(def, [])).toEqual({});
    // 旗标形态（JSON 数组）也可
    expect(buildCommandArgs(def, ['--doc-tokens', '["tokC"]'])).toEqual({ docTokens: ['tokC'] });
  });
});

describe('POST /api/sync/whiteboard-backfill（路由门控）', () => {
  function buildApp(
    deps: Partial<{
      store: BackfillStore;
      client: ExportMockClient;
      config: Record<string, unknown>;
    }>,
  ) {
    const app = new Hono();
    app.use('*', async (context: any, next: () => Promise<void>) => {
      Object.assign(context, {
        localMapStore: deps.store,
        larkCliClient: deps.client,
        configManager: { load: async () => deps.config },
      });
      await next();
    });
    app.route('/', syncRoutes);
    return app;
  }

  function routeFixture(overrides: { config?: Record<string, unknown>; store?: BackfillStore } = {}) {
    const { kbRoot, opDir } = makeDirs();
    const client = new ExportMockClient();
    const store = new BackfillStore();
    seedSyncedDoc(store, kbRoot);
    const config = {
      knowledgeBaseRoot: kbRoot,
      operationManifestDir: opDir,
      watchedRoots: [],
      ...(overrides.config ?? {}),
    };
    const app = buildApp({ store: overrides.store ?? store, client, config });
    return { app, store, client, kbRoot };
  }

  it('缺 confirm → 422 confirmation_required', async () => {
    const { app } = routeFixture();
    const res = await app.request('/api/sync/whiteboard-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('confirmation_required');
  });

  it('非法 docTokens → 400 invalid_doc_tokens', async () => {
    const { app } = routeFixture();
    const res = await app.request('/api/sync/whiteboard-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'BACKFILL', docTokens: [] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_doc_tokens');
  });

  it('whiteboardExport 显式关闭 → 400 whiteboard_export_disabled', async () => {
    const { app } = routeFixture({ config: { sync: { whiteboardExport: { enabled: false } } } });
    const res = await app.request('/api/sync/whiteboard-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'BACKFILL' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('whiteboard_export_disabled');
  });

  it('标准库构建活跃 → 409 kb_build_active（整个命令拒绝）', async () => {
    const store = new BackfillStore();
    store.activeBuild = { id: 'b1', status: 'running' };
    const { app } = routeFixture({ store });
    const res = await app.request('/api/sync/whiteboard-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'BACKFILL' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('kb_build_active');
  });

  it('成功路径：200 返回 {scanned, exported, skipped, committedFiles}', async () => {
    const { app, kbRoot } = routeFixture();
    const res = await app.request('/api/sync/whiteboard-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'BACKFILL' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ scanned: 1, exported: 1, skipped: [] });
    expect(json.committedFiles).toEqual([`架构图/images/01-${WB_TOKEN}.wb.svg`]);
    expect(fs.existsSync(path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.wb.svg`))).toBe(true);
  });

  it('CLI 执行域端到端：/api/cli/sync.whiteboard_backfill 转发可达目标路由', async () => {
    const { app, kbRoot } = routeFixture();
    const CLI_TEST_TOKEN = 'cli-token-wb-backfill-test-0001';
    // 真实 cliRoutes + cli-auth 三重校验 + 命令表转发（getApp 返回挂载
    // syncRoutes 的目标 app）；审计落临时 dataRoot。
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backfill-home-'));
    dirs.push([dataRoot, fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backfill-dummy-'))]);
    const cliApp = cliRoutes({
      cliEndpoint: {
        verify: (token: string) => token === CLI_TEST_TOKEN,
        getUrl: () => null,
        isPublished: () => true,
        revoke: () => {},
        rotate: () => {},
        publish: () => {},
      } as any,
      desktopToken: 'desktop-token-not-used-here',
      configManager: { getConfig: () => ({}), updateConfig: async () => {} } as any,
      getApp: () => app,
      dataRoot,
    });

    const res = await cliApp.request('http://127.0.0.1/api/cli/sync.whiteboard_backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cli-Token': CLI_TEST_TOKEN },
      body: JSON.stringify({ args: {}, confirm: 'BACKFILL' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data).toMatchObject({ scanned: 1, exported: 1, skipped: [] });
    expect(fs.existsSync(path.join(kbRoot, '架构图', 'images', `01-${WB_TOKEN}.wb.svg`))).toBe(true);
  });
});
