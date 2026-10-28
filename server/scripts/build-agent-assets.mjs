/**
 * server 构建资产复制 + MCP 单文件打包（F1）
 *
 * 1. 复制 agent 静态资产到 dist：prompts/*.md（内置文风规范与构建规则）、
 *    pi-extension/feishu-sync-agent.js（纯转发扩展）——tsc 不处理非 TS
 *    资产，运行时按 dist 路径装载（pi 扩展路径 / prompts 读取）。
 * 2. esbuild 打包 MCP：src/mcp/kb-mcp-server.ts → dist/mcp/kb-mcp.cjs
 *    （platform=node、format=cjs、单文件、无原生依赖；外部 Node ≥20 可
 *    直接运行，Electron RunAsNode 亦可）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleMcp } from './lib/mcp-bundle.mjs';
import { bundleCli } from './lib/cli-bundle.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(serverRoot, 'src');
const distRoot = path.join(serverRoot, 'dist');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      count += copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
      count += 1;
    }
  }
  return count;
}

// 1. agent 资产
const promptsSrc = path.join(srcRoot, 'agent', 'prompts');
const extensionSrc = path.join(srcRoot, 'agent', 'pi-extension');
if (!fs.existsSync(distRoot)) {
  console.error('[build-agent-assets] dist/ 不存在——先运行 tsc（npm run build）');
  process.exit(1);
}
const promptCount = copyDir(promptsSrc, path.join(distRoot, 'agent', 'prompts'));
const extensionCount = copyDir(extensionSrc, path.join(distRoot, 'agent', 'pi-extension'));
console.info(`[build-agent-assets] copied ${promptCount} prompt file(s), ${extensionCount} extension file(s)`);

// S6 任务编排：角色卡（server/src/agent/roles/*.md → dist/agent/roles）。
// RoleRegistry 从 dist 读取（开发态 tsx 回退 src）；缺目录时 0 张并告警。
const rolesSrc = path.join(srcRoot, 'agent', 'roles');
const roleCount = fs.existsSync(rolesSrc) ? copyDir(rolesSrc, path.join(distRoot, 'agent', 'roles')) : 0;
console.info(`[build-agent-assets] copied ${roleCount} role card(s)`);

// 2. MCP 单文件打包（共享入口，配置见 lib/mcp-bundle.mjs）
const { outfile, size } = await bundleMcp();
console.info(`[build-agent-assets] bundled ${path.basename(outfile)} (${(size / 1024).toFixed(1)} KB)`);

// 3. CLI 单文件打包（S9，设计 kb-agent-upgrade §6.1/U12；共享入口见
//    lib/cli-bundle.mjs）——产物 shim 与 Electron RunAsNode 均直接调起。
const cli = await bundleCli();
console.info(`[build-agent-assets] bundled ${path.basename(cli.outfile)} (${(cli.size / 1024).toFixed(1)} KB)`);
