import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { serverDistRoot } from '../agent/agent-assets.js';
import { LanTokenStore, tokenDigest } from '../kb-lan/token-store.js';
import { runtimeExecutable } from '../modules/runtime-executable.js';
import type { KbMcpHttpInfo } from '../types/agent-knowledge.js';
import { rawCatalogPath } from './raw-mcp-catalog.js';

const LOOPBACK = '127.0.0.1';
const LOCAL_MCP_PORT = 47392;

/** Owns the listener address and credentials. The detached reader owns its lifetime policy. */
export class LocalMcpService {
  private readonly url: string;
  private readonly tokens: LanTokenStore;
  private readonly artifact: string;
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private ready = false;
  private closed = false;
  private token?: string;

  constructor(private readonly dataRoot: string, private readonly kbRoot: () => string,
    private readonly port = LOCAL_MCP_PORT) {
    this.url = `http://${LOOPBACK}:${port}/mcp`;
    this.tokens = new LanTokenStore(dataRoot, 'kb-local-mcp.json');
    const root = serverDistRoot();
    const dist = path.basename(root) === 'src' ? path.join(root, '..', 'dist') : root;
    this.artifact = path.join(dist, 'mcp', 'kb-mcp-gateway.cjs');
  }

  info(): KbMcpHttpInfo {
    const headers: Record<string, string> = this.token ? { Authorization: `Bearer ${this.token}` } : {};
    const entry = { type: 'http', url: this.url, headers };
    return {
      available: this.ready && !this.closed,
      url: this.url,
      headers,
      snippet: this.token ? JSON.stringify({ mcpServers: { 'feishu-kb': entry } }, null, 2) : '',
    };
  }

  private async probe(): Promise<'ready' | 'closed' | 'unavailable'> {
    if (!this.token) return 'closed';
    try {
      const response = await fetch(this.url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(500) });
      return response.status === 204 && response.headers.get('X-Feishu-Kb-Local') === tokenDigest(this.token)
        ? 'ready' : 'unavailable';
    } catch (error) {
      return (error as Error & { cause?: NodeJS.ErrnoException }).cause?.code === 'ECONNREFUSED'
        ? 'closed' : 'unavailable';
    }
  }

  start(onReady: () => void): void {
    if (this.timer || this.closed || !fs.existsSync(this.artifact)) return;
    this.tokens.ensure();
    this.token = this.tokens.reveal() ?? undefined;
    const update = () => {
      if (this.pending || this.closed) return;
      this.pending = this.reconcile(onReady).catch(() => {
        console.warn('[local MCP] Listener startup or managed configuration update failed');
      }).finally(() => { this.pending = undefined; });
    };
    this.timer = setInterval(update, 2000);
    this.timer.unref();
    update();
  }

  private async reconcile(onReady: () => void): Promise<void> {
    const status = await this.probe();
    if (this.closed) return;
    if (status === 'ready') {
      if (!this.ready) { this.ready = true; onReady(); }
      return;
    }
    this.ready = false;
    if (status !== 'closed' || this.child || !this.token) return;
    const env: NodeJS.ProcessEnv = { KB_LAN_TOKEN_SHA256: tokenDigest(this.token) };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    for (const key of ['SystemRoot', 'KB_MCP_MAX_CHARS', 'FEISHU_KB_RANKER']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(runtimeExecutable(), [
      this.artifact, '--kb-root', this.kbRoot(), '--raw-catalog', rawCatalogPath(this.dataRoot),
      '--host', LOOPBACK, '--port', String(this.port), '--allow-cidrs', '127.0.0.1/32',
      '--local-data-root', this.dataRoot,
    ], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env,
    });
    this.child = child;
    const release = () => { if (this.child === child) this.child = undefined; };
    child.once('error', release);
    child.once('exit', release);
    child.unref();
  }

  /** Presence is withdrawn first. An attached or previously detached reader will observe it. */
  async close(keepRunning: boolean): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
    if (keepRunning) return;
    for (let attempt = 0; attempt < 15 && await this.probe() === 'ready'; attempt++) await delay(100);
    // Use a child handle only for the process this instance created.
    if (this.child?.exitCode === null) this.child.kill();
  }
}
