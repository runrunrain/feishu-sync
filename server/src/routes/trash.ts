/**
 * Trash Routes - Soft-delete recovery / permanent cleanup (P4-T13 backend).
 *
 *   GET    /api/trash                       - List cloud_deleted=1 docs
 *   POST   /api/trash/restore               - Restore (cloud_deleted=0 + move back)
 *   DELETE /api/trash/purge?obj_token=<tok> - Hard-delete single doc
 *   DELETE /api/trash/purge?all=1           - Hard-delete all trashed docs
 *
 * Consumes LocalMapStore trash methods (P2-T3). File-system moves are
 * done here (route layer), not in LocalMapStore, because:
 *   - LocalMapStore is a SQLite-only concern (testable in isolation).
 *   - File moves need config.knowledgeBaseRoot + path-traversal guard,
 *     which belong to the HTTP/route layer.
 *
 * Path-safety: every fs path is resolved relative to knowledgeBaseRoot
 * and rejected if it escapes that root. The .trash-bin staging dir is
 * created on-demand under the same root so the same guard applies.
 *
 * Contract mirrors src/api/client.ts (洛神 P4-2):
 *   GET    -> { items: TrashedDoc[] }
 *   POST   body { obj_token } -> { ok: true }
 *   DELETE -> { purged: number }
 */

import { Hono } from 'hono';
import path from 'node:path';
import fs from 'node:fs';

/**
 * TrashedDoc contract mirrors src/types/index.ts (洛神 P4-2). Duplicated
 * here (not cross-imported) because server/ and src/ are independent
 * tsconfig packages; the contract is small and stable.
 */
export interface TrashedDoc {
  obj_token: string;
  title: string;
  local_path: string;
  /** ISO timestamp the row was marked cloud_deleted (best-effort). */
  deleted_at: string | null;
  /** Optional reason: 'cloud_deleted' | 'user_trashed' | 'orphan'. */
  reason?: string;
}

const trashRoutes = new Hono();

// ---------------------------------------------------------------------------
// TrashedDoc mapping
// ---------------------------------------------------------------------------

/**
 * Map a DocumentRecord to the TrashedDoc contract expected by the UI.
 *
 * documents has no dedicated `deleted_at` column; the closest stable
 * timestamp is `last_seen_at` (refreshed when markCloudDeleted flipped
 * the row). Fall back to `updated_at` if last_seen_at is null.
 */
function toTrashedDoc(row: any): TrashedDoc {
  const deletedAt = row.last_seen_at ?? row.updated_at ?? null;
  return {
    obj_token: row.objToken ?? row.obj_token,
    title: row.title ?? '',
    local_path: row.localMdPath ?? row.local_md_path ?? '',
    deleted_at: deletedAt,
    reason: 'cloud_deleted',
  };
}

// ---------------------------------------------------------------------------
// Path safety helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `relPath` under `root` and return the absolute path if (and only
 * if) it stays inside `root`. Returns null on traversal escape.
 *
 * We normalize both sides with path.resolve() and then require the
 * resolved path to equal `root` or start with `root + sep`. The trailing
 * separator check prevents the `/foo-bad` prefix attack where a sibling
 * directory shares the name prefix.
 */
function safeResolve(root: string, relPath: string): string | null {
  if (!root || !relPath) return null;
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relPath);
  if (target === rootResolved) return target;
  const prefix = rootResolved + path.sep;
  if (target.startsWith(prefix)) return target;
  return null;
}

/**
 * Locate the .trash-bin staging directory under the knowledge base root.
 * Created on first use. Returns null if the root itself is misconfigured.
 */
function ensureTrashBin(root: string): string | null {
  const rootResolved = path.resolve(root);
  const trashBin = path.join(rootResolved, '.trash-bin');
  try {
    if (!fs.existsSync(trashBin)) {
      fs.mkdirSync(trashBin, { recursive: true });
    }
    return trashBin;
  } catch (err) {
    console.error('[trash] failed to ensure .trash-bin:', err);
    return null;
  }
}

