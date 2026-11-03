/**
 * 审核修复批 F07/F08（review-authority）：
 * - F07：默认（省略 unitId）actor 审查由 v2 权威回执驱动进入生产候选
 *   （assembleCandidateRelease 的 acceptance.validReportIds），不依赖
 *   legacy all.json；多审查者与版本绑定保留。
 * - F08：正式知识声明（objects/claims/evidence/readReceipt）→ 独立当前
 *   审查 pass → 对象级 machine-reviewed 凭据原子回写 → 发布消费同一权威
 *   （canPublish + prepareKnowledgePublish + publishRelease/CURRENT）成功链；
 *   改对象（metadata-only）/证据声明/来源快照/冻结规则后拒绝；非 pass 不
 *   回写；自审父链限制保留。
 *
 * 模式：真实 AgentToolService/BuildActorStore/KbBuildService（临时目录 +
 * fixture 快照，不依赖 SQLite/真实模型）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { canPublish, type ReviewReport } from '../src/kb/orchestration-contracts.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import {
  REVIEW_DEP_DECLARATION,
  REVIEW_DEP_SOURCE_SNAPSHOT,
  REVIEW_DEP_WORKFLOW_RULES,
  collectAuthorityValidatedReports,
  emptyKnowledgeDeclarationHash,
  knowledgeDeclarationHash,
  resolveCurrentReviewDependencies,
} from '../src/kb/review-authority.js';

const RULES_HASH_V1 = 'a'.repeat(64);
const RULES_HASH_V2 = 'b'.repeat(64);

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let toolService: AgentToolService;
let buildService: KbBuildService;

const DOC_PATH = 'combat/actions.md';
const WRITE_ARGS = {
  path: DOC_PATH,
  title: '行动规则',
  markdown: ['## 怒气消耗', '', '标准行动消耗 2 点怒气，自由行动消耗 1 点。', ''].join('\n'),
  sources: ['tokA'],
  summary: '怒气消耗规则',
  operationId: 'op-write-actions-1',
};

interface Fixture {
  state: BuildRunState;
  store: BuildActorStore;
  token: string;
}

function makeFixture(name: string, rulesHash: string | null = RULES_HASH_V1): Fixture {
  const stagingRoot = path.join(dataRoot, 'staging', name);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  const store = new BuildActorStore({ buildId: `b_${name}`, stagingRoot, generation: 1 });
  store.load();
  const state: BuildRunState = {
    knowledgeBaseRoot: kbRoot,
    snapshot: RawSourceSnapshot.fromEntries(
      [{
        objToken: 'tokA', objType: 'docx', title: '源A', relPath: 'src-a.md',
        contentHash: computeSourceHash(path.join(kbRoot, 'src-a.md'), [], kbRoot), objEditTime: null,
      }],
      { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] },
    ),
    mode: 'full',
    workset: new Map([['tokA', 'added']]),
    stagingRoot,
    finishInfo: null,
    units: [],
    writtenPaths: new Set<string>(),
    docMeta: new Map(),
    v2: { actorStore: store, generation: 1 },
    v2WorkflowRulesHash: rulesHash,
  };
  const { token } = toolService.createRunContext({
    runKind: 'build',
    buildId: `b_${name}`,
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    allowedToolsOverride: [...V2_CHILD_ALL_TOOLS],
    buildState: state,
    orchestration: { mode: 'pi-amagi', buildId: `b_${name}`, generation: 1, credential: 'child', actorStore: store },
  });
  return { state, store, token };
}

/** writer 写入带 objects/claims/evidence（真实 readReceipt）的正式知识声明。 */
async function writeDeclaredDoc(fixture: Fixture, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { token } = fixture;
  fixture.store.registerTaskCreation({ nativeTaskId: 'task-w1', requestedRole: 'luban' });
  fixture.store.assignOutputs({ ownerTaskId: 'task-w1', targets: [DOC_PATH] });
  const read = await toolService.executeTool(token, 'raw_read', { objToken: 'tokA' }, { toolCallId: `read-${Math.random().toString(36).slice(2, 8)}`, amagiTaskId: 'task-w1', amagiAgent: 'luban' });
  const receiptId = (read.details as Record<string, unknown>).readReceiptId as string;
  const result = await toolService.executeTool(token, 'kb_write_doc', {
    ...WRITE_ARGS,
    objects: [{
      clientKey: 'actRage', type: 'rule', title: '怒气消耗', familyKey: 'combat', variantKey: 'default',
      scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['怒气消耗'],
      claims: [{ claimKey: 'rage-cost', riskCategory: 'normal' }],
    }],
    evidenceClaims: [{
      clientKey: 'evRage', objectKey: 'actRage', claimKey: 'rage-cost',
      sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
      selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0 },
      role: 'supports', nature: 'direct', readReceiptId: receiptId,
    }],
    ...overrides,
  }, { amagiTaskId: 'task-w1', amagiAgent: 'luban' });
  return result.details as Record<string, unknown>;
}

