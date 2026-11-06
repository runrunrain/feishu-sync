import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createDesktopDiagnostics, startResponsivenessDiagnostics } from './diagnostics.js';

// Electron utility process entry: no BrowserWindow, no renderer access, no model credentials in argv.
const parent = (process as NodeJS.Process & { parentPort?: {
  on(name: string, listener: (event: { data: Record<string, unknown> }) => void): void;
  postMessage(data: unknown): void;
} }).parentPort;
if (!parent) throw new Error('Desktop backend requires a parent message port');
const stopDiagnostics = startResponsivenessDiagnostics(createDesktopDiagnostics(process.env.FEISHU_SYNC_HOME || path.join(os.homedir(), '.feishu-sync')), 'backend');
let started: { url: string; port: number; close(): Promise<void> } | null = null;
let starting = false; let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  try { await started?.close(); }
  finally { stopDiagnostics(); parent.postMessage({ type: 'closed' }); process.exit(0); }
};
parent.on('message', (event) => {
  const data = event.data;
  if (data.type === 'shutdown') { void close(); return; }
  if (data.type !== 'start' || starting || closing) return;
  starting = true;
  void (async () => {
    if (typeof data.serverPath !== 'string' || !path.isAbsolute(data.serverPath)
      || typeof data.desktopToken !== 'string' || !data.desktopToken) throw new Error('Invalid desktop server bootstrap');
    if (typeof data.desktopExecutable === 'string') process.env.FEISHU_SYNC_DESKTOP_EXECUTABLE = data.desktopExecutable;
    const server = await import(pathToFileURL(data.serverPath).href);
    started = await server.startServer({ desktopMode: true, desktopToken: data.desktopToken,
      hostname: '127.0.0.1', port: 0, corsDevMode: data.corsDevMode === true,
      cliLocalInstall: { defaults: data.corsDevMode === false } });
    parent.postMessage({ type: 'ready', url: started!.url, port: started!.port, pid: process.pid });
  })().catch((error) => {
    parent.postMessage({ type: 'startup_error', message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
});
process.once('SIGTERM', () => { void close(); });
