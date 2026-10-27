/**
 * AgentProcessPool — pi 进程池（设计 §4.5 + F3-R05/R06）
 *
 * - 上限 agent.maxConcurrentProcesses（默认 2；构建占 1，会话占其余）。
 * - F3-R05：容量先预留后 spawn——reserveSlot() 在 spawn 前锁定一个槽位
 *   （失败立即释放，不留无主进程），register() 消费预留；池满时第二个
 *   spawn 根本不会发生，而不是 spawn 完再因 register 失败泄漏 OS 子进程。
 * - F3-R06：busy（prompt 运行中）期间挂起 idle 回收；运行结束（成功/
 *   失败/异常）setBusy(false) 重起完整 idle 窗口——复用进程即使已空闲
 *   9 分钟，一次新 prompt 也必须获得全窗口，不得在 prompt 中途被回收。
 * - 会话进程空闲 idleTimeoutMinutes 后回收（terminate：stdin.end → 宽限
 *   → SIGKILL / Windows taskkill）；下次发消息用同一 --session-id 重拉。
 * - close() 时终止全部子进程；所有操作幂等（重复 terminate/close 安全）。
 */

import { PiRpcProcess } from './pi-rpc-process.js';

interface PoolEntry {
  process: PiRpcProcess;
  key: string;
  kind: 'session' | 'build' | 'probe';
  lastActiveAt: number;
  idleTimer?: NodeJS.Timeout;
}

export class AgentBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentBusyError';
  }
}

/**
 * F3-R05：容量预留凭证。release 幂等；register 消费预留（内部调用同一
 * release，把容量计数从「预留」转入「已注册进程」，随后再 release 无效）。
 */
export interface PoolSlot {
  release(): void;
}

export class AgentProcessPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly busyKeys = new Set<string>();
  private reservations = 0;
  private closed = false;
  private idleTimeoutMs: number;
  private maxProcesses: number;

  constructor(options: { maxConcurrentProcesses?: number; idleTimeoutMinutes?: number } = {}) {
    this.maxProcesses = Math.max(1, Math.min(4, options.maxConcurrentProcesses ?? 2));
    this.idleTimeoutMs = Math.max(1, options.idleTimeoutMinutes ?? 10) * 60_000;
  }

  configure(options: { maxConcurrentProcesses?: number; idleTimeoutMinutes?: number }): void {
    if (options.maxConcurrentProcesses !== undefined) {
      this.maxProcesses = Math.max(1, Math.min(4, options.maxConcurrentProcesses));
    }
    if (options.idleTimeoutMinutes !== undefined) {
      this.idleTimeoutMs = Math.max(1, options.idleTimeoutMinutes) * 60_000;
    }
  }

  /**
   * F3-R05：预留一个进程槽位。返回 null 表示池满（存活进程 + 未消费
   * 预留合计已达上限）。预留后 spawn；register(key, proc, kind, slot)
   * 消费预留，spawn 失败路径 slot.release()。closeAll 后拒绝新预留。
   */
  reserveSlot(): PoolSlot | null {
    if (this.closed) return null;
    this.evictExited();
    if (this.runningCount() + this.reservations >= this.maxProcesses) return null;
    this.reservations += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.reservations = Math.max(0, this.reservations - 1);
      },
    };
  }

  /** 当前有效负载：存活进程 + 未消费预留（容量判断口径）。 */
  loadCount(): number {
    return this.runningCount() + this.reservations;
  }

  runningCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!entry.process.isExited()) count += 1;
    }
    return count;
  }

  get max(): number {
    return this.maxProcesses;
  }

  has(key: string): boolean {
    const entry = this.entries.get(key);
    return Boolean(entry && !entry.process.isExited());
  }

  get(key: string): PiRpcProcess | null {
    const entry = this.entries.get(key);
    if (!entry || entry.process.isExited()) return null;
    return entry.process;
  }

  /**
   * 注册进程。持 slot 时消费预留（容量在 reserve 时已判定，不再重复
   * 检查）；未持 slot 时超出上限抛 AgentBusyError（409 agent_busy）。
   * 同 key 重复注册替换旧进程（terminate 旧的）。
   */
  register(key: string, process: PiRpcProcess, kind: PoolEntry['kind'], slot?: PoolSlot): void {
    if (this.closed) {
      throw new Error('进程池已关闭');
    }
    this.evictExited();
    if (!slot) {
      const replacing = this.has(key);
      if (!replacing && this.runningCount() + this.reservations > this.maxProcesses) {
        throw new AgentBusyError(`Agent 进程数已达上限（${this.maxProcesses}），请稍后重试或停止其他会话`);
      }
    }
    // 消费预留：容量计数从「预留」转入下面的「已注册进程」。
    slot?.release();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      void existing.process.terminate();
    }
    this.busyKeys.delete(key);
    this.entries.set(key, { process, key, kind, lastActiveAt: Date.now() });
    process.on('run_finished', () => this.touch(key));
    process.on('exit', () => {
      const current = this.entries.get(key);
      if (current && current.process === process) {
        if (current.idleTimer) clearTimeout(current.idleTimer);
        this.busyKeys.delete(key);
        this.entries.delete(key);
      }
    });
    this.scheduleIdleTimer(key);
  }

  /**
   * F3-R06：busy 标记。busy=true 挂起 idle 回收（清计时）；busy=false
   * 重起完整 idle 窗口。对不存在的 key 幂等无操作。
   */
  setBusy(key: string, busy: boolean): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (busy) {
      this.busyKeys.add(key);
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
      }
    } else {
      this.busyKeys.delete(key);
      entry.lastActiveAt = Date.now();
      this.scheduleIdleTimer(key);
    }
  }

  isBusy(key: string): boolean {
    return this.busyKeys.has(key);
  }

  touch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastActiveAt = Date.now();
    this.scheduleIdleTimer(key);
  }

  private scheduleIdleTimer(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.kind !== 'session') return; // 只有会话进程空闲回收
    if (this.busyKeys.has(key)) return; // F3-R06：busy 期间不排空闲回收
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.terminate(key);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  /** 主动终止（模式切换/会话删除/构建取消）。幂等。 */
  async terminate(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.busyKeys.delete(key);
    this.entries.delete(key);
    await entry.process.terminate();
  }

  private evictExited(): void {
    for (const [key, entry] of this.entries) {
      if (entry.process.isExited()) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        this.busyKeys.delete(key);
        this.entries.delete(key);
      }
    }
  }

  /** server close()：终止全部子进程并使后续 reserveSlot 失败。幂等。 */
  async closeAll(): Promise<void> {
    this.closed = true;
    this.reservations = 0;
    this.busyKeys.clear();
    const terminations: Array<Promise<void>> = [];
    for (const [key, entry] of this.entries) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.entries.delete(key);
      terminations.push(entry.process.terminate());
    }
    await Promise.allSettled(terminations);
  }
}