/** diting 提交审查（默认省略 unitId；conclusion 可覆写）。 */
async function submitReview(fixture: Fixture, conclusion: 'pass' | 'needs_revision' = 'pass', overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { token } = fixture;
  fixture.store.registerTaskCreation({ nativeTaskId: 'task-r1', requestedRole: 'diting' });
  const result = await toolService.executeTool(token, 'kb_submit_review', {
    operationId: `op-review-${Math.random().toString(36).slice(2, 8)}`,
    coverage: { sourceRefs: ['tokA'] },
    checkedDimensions: ['事实与数值'],
    issues: [],
    uncheckedScope: [],
    conclusion,
    ...overrides,
  }, { amagiTaskId: 'task-r1', amagiAgent: 'diting' });
  return result.details as Record<string, unknown>;
}

/** 真实 assembleCandidateRelease + canPublish（v2 权威回执驱动链）。 */
function candidateGate(fixture: Fixture): {
  validReportIds: string[];
  gate: ReturnType<typeof canPublish>;
} {
  const candidateFile = (buildService as unknown as { assembleCandidateRelease: (input: unknown) => { candidate: { acceptance: { validReportIds: string[] } }; candidateHash: string } })
    .assembleCandidateRelease({
      buildId: 'b_x', entry: {}, buildState: fixture.state, snapshot: fixture.state.snapshot,
      stagingRoot: fixture.state.stagingRoot,
      programChecks: { passed: true, checkIds: ['fixture'] },
      summary: 's',
      specInfo: { publishMode: 'auto', sourceSnapshotHash: resolveCurrentReviewDependencies({ stagingRoot: fixture.state.stagingRoot, snapshot: fixture.state.snapshot, workflowRulesHash: fixture.state.v2WorkflowRulesHash ?? null }).sourceSnapshotHash, baseReleaseId: null },
    });
  const reports = (KbBuildService as unknown as { collectReviewReports: (root: string) => ReviewReport[] }).collectReviewReports(fixture.state.stagingRoot);
  const gate = canPublish({
    candidate: candidateFile.candidate as never,
    reports,
    requiredReviewDraftHashes: [candidateFile.candidateHash],
    expectedSourceSnapshotHash: (candidateFile.candidate as unknown as { sourceSnapshotHash: string }).sourceSnapshotHash,
    expectedBaseReleaseId: null,
  });
  return { validReportIds: candidateFile.candidate.acceptance.validReportIds, gate };
}

function readDraftObjects(fixture: Fixture): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(fixture.state.stagingRoot, 'knowledge-draft.json'), 'utf8')).objects;
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revauth-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revauth-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revauth-out-'));
  fs.writeFileSync(path.join(kbRoot, 'src-a.md'), '怒气规则表\n标准行动消耗 2 怒气\n自由行动消耗 1 怒气\n', 'utf-8');
  toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  buildService = new KbBuildService({
    dataRoot, configProvider: () => ({ standardKb: { outputRoot }, knowledgeBaseRoot: kbRoot }) as never,
  } as never);
});