/**
 * Compute the trash-staging path for a document. We mirror the relative
 * structure of local_md_path under .trash-bin so restore can find it.
 *
 *   knowledgeBaseRoot/docs/foo/bar.md -> .trash-bin/docs/foo/bar.md
 *
 * Path safety: any relPath that escapes root yields null.
 */
function computeTrashPath(root: string, localMdPath: string): string | null {
  if (!localMdPath) return null;
  // Treat absolute localMdPath as already inside root; resolve relative.
  const rel = path.isAbsolute(localMdPath)
    ? path.relative(path.resolve(root), path.resolve(localMdPath))
    : localMdPath;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return safeResolve(path.join(path.resolve(root), '.trash-bin'), rel);
}

/**
 * Move a file from `src` to `dst`, creating dst's parent dir as needed.
 * Atomic on same-filesystem rename; falls back to copy+unlink on cross-
 * device (EXDEV). Returns true on success, false on any fs error.
 */
function moveFileSafe(src: string, dst: string): boolean {
  try {
    if (!fs.existsSync(src)) return false;
    const dstDir = path.dirname(dst);
    if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
    try {
      fs.renameSync(src, dst);
      return true;
    } catch (err: any) {
      if (err && err.code === 'EXDEV') {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
        return true;
      }
      throw err;
    }
  } catch (err) {
    console.error('[trash] moveFileSafe failed:', { src, dst, err });
    return false;
  }
}

