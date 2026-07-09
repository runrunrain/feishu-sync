#!/usr/bin/env node
/**
 * rebuild-index.cjs — 一次性索引重建脚本（Phase B 步骤 4）
 *
 * 目的：迁移文件头后，触发 IndexScanner.scanKnowledgeBase 重扫所有 .md，
 *       按新 yaml_html 头重建归属（含 obj_token/title/local_path），并
 *       regenerate _index.json 快照。等价于 POST /api/index/rebuild
 *       （mapping.ts:242-304），但不启动 HTTP server。
 *
 * 依赖：server/dist 已编译。better-sqlite3 ABI 需匹配当前 node 运行时
 *       （与 migrate-headers.cjs 同一执行路径）。
 *
 * larkCliClient stub 说明：IndexScanner.indexFile（index-scanner.ts:211-227）
 *       仅在「obj_token 缺失但有 original_link」时才调 larkCliClient.getNode。
 *       迁移后的 .md 文件都有 obj_token（红线 7 断言），orphan 文件无
 *       obj_token/original_link（parseMetadata 返回 null 即跳过），故
 *       rebuild 全程不会真正调用飞书。传 stub 仅满足类型契约。
 *
 * 用法：node scripts/rebuild-index.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.feishu-sync', 'config.json');
const DB_PATH = path.join(HOME, '.feishu-sync', 'feishu-sync.db');
const SERVER_ROOT = path.join(__dirname, '..', 'server');
const DIST = (name) => path.join(SERVER_ROOT, 'dist', 'modules', name + '.js');

async function loadModules() {
  for (const m of ['config-manager', 'local-map-store', 'index-scanner', 'snapshot-service']) {
    if (!fs.existsSync(DIST(m))) {
      throw new Error(`找不到 server 编译产物: ${DIST(m)}\n请先运行 \`npm run build --prefix server\``);
    }
  }
  const cfg = await import(pathToFileURL(DIST('config-manager')).href);
  const store = await import(pathToFileURL(DIST('local-map-store')).href);
  const scanner = await import(pathToFileURL(DIST('index-scanner')).href);
  const snap = await import(pathToFileURL(DIST('snapshot-service')).href);
  return {
    ConfigManager: cfg.ConfigManager,
    LocalMapStore: store.LocalMapStore,
    IndexScanner: scanner.IndexScanner,
    SnapshotService: snap.SnapshotService,
  };
}

// larkCliClient stub：满足类型契约，真正调用时显式抛错（rebuild 全程不应触达）。
const LARK_STUB = {
  async getNode() {
    throw new Error('rebuild-index.cjs stub: larkCliClient.getNode 不应在 rebuild 期间被调用（说明存在缺 obj_token 但有 original_link 的文件，需先完成头迁移）');
  },
};

async function main() {
  console.log('========================================');
  console.log(' rebuild-index.cjs');
  console.log('========================================');

  if (!fs.existsSync(DB_PATH)) {
    console.error('[fatal] SQLite 数据库不存在: ' + DB_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('[fatal] config.json 不存在: ' + CONFIG_PATH);
    process.exit(1);
  }

  const { ConfigManager, LocalMapStore, IndexScanner, SnapshotService } = await loadModules();

  console.info('[info] 初始化 ConfigManager');
  const configManager = new ConfigManager(CONFIG_PATH);
  await configManager.load();
  const config = configManager.getConfig();
  if (!config || !config.knowledgeBaseRoot) {
    console.error('[fatal] config 缺少 knowledgeBaseRoot');
    process.exit(1);
  }
  const kbRoot = config.knowledgeBaseRoot;
  console.info('[info] kbRoot = ' + kbRoot);

  console.info('[info] 初始化 LocalMapStore');
  const localMapStore = new LocalMapStore(DB_PATH);
  if (typeof localMapStore.initialize === 'function') {
    localMapStore.initialize();
  }

  console.info('[info] 初始化 IndexScanner（larkCliClient=stub）');
  const indexScanner = new IndexScanner({
    localMapStore,
    larkCliClient: LARK_STUB,
    config,
  });

  console.info('[info] 执行 scanKnowledgeBase ...');
  const scanResult = await indexScanner.scanKnowledgeBase(kbRoot);
  console.log('--- scan 结果 ---');
  console.log('  scanned : ' + scanResult.scanned);
  console.log('  indexed : ' + scanResult.indexed);
  console.log('  skipped : ' + scanResult.skipped);
  console.log('  failed  : ' + scanResult.failed);
  if (scanResult.errors && scanResult.errors.length > 0) {
    console.log('  errors:');
    for (const e of scanResult.errors) {
      console.log('    ' + e.file + ' -> ' + e.error);
    }
  }

  console.info('[info] 初始化 SnapshotService 并 regenerate _index.json ...');
  const snapshotService = new SnapshotService(localMapStore, configManager, indexScanner);
  // generate 同步或异步均兜底
  await Promise.resolve(snapshotService.generate());

  const indexPath = path.join(kbRoot, '_index.json');
  console.info('[done] _index.json regenerated at ' + indexPath);
  console.info('       generated_at mtime = ' + fs.statSync(indexPath).mtime.toISOString());

  // 失败数 > 0 仍返回 1，便于上游感知
  process.exit(scanResult.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[fatal] 未捕获错误:', e);
  process.exit(1);
});
