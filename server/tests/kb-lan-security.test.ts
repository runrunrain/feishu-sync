/** Synthetic isolated security fixtures, never a real LAN listener or data root. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedSource, normalizeRemote, validPrivateCidr, validateLanConfig, defaultLanConfig, resolveBind } from '../src/kb-lan/network.js';
import { LanTokenStore, tokenDigest, verifyBearer } from '../src/kb-lan/token-store.js';
import { LanAudit, sanitizeAudit } from '../src/kb-lan/audit.js';
import { LanCallQueue } from '../src/kb-lan/call-queue.js';
import { HeartbeatDeadline } from '../src/kb-lan/gateway-manager.js';

const roots: string[] = [];
function temporary() { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-lan-security-'))); roots.push(root); return root; }
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('socket CIDRs, including IPv6 subnets and IPv4 mapped forms', () => {
  it.each(['127.0.0.2', '10.5.6.7', '172.31.255.255', '192.168.1.2', '169.254.1.2', '100.64.0.1', '100.127.255.255', '::1', 'fd12:abcd:1::3', 'fe80::a%en0', '::ffff:192.168.1.2', '::ffff:c0a8:0102'])('accepts %s', (ip) => expect(allowedSource(ip)).toBe(true));
  it.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '::', '2001:4860:4860::8888', '::ffff:8.8.8.8', 'localhost', '127.0.0.1.evil'])('rejects %s', (ip) => expect(allowedSource(ip)).toBe(false));
  it('canonicalizes identities and checks exact IPv6 prefix boundaries', () => {
    expect(normalizeRemote('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(normalizeRemote('fd12::0001')).toBe(normalizeRemote('fd12:0:0:0:0:0:0:1'));
    expect(normalizeRemote('fe80::1%en0')).not.toBe(normalizeRemote('fe80::1%en1'));
    expect(allowedSource('fd12:abcd:0:100::1', ['fd12:abcd::/48'])).toBe(true);
    expect(allowedSource('fd12:abce::1', ['fd12:abcd::/48'])).toBe(false);
    expect(allowedSource('febf::1')).toBe(true); expect(allowedSource('fec0::1')).toBe(false);
  });
  it.each(['10.1.2.0/24', 'fd12:3456::/32', '::1', '::ffff:192.168.1.0/120'])('permits narrowed %s', (c) => expect(validPrivateCidr(c)).toBe(true));
  it.each(['0.0.0.0/0', '::/0', '192.168.0.0/15', 'fc00::/6', '8.8.8.0/24', '127.0.0.1/33', '10.0.0.0/x', '::ffff:10.0.0.0/80'])('rejects expanded/malformed %s', (c) => expect(validPrivateCidr(c)).toBe(false));
  it('strict backend configuration, no public binding or CIDR escape', () => {
    for (const patch of [{ port: 0 }, { port: 1023 }, { port: 65536 }, { port: 47391.1 }, { maxSessions: 65 }, { maxSessions: NaN }, { bindAddress: '8.8.8.8' }, { allowCidrs: ['::/0'] }]) expect(() => validateLanConfig({ ...defaultLanConfig(), ...patch })).toThrow();
    expect(() => validateLanConfig({ ...defaultLanConfig(), bindAddress: '0.0.0.0', allowCidrs: [] })).not.toThrow();
    expect(resolveBind('auto', [{ name: 'vpn', address: '100.65.0.1' }, { name: 'en0', address: '192.168.1.2' }])).toBe('192.168.1.2');
    expect(resolveBind('192.168.9.9', [])).toBeNull();
  });
});
describe('persistent secret isolation', () => {
  it('persistent 256-bit token, masks, rotate/revoke, permissions, no leftover temp', () => {
    const root = temporary(); const tokens = new LanTokenStore(root); tokens.ensure();
    const first = tokens.reveal()!;
    expect(first).toMatch(/^fskb_[A-Za-z0-9_-]{43}$/);
    expect(new LanTokenStore(root).reveal()).toBe(first);
    expect(tokens.masked()).not.toContain(first);
    expect(fs.statSync(tokens.directory).mode & 0o777).toBe(0o700); expect(fs.statSync(tokens.file).mode & 0o777).toBe(0o600);
    fs.chmodSync(tokens.file, 0o644); tokens.reveal(); expect(fs.statSync(tokens.file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(tokens.directory)).toEqual(['kb-lan-mcp.json']);
    tokens.rotate(); expect(tokens.reveal()).not.toBe(first);
    tokens.revoke(); expect(tokens.digests()).toEqual([]); tokens.ensure(); expect(tokens.reveal()).not.toBe(first);
  });
  it('rejects directory/target symlink and hardlink without changing outside permissions', () => {
    const root = temporary(); const outside = temporary();
    fs.symlinkSync(outside, path.join(root, 'secrets'));
    expect(() => new LanTokenStore(root).ensure()).toThrow('unsafe_path');
    fs.unlinkSync(path.join(root, 'secrets')); fs.mkdirSync(path.join(root, 'secrets'));
    const target = path.join(outside, 'secret.json'); fs.writeFileSync(target, '{}', { mode: 0o644 });
    const store = new LanTokenStore(root); fs.symlinkSync(target, store.file);
    expect(() => store.ensure()).toThrow(); expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    fs.unlinkSync(store.file); fs.linkSync(target, store.file); expect(() => store.rotate()).toThrow('unsafe_file');
  });
  it('compares every equal-length digest, never accepts other domains', () => {
    const good = 'fskb_' + 'a'.repeat(43); const expected = [tokenDigest('fskb_' + 'b'.repeat(43)), tokenDigest(good)];
    expect(verifyBearer(`Bearer ${good}`, expected)).toBe(true);
    for (const value of ['', 'Bearer desktop-token', 'Bearer cli-token', `Basic ${good}`, `Bearer ${good}x`]) expect(verifyBearer(value, expected)).toBe(false);
  });
});
describe('metadata audit', () => {
  it('whitelists fields and rotates at limit', () => {
    const root = temporary(); const audit = new LanAudit(root, 100);
    audit.append({ event: 'tool_call', remote: '127.0.0.1', tool: 'search_knowledge', session: 'abcdef01-1234', query: 'secret query', token: 'secret', body: 'private', releaseId: 'r1', resultChars: 20 });
    audit.append({ event: 'token_revealed', token: 'secret' });
    expect(fs.existsSync(audit.file + '.1')).toBe(true);
    const rows = audit.recent(); expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toMatch(/secret|private|query|token"/);
    expect(rows[1].session).toBe('abcdef01');
    expect(sanitizeAudit({ event: 'made_up', token: 'x' })).toBeNull();
  });
  it('aggregates authentication failures once per IP/minute', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    const audit = new LanAudit(temporary());
    for (let i = 0; i < 10; i++) audit.append({ event: 'auth_fail', remote: '127.0.0.1' });
    expect(audit.recent()).toEqual([]);
    vi.advanceTimersByTime(60_000); audit.flush();
    expect(audit.recent()).toHaveLength(1); expect(audit.recent()[0].count).toBe(10);
  });
});
describe('fair queue and serial regex', () => {
  it('caps sessions without blocking another client, and releases on error', async () => {
    const queue = new LanCallQueue(); const order: string[] = []; const releases: Array<() => void> = [];
    const slow = (key: string) => queue.run(key, false, () => new Promise<void>((resolve) => { order.push(key); releases.push(resolve); }));
    const tasks = [slow('a'), slow('a'), slow('a'), slow('b'), slow('b')];
    await Promise.resolve(); expect(order).toEqual(['a', 'a', 'b', 'b']); expect(queue.inflight).toBe(4); expect(queue.queued).toBe(1);
    releases.shift()!(); await tasks[0]; await new Promise((r) => setImmediate(r)); expect(order).toEqual(['a', 'a', 'b', 'b', 'a']);
    for (const release of releases) release(); await Promise.all(tasks);
    await expect(queue.run('x', false, async () => { throw new Error('expected'); })).rejects.toThrow('expected');
    await new Promise((r) => setImmediate(r)); expect(queue.inflight).toBe(0);
  });
  it('bounds queue, times out, and serializes regex globally', async () => {
    const queue = new LanCallQueue({ global: 4, session: 2, queued: 1, waitMs: 20 });
    let release!: () => void; const first = queue.run('a', true, () => new Promise<void>((r) => { release = r; }));
    const waiting = queue.run('b', true, async () => 'second');
    await expect(queue.run('c', true, async () => 'third')).rejects.toMatchObject({ code: 'kb_busy' });
    await expect(waiting).rejects.toMatchObject({ code: 'kb_busy' }); release(); await first;
    queue.close(); await expect(queue.run('x', false, async () => 1)).rejects.toMatchObject({ code: 'kb_busy' });
  });
});
it('monotonic watchdog: kills a stalled child but resets after parent timer drift', () => {
  const deadline = new HeartbeatDeadline(0);
  expect(deadline.expired(2000)).toBe(false); expect(deadline.expired(4000)).toBe(false);
  expect(deadline.expired(6000)).toBe(false); expect(deadline.expired(8000)).toBe(false);
  expect(deadline.expired(10_000)).toBe(false); expect(deadline.expired(12_000)).toBe(true);
  const sleep = new HeartbeatDeadline(0);
  expect(sleep.expired(100_000)).toBe(false); expect(sleep.expired(102_000)).toBe(false);
  sleep.beat(102_000); expect(sleep.expired(104_000)).toBe(false);
});
