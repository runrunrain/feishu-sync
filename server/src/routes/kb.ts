/**
 * KB 路由（设计 §9.2 / §9.5）— desktop auth 之后
 *
 * 标准库状态/树/文档/搜索、构建 CRUD 与 SSE、MCP 连接信息。
 * 只读查询不依赖 SQLite；构建状态来自 kb_builds 表。
 */

import { SnapshotService } from '../modules/snapshot-service.js';
import { cleanupSources } from '../kb/source-cleanup.js';
import { createLocalPathInspector } from '../modules/local-path-state.js';
import type { KbSourceChoice } from '../types/kb-version.js';
import { buildSourceTree } from '../kb/source-tree.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KbBuildService } from '../kb/kb-build-service.js';
import { StandardKbStore, KbNotPublishedError } from '../kb/standard-kb-store.js';
import { RawSourceSnapshot, collectSourceCandidates } from '../kb/raw-source-snapshot.js';
import { KbVersionStore, captureSourceContents, sourceChangePreview, validReleaseId } from '../kb/kb-version-store.js';
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

  const sourceDocuments = (root: string) => {
    const excluded = new Set(localMapStore.listKbExcludedSources(root));
    return deps.documentsProvider().filter((doc) => !excluded.has(doc.objToken));
  };

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
        sourceDocuments(config.knowledgeBaseRoot),
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
        sourceDocuments(config.knowledgeBaseRoot),
        deps.sheetCsvPaths,
      );
      const currentByToken = new Map(scan.entries.map((entry) => [entry.objToken, entry.contentHash]));
      const excluded = new Set(localMapStore.listKbExcludedSources(config.knowledgeBaseRoot));
      const sources = doc.sources.map((objToken) => {
        const snapshotEntry = manifest.sourceSnapshot.find((candidate) => candidate.objToken === objToken);
        const currentHash = currentByToken.get(objToken);
        let state: KbSourceState = 'current';
        if (excluded.has(objToken)) state = 'excluded';
        else if (currentHash === undefined) state = 'missing';
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

  // 源选择与版本入口独立于正文。标记只写应用元数据，不编辑原始文件。
  const sourceChoices = async () => {
      const { store, config } = await loadStore();
      const excluded = new Set(localMapStore.listKbExcludedSources(config.knowledgeBaseRoot));
      const manifest = store.readManifest();
      const documents = deps.documentsProvider();
      const scan = RawSourceSnapshot.scan(config.knowledgeBaseRoot, documents.filter((doc) => !excluded.has(doc.objToken)), deps.sheetCsvPaths);
      const current = new Map(scan.entries.map((entry) => [entry.objToken, entry]));
      const base = new Map((manifest?.sourceSnapshot ?? []).map((entry) => [entry.objToken, entry]));
      const candidates = new Map(collectSourceCandidates(documents).map((doc) => [doc.objToken, { title: doc.title, relPath: doc.localRelPath! }]));
      // 当前选择仅列实际存在的本地源；旧版本引用留在差异/版本入口。
      const inspect = createLocalPathInspector(config.knowledgeBaseRoot);
      for (const [token, doc] of candidates) if (inspect(doc.relPath) !== 'present') candidates.delete(token);
      const choices: KbSourceChoice[] = [...candidates].map(([objToken, doc]) => {
        const old = base.get(objToken); const next = current.get(objToken);
        const isExcluded = excluded.has(objToken);
        const pending = isExcluded ? (old ? 'removed' : 'excluded') : !next ? (old ? 'removed' : 'unchanged')
          : !old ? 'added' : next.contentHash !== old.contentHash || next.relPath !== old.relPath || next.title !== old.title ? 'changed' : 'unchanged';
        return { objToken, title: doc.title || objToken, relPath: doc.relPath, included: !isExcluded, published: Boolean(old), pending };
      });
    return { choices, config, documents };
  };
  routes.get('/api/kb/sources', async (c) => {
    try {
      const { choices } = await sourceChoices();
      const q = (c.req.query('q') ?? '').slice(0, 200).toLowerCase();
      const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50));
      const page = Math.max(1, Math.floor(Number(c.req.query('page')) || 1));
      const all = choices.filter((doc) => `${doc.title} ${doc.relPath} ${doc.objToken}`.toLowerCase().includes(q)).sort((a,b) => a.relPath.localeCompare(b.relPath));
      return c.json({ sources: all.slice((page-1)*limit, page*limit), total: all.length, page, limit });
    } catch (error) { return errorResponse(c, error); }
  });
  routes.get('/api/kb/sources/tree', async (c) => {
    try { const { choices, config, documents } = await sourceChoices();
      return c.json({ root: config.knowledgeBaseRoot, nodes: buildSourceTree(documents, choices), total: choices.length });
    } catch (error) { return errorResponse(c, error); }
  });
  routes.post('/api/kb/sources/selection', async (c) => {
    try {
      const body = await c.req.json();
      if (!body || !['include','exclude','invert'].includes(body.action) || !Array.isArray(body.tokens) || !body.tokens.length || body.tokens.length > 50000 || !body.tokens.every((token: unknown) => typeof token === 'string'))
        throw new ToolError('invalid_request', '请提供操作类型和1–50000个源文档标识');
      const { store, config } = await loadStore();
      if (body.root !== config.knowledgeBaseRoot) throw new ToolError('source_selection_changed', '原始库已变化，请刷新后再选择', 409);
      const valid = new Set([...collectSourceCandidates(deps.documentsProvider()).map((doc) => doc.objToken), ...(store.readManifest()?.sourceSnapshot.map((entry) => entry.objToken) ?? [])]);
      if (body.tokens.some((token: string) => !valid.has(token))) throw new ToolError('source_not_found', '部分源文档已不存在，请刷新', 404);
      if (buildService.activeBuild(localMapStore)) throw new ToolError('kb_build_running', '更新进行中，请结束后再调整源文档', 409);
      return c.json({ selection: localMapStore.setKbSourcesIncluded(config.knowledgeBaseRoot, body.tokens, body.action) });
    } catch (error) { return errorResponse(c, error); }
  });

  routes.post('/api/kb/sources/cleanup', async (c) => {
    try {
      const body = await c.req.json();
      if (body?.confirm !== 'CLEANUP' || !Array.isArray(body.sources) || !body.sources.length || body.sources.length > 50000
        || !body.sources.every((source: unknown) => source && typeof source === 'object' && typeof (source as any).objToken === 'string' && typeof (source as any).relPath === 'string'))
        throw new ToolError('invalid_request', '请确认清理并提供明确的源文档清单', 400);
      const { config } = await loadStore();
      if (body.root !== config.knowledgeBaseRoot) throw new ToolError('source_selection_changed', '原始库已变化，请刷新后重新选择', 409);
      if (buildService.activeBuild(localMapStore)) throw new ToolError('kb_build_running', '更新进行中，暂不能清理源文档', 409);
      const result = cleanupSources(localMapStore, config.knowledgeBaseRoot, body.sources);
      try { new SnapshotService(localMapStore, configManager, { larkCliClient: null, config }).generate(); }
      catch (error) { console.warn('[kb] source cleanup snapshot refresh failed:', error); }
      return c.json(result);
    } catch (error) { return errorResponse(c, error); }
  });

  routes.put('/api/kb/sources/:objToken', async (c) => {
    try {
      const body = await c.req.json() as { included?: unknown };
      if (typeof body.included !== 'boolean') return c.json({ error: 'invalid_request', message: 'included必须为boolean' }, 400);
      if (buildService.activeBuild(localMapStore)) return c.json({ error: 'kb_build_running', message: '更新进行中，请结束后再调整源文档' }, 409);
      const { store, config } = await loadStore();
      const token = c.req.param('objToken');
      if (!deps.documentsProvider().some((doc) => doc.objToken === token)
        && !store.readManifest()?.sourceSnapshot.some((entry) => entry.objToken === token))
        return c.json({ error: 'source_not_found', message: '原始文档不存在' }, 404);
      if (buildService.activeBuild(localMapStore)) throw new ToolError('kb_build_running', '更新进行中，请结束后再调整源文档', 409);
      localMapStore.setKbSourceExcluded(config.knowledgeBaseRoot, token, !body.included);
      return c.json({ objToken: token, included: body.included });
    } catch (error) { return errorResponse(c, error); }
  });

  routes.get('/api/kb/changes', async (c) => {
    try {
      const { store, config } = await loadStore();
      const manifest = store.readManifest();
      const scan = RawSourceSnapshot.scan(config.knowledgeBaseRoot, sourceDocuments(config.knowledgeBaseRoot), deps.sheetCsvPaths);
      const snapshot = RawSourceSnapshot.fromEntries(scan.entries, { sheetCsvPaths: deps.sheetCsvPaths });
      const contents = captureSourceContents(snapshot, config.knowledgeBaseRoot);
      const versions = new KbVersionStore(config.standardKb.outputRoot);
      return c.json(sourceChangePreview(snapshot, contents, manifest, versions.readSourceContents(manifest?.releaseId ?? null),
        new Set(localMapStore.listKbExcludedSources(config.knowledgeBaseRoot))));
    } catch (error) { return errorResponse(c, error); }
  });

  routes.get('/api/kb/versions', async (c) => {
    try {
      const { config } = await loadStore();
      return c.json({ versions: new KbVersionStore(config.standardKb.outputRoot).listVersions(), retainReleases: config.standardKb.retainReleases });
    } catch (error) { return errorResponse(c, error); }
  });

  routes.get('/api/kb/versions/:releaseId', async (c) => {
    try {
      const id = c.req.param('releaseId');
      if (!validReleaseId(id)) return c.json({ error: 'invalid_request', message: '版本标识无效' }, 400);
      const { config } = await loadStore();
      const version = new KbVersionStore(config.standardKb.outputRoot).readVersion(id);
      if (!version) return c.json({ error: 'version_not_found', message: '版本不存在或已按保留策略清理' }, 404);
      return c.json(version);
    } catch (error) { return errorResponse(c, error); }
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
