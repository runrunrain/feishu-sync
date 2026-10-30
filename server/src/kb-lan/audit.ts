/** Parent-owned metadata-only audit. Child records are untrusted input. */
import fs from 'node:fs';
import path from 'node:path';
const EVENTS = new Set(['tool_call', 'auth_fail', 'forbidden_source', 'browser_forbidden', 'rate_limited', 'session_open', 'session_close', 'session_evicted', 'foreign_token_header', 'watchdog_kill', 'token_rotated', 'token_revealed', 'enabled', 'disabled', 'regex_start', 'index_build']);
const TOOLS = new Set(['search_knowledge', 'get_knowledge', 'list_knowledge', 'get_release_info', 'grep_knowledge', 'get_outline', 'get_knowledge_bundle']);
export type AuditRecord = Record<string, string | number | null> & { event: string };
export function sanitizeAudit(raw: Record<string, unknown>): AuditRecord | null {
  if (typeof raw.event !== 'string' || !EVENTS.has(raw.event)) return null;
  const out: AuditRecord = { event: raw.event, time: new Date().toISOString() };
  if (typeof raw.remote === 'string' && raw.remote.length <= 80 && /^[a-fA-F0-9:.]+(?:%[A-Za-z0-9_.-]{1,32})?$/.test(raw.remote)) out.remote = raw.remote;
  if (typeof raw.session === 'string' && /^[a-fA-F0-9-]+$/.test(raw.session)) out.session = raw.session.slice(0, 8);
  if (typeof raw.tool === 'string' && TOOLS.has(raw.tool)) out.tool = raw.tool;
  if (typeof raw.releaseId === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(raw.releaseId)) out.releaseId = raw.releaseId;
  if (['ok', 'error'].includes(String(raw.status))) out.status = String(raw.status);
  if (typeof raw.errorCode === 'string' && /^[a-z_]{1,80}$/.test(raw.errorCode)) out.errorCode = raw.errorCode;
  for (const key of ['queueMs', 'durationMs', 'resultChars', 'indexBuildMs', 'count']) if (typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0) out[key] = raw[key];
  return out;
}
export class LanAudit {
  readonly file: string;
  private failures = new Map<string, { minute: number; count: number }>();
  constructor(dataRoot: string, private maxBytes = 5 * 1024 * 1024) { this.file = path.join(dataRoot, 'agent', 'audit', 'kb-lan-mcp.jsonl'); }
  append(raw: Record<string, unknown>): void {
    const record = sanitizeAudit(raw);
    if (!record) return;
    if (record.event === 'auth_fail') {
      const remote = String(record.remote ?? '');
      const minute = Math.floor(Date.now() / 60_000);
      const last = this.failures.get(remote);
      if (last?.minute === minute) { last.count++; return; }
      this.flushExpired(minute);
      this.failures.set(remote, { minute, count: 1 });
      return; // one delayed, aggregated record for this IP/minute
    }
    this.write(record);
  }
  private flushExpired(minute: number): void {
    for (const [remote, entry] of this.failures) if (entry.minute < minute) {
      this.write({ event: 'auth_fail', time: new Date(entry.minute * 60_000).toISOString(), remote, count: entry.count });
      this.failures.delete(remote);
    }
  }
  flush(force = false): void { this.flushExpired(force ? Infinity : Math.floor(Date.now() / 60_000)); }
  private write(record: AuditRecord): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file) && fs.statSync(this.file).size >= this.maxBytes) fs.renameSync(this.file, this.file + '.1');
    fs.appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  recent(limit = 50): AuditRecord[] {
    // Bounded to one rotated segment plus the active <=5MB segment.
    return [this.file + '.1', this.file].flatMap((file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as AuditRecord]; } catch { return []; } }) : []).slice(-Math.max(1, Math.min(200, limit))).reverse();
  }
}