afterAll(() => {
  for (const dir of [dataRoot, kbRoot, outputRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('F07/F08：真实 objects/claims/readReceipt → 默认审查 → 发布成功链', () => {
  it('增量候选只要求本轮工作集来源的去向，不要求旧权限占位源', async () => {
    const fixture = makeFixture('candidate-workset-disposition');
    await writeDeclaredDoc(fixture);
    fs.writeFileSync(path.join(kbRoot, 'old-denied.md'), '该文档在飞书侧权限受限。API 返回 40403 no permission，请向文档所有者申请权限。');
    fixture.state.snapshot = RawSourceSnapshot.fromEntries([
      ...fixture.state.snapshot.entries,
      { objToken: 'oldDenied', objType: 'docx', title: '旧权限源', relPath: 'old-denied.md',
        contentHash: computeSourceHash(path.join(kbRoot, 'old-denied.md'), [], kbRoot), objEditTime: null },
    ], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] });
    const assembled = (buildService as unknown as { assembleCandidateRelease: (input: unknown) => { candidate: { sourceDisposition: Array<{ sourceId: string; disposition: string }> } } })
      .assembleCandidateRelease({ buildId: 'b_candidate-workset-disposition', entry: {}, buildState: fixture.state,
        snapshot: fixture.state.snapshot, stagingRoot: fixture.state.stagingRoot,
        programChecks: { passed: true, checkIds: ['fixture'] }, summary: 's',
        specInfo: { publishMode: 'auto', sourceSnapshotHash: 'hash', baseReleaseId: null } });
    expect(assembled.candidate.sourceDisposition).toEqual([{ sourceId: 'tokA', disposition: 'referenced' }]);
  });

  it.each([
    ['ctx', 'run_token_revoked'], ['actor', 'actor_revoked'],
    ['generation', 'credential_generation_revoked'], ['publishing', 'build_publishing'],
  ] as const)('%s失效后不允许排队中的审查凭据迟到回写', async (kind, code) => {
    const fixture = makeFixture(`review-cancel-${kind}`);
    await writeDeclaredDoc(fixture);
    const draftFile = path.join(fixture.state.stagingRoot, 'knowledge-draft.json');
    const before = fs.readFileSync(draftFile, 'utf-8');
    let unlock!: () => void;
    fixture.state.knowledgeDeclarationQueue = new Promise<void>((resolve) => { unlock = resolve; });
    const pending = submitReview(fixture);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (kind === 'ctx') toolService.revokeToken(fixture.token);
    else if (kind === 'actor') fixture.store.revokeActor('task-r1', 'cancelled');
    else if (kind === 'generation') fixture.store.rotateGeneration(2, 'resume');
    else fixture.store.beginPublishWindow('a'.repeat(64), null);
    unlock();
    await expect(pending).rejects.toMatchObject({ code });
    expect(fs.readFileSync(draftFile, 'utf-8')).toBe(before);
    expect(JSON.parse(before).objects[0].reviewStatus).toBe('pending');
  });

  it('省略 unitId 的 diting 审查回写对象凭据并驱动生产候选发布（CURRENT 切换成功）', async () => {
    const fixture = makeFixture('ok-chain');
    await writeDeclaredDoc(fixture);
    const reviewDetails = await submitReview(fixture, 'pass');
    // F08：pass 且无 blocking → 对象凭据原子回写（不依赖 unitId=all）
    expect(reviewDetails.credentialMarked).toBe(1);
    const objects = readDraftObjects(fixture);
    expect(objects[0]).toMatchObject({ reviewStatus: 'passed', reviewActorKind: 'machine' });
    expect(String(objects[0].reviewerId)).toMatch(/^kr_/);
    // 回执绑定：报告文件 + 四类依赖哈希
    const receipts = fixture.store.listReviews();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.reportUnitId).toMatch(/^actor_/);
    expect(String(reviewDetails.unitId)).toBe(receipts[0]!.reportUnitId);
    expect(receipts[0]!.reportId).toBe(reviewDetails.reportId);
    expect(receipts[0]!.dependencyHashes[REVIEW_DEP_DECLARATION]).toBeTruthy();
    expect(receipts[0]!.dependencyHashes[REVIEW_DEP_SOURCE_SNAPSHOT]).toBeTruthy();
    expect(receipts[0]!.dependencyHashes[REVIEW_DEP_WORKFLOW_RULES]).toBe(RULES_HASH_V1);
    // F07：默认 actor 报告进生产候选（无 all.json）
    expect(fs.existsSync(path.join(fixture.state.stagingRoot, 'reviews', 'all.json'))).toBe(false);
    const { validReportIds, gate } = candidateGate(fixture);
    expect(validReportIds).toContain(reviewDetails.reportId);
    expect(gate.publishable).toBe(true);
    // 发布消费同一权威：真实 publishRelease（知识编译 + CURRENT rename）
    const manifest = await (buildService as unknown as { publishRelease: (input: unknown) => Promise<{ docs: unknown[] }> }).publishRelease({
      buildId: 'b_ok-chain', releaseId: 'r_revauth_ok', mode: 'full', baseReleaseId: null,
      model: null, snapshot: fixture.state.snapshot, stagingRoot: fixture.state.stagingRoot,
      outputRoot, docMeta: fixture.state.docMeta ?? new Map(), skippedSources: [],
      summary: 'fixture 发布', knowledgeBaseRoot: kbRoot,
    });
    expect(manifest.docs.length).toBeGreaterThan(0);
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId).toBe('r_revauth_ok');
    const knowledge = JSON.parse(fs.readFileSync(path.join(outputRoot, 'releases', 'r_revauth_ok', 'knowledge.json'), 'utf8'));
    expect(knowledge.objects[0].reviewStatus).toBe('passed');
  });
});

