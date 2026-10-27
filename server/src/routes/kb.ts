/**
 * KB 路由（设计 §9.2 / §9.5）— desktop auth 之后
 *
 * 标准库状态/树/文档/搜索、构建 CRUD 与 SSE、MCP 连接信息。
 * 只读查询不依赖 SQLite；构建状态来自 kb_builds 表。
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KbBuildService } from '../kb/kb-build-service.js';
import { StandardKbStore, KbNotPublishedError } from '../kb/standard-kb-store.js';
import { RawSourceSnapshot } from '../kb/raw-source-snapshot.js';
import { computeChangeset } from '../kb/kb-build-service.js';
import { ToolError } from '../agent/agent-tool-service.js';
import type { LocalMapStore } from '../modules/local-map-store.js';
import type { ConfigManager } from '../modules/config-manager.js';
import { resolveDataRoot } from '../modules/data-root.js';
import type { KbDocDto, KbMcpInfoDto, KbSourceState, KbStatusDto } from '../types/agent-knowledge.js';

export interface KbRouteDeps {
  buildService: KbBuildService;
  configManager: ConfigManager;
  localMapStore: LocalMapStore;
  documentsProvider: () => import('../types/index.js').DocumentRecord[];
  sheetCsvPaths: (objToken: string) => string[];
}

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ToolError) {
    return c.json({ error: error.code, message: error.message }, error.status as ContentfulStatusCode) as unknown as Response;
  }
  if (error instanceof KbNotPublishedError) {
    return c.json({ error: 'kb_not_published', message: error.message }, 404) as unknown as Response;
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: 'internal_error', message }, 500) as unknown as Response;
}

/** 当前原始源 vs manifest 快照的源状态与 pending 计数。 */
function compareSources(
  manifest: { sourceSnapshot: Array<{ objToken: string; contentHash: string }> } | null,
  currentEntries: Array<{ objToken: string; contentHash: string }>,
  sheetCsvPaths: (objToken: string) => string[],
  knowledgeBaseRoot: string,
): { pending: { added: number; changed: number; removed: number } } {
  if (!manifest) {
    return { pending: { added: currentEntries.length, changed: 0, removed: 0 } };
  }
  const changeset = computeChangeset(currentEntries as never, manifest as never);
  void sheetCsvPaths;
  void knowledgeBaseRoot;
  return {
    pending: {
      added: changeset.added.length,
      changed: changeset.changed.length,
      removed: changeset.removed.length,
    },
  };
}

