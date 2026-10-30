/** Parent lifecycle owner: no LAN listener runs in the Electron/Hono event loop. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { serverDistRoot } from '../agent/agent-assets.js';
import type { ConfigManager } from '../modules/config-manager.js';
import type { KbLanMcpConfig } from '../types/index.js';
import { defaultLanConfig, privateInterfaces, resolveBind, validateLanConfig, DEFAULT_CIDRS } from './network.js';
import { LanTokenStore } from './token-store.js';
import { LanAudit } from './audit.js';
import { rawCatalogPath } from '../kb/raw-mcp-catalog.js';

export type LanState = 'disabled' | 'starting' | 'running' | 'port_in_use' | 'bind_unavailable' | 'no_private_interface' | 'artifact_missing' | 'failed';
export interface GatewayManagerOptions {
  dataRoot: string; config: Pick<ConfigManager, 'getConfig' | 'updateConfig'>;
  artifact?: string; executable?: string;
  interfaces?: typeof privateInterfaces;
  spawn?: typeof spawn;
  now?: () => number;
  timing?: { tickMs?: number; heartbeatMs?: number; driftMs?: number; networkMs?: number; killMs?: number; backoffMs?: number; crashWindowMs?: number };
  localHostname?: () => string | null;
}
/** Monotonic, drift-aware deadline, independently testable without actual sleep. */
export class HeartbeatDeadline {
  private tick: number;
  private heartbeat: number;
  constructor(now: number, private tickMs = 2000, private timeoutMs = 10_000, private driftMs = 5000) { this.tick = this.heartbeat = now; }
  beat(now: number): void { this.heartbeat = now; }
  expired(now: number): boolean {
    const drift = now - this.tick - this.tickMs;
    this.tick = now;
    if (drift > this.driftMs) { this.heartbeat = now; return false; }
    return now - this.heartbeat > this.timeoutMs;
  }
}
export class KbLanGatewayManager {
  readonly tokens: LanTokenStore;
  readonly audit: LanAudit;
  private state: LanState = 'disabled';
  private lastError: { code: string; message: string } | null = null;
  private host: string | null = null;
  private child: ChildProcess | null = null;
  private heartbeat: HeartbeatDeadline | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private crashes: number[] = [];
  private retryCount = 0;
  private lastNetwork = 0;
  private lastRegex: string | null = null;
  private load = { sessions: 0, inflight: 0, queued: 0, heapUsed: 0 };
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly now: () => number;
  private readonly localHostname: string | null;
  private readonly timing: Required<NonNullable<GatewayManagerOptions['timing']>>;
  constructor(private options: GatewayManagerOptions) {
    this.tokens = new LanTokenStore(options.dataRoot);
    this.audit = new LanAudit(options.dataRoot);
    this.now = options.now ?? (() => performance.now());
    this.localHostname = options.localHostname ? options.localHostname() : this.readLocalHostname();
    this.timing = { tickMs: 2000, heartbeatMs: 10_000, driftMs: 5000, networkMs: 30_000, killMs: 3000, backoffMs: 1000, crashWindowMs: 600_000, ...options.timing };
  }
  private readLocalHostname(): string | null {
    if (process.platform !== 'darwin') return null;
    try { return execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; } // No invented .local URL when system lookup fails.
  }
  private config(): KbLanMcpConfig { return this.options.config.getConfig()?.kbLanMcp ?? defaultLanConfig(); }
  private interfaces() { return (this.options.interfaces ?? privateInterfaces)(); }
  status() {
    const config = this.config();
    const host = this.host;
    const urlHost = host?.includes(':') ? `[${host}]` : host;
    const urls = host ? [`http://${urlHost}:${config.port}/mcp`] : [];
    if (host === '0.0.0.0' || host === '::') urls.splice(0, urls.length, ...this.interfaces().map((i) => `http://${i.address.includes(':') ? `[${i.address}]` : i.address}:${config.port}/mcp`));
    // macOS publishes its host name independently of this application. Do not
    // advertise any application service or infer it on other platforms.
    const local = this.localHostname;
    if (host && local && /^[A-Za-z0-9-]+$/.test(local)) urls.push(`http://${local}.local:${config.port}/mcp`);
    return { enabled: config.enabled, state: this.state, bindAddress: config.bindAddress, resolvedHost: host, port: config.port, urls, ...this.load, lastError: this.lastError?.message ?? null, tokenMasked: this.tokens.masked(), interfaces: this.interfaces() };
  }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serial.then(run);
    this.serial = next.catch(() => {});
    return next;
  }
  start(): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed) return;
      if (!this.timer) {
        this.timer = setInterval(() => {
          try { this.tick(); }
          catch {
            this.failure('failed', 'gateway_supervision_failed');
            void this.exclusive(() => this.stopChild()).catch(() => {});
          }
        }, this.timing.tickMs);
        this.timer.unref();
      }
      if (this.config().enabled) {
        try { this.tokens.ensure(); this.launch(); }
        catch { this.failure('failed', 'gateway_start_failed'); }
      }
    });
  }
  enable(patch: Partial<Pick<KbLanMcpConfig, 'bindAddress' | 'port'>>): Promise<ReturnType<KbLanGatewayManager['status']>> {
    return this.exclusive(async () => {
      const next = { ...this.config(), ...patch, enabled: true };
      validateLanConfig(next);
      // Availability check is backend authority, not a UI confirmation.
      if (next.bindAddress !== 'auto' && !resolveBind(next.bindAddress, this.interfaces())) throw new Error('bind_unavailable');
      this.tokens.ensure();
      await this.options.config.updateConfig({ kbLanMcp: next });
      await this.stopChild(); this.crashes = []; this.retryCount = 0;
      this.audit.append({ event: 'enabled' }); this.launch(); return this.status();
    });
  }
  disable(revoke = false): Promise<ReturnType<KbLanGatewayManager['status']>> {
    return this.exclusive(async () => {
      await this.options.config.updateConfig({ kbLanMcp: { ...this.config(), enabled: false } });
      await this.stopChild();
      if (revoke) this.tokens.revoke();
      this.state = 'disabled'; this.lastError = null; this.host = null;
      this.audit.append({ event: 'disabled' }); return this.status();
    });
  }
  settings(patch: Omit<KbLanMcpConfig, 'enabled'>): Promise<ReturnType<KbLanGatewayManager['status']>> {
    return this.exclusive(async () => {
      const next = { ...patch, enabled: this.config().enabled };
      validateLanConfig(next);
      if (next.bindAddress !== 'auto' && !resolveBind(next.bindAddress, this.interfaces())) throw new Error('bind_unavailable');
      await this.options.config.updateConfig({ kbLanMcp: next });
      await this.stopChild();
      this.crashes = []; this.retryCount = 0;
      if (next.enabled) this.launch();
      return this.status();
    });
  }
  refresh(): Promise<void> {
    return this.exclusive(async () => { await this.stopChild(); if (this.config().enabled) this.launch(); });
  }
  rotate(): Promise<{ tokenMasked: string | null }> {
    return this.exclusive(async () => {
      // Stop first: the old child must not authenticate another request after
      // the replacement secret is persisted or the API reports completion.
      await this.stopChild(); this.tokens.rotate();
      this.audit.append({ event: 'token_rotated' });
      if (this.config().enabled) this.launch();
      return { tokenMasked: this.tokens.masked() };
    });
  }
  reveal(): { token: string | null } { this.audit.append({ event: 'token_revealed' }); return { token: this.tokens.reveal() }; }
  private failure(code: LanState, message: string = code): void { this.state = code; this.lastError = { code, message }; }
  private artifact(): string {
    const root = serverDistRoot();
    return this.options.artifact ?? path.join(path.basename(root) === 'src' ? path.join(root, '..', 'dist') : root, 'mcp', 'kb-mcp-gateway.cjs');
  }
  private launch(): void {
    if (this.closed || this.child || this.retry || !this.config().enabled) return;
    const config = this.config();
    this.host = resolveBind(config.bindAddress, this.interfaces());
    if (!this.host) { this.failure(config.bindAddress === 'auto' ? 'no_private_interface' : 'bind_unavailable'); return; }
    if (!fs.existsSync(this.artifact())) { this.failure('artifact_missing'); return; }
    const env: NodeJS.ProcessEnv = { KB_LAN_TOKEN_SHA256: this.tokens.digests().join(',') };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    for (const key of ['KB_MCP_MAX_CHARS', 'FEISHU_KB_RANKER']) if (process.env[key]) env[key] = process.env[key];
    this.state = 'starting'; this.lastError = null;
    this.heartbeat = new HeartbeatDeadline(this.now(), this.timing.tickMs, this.timing.heartbeatMs, this.timing.driftMs);
    let child: ChildProcess;
    try {
      child = (this.options.spawn ?? spawn)(this.options.executable ?? process.execPath, [this.artifact(), '--kb-root', this.options.config.getConfig()!.standardKb.outputRoot, '--raw-catalog', rawCatalogPath(this.options.dataRoot), '--host', this.host, '--port', String(config.port), '--max-sessions', String(config.maxSessions), '--allow-cidrs', (config.allowCidrs ?? DEFAULT_CIDRS).join(',')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch { this.failure('failed', 'spawn_failed'); this.scheduleRestart(); return; }
    this.child = child;
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 65_536) { child.kill('SIGKILL'); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { continue; }
        try { this.message(message, child); }
        catch {
          this.failure('failed', 'audit_unavailable');
          void this.exclusive(() => this.stopChild()).catch(() => {});
        }
      }
    });
    // Drain without persisting arbitrary child stderr (may contain data).
    child.stderr?.resume();
    child.once('error', () => { if (this.child === child) this.failure('failed', 'spawn_failed'); });
    child.once('close', () => {
      if (this.child !== child) return;
      this.child = null; this.load = { sessions: 0, inflight: 0, queued: 0, heapUsed: 0 };
      if (['port_in_use', 'bind_unavailable'].includes(this.state)) return;
      this.failure('failed', 'gateway_exited'); this.scheduleRestart();
    });
  }
  private message(message: Record<string, unknown>, child: ChildProcess): void {
    if (message.type === 'ready' && message.pid === child.pid && message.host === this.host && message.port === this.config().port) {
      this.state = 'running'; this.lastError = null; this.heartbeat?.beat(this.now());
    } else if (message.type === 'hb') {
      this.heartbeat?.beat(this.now());
      for (const key of ['sessions', 'inflight', 'queued', 'heapUsed'] as const) if (typeof message[key] === 'number' && Number.isFinite(message[key]) && message[key] >= 0) this.load[key] = message[key];
    } else if (message.type === 'audit') {
      if (message.event === 'regex_start' && typeof message.session === 'string') this.lastRegex = message.session;
      this.audit.append(message);
    } else if (message.type === 'fatal') {
      const code = message.code === 'port_in_use' ? 'port_in_use' : message.code === 'bind_unavailable' ? 'bind_unavailable' : 'failed';
      this.failure(code); child.kill('SIGKILL');
    }
  }
  private scheduleRestart(): void {
    if (this.closed || !this.config().enabled) return;
    const now = this.now(); this.crashes = this.crashes.filter((t) => now - t < this.timing.crashWindowMs); this.crashes.push(now);
    if (this.crashes.length >= 5) { this.failure('failed', 'crash_limit'); return; }
    const delay = Math.min(60_000, this.timing.backoffMs * 2 ** this.retryCount++);
    this.retry = setTimeout(() => {
      this.retry = null;
      try { this.launch(); } catch { this.failure('failed', 'gateway_restart_failed'); }
    }, delay);
    this.retry.unref();
  }
  private tick(): void {
    try { this.audit.flush(); }
    catch {
      this.failure('failed', 'audit_unavailable');
      void this.exclusive(() => this.stopChild()).catch(() => {});
      return;
    }
    if (this.child && this.heartbeat?.expired(this.now())) {
      this.audit.append({ event: 'watchdog_kill', ...(this.lastRegex ? { session: this.lastRegex } : {}) });
      this.heartbeat = null; this.child.kill('SIGKILL');
    }
    if (this.now() - this.lastNetwork < this.timing.networkMs) return;
    this.lastNetwork = this.now();
    if (!this.config().enabled || this.closed) return;
    const next = resolveBind(this.config().bindAddress, this.interfaces());
    if (next !== this.host || ['bind_unavailable', 'no_private_interface'].includes(this.state)) {
      void this.exclusive(async () => { await this.stopChild(); this.launch(); })
        .catch(() => this.failure('failed', 'gateway_restart_failed'));
    }
  }
  private async stopChild(): Promise<void> {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const child = this.child;
    this.child = null; this.heartbeat = null; this.lastRegex = null;
    this.load = { sessions: 0, inflight: 0, queued: 0, heapUsed: 0 };
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, this.timing.killMs);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  close(): Promise<void> {
    this.closed = true;
    return this.exclusive(async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      await this.stopChild();
      try { this.audit.flush(true); } catch { this.lastError = { code: 'audit_unavailable', message: 'audit_unavailable' }; }
      this.state = 'disabled';
    });
  }
}
