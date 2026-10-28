/**
 * SourceWriteLock — 源文档写互斥锁（S11，设计 §7.2/§7.3）。
 *
 * 作用域：单进程内按 objToken 串行化「SyncEngine 提交」与
 * 「SourceEditService 编辑/放弃修改」两类原始库写者，防止同步提交与
 * 本地编辑在 check-then-write 窗口内交错（设计 §9.1 不变量 1a：
 * 存在未写回本地修改时同步不得覆盖该文档）。
 *
 * 非目标：跨进程互斥（server 是唯一原始库写进程，Electron 内嵌运行，
 * CLI/S13 均经 HTTP API 访问同一进程）；文件级原子性由 atomicWriteFile
 * 的同目录临时文件 + rename 提供。
 *
 * SyncEngine 每请求在 routes/sync.ts 构造，无法经 DI 拿到服务级单例，
 * 因此导出 sharedSourceWriteLock 作为进程级共享实例——SyncEngine 默认
 * 使用它，SourceEditService 构造时若未注入 locks 也回落到它，保证两侧
 * 拿到同一把锁。测试可注入独立实例隔离。
 *
 * tails 条目按 objToken 常驻（每 token 至多一个已 settle 的哑 Promise），
 * 上限为文档数，不随编辑次数增长。
 */

/** 最小锁接口：SyncEngine / SourceEditService 共用，便于测试替身。 */
export interface SourceWriteLockLike {
  withLock<T>(objToken: string, fn: () => T | Promise<T>): Promise<T>;
}

export class SourceWriteLock implements SourceWriteLockLike {
  /** 每个 objToken 的等待队列尾（Promise 链），FIFO 排队。 */
  private tails = new Map<string, Promise<unknown>>();
  /** 每个 objToken 当前正在执行（含 await 中）的临界区数量。 */
  private active = new Map<string, number>();

  /**
   * 在 objToken 锁内执行 fn：后续入队者等待前一个完成（含异常）。
   * fn 抛错时锁照样释放，错误原样传播给调用方。
   */
  async withLock<T>(objToken: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(objToken) ?? Promise.resolve();
    const run = (async () => {
      await previous.catch(() => {
        /* 前任失败不阻塞后续入队者；错误已由前任调用方接收 */
      });
      this.active.set(objToken, (this.active.get(objToken) ?? 0) + 1);
      try {
        return await fn();
      } finally {
        const remaining = (this.active.get(objToken) ?? 1) - 1;
        if (remaining > 0) this.active.set(objToken, remaining);
        else this.active.delete(objToken);
      }
    })();
    // 先占位再执行：并发入队时保证 FIFO 顺序。
    this.tails.set(objToken, run.catch(() => undefined));
    return await run;
  }

  /** 该 objToken 是否仍有正在执行的临界区（诊断/测试用）。 */
  isLocked(objToken: string): boolean {
    return this.active.has(objToken);
  }
}

/** 进程级共享实例：SyncEngine 与 SourceEditService 的默认锁。 */
export const sharedSourceWriteLock = new SourceWriteLock();
