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
import {
  resolveAbsolute,
  toPortableRelative,
  isPathInsideRoot,
  joinRelative,
} from '../modules/path-resolver.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_CSV_TABLES = 20;

interface ContentDependencies {
  localMapStore: {
    getDocumentByObjToken: (objToken: string) => {
      objToken: string;
      objType: string;
      title: string;
      localMdPath: string;
    } | null;
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

    return c.json({
      objToken: doc.objToken,
      title: doc.title,
      objType: doc.objType,
      mdPath,
      mdContent,
      mdTruncated,
      csvTables,
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
