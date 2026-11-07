/**
 * A2 在途派发准入 — host 侧快照与 A1 池容量组装测试（kb-build-speedup WP-A）
 *
 * 覆盖：
 * - assembleSpec：同模型时 writer/reviewer/research 共享整池容量 = max
 *   （R1 修复：旧实现 floor(max/2) 使同池两角色只得半容池）；异模型保持
 *   「总和 ≤ max、写作优先」语义；max=1 同模型在修复后的校验下合法。
 * - composeDispatchInflightSnapshot：在途快照组装（role 取账本登记名，
 *   backlog 信号透传）。
 * - writeDispatchInflightSnapshot：落盘 seq 单调递增、代次换代后重写不
 *   泄漏旧代次在途、epoch 与 adapter 同口径。
 * - BuildActorStore.dispatchBacklogSignal：待审/待修订推导与修订落地收敛。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildRuntimeHost } from '../src/kb/build-runtime-host.js';
import { composeDispatchInflightSnapshot } from '../src/kb/build-runtime-host.js';
import { BuildActorStore } from '../src/kb/build-actors.js';
import { validateBuildRunSpec, type BuildRunSpec } from '../src/agent/build-runtime/contracts.js';
import type { DispatchInflightSnapshot } from '../src/agent/build-runtime/dispatch-guard.js';

type HostInternals = {
  assembleSpec: (input: Record<string, unknown>, amagiPackage: BuildRunSpec['amagiPackage'], piVersion: string, bridge: { bridgeCommand: string; bridgeArgs: string[] }) => BuildRunSpec;
  writeDispatchInflightSnapshot: (session: unknown, supervisor: unknown, warn: (message: string) => void) => void;
};
const host = new BuildRuntimeHost({ dataRoot: '/data' } as ConstructorParameters<typeof BuildRuntimeHost>[0]) as unknown as HostInternals;

const AMAGI: BuildRunSpec['amagiPackage'] = {
  version: '2.21.31',
  installDir: '/data/agent/runtime-packages/amagi-pi@2.21.31',
  packageRoot: '/data/agent/runtime-packages/amagi-pi@2.21.31/package',
  contentHash: 'c'.repeat(16),
};
const model = (id: string) => ({
  provider: 'zhipuai' as const,
  modelId: id,
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  reasoning: true,
  thinkingLevels: ['low', 'high'],
  thinking: 'high' as const,
  contextWindow: 128_000,
  maxTokens: 32_768,
});

function assemble(input: { sameModel?: boolean; max: number }): BuildRunSpec {
  return host.assembleSpec({
    buildId: 'b_20261106090000_wpatest',
    mode: 'full',
    generation: 1,
    models: {
      leader: model('glm-5.3'),
      writer: model(input.sameModel === false ? 'glm-5.3-flash' : 'glm-5.3'),
      reviewer: model('glm-5.3'),
    },
    maxConcurrentAgents: input.max,
    publicationPolicy: 'auto',
    workflowRevision: 'b'.repeat(12),
    workflowSkillPath: '/tmp/skills/kb-build/SKILL.md',
    apiKeys: { zhipuai: 'k' },
    leaderBriefing: '',
    resumeBriefing: '',
    rebuildResume: null,
    stagingRoot: '/tmp/staging',
    buildState: { gatePolicy: { strict: true } },
    material: {} as never,
    priorState: null,
    resumeStrategy: undefined,
    publishExecutor: null as never,
    onCheckpoint: () => {},
    log: () => {},
    signal: new AbortController().signal,
  }, AMAGI, '1.4.0', { bridgeCommand: '/usr/local/bin/node', bridgeArgs: [] });
}

describe('A1 assembleSpec 池容量（R1 修复）', () => {
  for (const max of [1, 2, 3, 6]) {
    it(`同模型 max=${max} → writer=reviewer=${max}，validate 通过`, () => {
      const spec = assemble({ max, sameModel: true });
      expect(spec.limits.maxConcurrentAgents).toBe(max);
      expect(spec.limits.admissionPools).toEqual({ writer: max, reviewer: max });
      expect(validateBuildRunSpec(spec)).toEqual([]);
    });
  }
  it('异模型保持写作优先：reviewer=min(2,max-1)，writer=余量，总和=max', () => {
    const spec = assemble({ max: 6, sameModel: false });
    expect(spec.limits.admissionPools).toEqual({ writer: 4, reviewer: 2 });
    expect(validateBuildRunSpec(spec)).toEqual([]);
    expect(assemble({ max: 3, sameModel: false }).limits.admissionPools).toEqual({ writer: 1, reviewer: 2 });
    // 异模型两池在 max=1 时无法再压（各至少 1）——assembleSpec 内建校验如实抛错，不静默降级
    expect(() => assemble({ max: 1, sameModel: false })).toThrow('超过 maxConcurrentAgents=1');
  });
});

describe('composeDispatchInflightSnapshot', () => {
  it('透传在途角色/状态与 backlog；role 取账本登记名兜底 unknown', () => {
    const snapshot = composeDispatchInflightSnapshot({
      buildId: 'b_x',
      generation: 2,
      seq: 7,
      now: '2026-11-06T00:00:00.000Z',
      actors: [
        { nativeTaskId: 't1', role: 'luban', execState: 'running', status: 'confirmed', generation: 2, lastEventAt: '', parentTaskId: null },
        { nativeTaskId: 't2', role: 'unknown', execState: 'queued', status: 'pending', generation: 2, lastEventAt: '', parentTaskId: null },
      ],
      roleOf: (id) => (id === 't1' ? 'luban' : 'unknown'),
      backlog: { pendingReview: 1, pendingRevision: 2 },
    });
    expect(snapshot).toEqual({
      schemaVersion: 1,
      buildId: 'b_x',
      generation: 2,
      seq: 7,
      updatedAt: '2026-11-06T00:00:00.000Z',
      inflight: [{ role: 'luban', state: 'running' }, { role: 'unknown', state: 'queued' }],
      pendingReview: 1,
      pendingRevision: 2,
    } satisfies DispatchInflightSnapshot);
  });
});

describe('writeDispatchInflightSnapshot（host 落盘）', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpA-inflight-'));
  const buildId = 'b_20261106090000_wpatest';
  type SnapshotHost = HostInternals & { deps: { dataRoot: string }; dispatchInflightSeq: Map<string, number> };
  const snapshotHost = new BuildRuntimeHost({ dataRoot } as ConstructorParameters<typeof BuildRuntimeHost>[0]) as unknown as SnapshotHost;
  const file = path.join(dataRoot, 'agent', 'builds', buildId, 'epochs', 'e1', 'dispatch-inflight.json');

  function stubSupervisor(actors: Array<{ nativeTaskId: string; role: string; execState: string; generation: number }>, generation: number, runtimeEpoch = 1) {
    return {
      state: { generation, runtimeEpoch, binding: null },
      dispatchInflightActors: () => actors,
    };
  }

  it('seq 单调递增；换代后 generation 重写、旧代次在途不再写入', () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'wpA-store-'));
    const store = new BuildActorStore({ buildId, stagingRoot: staging, generation: 1 });
    store.registerTaskCreation({ nativeTaskId: 't1', requestedRole: 'luban' });
    const session = { buildId, generation: 1, actorStore: store };
    const supervisor = stubSupervisor([{ nativeTaskId: 't1', role: 'luban', execState: 'running', generation: 1 }], 1);
    snapshotHost.writeDispatchInflightSnapshot(session, supervisor, () => { throw new Error('不应告警'); });
    const first = JSON.parse(fs.readFileSync(file, 'utf-8')) as DispatchInflightSnapshot;
    expect(first.generation).toBe(1);
    expect(first.inflight).toEqual([{ role: 'luban', state: 'running' }]);
    expect(first.seq).toBe(1);
    snapshotHost.writeDispatchInflightSnapshot(session, supervisor, () => {});
    expect((JSON.parse(fs.readFileSync(file, 'utf-8')) as DispatchInflightSnapshot).seq).toBe(2);
    // 换代（generation=2）：旧文件 generation 不匹配 → seq 不继承、整文件重写
    const session2 = { buildId, generation: 2, actorStore: store };
    const supervisor2 = stubSupervisor([], 2);
    snapshotHost.writeDispatchInflightSnapshot(session2, supervisor2, () => {});
    const second = JSON.parse(fs.readFileSync(file, 'utf-8')) as DispatchInflightSnapshot;
    expect(second.generation).toBe(2);
    expect(second.inflight).toEqual([]);
    expect(second.seq).toBe(1);
  });
});

describe('BuildActorStore.dispatchBacklogSignal', () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'wpA-backlog-'));
  const store = new BuildActorStore({ buildId: 'b_backlog', stagingRoot: staging, generation: 1 });

  it('无写入 → 无积压；写入后未审 → 待审；needs_revision 未修订 → 待修订；修订落地 → 收敛', () => {
    expect(store.dispatchBacklogSignal()).toEqual({ pendingReview: 0, pendingRevision: 0 });
    store.registerTaskCreation({ nativeTaskId: 'author-1', requestedRole: 'luban' });
    store.recordReceipt({
      authorTaskId: 'author-1', kind: 'write_doc', operationId: 'op-1', payloadHash: 'h', paths: ['A.md'], result: {},
    });
    expect(store.dispatchBacklogSignal()).toEqual({ pendingReview: 1, pendingRevision: 0 });
    store.registerTaskCreation({ nativeTaskId: 'review-1', requestedRole: 'diting' });
    store.recordReview({
      reviewerTaskId: 'review-1',
      draftHash: 'd', dependencyHashes: {}, ruleVersion: 'r',
      issues: [{ issueId: 'i1', severity: 'blocking', draftLocation: 'A.md:1', sourceLocation: null, description: 'x' }],
      verdict: 'needs_revision', scopePaths: ['A.md'],
    });
    // 已审（不再待审）但待修订
    expect(store.dispatchBacklogSignal()).toEqual({ pendingReview: 0, pendingRevision: 1 });
    store.recordReceipt({
      authorTaskId: 'author-1', kind: 'edit_doc', operationId: 'op-2', payloadHash: 'h2', paths: ['A.md'], result: {},
    });
    // 修订落地（写入回执晚于审查）→ 无积压
    expect(store.dispatchBacklogSignal()).toEqual({ pendingReview: 0, pendingRevision: 0 });
  });
});
