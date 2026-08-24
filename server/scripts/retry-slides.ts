import path from 'node:path';
import os from 'node:os';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { ConfigManager } from '../src/modules/config-manager.js';

async function main() {
  const cm = new ConfigManager(path.join(os.homedir(), '.feishu-sync', 'config.json'));
  const config = await cm.load();
  config.knowledgeBaseRoot =
    '/Users/maorun/maorun-workpace/weixiao-database/飞书同步知识库';
  (config as any).operationManifestDir = path.join(
    os.homedir(),
    '.feishu-sync',
    'operations',
  );
  const store = new LocalMapStore(path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db'));
  store.initialize();
  const lark = new LarkCliClient({
    requiredScopes: config.requiredScopes,
    timeout: 120000,
  });
  const engine = new SyncEngine({
    larkCliClient: lark,
    localMapStore: store,
    config,
  });
  const objToken = 'FP0gs1xS1l26VhdrGNHc4ZFQnuf';
  const rec = store.getDocumentByObjToken(objToken);
  const r = await engine.syncDocuments(
    [
      {
        objToken,
        objType: 'slides',
        title: '【必读】我们的事业《万里同风》制作人阐述设计思路V.1.4',
        changeType: 'added',
        cloudModifiedTime: new Date().toISOString(),
        localSyncedTime: null,
        localMdPath: rec?.localMdPath ?? null,
        localRelPath: rec?.localRelPath ?? null,
        wikiNodeToken: rec?.wikiNodeToken ?? null,
        watchedRootId: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
        hasChild: true,
        observedObjEditTime: Date.now(),
      },
    ],
    {
      enableLLM: false,
      fullSync: false,
      apply: true,
      confirmation: 'APPLY',
    },
  );
  console.log(
    JSON.stringify(
      {
        success: r.success,
        synced: r.syncedDocuments,
        failed: r.failedDocuments,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
