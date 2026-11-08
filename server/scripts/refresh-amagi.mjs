/** 以远端最新模式刷新检入冻结包（server/bundled/amagi-pi）。
 *
 * 用法：cd server && npm run amagi:refresh
 * 前置：先 `npm run build` 生成 dist（bundleAmagi 依赖 dist/agent/build-runtime/amagi-package.js）。
 * 行为：设 AMAGI_PI_LATEST=1 后调用 bundleAmagi —— 从远端默认分支 HEAD（或
 * AMAGI_PI_REPO/AMAGI_PI_REF/AMAGI_PI_TOKEN 指定的源）重打包并写回检入冻结包。
 * 校验（主版本 = 2、禁止降级低于检入版本、稳定 semver）见 lib/amagi-source.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(serverRoot, 'dist/agent/build-runtime/amagi-package.js'))) {
  console.error('[amagi-refresh] server/dist 缺失——先运行 npm run build 生成 dist（bundleAmagi 依赖 dist 内容哈希实现）');
  process.exit(1);
}

process.env.AMAGI_PI_LATEST = '1';
const { bundleAmagi } = await import('./lib/bundled-amagi.mjs');
const manifest = await bundleAmagi();
console.info(`[amagi-refresh] 检入冻结包已刷新：amagi-pi ${manifest.version} @ ${manifest.sourceCommit ? manifest.sourceCommit.slice(0, 8) : 'unknown'}`);
console.info('[amagi-refresh] 变更文件见 `git status server/bundled/amagi-pi`（manifest.json + package.zip），请随本次改动一并提交入库');
