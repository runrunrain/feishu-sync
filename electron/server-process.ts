import { utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { createVisionImageTiles } from '../server/src/agent/vision/vision-image-tiles.js';
import type { VisionRequest } from '../server/src/agent/vision/vision-channel.js';

export interface DesktopServerProcess {
  url: string;
  port: number;
  pid: number;
  close(): Promise<void>;
}

/** Keep HTTP, SQLite, workbook parsing and agent tool work off Electron's UI/lifecycle thread. */
export function startServerProcess(input: {
  entryPath: string;
  serverPath: string;
  desktopToken: string;
  corsDevMode: boolean;
  onUnexpectedExit?: (code: number) => void;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}): Promise<DesktopServerProcess> {
  const child: UtilityProcess = utilityProcess.fork(input.entryPath, [], {
    stdio: 'pipe', serviceName: 'Feishu Sync Backend', env: { ...process.env },
  });
  child.stdout?.on('data', (chunk) => console.info('[backend]', String(chunk).trimEnd()));
  child.stderr?.on('data', (chunk) => console.warn('[backend]', String(chunk).trimEnd()));
  let closing = false; let ready = false; let exited = false;
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  let shutdownTimer: NodeJS.Timeout | null = null;
  // Only image cropping needs Electron's nativeImage module, which utility processes do not expose.
  let imageWork = Promise.resolve();
  const terminate = () => {
    if (exited) return;
    // UtilityProcess.kill() can synchronously wait for an unresponsive service. Keep the UI thread nonblocking.
    if (child.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    else child.kill();
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      closing = true; terminate(); reject(new Error('后端服务启动超时，请重新启动应用'));
    }, input.startupTimeoutMs ?? 45_000);
    const failed = (message: string) => { clearTimeout(timer); closing = true; terminate(); reject(new Error(message)); };
    child.on('exit', (code) => {
      exited = true; clearTimeout(timer); if (shutdownTimer) clearTimeout(shutdownTimer);
      resolveClose?.();
      if (!ready) reject(new Error(`后端服务在启动时退出（${code}）`));
      else if (!closing) input.onUnexpectedExit?.(code);
    });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const data = message as Record<string, unknown>;
      if (data.type === 'startup_error') { failed(String(data.message ?? '后端服务启动失败').slice(0, 500)); return; }
      if (data.type === 'closed') return; // The entry exits after the shutdown acknowledgement.
      if (data.type === 'vision_tiles' && typeof data.id === 'number') {
        const id = data.id;
        imageWork = imageWork.then(async () => {
          let tiles: Awaited<ReturnType<typeof createVisionImageTiles>> = [];
          if (!closing && data.bytes instanceof Uint8Array && data.bytes.byteLength <= 32 * 1024 * 1024
            && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(data.mime))) {
            await new Promise<void>((done) => setImmediate(done));
            tiles = await createVisionImageTiles({ bytes: Buffer.from(data.bytes), mime: data.mime } as VisionRequest);
          }
          if (!exited) child.postMessage({ type: 'vision_tiles_result', id, tiles });
        }).catch((error) => { console.warn('[backend] 图片裁剪失败:', String(error).slice(0, 200)); });
        return;
      }
      if (data.type !== 'ready' || ready || closing) return;
      const port = Number(data.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || data.url !== `http://127.0.0.1:${port}`) {
        failed('后端服务返回了无效的本机地址'); return;
      }
      clearTimeout(timer); ready = true;
      resolve({ url: String(data.url), port, pid: child.pid!, close: () => {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = new Promise<void>((done) => {
          if (exited) { done(); return; }
          resolveClose = done;
          child.postMessage({ type: 'shutdown' });
          // Finish before QuitCoordinator's final exit deadline. Persisted recovery state stays intact.
          shutdownTimer = setTimeout(() => {
            if (exited) return;
            terminate();
          }, input.shutdownTimeoutMs ?? 4000);
        });
        return closePromise;
      } });
    });
    child.postMessage({ type: 'start', serverPath: input.serverPath, desktopToken: input.desktopToken,
      desktopExecutable: process.execPath, corsDevMode: input.corsDevMode });
  });
}
