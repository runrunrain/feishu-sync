/**
 * AgentProcessPool — pi 进程池（设计 §4.5 + F3-R05/R06 + §4.7/U9）
 *
 * - 上限 agent.maxConcurrentProcesses（默认 3；范围 1..6）。
 * - F3-R05：容量先预留后 spawn——reserveSlot()/acquire() 在 spawn 前锁定
 *   一个槽位（失败立即释放，不留无主进程），register() 消费预留；池满时
 *   第二个 spawn 根本不会发生，而不是 spawn 完再因 register 失败泄漏
 *   OS 子进程。
 * - U9（S1）准入排队：acquire('background') FIFO 排队等待而非立即失败；
 *   会话类保持立即语义——reserveSlot() 池满返回 null、acquire('session')
 *   池满抛 AgentBusyError（显式不排队场景，调用方映射 409 agent_busy）。
 *   后台类（构建 worker/任务进程）合计并发 ≤ M−1（M≥2 时为交互会话
 *   保留 1 槽；M=1 时后台与前台互斥）；release 同步晋级队首；closeAll
 *   清空队列；队列不跨重启。
 * - F3-R06：busy（prompt 运行中）期间挂起 idle 回收；运行结束（成功/
 *   失败/异常）setBusy(false) 重起完整 idle 窗口——复用进程即使已空闲
 *   9 分钟，一次新 prompt 也必须获得全窗口，不得在 prompt 中途被回收。
 * - 会话进程空闲 idleTimeoutMinutes 后回收（terminate：stdin.end → 宽限
 *   → SIGKILL / Windows taskkill）；下次发消息用同一 --session-id 重拉。
 * - close() 时终止全部子进程并清空等待队列；所有操作幂等（重复
 *   terminate/close 安全）。
 */

import { PiRpcProcess } from './pi-rpc-process.js';

interface PoolEntry {
  process: PiRpcProcess;
  key: string;
  kind: 'session' | 'build' | 'probe';
  /** U9：本条目是否占用后台配额（后台槽消费而来，或既有 kind='build' 构建进程） */
  background: boolean;
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
 * settle 路径，把容量计数从「预留」转入「已注册进程」，随后再 release 无效）。
 */
export interface PoolSlot {
  release(): void;
}

/** acquire 的准入类别（U9）。 */
export type PoolAcquireKind = 'session' | 'background';

export interface PoolAcquireOptions {
  /** 取消信号：排队等待者被取消即出队并拒绝（AbortError），不再占位。 */
  signal?: AbortSignal;
}

interface QueueWaiter {
  resolve: (slot: PoolSlot) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

function createAbortError(): Error {
  const error = new Error('等待进程槽位已被取消');
  error.name = 'AbortError';
  return error;
}

/**
 * 池内部预留凭证：携带 background 标记（register 据此把后台配额计数从
 * 「预留」转入注册条目）。release = 放弃预留并触发队列晋级；consume =
 * register 消费（计数转移，容量净值不变，不触发晋级——否则会在条目
 * 落表前出现瞬时容量空窗导致超卖）。
 */
class ReservationSlot implements PoolSlot {
  readonly background: boolean;
  private settled = false;

  constructor(background: boolean, private readonly onSettle: (consume: boolean) => void) {
    this.background = background;
  }

  release(): void {
    this.settle(false);
  }

  /** register 消费预留：计数转移，不触发队列晋级。 */
  consume(): void {
    this.settle(true);
  }

  private settle(consume: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.onSettle(consume);
  }
}

export class AgentProcessPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly busyKeys = new Set<string>();
  private readonly waiters: QueueWaiter[] = [];
  private reservations = 0;
  private backgroundReservations = 0;
  private closed = false;
  private idleTimeoutMs: number;
  private maxProcesses: number;

  constructor(options: { maxConcurrentProcesses?: number; idleTimeoutMinutes?: number } = {}) {
    this.maxProcesses = this.clampMax(options.maxConcurrentProcesses ?? 3);
    this.idleTimeoutMs = Math.max(1, options.idleTimeoutMinutes ?? 10) * 60_000;
  }

  /** U9：上限 1..6（默认 3；设计 §4.7 M = clamp(maxConcurrentProcesses,1,6)）。 */
  private clampMax(value: number): number {
    return Math.max(1, Math.min(6, value));
  }

  configure(options: { maxConcurrentProcesses?: number; idleTimeoutMinutes?: number }): void {
    if (options.maxConcurrentProcesses !== undefined) {
      this.maxProcesses = this.clampMax(options.maxConcurrentProcesses);
    }
    if (options.idleTimeoutMinutes !== undefined) {
      this.idleTimeoutMs = Math.max(1, options.idleTimeoutMinutes) * 60_000;
    }
    // 扩容可立即放行队首；缩容不抢占已占槽（只是不再新授）
    this.pumpBackgroundQueue();
  }

  /**
   * F3-R05：预留一个进程槽位（立即语义：池满返回 null，不排队）。
   * 返回 null 表示池满（存活进程 + 未消费预留合计已达上限）。预留后
   * spawn；register(key, proc, kind, slot) 消费预留，spawn 失败路径
   * slot.release()。closeAll 后拒绝新预留。kind 参数为分类标记（当前
   * session/probe 同为立即语义，留给后续切片细分统计）。
   */
  reserveSlot(kind: 'session' | 'probe' = 'session'): PoolSlot | null {
    void kind;
    if (this.closed) return null;
    this.evictExited();
    if (this.runningCount() + this.reservations >= this.maxProcesses) return null;
    return this.createReservation(false);
  }

