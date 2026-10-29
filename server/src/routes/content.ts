/**
 * Content Routes - 本地文档内容预览 API（v0.2.8 布局重构 批次1）
 *
 *   GET /api/mapping/content/:objToken  - 读取该文档本地 Markdown 全文 +
 *     sheet 文档伴随的 `<stem>.csv-data/ *.csv` 表格列表，供前端右侧
 *     预览面板以 MD / CSV 两种格式渲染。
 *
 * 安全契约：
 *   - 所有路径经 toPortableRelative/resolveAbsolute 收敛到
 *     knowledgeBaseRoot 内，isPathInsideRoot 二次校验，拒绝越界读取；
 *   - 只读接口，绝不写盘；
 *   - 单文件 512KB 截断上限（truncated 标记），CSV 最多返回 20 个表。
 *
 * 依赖注入沿用项目约定：从 Hono context 取 localMapStore / configManager。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { MAX_WORKBOOK_BYTES, readWorkbookPreview, workbookPathForMarkdown } from '../modules/sheet-workbook.js';
import {
  resolveAbsolute,
  toPortableRelative,
  isPathInsideRoot,
  joinRelative,
} from '../modules/path-resolver.js';
import { resolveSourceLinks, type ResolvedSourceLink, type SourceLinkEdgeRow } from '../kb/source-links.js';
import type { DocumentRecord } from '../types/index.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_CSV_TABLES = 20;

interface ContentDependencies {
  localMapStore: {
    getDocumentByObjToken: (objToken: string) => {
      objToken: string;
      objType: string;
      title: string;
      localMdPath: string;
      lastSyncedAt?: string | null;
      syncedObjEditTime?: number | null;
      wikiNodeToken?: string | null;
    } | null;
    /** P1-S3：入边查询（被引用，设计 §2.3）——可选以兼容旧测试替身。 */
    listSourceReferencesByTarget?: (targetTokens: string[]) => unknown[];
    /** P1-S4：出边查询（引用，设计 §2.3/§2.4）——可选以兼容旧测试替身。 */
    listSourceReferencesBySrc?: (objToken: string) => unknown[];
    getDocumentByWikiNodeToken?: (wikiNodeToken: string) => unknown;
    /** P2-S4：评论溯源查询（设计 §5.1）——可选以兼容旧测试替身。 */
    getSourceCommentMeta?: (objToken: string) => unknown;
    listSourceCommentsBySrc?: (objToken: string) => unknown[];
  };
  configManager: {
    getConfig: () => { knowledgeBaseRoot?: string } | null;
  };
}

function getDeps(c: any): ContentDependencies {
  const localMapStore = c.localMapStore;
  const configManager = c.configManager;
  if (!localMapStore || !configManager) {
    throw new Error('[content] required dependencies not injected');
  }
  return { localMapStore, configManager };
}

/** Read a UTF-8 text file with a hard byte cap; null when unreadable. */
function readTextCapped(
  absolutePath: string,
): { content: string; truncated: boolean } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const fd = fs.openSync(absolutePath, 'r');
  try {
    const size = Math.min(stat.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
    // Slice on a UTF-8 boundary-ish basis; a partial multibyte tail renders
    // as U+FFFD which is acceptable for a capped preview.
    const content = buffer.subarray(0, bytesRead).toString('utf-8');
    return { content, truncated: stat.size > MAX_FILE_BYTES };
  } finally {
    fs.closeSync(fd);
  }
}

export const contentRoutes = new Hono();

