/**
 * MCP 单文件打包共享入口（build 脚本与 vitest 按需打包共用，防配置漂移）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mcpEntry = path.join(serverRoot, 'src', 'mcp', 'kb-mcp-server.ts');
export const mcpOutDefault = path.join(serverRoot, 'dist', 'mcp', 'kb-mcp.cjs');

/**
 * 打包 kb-mcp-server.ts → 单文件 CJS（platform=node、target node20、
 * 无 external——SDK 纯 JS 全量打入，产物可直接被外部 Node ≥20 运行）。
 */
export async function bundleMcp(outfile = mcpOutDefault) {
  return bundleReadOnlyMcp(mcpEntry, outfile);
}

export const gatewayOutDefault = path.join(serverRoot, 'dist', 'mcp', 'kb-mcp-gateway.cjs');
export async function bundleGateway(outfile = gatewayOutDefault) {
  return bundleReadOnlyMcp(path.join(serverRoot, 'src', 'mcp', 'kb-mcp-gateway.ts'), outfile);
}

async function bundleReadOnlyMcp(entry, outfile) {
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    metafile: true,
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
  const code = fs.readFileSync(outfile, 'utf8');
  if (Object.keys(result.metafile.inputs).some((input) => /better-sqlite3|\.node$/.test(input))
    || /better-sqlite3|\.node["'`]/.test(code)) {
    throw new Error('只读 MCP bundle 不得包含原生模块引用');
  }
  return { outfile, size: fs.statSync(outfile).size };
}
