/**
 * 重构 v2：Leader 监督检查点（build-checkpoint leaderRun 字段，schemaVersion 2）测试。
 *
 * 覆盖：
 * - leaderRun（含成果账本载荷 actorPayload）随检查点原子落盘/回读；
 * - 旧检查点（无 leaderRun 字段）→ 按 legacy 语义恢复（字段保持缺省）；
 * - 非法 leaderRun 形状（schemaVersion 1 废弃形状/缺 material）→ 拒读（不伪造恢复）；
 * - 监督状态经 JSON round-trip 后可重建监督器并保留身份/游标。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildCheckpointStore, type BuildCheckpoint } from '../src/kb/build-checkpoint.js';
import { BuildLeaderSupervisor, freshLeaderRunState, type LeaderRunOutcome } from '../src/kb/build-leader-supervisor.js';
import type { BuildRunSpec, RuntimeBinding, RuntimeEvent } from '../src/agent/build-runtime/contracts.js';
import type { KbBuildProgressDto, LeaderRunCheckpointState } from '../src/types/agent-knowledge.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-cp-'));
  fs.mkdirSync(path.join(root, 'standard-kb'), { recursive: true });
  return root;
}

function progress(): KbBuildProgressDto {
  return { batchIndex: 0, batchTotal: 0, stage: null, units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 }, workers: [], images: { total: 0, described: 0, cached: 0, unavailable: 0 } };
}

/** 运行层 spec fixture（runtime/contracts 形状；哈希/amagi 包为形式合法值）。 */
function specFixture(buildId: string, generation = 1): BuildRunSpec {
  return {
    buildId,
    generation,
    orchestrationMode: 'pi-amagi',
    mode: 'full',
    sourceManifestHash: 'a'.repeat(64),
    workflowRevision: 'f'.repeat(64),
    workflowSkillPath: '/tmp/skills/knowledge-build/SKILL.md',
    amagiPackage: { version: '2.21.31', installDir: '/tmp/amagi-pi@2.21.31', packageRoot: '/tmp/amagi-pi@2.21.31/package', contentHash: 'p'.repeat(64) },
    piVersion: '1.4.0',
    agentDirConfigHash: 'c'.repeat(64),
    models: { leader: 'zhipuai/glm-5.3', writer: 'zhipuai/glm-5.3-flash', reviewer: 'zhipuai/glm-5.3', research: 'zhipuai/glm-5.3-flash' },
    modelDescriptors: [
      { id: 'glm-5.3', baseUrl: 'https://fixture.example/v1', api: 'openai-completions' },
      { id: 'glm-5.3-flash', baseUrl: 'https://fixture.example/v1', api: 'openai-completions' },
    ],
    roles: { writer: 'luban', reviewer: 'diting', research: 'baize' },
    limits: { maxConcurrentAgents: 6, admissionPools: { writer: 4, reviewer: 2 } },
    autoRounds: { verify: false, continueRounds: 1, repairRounds: 1, implicitRetryRounds: 1 },
    publicationPolicy: 'auto',
  };
}

function checkpointFixture(leaderRun?: LeaderRunCheckpointState): BuildCheckpoint {
  return {
    schemaVersion: 1,
    buildId: 'b_leadertest01',
    knowledgeBaseRoot: '/tmp/raw-fixture',
    baseReleaseId: null,
    requestedMode: 'full',
    mode: 'full',
    backend: 'pi',
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
    progress: progress(),
    updatedAt: new Date().toISOString(),
    ...(leaderRun ? { leaderRun } : {}),
  } as BuildCheckpoint;
}

function stagingFixture(root: string): string {
  const staging = path.join(root, '.staging', 'b_leadertest01');
  fs.mkdirSync(path.join(staging, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'docs', 'intro.md'), '# Intro\nfixture\n');
  return staging;
}