/** The index chooses the workbook. A caller cannot provide an arbitrary path. */
function findWorkbook(deps: ContentDependencies, objToken: string) {
  const root = deps.configManager.getConfig()?.knowledgeBaseRoot;
  const doc = deps.localMapStore.getDocumentByObjToken(objToken);
  if (!root || !doc || doc.objType !== 'sheet' || !doc.localMdPath) return null;
  const mdRelative = toPortableRelative(root, doc.localMdPath);
  if (!mdRelative) return null;
  const relativePath = workbookPathForMarkdown(mdRelative);
  const absolutePath = resolveAbsolute(root, relativePath);
  if (!isPathInsideRoot(root, absolutePath)) return null;
  try {
    const rootReal = fs.realpathSync.native(root);
    const realPath = fs.realpathSync.native(absolutePath);
    if (!isPathInsideRoot(rootReal, realPath)) return null;
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) return null;
    let mode: 'native' | 'read-reconstruction' | undefined;
    const metadataPath = `${absolutePath}.metadata.json`;
    if (fs.existsSync(metadataPath)) {
      const metadataReal = fs.realpathSync.native(metadataPath);
      if (isPathInsideRoot(rootReal, metadataReal) && fs.statSync(metadataReal).size < 2 * 1024 * 1024) {
        try {
          const metadata = JSON.parse(fs.readFileSync(metadataReal, 'utf-8'));
          if (metadata.mode === 'native' || metadata.mode === 'read-reconstruction') mode = metadata.mode;
        } catch { /* Missing provenance does not make the archived file unreadable. */ }
      }
    }
    return { path: relativePath, absolutePath: realPath, size: stat.size, modifiedTime: stat.mtime.toISOString(), mode };
  } catch { return null; }
}

