/**
 * 真实环境验证脚本：media-gap 检测（只读，不写知识库文件）。
 * - 用真实 config / DB / 知识库 / lark-cli 构造 ChangeDetector
 * - 跑一次 full detect，输出 changedDocuments 中的 mediaGap 项与常规变更项
 * 用法：npx tsx scripts/verify-media-gap.ts <watchedRootUrl>
 */
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { ChangeDetector } from '../src/modules/change-detector.js';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const rootUrl = process.argv[2];
  const full = process.argv.includes('--full');
  if (!rootUrl) {
    console.error('Usage: npx tsx scripts/verify-media-gap.ts <watchedRootUrl> [--full]');
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

  console.log(`[verify] root: ${rootUrl}`);
  console.log(`[verify] knowledgeBaseRoot: ${config.knowledgeBaseRoot}`);
  const result = await detector.detectChanges(rootUrl, {
    forceFresh: true,
    bypassCooldown: true,
    mediaGapScope: full ? 'full' : 'local-only',
  });

  console.log(`[verify] totalNodes=${result.totalNodes ?? 'n/a'} changed=${result.changed} errors=${result.errors ?? 'n/a'}`);
  const mediaGaps = result.changedDocuments.filter((d) => d.mediaGapReason);
  console.log(`\n=== media-gap pending (${mediaGaps.length}) ===`);
  for (const doc of mediaGaps) {
    console.log(
      `  [${doc.mediaGapReason}] ${doc.title} (${doc.objType} ${doc.objToken}) local=${doc.localRelPath ?? doc.localMdPath}`,
    );
  }
  const regular = result.changedDocuments.filter((d) => !d.mediaGapReason);
  console.log(`\n=== regular pending (${regular.length}) ===`);
  for (const doc of regular) {
    console.log(`  [${doc.changeType}] ${doc.title} (${doc.objType})`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
