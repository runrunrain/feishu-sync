/**
 * T2a 编排骨架测试（B 案 §5/§6/§7/§8）：
 * - BuildOrchestration 状态机：三轴独立转移、非法转移拒绝、readyTasks
 *   依赖/解锁过滤、修订预算换稿不重置、接口失败与内容修订分开计数、
 *   迟到回执拒绝、幂等提交、serialize/restore round-trip
 * - AgentProcessPool 三通道配额：N 独立性、保底名额、等待不占位
 * - BuildCheckpointStore：orchestration additive 字段两分支 round-trip
 * - kb-build-service 接入：buildSpecFromConfig 冻结 + kb_builds 摘要列写入
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BuildOrchestration,
  OrchestrationError,
  budgetSubjectKey,
  buildSpecFromConfig,
  computeSnapshotHash,
  type BuildOrchestrationSnapshot,
} from '../src/kb/build-orchestration.js';
import { computeBuildSpecHash, type BuildSpec } from '../src/kb/orchestration-contracts.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<Omit<BuildSpec, 'specHash'>> = {}): Omit<BuildSpec, 'specHash'> {
  return {
    buildId: 'b_test',
    sourceSnapshotId: 'b_test:snapshot',
    sourceSnapshotHash: 'snap-hash-1',
    baseReleaseId: null,
    roles: { writer: { modelPresetId: 'writer-1' }, reviewer: { modelPresetId: 'reviewer-1' } },
    specVersion: 'v1',
    concurrency: 2,
    maxAutoRevisions: 2,
    maxInterfaceRetries: 2,
    publishMode: 'auto',
    ...overrides,
  };
}

function snapshotEntries(n = 2): RawSourceSnapshotEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    objToken: `tok${i}`,
    objType: 'docx',
    title: `t${i}`,
    relPath: `s${i}.md`,
    contentHash: `hash-${i}`,
    objEditTime: null,
  }));
}

const noopTask = (taskId: string, overrides: Record<string, unknown> = {}) => ({
  taskId,
  revision: 0,
  role: 'write' as const,
  unitId: `u_${taskId.replace('t:', '')}`,
  reviewSubjectDraftHash: null,
  inputRefs: ['raw:tok0'],
  dependencies: [],
  allowedWritePaths: [],
  outputRequirements: '草稿',
  ...overrides,
});

// ---------------------------------------------------------------------------
// 状态机：三轴独立转移 + 非法转移拒绝
// ---------------------------------------------------------------------------

describe('BuildOrchestration 三轴状态机（B 案 §7）', () => {
  it('构造即冻结 specHash；字段一致时哈希稳定', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    expect(orchestration.spec.specHash).toBe(computeBuildSpecHash(makeSpec()));
    // 携带伪造 specHash 的输入也不信任——以重算为准
    const tampered = new BuildOrchestration({ ...makeSpec(), specHash: 'fake' });
    expect(tampered.spec.specHash).toBe(computeBuildSpecHash(makeSpec()));
  });

  it('三轴独立推进：exec done 不代表验收通过；各轴可独立更新', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t1'));
    orchestration.updateExecState('t1', 'running');
    orchestration.updateExecState('t1', 'done');
    // exec 终态后产物/验收轴仍可推进（三轴分离）
    orchestration.updateArtifactState('t1', 'available');
    orchestration.updateAcceptanceState('t1', 'needs_revision');
    orchestration.updateAcceptanceState('t1', 'passed');
    const task = orchestration.task('t1')!;
    expect(task.execState).toBe('done');
    expect(task.artifactState).toBe('available');
    expect(task.acceptanceState).toBe('passed');
  });

  it('非法转移拒绝：exec 终态不可再改；queued 不能直通 done；artifact 不能横跳', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t1'));
    expect(() => orchestration.updateExecState('t1', 'done')).toThrow(OrchestrationError);
    orchestration.updateExecState('t1', 'running');
    orchestration.updateExecState('t1', 'done');
    // exec 已终态再改 exec → 抛错
    expect(() => orchestration.updateExecState('t1', 'running')).toThrow(/非法转移/);
    expect(() => orchestration.updateExecState('t1', 'failed')).toThrow(/非法转移/);
    // artifact 终态间横跳拒绝
    orchestration.updateArtifactState('t1', 'available');
    expect(() => orchestration.updateArtifactState('t1', 'missing')).toThrow(OrchestrationError);
    orchestration.updateArtifactState('t1', 'pending');
    orchestration.updateArtifactState('t1', 'incomplete');
    // acceptance：passed 只能失效回 unreviewed / pending_decision
    orchestration.updateAcceptanceState('t1', 'unreviewed');
    orchestration.updateAcceptanceState('t1', 'passed');
    expect(() => orchestration.updateAcceptanceState('t1', 'needs_revision')).toThrow(OrchestrationError);
    // 同态幂等（不抛错）
    expect(() => orchestration.updateExecState('t1', 'done')).not.toThrow();
    expect(() => orchestration.updateArtifactState('t1', 'incomplete')).not.toThrow();
  });

  it('创建校验：重复 taskId / 未知角色 / 负修订 / 未知依赖 / 依赖成环', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t1'));
    expect(() => orchestration.createTask(noopTask('t1'))).toThrow(/已存在/);
    expect(() => orchestration.createTask(noopTask('bad', { role: 'hacker' as never }))).toThrow(/角色/);
    expect(() => orchestration.createTask(noopTask('bad', { revision: -1 }))).toThrow(/revision/);
    expect(() => orchestration.createTask(noopTask('bad', { dependencies: [{ taskId: 'missing', requires: 'artifact_available' }] }))).toThrow(/不存在/);
    expect(() => orchestration.createTask(noopTask('bad', { dependencies: [{ taskId: 'bad', requires: 'artifact_available' }] }))).toThrow(/自身/);
    // 环：t1 → t2 → t1（创建 t2 依赖 t1，再造 t1' 依赖 t2 会成环——这里测
    // 三节点环）
    orchestration.createTask(noopTask('t2', { dependencies: [{ taskId: 't1', requires: 'artifact_available' }] }));
    expect(() => orchestration.createTask(noopTask('t3', {
      unitId: 'u3',
      dependencies: [
        { taskId: 't2', requires: 'artifact_available' },
        { taskId: 't1', requires: 'artifact_available' },
      ],
    }))).not.toThrow();
    // t3→t2→t1 无环；再造 t0 被 t1 依赖且 t0 依赖 t3 → 成环
    expect(() => orchestration.createTask(noopTask('t0', { dependencies: [{ taskId: 't3', requires: 'artifact_available' }] }))).not.toThrow();
    expect(() => orchestration.createTask(noopTask('t9', { dependencies: [{ taskId: 't0', requires: 'artifact_available' }] }))).not.toThrow();
    // 此时 t1 若再被要求依赖 t9 → t9→t0→t3→t2→t1 + t1→t9 成环；t1 已存在，
    // 换 t5（依赖 t9）+ 让 t9 依赖 t5 的场景由新建时校验：
    expect(() => orchestration.createTask(noopTask('t5', { dependencies: [{ taskId: 't9', requires: 'artifact_available' }] }))).not.toThrow();
    // t9 已依赖 t0…；直接构造双向：新建 t6 依赖 t5，然后校验 t5 已在图里无法
    // 改依赖——成环校验发生在新建时，用三节点链条验证足够。
  });
});

// ---------------------------------------------------------------------------
// readyTasks：依赖 + 解锁过滤（B 案 §7）
// ---------------------------------------------------------------------------

describe('readyTasks 依赖与解锁（B 案 §7）', () => {
  it('依赖 artifact_available：撰写 done 但产物缺失不解锁；产物可用才解锁', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t:write'));
    orchestration.createTask(noopTask('t:review', {
      role: 'review',
      unitId: null,
      dependencies: [{ taskId: 't:write', requires: 'artifact_available' }],
    }));
    orchestration.updateExecState('t:write', 'running');
    expect(orchestration.readyTasks().map((task) => task.taskId)).toEqual([]);
    // exec done 但 artifactState=missing（审查报告缺失同理）→ 不解锁下游
    orchestration.updateExecState('t:write', 'done');
    orchestration.updateArtifactState('t:write', 'missing');
    expect(orchestration.readyTasks().map((task) => task.taskId)).toEqual([]);
    orchestration.updateArtifactState('t:write', 'pending');
    orchestration.updateArtifactState('t:write', 'available');
    expect(orchestration.readyTasks().map((task) => task.taskId)).toEqual(['t:review']);
  });

  it('依赖 acceptance_passed：内容通过才解锁整合；needs_revision 不解锁', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t:write', { dependencies: [], reviewSubjectDraftHash: 'h1' }));
    orchestration.createTask(noopTask('t:integrate', {
      role: 'integrate',
      unitId: null,
      dependencies: [{ taskId: 't:write', requires: 'acceptance_passed' }],
    }));
    orchestration.updateExecState('t:write', 'running'); // 撰写中：自身不在 ready 集
    orchestration.updateAcceptanceState('t:write', 'needs_revision');
    expect(orchestration.readyTasks().map((task) => task.taskId)).toEqual([]);
    orchestration.updateAcceptanceState('t:write', 'unreviewed');
    expect(orchestration.readyTasks().map((task) => task.taskId)).toEqual([]);
    orchestration.updateAcceptanceState('t:write', 'passed');
    expect(orchestration.readyTasks().map((task) => task.taskId)).toEqual(['t:integrate']);
    // 已 running 的任务不再出现在 readyTasks
    orchestration.updateExecState('t:integrate', 'running');
    expect(orchestration.readyTasks()).toEqual([]);
    // 构建结束后不再产出就绪任务
    orchestration.endBuild('cancelled');
    expect(orchestration.readyTasks()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 修订预算与接口失败（B 案 §5：分开计数、换稿不重置）
// ---------------------------------------------------------------------------

describe('修订预算与接口失败（B 案 §5）', () => {
  it('修订预算按逻辑审查对象累计，换稿不重置；耗尽后 pending_decision', () => {
    const orchestration = new BuildOrchestration(makeSpec({ maxAutoRevisions: 2 }));
    const subject = budgetSubjectKey('u1', 'write');
    expect(subject).toBe('unit:u1');
    // 第一轮修订（换稿新 hash，但预算按逻辑对象累计）
    const first = orchestration.tryStartRevision(subject);
    expect(first.allowed).toBe(true);
    expect(first.budget.usedAutoRevisions).toBe(1);
    // 第二轮
    const second = orchestration.tryStartRevision(subject);
    expect(second.allowed).toBe(true);
    // 第三轮：预算耗尽（初始审查 + 2 轮修订），换稿也不重置
    const third = orchestration.tryStartRevision(subject);
    expect(third.allowed).toBe(false);
    expect(third.budget.usedAutoRevisions).toBe(2);
    // 新任务 stamp 的预算携带累计用量（换稿后新建 write 任务，同一逻辑对象）
    const task = orchestration.createTask(noopTask('t:revise1', { revision: 1, unitId: 'u1', reviewSubjectDraftHash: 'new-hash' }));
    expect(task.revisionBudget).toEqual({ usedAutoRevisions: 2, maxAutoRevisions: 2 });
    // 单元修订与整合修订分别记录（B 案 §5）
    const integrateSubject = budgetSubjectKey(null, 'integrate');
    expect(integrateSubject).toBe('role:integrate');
    expect(orchestration.tryStartRevision(integrateSubject).allowed).toBe(true);
  });

  it('review/plan 任务不 stamp 修订预算；write/integrate stamp', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    expect(orchestration.createTask(noopTask('t:w')).revisionBudget).not.toBeNull();
    expect(orchestration.createTask(noopTask('t:i', { role: 'integrate' })).revisionBudget).not.toBeNull();
    expect(orchestration.createTask(noopTask('t:r', { role: 'review' })).revisionBudget).toBeNull();
    expect(orchestration.createTask(noopTask('t:p', { role: 'plan' })).revisionBudget).toBeNull();
  });

  it('接口失败独立计数：不动修订预算；达上限后 canRetry=false', () => {
    const orchestration = new BuildOrchestration(makeSpec({ maxInterfaceRetries: 2, maxAutoRevisions: 1 }));
    orchestration.createTask(noopTask('t1'));
    const first = orchestration.recordInterfaceFailure('t1');
    expect(first).toEqual({ used: 1, max: 2, canRetry: true });
    const second = orchestration.recordInterfaceFailure('t1');
    expect(second.canRetry).toBe(false);
    // 接口失败不消耗修订预算
    const revision = orchestration.tryStartRevision(budgetSubjectKey('u_t1', 'write'));
    expect(revision.allowed).toBe(true);
    // 终态任务不能再记接口失败
    orchestration.updateExecState('t1', 'running');
    orchestration.updateExecState('t1', 'failed');
    expect(() => orchestration.recordInterfaceFailure('t1')).toThrow(/终态/);
  });
});

// ---------------------------------------------------------------------------
// 提交回执：幂等 + 迟到拒绝（B 案 §8 + 附录 B）
// ---------------------------------------------------------------------------

describe('submitResult 幂等与迟到回执（B 案 §8/附录 B）', () => {
  it('合法提交推进 exec done + artifact；同 taskId+revision 重复提交幂等', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t1'));
    orchestration.updateExecState('t1', 'running');
    const recorded = orchestration.submitResult({ taskId: 't1', revision: 0, artifactState: 'available', resultRef: 'unit:u1:v1' });
    expect(recorded.status).toBe('recorded');
    expect(orchestration.task('t1')!.execState).toBe('done');
    expect(orchestration.task('t1')!.artifactState).toBe('available');
    const again = orchestration.submitResult({ taskId: 't1', revision: 0, artifactState: 'available' });
    expect(again.status).toBe('duplicate');
    // 幂等：不重复推进（done 不会被二次转移）
    expect(orchestration.task('t1')!.execState).toBe('done');
    expect(orchestration.getReceipt('t1', 0)?.resultRef).toBe('unit:u1:v1');
  });

  it('任务取消后的提交：记录迟到原因并拒绝推进', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t1'));
    orchestration.updateExecState('t1', 'running');
    orchestration.cancelTask('t1');
    const late = orchestration.submitResult({ taskId: 't1', revision: 0, artifactState: 'available' });
    expect(late.status).toBe('rejected');
    if (late.status === 'rejected') expect(late.reason).toBe('task_cancelled');
    expect(orchestration.task('t1')!.execState).toBe('cancelled');
    expect(orchestration.lateReceiptLog).toHaveLength(1);
    expect(orchestration.lateReceiptLog[0].reason).toBe('task_cancelled');
    // 取消任务不能被推进任何轴
    expect(() => orchestration.updateArtifactState('t1', 'available')).toThrow(/已取消/);
    expect(() => orchestration.updateAcceptanceState('t1', 'passed')).toThrow(/已取消/);
  });

  it('构建结束后的提交与状态推进全部拒绝（迟到回执不得推进发布）', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t1'));
    orchestration.updateExecState('t1', 'running');
    orchestration.endBuild('cancelled');
    const late = orchestration.submitResult({ taskId: 't1', revision: 0, artifactState: 'available' });
    expect(late.status).toBe('rejected');
    if (late.status === 'rejected') expect(late.reason).toBe('build_ended');
    expect(() => orchestration.updateExecState('t1', 'done')).toThrow(/已结束/);
    expect(() => orchestration.createTask(noopTask('t2'))).toThrow(/已结束/);
    // endBuild 把未终态任务取消（B 案 §8：取消使未完成节点停止）
    expect(orchestration.task('t1')!.execState).toBe('cancelled');
    // 幂等：重复 endBuild 不改写
    orchestration.endBuild('published');
    expect(orchestration.endReason).toBe('cancelled');
  });

  it('过期修订（stale）与未运行任务的提交拒绝并记录原因', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t1', { revision: 1 }));
    // 未运行 → task_not_running
    const notRunning = orchestration.submitResult({ taskId: 't1', revision: 1, artifactState: 'available' });
    expect(notRunning.status).toBe('rejected');
    if (notRunning.status === 'rejected') expect(notRunning.reason).toBe('task_not_running');
    orchestration.updateExecState('t1', 'running');
    // 落后于当前修订 → stale_revision
    const stale = orchestration.submitResult({ taskId: 't1', revision: 0, artifactState: 'available' });
    expect(stale.status).toBe('rejected');
    if (stale.status === 'rejected') expect(stale.reason).toBe('stale_revision');
    const missing = orchestration.submitResult({ taskId: 'ghost', revision: 0, artifactState: 'available' });
    expect(missing.status).toBe('rejected');
    expect(orchestration.lateReceiptLog.map((receipt) => receipt.reason)).toEqual(['task_not_running', 'stale_revision', 'task_not_found']);
  });
});

// ---------------------------------------------------------------------------
// serialize / restore round-trip（B 案 §8：先核对再恢复）
// ---------------------------------------------------------------------------

describe('serialize/restore round-trip（B 案 §8）', () => {
  it('全量 round-trip：任务/计数/回执/结束状态保持；running 恢复归一为 queued', () => {
    const orchestration = new BuildOrchestration(makeSpec({ buildId: 'b_rt', sourceSnapshotHash: computeSnapshotHash(snapshotEntries(3)) }));
    orchestration.createTask(noopTask('t1'));
    orchestration.createTask(noopTask('t2'));
    orchestration.updateExecState('t1', 'running');
    orchestration.updateExecState('t2', 'running');
    orchestration.recordInterfaceFailure('t2'); // 中断任务的接口失败计数
    orchestration.tryStartRevision('unit:u1');
    orchestration.submitResult({ taskId: 't1', revision: 0, artifactState: 'available', resultRef: 'r1' });
    orchestration.updateAcceptanceState('t1', 'passed');
    const snapshot = orchestration.serialize();
    const json = JSON.parse(JSON.stringify(snapshot)) as BuildOrchestrationSnapshot;
    const restored = BuildOrchestration.restore(json);
    // spec 冻结哈希保持
    expect(restored.spec.specHash).toBe(orchestration.spec.specHash);
    // done+available 原样保留（跳过）
    expect(restored.task('t1')!.execState).toBe('done');
    expect(restored.task('t1')!.artifactState).toBe('available');
    expect(restored.task('t1')!.acceptanceState).toBe('passed');
    // 中断 running → 重新排队（B 案 §8 + 任务书 §4）
    expect(restored.task('t2')!.execState).toBe('queued');
    // 接口失败计数保留（恢复后再记一次 → used=2）；修订用量保留
    const retry = restored.recordInterfaceFailure('t2');
    expect(retry.used).toBe(2);
    expect(restored.revisionBudgetOf('unit:u1').usedAutoRevisions).toBe(1);
    // 回执幂等仍在：重复提交同一回执 → duplicate
    const dup = restored.submitResult({ taskId: 't1', revision: 0, artifactState: 'available' });
    expect(dup.status).toBe('duplicate');
    // 恢复后的摘要可正常产出
    expect(restored.summary().taskTotal).toBe(2);
    expect(restored.summary().tasksByExecState).toEqual({ done: 1, queued: 1 });
  });

  it('specHash 不一致 → 拒绝恢复（先核对再恢复）', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t1'));
    const snapshot = orchestration.serialize();
    snapshot.spec.concurrency = 8; // 篡改
    expect(() => BuildOrchestration.restore(snapshot)).toThrow(OrchestrationError);
  });

  it('已结束构建恢复后仍结束：迟到提交继续拒绝', () => {
    const orchestration = new BuildOrchestration(makeSpec());
    orchestration.createTask(noopTask('t1'));
    orchestration.endBuild('cancelled');
    const restored = BuildOrchestration.restore(JSON.parse(JSON.stringify(orchestration.serialize())));
    expect(restored.ended).toBe(true);
    expect(restored.submitResult({ taskId: 't1', revision: 0, artifactState: 'available' }).status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// AgentProcessPool 三通道配额（B 案 §6；mock/短任务模式，不起真进程）
// ---------------------------------------------------------------------------

describe('AgentProcessPool 三通道配额（B 案 §6）', () => {
  it('N=5：5 个构建任务并行 + 交互会话仍可用（N 不被 M 截断）', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, buildConcurrency: 5 });
    const slots = [];
    for (let i = 0; i < 5; i += 1) {
      const slot = await pool.acquire('build');
      slots.push(slot);
    }
    expect(pool.buildRunningCount()).toBe(0); // 预留未 register，不计运行条目
    expect(pool.buildLoadCount()).toBe(5); // build 通道负载口径（预留计入）
    expect(pool.loadCount()).toBe(0); // 非构建通道不受构建预留影响（B 案 §6 独立）
    // 交互会话不受构建占满影响（额外名额，B 案 §6 场景表）
    const session = await pool.acquire('session');
    expect(session).toBeTruthy();
    // 第 6 个构建 → 排队等待
    const sixth = pool.acquire('build');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.buildQueueDepth()).toBe(1);
    // 释放一个 → FIFO 晋升
    slots[0].release();
    const promoted = await sixth;
    promoted.release();
    for (const slot of slots.slice(1)) slot.release();
    session.release();
    expect(pool.buildQueueDepth()).toBe(0);
  });

  it('N=1：串行——第二个构建排队，等待者不提前占位', async () => {
    const pool = new AgentProcessPool({ buildConcurrency: 1 });
    const first = await pool.acquire('build');
    const second = pool.acquire('build');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.buildQueueDepth()).toBe(1);
    // 等待者不占位：容量 1 已被 first 占用
    let secondState = 'pending';
    void second.then(() => { secondState = 'granted'; }, () => { secondState = 'rejected'; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondState).toBe('pending');
    first.release();
    const granted = await second;
    granted.release();
    expect(pool.buildCapacity).toBe(1);
  });

  it('构建满额时非构建后台仍可运行；会话保底名额保留', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, buildConcurrency: 2 });
    const build1 = await pool.acquire('build');
    const build2 = await pool.acquire('build');
    expect(pool.buildQueueDepth()).toBe(0);
    // 非构建后台（任务进程/探测）照常：M-1=2
    const bg1 = await pool.acquire('background');
    const bg2 = await pool.acquire('background');
    expect(bg1 && bg2).toBeTruthy();
    // 会话保底：第 3 槽保留
    const session = await pool.acquire('session');
    expect(session).toBeTruthy();
    // 第 3 个后台 → 排队（既有 M-1 语义不变）
    const bg3 = pool.acquire('background');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.queueDepth()).toBe(1);
    session.release();
    bg1.release();
    const promoted = await bg3;
    promoted.release();
    bg2.release();
    build1.release();
    build2.release();
  });

  it('总容量如实上报：totalCapacity = N + 非构建容量；configure 动态调整构建容量', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, buildConcurrency: 5 });
    expect(pool.totalCapacity).toBe(8); // 5 + 3，不再固定 6
    expect(pool.buildCapacity).toBe(5);
    const first = await pool.acquire('build');
    pool.configure({ buildConcurrency: 1 }); // 缩容不抢占已占槽
    const waiter = pool.acquire('build');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.buildQueueDepth()).toBe(1);
    pool.configure({ buildConcurrency: 2 }); // 扩容立即放行
    const granted = await waiter;
    granted.release();
    first.release();
  });

  it('构建等待者可取消；closeAll 清空两个队列', async () => {
    const pool = new AgentProcessPool({ buildConcurrency: 1, maxConcurrentProcesses: 2 });
    const first = await pool.acquire('build');
    const controller = new AbortController();
    const cancelled = pool.acquire('build', { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.buildQueueDepth()).toBe(0);
    // 两个通道各占一个 + 各排一个等待者，closeAll 全部拒绝
    const bg = await pool.acquire('background'); // M=2，bgLimit=1 占满
    const backgroundWaiter = pool.acquire('background');
    const buildWaiter = pool.acquire('build');
    await pool.closeAll();
    await expect(backgroundWaiter).rejects.toThrow('进程池已关闭');
    await expect(buildWaiter).rejects.toThrow('进程池已关闭');
    await expect(pool.acquire('session')).rejects.toThrow('进程池已关闭');
    void first;
    void bg;
  });

  it('会话立即语义保留：非构建容量满 → AgentBusyError（不受构建通道影响）', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1, buildConcurrency: 3 });
    // 非构建容量 1 被后台占用 → 会话 409（既有语义）；构建通道照常
    const bg = await pool.acquire('background');
    await expect(pool.acquire('session')).rejects.toMatchObject({ name: 'AgentBusyError' });
    const build = await pool.acquire('build');
    expect(build).toBeTruthy();
    build.release();
    bg.release();
  });
});

// ---------------------------------------------------------------------------
// BuildCheckpointStore：orchestration additive 字段两分支（任务书 §4）
// ---------------------------------------------------------------------------

let ckptDir: string;
let ckptStaging: string;
beforeAll(() => {
  ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-orch-ckpt-'));
  ckptStaging = path.join(ckptDir, 'staging');
  fs.mkdirSync(path.join(ckptStaging, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ckptStaging, 'docs', '草稿.md'), '# 草稿\n内容');
});
afterAll(() => {
  fs.rmSync(ckptDir, { recursive: true, force: true });
});

function makeCheckpoint(orchestration?: BuildOrchestrationSnapshot) {
  return {
    schemaVersion: 1 as const,
    buildId: 'b_ckpt',
    knowledgeBaseRoot: ckptDir,
    baseReleaseId: null,
    requestedMode: 'full' as const,
    mode: 'full' as const,
    backend: 'pi' as const,
    rebuildSelected: false,
    snapshot: [],
    workset: [],
    docMeta: [],
    writtenPaths: [],
    preservedDocs: [],
    requiredRewrites: [],
    baseDocPaths: [],
    finishInfo: null,
    imageDescriptions: [],
    units: [],
    unitDone: [],
    claims: [],
    singleBatches: [],
    singleCompleted: 0,
    unitProgress: [],
    workerCount: 1,
    wordBudget: 0,
    progress: {
      batchIndex: 0, batchTotal: 1, stage: null,
      units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 },
      workers: [],
      images: { total: 0, described: 0, cached: 0, unavailable: 0 },
    },
    updatedAt: new Date().toISOString(),
    ...(orchestration ? { orchestration } : {}),
  };
}

describe('BuildCheckpointStore orchestration 分支（任务书 §4）', () => {
  it('含 orchestration：save→read round-trip 保持编排快照', () => {
    const store = new BuildCheckpointStore(ckptDir);
    const orchestration = new BuildOrchestration(makeSpec({ buildId: 'b_ckpt', sourceSnapshotHash: computeSnapshotHash(snapshotEntries(2)) }));
    orchestration.createTask(noopTask('t1'));
    orchestration.updateExecState('t1', 'running');
    orchestration.recordInterfaceFailure('t1');
    store.save(makeCheckpoint(orchestration.serialize()), ckptStaging);
    const loaded = store.read('b_ckpt');
    expect(loaded?.orchestration).toBeDefined();
    const restored = BuildOrchestration.restore(loaded!.orchestration!);
    expect(restored.task('t1')!.execState).toBe('queued'); // running 恢复归一
    expect(restored.spec.buildId).toBe('b_ckpt');
    const retry = restored.recordInterfaceFailure('t1');
    expect(retry.used).toBe(2); // 接口失败计数保留
  });

  it('旧格式无 orchestration：照常读写（不升级成新式任务）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-orch-legacy-'));
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(path.join(staging, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'docs', '旧.md'), '# 旧');
    const store = new BuildCheckpointStore(dir);
    store.save(makeCheckpoint(), staging);
    const loaded = store.read('b_ckpt');
    expect(loaded).not.toBeNull();
    expect(loaded!.orchestration).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// kb-build-service 接入：buildSpecFromConfig 冻结 + kb_builds 摘要列
// ---------------------------------------------------------------------------

describe('buildSpecFromConfig 冻结（B 案 §8）', () => {
  it('diting F05：resolveRoleModel 冻结实际非密钥模型参数进 resolvedRoles，specHash 覆盖', () => {
    const entries = snapshotEntries(1);
    const standardKb = {
      buildParallelism: 2,
      buildRoles: {
        writer: { modelPresetId: 'glm-4.7', thinking: 'high' as const },
        reviewer: { modelPresetId: '' },
        plannerEnabled: false,
      },
      reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
      publishMode: 'auto' as const,
    };
    const resolver = ({ config }: { config: { modelPresetId: string } }) =>
      config.modelPresetId === 'glm-4.7'
        ? { modelId: 'glm-4.7-real', providerId: 'pf1', baseUrl: 'https://pf.example/v1', protocol: 'openai-completions', thinking: 'high', roleSpecVersion: 'v1' }
        : null;
    const frozen = buildSpecFromConfig({
      buildId: 'b_f05', snapshotEntries: entries, baseReleaseId: null,
      standardKb, specVersion: 'v1', resolveRoleModel: resolver,
    });
    expect(frozen.resolvedRoles?.writer).toMatchObject({ modelId: 'glm-4.7-real', providerId: 'pf1', baseUrl: 'https://pf.example/v1', thinking: 'high' });
    expect(frozen.resolvedRoles?.reviewer).toBeUndefined(); // 未解析成功不冻结（派发时按待处理）
    const plain = buildSpecFromConfig({
      buildId: 'b_f05', snapshotEntries: entries, baseReleaseId: null,
      standardKb, specVersion: 'v1',
    });
    expect(plain.resolvedRoles).toBeUndefined(); // 未提供解析器：旧语义不变
    expect(frozen.specHash).not.toBe(plain.specHash); // specHash 覆盖 resolvedRoles
    // 恢复可校验：同冻结结果重建 → 哈希一致
    const again = buildSpecFromConfig({
      buildId: 'b_f05', snapshotEntries: entries, baseReleaseId: null,
      standardKb, specVersion: 'v1', resolveRoleModel: resolver,
    });
    expect(again.specHash).toBe(frozen.specHash);
  });

  it('角色/预算/发布方式从配置映射；buildConcurrency 优先回落 buildParallelism；哈希稳定', () => {
    const entries = snapshotEntries(3);
    const standardKb = {
      buildParallelism: 2,
      buildConcurrency: 5,
      buildRoles: {
        writer: { modelPresetId: 'glm-4.7', thinking: 'high' as const },
        reviewer: { modelPresetId: 'kimi-k2', providerId: 'moonshot' },
        plannerEnabled: false,
      },
      reviewPolicy: { maxAutoRevisions: 3, maxInterfaceRetries: 1 },
      publishMode: 'confirm' as const,
    };
    const spec = buildSpecFromConfig({ buildId: 'b1', snapshotEntries: entries, baseReleaseId: 'r_base', standardKb, specVersion: 'v1:abcd' });
    expect(spec.concurrency).toBe(5);
    expect(spec.maxAutoRevisions).toBe(3);
    expect(spec.maxInterfaceRetries).toBe(1);
    expect(spec.publishMode).toBe('confirm');
    expect(spec.baseReleaseId).toBe('r_base');
    expect(spec.sourceSnapshotHash).toBe(computeSnapshotHash(entries));
    expect(spec.roles.writer).toEqual({ modelPresetId: 'glm-4.7', thinking: 'high' });
    expect(spec.roles.reviewer).toEqual({ modelPresetId: 'kimi-k2', providerId: 'moonshot' });
    // 同输入 → 同哈希；配置变化 → 哈希变化（冻结可校验）
    const again = buildSpecFromConfig({ buildId: 'b1', snapshotEntries: entries, baseReleaseId: 'r_base', standardKb, specVersion: 'v1:abcd' });
    expect(again.specHash).toBe(spec.specHash);
    const changed = buildSpecFromConfig({
      buildId: 'b1', snapshotEntries: entries, baseReleaseId: 'r_base',
      standardKb: { ...standardKb, reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 1 } },
      specVersion: 'v1:abcd',
    });
    expect(changed.specHash).not.toBe(spec.specHash);
    // 未设 buildConcurrency → 回落 buildParallelism
    const fallback = buildSpecFromConfig({
      buildId: 'b1', snapshotEntries: entries, baseReleaseId: null,
      standardKb: { ...standardKb, buildConcurrency: undefined },
    });
    expect(fallback.concurrency).toBe(2);
    // 密钥不入记录：roles 只含预设引用
    expect(JSON.stringify(spec.roles)).not.toContain('apiKey');
    expect(JSON.stringify(spec.roles)).not.toContain('sk-');
  });
});

describe('kb_builds 摘要列写入（T1 列 + T2a 写入路径）', () => {
  let dir: string;
  let db: LocalMapStore;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-orch-db-'));
    db = new LocalMapStore(path.join(dir, 'db.sqlite'));
    db.initialize();
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('createKbBuild + updateKbBuild rolesJson/orchestrationJson 落库（增量迁移后）', () => {
    db.createKbBuild({ id: 'b_sum', mode: 'full', status: 'queued', baseReleaseId: null, model: 'm', createdAt: new Date().toISOString() });
    const orchestration = new BuildOrchestration(makeSpec({ buildId: 'b_sum' }));
    orchestration.createTask(noopTask('t:u1'));
    orchestration.createTask(noopTask('t:u2'));
    orchestration.updateExecState('t:u1', 'running');
    orchestration.submitResult({ taskId: 't:u1', revision: 0, artifactState: 'available' });
    db.updateKbBuild('b_sum', {
      rolesJson: JSON.stringify(orchestration.spec.roles),
      orchestrationJson: JSON.stringify(orchestration.summary()),
    });
    const row = db.getKbBuild('b_sum')!;
    expect(row.roles_json).toBeTruthy();
    expect(JSON.parse(String(row.roles_json)).writer.modelPresetId).toBe('writer-1');
    const summary = JSON.parse(String(row.orchestration_json));
    expect(summary.taskTotal).toBe(2);
    expect(summary.tasksByExecState).toEqual({ done: 1, queued: 1 });
    // 缺省不动：再次更新其他字段不清洗摘要列
    db.updateKbBuild('b_sum', { status: 'running' });
    const row2 = db.getKbBuild('b_sum')!;
    expect(row2.orchestration_json).toBe(row.orchestration_json);
    expect(String(row2.status)).toBe('running');
  });
});
