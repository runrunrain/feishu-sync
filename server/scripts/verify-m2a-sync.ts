/**
 * M2-A 真实单文档同步验证脚本
 *
 * 验证 SyncEngine 核心功能：
 * 1. 获取真实 docx 内容（fetchDocumentContent）
 * 2. 下载图片到 images/（downloadImages）
 * 3. 写入本地 .md 文件（writeLocalMarkdown）
 * 4. 更新 SQLite 映射（updateLocalMap）
 *
 * 使用 M1 的 ChangeDetector 获取一篇真实 docx 进行同步
 */

import { ChangeDetector } from '../dist/modules/change-detector.js';
import { LarkCliClient } from '../dist/modules/lark-cli-client.js';
import { LocalMapStore } from '../dist/modules/local-map-store.js';
import { SyncEngine } from '../dist/modules/sync-engine.js';
import { ConfigManager } from '../dist/modules/config-manager.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

async function main() {
  console.info('[M2-A 验证] 开始真实单文档同步验证...');

  // 1. Initialize dependencies
  const dbPath = path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db');
  const localMapStore = new LocalMapStore(dbPath);
  localMapStore.initialize();

  const configPath = path.join(os.homedir(), '.feishu-sync', 'config.json');
  const configManager = new ConfigManager(configPath);
  const config = await configManager.load();

  const larkCliClient = new LarkCliClient({
    requiredScopes: [
      'wiki:node:retrieve',
      'wiki:space:retrieve',
      'docs:document.content:read',
      'sheets:spreadsheet:read',
      'docx:document:readonly',
      'drive:drive.metadata:readonly',
    ],
    timeout: 30000,
  });

  const changeDetector = new ChangeDetector(larkCliClient, localMapStore);

  // 注释：不要在这里创建 SyncEngine，将在使用测试配置后创建
  // const syncEngine = new SyncEngine({
  //   larkCliClient,
  //   localMapStore,
  //   config,
  // });

  // 2. Get a real docx from M1 detection
  const realRootUrl = 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb';
  console.info(`[M2-A 验证] 检测根 URL: ${realRootUrl}`);

  const detectionResult = await changeDetector.detectChanges(realRootUrl);
  console.info(`[M2-A 验证] 检测到 ${detectionResult.totalNodes} 个节点`);

  // Find a docx document
  const docxDocs = detectionResult.changedDocuments.filter(doc => doc.objType === 'docx');
  if (docxDocs.length === 0) {
    console.error('[M2-A 验证] 未找到 docx 文档');
    process.exit(1);
  }

  const selectedDoc = docxDocs[0];
  console.info(`[M2-A 验证] 选择同步文档: ${selectedDoc.title}`);
  console.info(`[M2-A 验证] objToken: ${selectedDoc.objToken}`);

  // 3. Create temporary sync directory
  const tempSyncDir = path.join(os.tmpdir(), 'feishu-sync-test');
  console.info(`[M2-A 验证] 临时同步目录: ${tempSyncDir}`);

  // Update config to use temp directory
  const testConfig = { ...config, knowledgeBaseRoot: tempSyncDir };

  // 4. Create SyncEngine with test config
  const syncEngine = new SyncEngine({
    larkCliClient,
    localMapStore,
    config: testConfig,
  });

  // 5. Execute synchronization
  console.info('[M2-A 验证] 开始同步...');
  const syncResult = await syncEngine.syncDocuments(
    [selectedDoc],
    { enableLLM: false, fullSync: false }
  );

  // 6. Verify results
  console.info('\n=== M2-A 验证结果 ===');
  console.info(`同步成功: ${syncResult.success}`);
  console.info(`同步文档数: ${syncResult.syncedDocuments.length}`);
  console.info(`失败文档数: ${syncResult.failedDocuments.length}`);
  console.info(`耗时: ${syncResult.duration}ms`);

  if (syncResult.syncedDocuments.length > 0) {
    const syncedDoc = syncResult.syncedDocuments[0];
    console.info('\n=== 同步文档详情 ===');
    console.info(`标题: ${syncedDoc.title}`);
    console.info(`本地路径: ${syncedDoc.localMdPath}`);
    console.info(`内容大小: ${syncedDoc.size} bytes`);
    console.info(`图片数: ${syncedDoc.imagesCount}`);
    console.info(`附件数: ${syncedDoc.attachmentsCount}`);
    console.info(`表格数: ${syncedDoc.sheetsCount}`);

    // 7. Verify SQLite record
    const dbRecord = localMapStore.getDocumentByObjToken(selectedDoc.objToken);
    if (dbRecord) {
      console.info('\n=== SQLite 记录验证 ===');
      console.info(`objToken: ${dbRecord.objToken}`);
      console.info(`title: ${dbRecord.title}`);
      console.info(`localMdPath: ${dbRecord.localMdPath}`);
      console.info(`status: ${dbRecord.status}`);
      console.info(`lastSyncedModifyTime: ${dbRecord.lastSyncedModifyTime}`);
      console.info(`lastSyncedAt: ${dbRecord.lastSyncedAt}`);
    } else {
      console.error('[M2-A 验证] 未找到 SQLite 记录');
    }

    // 8. Verify file existence
    if (fs.existsSync(syncedDoc.localMdPath)) {
      console.info('\n=== 文件系统验证 ===');
      console.info(`✓ 文件存在: ${syncedDoc.localMdPath}`);

      const content = fs.readFileSync(syncedDoc.localMdPath, 'utf-8');
      console.info(`✓ 文件内容长度: ${content.length} bytes`);

      // Check for HTML comment header
      if (content.includes('<!--\n来源: 飞书知识库')) {
        console.info('✓ HTML 注释头正确');
      } else {
        console.error('✗ HTML 注释头缺失');
      }

      // Check for images directory
      const imagesDir = path.join(path.dirname(syncedDoc.localMdPath), 'images');
      if (fs.existsSync(imagesDir)) {
        const imageFiles = fs.readdirSync(imagesDir);
        console.info(`✓ images 目录存在，包含 ${imageFiles.length} 个文件`);
      } else {
        console.info('✓ images 目录不存在（文档可能无图片）');
      }
    } else {
      console.error(`✗ 文件不存在: ${syncedDoc.localMdPath}`);
    }
  }

  if (syncResult.failedDocuments.length > 0) {
    console.info('\n=== 失败文档 ===');
    syncResult.failedDocuments.forEach((doc, index) => {
      console.info(`[${index + 1}] ${doc.title}`);
      console.info(`    错误: ${doc.error}`);
      console.info(`    可重试: ${doc.retryable}`);
    });
  }

  console.info('\n=== 验证完成 ===');
  console.info(`临时目录: ${tempSyncDir}`);
  console.info('可保留作证据，或手动清理');
}

main().catch((error) => {
  console.error('[M2-A 验证] 失败:', error);
  process.exit(1);
});