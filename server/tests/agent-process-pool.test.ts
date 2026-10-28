/**
 * AgentProcessPool U9 准入排队单测（S1）：
 *  - acquire('background') FIFO 排队 / release 同步晋级队首
 *  - 排队等待者可被取消（AbortSignal），取消即出队不再占位
 *  - 后台合计并发 ≤ M−1（M≥2 为会话保留 1 槽；M=1 前后台互斥）
 *  - acquire('session') 立即语义：池满抛 AgentBusyError（显式不排队场景）
 *  - closeAll 清空队列；上限 1..6、默认 3
 *  - 既有 reserveSlot/register 语义不回归（消费转移、幂等 release）
 */

import { describe, expect, it } from 'vitest';
import { AgentBusyError, AgentProcessPool } from '../src/agent/agent-process-pool.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';

/** 最小假进程：只需 isExited/on/terminate/emit。 */
function fakeProcess(): PiRpcProcess & { emit(event: string): void } {
  const listeners = new Map<string, Array<() => void>>();
  let exited = false;
  const proc = {
    isExited: () => exited,
    on: (event: string, handler: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    terminate: async () => {
      exited = true;
    },
    emit: (event: string) => {
      for (const handler of listeners.get(event) ?? []) handler();
    },
  };
  return proc as unknown as PiRpcProcess & { emit(event: string): void };
}

describe('AgentProcessPool 配置范围（U9）', () => {
  it('默认上限 3；configure 钳制到 1..6', () => {
    const pool = new AgentProcessPool();
    expect(pool.max).toBe(3);
    pool.configure({ maxConcurrentProcesses: 9 });
    expect(pool.max).toBe(6);
    pool.configure({ maxConcurrentProcesses: 0 });
    expect(pool.max).toBe(1);
    pool.configure({ maxConcurrentProcesses: 4 });
    expect(pool.max).toBe(4);
  });

  it('构造参数超范围同样钳制', () => {
    expect(new AgentProcessPool({ maxConcurrentProcesses: 99 }).max).toBe(6);
    expect(new AgentProcessPool({ maxConcurrentProcesses: -3 }).max).toBe(1);
  });
});

describe('acquire FIFO 排队', () => {
  it('后台满额排队，release 后按 FIFO 晋级', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    // bgLimit = 1：第一个立即授槽，其余排队
    const first = await pool.acquire('background');
    expect(pool.queueDepth()).toBe(0);
    const second = pool.acquire('background');
    const third = pool.acquire('background');
    expect(pool.queueDepth()).toBe(2);
    // 未释放前不得授槽
    let secondState = 'pending';
    void second.then(() => { secondState = 'granted'; }, () => { secondState = 'rejected'; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondState).toBe('pending');
    first.release();
    const secondSlot = await second;
    expect(pool.queueDepth()).toBe(1);
    secondSlot.release();
    const thirdSlot = await third;
    thirdSlot.release();
    expect(pool.loadCount()).toBe(0);
  });

  it('排队等待者可被取消：出队拒绝（AbortError），不再占位', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const first = await pool.acquire('background');
    const controller = new AbortController();
    const cancelled = pool.acquire('background', { signal: controller.signal });
    const queued = pool.acquire('background');
    expect(pool.queueDepth()).toBe(2);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.queueDepth()).toBe(1);
    first.release();
    // 取消者不占位：队中只剩 queued，释放后直接晋级
    const queuedSlot = await queued;
    expect(pool.queueDepth()).toBe(0);
    queuedSlot.release();
  });

  it('signal 已中止：立即拒绝且不入队', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const first = await pool.acquire('background');
    const controller = new AbortController();
    controller.abort();
    await expect(pool.acquire('background', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.queueDepth()).toBe(0);
    first.release();
  });

  it('授槽后取消信号不影响已授出的槽（仍需显式 release）', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const slot = await pool.acquire('background');
    const controller = new AbortController();
    const queued = pool.acquire('background', { signal: controller.signal });
    slot.release();
    const granted = await queued;
    controller.abort(); // 已授槽，取消无效
    expect(pool.loadCount()).toBe(1);
    expect(() => granted.release()).not.toThrow();
    expect(pool.loadCount()).toBe(0);
  });

  it('closeAll 清空队列：等待者拒绝，后续 acquire 拒绝', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const first = await pool.acquire('background');
    void first;
    const waiter = pool.acquire('background');
    expect(pool.queueDepth()).toBe(1);
    await pool.closeAll();
    await expect(waiter).rejects.toThrow('进程池已关闭');
    expect(pool.queueDepth()).toBe(0);
    await expect(pool.acquire('background')).rejects.toThrow('进程池已关闭');
    await expect(pool.acquire('session')).rejects.toThrow('进程池已关闭');
  });
});

