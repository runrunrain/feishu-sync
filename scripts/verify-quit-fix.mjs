/**
 * 退出卡死修复验证脚本（基于构建产物 server/dist）。
 *
 * 场景：客户端持有 keep-alive 空闲连接（等价于渲染进程 30s 轮询维持的
 * 连接），此时调用 started.close()。修复前 server.close() 的回调要等连
 * 接自然超时断开才触发，退出流程被拖死；修复后应立即踢掉空闲连接、快速
 * resolve。
 *
 * better-sqlite3 是按 Electron ABI 编译的，需用 Electron 的 Node 运行：
 *   HOME=/tmp/feishu-sync-quit-test ELECTRON_RUN_AS_NODE=1 \
 *     npx electron scripts/verify-quit-fix.mjs
 */
import net from 'node:net';
import { startServer } from '../server/dist/index.js';

async function main() {
  const started = await startServer({
    desktopMode: true,
    corsDevMode: false,
    port: 0,
    hostname: '127.0.0.1',
  });
  console.log('[test] server started at', started.url);

  // 建立一条 keep-alive 连接：发一次请求后保持空闲不关闭。
  const sock = net.connect(started.port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  sock.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log('[test] keep-alive connection established and idle');

  const t0 = Date.now();
  const closedByServer = new Promise((resolve) => {
    sock.once('close', () => resolve(true));
  });
  await started.close();
  const elapsed = Date.now() - t0;

  console.log(`[test] close() resolved in ${elapsed}ms`);
  if (elapsed > 4500) {
    console.error('[test] FAIL: close() 耗时过长，退出流程仍会被拖死');
    process.exit(1);
  }
  const kicked = await Promise.race([
    closedByServer.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);
  console.log('[test] lingering connection kicked by server:', kicked);

  sock.destroy();
  console.log('[test] PASS');
  process.exit(0);
}

main().catch((error) => {
  console.error('[test] FAIL:', error);
  process.exit(1);
});
