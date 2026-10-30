/**
 * P0-S6 白板旁路导出（svg 主 + raw 降级）— SyncEngine 全链路测试。
 *
 * 设计依据：lark-cli-newcaps-P0.md §5.1–§5.3 + §10 裁定 1（P0-S1 HP-4）：
 * - PNG 预览仍是 md 唯一引用（缺 PNG 阻断，现状不变）；
 * - svg 旁路导出失败/超时/校验不过 → 降级 raw 落 `.wb.raw.json`；
 * - 双失败只告警（whiteboard_svg_unavailable），正文照常提交；
 * - 旁路文件与 PNG 同主干（<stem>.wb.svg / <stem>.wb.raw.json），随
 *   atomic-commit extraFiles 入库，不进 requiredRelativePaths；
 * - md 正文与 feishu_sync 头字节零改动。
 *
 * 伴生资源生命周期（§5.2）：源清理（cleanupSources）现状只枚举 md +
 * workbook 伴生 + sheet CSV，不枚举 images/——旁路文件与 PNG 同生命周期
 * （清理后均保留原位），本文件末用例固化该一致性。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { LarkCliError } from '../src/modules/lark-cli-client.js';
import {
  normalizeSyncConfigLoose,
  validateSyncConfig,
  InvalidConfigError,
} from '../src/modules/config-manager.js';
import { cleanupSources } from '../src/kb/source-cleanup.js';
import type { ChangedDocument, DocumentRecord } from '../src/types/index.js';

const WB_TOKEN = 'wbTkWhiteboard01A';

/** 白板 docx 全链路 mock：PNG 走 media-download；+export 行为可配置。 */
class WhiteboardMockClient {
  exportWhiteboardCalls: Array<{ token: string; outputType: string; timeoutMs?: number }> = [];
  svgBehavior: 'ok' | 'timeout' | 'fail' | 'garbage' = 'ok';
  rawBehavior: 'ok' | 'fail' = 'ok';

  async fetchDocumentMarkdown() {
    return {
      data: {
        document: {
          content:
            `# 白板文档\n\n` +
            `<whiteboard token="${WB_TOKEN}"></whiteboard>\n\n` +
            `正文段落。\n`,
        },
      },
    };
  }

  async downloadMedia(token: string, filepath: string, type: string) {
    expect(type).toBe('whiteboard');
    expect(token).toBe(WB_TOKEN);
    const target = `${filepath}.png`;
    fs.writeFileSync(target, 'png-preview-bytes');
    return { data: { saved_path: target } };
  }

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
      if (this.svgBehavior === 'timeout') {
        // P0-S1 实测形态：服务端渲染超时 ~6.5s 即返回（S2 归 timeout 类）。
        throw new LarkCliError('API call failed: server time out error', 'timeout', true);
      }
      if (this.svgBehavior === 'fail') {
        throw new LarkCliError('whiteboard export failed', 'upstream', false);
      }
      const body = this.svgBehavior === 'garbage'
        ? '<html>not-a-board</html>'
        : '<svg xmlns="http://www.w3.org/2000/svg"><text>白板节点文字</text></svg>';
      fs.writeFileSync(opts.outputPath, body);
      return opts.outputPath;
    }
    if (this.rawBehavior === 'fail') {
      throw new LarkCliError('raw export failed', 'upstream', false);
    }
    fs.writeFileSync(opts.outputPath, JSON.stringify({ nodes: [{ id: 'n1', text: { text: '节点文字' } }] }));
    return opts.outputPath;
  }
}

/** syncDocuments 全链路 + cleanupSources 所需的最小 LocalMapStore 替身。 */
class WhiteboardPipelineStore {
  records = new Map<string, DocumentRecord>();
  upserted: Array<Record<string, unknown>> = [];
  markSyncedCalls: Array<Record<string, unknown>> = [];
  deletedSources: Array<{ root: string; objToken: string }> = [];

  getDocumentByObjToken(objToken: string): DocumentRecord | null {
    return this.records.get(objToken) ?? null;
  }
  getAllDocuments(): DocumentRecord[] {
    return [...this.records.values()];
  }
  getSheetSheets(): Array<Record<string, unknown>> {
    return [];
  }
  upsertDocument(record: DocumentRecord): void {
    this.upserted.push({ ...record });
  }
  markDocumentSynced(input: Record<string, unknown>): void {
    this.markSyncedCalls.push({ ...input });
  }
  withTransaction<T>(operation: () => T): T {
    return operation();
  }
  markLocalSourceDeleted(root: string, document: DocumentRecord): void {
    this.deletedSources.push({ root, objToken: document.objToken });
  }
  deleteDocumentsByTokens(): void {
    /* cleanupSources 默认 commit 分支 */
  }
  logSync(): void {
    /* syncDocuments 收尾日志 */
  }
}

interface RunOptions {
  whiteboardExport?: { enabled: boolean; svgTimeoutMs?: number };
  svgBehavior?: WhiteboardMockClient['svgBehavior'];
  rawBehavior?: WhiteboardMockClient['rawBehavior'];
}

