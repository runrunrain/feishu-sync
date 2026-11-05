/** App recovery policy: retire fenced dispatches after inspecting their process
 * namespace. Native task files remain intact; this is not a human attestation or
 * a claim that an unobserved child successfully completed. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readBirthIdentities } from './process-identity.js';
import type { ChildProcessFinding, TerminationOutcome } from './contracts.js';

export interface ScopedProcess { pid: number; ppid: number; uid: number }
export interface AutomaticRecoveryDeps {
  scan?: (homes: readonly string[]) => Promise<ScopedProcess[] | null>;
  birth?: (pids: readonly number[]) => Promise<Map<number, string>>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only exact inherited runtime-home labels identify roots. Arbitrary mentions
 * of a path in a shell command, another app, or this scanner do not identify it. */
export function parseScopedProcesses(raw: string, homes: readonly string[], uid: number,
  workingDirectories: ReadonlyMap<number, string> = new Map()): ScopedProcess[] | null {
  const rows = raw.split('\n').filter(line => line.trim()).map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), command: m[4] } : null;
  });
  if (!rows.length || rows.some(row => row === null)) return null;
  const labels = homes.map(home => new RegExp(`(?:^|\\s)PI_CODING_AGENT_DIR=${escape(home)}(?=\\s|$)`));
  const scopes = homes.map(home => {
    try { return path.dirname(fs.realpathSync.native(home)); } catch { return path.dirname(path.resolve(home)); }
  });
  const inScope = (pid: number) => {
    const cwd = workingDirectories.get(pid);
    return cwd && scopes.some(scope => cwd === scope || cwd.startsWith(scope + path.sep));
  };
  const ours = new Set(rows.filter(row => row!.uid === uid && row!.pid !== process.pid
    && (inScope(row!.pid) || labels.some(label => label.test(row!.command)))).map(row => row!.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (row && row.uid === uid && row.pid !== process.pid && ours.has(row.ppid) && !ours.has(row.pid)) {
      ours.add(row.pid); changed = true;
    }
  }
  return rows.filter((row): row is NonNullable<typeof row> => !!row && ours.has(row.pid))
    .map(({ pid, ppid, uid: owner }) => ({ pid, ppid, uid: owner }));
}

export async function scanScopedProcesses(homes: readonly string[]): Promise<ScopedProcess[] | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const raw = await new Promise<string | null>(resolve => {
    execFile('ps', ['eww', '-axo', 'pid=,ppid=,uid=,command='],
      { encoding: 'utf8', timeout: 8_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
  });
  if (raw === null) return null;
  const uid = process.getuid?.() ?? -1;
  const candidates = raw.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => !!match && Number(match[3]) === uid);
  const cwds = new Map<number, string>();
  if (process.platform === 'darwin') {
    // Pi overwrites process.title, and macOS then hides both argv and env from
    // ps. Inspect kernel cwd records too; an empty ps label search is not proof.
    const listing = await new Promise<string | null>(resolve => {
      execFile('/usr/sbin/lsof', ['-w', '-a', '-u', String(uid), '-d', 'cwd', '-Fpn'],
        { encoding: 'utf8', timeout: 8_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => resolve(error && !stdout ? null : stdout));
    });
    if (listing === null) return null;
    let pid = 0;
    for (const line of listing.split('\n')) {
      if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
      else if (line.startsWith('n/') && pid > 1) cwds.set(pid, line.slice(1));
    }
  } else {
    for (const match of candidates) {
      try { cwds.set(Number(match[1]), fs.readlinkSync(`/proc/${match[1]}/cwd`)); } catch { /* exited or inaccessible; checked below */ }
    }
  }
  const opaqueRuntimes = candidates.filter(match => /^(?:\S*\/)?(?:pi|node|nodejs|bun)(?:\s|$)/.test(match[4]));
  for (const match of opaqueRuntimes) {
    const pid = Number(match[1]);
    if (pid === process.pid || cwds.has(pid)) continue;
    try { process.kill(pid, 0); return null; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return null;
    }
  }
  // Never log or persist raw process environments (they may contain credentials).
  return parseScopedProcesses(raw, homes, uid, cwds);
}

function recoverable(finding: ChildProcessFinding, homes: readonly string[]): boolean {
  if (finding.source !== 'v2-store' || finding.pid !== 0 || !finding.taskId
    || !/^[A-Za-z0-9_-]{1,64}$/.test(finding.taskId)) return false;
  return homes.some(home => {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(home, 'amagi/v2-store', finding.taskId!, 'current.json'), 'utf8'));
      return run.version === 1 && run.taskId === finding.taskId && run.specId === finding.taskId
        && typeof run.ownerId === 'string' && run.ownerId.length > 0
        && ['queued', 'running', 'blocked', 'answering'].includes(run.execution)
        && ['not-started', 'unknown'].includes(run.processState) && !run.backendRunId;
    } catch { return false; }
  });
}

