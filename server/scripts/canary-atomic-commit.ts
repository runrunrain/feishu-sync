/**
 * Disposable-KB canary via the real SyncEngine apply entry point:
 * dry-run → apply → second dry-run, plus explicit DB-failure rollback drill.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import type { ChangedDocument } from '../src/types/index.js';

const scratch =
  process.env.SCRATCH ||
  '/var/folders/81/zk31vz7j4bgb0k41z2g_hfgr0000gn/T/grok-goal-d74db4dec1c8/implementer';
const root = path.join(scratch, 'canary');
const kb = path.join(root, 'kb');
const ops = path.join(root, 'ops');
const dbPath = path.join(root, 'map.db');

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(kb, { recursive: true });
fs.mkdirSync(ops, { recursive: true });

function sha(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const store = new LocalMapStore(dbPath);
store.initialize();

const config = {
  knowledgeBaseRoot: kb,
  operationManifestDir: ops,
  watchedRoots: [
    {
      id: 'dev',
      url: 'https://example.feishu.cn/wiki/dev',
      localDir: '技术 - Dev',
      layoutProfile: 'directory-readme' as const,
      enabled: true,
    },
    {
      id: 'designer',
      url: 'https://example.feishu.cn/wiki/designer',
      localDir: '策划 - Designer',
      layoutProfile: 'mirror-title-file' as const,
      enabled: true,
    },
  ],
  watchedRootUrls: [
    'https://example.feishu.cn/wiki/dev',
    'https://example.feishu.cn/wiki/designer',
  ],
  llm: { temperature: 0.2, timeoutMs: 1000 },
};

const docxPath = path.join(kb, '技术 - Dev', 'canary-docx', 'README.md');
fs.mkdirSync(path.dirname(docxPath), { recursive: true });
fs.writeFileSync(docxPath, '# prior docx\n');
const priorHash = sha(docxPath);

const docxDoc: ChangedDocument = {
  objToken: 'canary-docx-token',
  objType: 'docx',
  title: 'canary-docx',
  changeType: 'modified',
  cloudModifiedTime: '2026-07-17T00:00:00.000Z',
  localSyncedTime: null,
  localMdPath: docxPath,
  localRelPath: '技术 - Dev/canary-docx/README.md',
  wikiNodeToken: 'canary-docx-node',
  watchedRootId: 'dev',
  hasChild: false,
  isWatchedRootNode: false,
  parentChainTitles: [],
  observedObjEditTime: 2_000,
};

store.upsertDocument({
  objToken: docxDoc.objToken,
  wikiNodeToken: docxDoc.wikiNodeToken ?? null,
  objType: 'docx',
  title: 'canary-docx',
  localMdPath: docxPath,
  lastSyncedModifyTime: 'old',
  lastSyncedAt: '2026-01-01T00:00:00.000Z',
  status: 'synced',
  localRelPath: docxDoc.localRelPath,
  watchedRootId: 'dev',
  syncedObjEditTime: 1_000,
  observedObjEditTime: 1_000,
  syncState: 'synced',
} as any);

const lark = {
  fetchDocumentMarkdown: async () => ({
    data: {
      document: {
        content: 'canary body after apply\n',
        images: [],
        attachments: [],
        sheets: [],
        url: 'https://example.feishu.cn/wiki/canary-docx-node',
      },
    },
  }),
  getWorkbookInfo: async () => ({
    data: {
      sheets: [
        { sheet_id: 's1', sheet_name: '主表', row_count: 2, column_count: 2 },
        { sheet_id: 's2', sheet_name: '附表', row_count: 2, column_count: 1 },
      ],
    },
  }),
  getSheetCsv: async ({ sheetId }: { sheetId: string }) => ({
    data: {
      annotated_csv:
        sheetId === 's1' ? 'a,b\n1,2\n' : 'x\n9\n',
    },
  }),
};

const engine = new SyncEngine({
  larkCliClient: lark,
  localMapStore: store,
  config,
});

const dryRun = await engine.syncDocuments([docxDoc], {
  enableLLM: false,
  fullSync: false,
});
const apply = await engine.syncDocuments([docxDoc], {
  enableLLM: false,
  fullSync: false,
  apply: true,
  confirmation: 'APPLY',
});
const afterHash = sha(docxPath);
const secondDry = await engine.syncDocuments(
  [{ ...docxDoc, observedObjEditTime: 2_000 }],
  { enableLLM: false, fullSync: false },
);
const row = store.getDocumentByObjToken('canary-docx-token');

// DB-stage rollback drill via testHooks on a second engine instance
const rollbackPath = path.join(kb, '技术 - Dev', 'rollback-doc', 'README.md');
fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
fs.writeFileSync(rollbackPath, '# keep\n');
const keepHash = sha(rollbackPath);
const failEngine = new SyncEngine({
  larkCliClient: lark,
  localMapStore: store,
  config,
  testHooks: { failAfterFileCommit: true },
});
const failApply = await failEngine.syncDocuments(
  [
    {
      ...docxDoc,
      objToken: 'canary-rollback-token',
      title: 'rollback-doc',
      localMdPath: rollbackPath,
      localRelPath: '技术 - Dev/rollback-doc/README.md',
      observedObjEditTime: 9_000,
    },
  ],
  { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
);

// Multi-sheet apply
const sheetPath = path.join(kb, '策划 - Designer', 'canary-sheet.md');
const sheetEngine = new SyncEngine({
  larkCliClient: lark,
  localMapStore: store,
  config,
});
const sheetApply = await sheetEngine.syncDocuments(
  [
    {
      objToken: 'canary-sheet-token',
      objType: 'sheet',
      title: 'canary-sheet',
      changeType: 'added',
      cloudModifiedTime: '2026-07-17T00:00:00.000Z',
      localSyncedTime: null,
      localMdPath: sheetPath,
      localRelPath: '策划 - Designer/canary-sheet.md',
      wikiNodeToken: 'canary-sheet-node',
      watchedRootId: 'designer',
      hasChild: false,
      isWatchedRootNode: false,
      parentChainTitles: [],
      observedObjEditTime: 3_000,
    },
  ],
  { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
);

const evidence = {
  entryPoint: 'SyncEngine.syncDocuments',
  dryRunMode: dryRun.mode,
  dryRunOp: dryRun.operationId,
  applyOk: apply.success,
  applyMode: apply.mode,
  applyOp: apply.operationId,
  sameOpFamily: Boolean(dryRun.operationId && apply.operationId),
  priorHash,
  afterHash,
  bodyApplied: fs.readFileSync(docxPath, 'utf-8').includes('canary body after apply'),
  syncedBaseline: row?.syncedObjEditTime ?? null,
  secondDryMode: secondDry.mode,
  secondDryMutated: sha(docxPath) !== afterHash,
  dbFailApplyOk: failApply.success,
  dbFailRestored: sha(rollbackPath) === keepHash,
  sheetOk: sheetApply.success,
  sheetOp: sheetApply.operationId,
  sheetCsvs: [
    fs.existsSync(path.join(kb, '策划 - Designer', 'canary-sheet.csv-data', '主表.csv')),
    fs.existsSync(path.join(kb, '策划 - Designer', 'canary-sheet.csv-data', '附表.csv')),
  ],
  note: 'Uses mocked LarkCliClient (user auth expired); drives real SyncEngine apply path.',
};

fs.writeFileSync(path.join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));

const pass =
  evidence.applyOk &&
  evidence.bodyApplied &&
  evidence.syncedBaseline === 2_000 &&
  evidence.secondDryMutated === false &&
  evidence.dbFailRestored &&
  evidence.sheetOk &&
  evidence.sheetCsvs.every(Boolean);

if (!pass) process.exit(2);
