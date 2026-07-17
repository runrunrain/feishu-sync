/**
 * Gate 2 closeout evidence script: index disposable KB, apply relative-path
 * reconciliation to SQLite, regenerate portable snapshot, verify invariants.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { IndexScanner } from '../src/modules/index-scanner.js';
import { SnapshotService } from '../src/modules/snapshot-service.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { applyReconciliation } from '../src/modules/reconciliation-apply.js';
import { buildReconciliationReport } from '../src/modules/reconciliation.js';
import type { WatchedRootConfig } from '../src/types/index.js';

const scratch =
  process.env.SCRATCH ||
  '/var/folders/81/zk31vz7j4bgb0k41z2g_hfgr0000gn/T/grok-goal-d74db4dec1c8/implementer';
const kb = path.join(scratch, 'gate2-kb');
const data = path.join(scratch, 'gate2-data');
const dbPath = path.join(data, 'feishu-sync.db');
const ops = path.join(data, 'operations');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(ops, { recursive: true });

const roots: WatchedRootConfig[] = [
  {
    id: 'designer',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb',
    localDir: '策划 - Designer',
    layoutProfile: 'mirror-title-file',
    enabled: true,
  },
  {
    id: 'dev',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/QdZpwOmgBi25JVkAUmYcBiMinIf',
    localDir: '技术 - Dev',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
  {
    id: 'spec',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/NudewPkE9inlGhkEDA1c9FSsnkb',
    localDir: '[必读] 研发规范',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
  {
    id: 'devguide',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/FEaww3vUHieIumk6FdIc92WHnyh',
    localDir: '开发环境指引',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
];

async function main(): Promise<void> {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const store = new LocalMapStore(dbPath);
  store.initialize();
  const scanner = new IndexScanner({
    localMapStore: store,
    larkCliClient: {},
    config: { knowledgeBaseRoot: kb, watchedRoots: roots },
  });
  const scan = await scanner.scanKnowledgeBase(kb);
  console.log('scan', scan);

  const docs = store.getAllDocuments();
  let injected = 0;
  for (const d of docs.slice(0, 30)) {
    if (!d.localMdPath || !fs.existsSync(d.localMdPath)) continue;
    const rel = path.relative(kb, d.localMdPath).split(path.sep).join('/');
    const fakeAbs = `C:\\Users\\fake\\飞书同步知识库\\${rel.replace(/\//g, '\\')}`;
    store.upsertDocument({
      ...d,
      localMdPath: fakeAbs,
      localRelPath: null as any,
    });
    injected += 1;
  }
  console.log('injected windows paths', injected);

  store.upsertDocument({
    objToken: 'placeholder-restricted-1',
    wikiNodeToken: 'wiki-ph-1',
    objType: 'docx',
    title: '',
    localMdPath: '',
    lastSyncedModifyTime: '',
    lastSyncedAt: new Date().toISOString(),
    status: 'placeholder',
    cloudMatch: 'restricted',
    syncState: 'restricted',
  } as any);

  const report = buildReconciliationReport({
    knowledgeBaseRoot: kb,
    watchedRoots: roots,
  });
  const apply = await applyReconciliation({
    knowledgeBaseRoot: kb,
    watchedRoots: roots,
    dbPath,
    operationDirectory: ops,
    confirmation: 'APPLY',
    report,
  });
  console.log('apply', {
    mode: apply.mode,
    applied: apply.applied,
    operationId: apply.operationId,
  });

  await scanner.scanKnowledgeBase(kb);

  const configPath = path.join(data, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        llm: {
          openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
          apiKey: '',
          model: 'glm-4-flash',
          temperature: 0.2,
          primaryChannel: 'claude-cli',
          fallbackOnFailure: true,
          claudeCli: { extraArgs: [] },
        },
        pollIntervalMinutes: 30,
        knowledgeBaseRoot: kb,
        watchedRoots: roots,
        watchedRootUrls: roots.map((r) => r.url),
        requiredScopes: [],
        enableAutoStart: true,
        enableNotifications: true,
      },
      null,
      2,
    ),
  );
  const cm = new ConfigManager(configPath);
  await cm.load();
  const snapSvc = new SnapshotService(store, cm, scanner);
  const snap = snapSvc.generate();
  fs.writeFileSync(
    path.join(data, '_index.generated.json'),
    `${JSON.stringify(snap, null, 2)}\n`,
  );

  const absPaths = snap.nodes.filter(
    (n) =>
      n.local_path &&
      (n.local_path.startsWith('/') || /^[A-Za-z]:/.test(n.local_path)),
  );
  const readmeTitles = snap.nodes.filter((n) => n.title === 'README');
  const all = store.getAllDocuments();
  const placeholders = all.filter(
    (d) => d.status === 'placeholder' || d.cloudMatch === 'restricted',
  );
  const withRel = all.filter((d) => d.localRelPath);

  const summary = {
    scanIndexed: scan.indexed,
    applyApplied: apply.applied,
    applyOp: apply.operationId,
    nodes: snap.nodes.length,
    absoluteLocalPaths: absPaths.length,
    literalReadmeTitles: readmeTitles.length,
    snapshotOrphans: snap.orphan_files.length,
    placeholderRows: placeholders.length,
    relPathCount: withRel.length,
    gate2Pass:
      absPaths.length === 0 &&
      readmeTitles.length === 0 &&
      placeholders.length >= 1 &&
      withRel.length > 0,
  };
  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(data, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  if (!summary.gate2Pass) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
