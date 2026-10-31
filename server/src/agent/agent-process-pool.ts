/**
 * AgentProcessPool — pi 进程池（设计 §4.5 + F3-R05/R06 + §4.7/U9 + B 案 §6）
 *
 * 三通道准入（B 案 §6：N 路构建与其他名额分开计算）：
 * - 'session'：交互会话，立即语义——池满抛 AgentBusyError（调用方映射
 *   409 agent_busy），不排队；至少保留 1 槽（后台容量 M−1 的既有行为
 *   保留，B 案 §6「构建已用满五路，用户发起对话 → 使用额外的交互名额」）。
 * - 'background'：非构建后台（任务进程、连接探测），合计并发 ≤ M−1
 *   （M≥2 时为交互会话保留 1 槽；M=1 时前后台互斥）。maxConcurrentProcesses
 *   语义收敛为「非构建后台容量」（缺省沿用现有值），不再与构建共享扣减
 *   （B 案 §6：旧的应用总进程配置迁移为非构建容量，不能继续作为构建的
 *   第二道上限）。
 * - 'build'：构建类任务专用通道，容量 N = buildConcurrency（由
 *   kb-build-service 按构建配置 resolveBuildConcurrency 结果传入）；N 不被
 *   maxConcurrentProcesses−M 截断（B 案 R3：配置多少构建上限就是多少路）。
 *   总运行上限 = N + 非构建容量（M），不再用固定全局上限截断构建与
 *   非构建之和（B 案 §6 末段）；诊断如实上报（totalCapacity 等 getter）。
 *
 * - F3-R05：容量先预留后 spawn——reserveSlot()/acquire() 在 spawn 前锁定
 *   一个槽位（失败立即释放，不留无主进程），register() 消费预留；池满时
 *   第二个 spawn 根本不会发生，而不是 spawn 完再因 register 失败泄漏
 *   OS 子进程。
 * - U9（S1）准入排队：background/build 均 FIFO 排队等待而非立即失败；
 *   会话类保持立即语义。signal 取消即出队拒绝（AbortError）；已授出的
 *   槽不受后续取消影响；等待者不提前占位（B 案 §6「不能提前创建一批
 *   空等进程」）。release 同步晋级队首；closeAll 清空两个队列；队列不跨
 *   重启。
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
  /** 配额通道（B 案 §6）：session/background 占非构建容量，build 占独立 N 路 */
  channel: 'session' | 'background' | 'build';
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

/** acquire 的准入类别（U9 + B 案 §6 三通道）。 */
export type PoolAcquireKind = 'session' | 'background' | 'build';

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

type PoolChannel = 'session' | 'background' | 'build';

/**
 * 池内部预留凭证：携带配额通道（register 据此把对应通道的容量计数从
 * 「预留」转入注册条目）。release = 放弃预留并触发队列晋级；consume =
 * register 消费（计数转移，容量净值不变，不触发晋级——否则会在条目
 * 落表前出现瞬时容量空窗导致超卖）。
 */
class ReservationSlot implements PoolSlot {
  private settled = false;

  constructor(readonly channel: PoolChannel, private readonly onSettle: (consume: boolean) => void) {}