async function runWhiteboardSync(options: RunOptions = {}): Promise<{
  kbRoot: string;
  opDir: string;
  client: WhiteboardMockClient;
  store: WhiteboardPipelineStore;
  result: Awaited<ReturnType<SyncEngine['syncDocuments']>>;
}> {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bypass-kb-'));
  const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bypass-ops-'));
  const client = new WhiteboardMockClient();
  if (options.svgBehavior) client.svgBehavior = options.svgBehavior;
  if (options.rawBehavior) client.rawBehavior = options.rawBehavior;
  const store = new WhiteboardPipelineStore();
  const engine = new SyncEngine({
    larkCliClient: client,
    localMapStore: store,
    config: {
      knowledgeBaseRoot: kbRoot,
      operationManifestDir: opDir,
      watchedRoots: [],
      watchedRootUrls: [],
      ...(options.whiteboardExport !== undefined
        ? { sync: { whiteboardExport: options.whiteboardExport } }
        : {}),
    },
  } as any);

  const doc: ChangedDocument = {
    objToken: 'doxcnWbBypass1',
    objType: 'docx',
    title: '白板文档',
    changeType: 'added',
    cloudModifiedTime: '2026-10-28T10:00:00.000Z',
    localSyncedTime: null,
    localMdPath: path.join(kbRoot, '白板文档.md'),
    observedObjEditTime: 1761645600,
  };
  const result = await engine.syncDocuments([doc], {
    enableLLM: false,
    fullSync: false,
    apply: true,
    confirmation: 'APPLY',
  });
  return { kbRoot, opDir, client, store, result };
}

