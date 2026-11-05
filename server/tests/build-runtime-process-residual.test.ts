/**
 * F10 残留核对/回收单元测试（注入 ps/出生令牌/信号出口；不依赖真实 amagi）。
 *
 * 覆盖判定矩阵：exited / reaped(birth-token) / reaped(pgid-invariant) /
 * not-ours（pid 复用绝不发信号）/ unconfirmed（无证明不发信号）；观察模式
 * 不发信号；进程表不可得全 unconfirmed；Windows 平台能力诚实；组员回收；
 * 账本 Leader 个体三级对账。
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendProcessLedgerEntry, commandFingerprint, markLedgerExit, patchLedgerBirthToken, readProcessLedger } from '../src/agent/build-runtime/process-ledger.js';
import { reconcileResidualProcesses, scanLaunchAnchors, listBuildHomeDirs, findAliveLedgerLeaders, type AnchorRun, type ResidualDeps } from '../src/agent/build-runtime/process-residual.js';
import { readBirthIdentities, type ProcTableRow } from '../src/agent/build-runtime/process-identity.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'residual-test-'));
}

interface Fixture {
  root: string;
  homeDir: string;
  buildRoot: string;
  leaderPid: number;
  table: ProcTableRow[];
  tokens: Map<number, string>;
  signals: Array<{ pid: number; signal: string }>;
  alive: Set<number>;
  deps: ResidualDeps;
}

/** 个体进程表行 + 出生令牌 + 信号记录的最小装置。 */
function makeFixture(overrides: { platform?: NodeJS.Platform } = {}): Fixture {
  const root = tmpRoot();
  const homeDir = path.join(root, 'epochs', 'e1', 'home');
  const buildRoot = path.join(root, 'agent', 'builds', 'b_test01');
  fs.mkdirSync(path.join(homeDir, 'amagi', 'data', 'process-audits'), { recursive: true });
  const fixture: Fixture = {
    root, homeDir, buildRoot,
    leaderPid: 4100,
    table: [], tokens: new Map(), signals: [], alive: new Set(),
    deps: {
      platform: overrides.platform ?? 'darwin',
      runPs: async () => null,
      probeBirthTokens: async () => new Map(),
      // 默认装置：个体收到信号即退出（模拟服从 TERM 的普通进程）；
      // 需要模拟顽固进程时在用例内覆写。
      kill: (pid, signal) => {
        fixture.signals.push({ pid, signal });
        fixture.alive.delete(pid);
      },
      isAlive: (pid) => fixture.alive.has(pid),
      sleep: async () => undefined,
      now: () => 1_700_000_000_000,
      reapGraceMs: 1,
    },
  };
  return fixture;
}

