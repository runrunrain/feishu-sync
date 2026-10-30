/**
 * KB 路由（设计 §9.2 / §9.5）— desktop auth 之后
 *
 * 标准库状态/树/文档/搜索、构建 CRUD 与 SSE、MCP 连接信息。
 * 只读查询不依赖 SQLite；构建状态来自 kb_builds 表。
 */

import { SnapshotService } from '../modules/snapshot-service.js';
import { cleanupSources } from '../kb/source-cleanup.js';
import { createLocalPathInspector } from '../modules/local-path-state.js';
import { filterDeletedLocalDocuments } from '../modules/local-index-reconcile.js';
import type { KbSourceChoice } from '../types/kb-version.js';
import { buildSourceTree } from '../kb/source-tree.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import fs from 'node:fs';
import path from 'node:path';
import type { KbBuildService } from '../kb/kb-build-service.js';
import { StandardKbStore, KbNotPublishedError } from '../kb/standard-kb-store.js';
import { QueryError } from '../kb/search/kb-query-service.js';
import { RawSourceSnapshot, collectSourceCandidates } from '../kb/raw-source-snapshot.js';
import { KbVersionStore, captureSourceContents, sourceChangePreview, validReleaseId } from '../kb/kb-version-store.js';
import type { KbChangePreview } from '../types/kb-version.js';
import { computeChangeset } from '../kb/kb-build-service.js';
import { enrichEntriesWithWhiteboardTextHash } from '../kb/source-images.js';
import { hashImageFile, resolveSourceImages } from '../kb/source-images.js';
import { ToolError } from '../agent/agent-tool-service.js';
import type { LocalMapStore } from '../modules/local-map-store.js';
import type { ConfigManager } from '../modules/config-manager.js';
import { resolveDataRoot } from '../modules/data-root.js';
import { kbMcpInfo } from '../kb/mcp-info.js';
import type { KbDocDto, KbSourceState, KbStatusDto } from '../types/agent-knowledge.js';

export interface KbRouteDeps {
  buildService: KbBuildService;
  configManager: ConfigManager;
  localMapStore: LocalMapStore;
  documentsProvider: () => import('../types/index.js').DocumentRecord[];
  sheetCsvPaths: (objToken: string) => string[];
}

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof QueryError) {
    const status = error.code.startsWith('invalid_') ? 400 : ['kb_not_published', 'kb_release_unavailable', 'kb_not_found'].includes(error.code) ? 404 : 500;
    return c.json({ error: error.code, message: error.message, details: error.details }, status) as unknown as Response;
  }
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
  // P0-S7：status 预览同样按白板旁路文字判定——scan 条目缺该字段时会与
  // 非空 manifest 值恒不等而虚报 changed；先补算再比较（mediaHash 语义不变）。
  enrichEntriesWithWhiteboardTextHash(knowledgeBaseRoot, currentEntries as never);
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

/**
 * P1-S3（设计 §2.3）：被引用计数——入链按 obj_token 与 wiki_node_token
 * 双键并集，同一文档两个键的计数相加（S4 UI 徽标；无 source_references
 * 方法时返回空 Map，老库/替身安全降级）。
 */
function countIncomingReferences(
  store: LocalMapStore,
  documents: Array<import('../types/index.js').DocumentRecord>,
): Map<string, number> {
  if (typeof store.countSourceReferencesByTarget !== 'function') return new Map();
  const byTarget = store.countSourceReferencesByTarget();
  const out = new Map<string, number>();
  for (const doc of documents) {
    let count = byTarget.get(doc.objToken) ?? 0;
    if (doc.wikiNodeToken && doc.wikiNodeToken !== doc.objToken) {
      count += byTarget.get(doc.wikiNodeToken) ?? 0;
    }
    if (count > 0) out.set(doc.objToken, count);
  }
  return out;
}

/** S3（§3.6）：待处理源（added/changed）引用图片的总数与未缓存数。 */
async function countPendingImages(
  knowledgeBaseRoot: string,
  snapshot: RawSourceSnapshot,
  preview: KbChangePreview,
  lookup: ((imageHash: string) => Promise<string | null>) | null,
): Promise<{ total: number; uncached: number }> {
  const pendingTokens = new Set(
    preview.sources
      .filter((change) => change.kind === 'added' || change.kind === 'changed')
      .map((change) => change.key),
  );
  if (pendingTokens.size === 0) return { total: 0, uncached: 0 };
  let total = 0;
  const hashes: string[] = [];
  for (const token of pendingTokens) {
    const entry = snapshot.get(token);
    if (!entry) continue;
    try {
      const content = fs.readFileSync(path.join(knowledgeBaseRoot, entry.relPath), 'utf-8');
      for (const image of resolveSourceImages(knowledgeBaseRoot, entry.relPath, content)) {
        total += 1;
        const hash = hashImageFile(image.file);
        if (hash) hashes.push(hash);
      }
    } catch {
      /* 源不可读：不计数（变更预览已如实展示该源状态） */
    }
  }
  if (!lookup) return { total, uncached: total };
  let uncached = 0;
  for (const hash of hashes) {
    const hit = await lookup(hash);
    if (hit == null) uncached += 1;
  }
  // 文件缺失/不可哈希的图片按未缓存计（无法验证缓存）
  uncached += total - hashes.length;
  return { total, uncached };
}