function cleanup(root: string, dir: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('sync.whiteboardExport 配置契约（config-manager additive）', () => {
  it('宽容归一：缺段/非法 → enabled 默认 true，svgTimeoutMs 非法剔除', () => {
    expect(normalizeSyncConfigLoose(undefined).whiteboardExport).toEqual({ enabled: true });
    expect(normalizeSyncConfigLoose({}).whiteboardExport).toEqual({ enabled: true });
    expect(
      normalizeSyncConfigLoose({ whiteboardExport: { enabled: 'yes', svgTimeoutMs: -1 } })
        .whiteboardExport,
    ).toEqual({ enabled: true });
    expect(
      normalizeSyncConfigLoose({ whiteboardExport: { enabled: false, svgTimeoutMs: 6500 } })
        .whiteboardExport,
    ).toEqual({ enabled: false, svgTimeoutMs: 6500 });
  });

  it('严格校验：类型错位/非正数 svgTimeoutMs → InvalidConfigError', () => {
    expect(() => validateSyncConfig({ whiteboardExport: { enabled: 1 } })).toThrow(InvalidConfigError);
    expect(() =>
      validateSyncConfig({ whiteboardExport: { enabled: true, svgTimeoutMs: 0 } }),
    ).toThrow(InvalidConfigError);
    expect(() =>
      validateSyncConfig({ whiteboardExport: { enabled: true, svgTimeoutMs: '6500' } }),
    ).toThrow(InvalidConfigError);
    // 合法形态不抛：显式段与缺段都通过
    expect(() => validateSyncConfig(undefined)).not.toThrow();
    expect(() =>
      validateSyncConfig({ whiteboardExport: { enabled: true, svgTimeoutMs: 6500 } }),
    ).not.toThrow();
  });
});

describe('SyncEngine — P0-S6 白板旁路导出（svg 主 + raw 降级）', () => {
  it('svg 成功：.wb.svg 与 PNG 同主干入库，md 只引用 PNG，svgTimeoutMs 透传', async () => {
    const run = await runWhiteboardSync({ whiteboardExport: { enabled: true, svgTimeoutMs: 6500 } });
    try {
      expect(run.result.success).toBe(true);
      expect(run.result.syncedDocuments.length).toBe(1);

      const png = path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.png`);
      const svg = path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.wb.svg`);
      expect(fs.existsSync(png)).toBe(true);
      expect(fs.existsSync(svg)).toBe(true);
      expect(fs.readFileSync(svg, 'utf-8')).toContain('<svg');

      // md 唯一引用仍是 PNG 预览（§5.1：PNG 必需资源，旁路不被引用）
      const md = fs.readFileSync(path.join(run.kbRoot, '白板文档.md'), 'utf-8');
      expect(md).toContain(`![飞书白板](images/01-${WB_TOKEN}.png)`);
      expect(md).not.toContain('.wb.svg');
      expect(md).not.toContain('.wb.raw.json');

      // 超时预算由调用方传入（§10 裁定 1）
      expect(run.client.exportWhiteboardCalls).toEqual([
        { token: WB_TOKEN, outputType: 'svg', timeoutMs: 6500 },
      ]);

      // synced 基线照常推进（旁路失败语义不影响）
      expect(run.store.markSyncedCalls.length).toBe(1);
    } finally {
      cleanup(run.kbRoot, run.opDir);
    }
  });

  it('svg 超时 → raw 降级：落 .wb.raw.json，无 .wb.svg 残留', async () => {
    const run = await runWhiteboardSync({
      whiteboardExport: { enabled: true, svgTimeoutMs: 6500 },
      svgBehavior: 'timeout',
    });
    try {
      expect(run.result.success).toBe(true);
      expect(run.client.exportWhiteboardCalls.map((call) => call.outputType)).toEqual(['svg', 'raw']);

      const raw = path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.wb.raw.json`);
      const svg = path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.wb.svg`);
      expect(fs.existsSync(raw)).toBe(true);
      expect(JSON.parse(fs.readFileSync(raw, 'utf-8'))).toHaveProperty('nodes');
      expect(fs.existsSync(svg)).toBe(false);
    } finally {
      cleanup(run.kbRoot, run.opDir);
    }
  });

  it('svg 校验不过（无 <svg 头）→ 删残留并降级 raw', async () => {
    const run = await runWhiteboardSync({ svgBehavior: 'garbage' });
    try {
      expect(run.result.success).toBe(true);
      expect(fs.existsSync(path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.wb.raw.json`))).toBe(true);
      // 校验不过的 svg 产物绝不入库（§5.3：删 staging 残留）
      expect(fs.existsSync(path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.wb.svg`))).toBe(false);
    } finally {
      cleanup(run.kbRoot, run.opDir);
    }
  });

  it('双失败：仅告警不阻断，正文照常提交且无旁路残留', async () => {
    const run = await runWhiteboardSync({ svgBehavior: 'fail', rawBehavior: 'fail' });
    try {
      expect(run.result.success).toBe(true);
      expect(run.result.failedDocuments.length).toBe(0);
      expect(run.client.exportWhiteboardCalls.length).toBe(2);

      const md = fs.readFileSync(path.join(run.kbRoot, '白板文档.md'), 'utf-8');
      expect(md).toContain(`![飞书白板](images/01-${WB_TOKEN}.png)`);
      expect(fs.existsSync(path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.wb.svg`))).toBe(false);
      expect(fs.existsSync(path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.wb.raw.json`))).toBe(false);
      expect(run.store.markSyncedCalls.length).toBe(1);
    } finally {
      cleanup(run.kbRoot, run.opDir);
    }
  });

  it('配置关闭：零导出调用，md 与双失败场景逐字节一致（旁路链不改正文字节）', async () => {
    const disabled = await runWhiteboardSync({ whiteboardExport: { enabled: false } });
    const failed = await runWhiteboardSync({ svgBehavior: 'fail', rawBehavior: 'fail' });
    try {
      expect(disabled.client.exportWhiteboardCalls).toEqual([]);

      const disabledMd = fs.readFileSync(path.join(disabled.kbRoot, '白板文档.md'), 'utf-8');
      const failedMd = fs.readFileSync(path.join(failed.kbRoot, '白板文档.md'), 'utf-8');
      expect(disabledMd).toBe(failedMd);
      expect(disabledMd).toContain(`![飞书白板](images/01-${WB_TOKEN}.png)`);
    } finally {
      cleanup(disabled.kbRoot, disabled.opDir);
      cleanup(failed.kbRoot, failed.opDir);
    }
  });

  it('伴生生命周期：源清理移走 md 后，旁路文件与 PNG 行为一致（均保留原位）', async () => {
    const run = await runWhiteboardSync({});
    try {
      const png = path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.png`);
      const svg = path.join(run.kbRoot, 'images', `01-${WB_TOKEN}.wb.svg`);
      expect(fs.existsSync(png) && fs.existsSync(svg)).toBe(true);

      // prepareSourceCleanup/cleanupSources 是源清理公共咽喉（source-batch/
      // manual-delete/kb routes 全部经此）；其文件枚举面 = md + workbook
      // 伴生 + sheet CSV，不含 images/——PNG 与旁路文件同生命周期。
      run.store.records.set('doxcnWbBypass1', {
        objToken: 'doxcnWbBypass1',
        objType: 'docx',
        title: '白板文档',
        localMdPath: path.join(run.kbRoot, '白板文档.md'),
        localRelPath: '白板文档.md',
        lastSyncedModifyTime: '2026-10-28T10:00:00.000Z',
        lastSyncedAt: '2026-10-28T10:00:00.000Z',
        status: 'synced',
      } as DocumentRecord);
      const cleaned = cleanupSources(run.store, run.kbRoot, [
        { objToken: 'doxcnWbBypass1', relPath: '白板文档.md' },
      ]);
      expect(cleaned.cleaned).toBe(1);
      expect(run.store.deletedSources).toEqual([{ root: run.kbRoot, objToken: 'doxcnWbBypass1' }]);
      expect(fs.existsSync(path.join(run.kbRoot, '白板文档.md'))).toBe(false);
      expect(fs.existsSync(png)).toBe(true);
      expect(fs.existsSync(svg)).toBe(true);
    } finally {
      cleanup(run.kbRoot, run.opDir);
    }
  });
});
