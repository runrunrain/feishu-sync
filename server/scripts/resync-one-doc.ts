/**
 * 单文档精准重同步脚本（2026-09-10 事故善后专用）。
 *
 * 背景：docx 内嵌 <sheet> 标签全量导出 bug（28 标签 × 30 子表 = 840 段）
 * + execFile 默认 1MB maxBuffer 导致「csv-get stdout maxBuffer length
 * exceeded」死循环，`（思路）部队初始化思路-300` 卡在 pending_modified、
 * synced 基线永不推进。修复代码后用本脚本对该文档重跑一次正式 apply
 * 同步（与 sync-latest.ts 相同的依赖构造契约：只读 config.json、不调
 * ConfigManager.load、LocalMapStore additive 迁移幂等）。
 *
 * 用法：
 *   npx tsx scripts/resync-one-doc.ts <objToken> [--dry-run]
 *
 * 不做检测（changeDetector），直接按 DB 中该文档的 observed 基线构造
 * ChangedDocument；apply 成功后 engine 自行推进 synced 基线。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { LayoutReconstructor } from '../src/modules/layout-reconstructor.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import type { ChangedDocument, Config } from '../src/types/index.js';
import { REQUIRED_SCOPES } from './sync-latest.js';

function usage(): string {
  return [
    '用法: npx tsx scripts/resync-one-doc.ts <objToken> [--dry-run]',
    '',
    '  <objToken>   documents 表 obj_token，必须存在且 observed > synced',
    '  --dry-run    只出计划不写盘（缺省为 apply+APPLY 正式写盘）',
  ].join('\n');
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const token = argv.find((arg) => !arg.startsWith('--') && arg.length > 0);
  if (!token) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const configDir = process.env.FEISHU_SYNC_HOME || path.join(os.homedir(), '.feishu-sync');
  const configPath = path.join(configDir, 'config.json');
  const dbPath = path.join(configDir, 'feishu-sync.db');
  // 只读现有配置（与 sync-latest 默认契约一致），缺 operationManifestDir
  // 时补脚本级缺省——真实 config.json 已有该字段，这里仅防御。
  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<Config>;
  const config: Config = {
    ...rawConfig,
    operationManifestDir:
      rawConfig.operationManifestDir || path.join(configDir, 'operations'),
  } as Config;

  const store = new LocalMapStore(dbPath);
  store.initialize();
  const record = store.getDocumentByObjToken(token);
  if (!record) {
    console.error(`[resync-one] 未找到文档: ${token}`);
    process.exitCode = 1;
    return;
  }
  if (!record.localMdPath || !record.observedObjEditTime) {
    console.error(`[resync-one] 文档缺少 localMdPath/observed 基线，无法构造变更输入`);
    process.exitCode = 1;
    return;
  }
  console.info(
    `[resync-one] ${record.title} observed=${record.observedObjEditTime} ` +
      `synced=${record.syncedObjEditTime ?? 'null'} mode=${dryRun ? 'dry-run' : 'APPLY'}`,
  );

  const lark = new LarkCliClient({
    requiredScopes: (config.requiredScopes as string[]) || REQUIRED_SCOPES,
    timeout: 120_000,
  });
  const auth = await lark.checkAuthReady();
  if (!auth.ready) {
    throw new Error(`鉴权未就绪: ${auth.error}`);
  }

  const engine = new SyncEngine({
    larkCliClient: lark,
    localMapStore: store,
    config,
    layoutReconstructor: new LayoutReconstructor(),
  });

  const doc: ChangedDocument = {
    objToken: record.objToken,
    objType: record.objType,
    title: record.title,
    wikiNodeToken: record.wikiNodeToken ?? undefined,
    watchedRootId: record.watchedRootId ?? undefined,
    changeType: 'modified',
    cloudModifiedTime: new Date(record.observedObjEditTime * 1000).toISOString(),
    localSyncedTime: record.lastSyncedModifyTime ?? null,
    localMdPath: record.localMdPath,
    observedObjEditTime: record.observedObjEditTime,
  } as ChangedDocument;

  const result = await engine.syncDocuments([doc], {
    enableLLM: false,
    fullSync: false,
    apply: !dryRun,
    confirmation: dryRun ? undefined : 'APPLY',
  });

  console.info(
    `[resync-one] success=${result.success} synced=${result.syncedDocuments.length} ` +
      `failed=${result.failedDocuments.length}`,
  );
  for (const synced of result.syncedDocuments) {
    console.info(
      `  OK ${synced.title}: size=${synced.size} sheets=${synced.sheetsCount} images=${synced.imagesCount}`,
    );
  }
  for (const failed of result.failedDocuments) {
    console.error(`  FAIL ${failed.title}: ${failed.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('resync-one-doc.ts')) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('[resync-one] fatal:', error);
    process.exitCode = 1;
  });
}