export async function recoverOrphanDispatches(input: {
  buildId: string; buildRoot: string; homes: string[]; outcome: TerminationOutcome;
  /** Must revoke old API tokens/leases before any cleanup or record retirement. */
  fence: () => boolean;
}, deps: AutomaticRecoveryDeps = {}): Promise<TerminationOutcome> {
  const pending = input.outcome.children.filter(child => child.verdict === 'unconfirmed');
  if (!pending.length || pending.some(child => !recoverable(child, input.homes))) return input.outcome;
  if (!input.fence()) return { ...input.outcome, note: `${input.outcome.note}；旧代次凭据撤销失败，自动恢复稍后重试` };
  const scan = deps.scan ?? scanScopedProcesses;
  const birth = deps.birth ?? readBirthIdentities;
  const signal = deps.signal ?? ((pid, value) => { process.kill(pid, value); });
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let processes = await scan(input.homes);
  if (!processes) return { ...input.outcome, note: `${input.outcome.note}；本机构建进程扫描不可用，自动恢复稍后重试` };
  const identities = await birth(processes.map(row => row.pid));
  for (const value of ['SIGTERM', 'SIGKILL'] as const) {
    for (const row of processes) {
      const expected = identities.get(row.pid);
      if (!expected) continue;
      const fresh = await birth([row.pid]);
      if (fresh.get(row.pid) !== expected) continue;
      try { signal(row.pid, value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    }
    if (processes.length) await sleep(value === 'SIGTERM' ? 500 : 100);
    const next = await scan(input.homes);
    if (!next) return { ...input.outcome, note: `${input.outcome.note}；清理后进程扫描不可用，自动恢复稍后重试` };
    processes = next;
    if (!processes.length) break;
  }
  // A second independent scan also covers a child that became visible while
  // its old Leader was closing. An old writer has already lost its API lease.
  await sleep(50);
  const final = await scan(input.homes);
  if (!final || final.length) return { ...input.outcome,
    note: `${input.outcome.note}；${final ? `仍在自动清理 ${final.length} 个本构建进程` : '进程复核暂不可用'}，稍后重试` };
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const recovered = new Set(pending.map(child => child.taskId));
  const outcome: TerminationOutcome = { ...input.outcome, state: 'confirmed', at,
    children: input.outcome.children.map(child => child.verdict === 'unconfirmed' && recovered.has(child.taskId)
      ? { ...child, verdict: 'abandoned', proof: 'scope-scan', detail: '旧代次写入资格已撤销；构建专属进程范围已清理并复核，孤立派发按未完成收回；保留原生记录，不伪造退出或成功' } : child),
    note: `已自动收回 ${pending.length} 条孤立派发；旧代次凭据已撤销，构建专属进程扫描与清理已完成，保留草稿继续恢复` };
  const audit = path.join(input.buildRoot, 'automatic-recovery.json');
  fs.writeFileSync(`${audit}.tmp`, JSON.stringify({ version: 1, buildId: input.buildId, at,
    taskIds: [...recovered], decision: 'abandoned-after-fence-and-scope-scan', physicalExitAsserted: false }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${audit}.tmp`, audit);
  return outcome;
}