function addProcess(fixture: Fixture, pid: number, overrides: Partial<ProcTableRow> = {}, token?: string): void {
  fixture.table.push({ pid, ppid: 1, pgid: pid, uid: 501, elapsedSec: 10, comm: '/usr/local/bin/node', ...overrides });
  fixture.alive.add(pid);
  if (token) fixture.tokens.set(pid, token);
  fixture.deps.runPs = async () => {
    const header = fixture.table.filter((row) => fixture.alive.has(row.pid))
      .map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${row.uid} 10:00 ${row.comm ?? 'node'}`)
      .join('\n');
    return header.length > 0 ? header : '1 0 1 0 10:00 launchd';
  };
  fixture.deps.probeBirthTokens = async (pids) => {
    const out = new Map<number, string>();
    for (const pid of pids) {
      const token = fixture.tokens.get(pid);
      if (token && fixture.alive.has(pid)) out.set(pid, token);
    }
    return out;
  };
}

/** 写一个 amagi 形状的 launch-anchor。 */
function writeAnchor(fixture: Fixture, taskId: string, run: Partial<AnchorRun> & { rootPid: number }): void {
  const dir = path.join(fixture.homeDir, 'amagi', 'data', 'process-audits', taskId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    version: 1,
    taskId,
    runs: [{
      backendRunId: `run_${taskId}`,
      rootPid: run.rootPid,
      ...(run.pgid !== undefined ? { pgid: run.pgid } : {}),
      ...(run.rootIdentityToken ? { rootIdentityToken: run.rootIdentityToken } : {}),
      leaderPid: run.leaderPid ?? fixture.leaderPid,
      at: run.at ?? 1_699_999_000_000,
    }],
  };
  fs.writeFileSync(path.join(dir, 'launch-anchor.json'), JSON.stringify(body));
}

const LEADER_PIDS = () => new Set<number>([4100]);

describe('scanLaunchAnchors', () => {
  it('解析真实形状锚点；目录缺失 → 空（旧版 amagi 如实无线索）', () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 'task-abc', { rootPid: 5000, pgid: 5000, rootIdentityToken: 'darwin:111:222' });
    const scan = scanLaunchAnchors(fixture.homeDir);
    expect(scan.files).toBe(1);
    expect(scan.untrusted).toBe(false);
    expect(scan.runs).toHaveLength(1);
    expect(scan.runs[0]).toMatchObject({ taskId: 'task-abc', rootPid: 5000, pgid: 5000, rootIdentityToken: 'darwin:111:222', leaderPid: 4100 });

    const empty = scanLaunchAnchors(path.join(fixture.root, 'missing-home'));
    expect(empty).toEqual({ runs: [], untrusted: false, degraded: false, files: 0 });
  });

  it('损坏/形状非法/超上限截断 → untrusted（证据不全）', () => {
    const fixture = makeFixture();
    const dir = path.join(fixture.homeDir, 'amagi', 'data', 'process-audits', 'corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'launch-anchor.json'), '{ not json');
    const dropped = path.join(fixture.homeDir, 'amagi', 'data', 'process-audits', 'dropped');
    fs.mkdirSync(dropped, { recursive: true });
    fs.writeFileSync(path.join(dropped, 'launch-anchor.json'), JSON.stringify({ version: 1, taskId: 'dropped', runs: [{ rootPid: 5, leaderPid: 4100, at: 1 }], droppedRuns: 2 }));
    const scan = scanLaunchAnchors(fixture.homeDir);
    expect(scan.untrusted).toBe(true);
    expect(scan.runs).toHaveLength(1); // dropped 锚点的 run 仍可读，但整体不可信
  });
});

describe('reconcileResidualProcesses 判定矩阵', () => {
  it('pid 不在进程表 → exited（含已完成个体）', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-done', { rootPid: 5001 });
    addProcess(fixture, 9999); // 无关个体
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('confirmed');
    expect(outcome.children).toHaveLength(1);
    expect(outcome.children[0].verdict).toBe('exited');
    expect(fixture.signals).toHaveLength(0);
  });

  it('出生令牌匹配 → 回收（TERM→复核→退出确认）；观察模式不发信号', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-live', { rootPid: 5002, pgid: 5002, rootIdentityToken: 'darwin:100:1' });
    addProcess(fixture, 5002, { pgid: 5002 }, 'darwin:100:1');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('confirmed');
    expect(outcome.children[0]).toMatchObject({ pid: 5002, verdict: 'reaped', proof: 'birth-token' });
    expect(fixture.signals.some((entry) => entry.pid === 5002 && entry.signal === 'SIGTERM')).toBe(true);
    // 模拟进程响应 TERM 退出后的观察模式：另一个仍存活的归属个体 → 归属已证明但不杀
    writeAnchor(fixture, 't-live2', { rootPid: 5012, pgid: 5012, rootIdentityToken: 'darwin:100:12' });
    addProcess(fixture, 5012, { pgid: 5012 }, 'darwin:100:12');
    const observed = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: false }, fixture.deps);
    expect(observed.children.find((child) => child.pid === 5012)?.verdict).toBe('unconfirmed'); // 观察模式：归属证明但不杀
    expect(fixture.signals.some((entry) => entry.pid === 5012)).toBe(false);
  });

  it('出生令牌不匹配（pid 复用）→ not-ours，绝不发信号', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-reuse', { rootPid: 5003, pgid: 5003, rootIdentityToken: 'darwin:100:1' });
    // 当前同 pid 进程是复用后的无关个体（不同出生令牌、普通进程组）
    addProcess(fixture, 5003, { pgid: 1, comm: '/usr/sbin/sshd' }, 'darwin:999:9');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('confirmed');
    expect(outcome.children[0]).toMatchObject({ verdict: 'not-ours', proof: 'birth-token' });
    expect(fixture.signals).toHaveLength(0);
  });

  it('无出生令牌：同 PID/PGID 的 node 形进程也不降级回收（不是本次启动身份）→ unconfirmed 零信号', async () => {
    const fixture = makeFixture();
    // 无关 detached node 进程恰好占用了旧锚点的 PID/PGID（可执行名与组长不变量都吻合）
    writeAnchor(fixture, 't-pgid', { rootPid: 5004, pgid: 5004 }); // 无 rootIdentityToken
    addProcess(fixture, 5004, { pgid: 5004, comm: '/usr/local/bin/node' });
    writeAnchor(fixture, 't-nopgid', { rootPid: 5005, pgid: 5005 });
    addProcess(fixture, 5005, { pgid: 777, comm: '/usr/sbin/sshd' });
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const byPid = new Map(outcome.children.map((child) => [child.pid, child]));
    expect(byPid.get(5004)).toMatchObject({ verdict: 'unconfirmed', proof: 'none' });
    expect(byPid.get(5005)).toMatchObject({ verdict: 'unconfirmed', proof: 'none' });
    expect(outcome.state).toBe('unconfirmed');
    expect(fixture.signals).toHaveLength(0); // 零信号：pgid+可执行名不构成本次启动身份
  });

  it('进程表不可得（ps 失败/Windows）→ 全部 unconfirmed，不发信号', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const fixture = makeFixture({ platform });
      writeAnchor(fixture, 't-x', { rootPid: 5006, pgid: 5006, rootIdentityToken: 'darwin:1:1' });
      if (platform === 'darwin') {
        fixture.deps.runPs = async () => null; // ps 失败
      } else {
        fixture.deps.runPs = async () => { throw new Error('unexpected'); };
      }
      const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
      expect(outcome.state).toBe('unconfirmed');
      expect(outcome.children[0].verdict).toBe('unconfirmed');
      expect(fixture.signals).toHaveLength(0);
    }
  });

  it('R2-F10-01：登记集非空时锚点 leaderPid 不属本构建 → 归属不明如实 unconfirmed（不纳入对账与信号集合）', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-foreign', { rootPid: 5007, leaderPid: 9999 });
    addProcess(fixture, 5007); // 个体在表内也不探测/不发信号（归属不明不进可信号集合）
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children).toHaveLength(1);
    expect(outcome.children[0]).toMatchObject({ taskId: 't-foreign', pid: 5007, verdict: 'unconfirmed', proof: 'none' });
    expect(outcome.children[0]?.detail).toContain('归属不明');
    expect(fixture.signals).toHaveLength(0); // 绝不对归属不明的 run 发信号
    expect(fixture.alive.has(5007)).toBe(true);
  });

  it('顽固个体：TERM 后仍存活且身份复核成立 → SIGKILL 后确认；身份复核失败 → 停手 unconfirmed', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-stubborn', { rootPid: 5010, pgid: 5010, rootIdentityToken: 'darwin:100:10' });
    addProcess(fixture, 5010, { pgid: 5010 }, 'darwin:100:10');
    // TERM 不退出（kill 不改 alive），首信号前与 KILL 前复核令牌均匹配 → SIGKILL → 退出
    let killed = false;
    fixture.deps.kill = (pid, signal) => {
      fixture.signals.push({ pid, signal });
      if (signal === 'SIGKILL') { killed = true; fixture.alive.delete(pid); }
    };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.children[0]).toMatchObject({ verdict: 'reaped', proof: 'birth-token' });
    expect(killed).toBe(true);
    expect(fixture.signals.filter((entry) => entry.pid === 5010).map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGKILL']);

    // 身份复核失败（首信号前探测失效）→ 零信号、unconfirmed
    const fixture2 = makeFixture();
    writeAnchor(fixture2, 't-lose-proof', { rootPid: 5011, pgid: 5011, rootIdentityToken: 'darwin:100:11' });
    addProcess(fixture2, 5011, { pgid: 5011 }, 'darwin:100:11');
    fixture2.deps.kill = (pid, signal) => { fixture2.signals.push({ pid, signal }); };
    const originalProbe = fixture2.deps.probeBirthTokens;
    let probeCalls = 0;
    fixture2.deps.probeBirthTokens = async (pids) => {
      probeCalls += 1;
      // 首轮 readBirthIdentities 双采样（前两次调用）可用；回收路径 fresh 复核失效
      return probeCalls <= 2 ? originalProbe!(pids) : new Map();
    };
    const outcome2 = await reconcileResidualProcesses({ homeDir: fixture2.homeDir, buildRoot: fixture2.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture2.deps);
    expect(outcome2.children[0].verdict).toBe('unconfirmed');
    expect(fixture2.signals).toHaveLength(0); // 首信号前复核失败 → 零信号
  });

  it('身份在初次采样后/首 TERM 前改变（pid 换人）→ 零信号', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-swap', { rootPid: 5013, pgid: 5013, rootIdentityToken: 'darwin:100:13' });
    addProcess(fixture, 5013, { pgid: 5013 }, 'darwin:100:13');
    const originalProbe = fixture.deps.probeBirthTokens;
    let probeCalls = 0;
    fixture.deps.probeBirthTokens = async (pids) => {
      probeCalls += 1;
      // 分类快照（前两次调用）命中锚点令牌；此后同 pid 已被无关进程复用（不同令牌）
      if (probeCalls <= 2) return originalProbe!(pids);
      const out = new Map<number, string>();
      for (const pid of pids) if (fixture.alive.has(pid)) out.set(pid, 'darwin:999:swap');
      return out;
    };
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.children[0].verdict).toBe('unconfirmed');
    expect(fixture.signals).toHaveLength(0); // 首 TERM 前发现换人 → 一个信号都不发
  });

  it('组员（孙进程/桥）预录自身 birth 后逐信号复核回收；成员 PID 复用 → 不杀', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-group', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'darwin:100:9'); // 桥/孙进程
    // TERM 即退（装置语义：收到 TERM 即退出）
    fixture.deps.kill = (pid, signal) => {
      fixture.signals.push({ pid, signal });
      fixture.alive.delete(pid);
    };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const reaped = outcome.children.filter((child) => child.verdict === 'reaped').map((child) => child.pid).sort();
    expect(reaped).toEqual([5008, 5009]);
    expect(outcome.state).toBe('confirmed');

    // 成员 PID 复用：预录令牌 T1，成员信号前同 pid 已换人（令牌变化）→ 不杀该成员
    const fixture2 = makeFixture();
    writeAnchor(fixture2, 't-group2', { rootPid: 6008, pgid: 6008, rootIdentityToken: 'darwin:200:8' });
    addProcess(fixture2, 6008, { pgid: 6008 }, 'darwin:200:8');
    addProcess(fixture2, 6009, { ppid: 6008, pgid: 6008 }, 'darwin:200:9');
    const originalProbe2 = fixture2.deps.probeBirthTokens;
    let rootReaped = false;
    fixture2.deps.probeBirthTokens = async (pids) => {
      const base = await originalProbe2!(pids);
      if (rootReaped && pids.includes(6009)) {
        // 根已回收后：成员 pid 已被无关进程复用（令牌不同）
        const out = new Map<number, string>(base);
        if (out.has(6009)) out.set(6009, 'darwin:999:reuse');
        return out;
      }
      return base;
    };
    fixture2.deps.kill = (pid, signal) => {
      fixture2.signals.push({ pid, signal });
      fixture2.alive.delete(pid);
      if (pid === 6008) rootReaped = true;
    };
    const outcome2 = await reconcileResidualProcesses({ homeDir: fixture2.homeDir, buildRoot: fixture2.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture2.deps);
    const memberFinding = outcome2.children.find((child) => child.pid === 6009);
    expect(memberFinding).toMatchObject({ verdict: 'unconfirmed', proof: 'birth-token' });
    expect(fixture2.signals.some((entry) => entry.pid === 6009)).toBe(false); // 复用成员零信号
    expect(fixture2.signals.some((entry) => entry.pid === 6008)).toBe(true); // 根自身照常回收
  });
});

describe('v2-store 派发意图扫描（spawn→锚点窗口硬崩/旧版 amagi）', () => {
  function writeV2Current(fixture: ReturnType<typeof makeFixture>, taskId: string, current: { execution?: string; processState?: string; startedAt?: string | null; backendRunId?: string | null } | null): void {
    const dir = path.join(fixture.homeDir, 'amagi', 'v2-store', taskId);
    fs.mkdirSync(dir, { recursive: true });
    if (current === null) {
      fs.writeFileSync(path.join(dir, 'broken.json'), 'x'); // 目录存在但无 current.json
      return;
    }
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ taskId, ...current }));
  }

  it('queued/not-started也可能是fork后锚点前硬崩，不能凭缺PID与空进程表确认退出', async () => {
    const fixture = makeFixture();
    writeV2Current(fixture, 'task-fork-gap', {
      execution: 'queued', processState: 'not-started', startedAt: null, backendRunId: null,
    });
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children).toContainEqual(expect.objectContaining({ taskId: 'task-fork-gap', pid: 0, verdict: 'unconfirmed' }));
    expect(fixture.signals).toHaveLength(0);
  });

  it('完整原生初始排队记录证明尚未取得启动许可；有启动意图或状态已推进仍阻断', async () => {
    const fixture = makeFixture();
    const current = { version: 1, taskId: 'native-queued', specId: 'native-queued', ownerId: 'leader',
      stateSeq: 1, revision: 0, queuedAt: Date.now(), execution: 'queued', processState: 'not-started' };
    writeV2Current(fixture, 'native-queued', current);
    const input = { homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() };
    expect((await reconcileResidualProcesses(input, { reap: true }, fixture.deps)).state).toBe('confirmed');
    for (const change of [{ launchIntent: { at: Date.now(), nonce: 'intent' } }, { stateSeq: 3 }, { execution: 'running' }]) {
      writeV2Current(fixture, 'native-queued', { ...current, ...change });
      expect((await reconcileResidualProcesses(input, { reap: true }, fixture.deps)).state).toBe('unconfirmed');
    }
    expect(fixture.signals).toHaveLength(0);
  });

  it('活跃任务无锚点覆盖 → 不假 confirmed（个体不可发现即不可证明无残留）', async () => {
    const fixture = makeFixture();
    writeV2Current(fixture, 'task-noanchor', { execution: 'running', processState: 'alive' });
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    const gap = outcome.children.find((child) => child.source === 'v2-store');
    expect(gap?.taskId).toBe('task-noanchor');
    expect(gap?.detail).toContain('无锚点覆盖');
    expect(fixture.signals).toHaveLength(0);
  });

  it('活跃任务被锚点覆盖 → 按个体对账（不因意图缺口误报）', async () => {
    const fixture = makeFixture();
    writeV2Current(fixture, 'task-anchored', { execution: 'running', processState: 'alive' });
    writeAnchor(fixture, 'task-anchored', { rootPid: 7001, pgid: 7001, rootIdentityToken: 'darwin:300:1' });
    addProcess(fixture, 7001, { pgid: 7001 }, 'darwin:300:1');
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('confirmed');
    expect(outcome.children.find((child) => child.pid === 7001)).toMatchObject({ verdict: 'reaped' });
    expect(outcome.children.some((child) => child.source === 'v2-store')).toBe(false);
  });

  it('无 v2-store 且无锚点 → 无派发意图，confirmed（无任务即无子进程可残留）', async () => {
    const fixture = makeFixture();
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('confirmed');
    expect(outcome.note).toContain('无派发意图');
  });

  it('终态任务/已退出进程不触发缺口；状态不可读 → unconfirmed', async () => {
    const fixture = makeFixture();
    writeV2Current(fixture, 'task-done', { execution: 'done', processState: 'exited' });
    const okOutcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(okOutcome.state).toBe('confirmed');

    writeV2Current(fixture, 'task-broken', null);
    const badOutcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(badOutcome.state).toBe('unconfirmed');
    expect(badOutcome.children.some((child) => child.taskId === 'task-broken')).toBe(true);
  });
});

describe('账本 Leader 个体对账（应用重启句柄丢失补偿）', () => {
  it('birthToken 匹配 → 回收；不匹配 → not-ours；缺令牌 → unconfirmed', async () => {
    const fixture = makeFixture();
    appendProcessLedgerEntry(fixture.buildRoot, {
      launchId: 'l_a', buildId: 'b_test01', runtimeEpoch: 1, generation: 1, kind: 'leader',
      pid: 6001, startedAt: new Date().toISOString(), cwd: '/w', birthToken: 'darwin:200:1',
    });
    appendProcessLedgerEntry(fixture.buildRoot, {
      launchId: 'l_b', buildId: 'b_test01', runtimeEpoch: 1, generation: 1, kind: 'leader',
      pid: 6002, startedAt: new Date().toISOString(), cwd: '/w', birthToken: 'darwin:200:2',
    });
    appendProcessLedgerEntry(fixture.buildRoot, {
      launchId: 'l_c', buildId: 'b_test01', runtimeEpoch: 1, generation: 1, kind: 'leader',
      pid: 6003, startedAt: new Date().toISOString(), cwd: '/w',
    });
    addProcess(fixture, 6001, { pgid: 100 }, 'darwin:200:1');   // 归属成立
    addProcess(fixture, 6002, { pgid: 100 }, 'darwin:777:7');   // pid 复用
    addProcess(fixture, 6003, { pgid: 100 });                    // 无令牌可比
    const outcome = await reconcileResidualProcesses(
      { homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set<number>([6001, 6002, 6003]), includeLeaderEntries: true },
      { reap: true }, fixture.deps,
    );
    const byPid = new Map(outcome.children.map((child) => [child.pid, child]));
    expect(byPid.get(6001)).toMatchObject({ verdict: 'reaped', proof: 'birth-token' });
    expect(byPid.get(6002)).toMatchObject({ verdict: 'not-ours', proof: 'birth-token' });
    expect(byPid.get(6003)).toMatchObject({ verdict: 'unconfirmed', proof: 'none' });
    expect(outcome.state).toBe('unconfirmed');
    expect(fixture.signals.some((entry) => entry.pid === 6002)).toBe(false);
  });

  it('已登记退出的 Leader 条目不重复对账（exit 标记生效）', async () => {
    const fixture = makeFixture();
    appendProcessLedgerEntry(fixture.buildRoot, {
      launchId: 'l_done', buildId: 'b_test01', runtimeEpoch: 1, generation: 1, kind: 'leader',
      pid: 6100, startedAt: new Date().toISOString(), cwd: '/w',
    });
    markLedgerExit(fixture.buildRoot, 'l_done', 'leader', { code: 0, signal: null });
    addProcess(fixture, 6100); // 即使 pid 仍被复用占用，条目已收口
    const outcome = await reconcileResidualProcesses(
      { homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set<number>([6100]), includeLeaderEntries: true },
      { reap: true }, fixture.deps,
    );
    expect(outcome.children).toHaveLength(0);
  });
});

describe('F10-R1/R2：根退出同组存活成员与组员归属时序证明', () => {
  it('R1（注入）：根 pid 不在进程表但同组存活成员在 → 根 exited + 成员 unconfirmed，零信号不假 confirmed', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-rootdead', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    // 根已退出（不在表）；同组桥/孙进程仍活（普通同组遗留，无需 setsid 逃逸）
    addProcess(fixture, 5009, { ppid: 1, pgid: 5008 }, 'darwin:100:9');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const byPid = new Map(outcome.children.map((child) => [child.pid, child]));
    expect(byPid.get(5008)).toMatchObject({ verdict: 'exited' });
    expect(byPid.get(5008)?.detail).toContain('存活成员');
    expect(byPid.get(5009)).toMatchObject({ verdict: 'unconfirmed', proof: 'none' });
    expect(outcome.state).toBe('unconfirmed'); // 恢复守卫据此阻断新 Leader
    expect(fixture.signals).toHaveLength(0); // 绝不按 PGID 降级杀组员
    expect(fixture.alive.has(5009)).toBe(true); // 成员仍活（零信号）
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('R1（真实 OS）：根被 SIGKILL、同组长驻孤儿仍活 → 不能假 confirmed；孤儿不被误杀', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'residual-real-'));
    let parent: ReturnType<typeof spawn> | null = null;
    let orphan = 0;
    const pidAlive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
    };
    try {
      const homeDir = path.join(root, 'home');
      const buildRoot = path.join(root, 'build');
      fs.mkdirSync(path.join(homeDir, 'amagi', 'data', 'process-audits', 'group'), { recursive: true });
      const childFile = path.join(root, 'orphan-pid');
      parent = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childFile)},String(p.pid));setInterval(()=>{},1000);`], { detached: true, stdio: 'ignore' });
      for (let n = 0; n < 150 && !fs.existsSync(childFile); n += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      orphan = Number(fs.readFileSync(childFile, 'utf8'));
      const rootPid = parent.pid!;
      expect(pidAlive(orphan)).toBe(true);
      const tokens = await readBirthIdentities([rootPid]);
      const token = tokens.get(rootPid);
      expect(token).toBeTruthy();
      fs.writeFileSync(path.join(homeDir, 'amagi', 'data', 'process-audits', 'group', 'launch-anchor.json'), JSON.stringify({
        version: 1,
        taskId: 'group-task',
        runs: [{ rootPid, pgid: rootPid, rootIdentityToken: token, leaderPid: process.pid, at: Date.now() }],
      }));
      const exited = once(parent, 'exit');
      parent.kill('SIGKILL');
      await exited;
      // 生产对账（真实 ps/libproc；无探测/信号注入）：同组孤儿仍活 → 不假 confirmed
      const outcome = await reconcileResidualProcesses({ homeDir, buildRoot, leaderPids: new Set([process.pid]) }, { reap: true });
      expect(outcome.state).toBe('unconfirmed');
      expect(outcome.children.find((child) => child.pid === orphan)).toMatchObject({ verdict: 'unconfirmed', proof: 'none' });
      expect(outcome.children.find((child) => child.pid === rootPid)?.verdict).toBe('exited');
      expect(pidAlive(orphan)).toBe(true); // 未被误杀（零信号；只清理本脚本创建的进程）
    } finally {
      if (orphan) try { process.kill(orphan, 'SIGKILL'); } catch { /* 已退出 */ }
      if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('R2（注入）时序顺序断言：R0→M0(仅候选)→C0→M1→M2→C1→R1（membership 证据落在身份区间内）', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-order', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'darwin:100:9');
    const events: string[] = [];
    const basePs = fixture.deps.runPs!;
    let psCalls = 0;
    fixture.deps.runPs = async () => { psCalls += 1; events.push(`ps${psCalls}`); return basePs(); };
    const baseProbe = fixture.deps.probeBirthTokens!;
    let probeCalls = 0;
    fixture.deps.probeBirthTokens = async (pids) => {
      probeCalls += 1;
      events.push(`birth${probeCalls}:${pids.join('+')}`);
      return baseProbe(pids);
    };
    fixture.deps.probeProcessGroups = async (pids) => {
      events.push(`groups:${pids.join('+')}`);
      return new Map(); // darwin 形态：无 sid（固定实现前提由 ps 佐证）
    };
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    // 封存成功（注入出口回收正例）
    const reaped = outcome.children.filter((child) => child.verdict === 'reaped').map((child) => child.pid).sort();
    expect(reaped).toEqual([5008, 5009]);
    expect(outcome.state).toBe('confirmed');
    // 显式顺序断言：分类面(ps1+首根采样)之后，枚举序列恰为
    // R0(根采样) < M0(ps2) < C0(成员采样) < M1(ps3) < M2(ps4) < groups < C1(成员二采) < R1(根二采)
    const rootSamples = events.map((event, index) => ({ event, index })).filter((item) => item.event.endsWith(':5008')).map((item) => item.index);
    const memberSamples = events.map((event, index) => ({ event, index })).filter((item) => item.event.endsWith(':5009')).map((item) => item.index);
    const idx = (marker: string) => events.indexOf(marker);
    const groupsIdx = events.findIndex((event) => event.startsWith('groups:'));
    const ps2 = idx('ps2');
    const ps3 = idx('ps3');
    const ps4 = idx('ps4');
    expect(ps2).toBeGreaterThan(-1);
    expect(ps3).toBeGreaterThan(ps2);
    expect(ps4).toBeGreaterThan(ps3);
    const r0 = rootSamples[1]; // [0]=分类采样；[1]=R0；最后若干个=回收前 fresh 复核
    const c0 = memberSamples[0];
    const c1 = memberSamples.find((index) => index > groupsIdx);
    const r1 = rootSamples.find((index) => (c1 !== undefined && index > c1));
    expect(r0).toBeLessThan(ps2); // R0 在 M0 之前
    expect(ps2).toBeLessThan(c0); // M0(仅候选) 先于 C0
    expect(c0).toBeLessThan(ps3); // C0 先于 M1
    expect(ps4).toBeLessThan(groupsIdx); // M2 后才读组身份
    expect(groupsIdx).toBeLessThan(c1 as number); // C1 在 groups 之后（身份夹逼包住 M1/M2）
    expect(c1 as number).toBeLessThan(r1 as number); // C1 先于 R1
    // M1/M2 之外不得出现第三张 membership 表（时序恰两张）
    expect(events.filter((event) => /^ps\d+$/.test(event) && event !== 'ps1')).toEqual(['ps2', 'ps3', 'ps4']);
  });

  it('R2（注入）：M0 见过、M1 缺席、M2 又现（M0-only 连续）→ 不封存零信号（不把 M0 反向当证明）', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-m0-only', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'darwin:100:9');
    // ps 调用：#1 分类、#2 M0（5009 在）、#3 M1（5009 缺席）、#4 M2（5009 又现）
    let psCalls = 0;
    const basePs = fixture.deps.runPs!;
    fixture.deps.runPs = async () => {
      psCalls += 1;
      if (psCalls === 3) {
        return fixture.table
          .filter((row) => row.pid !== 5009 && fixture.alive.has(row.pid))
          .map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${row.uid} 10:00 ${row.comm ?? 'node'}`)
          .join('\n') || '1 0 1 0 10:00 launchd';
      }
      return basePs();
    };
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(fixture.signals.some((entry) => entry.pid === 5009)).toBe(false); // M1 缺席 → 连续性失败，零信号
    expect(fixture.alive.has(5009)).toBe(true);
    expect(outcome.children.find((child) => child.pid === 5009)).toMatchObject({ verdict: 'unconfirmed', proof: 'none' });
    expect(outcome.children.find((child) => child.pid === 5008)).toMatchObject({ verdict: 'reaped' });
    expect(outcome.state).toBe('unconfirmed');
  });

  it('R2（注入）：分类后根身份失效（枚举前 fresh 失败）→ memberPlan 作废，根与成员全零信号', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-pre-fail', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'darwin:100:9');
    const originalProbe = fixture.deps.probeBirthTokens;
    let probeCalls = 0;
    fixture.deps.probeBirthTokens = async (pids) => {
      probeCalls += 1;
      if (probeCalls <= 2) return originalProbe!(pids); // 分类快照命中锚点令牌
      // 此后同 pid 已被无关进程复用（新令牌）——枚举到的组员属于换人后的组
      const out = new Map<number, string>();
      for (const pid of pids) {
        if (!fixture.alive.has(pid)) continue;
        out.set(pid, pid === 5008 ? 'darwin:999:new' : 'darwin:100:9');
      }
      return out;
    };
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(fixture.signals).toHaveLength(0); // 根 fresh 失败零信号；memberPlan 作废 → 成员零信号
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children.find((child) => child.pid === 5008)).toMatchObject({ verdict: 'unconfirmed' });
    const planFinding = outcome.children.find((child) => child.pid === 0);
    expect(planFinding?.detail).toContain('枚举前');
    expect(fixture.alive.has(5009)).toBe(true); // 未被误杀
  });

  it('R2（注入）：枚举窗口内根换人（枚举后 fresh 失败）→ 预录成员计划作废，成员零信号', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-post-fail', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'darwin:100:9');
    const originalProbe = fixture.deps.probeBirthTokens;
    let probeCalls = 0;
    fixture.deps.probeBirthTokens = async (pids) => {
      probeCalls += 1;
      const base = await originalProbe!(pids);
      // 分类(1-2) + 枚举前复核(3-4) + 成员令牌(5-6) 正常；枚举后复核起根换人
      if (probeCalls <= 6 || !pids.includes(5008)) return base;
      const out = new Map(base);
      if (out.has(5008)) out.set(5008, 'darwin:999:new');
      return out;
    };
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(fixture.signals).toHaveLength(0); // 计划作废（成员不可信）+ 根换人 → 全零信号
    expect(outcome.state).toBe('unconfirmed');
    const planFinding = outcome.children.find((child) => child.pid === 0);
    expect(planFinding?.detail).toContain('枚举后');
    expect(fixture.alive.has(5009)).toBe(true); // 未被误杀
  });
  it('R2（注入）：成员 PID 在 ps→birth 采样间被复用（新占用者不同组）→ membership 夹逼失败，不封存零信号', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-member-reuse', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'darwin:100:9');
    // ps 调用计数：#1 分类 / #2 M1 枚举 / #3 M2 夹逼。M2 起同 pid 已被组外
    // 无关进程占用（复用发生在 ps 行→birth 采样之间；新占用者不同 pgid）。
    let psCalls = 0;
    const baseRunPs = fixture.deps.runPs!;
    fixture.deps.runPs = async () => {
      psCalls += 1;
      if (psCalls <= 2) return baseRunPs();
      return fixture.table
        .filter((row) => row.pid !== 5009)
        .filter((row) => fixture.alive.has(row.pid))
        .map((row) => `${row.pid} ${row.ppid} ${row.pid === 5008 ? 5008 : row.pgid} ${row.uid} 10:00 ${row.comm ?? 'node'}`)
        .join('\n') || '1 0 1 0 10:00 launchd';
    };
    // birth 采样：成员 pid 读到的已是新占用者令牌（旧实现会保存它并 fresh 匹配后误杀）
    fixture.deps.probeBirthTokens = async (pids) => {
      const out = new Map<number, string>();
      for (const pid of pids) {
        if (!fixture.alive.has(pid)) continue;
        out.set(pid, pid === 5009 ? 'darwin:999:reused' : 'darwin:100:8');
      }
      return out;
    };
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    // 成员不封存：零信号、仍活、如实上报；根照常回收
    expect(fixture.signals.some((entry) => entry.pid === 5009)).toBe(false);
    expect(fixture.alive.has(5009)).toBe(true);
    expect(outcome.children.find((child) => child.pid === 5009)).toMatchObject({ verdict: 'unconfirmed', proof: 'none' });
    expect(outcome.children.find((child) => child.pid === 5009)?.detail).toContain('membership');
    expect(outcome.children.find((child) => child.pid === 5008)).toMatchObject({ verdict: 'reaped' });
    expect(outcome.state).toBe('unconfirmed');
  });

  it('R2（注入）：成员 birth 前后采样不一致（C0→C1 间 pid 换人）→ 身份夹逼失败，不封存零信号', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-identity-sandwich', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'darwin:100:9');
    // 采样计数：分类(1-2)/R0(3-4)/C0(5-6) 为原成员令牌；C1(7-8) 起同 pid 换人
    let probeCalls = 0;
    fixture.deps.probeBirthTokens = async (pids) => {
      probeCalls += 1;
      const out = new Map<number, string>();
      for (const pid of pids) {
        if (!fixture.alive.has(pid)) continue;
        out.set(pid, pid === 5009 ? (probeCalls <= 6 ? 'darwin:100:9' : 'darwin:999:new') : 'darwin:100:8');
      }
      return out;
    };
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(fixture.signals.some((entry) => entry.pid === 5009)).toBe(false);
    expect(fixture.alive.has(5009)).toBe(true);
    expect(outcome.children.find((child) => child.pid === 5009)?.detail).toContain('身份夹逼');
    expect(outcome.children.find((child) => child.pid === 5008)).toMatchObject({ verdict: 'reaped' });
  });
});

describe('R2-F10-01/02：锚点归属分区与内层扫描契约', () => {
  function writeV2(fixture: ReturnType<typeof makeFixture>, taskId: string, current: { execution?: string; processState?: string } | null): void {
    const dir = path.join(fixture.homeDir, 'amagi', 'v2-store', taskId);
    fs.mkdirSync(dir, { recursive: true });
    if (current === null) {
      fs.writeFileSync(path.join(dir, 'broken.json'), 'x');
      return;
    }
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ taskId, ...current }));
  }

  it('登记集为空（缺 binding/账本）+ 存活 root：逐个体对账，归属可证但生产无出口 → unconfirmed 零信号（不再 filter 空假 confirmed）', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-unbound', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    writeV2(fixture, 't-unbound', { execution: 'running', processState: 'alive' });
    delete fixture.deps.kill; // 生产形态：无注入出口（历史/仅数字 PID 零信号）
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set<number>() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children.find((child) => child.pid === 5008)).toMatchObject({ verdict: 'unconfirmed', proof: 'birth-token' });
    expect(fixture.signals).toHaveLength(0);
    expect(fixture.alive.has(5008)).toBe(true);
  });

  it('登记集为空 + 已退出 root（不在进程表）→ 逐个体探测 exited + confirmed（确证退出经过目标个体探测，非 filter 空）', async () => {
    const fixture = makeFixture();
    addProcess(fixture, 9999); // 无关个体：让进程表可得，走主对账路径
    writeAnchor(fixture, 't-dead', { rootPid: 5009, pgid: 5009, rootIdentityToken: 'darwin:100:9' });
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set<number>() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('confirmed');
    expect(outcome.children).toHaveLength(1);
    expect(outcome.children[0]).toMatchObject({ pid: 5009, verdict: 'exited', proof: 'none' });
  });

  it('多 run 锚点：匹配 run 个体对账回收 + 不匹配 run 归属不明 unknown（同一锚点文件内分区，零信号）', async () => {
    const fixture = makeFixture();
    const dir = path.join(fixture.homeDir, 'amagi', 'data', 'process-audits', 't_multi');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'launch-anchor.json'), JSON.stringify({
      version: 1,
      taskId: 't_multi',
      runs: [
        { rootPid: 6001, pgid: 6001, rootIdentityToken: 'darwin:300:1', leaderPid: 4100, at: 1_699_999_000_000 },
        { rootPid: 6002, pgid: 6002, rootIdentityToken: 'darwin:300:2', leaderPid: 8888, at: 1_699_999_000_100 },
      ],
    }));
    addProcess(fixture, 6001, { pgid: 6001 }, 'darwin:300:1');
    addProcess(fixture, 6002, { pgid: 6002 }, 'darwin:300:2');
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const byPid = new Map(outcome.children.map((child) => [child.pid, child]));
    expect(byPid.get(6001)).toMatchObject({ verdict: 'reaped', proof: 'birth-token' }); // 匹配 run 照常回收（注入出口）
    expect(byPid.get(6002)).toMatchObject({ verdict: 'unconfirmed', proof: 'none' });   // 不匹配 run 归属不明
    expect(fixture.signals.some((entry) => entry.pid === 6002)).toBe(false);             // 不匹配 run 零信号
    expect(outcome.state).toBe('unconfirmed');
  });

  it('多 Leader：登记集含双方 → 均对账；只登记一方 → 另一方锚点归属不明', async () => {
    const fixture = makeFixture();
    addProcess(fixture, 9999); // 无关个体：让进程表可得
    writeAnchor(fixture, 't-la', { rootPid: 6101, leaderPid: 4100 });
    writeAnchor(fixture, 't-lb', { rootPid: 6102, leaderPid: 4200 });
    const both = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set<number>([4100, 4200]) }, { reap: true }, fixture.deps);
    expect(both.children).toHaveLength(2);
    expect(both.state).toBe('confirmed'); // 两 root 均不在表 → exited（对账口径）

    const oneSide = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set<number>([4100]) }, { reap: true }, fixture.deps);
    const byPid = new Map(oneSide.children.map((child) => [child.pid, child]));
    expect(byPid.get(6101)).toMatchObject({ verdict: 'exited' });
    expect(byPid.get(6102)).toMatchObject({ verdict: 'unconfirmed', proof: 'none' });
    expect(oneSide.state).toBe('unconfirmed');
  });

  it('活跃 v2-store 任务仅被不匹配锚点覆盖 → 不算已覆盖：anchorless 缺口与归属不明双未确认', async () => {
    const fixture = makeFixture();
    addProcess(fixture, 9999);
    writeV2(fixture, 't-cov', { execution: 'running', processState: 'alive' });
    writeAnchor(fixture, 't-cov', { rootPid: 6201, leaderPid: 7777 });
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children.some((child) => child.source === 'v2-store' && child.taskId === 't-cov' && child.detail.includes('无锚点覆盖'))).toBe(true);
    expect(outcome.children.some((child) => child.pid === 6201 && child.verdict === 'unconfirmed' && child.detail.includes('归属不明'))).toBe(true);
  });

  it('R2-F10-02：audits 目录被占位为文件（ENOTDIR）→ degraded fail-closed unconfirmed，不当空', async () => {
    const fixture = makeFixture();
    addProcess(fixture, 9999);
    fs.rmSync(path.join(fixture.homeDir, 'amagi', 'data', 'process-audits'), { recursive: true, force: true });
    fs.writeFileSync(path.join(fixture.homeDir, 'amagi', 'data', 'process-audits'), 'not-a-dir');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children.some((child) => child.source === 'anchor' && child.detail.includes('不可枚举'))).toBe(true);
    expect(outcome.note).toContain('degraded');
  });

  it('R2-F10-02：v2-store 目录被占位为文件（ENOTDIR）→ degraded unconfirmed，note 不再声称无派发意图', async () => {
    const fixture = makeFixture();
    addProcess(fixture, 9999);
    fs.mkdirSync(path.join(fixture.homeDir, 'amagi'), { recursive: true });
    fs.writeFileSync(path.join(fixture.homeDir, 'amagi', 'v2-store'), 'not-a-dir');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children.some((child) => child.source === 'v2-store' && child.detail.includes('不可枚举'))).toBe(true);
    expect(outcome.note).not.toContain('无派发意图');
  });

  it('R2-F10-02：任务目录被普通文件占位（锚点路径 ENOTDIR）→ untrusted 证据不全 → unconfirmed（不再无差别跳过）', async () => {
    const fixture = makeFixture();
    addProcess(fixture, 9999);
    fs.writeFileSync(path.join(fixture.homeDir, 'amagi', 'data', 'process-audits', 'blocked'), 'not-a-dir');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children.some((child) => child.source === 'anchor' && child.detail.includes('证据不全'))).toBe(true);
  });

  it('损坏锚点（untrusted）→ 总体 unconfirmed（证据缺口不再只改 note）', async () => {
    const fixture = makeFixture();
    addProcess(fixture, 9999);
    const dir = path.join(fixture.homeDir, 'amagi', 'data', 'process-audits', 'corrupt2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'launch-anchor.json'), '{ not json');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.note).toContain('锚点证据不全');
  });

  it('账本 degraded（直接调用路径）→ unconfirmed（Leader 归属事实不可得）', async () => {
    const fixture = makeFixture();
    addProcess(fixture, 9999);
    fs.mkdirSync(fixture.buildRoot, { recursive: true });
    fs.writeFileSync(path.join(fixture.buildRoot, 'process-ledger.json'), 'broken');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children.some((child) => child.source === 'ledger' && child.detail.includes('degraded'))).toBe(true);
  });

  it('空目录 vs 缺失目录同契约：audits/v2-store 存在但空 → 无任务事实 confirmed', async () => {
    const fixture = makeFixture();
    fs.mkdirSync(path.join(fixture.homeDir, 'amagi', 'v2-store'), { recursive: true }); // 空目录（存在≠有事实）
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('confirmed');
    expect(outcome.note).toContain('无派发意图');
  });
});

describe('R2-F10-01 追加轮：PID 冲突不变量（同 pid 多份运行身份，绝不静默挑一份）', () => {
  const writeRunsAnchor = (
    fixture: ReturnType<typeof makeFixture>,
    taskId: string,
    runs: Array<{ rootPid: number; token?: string; leaderPid?: number; pgid?: number }>,
    dirName = taskId.replace(/[^a-zA-Z0-9_-]/g, '_'),
  ): void => {
    const dir = path.join(fixture.homeDir, 'amagi', 'data', 'process-audits', dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'launch-anchor.json'), JSON.stringify({
      version: 1,
      taskId,
      runs: runs.map((run, index) => ({
        backendRunId: `run_${taskId}_${index}`,
        rootPid: run.rootPid,
        ...(run.pgid !== undefined ? { pgid: run.pgid } : {}),
        ...(run.token ? { rootIdentityToken: run.token } : {}),
        leaderPid: run.leaderPid ?? 4100,
        at: 1_699_999_000_000 + index,
      })),
    }));
  };

  it('旧令牌在前/新令牌在后：旧声称 exited、存活匹配者保守 unconfirmed 零信号，整体 unconfirmed（不假 confirmed）', async () => {
    const fixture = makeFixture();
    writeRunsAnchor(fixture, 'task_share', [
      { rootPid: 6300, token: 'darwin:400:old', pgid: 6300 },
      { rootPid: 6300, token: 'darwin:400:live', pgid: 6300 },
    ]);
    addProcess(fixture, 6300, { pgid: 6300 }, 'darwin:400:live'); // 当前占用者 = 新 run
    delete fixture.deps.kill;
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const shares = outcome.children.filter((child) => child.pid === 6300);
    expect(shares).toHaveLength(2); // 两份可见事实都在，不静默消除
    expect(shares.some((child) => child.verdict === 'exited' && child.detail.includes('已结束'))).toBe(true); // 旧声称
    expect(shares.some((child) => child.verdict === 'unconfirmed' && child.proof === 'birth-token' && child.detail.includes('冲突'))).toBe(true); // 新声称存活
    expect(outcome.state).toBe('unconfirmed');
    expect(fixture.signals).toHaveLength(0);
    expect(fixture.alive.has(6300)).toBe(true);
  });

  it('顺序不变性（新令牌在前/旧令牌在后）：分区结果与声称顺序无关', async () => {
    const fixture = makeFixture();
    writeRunsAnchor(fixture, 'task_share', [
      { rootPid: 6300, token: 'darwin:400:live', pgid: 6300 },
      { rootPid: 6300, token: 'darwin:400:old', pgid: 6300 },
    ]);
    addProcess(fixture, 6300, { pgid: 6300 }, 'darwin:400:live');
    delete fixture.deps.kill;
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const shares = outcome.children.filter((child) => child.pid === 6300);
    expect(shares).toHaveLength(2);
    expect(shares.some((child) => child.verdict === 'exited' && child.detail.includes('已结束'))).toBe(true);
    expect(shares.some((child) => child.verdict === 'unconfirmed' && child.proof === 'birth-token')).toBe(true);
    expect(outcome.state).toBe('unconfirmed');
    expect(fixture.signals).toHaveLength(0);
  });

  it('跨锚点文件冲突（不同 taskId/不同 leader，均在登记集）：按出生令牌分区，存活匹配者保守零信号', async () => {
    const fixture = makeFixture();
    writeRunsAnchor(fixture, 'taskA', [{ rootPid: 6400, token: 'darwin:500:old', leaderPid: 4100, pgid: 6400 }], 'task_a');
    writeRunsAnchor(fixture, 'taskB', [{ rootPid: 6400, token: 'darwin:500:live', leaderPid: 4200, pgid: 6400 }], 'task_b');
    addProcess(fixture, 6400, { pgid: 6400 }, 'darwin:500:live');
    delete fixture.deps.kill;
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set<number>([4100, 4200]) }, { reap: true }, fixture.deps);
    const shares = outcome.children.filter((child) => child.pid === 6400);
    expect(shares).toHaveLength(2);
    expect(shares.find((child) => child.taskId === 'taskA')).toMatchObject({ verdict: 'exited' });
    expect(shares.find((child) => child.taskId === 'taskB')).toMatchObject({ verdict: 'unconfirmed', proof: 'birth-token' });
    expect(outcome.state).toBe('unconfirmed');
    expect(fixture.signals).toHaveLength(0);
  });

  it('完全重复声称可去重（同任务+同令牌）：单一身份照常回收正例，不产生冲突项', async () => {
    const fixture = makeFixture();
    writeRunsAnchor(fixture, 'task_dup', [
      { rootPid: 6500, token: 'darwin:600:1', pgid: 6500 },
      { rootPid: 6500, token: 'darwin:600:1', pgid: 6500 },
    ]);
    addProcess(fixture, 6500, { pgid: 6500 }, 'darwin:600:1');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const shares = outcome.children.filter((child) => child.pid === 6500);
    expect(shares).toHaveLength(1); // 完全重复去重
    expect(shares[0]).toMatchObject({ verdict: 'reaped', proof: 'birth-token' });
    expect(shares[0]?.detail.includes('冲突')).toBe(false);
    expect(outcome.state).toBe('confirmed');
  });

  it('同任务同birth但pgid声称冲突，不得去重后漏掉第二组孤儿', async () => {
    const fixture = makeFixture();
    writeRunsAnchor(fixture, 'task_groups', [
      { rootPid: 6500, token: 'darwin:600:1', pgid: 6400 },
      { rootPid: 6500, token: 'darwin:600:1', pgid: 6500 },
    ]);
    addProcess(fixture, 6501, { pgid: 6500 }, 'darwin:601:1');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children).toContainEqual(expect.objectContaining({ pid: 6501, verdict: 'unconfirmed' }));
    expect(fixture.signals).toHaveLength(0);
  });

  it('同launchId但出生令牌冲突的账本条目，不得只保旧份而漏掉存活新份', async () => {
    const fixture = makeFixture();
    const common = { launchId: 'same', buildId: 'b_test01', runtimeEpoch: 1, generation: 1,
      kind: 'leader', pid: 6600, startedAt: new Date().toISOString(), cwd: '/w' };
    fs.mkdirSync(fixture.buildRoot, { recursive: true });
    fs.writeFileSync(path.join(fixture.buildRoot, 'process-ledger.json'), JSON.stringify({ version: 1, entries: [
      { ...common, birthToken: 'darwin:700:old' }, { ...common, birthToken: 'darwin:700:live' },
    ] }));
    addProcess(fixture, 6600, { pgid: 6600 }, 'darwin:700:live');
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set([6600]), includeLeaderEntries: true }, { reap: true }, fixture.deps);
    expect(outcome.state).toBe('unconfirmed');
    expect(outcome.children.filter((child) => child.pid === 6600)).toHaveLength(2);
    expect(fixture.signals).toHaveLength(0);
  });

  it('账本-账本 PID 冲突（同 pid 两个未收口 launch）：令牌匹配者存活保守 unconfirmed、不匹配者 exited', async () => {
    const fixture = makeFixture();
    appendProcessLedgerEntry(fixture.buildRoot, {
      launchId: 'l_c1', buildId: 'b_test01', runtimeEpoch: 1, generation: 1, kind: 'leader',
      pid: 6600, startedAt: new Date().toISOString(), cwd: '/w', birthToken: 'darwin:700:old',
    });
    appendProcessLedgerEntry(fixture.buildRoot, {
      launchId: 'l_c2', buildId: 'b_test01', runtimeEpoch: 2, generation: 3, kind: 'leader',
      pid: 6600, startedAt: new Date().toISOString(), cwd: '/w', birthToken: 'darwin:700:live',
    });
    addProcess(fixture, 6600, { pgid: 6600 }, 'darwin:700:live');
    const outcome = await reconcileResidualProcesses(
      { homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: new Set<number>([6600]), includeLeaderEntries: true },
      { reap: true }, fixture.deps,
    );
    const shares = outcome.children.filter((child) => child.pid === 6600);
    expect(shares).toHaveLength(2); // 旧 launch 与新 launch 都可见（不同 epoch/generation 也各自对账）
    expect(shares.filter((child) => child.verdict === 'exited')).toHaveLength(1);
    expect(shares.filter((child) => child.verdict === 'unconfirmed' && child.proof === 'birth-token')).toHaveLength(1);
    expect(outcome.state).toBe('unconfirmed');
    expect(fixture.signals).toHaveLength(0); // 冲突个体一律零信号（有注入出口也不杀）
    expect(fixture.alive.has(6600)).toBe(true);
  });

  it('账本-锚点 PID 冲突：两份声称都保留，存活匹配者保守零信号（不再锚点静默覆盖账本）', async () => {
    const fixture = makeFixture();
    writeRunsAnchor(fixture, 'task_x', [{ rootPid: 6700, token: 'darwin:800:old', pgid: 6700 }]);
    appendProcessLedgerEntry(fixture.buildRoot, {
      launchId: 'l_mixed', buildId: 'b_test01', runtimeEpoch: 1, generation: 1, kind: 'leader',
      pid: 6700, startedAt: new Date().toISOString(), cwd: '/w', birthToken: 'darwin:800:live',
    });
    addProcess(fixture, 6700, { pgid: 6700 }, 'darwin:800:live');
    const outcome = await reconcileResidualProcesses(
      { homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS(), includeLeaderEntries: true },
      { reap: true }, fixture.deps,
    );
    const shares = outcome.children.filter((child) => child.pid === 6700);
    expect(shares).toHaveLength(2);
    expect(shares.find((child) => child.source === 'anchor')).toMatchObject({ verdict: 'exited' });
    expect(shares.find((child) => child.source === 'ledger')).toMatchObject({ verdict: 'unconfirmed', proof: 'birth-token' });
    expect(outcome.state).toBe('unconfirmed');
    expect(fixture.signals).toHaveLength(0);
  });

  it('PID 冲突但 pid 已退出：各声称出生均已结束 → exited + confirmed（正例，内核级无活写者）', async () => {
    const fixture = makeFixture();
    addProcess(fixture, 9999); // 无关个体：让进程表可得
    writeRunsAnchor(fixture, 'task_gone', [
      { rootPid: 6800, token: 'darwin:900:old', pgid: 6800 },
      { rootPid: 6800, token: 'darwin:900:new', pgid: 6800 },
    ]);
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const shares = outcome.children.filter((child) => child.pid === 6800);
    expect(shares).toHaveLength(2);
    expect(shares.every((child) => child.verdict === 'exited')).toBe(true);
    expect(outcome.state).toBe('confirmed');
    expect(fixture.signals).toHaveLength(0);
  });

  it('PID 冲突 + 占用者令牌探测失效：两份声称均不可区分 → 全部 unconfirmed 零信号', async () => {
    const fixture = makeFixture();
    writeRunsAnchor(fixture, 'task_probe', [
      { rootPid: 6900, token: 'darwin:910:old', pgid: 6900 },
      { rootPid: 6900, token: 'darwin:910:live', pgid: 6900 },
    ]);
    addProcess(fixture, 6900, { pgid: 6900 }, 'darwin:910:live');
    fixture.deps.probeBirthTokens = async () => new Map(); // 探测失效
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const shares = outcome.children.filter((child) => child.pid === 6900);
    expect(shares).toHaveLength(2);
    expect(shares.every((child) => child.verdict === 'unconfirmed' && child.detail.includes('探测失效'))).toBe(true);
    expect(outcome.state).toBe('unconfirmed');
    expect(fixture.signals).toHaveLength(0);
  });

  it('PID 冲突 + 一份声称无令牌：无令牌份不可区分 → unconfirmed（PID 不是运行身份）', async () => {
    const fixture = makeFixture();
    writeRunsAnchor(fixture, 'task_nolock', [
      { rootPid: 6950, token: 'darwin:920:live', pgid: 6950 },
      { rootPid: 6950, pgid: 6950 }, // 无令牌
    ]);
    addProcess(fixture, 6950, { pgid: 6950 }, 'darwin:920:live');
    delete fixture.deps.kill;
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const shares = outcome.children.filter((child) => child.pid === 6950);
    expect(shares).toHaveLength(2);
    expect(shares.filter((child) => child.verdict === 'unconfirmed')).toHaveLength(2); // 匹配者保守 + 无令牌者不可区分
    expect(outcome.state).toBe('unconfirmed');
    expect(fixture.signals).toHaveLength(0);
  });
});

describe('findAliveLedgerLeaders（binding 未落盘窗口的存活 Leader 检测）', () => {
  it('探针失效（fresh undefined）→ 探针失效≠不是本 run：unprovable 保守阻断', async () => {
    const fixture = makeFixture();
    appendProcessLedgerEntry(fixture.buildRoot, {
      launchId: 'l_probe_fail', buildId: 'b_test01', runtimeEpoch: 1, generation: 1, kind: 'leader',
      pid: 6005, startedAt: new Date().toISOString(), cwd: '/w', birthToken: 'darwin:200:5',
    });
    addProcess(fixture, 6005, { pgid: 100 }); // 存活
    fixture.deps.probeBirthTokens = async () => new Map(); // 探针失效：读不到 fresh 令牌
    const alive = await findAliveLedgerLeaders(fixture.buildRoot, fixture.deps);
    expect(alive).toEqual([{ pid: 6005, launchId: 'l_probe_fail', evidence: 'unprovable' }]);
    expect(fixture.signals).toHaveLength(0);
  });

  it('存活且令牌匹配 → ours；存活但令牌不匹配/已退出/已登记退出 → 不计；无令牌存活 → unprovable', async () => {
    const fixture = makeFixture();
    const writeLedger = (launchId: string, pid: number, birthToken?: string, exit?: { code: number | null; signal: string | null }) => {
      appendProcessLedgerEntry(fixture.buildRoot, {
        launchId, buildId: 'b_test01', runtimeEpoch: 1, generation: 1, kind: 'leader',
        pid, startedAt: new Date().toISOString(), cwd: '/w', ...(birthToken ? { birthToken } : {}),
      });
      if (exit) markLedgerExit(fixture.buildRoot, launchId, 'leader', exit);
    };
    addProcess(fixture, 6001, { pgid: 100 }, 'darwin:200:1');   // ours（令牌匹配）
    addProcess(fixture, 6002, { pgid: 100 }, 'darwin:777:7');   // pid 复用（不匹配）
    addProcess(fixture, 6003, { pgid: 100 });                    // 无令牌可比
    addProcess(fixture, 6004, { pgid: 100 }, 'darwin:200:4');   // 已登记退出（exit 标记生效）
    writeLedger('l_1', 6001, 'darwin:200:1');
    writeLedger('l_2', 6002, 'darwin:200:2');
    writeLedger('l_3', 6003);
    writeLedger('l_4', 6004, 'darwin:200:4', { code: 0, signal: null });
    // 6005：账本声称存活但实际已退出（应用硬崩未落 exit 的真实形态）
    writeLedger('l_5', 6999, 'darwin:200:9');
    const alive = await findAliveLedgerLeaders(fixture.buildRoot, fixture.deps);
    const byPid = new Map(alive.map((entry) => [entry.pid, entry]));
    expect(byPid.get(6001)).toMatchObject({ evidence: 'birth-token' });
    expect(byPid.get(6002)).toBeUndefined(); // 复用 → 不是我们的 Leader
    expect(byPid.get(6003)).toMatchObject({ evidence: 'unprovable' }); // 不能排除，保守计入
    expect(byPid.get(6004)).toBeUndefined(); // 已登记退出
    expect(byPid.has(6999)).toBe(false);     // 实际已退出
    expect(fixture.signals).toHaveLength(0); // 检测不发信号
  });
});

describe('裁决 #5：生产无注入出口 → 历史发现/仅数字 PID 目标零信号', () => {
  it('归属可证且存活 → unconfirmed 零信号（不 process.kill）；exited/not-ours 照常', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-prod-noKill', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'darwin:100:9');
    // 生产形态：不注入 kill（deps.kill 缺省）——其余探测照常
    delete fixture.deps.kill;
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(fixture.signals).toHaveLength(0); // 生产对历史/仅数字 PID 目标零信号
    expect(fixture.alive.has(5008)).toBe(true);
    expect(fixture.alive.has(5009)).toBe(true);
    const byPid = new Map(outcome.children.map((child) => [child.pid, child]));
    expect(byPid.get(5008)).toMatchObject({ verdict: 'unconfirmed', proof: 'birth-token' });
    expect(byPid.get(5008)?.detail).toContain('无稳定自有引用');
    // 封存组员（归属时序证明成立）同样零信号、如实 unconfirmed
    expect(byPid.get(5009)).toMatchObject({ verdict: 'unconfirmed', proof: 'birth-token' });
    expect(byPid.get(5009)?.detail).toContain('无稳定自有引用');
    expect(outcome.state).toBe('unconfirmed');
  });

  it('注入 identity-bound 出口（测试模拟/自有句柄桥接）才可回收——正例标注非生产默认能力', async () => {
    const fixture = makeFixture();
    writeAnchor(fixture, 't-injected-exit', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(outcome.children[0]).toMatchObject({ pid: 5008, verdict: 'reaped', proof: 'birth-token' });
    expect(outcome.children[0]?.detail).toContain('非生产默认能力');
    expect(outcome.state).toBe('confirmed');
  });
});

describe('私有 session 前提（同 PGID 本身不授归属；同组≠同 run）', () => {
  it('linux 式 SID 证据：根 sid≠rootPid（非本运行受信 detached 会话）→ 成员不封存、零信号', async () => {
    const fixture = makeFixture({ platform: 'linux' });
    writeAnchor(fixture, 't-sid-mismatch', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'linux:boot:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'linux:boot:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'linux:boot:9');
    fixture.deps.probeProcessGroups = async (pids) => {
      const out = new Map<number, { pgid: number; sid?: number }>();
      for (const pid of pids) out.set(pid, { pgid: 5008, sid: 4000 }); // sid≠rootPid：不属于根的私有会话
      return out;
    };
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    // 根自身归属仍由出生令牌证明 → 按注入出口回收；成员 session 前提失败 → 不封存零信号
    expect(fixture.signals.some((entry) => entry.pid === 5009)).toBe(false);
    expect(fixture.alive.has(5009)).toBe(true);
    expect(outcome.children.find((child) => child.pid === 5009)?.detail).toContain('session');
    expect(outcome.children.find((child) => child.pid === 5008)).toMatchObject({ verdict: 'reaped' });
    expect(outcome.state).toBe('unconfirmed');
  });

  it('成员同组但不同 session（sid 可得且≠rootPid）→ 该成员不封存零信号', async () => {
    const fixture = makeFixture({ platform: 'linux' });
    writeAnchor(fixture, 't-member-sid', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'linux:boot:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'linux:boot:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'linux:boot:9');
    fixture.deps.probeProcessGroups = async (pids) => {
      const out = new Map<number, { pgid: number; sid?: number }>();
      for (const pid of pids) out.set(pid, pid === 5008 ? { pgid: 5008, sid: 5008 } : { pgid: 5008, sid: 4100 });
      return out;
    };
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    expect(fixture.signals.some((entry) => entry.pid === 5009)).toBe(false);
    expect(outcome.children.find((child) => child.pid === 5009)?.detail).toContain('session');
  });

  it('darwin 无 sid（固定实现前提）：根为受信实现声称的组长（ps 双快照佐证）→ 可封存回收', async () => {
    const fixture = makeFixture(); // platform darwin
    writeAnchor(fixture, 't-darwin-premise', { rootPid: 5008, pgid: 5008, rootIdentityToken: 'darwin:100:8' });
    addProcess(fixture, 5008, { pgid: 5008 }, 'darwin:100:8');
    addProcess(fixture, 5009, { ppid: 5008, pgid: 5008 }, 'darwin:100:9');
    fixture.deps.probeProcessGroups = async () => new Map(); // darwin 实测无 sid：探测空
    fixture.deps.kill = (pid, signal) => { fixture.signals.push({ pid, signal }); fixture.alive.delete(pid); };
    const outcome = await reconcileResidualProcesses({ homeDir: fixture.homeDir, buildRoot: fixture.buildRoot, leaderPids: LEADER_PIDS() }, { reap: true }, fixture.deps);
    const reaped = outcome.children.filter((child) => child.verdict === 'reaped').map((child) => child.pid).sort();
    expect(reaped).toEqual([5008, 5009]); // 固定实现前提（anchor+birth+双夹逼+ps 组长佐证）成立 → 封存+注入出口回收
    expect(outcome.state).toBe('confirmed');
  });
});

describe('listBuildHomeDirs（F10-R3 跨 epoch 对账）', () => {
  it('枚举 epochs/e*/home（按序）+ legacy home；缺失（ENOENT）如实为空、非 ENOENT 读取失败 → degraded', () => {
    const root = tmpRoot();
    const buildRoot = path.join(root, 'agent', 'builds', 'b_homes');
    expect(listBuildHomeDirs(buildRoot)).toEqual({ homes: [], degraded: false });
    for (const epoch of ['e2', 'e1', 'e3']) {
      fs.mkdirSync(path.join(buildRoot, 'epochs', epoch, 'home'), { recursive: true });
    }
    fs.mkdirSync(path.join(buildRoot, 'epochs', 'e4'), { recursive: true }); // 无 home 子目录
    fs.mkdirSync(path.join(buildRoot, 'home'), { recursive: true }); // legacy 布局
    expect(listBuildHomeDirs(buildRoot)).toEqual({
      homes: [
        path.join(buildRoot, 'epochs', 'e1', 'home'),
        path.join(buildRoot, 'epochs', 'e2', 'home'),
        path.join(buildRoot, 'epochs', 'e3', 'home'),
        path.join(buildRoot, 'home'),
      ],
      degraded: false,
    });
    // epochs 根被同名文件占位（读取失败、非 ENOENT）→ degraded（不能当没旧事实）
    const root2 = tmpRoot();
    const buildRoot2 = path.join(root2, 'agent', 'builds', 'b_blocked');
    fs.mkdirSync(buildRoot2, { recursive: true });
    fs.writeFileSync(path.join(buildRoot2, 'epochs'), 'not-a-dir');
    expect(listBuildHomeDirs(buildRoot2)).toEqual({ homes: [], degraded: true });
  });
});

describe('进程账本（process-ledger）', () => {
  it('追加/退出/令牌补写往返；不含 env/密钥字段', () => {
    const root = path.join(tmpRoot(), 'build-root');
    appendProcessLedgerEntry(root, {
      launchId: 'l_1', buildId: 'b_x', runtimeEpoch: 2, generation: 3, kind: 'leader',
      pid: 1234, startedAt: '2026-11-01T00:00:00Z', cwd: '/work', commandFingerprint: commandFingerprint(['node', 'pi']),
    });
    patchLedgerBirthToken(root, 'l_1', 'darwin:1:2');
    markLedgerExit(root, 'l_1', 'leader', { code: 1, signal: null });
    const { entries, degraded } = readProcessLedger(root);
    expect(degraded).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ launchId: 'l_1', pid: 1234, birthToken: 'darwin:1:2', exit: { code: 1, signal: null } });
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('env');
    expect(serialized).not.toContain('token":');
  });

  it('损坏账本 → degraded 如实上报（不静默当空）', () => {
    const root = path.join(tmpRoot(), 'corrupt-root');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'process-ledger.json'), 'broken');
    const result = readProcessLedger(root);
    expect(result.degraded).toBe(true);
    expect(result.entries).toHaveLength(0);
  });
});