describe('F08：依赖漂移拒绝链', () => {
  it('metadata-only 对象声明变化（正文不变）→ 对象回 pending、回执失效、发布拒绝；重审后闭环', async () => {
    const fixture = makeFixture('meta-only');
    await writeDeclaredDoc(fixture);
    const first = await submitReview(fixture, 'pass');
    expect(first.credentialMarked).toBe(1);
    const before = candidateGate(fixture);
    expect(before.gate.publishable).toBe(true);
    // metadata-only：同正文重写，仅对象语义字段变化（scopeKey/scopeText/title）
    const read2 = await toolService.executeTool(fixture.token, 'raw_read', { objToken: 'tokA' }, { toolCallId: 'read-2', amagiTaskId: 'task-w1', amagiAgent: 'luban' });
    const receipt2 = (read2.details as Record<string, unknown>).readReceiptId as string;
    await toolService.executeTool(fixture.token, 'kb_write_doc', {
      ...WRITE_ARGS, operationId: 'op-write-actions-2',
      objects: [{
        clientKey: 'actRage', type: 'rule', title: '怒气消耗（改）', familyKey: 'combat', variantKey: 'default',
        scopeKey: 'pvp', scopeText: 'PVP 战斗（语义已变）', headingPath: ['怒气消耗'],
        claims: [{ claimKey: 'rage-cost', riskCategory: 'normal' }],
      }],
      evidenceClaims: [{
        clientKey: 'evRage', objectKey: 'actRage', claimKey: 'rage-cost',
        sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
        selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0 },
        role: 'supports', nature: 'direct', readReceiptId: receipt2,
      }],
    }, { amagiTaskId: 'task-w1', amagiAgent: 'luban' });
    // 对象回 pending（载荷/语义变化不得继承审查）
    expect(readDraftObjects(fixture)[0]).toMatchObject({ reviewStatus: 'pending' });
    // 旧回执失效（作者修订路径失效 + 声明哈希漂移）
    const receipts = fixture.store.listReviews();
    expect(receipts.some((r) => r.reportId === first.reportId && r.status === 'stale')).toBe(true);
    // 候选拒绝：旧报告不能再覆盖（metadata-only 变化在无新审查时 review_missing）
    const after = candidateGate(fixture);
    expect(after.validReportIds).not.toContain(first.reportId);
    expect(after.gate.publishable).toBe(false);
    expect(after.gate.reasons).toContain('review_missing');
    // 重审后闭环
    const second = await submitReview(fixture, 'pass');
    expect(second.credentialMarked).toBe(1);
    expect(candidateGate(fixture).gate.publishable).toBe(true);
  });

  it('来源快照漂移 → 候选审查依赖失效（review_missing）', async () => {
    const fixture = makeFixture('snap-drift');
    await writeDeclaredDoc(fixture);
    const review = await submitReview(fixture, 'pass');
    expect(review.credentialMarked).toBe(1);
    // 源文件变化 → 快照哈希漂移（模拟构建期间源被改）
    fs.writeFileSync(path.join(kbRoot, 'src-a.md'), '怒气规则表（已改）\n标准行动消耗 3 怒气\n', 'utf-8');
    fixture.state.snapshot = RawSourceSnapshot.fromEntries(
      [{
        objToken: 'tokA', objType: 'docx', title: '源A', relPath: 'src-a.md',
        contentHash: computeSourceHash(path.join(kbRoot, 'src-a.md'), [], kbRoot), objEditTime: null,
      }],
      { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] },
    );
    const after = candidateGate(fixture);
    expect(after.gate.publishable).toBe(false);
    expect(after.gate.reasons).toContain('review_missing');
  });

  it('冻结 workflow 规则哈希变化 → 旧审查不再覆盖候选（review_missing）', async () => {
    const fixture = makeFixture('rules-drift', RULES_HASH_V1);
    await writeDeclaredDoc(fixture);
    const review = await submitReview(fixture, 'pass');
    expect(review.credentialMarked).toBe(1);
    expect(candidateGate(fixture).gate.publishable).toBe(true);
    fixture.state.v2WorkflowRulesHash = RULES_HASH_V2;
    const after = candidateGate(fixture);
    expect(after.gate.publishable).toBe(false);
    expect(after.gate.reasons).toContain('review_missing');
  });

  it('F08 补强：v2 权威规则哈希缺失（null）→ fail-closed：回写拒绝 + 发布核验拒绝', async () => {
    const fixture = makeFixture('rules-missing', null);
    await writeDeclaredDoc(fixture);
    const review = await submitReview(fixture, 'pass');
    // 回执已登记，但规则键缺失 → 不回写对象凭据（缺证明不 mark passed）
    expect(review.credentialDeferred).toBe('workflow_rules_changed_since_review');
    expect(review.credentialMarked).toBeUndefined();
    expect(readDraftObjects(fixture)[0]).toMatchObject({ reviewStatus: 'pending' });
    const receipts = fixture.store.listReviews();
    expect(receipts[0]!.dependencyHashes[REVIEW_DEP_WORKFLOW_RULES]).toBeUndefined();
    // 发布核验同样 fail-closed（不因集成者未提供规则哈希而默许）
    const { validReportIds, gate } = candidateGate(fixture);
    expect(validReportIds).toEqual([]);
    expect(gate.publishable).toBe(false);
    expect(gate.reasons).toContain('review_missing');
  });
});

