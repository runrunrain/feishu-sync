/**
 * feishu-sync CLI 进程入口（S9，设计 kb-agent-upgrade §6.1/U12）
 *
 * esbuild 单文件打包为 server/dist/cli/feishu-sync-cli.cjs（零原生依赖，
 * Node ≥20；构建入口 scripts/lib/cli-bundle.mjs）。shim（应用设置中一键
 * 生成）以 `node <本文件> …`（开发）或
 * `ELECTRON_RUN_AS_NODE=1 <Electron> <本文件> …`（打包版）方式调起。
 *
 * 本文件只做进程编排；参数解析、HTTP 与输出契约见同目录其余模块。
 */

import { runCli } from './cli-app.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    // 只设 exitCode 让事件循环自然退出：显式 process.exit 可能截断管道
    // stdout（Node 对 pipe 的写回是异步的）。
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`CLI 内部错误：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
