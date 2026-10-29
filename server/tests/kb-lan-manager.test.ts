/** Actual subprocess lifecycle, using tiny protocol fixture children (not KB tools). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { KbLanGatewayManager } from '../src/kb-lan/gateway-manager.js';
import { defaultLanConfig } from '../src/kb-lan/network.js';
import type { Config } from '../src/types/index.js';

const roots: string[] = []; const managers: KbLanGatewayManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.close())); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(mode = 'healthy') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-lan-manager-'))); roots.push(root);
  const artifact = path.join(root, 'fixture.cjs');
  fs.writeFileSync(artifact, `const args=process.argv; const arg=k=>args[args.indexOf(k)+1];
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
${mode === 'port' ? "emit({type:'fatal',code:'port_in_use',message:'ignored arbitrary data'});process.exit(1);" : mode === 'bind' ? "emit({type:'fatal',code:'bind_unavailable'});process.exit(1);" : `emit({type:'ready',host:arg('--host'),port:Number(arg('--port')),pid:process.pid});
${mode !== 'stall' ? "setInterval(()=>emit({type:'hb',t:Date.now(),sessions:2,inflight:1,queued:0,heapUsed:123}),20);" : 'setInterval(()=>{},1000);'}
${mode === 'crash' ? 'setTimeout(()=>process.exit(1),40);' : mode === 'redos' ? "emit({type:'audit',event:'regex_start',session:'abcdef01-1234'});setImmediate(()=>/(a|aa)+$/.test('a'.repeat(50)+'b'));" : ''}
${mode === 'ignoreterm' ? "process.on('SIGTERM',()=>{});" : "process.on('SIGTERM',()=>process.exit(0));"}`}`);
  let config = { kbLanMcp: { ...defaultLanConfig(), bindAddress: '127.0.0.1' }, standardKb: { outputRoot: path.join(root, 'kb') } } as Config;
  let interfaces = [{ name: 'test', address: '192.168.1.2' }];
  const launches: Array<{ pid: number; args: readonly string[]; env: NodeJS.ProcessEnv; at: number }> = [];
  const manager = new KbLanGatewayManager({ dataRoot: root, artifact, config: { getConfig: () => config, updateConfig: async (patch) => { config = { ...config, ...patch }; return config; } }, interfaces: () => interfaces,
    spawn: ((command: string, args: string[], opts: any) => { const child = spawn(command, args, opts); launches.push({ pid: child.pid!, args, env: opts.env, at: performance.now() }); return child; }) as typeof spawn,
    timing: { tickMs: 20, heartbeatMs: 150, driftMs: 500, networkMs: 100, killMs: 50, backoffMs: 20, crashWindowMs: 10_000 }, localHostname: () => 'test-host',
  }); managers.push(manager);
  return { root, artifact, manager, launches, config: () => config, interfaces: (next: typeof interfaces) => { interfaces = next; } };
}
const running = (m: KbLanGatewayManager) => vi.waitFor(() => expect(m.status().state).toBe('running'), { timeout: 3000, interval: 10 });
describe('gateway manager lifecycle', () => {
  it('disabled by default; enables persistent token; minimal child env and no token argv', async () => {
    const f = fixture(); await f.manager.start(); expect(f.launches).toHaveLength(0);
    expect(f.manager.status().state).toBe('disabled');
    await f.manager.enable({}); await running(f.manager);
    await vi.waitFor(() => expect(f.manager.status().sessions).toBe(2));
    expect(f.manager.status()).toMatchObject({ enabled: true, resolvedHost: '127.0.0.1', port: 47391, inflight: 1, queued: 0, heapUsed: 123 });
    const token = f.manager.reveal().token!;
    expect(JSON.stringify(f.launches[0].args)).not.toContain(token);
    expect(f.launches[0].env.KB_LAN_TOKEN_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(f.launches[0].env).sort()).toEqual(['KB_LAN_TOKEN_SHA256']);
    await f.manager.disable(); expect(f.manager.reveal().token).toBe(token);
    expect(() => process.kill(f.launches[0].pid, 0)).toThrow();
    await f.manager.enable({}); await running(f.manager); expect(f.manager.reveal().token).toBe(token);
    await f.manager.disable(true); expect(f.manager.reveal().token).toBeNull();
  });
  it('rotation terminates old child and changes digest without exposing cleartext', async () => {
    const f = fixture(); await f.manager.start(); await f.manager.enable({}); await running(f.manager);
    const token = f.manager.reveal().token; const old = f.launches[0];
    const result = await f.manager.rotate(); await running(f.manager);
    expect(result).toEqual({ tokenMasked: f.manager.status().tokenMasked });
    expect(f.manager.reveal().token).not.toBe(token); expect(() => process.kill(old.pid, 0)).toThrow();
    expect(f.launches[1].env.KB_LAN_TOKEN_SHA256).not.toBe(old.env.KB_LAN_TOKEN_SHA256);
    const audit = fs.readFileSync(f.manager.audit.file, 'utf8'); expect(audit).toContain('token_rotated'); expect(audit).not.toContain(token!);
  });
  it('kill -9 restarts with backoff, then five crashes stop retrying', async () => {
    const f = fixture('crash'); await f.manager.start(); await f.manager.enable({});
    await vi.waitFor(() => expect(f.manager.status().lastError).toBe('crash_limit'), { timeout: 5000, interval: 20 });
    expect(f.launches).toHaveLength(5);
    expect(f.launches[2].at - f.launches[1].at).toBeGreaterThanOrEqual(60);
    await new Promise((r) => setTimeout(r, 200)); expect(f.launches).toHaveLength(5);
  });
  it('explicit SIGKILL recovers, and parent watchdog attributes a missing heartbeat', async () => {
    const f = fixture(); await f.manager.start(); await f.manager.enable({}); await running(f.manager);
    process.kill(f.launches[0].pid, 'SIGKILL'); await vi.waitFor(() => expect(f.launches).toHaveLength(2)); await running(f.manager);
    const stalled = fixture('redos'); await stalled.manager.start(); await stalled.manager.enable({}); await running(stalled.manager);
    await vi.waitFor(() => expect(stalled.launches.length).toBeGreaterThan(1), { timeout: 3000 });
    expect(stalled.manager.audit.recent().some((row) => row.event === 'watchdog_kill' && row.session === 'abcdef01')).toBe(true);
  });
  it('never changes/retries an occupied fixed port, and missing artifacts do not spawn', async () => {
    const f = fixture('port'); await f.manager.start(); await f.manager.enable({});
    await vi.waitFor(() => expect(f.manager.status().state).toBe('port_in_use'));
    await new Promise((r) => setTimeout(r, 250)); expect(f.launches).toHaveLength(1); expect(f.manager.status().port).toBe(47391);
    const missing = fixture(); fs.unlinkSync(missing.artifact); await missing.manager.start(); await missing.manager.enable({});
    expect(missing.manager.status().state).toBe('artifact_missing'); expect(missing.launches).toHaveLength(0);
  });
  it('auto binding follows interface disappearance and restores after recovery', async () => {
    const f = fixture(); await f.manager.start(); await f.manager.enable({ bindAddress: 'auto' }); await running(f.manager);
    expect(f.manager.status().resolvedHost).toBe('192.168.1.2');
    f.interfaces([]); await vi.waitFor(() => expect(f.manager.status().state).toBe('no_private_interface'));
    expect(() => process.kill(f.launches[0].pid, 0)).toThrow();
    f.interfaces([{ name: 'test', address: '192.168.2.3' }]); await vi.waitFor(() => expect(f.launches.length).toBe(2)); await running(f.manager);
    expect(f.manager.status().resolvedHost).toBe('192.168.2.3');
  });
  it('enabling auto with no interface reports a recoverable state rather than losing intent', async () => {
    const f = fixture(); f.interfaces([]); await f.manager.start();
    await f.manager.enable({ bindAddress: 'auto' });
    expect(f.manager.status()).toMatchObject({ enabled: true, state: 'no_private_interface' });
    expect(f.launches).toHaveLength(0);
    f.interfaces([{ name: 'test', address: '192.168.3.4' }]);
    await running(f.manager); expect(f.launches).toHaveLength(1);
  });
  it('SIGTERM escalates to SIGKILL; close cancels retries and cannot resurrect', async () => {
    const f = fixture('ignoreterm'); await f.manager.start(); await f.manager.enable({}); await running(f.manager);
    await f.manager.close(); expect(() => process.kill(f.launches[0].pid, 0)).toThrow();
    await new Promise((r) => setTimeout(r, 100)); expect(f.launches).toHaveLength(1);
    await f.manager.start(); expect(f.launches).toHaveLength(1);
  });
  it('validates all interfaces, ports, CIDR narrowing before persistence', async () => {
    const f = fixture(); await f.manager.start();
    await expect(f.manager.enable({ bindAddress: '8.8.8.8' })).rejects.toThrow('invalid');
    await expect(f.manager.enable({ bindAddress: '192.168.9.9' })).rejects.toThrow('bind_unavailable');
    await expect(f.manager.settings({ bindAddress: '0.0.0.0', port: 47391, maxSessions: 16, allowCidrs: ['0.0.0.0/0'] })).rejects.toThrow('invalid');
    expect(f.config().kbLanMcp?.enabled).toBe(false); expect(f.launches).toHaveLength(0);
  });
});
