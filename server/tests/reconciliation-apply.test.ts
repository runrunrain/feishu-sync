/**
 * P2-07 reconciliation apply: SQLite-only backfill with backup/rollback.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  applyReconciliation,
  rollbackReconciliationApply,
} from '../src/modules/reconciliation-apply.js';
import type { WatchedRootConfig } from '../src/types/index.js';

function makeKb(): { root: string; dbPath: string; ops: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-apply-kb-'));
  const ops = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-apply-ops-'));
  const dir = path.join(root, '技术 - Dev', '节点A');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    `<!--
feishu_sync:
  obj_token: tok-a
  wiki_node_token: node-a
  obj_type: docx
  original_link: https://example.feishu.cn/wiki/node-a
  fetch_date: 2026-07-17
-->

# 节点A标题
`,
  );

  const dbPath = path.join(root, 'map.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE documents (
      obj_token TEXT PRIMARY KEY,
      wiki_node_token TEXT,
      obj_type TEXT,
      title TEXT,
      local_md_path TEXT,
      last_synced_modify_time TEXT,
      last_synced_at TEXT,
      status TEXT,
      local_rel_path TEXT,
      watched_root_id TEXT,
      cloud_match TEXT DEFAULT 'unknown',
      updated_at TEXT
    );
  `);
  db.prepare(
    `INSERT INTO documents (obj_token, title, local_md_path, status)
     VALUES ('tok-a', 'README', ?, 'synced')`,
  ).run(path.join(dir, 'README.md'));
  db.close();

  return { root, dbPath, ops };
}

const roots: WatchedRootConfig[] = [
  {
    id: 'dev',
    url: 'https://example.feishu.cn/wiki/dev',
    localDir: '技术 - Dev',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
];

describe('applyReconciliation', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    temps.length = 0;
  });

  it('dry-runs without confirmation and does not mutate sqlite', async () => {
    const { root, dbPath, ops } = makeKb();
    temps.push(root, ops);

    const result = await applyReconciliation({
      knowledgeBaseRoot: root,
      watchedRoots: roots,
      dbPath,
      operationDirectory: ops,
    });

    expect(result.mode).toBe('dry-run');
    expect(result.applied).toBe(0);
    expect(result.backupPath).toBeNull();

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT title, local_rel_path FROM documents WHERE obj_token='tok-a'`).get() as any;
    expect(row.title).toBe('README');
    expect(row.local_rel_path).toBeNull();
    db.close();
  });

  it('applies unique title/path backfill and supports RESTORE rollback', async () => {
    const { root, dbPath, ops } = makeKb();
    temps.push(root, ops);

    const applied = await applyReconciliation({
      knowledgeBaseRoot: root,
      watchedRoots: roots,
      dbPath,
      operationDirectory: ops,
      confirmation: 'APPLY',
    });

    expect(applied.mode).toBe('apply');
    expect(applied.applied).toBeGreaterThanOrEqual(1);
    expect(applied.backupPath && fs.existsSync(applied.backupPath)).toBe(true);

    let db = new Database(dbPath, { readonly: true });
    let row = db.prepare(`SELECT title, local_rel_path FROM documents WHERE obj_token='tok-a'`).get() as any;
    expect(row.title).toBe('节点A标题');
    expect(row.local_rel_path).toBe('技术 - Dev/节点A/README.md');
    db.close();

    rollbackReconciliationApply({
      dbPath,
      backupPath: applied.backupPath!,
      confirmation: 'RESTORE',
    });

    db = new Database(dbPath, { readonly: true });
    row = db.prepare(`SELECT title, local_rel_path FROM documents WHERE obj_token='tok-a'`).get() as any;
    expect(row.title).toBe('README');
    expect(row.local_rel_path).toBeNull();
    db.close();
  });
});
