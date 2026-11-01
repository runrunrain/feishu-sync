/**
 * R2-F10-01/02 正式回归（真实 OS；源自 R2 审核 residual-probe 反例
 * UNBOUND_ANCHOR / SHUTDOWN_UNBOUND / UNREADABLE_SCAN 的转正）：
 *
 * - UNBOUND_ANCHOR：binding 不可得 + 账本缺失（登记集空）+ 合法锚点 +
 *   running v2-store + 真实存活 root → 旧缺陷把锚点 leaderPids 过滤丢弃、
 *   byPid 空直接假 confirmed；修复后 home 私有事实逐个体对账：root 存活、
 *   令牌匹配、生产无注入出口 → unconfirmed 零信号（裁决 #5）。
 * - SHUTDOWN_UNBOUND：同一现场经 reconcileBuildRootResiduals（shutdown
 *   持久事实扫描 scanDiskResidualFacts 的同一只读链，binding:null）→
 *   unconfirmed 贯穿消费者（quiesced 判据的输入不再被假 confirmed 下调）。
 * - UNREADABLE_SCAN：amagi/data/process-audits / amagi/v2-store 被占位为
 *   普通文件（readdir ENOTDIR）→ degraded fail-closed unconfirmed，不能
 *   当空、note 不再声称「无派发意图」。
 * - 登记集空的已退出 root 正例：真实 ps 逐个体探测 → exited（确证退出
 *   经过目标个体探测，不是 filter 空的 confirmed）。
 *
 * 信号纪律：测试只向自己持有的 ChildProcess 句柄发信号；未知/历史 PID
 * 零信号（与生产裁决 #5 同口径）。
 */
import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileResidualProcesses } from '../src/agent/build-runtime/process-residual.js';
import { reconcileBuildRootResiduals } from '../src/agent/build-runtime/adapter.js';
import { readBirthIdentities } from '../src/agent/build-runtime/process-identity.js';

const isPosix = (): boolean => process.platform === 'darwin' || process.platform === 'linux';

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scan-recovery-'));
}

/** 只用本测试持有的 ChildProcess 句柄回收（未知/历史 PID 零信号纪律）。 */
async function reapOwned(owned: ChildProcess | null): Promise<void> {
  if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
  try {
    owned.kill('SIGTERM');
    await Promise.race([once(owned, 'exit'), new Promise((resolve) => { setTimeout(resolve, 2_000).unref?.(); })]);
    if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
    await Promise.race([once(owned, 'exit'), new Promise((resolve) => { setTimeout(resolve, 2_000).unref?.(); })]);
  } catch { /* 已退出 */ }
}

/** UNBOUND 现场：合法锚点（真实出生令牌）+ running v2-store；无账本、无 binding。 */
async function makeUnboundFixture(root: string, buildId: string): Promise<{ homeDir: string; buildRoot: string; owned: ChildProcess; ownedPid: number }> {
  const buildRoot = path.join(root, 'agent', 'builds', buildId);
  const homeDir = path.join(buildRoot, 'epochs', 'e1', 'home');
  const owned = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], { detached: true, stdio: 'ignore' });
  const ownedPid = owned.pid!;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(pidAlive(ownedPid)).toBe(true);
  const tokens = await readBirthIdentities([ownedPid]);
  const token = tokens.get(ownedPid);
  expect(token).toBeTruthy(); // 真实内核出生令牌（darwin libproc / linux procfs）
  const audits = path.join(homeDir, 'amagi', 'data', 'process-audits', 'task_unbound');
  fs.mkdirSync(audits, { recursive: true });
  fs.writeFileSync(path.join(audits, 'launch-anchor.json'), JSON.stringify({
    version: 1,
    taskId: 'task_unbound',
    runs: [{ backendRunId: 'run_u', rootPid: ownedPid, pgid: ownedPid, rootIdentityToken: token, leaderPid: process.pid, at: Date.now() }],
  }));
  const v2dir = path.join(homeDir, 'amagi', 'v2-store', 'task_unbound');
  fs.mkdirSync(v2dir, { recursive: true });
  fs.writeFileSync(path.join(v2dir, 'current.json'), JSON.stringify({ taskId: 'task_unbound', execution: 'running', processState: 'alive' }));
  // 故意不写 process-ledger.json、不传 binding：登记集为空（原反例触发条件）
  return { homeDir, buildRoot, owned, ownedPid };
}