describe('Leader 监督检查点（schemaVersion 2）', () => {
  it('leaderRun（含成果账本载荷）随检查点原子落盘并可回读', () => {
    const root = tempRoot();
    try {
      const state = freshLeaderRunState(specFixture('b_leadertest01'), { mode: 'full', sourceSnapshotHash: 'a'.repeat(64), baseReleaseId: null });
      state.actors.push({ nativeTaskId: 't1', parentTaskId: null, generation: 1, role: 'luban', status: 'confirmed', execState: 'done', lastEventAt: new Date().toISOString() });
      state.eventCursor['leader-rpc'] = 'evt-9';
      state.binding = { buildId: 'b_leadertest01', generation: 1, agentDir: '/tmp/agentdir', workDir: '/tmp/workdir', leaderSessionId: 's1', leaderPid: null, resumeCapability: { session: true, artifact: true } } satisfies RuntimeBinding;
      state.publishRequest = { requestId: 'pub_x', candidateRevision: 'c'.repeat(64), summary: 'fixture', accepted: false, status: 'pending', decidedAt: new Date().toISOString() };
      state.actorPayload = {
        schemaVersion: 1,
        buildId: 'b_leadertest01',
        generation: 1,
        actors: [],
        assignments: [],
        receipts: [],
        reviews: [],
        handoffs: [],
        issueLists: [],
        publishRequests: [],
        eventCursor: null,
      };
      const store = new BuildCheckpointStore(path.join(root, 'standard-kb'));
      store.save(checkpointFixture(state), stagingFixture(root));
      const restored = store.read('b_leadertest01');
      expect(restored?.leaderRun).toBeDefined();
      expect(restored?.leaderRun?.schemaVersion).toBe(2);
      expect(restored?.leaderRun?.actors).toHaveLength(1);
      expect(restored?.leaderRun?.eventCursor['leader-rpc']).toBe('evt-9');
      expect(restored?.leaderRun?.binding?.leaderSessionId).toBe('s1');
      expect(restored?.leaderRun?.publishRequest?.status).toBe('pending');
      expect(restored?.leaderRun?.actorPayload?.buildId).toBe('b_leadertest01');
      expect(restored?.leaderRun?.material.sourceSnapshotHash).toBe('a'.repeat(64));
      expect(store.summary('b_leadertest01')?.draftCount).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('旧检查点（无 leaderRun 字段）按 legacy 语义恢复：字段缺省不升级', () => {
    const root = tempRoot();
    try {
      const store = new BuildCheckpointStore(path.join(root, 'standard-kb'));
      store.save(checkpointFixture(), stagingFixture(root));
      const restored = store.read('b_leadertest01');
      expect(restored).not.toBeNull();
      expect(restored?.leaderRun).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('非法 leaderRun 形状（废弃 schemaVersion 1 / 缺 material）拒读（不伪造恢复）', () => {
    const root = tempRoot();
    try {
      const store = new BuildCheckpointStore(path.join(root, 'standard-kb'));
      const base = freshLeaderRunState(specFixture('b_leadertest01'), { mode: 'full', sourceSnapshotHash: 'a'.repeat(64), baseReleaseId: null });
      const v1 = { ...base, schemaVersion: 1 as 2 } as LeaderRunCheckpointState;
      store.save(checkpointFixture(v1), stagingFixture(root));
      expect(() => store.read('b_leadertest01')).toThrow('Leader 运行检查点无效');
      const noMaterial = { ...base, material: undefined } as unknown as LeaderRunCheckpointState;
      store.save(checkpointFixture(noMaterial), stagingFixture(root));
      expect(() => store.read('b_leadertest01')).toThrow('Leader 运行检查点无效');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('监督状态 JSON round-trip 后可重建监督器并保留身份/游标', async () => {
    const root = tempRoot();
    try {
      const state = freshLeaderRunState(specFixture('b_leadertest01'), { mode: 'full', sourceSnapshotHash: 'a'.repeat(64), baseReleaseId: null });
      state.eventCursor['tool-service'] = 'ts-3';
      const serialized = JSON.parse(JSON.stringify(state)) as LeaderRunCheckpointState;
      const order: string[] = [];
      // 事件流立即结束且未取消 → leader-failed（不伪造成功）
      const emptyEvents = async function* (): AsyncGenerator<RuntimeEvent> { /* 无事件 */ };
      const supervisor = new BuildLeaderSupervisor({
        pool: new AgentProcessPool(),
        log: () => undefined,
        persistCheckpoint: () => undefined,
        revokeCredentials: () => order.push('revoke'),
        startLeader: async () => ({ buildId: 'b_leadertest01', generation: serialized.generation, agentDir: '/tmp/ad', workDir: '/tmp/wd', leaderSessionId: 's2', leaderPid: null, resumeCapability: { session: true, artifact: true } } satisfies RuntimeBinding),
        cancelLeader: async () => { order.push('cancel'); return { leaderExit: null, credentialsRevoked: true, residualNote: 'fixture' }; },
        events: () => emptyEvents(),
        nudge: async () => undefined,
        currentRuntimeFreeze: () => ({ piVersion: serialized.spec.piVersion, amagiContentHash: serialized.spec.amagiPackage.contentHash, agentDirConfigHash: serialized.spec.agentDirConfigHash, workflowRevision: serialized.spec.workflowRevision }),
        actorSnapshot: () => ({ acceptedDocumentCount: 0, openBlockingCount: 0, activeAssignments: 0 }),
      }, serialized, { idleGraceMs: 10 });
      const outcome: LeaderRunOutcome = await supervisor.run({ spec: serialized.spec, signal: new AbortController().signal, resumeMode: 'fresh' });
      expect(outcome.kind).toBe('leader-failed');
      expect(order[0]).toBe('revoke');
      expect(supervisor.state.eventCursor['tool-service']).toBe('ts-3');
      expect(supervisor.progress().generation).toBe(serialized.generation);
      // summary 字段来自宿主成果快照回调（真实链路取自 BuildActorStore）
      expect(supervisor.progress().summary.acceptedDocumentCount).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