export function kbRoutes(deps: KbRouteDeps): Hono {
  const routes = new Hono();
  const { buildService, configManager, localMapStore } = deps;

  let queryStore: StandardKbStore | undefined;
  async function loadStore(): Promise<{ store: StandardKbStore; config: Awaited<ReturnType<ConfigManager['load']>> }> {
    const config = await configManager.load();
    if (!queryStore || queryStore.outputRootPath !== config.standardKb.outputRoot) queryStore = new StandardKbStore(config.standardKb.outputRoot);
    return { store: queryStore, config };
  }

  const sourceDocuments = (root: string) => {
    const excluded = new Set(localMapStore.listKbExcludedSources(root));
    return filterDeletedLocalDocuments(localMapStore, root, deps.documentsProvider()).filter((doc) => !excluded.has(doc.objToken));
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
      const deleted = new Set(localMapStore.listLocalSourceDeletions?.(config.knowledgeBaseRoot).map((item) => item.objToken) ?? []);
      const sources = doc.sources.map((objToken) => {
        const snapshotEntry = manifest.sourceSnapshot.find((candidate) => candidate.objToken === objToken);
        const currentHash = currentByToken.get(objToken);
        let state: KbSourceState = 'current';
        if (deleted.has(objToken)) state = 'deleted';
        else if (excluded.has(objToken)) state = 'excluded';
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
      return c.json({ releaseId: manifest.releaseId, results: await store.search(manifest, q, limit) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // 源选择与版本入口独立于正文。标记只写应用元数据，不编辑原始文件。
  const sourceChoices = async () => {
      const { store, config } = await loadStore();
      const excluded = new Set(localMapStore.listKbExcludedSources(config.knowledgeBaseRoot));
      const manifest = store.readManifest();
      const documents = filterDeletedLocalDocuments(localMapStore, config.knowledgeBaseRoot, deps.documentsProvider());
      const scan = RawSourceSnapshot.scan(config.knowledgeBaseRoot, documents.filter((doc) => !excluded.has(doc.objToken)), deps.sheetCsvPaths);
      const current = new Map(scan.entries.map((entry) => [entry.objToken, entry]));
      const base = new Map((manifest?.sourceSnapshot ?? []).map((entry) => [entry.objToken, entry]));
      const candidates = new Map(collectSourceCandidates(documents).map((doc) => [doc.objToken, { title: doc.title, relPath: doc.localRelPath!, recovered: doc.recoveredLocalVersion === true }]));
      const referencedCounts = countIncomingReferences(localMapStore, documents);
      // 当前选择仅列实际存在的本地源；旧版本引用留在差异/版本入口。
      const inspect = createLocalPathInspector(config.knowledgeBaseRoot);
      for (const [token, doc] of candidates) if (inspect(doc.relPath) !== 'present') candidates.delete(token);
      const choices: KbSourceChoice[] = [...candidates].map(([objToken, doc]) => {
        const old = base.get(objToken); const next = current.get(objToken);
        const isExcluded = excluded.has(objToken);
        const pending = isExcluded ? (old ? 'removed' : 'excluded') : !next ? (old ? 'removed' : 'unchanged')
          : !old ? 'added' : next.contentHash !== old.contentHash || next.relPath !== old.relPath || next.title !== old.title ? 'changed' : 'unchanged';
        return { objToken, title: doc.title || objToken, relPath: doc.relPath, included: !isExcluded, published: Boolean(old), pending, ...(doc.recovered ? { recovered: true } : {}),
          referencedBy: referencedCounts.get(objToken) ?? 0 };
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
      const preview = sourceChangePreview(snapshot, contents, manifest, versions.readSourceContents(manifest?.releaseId ?? null),
        new Set(localMapStore.listKbExcludedSources(config.knowledgeBaseRoot)));
      // S3（§3.6）：变更入口增图片维度——待处理源引用的图片数 / 未缓存数。
      // 按图片内容查找已有描述；未命中才计入 uncached。
      const images = await countPendingImages(config.knowledgeBaseRoot, snapshot, preview, buildService.visionCacheProbe());
      return c.json({ ...preview, images });
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
      const body = await c.req.json() as { mode?: string; confirm?: string; refreshImages?: boolean };
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
    return c.json(kbMcpInfo(config.standardKb.outputRoot));
  });

  return routes;
}

function buildServiceDepsOutputRoot(deps: KbRouteDeps): string {
  return deps.configManager.getConfig()?.standardKb.outputRoot ?? path.join(resolveDataRoot(), 'standard-kb');
}
