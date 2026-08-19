#!/usr/bin/env tsx
/**
 * Read-only reconciliation dry-run for a knowledge base copy or the formal
 * corpus. Never mutates Markdown; writes reports under ~/.feishu-sync/operations
 * unless --report is provided.
 *
 * Usage:
 *   npx tsx scripts/reconcile-knowledge-base.ts \
 *     --root /path/to/kb \
 *     [--report /path/to/out-dir]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReconciliationReport,
  formatReconciliationMarkdown,
} from '../src/modules/reconciliation.js';
import type { LayoutProfile, WatchedRootConfig } from '../src/types/index.js';

function parseArgs(argv: string[]): {
  root: string;
  reportDir: string;
  db: string;
} {
  let root = '';
  let db = '';
  let reportDir = path.join(os.homedir(), '.feishu-sync', 'operations');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') root = argv[++i] ?? '';
    else if (arg === '--db') db = argv[++i] ?? '';
    else if (arg === '--report') reportDir = argv[++i] ?? reportDir;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: reconcile-knowledge-base --root <kb> [--db <sqlite>] [--report <dir>]`);
      process.exit(0);
    }
  }
  if (!root) {
    console.error('缺少 --root <knowledgeBaseRoot>');
    process.exit(1);
  }
  // Default to the standard feishu-sync DB so custom-folder prefixes are
  // auto-excluded even when the caller omits --db.
  if (!db) {
    db = path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db');
  }
  return { root: path.resolve(root), reportDir: path.resolve(reportDir), db: path.resolve(db) };
}

/** Default four roots from the formal 飞书同步知识库 layout. */
function defaultWatchedRoots(kbRoot: string): WatchedRootConfig[] {
  const candidates: Array<{
    localDir: string;
    layoutProfile: LayoutProfile;
    id: string;
  }> = [
    {
      localDir: '策划 - Designer',
      layoutProfile: 'mirror-title-file',
      id: 'preset-designer',
    },
    {
      localDir: '技术 - Dev',
      layoutProfile: 'directory-readme',
      id: 'preset-dev',
    },
    {
      localDir: '[必读] 研发规范',
      layoutProfile: 'directory-readme',
      id: 'preset-spec',
    },
    {
      localDir: '开发环境指引',
      layoutProfile: 'directory-readme',
      id: 'preset-devguide',
    },
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

function main(): void {
  const { root, reportDir, db } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`知识库根不可读: ${root}`);
    process.exit(1);
  }

  const watchedRoots = defaultWatchedRoots(root);
  if (watchedRoots.length === 0) {
    console.warn('未发现预设 watchedRoots 目录，将按空配置扫描');
  }

  const report = buildReconciliationReport({
    knowledgeBaseRoot: root,
    watchedRoots,
    // Pass the DB so custom-folder prefixes are read automatically and
    // _custom files are never misclassified as outside_watched_roots.
    dbPath: fs.existsSync(db) ? db : undefined,
  });

  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const stamp = report.createdAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(reportDir, `reconcile-${stamp}.json`);
  const mdPath = path.join(reportDir, `reconcile-${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.writeFileSync(mdPath, formatReconciliationMarkdown(report), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  console.log(JSON.stringify({
    ok: true,
    markdownTotal: report.summary.markdownTotal,
    byClass: report.summary.byClass,
    jsonPath,
    mdPath,
  }, null, 2));
}

main();
