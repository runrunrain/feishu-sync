/**
 * 一次性同步脚本: Troop / Unit / Cell 三个 sheet 文档
 *
 * Task: feishu-sync-troop-sync-20260701
 *
 * 把 3 个飞书 sheet 文档同步到本地（云端覆盖本地）：
 *   - 200-04-实体部队(Troop)数据结构
 *   - 200-041-作战单元(Unit)数据结构
 *   - 200-041-模型（Cell）数据结构
 *
 * 关键点：
 *   - 直接 import 源码 .ts（tsx 跑，不依赖 dist）
 *   - 复用 verify-m2a-sync.ts 的依赖初始化模式
 *   - 复用 sync.ts 第 46-63 行的 LayoutReconstructor/ContentAdapter 注入
 *   - enableLLM=true（bigmodel GLM，主上已确认 2 分钟约束例外）
 *   - localMdPath 写绝对路径（已知目录已存在）
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// 直接 import 源码 .ts（tsx 支持 .js 映射到 .ts）
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { LayoutReconstructor } from '../src/modules/layout-reconstructor.js';
import { ContentAdapter } from '../src/modules/content-adapter.js';
import { ContentBackendRegistry } from '../src/modules/content-backend-registry.js';
import type { ChannelConfig } from '../src/modules/content-backend.js';
import type { ChangedDocument } from '../src/types/index.js';

// ===== 3 个目标文档（Leader 探索已确认标识）=====
const KNOWLEDGE_BASE_ROOT = 'D:/WorkPace/公司知识库/飞书同步知识库';
const SHEET_DIR = path.join(
  KNOWLEDGE_BASE_ROOT,
  '策划 - Designer',
  '200-系统框架&数据结构',
  '200-04-【概述】数据化战斗（R）',
  '200-04-实体部队(Troop)数据结构'
);

const TARGET_DOCS: Array<{
  objToken: string;
  title: string;
  localMdPath: string;
}> = [
  {
    objToken: 'RkL1soZBKhIpPjtdV7mclkRWnlf',
    title: '200-04-实体部队(Troop)数据结构',
    localMdPath: path.join(SHEET_DIR, '200-04-实体部队(Troop)数据结构.md'),
  },
  {
    objToken: 'DqjvsySS4hsLwStEk73cL6VZnzb',
    title: '200-041-作战单元(Unit)数据结构',
    localMdPath: path.join(SHEET_DIR, '200-041-作战单元(Unit)数据结构.md'),
  },
  {
    objToken: 'Y6QOskVU3hk3aotTvZWcIUxpnWg',
    title: '200-041-模型（Cell）数据结构',
    localMdPath: path.join(SHEET_DIR, '200-041-模型（Cell）数据结构.md'),
  },
];

// 预期每文档子表数（来自 Contract）
const EXPECTED_SHEETS: Record<string, number> = {
  'RkL1soZBKhIpPjtdV7mclkRWnlf': 8, // Troop
  'DqjvsySS4hsLwStEk73cL6VZnzb': 7, // Unit
  'Y6QOskVU3hk3aotTvZWcIUxpnWg': 6, // Cell
};

async function main() {
  console.info('[sync-troop-unit-cell] 开始同步 3 个 sheet 文档...');
  console.info(`[sync-troop-unit-cell] 工作目录: ${process.cwd()}`);

  // ===== 1. 初始化依赖（参考 verify-m2a-sync.ts）=====
  const dbPath = path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db');
  const localMapStore = new LocalMapStore(dbPath);
  localMapStore.initialize();
  console.info(`[sync-troop-unit-cell] DB: ${dbPath}`);

  const configPath = path.join(os.homedir(), '.feishu-sync', 'config.json');
  const configManager = new ConfigManager(configPath);
  const config = await configManager.load();
  console.info(`[sync-troop-unit-cell] config.knowledgeBaseRoot: ${config.knowledgeBaseRoot}`);
  console.info(
    `[sync-troop-unit-cell] config.llm.primaryChannel: ${config.llm.primaryChannel}, ` +
    `fallbackOnFailure: ${config.llm.fallbackOnFailure}, timeoutMs: ${config.llm.timeoutMs}`
  );

  const larkCliClient = new LarkCliClient({
    requiredScopes: config.requiredScopes ?? [
      'wiki:node:retrieve',
      'wiki:space:retrieve',
      'docs:document.content:read',
      'sheets:spreadsheet:read',
      'docx:document:readonly',
      'drive:drive.metadata:readonly',
    ],
    timeout: 30000,
  });

  // ===== 2. 注入 LayoutReconstructor + ContentAdapter（参考 sync.ts 46-63 行）=====
  const layoutReconstructor = new LayoutReconstructor();
  const channelConfig: ChannelConfig = {
    llm: config.llm,
    claudeCli: config.llm.claudeCli,
    opencode: config.llm.opencode,
    primaryChannel: config.llm.primaryChannel,
    fallbackOnFailure: config.llm.fallbackOnFailure,
  };
  const registry = new ContentBackendRegistry(channelConfig);
  const contentAdapter = new ContentAdapter(registry);

  const syncEngine = new SyncEngine({
    larkCliClient,
    localMapStore,
    config,
    layoutReconstructor,
    contentAdapter,
  });
  console.info('[sync-troop-unit-cell] SyncEngine 已注入 LayoutReconstructor + ContentAdapter');

  // ===== 3. 构造 ChangedDocument[] =====
  const nowIso = new Date().toISOString();
  const docs: ChangedDocument[] = TARGET_DOCS.map((d) => {
    // ChangedDocument 形状参考 verify-m2a-sync.ts 与 sync.ts 用法
    return {
      objToken: d.objToken,
      objType: 'sheet',
      title: d.title,
      changeType: 'modified',
      cloudModifiedTime: nowIso,
      localSyncedTime: null,
      localMdPath: d.localMdPath,
    } as unknown as ChangedDocument;
  });

  // 预检查：所有 localMdPath 所在目录存在
  for (const d of TARGET_DOCS) {
    const dir = path.dirname(d.localMdPath);
    if (!fs.existsSync(dir)) {
      throw new Error(`目录不存在: ${dir}`);
    }
  }
  console.info(`[sync-troop-unit-cell] 全部 localMdPath 父目录已确认存在`);

  // ===== 4. 执行同步（enableLLM=true）=====
  console.info('\n[sync-troop-unit-cell] 调用 syncDocuments，enableLLM=true ...');
  const syncResult = await syncEngine.syncDocuments(docs, {
    enableLLM: true,
    fullSync: false,
  });

  // ===== 5. 输出结果 =====
  console.info('\n=== 同步结果汇总 ===');
  console.info(`success: ${syncResult.success}`);
  console.info(`synced: ${syncResult.syncedDocuments.length}, failed: ${syncResult.failedDocuments.length}`);
  console.info(`duration: ${syncResult.duration}ms`);

  console.info('\n=== Synced Documents ===');
  for (const s of syncResult.syncedDocuments) {
    const expected = EXPECTED_SHEETS[s.objToken] ?? '?';
    console.info('---');
    console.info(`  title: ${s.title}`);
    console.info(`  objToken: ${s.objToken}`);
    console.info(`  localMdPath: ${s.localMdPath}`);
    console.info(`  size: ${s.size} bytes`);
    console.info(`  sheetsCount: ${s.sheetsCount} (expected ${expected})`);
    console.info(`  imagesCount: ${s.imagesCount}`);
    console.info(`  attachmentsCount: ${s.attachmentsCount}`);
  }

  if (syncResult.failedDocuments.length > 0) {
    console.info('\n=== Failed Documents ===');
    for (const f of syncResult.failedDocuments) {
      console.info('---');
      console.info(`  title: ${f.title}`);
      console.info(`  objToken: ${f.objToken}`);
      console.info(`  error: ${f.error}`);
      console.info(`  retryable: ${f.retryable}`);
    }
  }

  console.info('\n[sync-troop-unit-cell] 完成。');
}

main().catch((error) => {
  console.error('[sync-troop-unit-cell] 失败:', error);
  process.exit(1);
});
