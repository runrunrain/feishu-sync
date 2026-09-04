/**
 * 媒体欠账补齐脚本：检测 media-gap 并用 SyncEngine 补齐图片/白板。
 * 默认 dry-run；--apply 才写盘（原子提交）。
 * 用法：npx tsx scripts/repair-media-gaps.ts <watchedRootUrl> [--apply]
 */
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { ChangeDetector } from '../src/modules/change-detector.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { LayoutReconstructor } from '../src/modules/layout-reconstructor.js';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const rootUrl = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!rootUrl) {
    console.error('Usage: npx tsx scripts/repair-media-gaps.ts <watchedRootUrl> [--apply]');
    process.exit(1);
  }

  const configManager = new ConfigManager();
  const config = await configManager.load();
  const store = new LocalMapStore(
    path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db'),
  );
  store.initialize();
  const client = new LarkCliClient({ requiredScopes: [], timeout: 30_000 });

  const detector = new ChangeDetector(client, store, {
    knowledgeBaseRoot: config.knowledgeBaseRoot,
  });
  const result = await detector.detectChanges(rootUrl, {
    forceFresh: true,
    bypassCooldown: true,
    mediaGapScope: 'full',
  });
  const mediaGaps = result.changedDocuments.filter((d) => d.mediaGapReason);
  console.log(`[repair] detected ${mediaGaps.length} media-gap document(s)`);
  if (mediaGaps.length === 0) {
    console.log('[repair] nothing to do');
    process.exit(0);
  }

  const engine = new SyncEngine({
    larkCliClient: client,
    localMapStore: store,
    config,
    layoutReconstructor: new LayoutReconstructor(),
  });

  const syncResult = await engine.syncDocuments(mediaGaps, {
    apply,
    confirmation: apply ? 'APPLY' : undefined,
  });

  console.log(`[repair] mode=${syncResult.mode} success=${syncResult.success}`);
  console.log(`[repair] synced=${syncResult.syncedDocuments.length} failed=${syncResult.failedDocuments.length}`);
  for (const doc of syncResult.syncedDocuments) {
    console.log(`  ✓ ${doc.title} (images: ${doc.imagesCount}, sheets: ${doc.sheetsCount})`);
  }
  for (const doc of syncResult.failedDocuments) {
    console.log(`  ✗ ${doc.title}: ${doc.error} [${doc.reasonCode ?? 'unknown'}]`);
  }
  process.exit(syncResult.success ? 0 : 1);
}

main().catch((err) => {
  console.error('[repair] failed:', err);
  process.exit(1);
});
