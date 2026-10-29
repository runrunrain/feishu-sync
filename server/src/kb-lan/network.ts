/** Socket-address policy. No DNS, proxy headers, or public CIDR escape hatch. */
import { isIP } from 'node:net';
import os from 'node:os';
import type { KbLanMcpConfig } from '../types/index.js';

export const DEFAULT_CIDRS = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', 'fc00::/7', 'fe80::/10'];
export const defaultLanConfig = (): KbLanMcpConfig => ({ enabled: false, bindAddress: 'auto', port: 47391, maxSessions: 16 });

type Address = { bits: number; value: bigint };
function address(raw: string): Address | null {
  const ip = raw.split('%')[0].toLowerCase();
  const family = isIP(ip);
  if (family === 4) return { bits: 32, value: ip.split('.').reduce((n, x) => (n << 8n) + BigInt(x), 0n) };
  if (family !== 6) return null;
  let text = ip;
  if (text.includes('.')) {
    const at = text.lastIndexOf(':');
    const v4 = address(text.slice(at + 1))!;
    text = text.slice(0, at) + ':' + (v4.value >> 16n).toString(16) + ':' + (v4.value & 65535n).toString(16);
  }
  const [left, right] = text.split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const parts = right !== undefined ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  const value = parts.reduce((n, x) => (n << 16n) + BigInt('0x' + x), 0n);
  if (value >> 32n === 65535n) return { bits: 32, value: value & 0xffffffffn };
  return { bits: 128, value };
}
export function normalizeRemote(ip: string): string {
  const parsed = address(ip);
  if (!parsed) return '';
  if (parsed.bits === 32) return [24n, 16n, 8n, 0n].map((n) => String((parsed.value >> n) & 255n)).join('.');
  // Canonical identity independent of IPv6 compression/zone spelling.
  const zone = ip.includes('%') ? '%' + ip.split('%')[1] : '';
  return Array.from({ length: 8 }, (_, i) => ((parsed.value >> BigInt((7 - i) * 16)) & 65535n).toString(16)).join(':') + zone;
}
function cidr(text: string): (Address & { prefix: number }) | null {
  const [ip, suffix, extra] = text.split('/');
  const parsed = address(ip);
  if (!parsed || extra !== undefined || (suffix !== undefined && !/^\d+$/.test(suffix))) return null;
  let prefix = suffix === undefined ? parsed.bits : Number(suffix);
  // Mapped IPv6 CIDRs may only describe the IPv4-mapped /96 subtree.
  if (isIP(ip) === 6 && parsed.bits === 32 && suffix !== undefined) prefix -= 96;
  if (prefix < 0 || prefix > parsed.bits) return null;
  return { ...parsed, prefix };
}
function contains(parent: Address & { prefix: number }, child: Address): boolean {
  return parent.bits === child.bits && (parent.value >> BigInt(parent.bits - parent.prefix)) === (child.value >> BigInt(parent.bits - parent.prefix));
}
export function allowedSource(ip: string, ranges = DEFAULT_CIDRS): boolean {
  const parsed = address(ip);
  return !!parsed && ranges.some((range) => { const c = cidr(range); return !!c && contains(c, parsed); });
}
export function validPrivateCidr(range: string): boolean {
  const candidate = cidr(range);
  return !!candidate && DEFAULT_CIDRS.some((range) => { const parent = cidr(range)!; return candidate.prefix >= parent.prefix && contains(parent, candidate); });
}
export function validateLanConfig(value: unknown): asserts value is KbLanMcpConfig {
  const c = value as KbLanMcpConfig;
  if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.enabled !== 'boolean'
    || typeof c.bindAddress !== 'string' || !['auto', '0.0.0.0', '::'].includes(c.bindAddress) && !allowedSource(c.bindAddress)
    || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535
    || !Number.isInteger(c.maxSessions) || c.maxSessions < 1 || c.maxSessions > 64
    || c.allowCidrs !== undefined && (!Array.isArray(c.allowCidrs) || c.allowCidrs.length > 64 || !c.allowCidrs.every((x) => typeof x === 'string' && validPrivateCidr(x)))) {
    throw new Error('invalid_kb_lan_config');
  }
}
export function normalizeLanConfig(value: unknown): KbLanMcpConfig {
  const merged = { ...defaultLanConfig(), ...(value && typeof value === 'object' ? value : {}) };
  try {
    validateLanConfig(merged);
    return { enabled: merged.enabled, bindAddress: merged.bindAddress, port: merged.port, maxSessions: merged.maxSessions, ...(merged.allowCidrs === undefined ? {} : { allowCidrs: [...merged.allowCidrs] }) };
  } catch { return defaultLanConfig(); }
}
export function privateInterfaces(source = os.networkInterfaces()): Array<{ name: string; address: string }> {
  return Object.entries(source).flatMap(([name, entries]) => (entries ?? []).filter((e) => !e.internal && allowedSource(e.address)).map((e) => ({ name, address: e.address })))
    .sort((a, b) => (a.name === 'en0' ? -1 : b.name === 'en0' ? 1 : a.name.localeCompare(b.name)) || a.address.localeCompare(b.address));
}
export function resolveBind(bind: string, interfaces = privateInterfaces()): string | null {
  if (bind === 'auto') return interfaces.find((i) => isIP(i.address) === 4 && allowedSource(i.address, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']))?.address ?? null;
  if (['0.0.0.0', '::', '127.0.0.1', '::1'].includes(bind)) return bind;
  return interfaces.some((i) => normalizeRemote(i.address) === normalizeRemote(bind)) ? bind : null;
}