describe('F07/F08：审查有效性约束', () => {
  it('非 pass 不回写对象凭据（不无条件 mark passed）', async () => {
    const fixture = makeFixture('needs-revision');
    await writeDeclaredDoc(fixture);
    const review = await submitReview(fixture, 'needs_revision');
    expect(review.credentialMarked).toBeUndefined();
    expect(readDraftObjects(fixture)[0]).toMatchObject({ reviewStatus: 'pending' });
    // 审查回执仍登记（问题供 Leader 聚合），但对象门禁拦截发布
    const { gate } = candidateGate(fixture);
    expect(gate.publishable).toBe(true); // 报告有效（draftHash 绑定），但对象 pending 由知识门禁拦截
  });

  it('撰写者身份不能自审（角色工具面拒绝；审查角色校验兑底）', async () => {
    const fixture = makeFixture('self-review');
    await writeDeclaredDoc(fixture);
    fixture.store.registerTaskCreation({ nativeTaskId: 'task-r0', requestedRole: 'diting' });
    // 第一道防线：luban 角色工具面不含 kb_submit_review（自审无入口）
    await expect(toolService.executeTool(fixture.token, 'kb_submit_review', {
      operationId: 'op-review-self', coverage: { sourceRefs: ['tokA'] }, issues: [], conclusion: 'pass',
    }, { amagiTaskId: 'task-w1', amagiAgent: 'luban' })).rejects.toMatchObject({ code: 'tool_not_allowed' });
    expect(readDraftObjects(fixture)[0]).toMatchObject({ reviewStatus: 'pending' });
  });

  it('多 reviewer：两个独立审查者的回执都进入生产候选', async () => {
    const fixture = makeFixture('multi-reviewer');
    await writeDeclaredDoc(fixture);
    fixture.store.registerTaskCreation({ nativeTaskId: 'task-r1', requestedRole: 'diting' });
    fixture.store.registerTaskCreation({ nativeTaskId: 'task-r2', requestedRole: 'diting' });
    const r1 = await toolService.executeTool(fixture.token, 'kb_submit_review', {
      operationId: 'op-r1', coverage: { sourceRefs: ['tokA'] }, issues: [], conclusion: 'pass',
    }, { amagiTaskId: 'task-r1', amagiAgent: 'diting' });
    const r2 = await toolService.executeTool(fixture.token, 'kb_submit_review', {
      operationId: 'op-r2', coverage: { sourceRefs: ['tokA'] }, issues: [], conclusion: 'pass',
    }, { amagiTaskId: 'task-r2', amagiAgent: 'diting' });
    const { validReportIds, gate } = candidateGate(fixture);
    expect(validReportIds).toContain((r1.details as Record<string, unknown>).reportId);
    expect(validReportIds).toContain((r2.details as Record<string, unknown>).reportId);
    expect(gate.publishable).toBe(true);
  });
});