describe('R2-F10-01/02：真实 OS 残留对账反例回归', () => {
  it.runIf(isPosix())('UNBOUND_ANCHOR：登记集空 + 合法锚点 + running v2-store + 存活 root → unconfirmed 零信号（不假 confirmed）', async () => {
    const root = tmpRoot();
    let owned: ChildProcess | null = null;
    try {
      const fixture = await makeUnboundFixture(root, 'b_unbound');
      owned = fixture.owned;
      const outcome = await reconcileResidualProcesses(
        { homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set<number>() },
        { reap: true },
      );
      // 旧缺陷：锚点被 leaderPids 过滤丢弃 → byPid 空 → confirmed（假收口）。
      // 修复后：锚点按 home 私有事实逐个体对账——存活+令牌匹配+生产无注入
      // 出口 → 如实 unconfirmed（历史/仅数字 PID 目标零信号）。
      expect(outcome.state).toBe('unconfirmed');
      const finding = outcome.children.find((child) => child.pid === fixture.ownedPid);
      expect(finding).toMatchObject({ verdict: 'unconfirmed', proof: 'birth-token', source: 'anchor' });
      expect(pidAlive(fixture.ownedPid)).toBe(true); // 未被发信号
    } finally {
      await reapOwned(owned); // 只清理本测试自有句柄
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(isPosix())('SHUTDOWN_UNBOUND：同一现场经 reconcileBuildRootResiduals（shutdown 磁盘对账链，binding:null）→ unconfirmed 贯穿消费者', async () => {
    const root = tmpRoot();
    let owned: ChildProcess | null = null;
    try {
      const fixture = await makeUnboundFixture(root, 'b_unbound2');
      owned = fixture.owned;
      // scanDiskResidualFacts 逐构建调用的同一只读链（reap:false, binding:null）
      const outcome = await reconcileBuildRootResiduals(
        { buildId: 'b_unbound2', buildRoot: fixture.buildRoot, binding: null },
        { reap: false, includeLeaders: false },
      );
      expect(outcome).not.toBeNull();
      expect(outcome?.state).toBe('unconfirmed'); // shutdown 据此 quiesced=false、保留 home
      expect(outcome?.children.some((child) => child.pid === fixture.ownedPid && child.verdict === 'unconfirmed')).toBe(true);
      expect(pidAlive(fixture.ownedPid)).toBe(true);
    } finally {
      await reapOwned(owned);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(isPosix())('UNREADABLE_SCAN：audits / v2-store 目录被占位为普通文件（ENOTDIR）→ degraded fail-closed，不当空、不称无派发', async () => {
    const root = tmpRoot();
    try {
      // 场景 A：process-audits 本身是普通文件 → readdir ENOTDIR
      const homeA = path.join(root, 'homeA');
      fs.mkdirSync(path.join(homeA, 'amagi', 'data'), { recursive: true });
      fs.writeFileSync(path.join(homeA, 'amagi', 'data', 'process-audits'), 'not-a-dir');
      const outcomeA = await reconcileResidualProcesses({ homeDir: homeA, buildRoot: path.join(root, 'buildA'), leaderPids: new Set<number>([process.pid]) }, { reap: true });
      expect(outcomeA.state).toBe('unconfirmed');
      expect(outcomeA.children.some((child) => child.source === 'anchor' && child.detail.includes('不可枚举'))).toBe(true);

      // 场景 B：v2-store 是普通文件 → readdir ENOTDIR（旧实现当空 + note 声称无派发意图）
      const homeB = path.join(root, 'homeB');
      fs.mkdirSync(path.join(homeB, 'amagi'), { recursive: true });
      fs.writeFileSync(path.join(homeB, 'amagi', 'v2-store'), 'not-a-dir');
      const outcomeB = await reconcileResidualProcesses({ homeDir: homeB, buildRoot: path.join(root, 'buildB'), leaderPids: new Set<number>([process.pid]) }, { reap: true });
      expect(outcomeB.state).toBe('unconfirmed');
      expect(outcomeB.children.some((child) => child.source === 'v2-store' && child.detail.includes('不可枚举'))).toBe(true);
      expect(outcomeB.note).not.toContain('无派发意图');

      // 场景 C：经 adapter（shutdown 消费链）读失败同样贯穿总体 state
      const buildRootC = path.join(root, 'agent', 'builds', 'b_unread');
      const homeC = path.join(buildRootC, 'epochs', 'e1', 'home');
      fs.mkdirSync(path.join(homeC, 'amagi'), { recursive: true });
      fs.writeFileSync(path.join(homeC, 'amagi', 'v2-store'), 'not-a-dir');
      const outcomeC = await reconcileBuildRootResiduals({ buildId: 'b_unread', buildRoot: buildRootC, binding: null }, { reap: false, includeLeaders: false });
      expect(outcomeC?.state).toBe('unconfirmed');
      expect(outcomeC?.note).toContain('v2-store 目录不可枚举');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(isPosix())('登记集空的已退出 root 正例：真实 ps 逐个体探测 → exited（确证退出经目标个体探测，非 filter 空）', async () => {
    const root = tmpRoot();
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await once(dead, 'exit');
    const deadPid = dead.pid!;
    try {
      const homeDir = path.join(root, 'home');
      const buildRoot = path.join(root, 'build');
      const audits = path.join(homeDir, 'amagi', 'data', 'process-audits', 'task_dead');
      fs.mkdirSync(audits, { recursive: true });
      fs.writeFileSync(path.join(audits, 'launch-anchor.json'), JSON.stringify({
        version: 1,
        taskId: 'task_dead',
        runs: [{ backendRunId: 'run_d', rootPid: deadPid, pgid: deadPid, rootIdentityToken: 'darwin:1:1', leaderPid: process.pid, at: Date.now() }],
      }));
      // 登记集空 + 锚点 root 已退出：逐个体探测（真实 ps）→ exited/复用排除
      const outcome = await reconcileResidualProcesses({ homeDir, buildRoot, leaderPids: new Set<number>() }, { reap: true });
      const finding = outcome.children.find((child) => child.pid === deadPid);
      expect(finding).toBeTruthy(); // 个体确实被对账（不是 filter 空的 confirmed）
      expect(['exited', 'not-ours']).toContain(finding?.verdict);
      expect(outcome.state).toBe('confirmed'); // 探测性结论（退出/复用排除）都是确认性的
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
