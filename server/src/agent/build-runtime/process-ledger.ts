/**
 * build-runtime/process-ledger.ts — F10 应用侧进程账本（生命周期对账）
 *
 * 位置：<buildRoot>/process-ledger.json（跨 epoch 共享；0600、tmp+rename 原子写）。
 *
 * 边界（任务书 F10）：
 * - 这是**生命周期对账**记录（谁何时启动/退出/如何被回收），不是任务状态
 *   调度器——不存任务语义、不驱动调度。
 * - 只记 pid/时间/epoch/generation/launchId/命令指纹（sha256(可执行+关键
 *   参数)）/cwd；**绝不**存密钥或整份 env。
 * - 历史证据：append-only；错误条目不删除，追加更正记录。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ProcessLedgerEntry {
  /** 启动身份（同 epoch 内每次启动唯一；adapter 签发）。 */
  launchId: string;
  buildId: string;
  runtimeEpoch: number | null;
  generation: number;
  kind: 'leader' | 'child' | 'bridge';
  /** amagi 原生任务 id（child/bridge 观察自启动锚点时回填；leader 为 null）。 */
  taskId?: string | null;
  /** 0 = 已持久化派发意图但尚未取得PID，不能据此认定从未spawn。 */
  pid: number;
  launchState?: 'intent' | 'started';
  startedAt: string;
  endedAt?: string;
  exit?: { code: number | null; signal: string | null };
  /** 可执行+参数指纹（sha256 前 16 hex；不含 env 值）。 */
  commandFingerprint?: string;
  /** 内核出生令牌（启动后尽力探测；darwin:sec:usec / linux:boot:start；缺席=日后无法精确对账）。 */
  birthToken?: string;
  cwd: string;
  /** 残留回收结论（对账时追加）。 */
  reconciliation?: {
    verdict: 'exited' | 'reaped' | 'not-ours' | 'unconfirmed';
    proof: 'birth-token' | 'pgid-invariant' | 'none';
    at: string;
  };
}

export function commandFingerprint(command: readonly string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex').slice(0, 16);
}

/** 读取账本（不存在/损坏 → 空账本并标注不可用；损坏不静默当空——返回 degraded）。 */
export function readProcessLedger(buildRoot: string): { entries: ProcessLedgerEntry[]; degraded: boolean } {
  const file = path.join(buildRoot, 'process-ledger.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; entries?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return { entries: [], degraded: true };
    const entries = parsed.entries.filter((entry): entry is ProcessLedgerEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Partial<ProcessLedgerEntry>;
      return typeof candidate.launchId === 'string' && candidate.launchId.length > 0
        && Number.isInteger(candidate.pid) && candidate.pid! >= 0
        && ['leader', 'child', 'bridge'].includes(candidate.kind ?? '')
        && typeof candidate.buildId === 'string'
        && (candidate.runtimeEpoch === null || (Number.isInteger(candidate.runtimeEpoch) && candidate.runtimeEpoch! >= 0))
        && Number.isInteger(candidate.generation) && candidate.generation! >= 0
        && typeof candidate.startedAt === 'string' && typeof candidate.cwd === 'string'
        && (candidate.launchState === undefined || candidate.launchState === 'intent' || candidate.launchState === 'started')
        && (candidate.birthToken === undefined || typeof candidate.birthToken === 'string')
        && (candidate.endedAt === undefined || typeof candidate.endedAt === 'string')
        && (candidate.exit === undefined || (candidate.exit !== null && typeof candidate.exit === 'object'
          && (candidate.exit.code === null || typeof candidate.exit.code === 'number')
          && (candidate.exit.signal === null || typeof candidate.exit.signal === 'string')));
    });
    return { entries, degraded: entries.length !== parsed.entries.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], degraded: false };
    return { entries: [], degraded: true };
  }
}

/** 追加条目（原子写；同类 launchId+kind 幂等覆盖尾条）。 */
export function appendProcessLedgerEntry(buildRoot: string, entry: ProcessLedgerEntry): void {
  const { entries } = readProcessLedger(buildRoot);
  // 同一启动的重复登记（如 exit 回调与 cancel 并发）取首条
  const deduped = entries.filter((existing) => !(existing.launchId === entry.launchId && existing.kind === entry.kind));
  deduped.push(entry);
  writeProcessLedger(buildRoot, deduped);
}

/** 标记退出（不存在对应条目时补一条只含退出事实的记录，不虚构启动信息）。 */
export function markLedgerExit(
  buildRoot: string,
  launchId: string,
  kind: ProcessLedgerEntry['kind'],
  exit: { code: number | null; signal: string | null },
): void {
  const { entries } = readProcessLedger(buildRoot);
  const target = entries.find((entry) => entry.launchId === launchId && entry.kind === kind);
  if (!target) {
    appendProcessLedgerEntry(buildRoot, {
      launchId, buildId: '', runtimeEpoch: null, generation: 0, kind,
      pid: 0, startedAt: new Date().toISOString(),
      exit, endedAt: new Date().toISOString(),
      cwd: '(unknown)',
    });
    return;
  }
  target.exit = exit;
  target.endedAt = new Date().toISOString();
  writeProcessLedger(buildRoot, entries);
}

function writeProcessLedger(buildRoot: string, entries: ProcessLedgerEntry[]): void {
  fs.mkdirSync(buildRoot, { recursive: true, mode: 0o700 });
  const file = path.join(buildRoot, 'process-ledger.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 非阻塞出生令牌补写（启动后探测完成时回填；条目已不存在则忽略）。 */
export function patchLedgerBirthToken(buildRoot: string, launchId: string, birthToken: string): void {
  const { entries } = readProcessLedger(buildRoot);
  const target = entries.find((entry) => entry.launchId === launchId && entry.kind === 'leader');
  if (!target || target.birthToken) return;
  target.birthToken = birthToken;
  writeProcessLedger(buildRoot, entries);
}