  /** 兼容旧读法：是否后台通道。 */
  get background(): boolean {
    return this.channel === 'background';
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
  /** B 案 §6：构建通道独立 FIFO 队列（与 background 队列各自晋升） */
  private readonly buildWaiters: QueueWaiter[] = [];
  /** 非构建预留计数（session+background；容量口径不含 build 通道） */
  private reservations = 0;
  private backgroundReservations = 0;
  /** B 案 §6：构建通道预留计数 */
  private buildReservations = 0;
  private closed = false;
  private idleTimeoutMs: number;
  private maxProcesses: number;
  /** 构建容量 N（B 案 §6；缺省 2 = resolveBuildConcurrency 的缺省回落） */
  private buildCapacityValue: number;

  constructor(options: { maxConcurrentProcesses?: number; idleTimeoutMinutes?: number; buildConcurrency?: number } = {}) {
    this.maxProcesses = this.clampMax(options.maxConcurrentProcesses ?? 3);
    this.idleTimeoutMs = Math.max(1, options.idleTimeoutMinutes ?? 10) * 60_000;
    this.buildCapacityValue = this.clampBuildCapacity(options.buildConcurrency ?? 2);
  }

  /** U9：上限 1..6（默认 3；设计 §4.7 M = clamp(maxConcurrentProcesses,1,6)）。 */
  private clampMax(value: number): number {
    return Math.max(1, Math.min(6, value));
  }

  /** B 案 §6：构建容量 1..8（与 resolveBuildConcurrency 同界；不受 M 截断）。 */
  private clampBuildCapacity(value: number): number {
    return Math.max(1, Math.min(8, Math.floor(value)));
  }

  configure(options: { maxConcurrentProcesses?: number; idleTimeoutMinutes?: number; buildConcurrency?: number }): void {
    if (options.maxConcurrentProcesses !== undefined) {
      this.maxProcesses = this.clampMax(options.maxConcurrentProcesses);
    }
    if (options.idleTimeoutMinutes !== undefined) {
      this.idleTimeoutMs = Math.max(1, options.idleTimeoutMinutes) * 60_000;
    }
    if (options.buildConcurrency !== undefined) {
      this.buildCapacityValue = this.clampBuildCapacity(options.buildConcurrency);
    }
    // 扩容可立即放行队首；缩容不抢占已占槽（只是不再新授）
    this.pumpQueues();
  }

  /**
   * F3-R05：预留一个进程槽位（立即语义：池满返回 null，不排队）。
   * 返回 null 表示非构建容量已满（存活进程 + 未消费预留合计达上限；
   * 构建通道条目不占非构建容量——B 案 §6 交互名额独立）。预留后
   * spawn；register(key, proc, kind, slot) 消费预留，spawn 失败路径
   * slot.release()。closeAll 后拒绝新预留。kind 参数为分类标记。
   */
  reserveSlot(kind: 'session' | 'probe' = 'session'): PoolSlot | null {
    void kind;
    if (this.closed) return null;
    this.evictExited();
    if (this.nonBuildLoad() >= this.maxProcesses) return null;
    return this.createReservation('session');
  }

  /**
   * U9 准入排队接口（FIFO）。
   * - 'background'：后台配额（M>1 ? M−1 : 1）与非构建容量均有富余时立即
   *   授槽；否则入队等待。signal 取消即出队拒绝；已授出的槽不受后续
   *   取消影响。
   * - 'build'（B 案 §6）：构建容量 N 有富余即授槽；N 独立于 maxProcesses
   *   ——不再被隐藏总上限压低（R3）；满额 FIFO 排队，等待不占位。
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
    const channel: PoolChannel = kind === 'build' ? 'build' : 'background';
    const queue = channel === 'build' ? this.buildWaiters : this.waiters;
    this.evictExited();
    if (options.signal?.aborted) throw createAbortError();
    if (channel === 'build' ? this.canGrantBuild() : this.canGrantBackground()) {
      return this.createReservation(channel);
    }
    return await new Promise<PoolSlot>((resolve, reject) => {
      const waiter: QueueWaiter = { resolve, reject, settled: false };
      const onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(createAbortError());
      };
      waiter.signal = options.signal;
      waiter.onAbort = onAbort;
      options.signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  }

  /** U9：当前排队等待后台槽位的数量（不含已授槽者；构建队列另见
   * buildQueueDepth）。 */
  queueDepth(): number {
    return this.waiters.length;
  }

  /** B 案 §6：构建通道排队等待数。 */
  buildQueueDepth(): number {
    return this.buildWaiters.length;
  }

  /** 后台类并发上限：M≥2 → M−1（为交互会话保留 1 槽）；M=1 → 1（前后台互斥）。 */
  private backgroundLimit(): number {
    return this.maxProcesses > 1 ? this.maxProcesses - 1 : 1;
  }

  /** 后台通道当前占用：存活后台条目 + 未消费后台预留。 */
  private backgroundCount(): number {
    let count = this.backgroundReservations;
    for (const entry of this.entries.values()) {
      if (!entry.process.isExited() && entry.channel === 'background') count += 1;
    }
    return count;
  }

  /** 构建通道当前占用（B 案 §6）：存活构建条目 + 未消费构建预留。 */
  private buildCount(): number {
    let count = this.buildReservations;
    for (const entry of this.entries.values()) {
      if (!entry.process.isExited() && entry.channel === 'build') count += 1;
    }
    return count;
  }

  private canGrantBackground(): boolean {
    return this.backgroundCount() < this.backgroundLimit()
      && this.nonBuildLoad() < this.maxProcesses;
  }

  /** B 案 §6/R3：构建授槽只看 N——不受 maxProcesses 与后台配额影响。 */
  private canGrantBuild(): boolean {
    return this.buildCount() < this.buildCapacityValue;
  }

  /** 释放/退出/扩容同步晋升两个队列的队首（各自按通道富余授槽）。 */
  private pumpQueues(): void {
    while (this.waiters.length > 0 && this.canGrantBackground()) {
      this.promote(this.waiters.shift()!, 'background');
    }
    while (this.buildWaiters.length > 0 && this.canGrantBuild()) {
      this.promote(this.buildWaiters.shift()!, 'build');
    }
  }

  private promote(waiter: QueueWaiter, channel: PoolChannel): void {
    waiter.settled = true;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(this.createReservation(channel));
  }

  private createReservation(channel: PoolChannel): ReservationSlot {
    if (channel === 'build') this.buildReservations += 1;
    else this.reservations += 1;
    if (channel === 'background') this.backgroundReservations += 1;
    return new ReservationSlot(channel, (consume) => {
      if (channel === 'build') this.buildReservations = Math.max(0, this.buildReservations - 1);
      else this.reservations = Math.max(0, this.reservations - 1);
      if (channel === 'background') this.backgroundReservations = Math.max(0, this.backgroundReservations - 1);
      if (!consume) this.pumpQueues();
    });
  }

  /** 非构建有效负载：非构建存活进程 + 非构建未消费预留（容量判断口径；
   * 构建通道不占非构建容量——B 案 §6）。 */
  private nonBuildLoad(): number {
    return this.nonBuildRunningCount() + this.reservations;
  }

  /** 当前有效负载（既有口径：非构建通道；语义同 loadCount）。 */
  loadCount(): number {
    return this.nonBuildLoad();
  }

  runningCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!entry.process.isExited()) count += 1;
    }
    return count;
  }

  /** B 案 §6：非构建通道存活进程数。 */
  nonBuildRunningCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!entry.process.isExited() && entry.channel !== 'build') count += 1;
    }
    return count;
  }

  /** B 案 §6：构建通道存活进程数。 */
  buildRunningCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!entry.process.isExited() && entry.channel === 'build') count += 1;
    }
    return count;
  }

  get max(): number {
    return this.maxProcesses;
  }

  /** B 案 §6：构建通道当前负载（存活条目 + 未消费预留）。 */
  buildLoadCount(): number {
    return this.buildCount();
  }

  /** B 案 §6：构建容量 N（诊断如实上报）。 */
  get buildCapacity(): number {
    return this.buildCapacityValue;
  }

  /** B 案 §6：总运行上限 = N + 非构建容量（不再是固定全局上限）。 */
  get totalCapacity(): number {
    return this.buildCapacityValue + this.maxProcesses;
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
   * 未持 slot 时超出非构建上限抛 AgentBusyError（409 agent_busy）。
   * 同 key 重复注册替换旧进程（terminate 旧的）。
   *
   * 配额通道归属（B 案 §6）：build 槽 → 构建通道；background 槽 →
   * 后台通道；其余（含未持槽）→ 非构建通道，且 kind='build' 的无槽/
   * 通用槽注册沿用后台配额（既有行为保留——历史遗留路径不因三通道
   * 改造而失去容量约束）。
   */
  register(key: string, process: PiRpcProcess, kind: PoolEntry['kind'], slot?: PoolSlot): void {
    if (this.closed) {
      throw new Error('进程池已关闭');
    }
    this.evictExited();
    if (!slot) {
      const replacing = this.has(key);
      if (!replacing && this.nonBuildRunningCount() + this.reservations > this.maxProcesses) {
        throw new AgentBusyError(`Agent 进程数已达上限（${this.maxProcesses}），请稍后重试或停止其他会话`);
      }
    }
    let channel: PoolChannel;
    if (slot instanceof ReservationSlot) {
      channel = slot.channel;
    } else {
      channel = 'session';
    }
    // 兼容既有语义：kind='build' 且未走 build 槽 → 计入后台配额
    if (kind === 'build' && channel !== 'build') channel = 'background';
    // 消费预留：容量计数从「预留」转入下面的「已注册进程」（转移不触发
    // 晋升，避免 entries.set 前的瞬时空窗超卖）。
    if (slot instanceof ReservationSlot) slot.consume();
    else slot?.release();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      void existing.process.terminate();
    }
    this.busyKeys.delete(key);
    this.entries.set(key, { process, key, kind, channel, lastActiveAt: Date.now() });
    process.on('run_finished', () => this.touch(key));
    process.on('exit', () => {
      const current = this.entries.get(key);
      if (current && current.process === process) {
        if (current.idleTimer) clearTimeout(current.idleTimer);
        this.busyKeys.delete(key);
        this.entries.delete(key);
        this.pumpQueues();
      }
    });
    this.scheduleIdleTimer(key);
    // 替换旧进程可能腾出容量；晋升在条目落表之后进行。
    this.pumpQueues();
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
    this.pumpQueues();
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
    if (evicted) this.pumpQueues();
  }

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

  /** server close()：终止全部子进程并使后续 reserveSlot 失败。幂等。 */
  async closeAll(): Promise<void> {
    this.closed = true;
    this.reservations = 0;
    this.backgroundReservations = 0;
    this.buildReservations = 0;
    this.busyKeys.clear();
    // U9：清空两个等待队列——等待者全部拒绝，不得悬挂到进程退出之后。
    const waiters = [...this.waiters.splice(0), ...this.buildWaiters.splice(0)];
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