export function kbRoutes(deps: KbRouteDeps): Hono {
  const routes = new Hono();
  const { buildService, configManager, localMapStore } = deps;

  async function loadStore(): Promise<{ store: StandardKbStore; config: Awaited<ReturnType<ConfigManager['load']>> }> {
    const config = await configManager.load();
    return { store: new StandardKbStore(config.standardKb.outputRoot), config };
  }

  // ------------------------------------------------------------------
  // 只读查询
  // ------------------------------------------------------------------

  routes.get('/api/kb/status', async (c) => {
    try {
      const { store, config } = await loadStore();
      const current = store.readCurrent();
      const manifest = store.readManifest();
      const scan = RawSourceSnapshot.scan(
        config.knowledgeBaseRoot,
        deps.documentsProvider(),
        deps.sheetCsvPaths,
      );
      const { pending } = compareSources(manifest, scan.entries, deps.sheetCsvPaths, config.knowledgeBaseRoot);
      const dto: KbStatusDto = {
        outputRoot: config.standardKb.outputRoot,
        current: current && manifest
          ? {
            releaseId: manifest.releaseId,
            buildId: manifest.buildId,
            publishedAt: manifest.publishedAt,
            docCount: manifest.docs.length,
            sourceCount: manifest.sourceSnapshot.length,
            model: manifest.model,
          }
          : null,
        pending,
        activeBuild: buildService.activeBuild(localMapStore),
      };
      return c.json(dto);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get('/api/kb/tree', async (c) => {
    try {
      const { store } = await loadStore();
      const manifest = store.readManifest();
      if (!manifest) {
        return c.json({ error: 'kb_not_published', message: '标准知识库尚未发布' }, 404);
      }
      return c.json({ releaseId: manifest.releaseId, nodes: store.buildTree(manifest) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get('/api/kb/docs/:docId', async (c) => {
    try {
      const { store } = await loadStore();
      const manifest = store.readManifest();
      if (!manifest) {
        return c.json({ error: 'kb_not_published', message: '标准知识库尚未发布' }, 404);
      }
      const doc = store.findDoc(manifest, { docId: c.req.param('docId') });
      if (!doc) {
        return c.json({ error: 'kb_doc_not_found', message: '标准文档不存在' }, 404);
      }
      const loaded = store.readReleaseDoc(manifest.releaseId, doc);
      // 源状态：与当前原始库比较
      const config = await configManager.load();
      const scan = RawSourceSnapshot.scan(
        config.knowledgeBaseRoot,
        deps.documentsProvider(),
        deps.sheetCsvPaths,
      );
      const currentByToken = new Map(scan.entries.map((entry) => [entry.objToken, entry.contentHash]));
      const sources = doc.sources.map((objToken) => {
        const snapshotEntry = manifest.sourceSnapshot.find((candidate) => candidate.objToken === objToken);
        const currentHash = currentByToken.get(objToken);
        let state: KbSourceState = 'current';
        if (currentHash === undefined) state = 'missing';
        else if (snapshotEntry && snapshotEntry.contentHash !== currentHash) state = 'changed';
        return {
          objToken,
          title: snapshotEntry?.title ?? objToken,
          relPath: snapshotEntry?.relPath ?? '',
          state,
        };
      });
      const dto: KbDocDto = {
        docId: doc.docId,
        path: doc.path,
        title: doc.title,
        summary: doc.summary,
        tags: doc.tags,
        markdown: loaded.markdown,
        releaseId: manifest.releaseId,
        updatedInBuild: doc.updatedInBuild,
        sources,
      };
      return c.json(dto);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get('/api/kb/search', async (c) => {
    try {
      const q = c.req.query('q') ?? '';
      if (q.length < 1 || q.length > 200) {
        return c.json({ error: 'invalid_request', message: 'q 长度必须在 1..200' }, 400);
      }
      const limitParam = Number.parseInt(c.req.query('limit') ?? '20', 10);
      const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(20, limitParam)) : 20;
      const { store } = await loadStore();
      const manifest = store.readManifest();
      if (!manifest) {
        return c.json({ error: 'kb_not_published', message: '标准知识库尚未发布' }, 404);
      }
      return c.json({ releaseId: manifest.releaseId, results: store.search(manifest, q, limit) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // ------------------------------------------------------------------
  // 构建
  // ------------------------------------------------------------------

  routes.post('/api/kb/builds', async (c) => {
    try {
      const body = await c.req.json() as { mode?: string; confirm?: string };
      const dto = await buildService.createBuild(localMapStore as never, body);
      return c.json(dto, 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get('/api/kb/builds', (c) => {
    const limitParam = Number.parseInt(c.req.query('limit') ?? '20', 10);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(100, limitParam)) : 20;
    const rows = localMapStore.listKbBuilds(limit);
    return c.json({ builds: rows.map((row) => buildService.toDto(row)) });
  });

  routes.get('/api/kb/builds/:id', (c) => {
    const row = localMapStore.getKbBuild(c.req.param('id'));
    if (!row) {
      return c.json({ error: 'build_not_found', message: '构建不存在' }, 404);
    }
    const dto = buildService.toDto(row);
    // report.json（失败时存在）
    const outputRoot = buildServiceDepsOutputRoot(deps);
    const reportPath = path.join(outputRoot, '.builds', String(row.id), 'report.json');
    if (fs.existsSync(reportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as { issues?: unknown };
        return c.json({ ...dto, report });
      } catch {
        /* report 损坏时忽略 */
      }
    }
    return c.json(dto);
  });

  routes.post('/api/kb/builds/:id/cancel', async (c) => {
    try {
      const dto = await buildService.cancelBuild(localMapStore as never, c.req.param('id'));
      if (!dto) return c.json({ error: 'build_not_found', message: '构建不存在' }, 404);
      return c.json(dto);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // 构建 SSE
  routes.get('/api/kb/builds/:id/events', (c) => {
    const buildId = c.req.param('id');
    const lastEventHeader = c.req.header('Last-Event-ID');
    const lastSeq = lastEventHeader !== undefined && /^-?\d+$/.test(lastEventHeader)
      ? Number.parseInt(lastEventHeader, 10)
      : null;
    const initial = buildService.eventsSince(buildId, lastSeq);
    return streamSSE(c, async (stream) => {
      for (const record of initial) {
        await stream.writeSSE({ id: String(record.seq), event: record.event, data: JSON.stringify(record.data) });
      }
      const closed = { value: false };
      const wake = { resolve: null as null | (() => void) };
      const listener = (payload: { buildId: string }) => {
        if (payload.buildId !== buildId) return;
        wake.resolve?.();
      };
      buildService.on('sse', listener);
      stream.onAbort(() => {
        closed.value = true;
        buildService.off('sse', listener);
        wake.resolve?.();
      });
      let cursor = initial.length > 0 ? initial[initial.length - 1].seq : (lastSeq ?? 0);
      while (!closed.value) {
        const pending = buildService.eventsSince(buildId, cursor);
        for (const record of pending) {
          await stream.writeSSE({ id: String(record.seq), event: record.event, data: JSON.stringify(record.data) });
          cursor = record.seq;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          timer.unref?.();
          wake.resolve = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake.resolve = null;
        await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => undefined);
      }
    });
  });

  // ------------------------------------------------------------------
  // MCP 连接信息（§9.5）
  // ------------------------------------------------------------------

  routes.get('/api/kb/mcp', async (c) => {
    const config = await configManager.load();
    const mcpScript = path.join(serverDistRoot(), 'mcp', 'kb-mcp.cjs');
    const available = fs.existsSync(mcpScript);
    const kbRoot = config.standardKb.outputRoot;

    // 推荐配置：应用自带 Electron 可执行（ELECTRON_RUN_AS_NODE=1）；
    // standalone/开发模式（node 直跑）用当前 Node。
    const isElectron = Boolean(process.versions.electron);
    const primaryCommand = isElectron ? process.execPath : process.execPath;
    const primaryEnv: Record<string, string> = isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {};

    const dto: KbMcpInfoDto = {
      available,
      command: primaryCommand,
      args: [mcpScript, '--kb-root', kbRoot],
      env: primaryEnv,
      alternative: {
        command: 'node',
        args: [mcpScript, '--kb-root', kbRoot],
        note: '外部 Node ≥20 亦可运行（kb-mcp.cjs 无原生依赖、不打开 SQLite）',
      },
      snippet: JSON.stringify({
        mcpServers: {
          'feishu-kb': {
            command: primaryCommand,
            args: [mcpScript, '--kb-root', kbRoot],
            ...(Object.keys(primaryEnv).length > 0 ? { env: primaryEnv } : {}),
          },
        },
      }, null, 2),
    };
    return c.json(dto);
  });

  return routes;
}

function serverDistRoot(): string {
  // 本文件编译后位于 dist/routes/kb.js；dist 根即上溯一级
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function buildServiceDepsOutputRoot(deps: KbRouteDeps): string {
  return deps.configManager.getConfig()?.standardKb.outputRoot ?? path.join(resolveDataRoot(), 'standard-kb');
}
