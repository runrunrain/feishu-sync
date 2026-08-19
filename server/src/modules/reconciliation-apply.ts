/**
 * Reconciliation apply (P2-07) — SQLite backfill only.
 *
 * Safety boundary for this phase:
 *   - Never deletes Markdown, orphans, or .pre-migrate files.
 *   - Never moves/overwrites knowledge-base files (path migration stays
 *     planned until P3 atomic commit).
 *   - Only unique, token-backed items may update documents rows.
 *   - Requires confirmation === 'APPLY' and writes an external operation
 *     manifest + SQLite online backup first.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  type ReconciliationItem,
  type ReconciliationReport,
  buildReconciliationReport,
} from './reconciliation.js';
import {
  resolveOperationDirectory,
  writeOperationManifest,
} from './operation-manifest.js';
import type { WatchedRootConfig } from '../types/index.js';

export interface ReconciliationApplyOptions {
  knowledgeBaseRoot: string;
  watchedRoots: WatchedRootConfig[];
  dbPath: string;
  confirmation?: string;
  operationDirectory?: string;
  /** Pre-built dry-run report; if omitted, one is generated first. */
  report?: ReconciliationReport;
  /** Custom-folder prefixes to exclude from the generated report. */
  customFolderRelPaths?: string[];
}

export interface ReconciliationApplyResult {
  mode: 'dry-run' | 'apply';
  operationId: string;
  manifestPath: string;
  backupPath: string | null;
  applied: number;
  skipped: number;
  items: Array<{
    relativePath: string;
    objToken: string;
    action: 'updated' | 'skipped';
    reason?: string;
  }>;
}

const APPLYABLE = new Set([
  'indexed_unique',
  'indexed_readme_title_fixed',
  'profile_path_mismatch',
]);

async function backupSqlite(
  dbPath: string,
  backupDir: string,
  operationId: string,
): Promise<string> {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, `${operationId}.db`);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }
  return backupPath;
}

function openWritableDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

/**
 * Apply unique reconciliation conclusions to SQLite.
 * File-system mutations are intentionally out of scope.
 */
