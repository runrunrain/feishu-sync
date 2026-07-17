/**
 * Production-oriented full sync against the formal knowledge base:
 * index → detect all roots → dry-run → apply (confirmation=APPLY).
 *
 * Usage:
 *   npx tsx scripts/sync-latest.ts              # dry-run only
 *   npx tsx scripts/sync-latest.ts --apply      # real write
 *   npx tsx scripts/sync-latest.ts --apply --root designer
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChangeDetector } from '../src/modules/change-detector.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { IndexScanner } from '../src/modules/index-scanner.js';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { LayoutReconstructor } from '../src/modules/layout-reconstructor.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { SnapshotService } from '../src/modules/snapshot-service.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import type { ChangedDocument, WatchedRootConfig } from '../src/types/index.js';

const FORMAL_KB =
  process.env.FORMAL_KB ||
  '/Users/maorun/maorun-workpace/weixiao-database/飞书同步知识库';
const CONFIG_DIR = process.env.FEISHU_SYNC_HOME || path.join(os.homedir(), '.feishu-sync');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DB_PATH = path.join(CONFIG_DIR, 'feishu-sync.db');
const OPS_DIR = path.join(CONFIG_DIR, 'operations');

const ALL_ROOTS: WatchedRootConfig[] = [
  {
    id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb',
    localDir: '策划 - Designer',
    layoutProfile: 'mirror-title-file',
    enabled: true,
  },
  {
    id: 'QdZpwOmgBi25JVkAUmYcBiMinIf',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/QdZpwOmgBi25JVkAUmYcBiMinIf',
    localDir: '技术 - Dev',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
  {
    id: 'NudewPkE9inlGhkEDA1c9FSsnkb',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/NudewPkE9inlGhkEDA1c9FSsnkb',
    localDir: '[必读] 研发规范',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
  {
    id: 'FEaww3vUHieIumk6FdIc92WHnyh',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/FEaww3vUHieIumk6FdIc92WHnyh',
    localDir: '开发环境指引',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
];

const ROOT_ALIASES: Record<string, string> = {
  designer: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
  dev: 'QdZpwOmgBi25JVkAUmYcBiMinIf',
  spec: 'NudewPkE9inlGhkEDA1c9FSsnkb',
  guide: 'FEaww3vUHieIumk6FdIc92WHnyh',
};

function parseArgs(argv: string[]) {
  let apply = false;
  let rootFilter: string | null = null;
  let skipIndex = false;
  let maxDocs = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--skip-index') skipIndex = true;
    else if (a === '--root') rootFilter = argv[++i] ?? null;
    else if (a === '--max') maxDocs = Number(argv[++i] || 0);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: sync-latest [--apply] [--root designer|dev|spec|guide|<id>] [--max N] [--skip-index]`);
      process.exit(0);
    }
  }
  return { apply, rootFilter, skipIndex, maxDocs };
}

function ensureConfig(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(OPS_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(FORMAL_KB)) {
    throw new Error(`知识库不存在: ${FORMAL_KB}`);
  }

  const payload = {
    _warning:
      'Contains secrets if apiKey filled. Do not commit. FEISHU_SYNC_HOME default ~/.feishu-sync',
    llm: {
      openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: '',
      model: 'glm-4-flash',
      temperature: 0.2,
      timeoutMs: 600_000,
      primaryChannel: 'claude-cli',
      fallbackOnFailure: true,
      claudeCli: { extraArgs: [] },
    },
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: FORMAL_KB,
    watchedRoots: ALL_ROOTS,
    watchedRootUrls: ALL_ROOTS.map((r) => r.url),
    requiredScopes: [
      'wiki:node:retrieve',
      'wiki:space:retrieve',
      'docs:document.content:read',
      'sheets:spreadsheet:read',
      'docx:document:readonly',
      'drive:drive.metadata:readonly',
      'docs:document.media:download',
      'slides:presentation:read',
      'offline_access',
    ],
    enableAutoStart: true,
    enableNotifications: true,
  };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

function selectRoots(filter: string | null): WatchedRootConfig[] {
  if (!filter) return ALL_ROOTS;
  const id = ROOT_ALIASES[filter] || filter;
  const found = ALL_ROOTS.filter((r) => r.id === id || r.localDir.includes(filter));
  if (found.length === 0) {
    throw new Error(`未知 root 过滤: ${filter}`);
  }
  return found;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  ensureConfig();

  console.info(`[sync-latest] config=${CONFIG_PATH}`);
  console.info(`[sync-latest] kb=${FORMAL_KB}`);
  console.info(`[sync-latest] db=${DB_PATH}`);
  console.info(`[sync-latest] mode=${args.apply ? 'APPLY' : 'dry-run'}`);

  const configManager = new ConfigManager(CONFIG_PATH);
  const config = await configManager.load();
  // Force knowledge base + roots in case old config existed
  config.knowledgeBaseRoot = FORMAL_KB;
  config.watchedRoots = ALL_ROOTS;
  (config as any).operationManifestDir = OPS_DIR;

  const store = new LocalMapStore(DB_PATH);
  store.initialize();

  const lark = new LarkCliClient({
    requiredScopes: config.requiredScopes,
    timeout: 120_000,
  });
  const auth = await lark.checkAuthReady();
  if (!auth.ready) {
    throw new Error(`鉴权未就绪: ${auth.error}`);
  }
  console.info('[sync-latest] auth ready');

  if (!args.skipIndex) {
    console.info('[sync-latest] indexing local knowledge base...');
    const scanner = new IndexScanner({
      localMapStore: store,
      larkCliClient: lark,
      config,
    });
    const indexResult = await scanner.scanKnowledgeBase(FORMAL_KB);
    console.info(
      `[sync-latest] index: scanned=${indexResult.scanned} indexed=${indexResult.indexed} skipped=${indexResult.skipped} failed=${indexResult.failed}`,
    );
  }

  const roots = selectRoots(args.rootFilter);
  const detector = new ChangeDetector(lark, store);
  const allChanges: ChangedDocument[] = [];
  const detectSummary: Array<Record<string, unknown>> = [];

  for (const root of roots) {
    console.info(`[sync-latest] detect ${root.localDir} ...`);
    try {
      const result = await detector.detectChanges(root.url);
      const docs = result.changedDocuments.map((d) => ({
        ...d,
        watchedRootId: d.watchedRootId ?? root.id,
      }));
      allChanges.push(...docs);
      detectSummary.push({
        root: root.localDir,
        totalNodes: result.totalNodes,
        changed: docs.length,
        added: docs.filter((d) => d.changeType === 'added').length,
        modified: docs.filter((d) => d.changeType === 'modified').length,
        deleted: docs.filter((d) => d.changeType === 'deleted').length,
        traversalComplete: result.traversalComplete ?? null,
      });
      console.info(
        `[sync-latest]   nodes=${result.totalNodes} changed=${docs.length} complete=${result.traversalComplete}`,
      );
    } catch (error) {
      detectSummary.push({
        root: root.localDir,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`[sync-latest] detect failed for ${root.localDir}:`, error);
    }
  }

  // Deduplicate by objToken (last wins)
  const byToken = new Map<string, ChangedDocument>();
  for (const doc of allChanges) {
    byToken.set(doc.objToken, doc);
  }
  let documents = [...byToken.values()].filter((d) => d.changeType !== 'deleted');

  // Enrich with SQLite mappings so PathResolver prefers existing files
  // (avoids "existing-file" blocks for already-indexed bodies).
  documents = documents.map((doc) => {
    const record = store.getDocumentByObjToken(doc.objToken);
    if (!record) return doc;
    return {
      ...doc,
      localMdPath: record.localMdPath || doc.localMdPath,
      localRelPath: record.localRelPath || doc.localRelPath || null,
      title: doc.title || record.title,
      wikiNodeToken: doc.wikiNodeToken ?? record.wikiNodeToken ?? null,
      watchedRootId: doc.watchedRootId || record.watchedRootId || null,
    };
  });

  if (args.maxDocs > 0) {
    documents = documents.slice(0, args.maxDocs);
  }

  console.info(`[sync-latest] unique pending (non-delete)=${documents.length}`);
  for (const d of documents.slice(0, 30)) {
    console.info(
      `  - [${d.changeType}] ${d.objType} ${d.title} path=${d.localRelPath || d.localMdPath || '∅'} (${d.objToken.slice(0, 8)}…)`,
    );
  }
  if (documents.length > 30) console.info(`  … +${documents.length - 30} more`);

  const engine = new SyncEngine({
    larkCliClient: lark,
    localMapStore: store,
    config,
    layoutReconstructor: new LayoutReconstructor(),
  });

  // Always dry-run first for reviewability
  console.info('[sync-latest] dry-run plan...');
  const dry = await engine.syncDocuments(documents, {
    enableLLM: false,
    fullSync: false,
  });
  const plannedOk = (dry.plannedDocuments ?? []).filter(
    (p) => p.action === 'create' || p.action === 'replace' || p.action === 'move',
  );
  const plannedBlocked = (dry.plannedDocuments ?? []).filter((p) => p.action === 'blocked');
  console.info(
    `[sync-latest] dry-run op=${dry.operationId} ok=${plannedOk.length} blocked=${plannedBlocked.length}`,
  );
  if (plannedBlocked.length) {
    const reasons = new Map<string, number>();
    for (const p of plannedBlocked) {
      const key = (p.reason || 'unknown').slice(0, 80);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    console.info('[sync-latest] blocked reasons:');
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.info(`  ${count}× ${reason}`);
    }
  }

  // Only apply documents that have an unblocked plan target.
  const applyTokens = new Set(plannedOk.map((p) => p.objToken));
  const toApply = documents.filter((d) => applyTokens.has(d.objToken));

  let applyResult = null;
  if (args.apply) {
    if (toApply.length === 0) {
      console.info('[sync-latest] nothing unblocked to apply');
    } else {
      console.info(
        `[sync-latest] APPLY ${toApply.length} documents (skipped blocked ${plannedBlocked.length})...`,
      );
      applyResult = await engine.syncDocuments(toApply, {
        enableLLM: false,
        fullSync: false,
        apply: true,
        confirmation: 'APPLY',
      });
      console.info(
        `[sync-latest] apply op=${applyResult.operationId} success=${applyResult.success} ok=${applyResult.syncedDocuments.length} fail=${applyResult.failedDocuments.length} duration=${applyResult.duration}ms`,
      );
      if (applyResult.failedDocuments.length) {
        for (const f of applyResult.failedDocuments.slice(0, 20)) {
          console.error(`  FAIL ${f.title}: ${f.error}`);
        }
      }

      try {
        const scanner = new IndexScanner({
          localMapStore: store,
          larkCliClient: lark,
          config,
        });
        const snap = new SnapshotService(store, configManager, scanner);
        snap.generate();
        console.info('[sync-latest] _index.json refreshed');
      } catch (e) {
        console.warn('[sync-latest] snapshot refresh failed:', e);
      }
    }
  } else {
    console.info('[sync-latest] dry-run only. Re-run with --apply to write formal KB.');
  }

  const report = {
    at: new Date().toISOString(),
    formalKb: FORMAL_KB,
    apply: args.apply,
    detectSummary,
    pendingCount: documents.length,
    dryRun: {
      operationId: dry.operationId,
      success: dry.success,
      failed: dry.failedDocuments.length,
      planned: dry.plannedDocuments?.map((p) => ({
        title: p.title,
        action: p.action,
        path: p.localRelPath ?? p.localMdPath,
      })),
    },
    applyResult: applyResult
      ? {
          operationId: applyResult.operationId,
          success: applyResult.success,
          synced: applyResult.syncedDocuments.map((s) => ({
            title: s.title,
            path: s.localMdPath,
            size: s.size,
            images: s.imagesCount,
            sheets: s.sheetsCount,
          })),
          failed: applyResult.failedDocuments,
          durationMs: applyResult.duration,
        }
      : null,
  };

  const reportPath = path.join(
    OPS_DIR,
    `sync-latest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.info(`[sync-latest] report ${reportPath}`);
  console.info(JSON.stringify({
    pending: documents.length,
    dryOp: dry.operationId,
    applyOp: applyResult?.operationId ?? null,
    applySuccess: applyResult?.success ?? null,
    synced: applyResult?.syncedDocuments.length ?? 0,
    failed: applyResult?.failedDocuments.length ?? 0,
  }, null, 2));

  if (args.apply && applyResult && !applyResult.success) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error('[sync-latest] fatal:', error);
  process.exit(1);
});