describe('后台配额与会话保留槽', () => {
  it('M≥2：后台合计 ≤ M−1，会话仍可立即占第 M 槽', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 3 });
    const background1 = await pool.acquire('background');
    const background2 = await pool.acquire('background');
    const waiter = pool.acquire('background'); // 后台满额（2=M−1）→ 排队
    expect(pool.queueDepth()).toBe(1);
    const sessionSlot = pool.reserveSlot(); // 第 3 槽为会话保留
    expect(sessionSlot).not.toBeNull();
    expect(pool.loadCount()).toBe(3);
    expect(pool.reserveSlot()).toBeNull(); // 池满：另一会话立即拒绝（既有语义）
    sessionSlot!.release();
    background1.release();
    const promoted = await waiter;
    expect(pool.queueDepth()).toBe(0);
    promoted.release();
    background2.release();
  });

  it('M=1：后台与前台互斥', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const background = await pool.acquire('background');
    expect(pool.reserveSlot()).toBeNull();
    await expect(pool.acquire('session')).rejects.toMatchObject({ name: 'AgentBusyError' });
    const waiter = pool.acquire('background');
    expect(pool.queueDepth()).toBe(1);
    background.release();
    const granted = await waiter;
    granted.release();
  });

  it("acquire('session') 空闲时立即授槽；loadCount 计入预留", async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const slot = await pool.acquire('session');
    expect(pool.loadCount()).toBe(1);
    slot.release();
    expect(pool.loadCount()).toBe(0);
  });

  it('register 消费后台槽：进程 exit 后释放配额并晋级队首', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const slot = await pool.acquire('background');
    const proc = fakeProcess();
    pool.register('build:b1', proc, 'build', slot);
    expect(pool.loadCount()).toBe(1);
    slot.release(); // 消费后的 release 幂等空操作
    expect(pool.loadCount()).toBe(1);
    const waiter = pool.acquire('background'); // bgLimit=1 已被注册条目占满 → 排队
    expect(pool.queueDepth()).toBe(1);
    proc.emit('exit');
    expect(pool.has('build:b1')).toBe(false);
    const promoted = await waiter;
    expect(pool.queueDepth()).toBe(0);
    promoted.release();
  });

  it("register kind='build'（通用槽）也计入后台配额", async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 3 });
    const legacySlot = pool.reserveSlot();
    expect(legacySlot).not.toBeNull();
    pool.register('build:legacy', fakeProcess(), 'build', legacySlot!);
    const background1 = await pool.acquire('background'); // 后台占用 2/2
    const waiter = pool.acquire('background');
    expect(pool.queueDepth()).toBe(1);
    // 第 3 槽仍可给会话（总数未满）
    const sessionSlot = pool.reserveSlot();
    expect(sessionSlot).not.toBeNull();
    sessionSlot!.release();
    background1.release();
    const promoted = await waiter;
    promoted.release();
  });

  it('terminate 释放容量并同步晋级', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const slot = await pool.acquire('background');
    pool.register('build:b1', fakeProcess(), 'build', slot);
    const waiter = pool.acquire('background');
    await pool.terminate('build:b1');
    const promoted = await waiter;
    promoted.release();
    expect(pool.loadCount()).toBe(0);
  });
});

describe('既有立即语义不回归（F3-R05）', () => {
  it('AgentBusyError 保留给显式不排队场景', () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const slot = pool.reserveSlot();
    expect(slot).not.toBeNull();
    expect(pool.reserveSlot()).toBeNull(); // 预留满：立即拒绝
    slot!.release();
    // register 未持槽且超限 → AgentBusyError（既有路径，边界为 > max：
    // 负载等于上限时不拒绝，超出后才拒绝——重构前后逐字一致）
    pool.register('k1', fakeProcess(), 'session');
    pool.register('k2', fakeProcess(), 'session'); // load=2（=max+1，历史宽容边界）
    expect(() => pool.register('k3', fakeProcess(), 'session')).toThrow(AgentBusyError);
  });

  it('configure 扩容立即放行队首；缩容不抢占已占槽', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const background1 = await pool.acquire('background');
    const waiter = pool.acquire('background'); // bgLimit=1 → 排队
    expect(pool.queueDepth()).toBe(1);
    pool.configure({ maxConcurrentProcesses: 4 }); // bgLimit=3，容量富余
    const promoted = await waiter;
    expect(pool.queueDepth()).toBe(0);
    promoted.release();
    background1.release();
    pool.configure({ maxConcurrentProcesses: 1 });
    expect(pool.loadCount()).toBe(0);
  });
});

describe('R2-05：retireIdle 只回收确为空闲的会话进程', () => {
  it('空闲会话回收；busy 会话与 task/build 后台进程不回收', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 6 });
    const sessionIdle = fakeProcess();
    const sessionBusy = fakeProcess();
    const taskProc = fakeProcess();
    pool.register('s-idle', sessionIdle, 'session');
    pool.register('s-busy', sessionBusy, 'session');
    pool.setBusy('s-busy', true);
    pool.register('task:t1', taskProc, 'build');

    await pool.retireIdle();
    expect(sessionIdle.isExited()).toBe(true); // 空闲会话被回收
    expect(sessionBusy.isExited()).toBe(false); // busy 会话保留
    expect(taskProc.isExited()).toBe(false); // task 进程不由 idle 回收管

    // 解除 busy 后会话可回收；task 进程仍只由 TaskService 生命周期终止
    pool.setBusy('s-busy', false);
    await pool.retireIdle();
    expect(sessionBusy.isExited()).toBe(true);
    expect(taskProc.isExited()).toBe(false);
    await pool.closeAll();
  });
});