contentRoutes.get('/api/mapping/workbook/:objToken/file', (c) => {
  const workbook = findWorkbook(getDeps(c), c.req.param('objToken'));
  if (!workbook) return c.json({ error: 'workbook_not_found' }, 404);
  if (workbook.size > MAX_WORKBOOK_BYTES) return c.json({ error: 'workbook_too_large' }, 413);
  return new Response(new Uint8Array(fs.readFileSync(workbook.absolutePath)), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(workbook.path))}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

contentRoutes.get('/api/mapping/workbook/:objToken', async (c) => {
  const index = c.req.query('sheet') ?? '0';
  if (!/^\d{1,4}$/.test(index)) return c.json({ error: 'invalid_sheet_index' }, 400);
  const workbook = findWorkbook(getDeps(c), c.req.param('objToken'));
  if (!workbook) return c.json({ error: 'workbook_not_found', message: '本地无 Excel 原件，请重新同步该表格' }, 404);
  if (workbook.size > MAX_WORKBOOK_BYTES) return c.json({ error: 'workbook_too_large', message: 'Excel 超过 64 MB 预览读取上限，请打开本地原件' }, 413);
  try {
    const preview = await readWorkbookPreview(workbook.absolutePath, Number(index));
    c.header('Cache-Control', 'no-store');
    return c.json(preview);
  } catch (error) {
    return c.json({
      error: 'workbook_preview_failed',
      message: error instanceof Error ? error.message : 'Excel 预览读取失败，请打开本地原件',
    }, error instanceof RangeError ? 404 : 422);
  }
});

/**
 * GET /api/mapping/media?path=<kbRoot 相对路径>（v0.2.9 预览图片支持）
 *
 * 同步产物中的 Markdown 以相对路径引用图片（`<文档目录>/images/xx.jpg`），
 * 前端把相对 src 解析为 kbRoot 相对路径后调此接口取二进制。路径经
 * resolveAbsolute + isPathInsideRoot 双重收敛，只允许图片扩展名，25MB 上限。
 * 仍走 X-Desktop-Token 鉴权（前端 fetch → blob → objectURL 渲染）。
 */
const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

contentRoutes.get('/api/mapping/media', async (c) => {
  const relPath = c.req.query('path');
  if (!relPath) {
    return c.json({ error: 'path query parameter is required' }, 400);
  }
  try {
    const { configManager } = getDeps(c);
    const config = configManager.getConfig();
    const knowledgeBaseRoot = config?.knowledgeBaseRoot;
    if (!knowledgeBaseRoot) {
      return c.json({ error: 'knowledgeBaseRoot not configured' }, 400);
    }

    const rel = toPortableRelative(knowledgeBaseRoot, relPath);
    if (!rel) {
      return c.json({ error: 'path_outside_root' }, 403);
    }
    const ext = path.extname(rel).toLowerCase();
    const mime = MEDIA_MIME[ext];
    if (!mime) {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    const abs = resolveAbsolute(knowledgeBaseRoot, rel);
    if (!isPathInsideRoot(knowledgeBaseRoot, abs)) {
      return c.json({ error: 'path_outside_root' }, 403);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return c.json({ error: 'media_not_found' }, 404);
    }
    if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES) {
      return c.json({ error: 'media_not_found_or_too_large' }, 404);
    }
    const buffer = fs.readFileSync(abs);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    console.error('[content] read media failed:', error);
    return c.json(
      {
        error: 'media_read_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

contentRoutes.get('/api/mapping/content/:objToken', async (c) => {
  const objToken = c.req.param('objToken');
  if (!objToken) {
    return c.json({ error: 'objToken is required' }, 400);
  }

  try {
    const { localMapStore, configManager } = getDeps(c);
    const config = configManager.getConfig();
    const knowledgeBaseRoot = config?.knowledgeBaseRoot;
    if (!knowledgeBaseRoot) {
      return c.json({ error: 'knowledgeBaseRoot not configured' }, 400);
    }

    const doc = localMapStore.getDocumentByObjToken(objToken);
    if (!doc) {
      return c.json({ error: 'document_not_found' }, 404);
    }

    // Resolve the markdown path defensively: the column may hold an absolute
    // path written by older versions, or a portable relative path. Either way
    // the result must land inside knowledgeBaseRoot.
    const mdRel = doc.localMdPath
      ? toPortableRelative(knowledgeBaseRoot, doc.localMdPath)
      : null;

    let mdPath: string | null = null;
    let mdContent: string | null = null;
    let mdTruncated = false;

    if (mdRel) {
      const mdAbs = resolveAbsolute(knowledgeBaseRoot, mdRel);
      if (isPathInsideRoot(knowledgeBaseRoot, mdAbs)) {
        const read = readTextCapped(mdAbs);
        if (read) {
          mdPath = mdRel;
          mdContent = read.content;
          mdTruncated = read.truncated;
        } else {
          // File referenced by the index but missing on disk — surface the
          // path with null content so the UI can show a "尚未同步" empty state.
          mdPath = mdRel;
        }
      }
    }

    // Sheet docs keep their raw tables in `<stem>.csv-data/*.csv` beside the
    // markdown file (see path-resolver relativeCsvDataDir convention).
    const csvTables: Array<{
      name: string;
      path: string;
      content: string;
      truncated: boolean;
    }> = [];

    if (mdRel) {
      const mdAbs = resolveAbsolute(knowledgeBaseRoot, mdRel);
      const dir = path.dirname(mdAbs);
      const stem = path.basename(mdAbs, path.extname(mdAbs));
      const csvDirAbs = path.join(dir, `${stem}.csv-data`);
      if (
        isPathInsideRoot(knowledgeBaseRoot, csvDirAbs) &&
        fs.existsSync(csvDirAbs)
      ) {
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(csvDirAbs, { withFileTypes: true });
        } catch {
          entries = [];
        }
        const csvDirRel = joinRelative(path.dirname(mdRel), `${stem}.csv-data`);
        for (const entry of entries) {
          if (csvTables.length >= MAX_CSV_TABLES) break;
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.csv')) {
            continue;
          }
          const abs = path.join(csvDirAbs, entry.name);
          if (!isPathInsideRoot(knowledgeBaseRoot, abs)) continue;
          const read = readTextCapped(abs);
          if (!read) continue;
          csvTables.push({
            name: entry.name.replace(/\.csv$/i, ''),
            path: joinRelative(csvDirRel, entry.name),
            content: read.content,
            truncated: read.truncated,
          });
        }
        csvTables.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      }
    }

    // P1-S3（设计 §2.3）：被引用关系——按本文档 obj_token 与 wiki_node_token
    // 双键并集反查入边（外部可能用任一种 URL 引用它）；附源文档 title/
    // 相对路径供预览面板渲染（S4 UI 消费；源行已删时元数据为 null）。
    const referencedBy = (() => {
      if (typeof localMapStore.listSourceReferencesByTarget !== 'function') return [];
      const tokens = [doc.objToken, doc.wikiNodeToken ?? null].filter(
        (token): token is string => typeof token === 'string' && token.length > 0,
      );
      return localMapStore.listSourceReferencesByTarget(tokens);
    })();

    // P1-S4（设计 §2.4）：出边引用——预览面板「引用」区；目标按 obj/wiki
    // 双键解析到本地文档行（未入本库的目标保留原 token 与边标题）。
    const references: ResolvedSourceLink[] = (() => {
      if (typeof localMapStore.listSourceReferencesBySrc !== 'function') return [];
      const outEdges = localMapStore.listSourceReferencesBySrc(doc.objToken) as SourceLinkEdgeRow[];
      if (!Array.isArray(outEdges) || outEdges.length === 0) return [];
      return resolveSourceLinks({
        outEdges,
        inEdges: [],
        lookup: (token) =>
          (localMapStore.getDocumentByObjToken(token)
            ?? (typeof localMapStore.getDocumentByWikiNodeToken === 'function'
              ? localMapStore.getDocumentByWikiNodeToken(token)
              : null)) as DocumentRecord | null,
      }).out;
    })();

    const workbook = findWorkbook({ localMapStore, configManager }, objToken);
    const fallback = /^\s+source_acquisition:\s*"csv-fallback"\s*$/m.test(mdContent?.slice(0, 16384) ?? '');
    let approximations: string[] = [];
    if (workbook) {
      try {
        const real = fs.realpathSync.native(`${workbook.absolutePath}.metadata.json`);
        if (isPathInsideRoot(fs.realpathSync.native(knowledgeBaseRoot), real) && fs.statSync(real).size < 2 * 1024 * 1024) {
          const metadata = JSON.parse(fs.readFileSync(real, 'utf-8'));
          if (metadata.objToken === objToken && Array.isArray(metadata.approximations)) {
            approximations = [...new Set<string>(metadata.approximations.map((a: any) => String(a.kind)))];
          }
        }
      } catch { /* Historical workbooks may not have a readable sidecar. */ }
    }
    return c.json({
      objToken: doc.objToken,
      title: doc.title,
      objType: doc.objType,
      mdPath,
      mdContent,
      mdTruncated,
      csvTables,
      referencedBy,
      references,
      workbook: workbook ? { path: workbook.path, size: workbook.size, modifiedTime: workbook.modifiedTime, mode: workbook.mode } : null,
      sheetStatus: doc.objType === 'sheet' ? {
        acquisition: fallback ? 'csv-fallback' : workbook ? workbook.mode ?? 'unknown-excel' : csvTables.length ? 'legacy-csv' : 'unavailable',
        workbookMayBeOlder: fallback && !!workbook,
        syncedAt: doc.lastSyncedAt ?? null,
        cloudEditTime: doc.syncedObjEditTime ?? null,
        approximations,
      } : null,
    });
  } catch (error) {
    console.error('[content] read content failed:', error);
    return c.json(
      {
        error: 'content_read_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

/**
 * GET /api/mapping/comments/:objToken — 文档评论（P2-S4 评论溯源，设计
 * §5.1 预览面板数据面）。只读 SQLite 采集表；collected=false 表示从未
 * 采集（非 docx 或未成功同步过——sheet/slides 不走 docs+fetch），前端
 * 隐藏评论区而非显示「0 条」。truncated=true 表示云端截断（comments.tips
 * 存在），UI 显示「可能不完整」。
 */
contentRoutes.get('/api/mapping/comments/:objToken', (c) => {
  const objToken = c.req.param('objToken');
  if (!objToken) {
    return c.json({ error: 'objToken is required' }, 400);
  }
  try {
    const { localMapStore } = getDeps(c);
    const doc = localMapStore.getDocumentByObjToken(objToken);
    if (!doc) {
      return c.json({ error: 'document_not_found' }, 404);
    }
    const meta = (typeof localMapStore.getSourceCommentMeta === 'function'
      ? localMapStore.getSourceCommentMeta(objToken)
      : null) as {
      srcObjToken: string; total: number; truncated: boolean; updatedAt: string;
    } | null;
    const comments = ((typeof localMapStore.listSourceCommentsBySrc === 'function'
      ? localMapStore.listSourceCommentsBySrc(objToken)
      : []) ?? []) as Array<{
      commentRef: string; text: string; quote: string | null;
      author: string | null; createdAtCloud: string | null; solved: boolean | null;
    }>;
    return c.json({
      objToken,
      collected: meta !== null,
      total: meta?.total ?? 0,
      truncated: meta?.truncated ?? false,
      updatedAt: meta?.updatedAt ?? null,
      comments: meta === null ? [] : comments,
    });
  } catch (error) {
    console.error('[content] read comments failed:', error);
    return c.json(
      {
        error: 'comments_read_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});
