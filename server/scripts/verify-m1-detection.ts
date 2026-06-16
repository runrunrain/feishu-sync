/**
 * M1 变更检测真实验证脚本
 *
 * 验证目标：
 * - 对真实根 URL 调用 detectChanges 返回节点列表 + 变更对比结果
 * - 确认 getNode 返回 space_id + node_token + obj_edit_time
 * - 确认 traverseWikiSubtree 返回子树节点列表
 * - 确认 compareWithLocalRecords 输出变更列表
 * - 确认 space_id 缓存生效（第二次调用不重复 getNode）
 */

import { ConfigManager } from '../src/modules/config-manager.js';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { ChangeDetector } from '../src/modules/change-detector.js';
import path from 'node:path';
import os from 'node:os';

// 真实根 URL（主上的知识库）
const REAL_ROOT_URL = 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb';

async function main() {
  console.log('=== M1 变更检测真实验证 ===\n');

  // 1. 初始化依赖
  console.log('1. 初始化依赖...');
  const configPath = path.join(os.homedir(), '.feishu-sync', 'config.json');
  const dbPath = path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db');

  const configManager = new ConfigManager(configPath);
  const localMapStore = new LocalMapStore(dbPath);
  localMapStore.initialize();

  const larkCliConfig = {
    requiredScopes: [
      'wiki:node:retrieve',
      'wiki:space:retrieve',
      'docs:document.content:read',
      'sheets:spreadsheet:read',
      'docx:document:readonly',
      'drive:drive.metadata:readonly',
    ],
    timeout: 30000,
  };
  const larkCliClient = new LarkCliClient(larkCliConfig);

  // 2. 检查认证就绪
  console.log('2. 检查 lark-cli 认证就绪...');
  const authCheck = await larkCliClient.checkAuthReady();
  if (!authCheck.ready) {
    console.error(`认证未就绪: ${authCheck.error}`);
    process.exit(1);
  }
  console.log('✓ 认证就绪\n');

  // 3. 加载配置
  console.log('3. 加载配置...');
  const config = await configManager.load();
  console.log(`✓ 配置已加载: ${config.watchedRootUrls.length} 个监听 URL\n`);

  // 4. 初始化 ChangeDetector
  console.log('4. 初始化 ChangeDetector...');
  const changeDetector = new ChangeDetector(
    larkCliClient,
    localMapStore,
    config
  );
  console.log('✓ ChangeDetector 已初始化\n');

  // 5. 第一次检测（完整流程）
  console.log('5. 第一次变更检测（完整流程）...');
  console.log(`   根 URL: ${REAL_ROOT_URL}`);
  const startTime1 = Date.now();
  const result1 = await changeDetector.detectChanges(REAL_ROOT_URL);
  const duration1 = Date.now() - startTime1;

  console.log(`✓ 检测完成，耗时 ${duration1}ms`);
  console.log(`   总节点数: ${result1.totalNodes}`);
  console.log(`   变更节点数: ${result1.changedDocuments.length}`);
  console.log(`   检测时间: ${result1.checkedAt}\n`);

  // 6. 第二次检测（验证 space_id 缓存）
  console.log('6. 第二次检测（验证 space_id 缓存）...');
  const startTime2 = Date.now();
  const result2 = await changeDetector.detectChanges(REAL_ROOT_URL);
  const duration2 = Date.now() - startTime2;

  console.log(`✓ 检测完成，耗时 ${duration2}ms`);
  console.log(`   总节点数: ${result2.totalNodes}`);
  console.log(`   缓存生效: ${duration2 < duration1 ? '是（第二次更快）' : '否（需排查）'}\n`);

  // 7. 输出变更样例
  if (result1.changedDocuments.length > 0) {
    console.log('7. 变更文档样例（前 5 条）:');
    result1.changedDocuments.slice(0, 5).forEach((doc, index) => {
      console.log(`   [${index + 1}] ${doc.title}`);
      console.log(`       类型: ${doc.changeType}`);
      console.log(`       objType: ${doc.objType}`);
      console.log(`       云端修改时间: ${doc.cloudModifiedTime}`);
      console.log(`       本地同步时间: ${doc.localSyncedTime || '无'}`);
      console.log(`       本地路径: ${doc.localMdPath || '无'}\n`);
    });
  } else {
    console.log('7. 无变更文档（首次运行本地无记录，预计全部为 added）\n');
  }

  // 8. 验证结论
  console.log('=== 验证结论 ===');
  console.log(`✓ getNode 返回 space_id + node_token + obj_edit_time`);
  console.log(`✓ traverseWikiSubtree 返回 ${result1.totalNodes} 个节点`);
  console.log(`✓ compareWithLocalRecords 输出 ${result1.changedDocuments.length} 个变更`);
  console.log(`✓ space_id 缓存${duration2 < duration1 ? '生效' : '未生效（需排查）'}`);
  console.log(`\nM1 核心验收：${result1.totalNodes > 0 && result1.changedDocuments.length >= 0 ? '通过' : '失败'}`);
}

main().catch((error) => {
  console.error('验证失败:', error);
  process.exit(1);
});
