/**
 * build-actors.test.ts — v2 成果权限账本（设计 v2 §4/§8）
 *
 * 覆盖：身份（pending→confirmed/续接继承/撤销/角色表）、代次轮换、
 * 输出分配（冲突/幂等/收回/续接转移）、幂等回执（同键同载荷重放、
 * 异载荷拒绝）、审查独立性（续接链）与失效、事件去重、检查点导出/恢复、
 * 发布窗口。模式：临时目录（候选目录 JSON 持久化），不依赖 SQLite。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BuildActorError,
  BuildActorStore,
  deriveIdempotencyKey,
  resolveV2RoleToolset,
  V2_CHILD_ALL_TOOLS,
} from '../src/kb/build-actors.js';

let staging: string;

beforeAll(() => {
  staging = fs.mkdtempSync(path.join(os.tmpdir(), 'build-actors-'));
  fs.mkdirSync(path.join(staging, 'docs'), { recursive: true });
});
afterAll(() => {
  fs.rmSync(staging, { recursive: true, force: true });
});

const expectActorError = (fn: () => unknown, code: string) => {
  try {
    fn();
    throw new Error(`期望抛出 BuildActorError(${code})，但未抛出`);
  } catch (error) {
    expect(error).toBeInstanceOf(BuildActorError);
    expect((error as BuildActorError).code).toBe(code);
  }
};

function freshStore(generation = 1): BuildActorStore {
  return new BuildActorStore({ buildId: `b_${Math.random().toString(36).slice(2, 8)}`, stagingRoot: staging, generation });
}

describe('身份链（§4.1）', () => {
  it('桥接先到 → pending；创建事件到达 → confirmed；角色表外拒绝', () => {
    const store = freshStore();
    const pending = store.ensurePendingIdentity('task-1', 'luban');
    expect(pending.status).toBe('pending');
    const confirmed = store.registerTaskCreation({ nativeTaskId: 'task-1', requestedRole: 'luban', agent: 'luban' });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.role).toBe('luban');
    expectActorError(() => store.registerTaskCreation({ nativeTaskId: 'task-x', requestedRole: 'writer' }), 'actor_role_unknown');
  });

  it('角色与创建事件不一致 → requireConfirmedActor 拒绝', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'task-1', requestedRole: 'luban' });
    expect(() => store.requireConfirmedActor('task-1', 'diting')).toThrow(BuildActorError);
    expect(() => store.requireConfirmedActor('task-1', 'luban')).not.toThrow();
  });

  it('续接继承分配并撤销父任务资格（§4.2）', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const assignment = store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w1' });
    const resumed = store.registerTaskCreation({ nativeTaskId: 'w2', parentTaskId: 'w1', requestedRole: 'luban' });
    expect(resumed.parentTaskId).toBe('w1');
    // 父任务撤销；新任务持有分配；旧分配 superseded
    expect(store.lookupActor('w1')!.status).toBe('revoked');
    expect(store.activeAssignmentFor('docs/a.md')!.ownerTaskId).toBe('w2');
    expect(store.listAssignments().find((item) => item.assignmentId === assignment.assignmentId)!.status).toBe('superseded');
    // w1 旧任务写入被拒
    expectActorError(() => store.requireConfirmedActor('w1'), 'actor_revoked');
    // 续接链：w2 的祖先含 w1
    expect(store.ancestryOf('w2').has('w1')).toBe(true);
  });

  it('父任务未登记 → 拒绝（创建事件必须先有父）', () => {
    const store = freshStore();
    expectActorError(
      () => store.registerTaskCreation({ nativeTaskId: 'w9', parentTaskId: 'ghost', requestedRole: 'luban' }),
      'amagi_parent_unknown',
    );
  });

  it('revokeActor 撤销身份并连带撤销分配', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w1' });
    store.revokeActor('w1', 'cancelled');
    expect(store.lookupActor('w1')!.status).toBe('revoked');
    expect(store.activeAssignmentFor('docs/a.md')).toBeNull();
  });
});

describe('代次（§4.1/§9）', () => {
  it('rotateGeneration 撤销旧代次全部身份与分配；旧代次凭据失效', () => {
    const store = freshStore(1);
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w1' });
    store.rotateGeneration(2, 'leader_crash');
    expect(store.activeGeneration).toBe(2);
    expect(store.lookupActor('w1')!.status).toBe('revoked');
    expect(store.activeAssignmentFor('docs/a.md')).toBeNull();
    expect(() => store.assertGeneration(1)).toThrow(BuildActorError);
    expect(() => store.rotateGeneration(2, 'again')).toThrow(BuildActorError);
  });
});

describe('输出分配（§4.2）', () => {
  it('同一目标同时只有一个有效分配；冲突返回持有者（409）', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.registerTaskCreation({ nativeTaskId: 'w2', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w1' });
    expectActorError(() => store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w2' }), 'kb_output_assignment_conflict');
    // 同 owner 幂等更新（不报冲突）
    expect(store.assignOutputs({ targets: ['docs/a.md', 'docs/b.md'], ownerTaskId: 'w1' }).targets).toHaveLength(2);
  });

  it('未分配写入 → 可重试错误；他人持有 → 明确拒绝', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.registerTaskCreation({ nativeTaskId: 'w2', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w1' });
    expectActorError(() => store.assertOutputAssignment('w1', 'docs/other.md'), 'kb_output_not_assigned');
    expectActorError(() => store.assertOutputAssignment('w2', 'docs/a.md'), 'kb_output_owned_by_other_task');
    expect(() => store.assertOutputAssignment('w1', 'docs/a.md')).not.toThrow();
  });

  it('revokeOutputs 按 assignmentId 与 ownerTaskId 收回', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w1' });
    store.assignOutputs({ targets: ['docs/b.md'], ownerTaskId: 'w1' });
    expect(store.revokeOutputs({ ownerTaskId: 'w1' })).toBe(2);
    expect(store.activeAssignmentFor('docs/a.md')).toBeNull();
    expectActorError(() => store.revokeOutputs({ assignmentId: 'asg_missing' }), 'invalid_request');
  });

  it('family 目标按 familyKey 认领（写入侧家族归属）', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['cap-family'], targetKind: 'family', ownerTaskId: 'w1' });
    expect(store.activeAssignmentFor('family:cap-family')!.ownerTaskId).toBe('w1');
  });
});

describe('幂等回执（§4.4）', () => {
  it('同键同载荷返回原回执；同键异载荷拒绝', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const first = store.recordReceipt({
      authorTaskId: 'w1', kind: 'write_doc', operationId: 'op-1', payloadHash: 'h1', paths: ['docs/a.md'],
      result: { content: [{ type: 'text', text: 'ok' }], details: { path: 'docs/a.md' } },
    });
    const key = deriveIdempotencyKey(store.buildId, store.activeGeneration, 'w1', 'op-1');
    const replayed = store.replayReceipt(key, 'h1');
    expect(replayed!.artifactId).toBe(first.artifactId);
    expectActorError(() => store.replayReceipt(key, 'h2'), 'kb_idempotency_conflict');
    // 不同任务同 operationId 不冲突（键含 nativeTaskId）
    store.registerTaskCreation({ nativeTaskId: 'w2', requestedRole: 'luban' });
    expect(store.replayReceipt(deriveIdempotencyKey(store.buildId, store.activeGeneration, 'w2', 'op-1'), 'h1')).toBeNull();
  });

  it('写入回执驱动最近作者账本（审查独立性输入）', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.recordReceipt({ authorTaskId: 'w1', kind: 'write_doc', operationId: 'op-1', payloadHash: 'h1', paths: ['docs/a.md'], result: {} });
    // 无关审查者合法
    store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    expect(() => store.assertReviewerIndependent('r1', ['docs/a.md'])).not.toThrow();
    // 作者自审拒绝
    expectActorError(() => store.assertReviewerIndependent('w1', ['docs/a.md']), 'kb_review_not_independent');
    // 作者续接任务审拒绝（w2 继承 w1，链含作者）
    store.registerTaskCreation({ nativeTaskId: 'w2', parentTaskId: 'w1', requestedRole: 'luban' });
    expectActorError(() => store.assertReviewerIndependent('w2', ['docs/a.md']), 'kb_review_not_independent');
  });
});

describe('审查回执（§4.3）', () => {
  it('recordReview 绑定哈希；invalidateReviewsForPaths 使受影响审查失效', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    const review = store.recordReview({
      reviewerTaskId: 'r1',
      draftHash: 'hash-all',
      dependencyHashes: { 'doc:docs/a.md': 'h-a', 'doc:docs/b.md': 'h-b' },
      ruleVersion: 'kb-review/1',
      issues: [{ issueId: 'i1', severity: 'blocking', draftLocation: 'docs/a.md#L1', sourceLocation: 'S1', description: 'x' }],
      verdict: 'needs_revision',
    });
    expect(review.status).toBe('valid');
    expect(store.invalidateReviewsForPaths(['docs/a.md'], 'content_revised')).toBe(1);
    expect(store.listReviews()[0]!.status).toBe('stale');
    expect(store.listReviews()[0]!.staleReason).toContain('docs/a.md');
    // 未受影响路径不再重复失效
    expect(store.invalidateReviewsForPaths(['docs/c.md'], 'content_revised')).toBe(0);
  });

  it('openBlockingIssues 取最新问题清单', () => {
    const store = freshStore();
    expect(store.openBlockingIssues()).toBe(0);
    store.recordIssueList({ summary: null, issues: [{ issueKey: 'k1', severity: 'blocking', targetPath: 'docs/a.md', draftLocation: null, sourceLocation: null, description: 'd', fromReviewId: null }] });
    store.recordIssueList({ summary: null, issues: [] });
    expect(store.openBlockingIssues()).toBe(0);
  });
});

describe('运行事件与去重（§8）', () => {
  it('source|nativeEventId 去重：重复登记返回原事件', () => {
    const store = freshStore();
    const first = store.appendEvent({ source: 'leader-rpc', nativeEventId: 'evt-1', type: 'actor_confirmed', taskId: 'w1', payload: {} });
    const dup = store.appendEvent({ source: 'leader-rpc', nativeEventId: 'evt-1', type: 'actor_confirmed', taskId: 'w1', payload: {} });
    expect(dup.eventId).toBe(first.eventId);
    expect(store.eventsSince().length).toBe(1);
    // 游标读取
    store.appendEvent({ source: 'tool-service', type: 'artifact_write_doc', payload: {} });
    expect(store.eventsSince(first.eventId).length).toBe(1);
    // 无 nativeEventId 的事件不去重
    store.appendEvent({ source: 'tool-service', type: 'tick', payload: {} });
    store.appendEvent({ source: 'tool-service', type: 'tick', payload: {} });
    expect(store.eventsSince().filter((event) => event.type === 'tick')).toHaveLength(2);
  });
});

describe('发布窗口（§5.4）', () => {
  it('beginPublishWindow 锁定候选；进行中重复申请拒绝；结算后关闭', () => {
    const store = freshStore();
    const request = store.beginPublishWindow('hash-1', null);
    expect(request.status).toBe('pending');
    expect(store.publishing!.draftHash).toBe('hash-1');
    expectActorError(() => store.beginPublishWindow('hash-2', null), 'build_publishing');
    store.settlePublishRequest(request.requestId, 'accepted', { ok: true });
    expect(store.publishing).toBeNull();
    expect(store.exportCheckpointPayload().publishRequests).toHaveLength(1);
    expect(store.exportCheckpointPayload().publishRequests[0]!.status).toBe('accepted');
  });
});

describe('持久化与检查点（§8/任务书）', () => {
  it('persist → 新 store load 恢复全部账本（含幂等回执与审查失效状态）', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w1' });
    store.recordReceipt({ authorTaskId: 'w1', kind: 'write_doc', operationId: 'op-1', payloadHash: 'h1', paths: ['docs/a.md'], result: {} });
    store.recordReview({ reviewerTaskId: 'r1', draftHash: 'dh', dependencyHashes: { 'doc:docs/a.md': 'ha' }, ruleVersion: 'kb-review/1', issues: [], verdict: 'pass' });
    const reloaded = new BuildActorStore({ buildId: store.buildId, stagingRoot: staging });
    reloaded.load();
    expect(reloaded.lookupActor('w1')!.status).toBe('confirmed');
    expect(reloaded.activeAssignmentFor('docs/a.md')!.ownerTaskId).toBe('w1');
    const key = deriveIdempotencyKey(store.buildId, store.activeGeneration, 'w1', 'op-1');
    expect(reloaded.replayReceipt(key, 'h1')!.artifactId).toBeTruthy();
    // 最近作者账本恢复 → 独立性判定仍生效（w1 自审拒绝；r1 合法）
    expectActorError(() => reloaded.assertReviewerIndependent('w1', ['docs/a.md']), 'kb_review_not_independent');
    expect(() => reloaded.assertReviewerIndependent('r1', ['docs/a.md'])).not.toThrow();
    // 事件恢复 + 不重复持久化
    const eventCount = reloaded.eventsSince().length;
    reloaded.persist();
    const reloaded2 = new BuildActorStore({ buildId: store.buildId, stagingRoot: staging });
    reloaded2.load();
    expect(reloaded2.eventsSince().length).toBe(eventCount);
  });

  it('exportCheckpointPayload / restoreCheckpointPayload（集成者接入 BuildCheckpoint）', () => {
    const store = freshStore();
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w1' });
    const payload = store.exportCheckpointPayload();
    expect(payload.schemaVersion).toBe(1);
    expect(payload.assignments).toHaveLength(1);
    const restored = new BuildActorStore({ buildId: store.buildId, stagingRoot: staging, generation: 3 });
    restored.restoreCheckpointPayload(payload);
    expect(restored.activeAssignmentFor('docs/a.md')!.ownerTaskId).toBe('w1');
    expect(restored.activeGeneration).toBeGreaterThanOrEqual(payload.generation);
    // buildId 不匹配拒绝
    expect(() => restored.restoreCheckpointPayload({ ...payload, buildId: 'other' })).toThrow(BuildActorError);
  });
});

describe('角色工具面（§3.5）', () => {
  it('内置三角色：writer/reviewer/research 工具面互异且读取面共享', () => {
    const writer = resolveV2RoleToolset('luban')!;
    const reviewer = resolveV2RoleToolset('diting')!;
    const research = resolveV2RoleToolset('baize')!;
    expect(writer.canWriteDocs).toBe(true);
    expect(writer.tools).toContain('kb_write_doc');
    expect(writer.tools).not.toContain('kb_submit_review');
    expect(reviewer.isReviewer).toBe(true);
    expect(reviewer.tools).toContain('kb_submit_review');
    expect(reviewer.tools).not.toContain('kb_write_doc');
    expect(research.tools).not.toContain('kb_write_doc');
    expect(research.tools).not.toContain('kb_submit_review');
    // 写入链工具归属
    expect(writer.writeTools).toContain('kb_edit_doc');
    expect(reviewer.writeTools).toContain('build_handoff_submit');
    // 子任务共享白名单 = 并集，且不含 Leader 专属工具
    for (const name of V2_CHILD_ALL_TOOLS) {
      expect(['build_manifest', 'build_assign_output', 'build_revoke_output', 'build_issues_submit', 'build_checkpoint', 'build_request_publish']).not.toContain(name);
    }
    expect(V2_CHILD_ALL_TOOLS).toContain('raw_read');
    expect(V2_CHILD_ALL_TOOLS).toContain('kb_write_doc');
    expect(V2_CHILD_ALL_TOOLS).toContain('kb_submit_review');
  });
});