export async function applyReconciliation(
  options: ReconciliationApplyOptions,
): Promise<ReconciliationApplyResult> {
  const root = path.resolve(options.knowledgeBaseRoot);
  const report =
    options.report ??
    buildReconciliationReport({
      knowledgeBaseRoot: root,
      watchedRoots: options.watchedRoots,
      customFolderRelPaths: options.customFolderRelPaths,
      dbPath: options.dbPath,
    });

  const operationId = `reconcile-apply-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const operationDirectory = resolveOperationDirectory(
    root,
    options.operationDirectory,
  );
  fs.mkdirSync(operationDirectory, { recursive: true, mode: 0o700 });

  const planned = report.items.filter(
    (item) =>
      item.objToken &&
      APPLYABLE.has(item.classification) &&
      item.classification !== 'profile_path_mismatch',
  );

  // profile_path_mismatch stays skipped for file moves; still may update
  // title/local_rel_path to the *current* path identity.
  const titleOnlyMismatches = report.items.filter(
    (item) =>
      item.objToken && item.classification === 'profile_path_mismatch',
  );

  const candidates: ReconciliationItem[] = [...planned, ...titleOnlyMismatches];

  const dryRunManifest = {
    schemaVersion: 1 as const,
    operationId,
    mode: 'dry-run' as const,
    createdAt: new Date().toISOString(),
    knowledgeBaseRoot: root,
    documents: candidates.map((item) => ({
      objToken: item.objToken!,
      title: item.title ?? item.relativePath,
      objType: 'docx' as const,
      changeType: 'modified' as const,
      action: 'replace' as const,
      localMdPath: path.join(root, ...item.relativePath.split('/')),
      localRelPath: item.relativePath,
      previousSha256: null,
      reason: `reconciliation ${item.classification}`,
      pathSource: 'existing-mapping' as const,
    })),
    summary: {
      create: 0,
      replace: candidates.length,
      blocked: 0,
    },
  };

  if (options.confirmation !== 'APPLY') {
    const manifestPath = writeOperationManifest(
      dryRunManifest as any,
      operationDirectory,
    );
    return {
      mode: 'dry-run',
      operationId,
      manifestPath,
      backupPath: null,
      applied: 0,
      skipped: candidates.length,
      items: candidates.map((item) => ({
        relativePath: item.relativePath,
        objToken: item.objToken!,
        action: 'skipped' as const,
        reason: '需要 confirmation=APPLY 才会写 SQLite',
      })),
    };
  }

  if (!options.dbPath || !fs.existsSync(options.dbPath)) {
    throw new Error(`SQLite 数据库不存在: ${options.dbPath}`);
  }

  const backupPath = await backupSqlite(
    options.dbPath,
    operationDirectory,
    operationId,
  );

  const db = openWritableDb(options.dbPath);
  const results: ReconciliationApplyResult['items'] = [];
  let applied = 0;
  let skipped = 0;

  try {
    const update = db.prepare(`
      UPDATE documents
      SET
        title = COALESCE(?, title),
        local_rel_path = COALESCE(?, local_rel_path),
        local_md_path = COALESCE(?, local_md_path),
        wiki_node_token = COALESCE(?, wiki_node_token),
        watched_root_id = COALESCE(?, watched_root_id),
        updated_at = datetime('now')
      WHERE obj_token = ?
    `);

    const exists = db.prepare(
      `SELECT obj_token FROM documents WHERE obj_token = ? LIMIT 1`,
    );

    const tx = db.transaction(() => {
      for (const item of candidates) {
        const token = item.objToken!;
        const row = exists.get(token) as { obj_token: string } | undefined;
        if (!row) {
          // Insert minimal row so reindex identity is available.
          db.prepare(`
            INSERT INTO documents (
              obj_token, wiki_node_token, obj_type, title, local_md_path,
              last_synced_modify_time, last_synced_at, status,
              local_rel_path, watched_root_id, cloud_match
            ) VALUES (?, ?, 'docx', ?, ?, datetime('now'), datetime('now'), 'synced', ?, ?, 'synced')
          `).run(
            token,
            item.wikiNodeToken,
            item.title ?? path.basename(item.relativePath, '.md'),
            path.join(root, ...item.relativePath.split('/')),
            item.relativePath,
            item.watchedRootId,
          );
          applied += 1;
          results.push({
            relativePath: item.relativePath,
            objToken: token,
            action: 'updated',
            reason: 'inserted from reconciliation',
          });
          continue;
        }

        const absolute = path.join(root, ...item.relativePath.split('/'));
        update.run(
          item.title,
          item.relativePath,
          absolute,
          item.wikiNodeToken,
          item.watchedRootId,
          token,
        );
        applied += 1;
        results.push({
          relativePath: item.relativePath,
          objToken: token,
          action: 'updated',
        });
      }
    });
    tx();
  } finally {
    db.close();
  }

  const applyManifest = {
    ...dryRunManifest,
    mode: 'apply' as const,
    completedAt: new Date().toISOString(),
    summary: {
      create: 0,
      replace: applied,
      blocked: skipped,
      succeeded: applied,
      failed: skipped,
    },
  };
  const manifestPath = writeOperationManifest(
    applyManifest as any,
    operationDirectory,
  );

  // Persist companion JSON for explicit rollback tooling.
  fs.writeFileSync(
    path.join(operationDirectory, `${operationId}.apply.json`),
    `${JSON.stringify({
      operationId,
      backupPath,
      applied,
      skipped,
      results,
    }, null, 2)}\n`,
    { encoding: 'utf-8', mode: 0o600 },
  );

  return {
    mode: 'apply',
    operationId,
    manifestPath,
    backupPath,
    applied,
    skipped,
    items: results,
  };
}

/**
 * Restore SQLite from a reconciliation apply backup.
 * Requires confirmation === 'RESTORE'.
 */
export function rollbackReconciliationApply(options: {
  dbPath: string;
  backupPath: string;
  confirmation?: string;
}): void {
  if (options.confirmation !== 'RESTORE') {
    throw new Error('回滚需要 confirmation=RESTORE');
  }
  if (!fs.existsSync(options.backupPath)) {
    throw new Error(`备份不存在: ${options.backupPath}`);
  }
  const targetDir = path.dirname(path.resolve(options.dbPath));
  fs.mkdirSync(targetDir, { recursive: true });
  const tempPath = `${options.dbPath}.restore-tmp`;
  fs.copyFileSync(options.backupPath, tempPath);
  fs.renameSync(tempPath, options.dbPath);
}
