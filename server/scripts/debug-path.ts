/**
 * 简化版同步验证脚本
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

async function main() {
  console.info('[调试] 路径生成测试');

  const tempSyncDir = path.join(os.tmpdir(), 'feishu-sync-test');
  console.info(`[调试] 临时同步目录: ${tempSyncDir}`);

  // 创建临时目录
  if (!fs.existsSync(tempSyncDir)) {
    fs.mkdirSync(tempSyncDir, { recursive: true });
  }

  const testTitle = '100-概念&游戏定位&美术风格&生产规划';
  const sanitizedTitle = testTitle.replace(/[<>:"/\\|?*]/g, '_');
  const localMdPath = path.join(tempSyncDir, `${sanitizedTitle}.md`);

  console.info(`[调试] 标题: ${testTitle}`);
  console.info(`[调试] 清洗后标题: ${sanitizedTitle}`);
  console.info(`[调试] 本地MD路径: ${localMdPath}`);
  console.info(`[调试] 目录部分: ${path.dirname(localMdPath)}`);

  // 检查路径是否存在
  console.info(`[调试] 临时目录存在: ${fs.existsSync(tempSyncDir)}`);
  console.info(`[调试] 本地MD父目录存在: ${fs.existsSync(path.dirname(localMdPath))}`);

  // 测试写入
  try {
    fs.writeFileSync(localMdPath, 'test content', 'utf-8');
    console.info(`[调试] ✓ 文件写入成功: ${localMdPath}`);

    const content = fs.readFileSync(localMdPath, 'utf-8');
    console.info(`[调试] ✓ 文件读取成功，内容长度: ${content.length}`);
  } catch (error) {
    console.error(`[调试] ✗ 文件操作失败:`, error);
  }
}

main().catch(console.error);