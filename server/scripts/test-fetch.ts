/**
 * 测试 lark-cli docs +fetch 命令
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function main() {
  const objToken = 'ZJXPdr6siopkHmxTRo4c9NGqn85';

  const args = [
    'docs',
    '+fetch',
    '--api-version', 'v2',
    '--doc', objToken,
    '--doc-format', 'markdown',
    '--detail', 'simple',
  ];

  console.info('测试 lark-cli docs +fetch 命令');
  console.info(`objToken: ${objToken}`);

  try {
    const { stdout, stderr } = await execFileAsync('lark-cli.cmd', args, {
      timeout: 30000,
      encoding: 'utf-8',
      shell: true,
    });

    console.info('=== STDOUT ===');
    console.info(stdout);
    console.info('\n=== STDERR ===');
    console.info(stderr);

    // Parse JSON
    try {
      const json = JSON.parse(stdout);
      console.info('\n=== PARSED JSON ===');
      console.info(JSON.stringify(json, null, 2));
    } catch (error) {
      console.error('\nJSON 解析失败:', error);
    }
  } catch (error: any) {
    console.error('命令执行失败:', error);
  }
}

main().catch(console.error);