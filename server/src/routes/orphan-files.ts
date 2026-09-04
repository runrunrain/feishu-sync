/**
 * Orphan Files Routes - 孤立本地文件扫描与清理（2026-09-04）
 *
 * GET  /api/orphan-files        dry-run 扫描：列出知识库根目录下与任何
 *                               watchedRoot（含停用）/custom_folder 无对应
 *                               关系、且被证实为同步产物（feishu_sync 头）
 *                               的目录/散档。
 * POST /api/orphan-files/cleanup  清理到 <root>/.trash-bin/orphan-<ts>/
 *                               （可恢复移动，非删除）。对齐同步引擎的
 *                               安全语义：{ confirmation: 'APPLY' } 才执行，
 *                               其他值一律 dry-run 只回显清单。
 */

import { Hono } from 'hono';
import type { WatchedRootConfig } from '../types/index.js';
import { scanOrphanFiles, cleanupOrphanFiles } from '../modules/orphan-files.js';

const orphanFilesRoutes = new Hono();

orphanFilesRoutes.get('/api/orphan-files', async (c) => {
  const configManager = (c as any).configManager;
  const localMapStore = (c as any).localMapStore;
  const config = await configManager.load();
  const rootDir = config.knowledgeBaseRoot;
  if (!rootDir || typeof rootDir !== 'string') {
    return c.json({ error: 'knowledge_base_root_unconfigured', items: [] }, 400);
  }

  const watchedRoots: WatchedRootConfig[] = config.watchedRoots ?? [];
  let customRelPaths: string[] = [];
  if (typeof localMapStore?.listCustomFolders === 'function') {
    customRelPaths = localMapStore.listCustomFolders().map((f: { local_rel_path: string }) => f.local_rel_path);
  }

  const result = scanOrphanFiles(rootDir, watchedRoots, customRelPaths);
  return c.json(result);
});

orphanFilesRoutes.post('/api/orphan-files/cleanup', async (c) => {
  const configManager = (c as any).configManager;
  const localMapStore = (c as any).localMapStore;
  const config = await configManager.load();
  const rootDir = config.knowledgeBaseRoot;
  if (!rootDir || typeof rootDir !== 'string') {
    return c.json({ error: 'knowledge_base_root_unconfigured' }, 400);
  }

  let body: { items?: Array<{ relPath: string; type: 'dir' | 'file'; evidence?: string | null }>; confirmation?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  // 服务端以当前扫描结果为准重新校验，客户端清单仅作选择意图；
  // 请求里指定 relPath 的项被限定在「当前确为孤立」的集合内，防止
  // 请求构造的任意路径清理（TOCTOU 与路径注入双重防线）。
  const watchedRoots: WatchedRootConfig[] = config.watchedRoots ?? [];
  let customRelPaths: string[] = [];
  if (typeof localMapStore?.listCustomFolders === 'function') {
    customRelPaths = localMapStore.listCustomFolders().map((f: { local_rel_path: string }) => f.local_rel_path);
  }
  const current = scanOrphanFiles(rootDir, watchedRoots, customRelPaths);
  const requested = Array.isArray(body.items) ? body.items.map((i) => i.relPath) : null;
  const targets = requested
    ? current.items.filter((item) => requested.includes(item.relPath))
    : current.items;

  const result = cleanupOrphanFiles(rootDir, targets, body.confirmation ?? '');
  return c.json({
    success: result.failed.length === 0,
    dryRun: result.dryRun,
    trashDir: result.trashDir,
    moved: result.moved,
    failed: result.failed,
    scannedTotal: current.items.length,
  });
});

export { orphanFilesRoutes };
