/**
 * CLI 单文件打包共享入口（S9，设计 kb-agent-upgrade §6.1/U12）
 *
 * src/cli/main.ts → dist/cli/feishu-sync-cli.cjs（platform=node、
 * format=cjs、target node20、单文件、零原生依赖）。与 lib/mcp-bundle.mjs
 * 同构：build 脚本与 vitest 按需打包共用本入口，防配置漂移。
 *
 * 注意：入口不得使用顶层 await / import.meta（cjs 格式）；CLI 源码只用
 * Node 内建模块（node:http/fs/path/os），命令面从 ops/command-table.ts
 * 静态并入（共表，U14）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = path.join(serverRoot, 'src', 'cli', 'main.ts');
export const cliOutDefault = path.join(serverRoot, 'dist', 'cli', 'feishu-sync-cli.cjs');

export async function bundleCli(outfile = cliOutDefault) {
  const result = await build({
    entryPoints: [cliEntry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  if (result.errors.length > 0) {
    throw new Error(`esbuild 打包失败: ${result.errors.map((error) => error.text).join('; ')}`);
  }
  return { outfile, size: fs.statSync(outfile).size };
}