function unlinkSafe(target: string): boolean {
  try {
    if (!fs.existsSync(target)) return true; // nothing to delete is success
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    console.error('[trash] unlinkSafe failed:', { target, err });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

trashRoutes.get('/api/trash', async (c) => {
  try {
    const store = (c as any).localMapStore;
    if (!store) {
      return c.json({ error: 'localMapStore_not_injected' }, 500);
    }
    const rows = store.listCloudDeleted() as any[];
    const items = rows.map(toTrashedDoc);
    return c.json({ items });
  } catch (error) {
    console.error('[trash] list failed:', error);
    return c.json(
      {
        error: 'trash_list_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

trashRoutes.post('/api/trash/restore', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const objToken =
    body && typeof body === 'object' && typeof body.obj_token === 'string'
      ? body.obj_token
      : null;
  if (!objToken) {
    return c.json(
      { error: 'invalid_body', message: 'obj_token (string) is required' },
      400,
    );
  }

  try {
    const store = (c as any).localMapStore;
    const configManager = (c as any).configManager;
    if (!store || !configManager) {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }

    const doc = store.getDocumentByObjToken(objToken) as any;
    if (!doc) {
      return c.json({ error: 'not_found', message: 'document not in trash' }, 404);
    }
    if (!(doc.cloudDeleted === 1 || doc.cloudDeleted === true)) {
      // Idempotent: already restored. Still return ok so UI is happy.
      return c.json({ ok: true });
    }

    const config = configManager.getConfig?.() ?? (await configManager.load?.());
    const root: string | undefined = config?.knowledgeBaseRoot;
    const localMdPath: string | undefined = doc.localMdPath;

    // Restore file from .trash-bin back to original path (if both known).
    // File missing is non-fatal: row may have been soft-deleted before any
    // fs move happened (e.g. user marked cloud_deleted without fs action).
    if (root && localMdPath) {
      const originalAbs = safeResolve(root, localMdPath);
      const trashAbs = computeTrashPath(root, localMdPath);
      if (originalAbs && trashAbs && fs.existsSync(trashAbs)) {
        moveFileSafe(trashAbs, originalAbs);
      }
    }

    // Flip the soft-delete flag in DB.
    store.restoreCloudDeleted(objToken);
    return c.json({ ok: true });
  } catch (error) {
    console.error('[trash] restore failed:', error);
    return c.json(
      {
        error: 'trash_restore_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/trash/manual-delete — 手动删除节点（2026-09）
// ---------------------------------------------------------------------------
//
// 用户在节点树上主动删除某个文档（典型：残留的非有效飞书节点）。
// 与回收站 purge 的语义区分：
//   - 回收站行（cloud_deleted=1）拒绝本入口 → 409，走回收站面板的恢复/
//     清空，避免双语义交叉；
//   - 活行：本地 .md 先移入 .trash-bin/（镜像相对路径，可手工找回），
//     再硬删 documents + sheet_sheets（LocalMapStore.deleteDocumentByToken
//     事务内级联）；文件不存在（已手动删）则直接删行。
// 删除后果说明（前端 confirm 文案同步）：云端仍存在的节点在下次检测会
// 作为本地缺失新增项重新出现在变更列表——不勾选即不会被同步回来。
//
trashRoutes.post('/api/trash/manual-delete', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const objToken =
    body && typeof body === 'object' && typeof body.obj_token === 'string'
      ? body.obj_token
      : null;
  if (!objToken) {
    return c.json(
      { error: 'invalid_body', message: 'obj_token (string) is required' },
      400,
    );
  }

  try {
    const store = (c as any).localMapStore;
    const configManager = (c as any).configManager;
    if (!store || !configManager) {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }

    const doc = store.getDocumentByObjToken(objToken) as any;
    if (!doc) {
      // 幂等：行已不存在视为删除成功。
      return c.json({ ok: true, file_moved_to_trash: false, already_gone: true });
    }
    if (doc.cloudDeleted === 1 || doc.cloudDeleted === true) {
      return c.json(
        {
          error: 'trash_managed_row',
          message: '该文档在回收站中，请在回收站面板里恢复或清空',
        },
        409,
      );
    }

    const config = configManager.getConfig?.() ?? (await configManager.load?.());
    const root: string | undefined = config?.knowledgeBaseRoot;
    const localMdPath: string | undefined = doc.localMdPath;

    let movedToTrash = false;
    if (root && localMdPath) {
      const originalAbs = safeResolve(root, localMdPath);
      const trashAbs = computeTrashPath(root, localMdPath);
      if (originalAbs && trashAbs && fs.existsSync(originalAbs)) {
        ensureTrashBin(root);
        movedToTrash = moveFileSafe(originalAbs, trashAbs);
        // 移动失败（IO 异常）不阻断行删除：文件残留会被下一次刷新索引的
        // prune 逻辑按「本地缺失行」重新收敉，不会复活视图节点。
      }
    }

    const deleted = store.deleteDocumentByToken(objToken);
    if (!deleted) {
      return c.json({ error: 'not_found', message: 'document row vanished' }, 404);
    }
    return c.json({ ok: true, file_moved_to_trash: movedToTrash });
  } catch (error) {
    console.error('[trash] manual-delete failed:', error);
    return c.json(
      {
        error: 'trash_manual_delete_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/trash/bulk-process — 删除候选批量处理（2026-09 变更列表修复）
// ---------------------------------------------------------------------------
//
// 背景：变更列表「已删除」分组来自检测器两次完整遍历未命中的
// missing_candidate 行（cloud_deleted=0）。此前前端「移入回收站/永久清理」
// 按钮只是打开回收站抽屉的 stub，从未调用任何写操作，导致：
//   1) 单条点击无实际效果、回收站始终为空（用户报告 36 项删除候选）；
//   2) 删除候选没有任何批量处理入口。
//
// 请求体：{ obj_tokens: string[], action: 'trash' | 'purge', confirmation: 'DELETE' }
//
// 语义（与既有端点的关系）：
//   - action='trash'：候选行软删（cloud_deleted=1 + deleted_confirmed，进
//     回收站面板）+ 本地 .md best-effort 移入 .trash-bin/ 镜像相对路径
//     （恢复/清理复用既有 restore/purge 语义）。等价于逐条 confirm
//     missing-candidate，但额外完成文件移动。
//   - action='purge'：候选行先软删再硬删（unlink 原路径与 .trash-bin 副本
//     + 删 documents 行），复用 purgeOne；不可恢复。
//   - 已在回收站的行（cloud_deleted=1）：trash 记 already_trashed 跳过；
//     purge 正常清理（与回收站面板单条清理同语义）。
//   - 幂等：行不存在记 gone，不报错。
//   - 防误删红线：活行（cloud_deleted=0）仅接受 missing_candidate /
//     deleted_confirmed 状态，其余（synced/pending_*）记 failed——不允许
//     借本端点删除云端仍存在或待同步的文档。
//
// 响应：{ requested, trashed, purged, already_trashed, gone,
//         failed: [{ obj_token, reason }] }
// ---------------------------------------------------------------------------
trashRoutes.post('/api/trash/bulk-process', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const action =
    body && typeof body === 'object' && (body.action === 'trash' || body.action === 'purge')
      ? body.action
      : null;
  const tokens: string[] | null =
    body && typeof body === 'object' && Array.isArray(body.obj_tokens)
      ? (body.obj_tokens as unknown[]).every((t) => typeof t === 'string')
        ? (body.obj_tokens as string[])
        : null
      : null;

  if (!action) {
    return c.json(
      { error: 'invalid_body', message: "action must be 'trash' or 'purge'" },
      400,
    );
  }
  if (!tokens || tokens.length === 0) {
    return c.json(
      { error: 'invalid_body', message: 'obj_tokens (string[]) is required and must be non-empty' },
      400,
    );
  }
  if (body?.confirmation !== 'DELETE') {
    return c.json(
      {
        error: 'confirmation_required',
        message: '请在请求体中提供 confirmation: "DELETE" 以确认批量处理删除候选。',
      },
      400,
    );
  }

  try {
    const store = (c as any).localMapStore;
    const configManager = (c as any).configManager;
    if (!store || !configManager) {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }

    const config = configManager.getConfig?.() ?? (await configManager.load?.());
    const root: string | undefined = config?.knowledgeBaseRoot;
    if (root) ensureTrashBin(root);

    const now = new Date().toISOString();
    const counts = {
      requested: tokens.length,
      trashed: 0,
      purged: 0,
      already_trashed: 0,
      gone: 0,
    };
    const failed: Array<{ obj_token: string; reason: string }> = [];
    // 软删成功但文件移动失败（IO 异常）非阻断性缺陷：行已入回收站，
    // restore/purge 均兼容「文件仍在原路径」，但必须上报而非静默吞掉
    // （diting 审核 Minor#1：可观测性缺口）。
    const warnings: Array<{ obj_token: string; reason: string }> = [];

    for (const objToken of tokens) {
      const doc = store.getDocumentByObjToken(objToken) as any;
      if (!doc) {
        counts.gone += 1;
        continue;
      }

      const cloudDeleted = doc.cloudDeleted === 1 || doc.cloudDeleted === true;
      if (!cloudDeleted) {
        // 防误删：活行仅接受删除候选状态。
        const syncState: string | undefined = doc.syncState ?? doc.sync_state;
        if (syncState !== 'missing_candidate' && syncState !== 'deleted_confirmed') {
          failed.push({ obj_token: objToken, reason: 'not_deletion_candidate' });
          continue;
        }
      }

      if (action === 'trash') {
        if (cloudDeleted) {
          counts.already_trashed += 1;
          continue;
        }
        store.markCloudDeleted(objToken, now);
        // 文件移动 best-effort：失败不回滚 DB 标记（restore/purge 均兼容
        // 「行已软删但文件仍在原路径」的状态，见 restore 的 non-fatal 注释），
        // 但记入 warnings 让前端可提示（diting 审核 Minor#1）。
        const localMdPath: string | undefined = doc.localMdPath ?? doc.local_md_path;
        if (root && localMdPath) {
          const originalAbs = safeResolve(root, localMdPath);
          const trashAbs = computeTrashPath(root, localMdPath);
          if (originalAbs && trashAbs && fs.existsSync(originalAbs)) {
            if (!moveFileSafe(originalAbs, trashAbs)) {
              warnings.push({ obj_token: objToken, reason: 'file_move_failed' });
            }
          }
        }
        counts.trashed += 1;
        continue;
      }

      // action === 'purge'
      if (!cloudDeleted) store.markCloudDeleted(objToken, now);
      const ok = purgeOne(store, root, objToken, doc);
      // purgeOne 以异常为失败信号，但 purgeCloudDeleted 的 DELETE WHERE
      // sync_state='deleted_confirmed' 不命中时既不抛错也不删行（零计数）。
      // 复查行是否真的消失，残留时如实上报而非虚报 purged
      // （diting 审核 Minor#2：预存缺陷在本批扩大暴露面的轻量防御）。
      const rowStillPresent = store.getDocumentByObjToken(objToken) != null;
      if (ok && !rowStillPresent) {
        counts.purged += 1;
      } else {
        failed.push({ obj_token: objToken, reason: rowStillPresent ? 'purge_noop_row_kept' : 'purge_failed' });
      }
    }

    return c.json({ ...counts, failed, warnings });
  } catch (error) {
    console.error('[trash] bulk-process failed:', error);
    return c.json(
      {
        error: 'trash_bulk_process_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

trashRoutes.delete('/api/trash/purge', async (c) => {
  const objToken = c.req.query('obj_token');
  const allFlag = c.req.query('all');

  // Reject ambiguous invocations to keep semantics explicit.
  if (!objToken && !allFlag) {
    return c.json(
      {
        error: 'invalid_request',
        message: 'provide ?obj_token=<tok> or ?all=1',
      },
      400,
    );
  }
  if (objToken && allFlag) {
    return c.json(
      {
        error: 'invalid_request',
        message: 'specify exactly one of obj_token or all=1',
      },
      400,
    );
  }

  try {
    const store = (c as any).localMapStore;
    const configManager = (c as any).configManager;
    if (!store || !configManager) {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }

    const config = configManager.getConfig?.() ?? (await configManager.load?.());
    const root: string | undefined = config?.knowledgeBaseRoot;
    if (root) ensureTrashBin(root);

    if (allFlag) {
      const rows = store.listCloudDeleted() as any[];
      let purged = 0;
      for (const row of rows) {
        const ok = purgeOne(store, root, row.objToken ?? row.obj_token, row);
        if (ok) purged += 1;
      }
      return c.json({ purged });
    }

    const doc = store.getDocumentByObjToken(objToken!) as any;
    if (!doc) {
      return c.json({ error: 'not_found', message: 'document not in trash' }, 404);
    }
    const ok = purgeOne(store, root, objToken!, doc);
    if (!ok) {
      return c.json(
        { error: 'purge_failed', message: 'see server logs' },
        500,
      );
    }
    return c.json({ purged: 1 });
  } catch (error) {
    console.error('[trash] purge failed:', error);
    return c.json(
      {
        error: 'trash_purge_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// Internal: purge a single document row + its fs artifacts.
// ---------------------------------------------------------------------------

/**
 * Purge a single trashed document:
 *   1. Unlink the local .md if it still exists at its original path
 *      (defensive: purge should be safe even if restore was not called).
 *   2. Unlink the staged copy under .trash-bin/ if present.
 *   3. Call LocalMapStore.purgeCloudDeleted to DELETE the row (FK CASCADE
 *      cleans sheet_sheets).
 *
 * Returns true on success. DB row delete failure returns false; missing
 * files are not treated as failure (idempotent purge contract).
 */
function purgeOne(
  store: any,
  root: string | undefined,
  objToken: string,
  doc: any,
): boolean {
  const localMdPath: string | undefined = doc?.localMdPath ?? doc?.local_md_path;
  if (root && localMdPath) {
    const originalAbs = safeResolve(root, localMdPath);
    if (originalAbs) unlinkSafe(originalAbs);
    const trashAbs = computeTrashPath(root, localMdPath);
    if (trashAbs) unlinkSafe(trashAbs);
  }
  try {
    store.purgeCloudDeleted(objToken);
    return true;
  } catch (err) {
    console.error('[trash] purgeOne DB delete failed:', { objToken, err });
    return false;
  }
}

export { trashRoutes };
