#!/usr/bin/env tsx
/**
 * SQLite-only reconciliation apply (P2-07).
 *
 * Default is dry-run. Real writes require --apply --confirm APPLY.
 * Does not move or delete knowledge-base files.
 *
 * Usage:
 *   npx tsx scripts/reconcile-apply.ts --root <kb> --db <sqlite>
 *   npx tsx scripts/reconcile-apply.ts --root <kb> --db <sqlite> --apply --confirm APPLY
 *   npx tsx scripts/reconcile-apply.ts --rollback --db <sqlite> --backup <path> --confirm RESTORE
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyReconciliation,
  rollbackReconciliationApply,
} from '../src/modules/reconciliation-apply.js';
import type { LayoutProfile, WatchedRootConfig } from '../src/types/index.js';

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--rollback') out.rollback = true;
    else if (arg.startsWith('--')) {
      out[arg.slice(2)] = argv[++i] ?? '';
    }
  }
  return out;
}

function defaultWatchedRoots(kbRoot: string): WatchedRootConfig[] {
  const candidates: Array<{ localDir: string; layoutProfile: LayoutProfile; id: string }> = [
    { localDir: '策划 - Designer', layoutProfile: 'mirror-title-file', id: 'preset-designer' },
    { localDir: '技术 - Dev', layoutProfile: 'directory-readme', id: 'preset-dev' },
    { localDir: '[必读] 研发规范', layoutProfile: 'directory-readme', id: 'preset-spec' },
    { localDir: '开发环境指引', layoutProfile: 'directory-readme', id: 'preset-devguide' },
  ];
  return candidates
    .filter((item) => fs.existsSync(path.join(kbRoot, item.localDir)))
    .map((item) => ({
      id: item.id,
      url: `https://example.feishu.cn/wiki/${item.id}`,
      localDir: item.localDir,
      layoutProfile: item.layoutProfile,
      enabled: true,
    }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.rollback) {
    const db = String(args.db || '');
    const backup = String(args.backup || '');
    rollbackReconciliationApply({
      dbPath: path.resolve(db),
      backupPath: path.resolve(backup),
      confirmation: String(args.confirm || ''),
    });
    console.log(JSON.stringify({ ok: true, mode: 'restore', db, backup }, null, 2));
    return;
  }

  const root = path.resolve(String(args.root || ''));
  const dbPath = path.resolve(String(args.db || ''));
  if (!root || !dbPath) {
    console.error('需要 --root <kb> --db <sqlite>');
    process.exit(1);
  }

  const result = await applyReconciliation({
    knowledgeBaseRoot: root,
    watchedRoots: defaultWatchedRoots(root),
    dbPath,
    operationDirectory: path.join(os.homedir(), '.feishu-sync', 'operations'),
    confirmation: args.apply ? String(args.confirm || '') : undefined,
  });

  console.log(JSON.stringify({
    ok: true,
    mode: result.mode,
    operationId: result.operationId,
    applied: result.applied,
    skipped: result.skipped,
    backupPath: result.backupPath,
    manifestPath: result.manifestPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
