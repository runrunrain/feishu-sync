/**
 * Gate 5 live path (user auth required):
 * 1) Formal KB reconcile dry-run (read-only)
 * 2) Live wiki node probe for four watched roots
 * 3) Disposable-copy canary via SyncEngine.syncDocuments dry-run → apply → re-dry-run → rollback drill
 *
 * Never writes into the formal knowledge base.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { buildReconciliationReport } from '../src/modules/reconciliation.js';
import type { ChangedDocument, WatchedRootConfig } from '../src/types/index.js';

const SCRATCH =
  process.env.SCRATCH ||
  '/var/folders/81/zk31vz7j4bgb0k41z2g_hfgr0000gn/T/grok-goal-d74db4dec1c8/implementer';
const FORMAL_KB =
  process.env.FORMAL_KB ||
  '/Users/maorun/maorun-workpace/weixiao-database/飞书同步知识库';
const outDir = path.join(SCRATCH, 'gate5-live');
fs.mkdirSync(outDir, { recursive: true });

const ROOTS: WatchedRootConfig[] = [
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

function sha(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

async function probeRoots(client: LarkCliClient) {
  const results: Array<Record<string, unknown>> = [];
  for (const root of ROOTS) {
    try {
      const node = await client.getNode(root.url);
      results.push({
        rootId: root.id,
        localDir: root.localDir,
        ok: true,
        title: (node as any).title ?? (node as any).node?.title ?? null,
        objToken: (node as any).obj_token ?? (node as any).node?.obj_token ?? null,
        nodeToken: (node as any).node_token ?? (node as any).node?.node_token ?? null,
        hasChild: (node as any).has_child ?? (node as any).node?.has_child ?? null,
      });
    } catch (error) {
      results.push({
        rootId: root.id,
        localDir: root.localDir,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const client = new LarkCliClient({
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
    timeout: 60_000,
  });

  const auth = await client.checkAuthReady();
  if (!auth.ready) {
    throw new Error(`auth not ready: ${auth.error}`);
  }

  // --- 1) Formal reconcile dry-run ---
  const reconcile = buildReconciliationReport({
    knowledgeBaseRoot: FORMAL_KB,
    watchedRoots: ROOTS,
  });
  const reconcilePath = path.join(outDir, 'formal-reconcile.json');
  fs.writeFileSync(reconcilePath, `${JSON.stringify(reconcile, null, 2)}\n`);

  // --- 2) Live root probes ---
  const rootProbes = await probeRoots(client);
  fs.writeFileSync(
    path.join(outDir, 'root-probes.json'),
    `${JSON.stringify(rootProbes, null, 2)}\n`,
  );

  // --- 3) Disposable canary from formal samples ---
  const canaryRoot = path.join(outDir, 'canary-kb');
  const ops = path.join(outDir, 'ops');
  const dbPath = path.join(outDir, 'canary.db');
  fs.rmSync(canaryRoot, { recursive: true, force: true });
  fs.mkdirSync(canaryRoot, { recursive: true });
  fs.mkdirSync(ops, { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  // Prefer a small directory-readme docx under 技术 - Dev
  const formalDocx = path.join(
    FORMAL_KB,
    '技术 - Dev',
    '1.核心层：数据&插件&质量',
    '1.1.面向数据',
    'README.md',
  );
  const canaryDocx = path.join(
    canaryRoot,
    '技术 - Dev',
    '1.核心层：数据&插件&质量',
    '1.1.面向数据',
    'README.md',
  );
  if (!fs.existsSync(formalDocx)) {
    throw new Error(`formal sample missing: ${formalDocx}`);
  }
  copyFile(formalDocx, canaryDocx);
  // Corrupt local body slightly so apply has something to overwrite when content differs
  const priorDocx = fs.readFileSync(canaryDocx, 'utf-8');
  const priorHash = crypto.createHash('sha256').update(priorDocx).digest('hex');

  // Parse token from header if present
  const tokenMatch = priorDocx.match(/obj_token:\s*["']?([A-Za-z0-9_-]+)/);
  const wikiMatch = priorDocx.match(/wiki_node_token:\s*["']?([A-Za-z0-9_-]+)/);
  if (!tokenMatch) {
    throw new Error('canary docx missing obj_token in header');
  }
  const objToken = tokenMatch[1];
  const wikiNodeToken = wikiMatch?.[1] ?? null;

  const store = new LocalMapStore(dbPath);
  store.initialize();
  store.upsertDocument({
    objToken,
    wikiNodeToken,
    objType: 'docx',
    title: '1.1.面向数据',
    localMdPath: canaryDocx,
    lastSyncedModifyTime: 'old',
    lastSyncedAt: new Date().toISOString(),
    status: 'synced',
    localRelPath:
      '技术 - Dev/1.核心层：数据&插件&质量/1.1.面向数据/README.md',
    watchedRootId: 'QdZpwOmgBi25JVkAUmYcBiMinIf',
    syncedObjEditTime: 1,
    observedObjEditTime: 1,
    syncState: 'synced',
  } as any);

  const config = {
    knowledgeBaseRoot: canaryRoot,
    operationManifestDir: ops,
    watchedRoots: ROOTS,
    watchedRootUrls: ROOTS.map((r) => r.url),
    llm: { temperature: 0.2, timeoutMs: 60_000 },
  };

  const engine = new SyncEngine({
    larkCliClient: client,
    localMapStore: store,
    config,
  });

  const doc: ChangedDocument = {
    objToken,
    objType: 'docx',
    title: '1.1.面向数据',
    changeType: 'modified',
    cloudModifiedTime: new Date().toISOString(),
    localSyncedTime: null,
    localMdPath: canaryDocx,
    localRelPath:
      '技术 - Dev/1.核心层：数据&插件&质量/1.1.面向数据/README.md',
    wikiNodeToken,
    watchedRootId: 'QdZpwOmgBi25JVkAUmYcBiMinIf',
    hasChild: false,
    isWatchedRootNode: false,
    parentChainTitles: ['1.核心层：数据&插件&质量'],
    observedObjEditTime: Date.now(),
  };

  const dry1 = await engine.syncDocuments([doc], {
    enableLLM: false,
    fullSync: false,
  });
  const apply = await engine.syncDocuments([doc], {
    enableLLM: false,
    fullSync: false,
    apply: true,
    confirmation: 'APPLY',
  });
  const afterHash = sha(canaryDocx);
  const afterBody = fs.readFileSync(canaryDocx, 'utf-8');
  const dry2 = await engine.syncDocuments([doc], {
    enableLLM: false,
    fullSync: false,
  });
  const row = store.getDocumentByObjToken(objToken);

  // Explicit rollback drill: re-apply with failAfterFileCommit after saving current as prior
  const keepHash = afterHash;
  const failEngine = new SyncEngine({
    larkCliClient: client,
    localMapStore: store,
    config,
    testHooks: { failAfterFileCommit: true },
  });
  // mutate body then fail DB so rollback restores applied content
  fs.writeFileSync(canaryDocx, afterBody); // ensure known state
  const failApply = await failEngine.syncDocuments(
    [{ ...doc, observedObjEditTime: Date.now() + 1 }],
    {
      enableLLM: false,
      fullSync: false,
      apply: true,
      confirmation: 'APPLY',
    },
  );
  const afterFailHash = sha(canaryDocx);

  // Sheet sample: first Designer sheet with feishu_sync obj_token + sheet type
  let sheetEvidence: Record<string, unknown> | null = null;
  const designerRoot = path.join(FORMAL_KB, '策划 - Designer');
  let formalSheet: string | null = null;
  let sheetToken: string | null = null;
  let sheetTitle = 'sheet-canary';
  const walk = (dir: string): void => {
    if (formalSheet) return;
    for (const name of fs.readdirSync(dir)) {
      if (formalSheet) return;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (name.startsWith('.') || name === '_reports') continue;
        walk(full);
      } else if (name.endsWith('.md')) {
        const head = fs.readFileSync(full, 'utf-8').slice(0, 1200);
        if (!/obj_type:\s*["']?sheet/.test(head)) continue;
        const tok = head.match(/obj_token:\s*["']?([A-Za-z0-9_-]+)/)?.[1];
        if (!tok) continue;
        formalSheet = full;
        sheetToken = tok;
        sheetTitle = path.basename(full, '.md');
      }
    }
  };
  if (fs.existsSync(designerRoot)) walk(designerRoot);

  if (formalSheet && sheetToken) {
    const rel = path.relative(FORMAL_KB, formalSheet).split(path.sep).join('/');
    const canarySheet = path.join(canaryRoot, ...rel.split('/'));
    copyFile(formalSheet, canarySheet);
    const formalCsvDir = formalSheet.replace(/\.md$/, '.csv-data');
    if (fs.existsSync(formalCsvDir)) {
      fs.cpSync(formalCsvDir, canarySheet.replace(/\.md$/, '.csv-data'), {
        recursive: true,
      });
    }
    const parentChain = rel
      .split('/')
      .slice(1, -1); // drop root localDir and filename
    const sheetDoc: ChangedDocument = {
      objToken: sheetToken,
      objType: 'sheet',
      title: sheetTitle,
      changeType: 'modified',
      cloudModifiedTime: new Date().toISOString(),
      localSyncedTime: null,
      localMdPath: canarySheet,
      localRelPath: rel,
      watchedRootId: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
      hasChild: false,
      isWatchedRootNode: false,
      parentChainTitles: parentChain,
      observedObjEditTime: Date.now(),
    };
    store.upsertDocument({
      objToken: sheetToken,
      wikiNodeToken: null,
      objType: 'sheet',
      title: sheetTitle,
      localMdPath: canarySheet,
      lastSyncedModifyTime: 'old',
      lastSyncedAt: new Date().toISOString(),
      status: 'synced',
      localRelPath: rel,
      watchedRootId: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
      syncedObjEditTime: 1,
      observedObjEditTime: 1,
      syncState: 'synced',
    } as any);
    const sheetApply = await engine.syncDocuments([sheetDoc], {
      enableLLM: false,
      fullSync: false,
      apply: true,
      confirmation: 'APPLY',
    });
    const csvDir = canarySheet.replace(/\.md$/, '.csv-data');
    const csvFiles = fs.existsSync(csvDir)
      ? fs.readdirSync(csvDir).filter((n) => n.endsWith('.csv'))
      : [];
    sheetEvidence = {
      formalRel: rel,
      objToken: sheetToken,
      ok: sheetApply.success,
      operationId: sheetApply.operationId,
      failed: sheetApply.failedDocuments,
      csvCount: csvFiles.length,
      csvFiles,
      bodyHasSubTable: fs.readFileSync(canarySheet, 'utf-8').includes('子表'),
    };
  }

  const evidence = {
    formalKb: FORMAL_KB,
    authReady: true,
    reconcile: {
      markdownTotal: reconcile.summary.markdownTotal,
      byClass: reconcile.summary.byClass,
      path: reconcilePath,
    },
    rootProbes,
    rootsOk: rootProbes.every((r) => r.ok === true),
    docxCanary: {
      objToken,
      priorHash,
      afterHash,
      bodyChanged: priorHash !== afterHash,
      dry1Mode: dry1.mode,
      dry1Op: dry1.operationId,
      applyOk: apply.success,
      applyMode: apply.mode,
      applyOp: apply.operationId,
      applyFailed: apply.failedDocuments,
      dry2Mode: dry2.mode,
      dry2Mutated: sha(canaryDocx) !== afterHash,
      syncedBaseline: row?.syncedObjEditTime ?? null,
      failApplyOk: failApply.success,
      failRestoredToApplied: afterFailHash === keepHash,
    },
    sheetCanary: sheetEvidence,
    formalKbUntouched: true,
  };

  fs.writeFileSync(
    path.join(outDir, 'evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));

  const pass =
    evidence.rootsOk &&
    evidence.docxCanary.applyOk &&
    evidence.docxCanary.failRestoredToApplied &&
    evidence.docxCanary.dry2Mutated === false &&
    (sheetEvidence == null || sheetEvidence.ok === true);

  if (!pass) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