  /**
   * U9：准入排队接口（FIFO）。
   * - 'background'：后台配额（M>1 ? M−1 : 1）与总容量均有富余时立即
   *   授槽；否则入队等待，release/退出/扩容同步晋级队首。signal 取消
   *   即出队拒绝（AbortError）；已授出的槽不受后续取消影响。
   * - 'session'：立即语义（不排队）——池满抛 AgentBusyError，调用方
   *   映射 409 agent_busy。
   * closeAll 后调用抛错；队列不跨重启。
   */
  async acquire(kind: PoolAcquireKind, options: PoolAcquireOptions = {}): Promise<PoolSlot> {
    if (this.closed) throw new Error('进程池已关闭');
    if (kind === 'session') {
      const slot = this.reserveSlot('session');
      if (!slot) {
        throw new AgentBusyError(`Agent 进程数已达上限（${this.maxProcesses}），请稍后重试或停止其他会话`);
      }
      return slot;
    }
    this.evictExited();
    if (options.signal?.aborted) throw createAbortError();
    if (this.canGrantBackground()) return this.createReservation(true);
    return await new Promise<PoolSlot>((resolve, reject) => {
      const waiter: QueueWaiter = { resolve, reject, settled: false };
      const onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(createAbortError());
      };
      waiter.signal = options.signal;
      waiter.onAbort = onAbort;
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** U9：当前排队等待后台槽位的数量（不含已授槽者）。 */
  queueDepth(): number {
    return this.waiters.length;
  }

  /** 后台类并发上限：M≥2 → M−1（为交互会话保留 1 槽）；M=1 → 1（前后台互斥）。 */
  private backgroundLimit(): number {
    return this.maxProcesses > 1 ? this.maxProcesses - 1 : 1;
  }

  /** 后台类当前占用：存活后台注册条目 + 未消费后台预留。 */
  private backgroundCount(): number {
    let count = this.backgroundReservations;
    for (const entry of this.entries.values()) {
      if (!entry.process.isExited() && entry.background) count += 1;
    }
    return count;
  }

  private canGrantBackground(): boolean {
    return this.backgroundCount() < this.backgroundLimit()
      && this.loadCount() < this.maxProcesses;
  }

  /** 释放同步晋级队首：容量或后台配额一有富余即按 FIFO 授槽。 */
  private pumpBackgroundQueue(): void {
    while (this.waiters.length > 0 && this.canGrantBackground()) {
      const waiter = this.waiters.shift()!;
      waiter.settled = true;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(this.createReservation(true));
    }
  }

  private createReservation(background: boolean): ReservationSlot {
    this.reservations += 1;
    if (background) this.backgroundReservations += 1;
    return new ReservationSlot(background, (consume) => {
      this.reservations = Math.max(0, this.reservations - 1);
      if (background) this.backgroundReservations = Math.max(0, this.backgroundReservations - 1);
      if (!consume) this.pumpBackgroundQueue();
    });
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
   * 注册进程。持 slot 时消费预留（容量在预留时已判定，不再重复检查）；
   * 未持 slot 时超出上限抛 AgentBusyError（409 agent_busy）。
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
    // 后台配额归属：后台槽消费而来，或既有 kind='build' 构建进程。
    const background = (slot instanceof ReservationSlot && slot.background) || kind === 'build';
    // 消费预留：容量计数从「预留」转入下面的「已注册进程」（转移不触发
    // 晋级，避免 entries.set 前的瞬时空窗超卖）。
    if (slot instanceof ReservationSlot) slot.consume();
    else slot?.release();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      void existing.process.terminate();
    }
    this.busyKeys.delete(key);
    this.entries.set(key, { process, key, kind, background, lastActiveAt: Date.now() });
    process.on('run_finished', () => this.touch(key));
    process.on('exit', () => {
      const current = this.entries.get(key);
      if (current && current.process === process) {
        if (current.idleTimer) clearTimeout(current.idleTimer);
        this.busyKeys.delete(key);
        this.entries.delete(key);
        this.pumpBackgroundQueue();
      }
    });
    this.scheduleIdleTimer(key);
    // 替换旧进程可能腾出后台配额；晋级在条目落表之后进行。
    this.pumpBackgroundQueue();
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
    this.pumpBackgroundQueue();
    await entry.process.terminate();
  }

  private evictExited(): void {
    let evicted = false;
    for (const [key, entry] of this.entries) {
      if (entry.process.isExited()) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        this.busyKeys.delete(key);
        this.entries.delete(key);
        evicted = true;
      }
    }
    if (evicted) this.pumpBackgroundQueue();
  }

  /** server close()：终止全部子进程并使后续 reserveSlot 失败。幂等。 */
  /**
   * 管理插件前回收空闲扩展进程；不关闭进程池本身。
   * R2-05：只回收确为空闲的**会话**进程——task/build 后台进程由各自生命
   * 周期管理（TaskService 轮结束即 terminate、构建取消链自终），不因
   * 插件管理被误杀（busy 标记之外的第二道防线）。
   */
  async retireIdle(): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      if (entry.kind !== 'session') continue;
      if (!this.busyKeys.has(key)) await this.terminate(key);
    }
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    this.reservations = 0;
    this.backgroundReservations = 0;
    this.busyKeys.clear();
    // U9：清空等待队列——等待者全部拒绝，不得悬挂到进程退出之后。
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.settled = true;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new Error('进程池已关闭'));
    }
    const terminations: Array<Promise<void>> = [];
    for (const [key, entry] of this.entries) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.entries.delete(key);
      terminations.push(entry.process.terminate());
    }
    await Promise.allSettled(terminations);
  }
}