describe('review-authority 纯函数（发布侧同一权威）', () => {
  it('knowledgeDeclarationHash：审查凭据字段与 calls 账本不入哈希（不自失效）', () => {
    const base = {
      schemaVersion: 1 as const, buildId: 'b', docs: {}, clientKeys: { o: 'ko_1' }, evidenceKeys: {},
      objects: [{ objectId: 'ko_1', reviewStatus: 'pending', title: 'T' }],
      presentations: [], relations: [], evidence: [], coverage: [], calls: {},
    };
    const marked = {
      ...base,
      objects: [{ objectId: 'ko_1', reviewStatus: 'passed', reviewActorKind: 'machine' as const, reviewerId: 'kr_1', reviewedAt: 'now', title: 'T' }],
      calls: { call1: { path: 'a.md', at: 'now', draftRevision: 1, docId: 'd', bytes: 1, objectIdMap: {}, evidenceIdMap: {} } },
    };
    expect(knowledgeDeclarationHash(base as never)).toBe(knowledgeDeclarationHash(marked as never));
    // 对象语义变化（title 变）→ 哈希变化
    const changed = { ...base, objects: [{ objectId: 'ko_1', reviewStatus: 'pending', title: 'T2' }] };
    expect(knowledgeDeclarationHash(base as never)).not.toBe(knowledgeDeclarationHash(changed as never));
    // 空 draft 哈希稳定且与空声明一致
    expect(emptyKnowledgeDeclarationHash()).toBe(emptyKnowledgeDeclarationHash());
  });

  it('collectAuthorityValidatedReports：回执缺报告绑定/依赖漂移/报告覆盖均不入选', async () => {
    const fixture = makeFixture('authority-matrix');
    await writeDeclaredDoc(fixture);
    const review = await submitReview(fixture, 'pass');
    const store = fixture.store;
    const current = resolveCurrentReviewDependencies({ stagingRoot: fixture.state.stagingRoot, snapshot: fixture.state.snapshot, workflowRulesHash: RULES_HASH_V1 });
    // 正文哈希真实取自 staging（与 stagingDraftEntries 同口径：contentResourceHash）
    const { contentResourceHash } = await import('../src/kb/evidence-locator.js');
    const docFile = path.join(fixture.state.stagingRoot, 'docs', DOC_PATH);
    const documentHashes = new Map([[DOC_PATH, contentResourceHash(fs.readFileSync(docFile, 'utf8'))]]);
    const ok = collectAuthorityValidatedReports({ stagingRoot: fixture.state.stagingRoot, store, current, documentHashes });
    expect(ok.validReportIds).toEqual([review.reportId]);
    // 规则漂移
    const drifted = collectAuthorityValidatedReports({ stagingRoot: fixture.state.stagingRoot, store, current: { ...current, workflowRulesHash: RULES_HASH_V2 }, documentHashes });
    expect(drifted.validReportIds).toEqual([]);
    expect(drifted.skipped[0]).toMatchObject({ reason: 'dependency_stale' });
    // 报告文件被删除
    fs.rmSync(path.join(fixture.state.stagingRoot, 'reviews', `${review.unitId}.json`));
    const missing = collectAuthorityValidatedReports({ stagingRoot: fixture.state.stagingRoot, store, current, documentHashes });
    expect(missing.validReportIds).toEqual([]);
    expect(missing.skipped[0]).toMatchObject({ reason: 'report_file_binding_mismatch' });
  });
});
