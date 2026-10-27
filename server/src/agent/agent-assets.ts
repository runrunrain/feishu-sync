/**
 * Agent 静态资产定位（F1）
 *
 * prompts（内置文风规范/构建规则）与 pi 扩展随 server/dist 发布：
 *   - 开发/standalone：<server>/dist/agent/...（由 build-agent-assets.mjs 复制）
 *   - Electron 打包：app.asar.unpacked/server/dist/...（asarUnpack server/**）
 *
 * 本模块提供 dist 内资产根的可靠定位与内容读取；资产缺失时返回 null，
 * 由调用方降级（构建 prompt 无文风规范时仍可运行，但会记录警告）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** server/dist 根（本模块编译后位于 dist/agent/agent-assets.js）。 */
export function serverDistRoot(): string {
  // ConfigManager同时被打进Electron的CJS main；该分支没有import.meta.url。
  // main位于dist-electron/，生产server则在resources/app.asar.unpacked。
  if (typeof __dirname === 'string' && path.basename(__dirname) === 'dist-electron') {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const unpacked = resources ? path.join(resources, 'app.asar.unpacked', 'server', 'dist') : null;
    if (unpacked && fs.existsSync(unpacked)) return unpacked;
    return path.resolve(__dirname, '..', 'server', 'dist');
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function agentAssetsRoot(): string {
  return path.join(serverDistRoot(), 'agent');
}

/** pi 扩展绝对路径（真实文件系统；不存在返回 null）。 */
export function piExtensionPath(): string | null {
  const candidates = [
    path.join(agentAssetsRoot(), 'pi-extension', 'feishu-sync-agent.js'),
    // 开发态（tsx 直跑 src）：源码目录
    path.join(serverDistRoot(), '..', 'src', 'agent', 'pi-extension', 'feishu-sync-agent.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 读取内置 prompt 资产（构建规则 + 文风规范）。缺任一返回 null。 */
export function readAgentPromptAssets(): { buildRules: string; styleGuide: string } | null {
  const read = (relative: string): string | null => {
    const candidates = [
      path.join(agentAssetsRoot(), 'prompts', relative),
      path.join(serverDistRoot(), '..', 'src', 'agent', 'prompts', relative),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf-8');
      }
    }
    return null;
  };
  const buildRules = read('standard-kb-build.md');
  const styleGuide = read('standard-kb-style.md');
  if (!buildRules || !styleGuide) {
    console.warn('[agent-assets] prompt 资产缺失（构建将无文风规范）');
    return null;
  }
  return { buildRules, styleGuide };
}
