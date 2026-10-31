/**
 * D1：人工业务决定服务 + 高风险人审入口（A 案 §4.2/§5.1/§7.4）
 *
 * 覆盖：
 * - 决定：追加 / supersede / expectedRevision 冲突 / 空 rationale 拒绝 /
 *   非法状态转移拒绝 / payloadHash mismatch 标记（登记不阻断）/ scopeKey
 *   绑定校验 / 文件权限（0700 目录 0600 文件）；
 *   diting S-F02：revision = 日志序（追加总数，修改同样递增；两个同
 *   expectedRevision 的更新只接受一个）；
 *   diting S-F03：人审拒绝聚合（最新有效记录裁决；拒绝不可被历史通过/
 *   自报 actor 豁免；subjectHash 变化旧凭据整体失效）；
 *   diting S-F04/S-F05：governable 生命周期列表 + targets 按有效决定链
 *   计算 + stale 重绑（始终携带 supersede ID 时服务接受）；
 * - 人工复核：追加 + reviewSubjectHash 绑定 + 待治理对象联查分组；
 * - snapshotForBuild：整体哈希随追加变化（D5 冻结复核基础）；
 * - validator（治理快照传入时）：approved 无决定 → kb_decision_invalid
 *   blocking；决定 payloadHash 过期 → kb_decision_stale；高风险无人审 →
 *   kb_review_human_missing blocking；有 human 凭据 → 通过；supersedes 边
 *   决定不解析 → blocking；快照缺省保留旧 warning 披露行为；
 * - 路由：desktop 域鉴权（无 token 401）、CLI 主体 403
 *   kb_governance_forbidden、决定提交 round-trip、409 revision 冲突。
 * 全部为确定性纯函数与真实临时文件系统 fixture，无模型调用。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { ConfigManager } from '../src/modules/config-manager.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { kbRoutes } from '../src/routes/kb.js';
import { ToolError } from '../src/agent/agent-tool-service.js';
import {
  KnowledgeGovernanceService,
  type GovernanceSnapshotForBuild,
} from '../src/kb/knowledge-governance-service.js';
import { runKnowledgeGates } from '../src/kb/knowledge-validator.js';
import { compileKnowledgeRelease, type CompilerDocInput, type KnowledgeDeclarationSet } from '../src/kb/knowledge-compiler.js';
import {
  computePayloadHash,
  computeReviewSubjectHash,
  type BodyRange,
  type KnowledgeManifest,
  type KnowledgeObject,
} from '../src/kb/knowledge-schema.js';

let dataRoot: string;
let serviceSeq = 0;

beforeAll(() => {
  dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kbgov-data-')));
});
afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixture：当前 release 知识清单（service 消费的对象表）
// ---------------------------------------------------------------------------

function objectOf(objectId: string, overrides: Partial<KnowledgeObject> = {}, body = `# ${objectId}\n规则正文。`): KnowledgeObject {
  const range: BodyRange = { startLine: 1, endLine: 2 };
  const object: KnowledgeObject = {
    objectId, type: 'rule', title: objectId, aliases: [], domainIds: [],
    familyKey: `fam:${objectId}`, variantKey: 'default', scopeKey: 'combat-global', scopeText: '战斗全局',
    canonical: { docId: `kd_${objectId}`, path: 'rules.md', anchor: objectId, bodyRange: range },
    revision: 1, locationRevision: 0, payloadHash: '', reviewSubjectHash: '',
    businessStatus: 'candidate', reviewStatus: 'passed', reviewActorKind: 'machine', reviewerId: 'kr_1',
    reviewedAt: '2026-11-01T00:00:00Z', claims: [],
    ...overrides,
  };
  object.payloadHash = computePayloadHash(object, body);
  object.reviewSubjectHash = computeReviewSubjectHash({ payloadHash: object.payloadHash, evidence: [], relations: [] });
  return object;
}

let manifestObjects: KnowledgeObject[];

function currentManifest(): KnowledgeManifest {
  return {
    schemaVersion: 1,
    releaseId: 'r_gov1',
    documents: [{ docId: 'kd_objA', path: 'rules.md' }],
    objects: manifestObjects,
    presentations: [],
    relations: [],
    evidence: [],
    coverage: [],
    migrations: [],
  };
}

function makeService(objects?: KnowledgeObject[]): KnowledgeGovernanceService {
  manifestObjects = objects ?? [
    objectOf('ko_objA', { claims: [{ claimKey: 'cap-300', bodyRange: { startLine: 2, endLine: 2 }, riskCategory: 'high', evidenceIds: [] }] }),
    objectOf('ko_objB', { type: 'concept', businessStatus: 'unknown' }),
  ];
  serviceSeq += 1;
  return new KnowledgeGovernanceService({
    // 每个用例独立目录：追加式日志的状态不跨用例泄漏
    outputRoot: path.join(dataRoot, `svc-${serviceSeq}`),
    readCurrentKnowledge: () => currentManifest(),
  });
}

function decisionInput(object: KnowledgeObject, over: Record<string, unknown> = {}) {
  return {
    objectId: object.objectId,
    payloadHash: object.payloadHash,
    scopeKey: object.scopeKey,
    businessStatus: 'approved' as const,
    rationale: '业务确认：该规则经设计负责人核对源文档后批准。',
    expectedRevision: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 决定服务（A 案 §4.2）
// ---------------------------------------------------------------------------

describe('决定：追加 / supersede / 并发 / 语义校验', () => {
  it('追加决定：server 生成 id/时间，0700 目录 0600 文件，revision 推进', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    const { decision, revision } = service.recordDecision(decisionInput(objA, { actor: '主上' }));
    expect(decision.decisionId).toMatch(/^kbd_[0-9a-f-]{36}$/);
    expect(decision.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(decision.actor).toBe('主上');
    expect(decision.businessStatus).toBe('approved');
    expect(revision).toBe(1);
    const dir = path.join(service.outputRoot, '.governance');
    expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe('700');
    expect((fs.statSync(path.join(dir, 'decisions.jsonl')).mode & 0o777).toString(8)).toBe('600');
    const view = service.listDecisions();
    expect(view.records).toHaveLength(1);
    expect(view.effective.map((item) => item.decisionId)).toEqual([decision.decisionId]);
    expect(view.revision).toBe(1);
  });

  it('supersede：新记录取代旧记录，旧记录保留可追溯；revision 为日志序随追加递增（diting S-F02）', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    const first = service.recordDecision(decisionInput(objA));
    const second = service.recordDecision(decisionInput(objA, {
      businessStatus: 'deprecated',
      rationale: '停用决定：该规则已被新机制取代。',
      supersedesDecisionId: first.decision.decisionId,
      expectedRevision: 1,
    }));
    expect(second.decision.supersedesDecisionId).toBe(first.decision.decisionId);
    expect(second.revision).toBe(2);
    const view = service.listDecisions();
    expect(view.records).toHaveLength(2); // 不物理删除
    expect(view.effective).toHaveLength(1);
    expect(view.effective[0]!.decisionId).toBe(second.decision.decisionId);
    // diting S-F02：修改既有决定同样 append → revision 递增（旧断言「supersede
    // 后 revision 不变」按日志序修正）；GET 与 POST 返回同一真相。
    expect(view.revision).toBe(2);
    expect(service.listDecisions('ko_objA').revision).toBe(2); // 过滤视图不缩水全局序号
    expect(service.effectiveDecisions().get('ko_objA')!.businessStatus).toBe('deprecated');
  });

  it('diting S-F02：两个同 expectedRevision 的更新请求只接受一个（409）；更新后 GET revision 递增', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    const objB = manifestObjects[1]!;
    const approvedA = service.recordDecision(decisionInput(objA));
    const approvedB = service.recordDecision(decisionInput(objB, { expectedRevision: 1 }));
    expect(approvedA.revision).toBe(1);
    expect(approvedB.revision).toBe(2);
    // 两窗口均持 revision=2，各自停用已批准对象：第一个被接受，第二个 409
    const first = service.recordDecision(decisionInput(objA, {
      businessStatus: 'deprecated',
      rationale: '窗口 1 停用。',
      supersedesDecisionId: approvedA.decision.decisionId,
      expectedRevision: 2,
    }));
    expect(first.revision).toBe(3);
    expect(() => service.recordDecision(decisionInput(objB, {
      businessStatus: 'deprecated',
      rationale: '窗口 2 停用（基于旧决定集）',
      supersedesDecisionId: approvedB.decision.decisionId,
      expectedRevision: 2,
    }))).toThrowError(expect.objectContaining({ code: 'kb_decision_revision_conflict', status: 409 }) as never);
    // 更新后 GET revision 递增（旧客户端可检出决定集变化）
    expect(service.listDecisions().revision).toBe(3);
    expect(service.listDecisions().records).toHaveLength(3);
    // 追上日志序后同一修改可重提成功
    const retry = service.recordDecision(decisionInput(objB, {
      businessStatus: 'deprecated',
      rationale: '窗口 2 刷新后重提。',
      supersedesDecisionId: approvedB.decision.decisionId,
      expectedRevision: 3,
    }));
    expect(retry.revision).toBe(4);
  });

  it('expectedRevision 冲突 → 409 kb_decision_revision_conflict', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    service.recordDecision(decisionInput(objA));
    const objB = manifestObjects[1]!;
    expect(() => service.recordDecision(decisionInput(objB, { expectedRevision: 0 })))
      .toThrowError(expect.objectContaining({ code: 'kb_decision_revision_conflict', status: 409 }) as never);
  });

  it('空 rationale 拒绝 → kb_decision_invalid（裁定必须有实质理由）', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    expect(() => service.recordDecision(decisionInput(objA, { rationale: '   ' })))
      .toThrowError(expect.objectContaining({ code: 'kb_decision_invalid' }) as never);
  });

  it('非法状态转移拒绝：unknown → deprecated（A 案 §4.3 转移表）', () => {
    const service = makeService();
    const objB = manifestObjects[1]!; // unknown
    expect(() => service.recordDecision(decisionInput(objB, { businessStatus: 'deprecated' })))
      .toThrowError(expect.objectContaining({ code: 'kb_decision_invalid' }) as never);
    // candidate → disputed 也不是人工决定通道
    const objA = manifestObjects[0]!;
    expect(() => service.recordDecision(decisionInput(objA, { businessStatus: 'disputed' })))
      .toThrowError(expect.objectContaining({ code: 'kb_decision_invalid' }) as never);
  });

  it('approved → approved 无 supersede 拒绝；deprecated → approved（恢复使用）需新决定', () => {
    const approved = objectOf('ko_objC', { businessStatus: 'approved' });
    const service = makeService([approved, objectOf('ko_objD', { businessStatus: 'deprecated', type: 'concept' })]);
    expect(() => service.recordDecision(decisionInput(approved)))
      .toThrowError(/修订既有决定须携带 supersedesDecisionId/);
    const restored = service.recordDecision(decisionInput(manifestObjects[1]!, { businessStatus: 'approved', expectedRevision: 0 }));
    expect(restored.decision.businessStatus).toBe('approved');
  });

  it('payloadHash mismatch：登记成功并标记 payloadMismatch（消费端拒绝当轮生效）', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    const { decision } = service.recordDecision(decisionInput(objA, { payloadHash: 'sha256:stale-payload' }));
    expect(decision.payloadMismatch).toBe(true);
  });

  it('scopeKey 绑定不一致拒绝；对象不在当前发布中拒绝；supersede 指向非有效决定拒绝', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    expect(() => service.recordDecision(decisionInput(objA, { scopeKey: 'other-scope' })))
      .toThrowError(/scopeKey 与当前对象不一致/);
    expect(() => service.recordDecision(decisionInput({ ...objA, objectId: 'ko_missing' } as KnowledgeObject)))
      .toThrowError(/不在当前发布中/);
    expect(() => service.recordDecision(decisionInput(objA, { supersedesDecisionId: 'kbd_none' })))
      .toThrowError(/必须指向该对象当前有效决定/);
  });
});

// ---------------------------------------------------------------------------
// 人工复核 + 快照 + 待治理联查（A 案 §5.1/§4.2）
// ---------------------------------------------------------------------------

describe('人工复核 / 快照 / 待治理联查', () => {
  it('recordHumanReview 追加并绑定 reviewSubjectHash；不校验真实人员身份（披露契约）', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    const review = service.recordHumanReview({ objectId: 'ko_objA', reviewSubjectHash: objA.reviewSubjectHash, passed: true, reviewerId: '主上' });
    expect(review.reviewId).toMatch(/^kbr_[0-9a-f-]{36}$/);
    expect(service.humanReviews('ko_objA')).toHaveLength(1);
    expect((fs.statSync(path.join(service.outputRoot, '.governance', 'human-reviews.jsonl')).mode & 0o777).toString(8)).toBe('600');
    expect(() => service.recordHumanReview({ objectId: 'ko_objA', reviewSubjectHash: '', passed: true })).toThrow(ToolError);
  });

  it('snapshotForBuild：整体哈希随任何追加变化；effectiveDecisions 只含有效决定', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    const before = service.snapshotForBuild();
    expect(before.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(before.effectiveDecisions).toHaveLength(0);
    service.recordDecision(decisionInput(objA));
    const after = service.snapshotForBuild();
    expect(after.snapshotHash).not.toBe(before.snapshotHash);
    expect(after.effectiveDecisions).toHaveLength(1);
    expect(after.revision).toBe(1);
  });

  it('pendingGovernanceWork：高风险无人审 / candidate / 决定过期分组', () => {
    const stale = objectOf('ko_objStale', { businessStatus: 'candidate', claims: [{ claimKey: 'cap-x', bodyRange: { startLine: 2, endLine: 2 }, riskCategory: 'high', evidenceIds: [] }] });
    const service = makeService([...manifestObjects, stale]);
    // objStale 的旧决定绑定别的载荷 → payloadMismatch 分组
    service.recordDecision(decisionInput(stale, { payloadHash: 'sha256:old' }));
    const view = service.pendingGovernanceWork();
    expect(view.releaseId).toBe('r_gov1');
    expect(view.highRisk.map((item) => item.objectId).sort()).toEqual(['ko_objA', 'ko_objStale']);
    expect(view.candidates.map((item) => item.objectId)).toContain('ko_objA');
    expect(view.staleDecisions.map((item) => item.objectId)).toEqual(['ko_objStale']);
    expect(view.candidates.find((item) => item.objectId === 'ko_objA')!.allowedDecisionTargets).toEqual(['approved']);
    // 人工复核后移出 highRisk 分组
    service.recordHumanReview({ objectId: 'ko_objA', reviewSubjectHash: manifestObjects[0]!.reviewSubjectHash, passed: true });
    const reviewed = service.pendingGovernanceWork();
    expect(reviewed.highRisk.map((item) => item.objectId)).toEqual(['ko_objStale']);
  });
});

// ---------------------------------------------------------------------------
// diting S-F03/S-F04/S-F05：人审拒绝聚合 / governable 生命周期 / stale 重绑
// ---------------------------------------------------------------------------

describe('diting S-F03：人审拒绝聚合（最新有效记录裁决）', () => {
  it('通过→拒绝：最新拒绝阻断（kb_review_human_rejected）；拒绝→重新通过：放行', () => {
    const draft = govDraft();
    const subject = draft.objects[0]!.reviewSubjectHash;
    const review = (passed: boolean, seq: number) => ({
      reviewId: `kbr_${seq}`, createdAt: `2026-11-01T00:00:0${seq}Z`, actor: '主上',
      objectId: 'ko_objA', reviewSubjectHash: subject, passed,
    });
    // 通过→拒绝 → 阻断（历史通过不覆盖最新拒绝；reviewActorKind 亦不豁免）
    const rejected = govGates(draft, govSnapshot([], [review(true, 1), review(false, 2)]));
    expect(rejected.blocking.some((item) => item.code === 'kb_review_human_rejected' && item.objectId === 'ko_objA')).toBe(true);
    expect(rejected.blocking.some((item) => item.code === 'kb_review_human_missing')).toBe(false);
    // 拒绝→重新通过 → 放行
    const passedAgain = govGates(draft, govSnapshot([], [review(true, 1), review(false, 2), review(true, 3)]));
    expect(passedAgain.blocking.some((item) => item.code === 'kb_review_human_rejected')).toBe(false);
    expect(passedAgain.blocking.some((item) => item.code === 'kb_review_human_missing' && item.objectId === 'ko_objA')).toBe(false);
    // 对象自报 reviewActorKind='human' 不能豁免最新拒绝
    const selfClaimed = govDraft((d) => { d.objects[0]!.reviewActorKind = 'human'; });
    const blocked = govGates(selfClaimed, govSnapshot([], [review(false, 2)]));
    expect(blocked.blocking.some((item) => item.code === 'kb_review_human_rejected')).toBe(true);
  });

  it('正文变更（subjectHash 变）→旧凭据整体失效（通过/拒绝均不继承）', () => {
    const draft = govDraft();
    const oldSubject = draft.objects[0]!.reviewSubjectHash;
    const reviews = [{
      reviewId: 'kbr_old', createdAt: '2026-11-01T00:00:00Z', actor: '主上',
      objectId: 'ko_objA', reviewSubjectHash: oldSubject, passed: true,
    }];
    // 新载荷 subject 不同 → 旧通过凭据失效（回到 missing）
    const newSubject = govDraft((d) => { d.objects[0]!.reviewSubjectHash = 'sha256:new-subject'; });
    const gates = govGates(newSubject, govSnapshot([], reviews));
    expect(gates.blocking.some((item) => item.code === 'kb_review_human_missing' && item.objectId === 'ko_objA')).toBe(true);
    // 旧拒绝同样失效：新主体下无拒绝记录，不再阻断 rejected
    const rejectReviews = [{ ...reviews[0], passed: false }];
    const gates2 = govGates(newSubject, govSnapshot([], rejectReviews));
    expect(gates2.blocking.some((item) => item.code === 'kb_review_human_rejected')).toBe(false);
    expect(gates2.blocking.some((item) => item.code === 'kb_review_human_missing' && item.objectId === 'ko_objA')).toBe(true);
  });

  it('pendingGovernanceWork 共用同一聚合：最新拒绝的对象不再标 humanReviewed（重新进入待复核）', () => {
    const service = makeService();
    const objA = manifestObjects[0]!;
    service.recordHumanReview({ objectId: 'ko_objA', reviewSubjectHash: objA.reviewSubjectHash, passed: true });
    expect(service.pendingGovernanceWork().highRisk.map((item) => item.objectId)).toEqual([]);
    service.recordHumanReview({ objectId: 'ko_objA', reviewSubjectHash: objA.reviewSubjectHash, passed: false });
    const view = service.pendingGovernanceWork();
    expect(view.highRisk.map((item) => item.objectId)).toEqual(['ko_objA']);
    expect(view.governable.find((item) => item.objectId === 'ko_objA')!.humanReviewed).toBe(false);
  });
});

describe('diting S-F04/S-F05：governable 生命周期入口与 stale 重绑一致性', () => {
  it('governable：当前 release 全部活跃对象可操作；targets 按有效决定链状态计算（与 recordDecision 同源）', () => {
    const unknown = objectOf('ko_objU', { type: 'concept', businessStatus: 'unknown' });
    const approved = objectOf('ko_objV', { type: 'concept', businessStatus: 'approved' });
    const deprecated = objectOf('ko_objW', { type: 'concept', businessStatus: 'deprecated' });
    const service = makeService([unknown, approved, deprecated]);
    const view = service.pendingGovernanceWork();
    // 无决定时回退 release 状态：unknown→approved；approved→deprecated/approved；deprecated→approved
    expect(view.governable.map((item) => item.objectId)).toEqual(['ko_objU', 'ko_objV', 'ko_objW']);
    expect(view.governable[0]!.allowedDecisionTargets).toEqual(['approved']);
    expect(view.governable[1]!.allowedDecisionTargets).toEqual(['deprecated', 'approved']);
    expect(view.governable[2]!.allowedDecisionTargets).toEqual(['approved']);
    // 有效决定链优先：unknown 对象带 approved 决定后 targets 变为 approved→deprecated/approved
    service.recordDecision(decisionInput(unknown, { expectedRevision: 0 }));
    const chained = service.pendingGovernanceWork();
    expect(chained.governable.find((item) => item.objectId === 'ko_objU')!.allowedDecisionTargets).toEqual(['deprecated', 'approved']);
  });

  it('stale 重绑：面板始终携带旧决定 ID 时服务接受（E2 STALE_UI_SUBMIT 反转）；两端 targets 一致', () => {
    const object = objectOf('ko_objNew', { type: 'rule', businessStatus: 'unknown' });
    const service = makeService([object]);
    // 旧载荷上的 approved 决定（新载荷发布为 unknown；旧决定不会自动生效）
    const old = service.recordDecision(decisionInput(object, { payloadHash: 'sha256:old-payload' }));
    const view = service.pendingGovernanceWork();
    const entry = view.governable.find((item) => item.objectId === 'ko_objNew')!;
    expect(view.staleDecisions.map((item) => item.objectId)).toEqual(['ko_objNew']);
    // diting S-F05：allowedDecisionTargets 按有效决定链（approved）而非 release
    // 状态（unknown）计算——与 recordDecision 的 currentStatus 同源
    expect(entry.allowedDecisionTargets).toEqual(['deprecated', 'approved']);
    // 面板按有效链提交：携带 supersedesDecisionId + 新载荷 → 服务接受（重绑）
    const rebound = service.recordDecision({
      objectId: object.objectId,
      payloadHash: object.payloadHash,
      scopeKey: object.scopeKey,
      businessStatus: 'approved',
      rationale: '新载荷上重新批准。',
      supersedesDecisionId: old.decision.decisionId,
      expectedRevision: 1, // 日志序：已追加 1 条旧决定
    });
    expect(rebound.decision.payloadMismatch).toBeUndefined();
    expect(service.effectiveDecisions().get('ko_objNew')!.payloadHash).toBe(object.payloadHash);
    // 重绑后不再 stale
    expect(service.pendingGovernanceWork().staleDecisions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validator：治理快照门禁（A 案 §4.2/§5.1/§6.1）
// ---------------------------------------------------------------------------

const GOV_HEADER = '<!--\nfeishu_sync_kb:\n  doc_id: kd_rules\n  sources:\n    - tokSrc\n  build_id: b_gov\n-->\n';
const RULES_BODY = ['# 规则文档', '## 拼点上限', '普攻伤害上限 300%。', '概念说明正文。'].join('\n');

function govDraft(mutate?: (draft: KnowledgeDeclarationSet) => void): KnowledgeDeclarationSet {
  const objects = [
    objectOf('ko_objA', {
      canonical: { docId: 'kd_rules', path: 'rules.md', anchor: 'ko_objA', bodyRange: { startLine: 2, endLine: 3 } },
      claims: [{ claimKey: 'cap-300', bodyRange: { startLine: 3, endLine: 3 }, riskCategory: 'high', evidenceIds: [] }],
    }, RULES_BODY),
    objectOf('ko_objB', {
      type: 'concept',
      canonical: { docId: 'kd_rules', path: 'rules.md', anchor: 'ko_objB', bodyRange: { startLine: 4, endLine: 4 } },
      businessStatus: 'candidate',
    }, RULES_BODY),
  ];
  const draft: KnowledgeDeclarationSet = {
    schemaVersion: 1,
    buildId: 'b_gov',
    docs: { 'rules.md': { docId: 'kd_rules', revision: 1 } },
    objects,
    presentations: [],
    relations: [],
    evidence: [],
    coverage: [],
  };
  mutate?.(draft);
  return draft;
}

function govGates(draft: KnowledgeDeclarationSet, governance?: GovernanceSnapshotForBuild) {
  const docs: CompilerDocInput[] = [{ path: 'rules.md', content: `${GOV_HEADER}${RULES_BODY}\n` }];
  const compiled = compileKnowledgeRelease({ docs, knowledgeDraft: draft, releaseId: 'r_govt', evidenceResources: [] });
  return runKnowledgeGates({
    compiled,
    candidate: null, // 审查凭据缺失与本组断言无关（kb_review_credential_missing 恒在）
    reviews: [],
    snapshot: { entries: [], get: () => undefined, readVerified: () => { throw new Error('unused'); }, size: 0 } as never,
    knowledgeBaseRoot: dataRoot,
    ...(governance ? { governance } : {}),
  });
}

function govSnapshot(decisions: GovernanceSnapshotForBuild['effectiveDecisions'], reviews: GovernanceSnapshotForBuild['humanReviews'] = []): GovernanceSnapshotForBuild {
  const records = decisions.slice();
  return {
    takenAt: '2026-11-01T00:00:00Z',
    revision: decisions.length,
    snapshotHash: 'fixed',
    decisionRecords: records,
    effectiveDecisions: decisions,
    humanReviews: reviews,
  };
}

describe('validator：决定门禁（治理快照传入时）', () => {
  it('approved 对象无有效决定 → kb_decision_invalid blocking（防模型/旧决定冒充）', () => {
    const draft = govDraft((d) => { d.objects[0]!.businessStatus = 'approved'; });
    const gates = govGates(draft, govSnapshot([]));
    const hit = gates.blocking.find((item) => item.code === 'kb_decision_invalid' && item.objectId === 'ko_objA');
    expect(hit?.message).toContain('无绑定当前载荷的有效人工决定');
  });

  it('决定绑定 payloadHash 过期 → kb_decision_stale blocking', () => {
    const draft = govDraft((d) => { d.objects[0]!.businessStatus = 'approved'; });
    const staleDecision = {
      decisionId: 'kbd_stale', createdAt: '2026-11-01T00:00:00Z', actor: '主上',
      objectId: 'ko_objA', payloadHash: 'sha256:old-payload', scopeKey: 'combat-global',
      businessStatus: 'approved' as const, rationale: '旧载荷上的批准',
    };
    const gates = govGates(draft, govSnapshot([staleDecision]));
    expect(gates.blocking.some((item) => item.code === 'kb_decision_stale' && item.objectId === 'ko_objA')).toBe(true);
    // 绑定当前载荷 + 范围一致 → 该门禁通过
    const freshDecision = { ...staleDecision, decisionId: 'kbd_fresh', payloadHash: draft.objects[0]!.payloadHash };
    const ok = govGates(draft, govSnapshot([freshDecision]));
    expect(ok.blocking.some((item) => (item.code === 'kb_decision_invalid' || item.code === 'kb_decision_stale') && item.objectId === 'ko_objA')).toBe(false);
  });

  it('决定 scopeKey/状态与对象不一致 → kb_decision_invalid blocking', () => {
    const draft = govDraft((d) => { d.objects[0]!.businessStatus = 'approved'; });
    const mismatch = {
      decisionId: 'kbd_scope', createdAt: '2026-11-01T00:00:00Z', actor: '主上',
      objectId: 'ko_objA', payloadHash: draft.objects[0]!.payloadHash, scopeKey: 'other-scope',
      businessStatus: 'approved' as const, rationale: '范围不一致的决定',
    };
    const gates = govGates(draft, govSnapshot([mismatch]));
    expect(gates.blocking.some((item) => item.code === 'kb_decision_invalid' && item.objectId === 'ko_objA')).toBe(true);
  });

  it('高风险 claim 无人工复核 → kb_review_human_missing blocking；有绑定当前载荷的 human 凭据 → 通过', () => {
    const draft = govDraft();
    const object = draft.objects[0]!;
    const blocked = govGates(draft, govSnapshot([]));
    const hit = blocked.blocking.find((item) => item.code === 'kb_review_human_missing' && item.objectId === 'ko_objA');
    expect(hit?.message).toContain('人工内容复核');
    // passed 且绑定当前 reviewSubjectHash → 通过
    const pass = govGates(draft, govSnapshot([], [{
      reviewId: 'kbr_1', createdAt: '2026-11-01T00:00:00Z', actor: '主上',
      objectId: 'ko_objA', reviewSubjectHash: object.reviewSubjectHash, passed: true,
    }]));
    expect(pass.blocking.some((item) => item.code === 'kb_review_human_missing')).toBe(false);
    // 绑定旧载荷的复核不可继承（A 案 §4.1）
    const staleReview = govGates(draft, govSnapshot([], [{
      reviewId: 'kbr_2', createdAt: '2026-11-01T00:00:00Z', actor: '主上',
      objectId: 'ko_objA', reviewSubjectHash: 'sha256:old-subject', passed: true,
    }]));
    expect(staleReview.blocking.some((item) => item.code === 'kb_review_human_missing')).toBe(true);
    // diting S-F06：对象自持服务端回写 human 凭据（无匹配运行期记录）→ 通过
    const carried = govDraft((d) => { d.objects[0]!.reviewActorKind = 'human'; });
    const carriedGates = govGates(carried, govSnapshot([]));
    expect(carriedGates.blocking.some((item) => item.code === 'kb_review_human_missing')).toBe(false);
  });

  it('supersedes 边 decisionRef 不解析 / 非有效决定 → kb_decision_invalid blocking；解析到有效决定 → 通过', () => {
    const decision = {
      decisionId: 'kbd_ok', createdAt: '2026-11-01T00:00:00Z', actor: '主上',
      objectId: 'ko_objA', payloadHash: '', scopeKey: 'combat-global',
      businessStatus: 'approved' as const, rationale: '取代关系业务决定',
    };
    const draftOf = (decisionRef: string): KnowledgeDeclarationSet => govDraft((d) => {
      d.objects[0]!.businessStatus = 'approved';
      decision.payloadHash = d.objects[0]!.payloadHash;
      d.relations.push({
        edgeId: 'ke_sup', fromObjectId: 'ko_objA', toObjectId: 'ko_objB',
        type: 'supersedes', scopeKey: 'combat-global', evidenceIds: [], decisionRef,
      });
    });
    const unresolved = govGates(draftOf('kbd_ghost'), govSnapshot([]));
    expect(unresolved.blocking.some((item) => item.code === 'kb_decision_invalid' && item.edgeId === 'ke_sup')).toBe(true);
    // 有效决定属于取代方对象（ko_objA）→ 边级校验通过
    const ok = govGates(draftOf('kbd_ok'), govSnapshot([decision]));
    expect(ok.blocking.some((item) => item.code === 'kb_decision_invalid' && item.edgeId === 'ke_sup')).toBe(false);
    // 决定属于其他对象 → 边引用决定不属于取代方
    const foreign = { ...decision, objectId: 'ko_objB' };
    const bad = govGates(draftOf('kbd_ok'), govSnapshot([foreign]));
    expect(bad.blocking.some((item) => item.code === 'kb_decision_invalid' && item.edgeId === 'ke_sup')).toBe(true);
  });

  it('快照缺省（未传）保留旧披露行为：kb_review_human_missing 为 warning', () => {
    const draft = govDraft();
    const gates = govGates(draft);
    expect(gates.warnings.some((item) => item.code === 'kb_review_human_missing' && item.objectId === 'ko_objA')).toBe(true);
    expect(gates.blocking.some((item) => item.code === 'kb_review_human_missing')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 路由：desktop 域鉴权 + round-trip（A 案 §4.2 写入口纪律）
// ---------------------------------------------------------------------------

describe('路由：/api/kb/governance/*', () => {
  let app: Hono;
  let configManager: ConfigManager;
  let routeOutputRoot: string;

  beforeAll(async () => {
    routeOutputRoot = path.join(dataRoot, 'route-out');
    configManager = new ConfigManager(path.join(dataRoot, 'route-config.json'));
    const config = await configManager.load();
    config.standardKb.outputRoot = routeOutputRoot;
    await configManager.save(config);
    // 真实 CURRENT → knowledge.json fixture（服务缺省读取路径；独立于上面
    // service 用例的目录，路由用例内顺序推进状态）
    const releaseDir = path.join(routeOutputRoot, 'releases', 'r_gov1');
    fs.mkdirSync(releaseDir, { recursive: true });
    manifestObjects = [
      objectOf('ko_objA', { claims: [{ claimKey: 'cap-300', bodyRange: { startLine: 2, endLine: 2 }, riskCategory: 'high', evidenceIds: [] }] }),
      objectOf('ko_objB', { type: 'concept', businessStatus: 'unknown' }),
    ];
    fs.writeFileSync(path.join(routeOutputRoot, 'CURRENT.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'r_gov1', publishedAt: '2026-11-01T00:00:00Z' }));
    fs.writeFileSync(path.join(releaseDir, 'knowledge.json'), JSON.stringify(currentManifest()));
    app = new Hono();
    app.use('*', async (c, next) => {
      (c as any).configManager = configManager;
      (c as any).desktopToken = 'gov-desktop-secret';
      await next();
    });
    app.use('*', authMiddleware());
    app.route('/', kbRoutes({
      buildService: { activeBuild: () => null } as never,
      configManager,
      localMapStore: {} as never,
      documentsProvider: () => [],
      sheetCsvPaths: () => [],
    }));
  });

  const request = (route: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) =>
    app.request(`http://127.0.0.1${route}`, {
      method: init?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': 'gov-desktop-secret', ...(init?.headers ?? {}) },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  it('无 desktop token → 401（desktop auth 域把守）', async () => {
    const res = await app.request('http://127.0.0.1/api/kb/governance/decisions');
    expect(res.status).toBe(401);
    const wrong = await app.request('http://127.0.0.1/api/kb/governance/decisions', { headers: { 'X-Desktop-Token': 'wrong' } });
    expect(wrong.status).toBe(401);
  });

  it('CLI 主体（actor 标记头 / CLI 令牌）→ 403 kb_governance_forbidden（写入口纪律）', async () => {
    for (const headers of [{ 'X-Feishu-Sync-Actor': 'cli' }, { 'X-Cli-Token': 'cli-secret' }]) {
      const res = await request('/api/kb/governance/decisions', { method: 'POST', body: {}, headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'kb_governance_forbidden' });
    }
    // 读端点不拦截（桌面鉴权域仍生效）
    const read = await request('/api/kb/governance/decisions', { headers: { 'X-Feishu-Sync-Actor': 'cli' } });
    expect(read.status).toBe(200);
  });

  it('决定提交 round-trip：POST 登记 → GET 历史 + effective + revision；supersede 链可见', async () => {
    const objA = manifestObjects[0]!;
    const posted = await request('/api/kb/governance/decisions', {
      method: 'POST',
      body: {
        objectId: 'ko_objA', payloadHash: objA.payloadHash, scopeKey: objA.scopeKey,
        businessStatus: 'approved', rationale: '路由 round-trip：批准。', expectedRevision: 0, actor: '主上',
      },
    });
    expect(posted.status).toBe(200);
    const { decision, revision } = await posted.json() as { decision: { decisionId: string }; revision: number };
    expect(decision.decisionId).toMatch(/^kbd_/);
    expect(revision).toBe(1);
    const list = await request('/api/kb/governance/decisions?objectId=ko_objA');
    const view = await list.json() as { records: unknown[]; effective: unknown[]; revision: number };
    expect(view.records).toHaveLength(1);
    expect(view.effective).toHaveLength(1);
    expect(view.revision).toBe(1);
    // supersede：停用决定
    const deprecated = await request('/api/kb/governance/decisions', {
      method: 'POST',
      body: {
        objectId: 'ko_objA', payloadHash: objA.payloadHash, scopeKey: objA.scopeKey,
        businessStatus: 'deprecated', rationale: '停用。', supersedesDecisionId: decision.decisionId, expectedRevision: 1,
      },
    });
    expect(deprecated.status).toBe(200);
    const after = await (await request('/api/kb/governance/decisions?objectId=ko_objA')).json() as { records: unknown[]; effective: Array<{ businessStatus: string }> };
    expect(after.records).toHaveLength(2);
    expect(after.effective[0]!.businessStatus).toBe('deprecated');
  });

  it('expectedRevision 过期 → 409 kb_decision_revision_conflict；非法转移 → 400', async () => {
    const conflict = await request('/api/kb/governance/decisions', {
      method: 'POST',
      body: {
        objectId: 'ko_objB', payloadHash: manifestObjects[1]!.payloadHash, scopeKey: manifestObjects[1]!.scopeKey,
        businessStatus: 'approved', rationale: '并发冲突。', expectedRevision: 0,
      },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'kb_decision_revision_conflict' });
    const invalid = await request('/api/kb/governance/decisions', {
      method: 'POST',
      body: {
        objectId: 'ko_objB', payloadHash: manifestObjects[1]!.payloadHash, scopeKey: manifestObjects[1]!.scopeKey,
        businessStatus: 'deprecated', rationale: 'unknown 不能直接停用。', expectedRevision: 2, // diting S-F02：日志序 = 前两等决定记录数
      },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'kb_decision_invalid' });
  });

  it('人工复核 round-trip + pending 联查', async () => {
    const objB = manifestObjects[1]!;
    const review = await request('/api/kb/governance/human-reviews', {
      method: 'POST',
      body: { objectId: 'ko_objB', reviewSubjectHash: objB.reviewSubjectHash, passed: true, reviewerId: '主上' },
    });
    expect(review.status).toBe(200);
    expect(((await review.json()) as { review: { reviewId: string } }).review.reviewId).toMatch(/^kbr_/);
    const list = await (await request('/api/kb/governance/human-reviews?objectId=ko_objB')).json() as { reviews: unknown[] };
    expect(list.reviews).toHaveLength(1);
    const pending = await (await request('/api/kb/governance/pending')).json() as {
      releaseId: string; highRisk: Array<{ objectId: string }>; candidates: Array<{ objectId: string }>;
      transitionTable: Record<string, string[]>;
    };
    expect(pending.releaseId).toBe('r_gov1');
    expect(pending.highRisk.map((item) => item.objectId)).toContain('ko_objA');
    expect(pending.transitionTable.unknown).toEqual(['approved']);
  });
});
