/**
 * F01（P2 §2.3）：标准门禁的审查主体摘要。
 *
 * 真实 AgentToolService/BuildActorStore/KbBuildService 工具链（临时目录 +
 * fixture 快照，不依赖 SQLite/真实模型）：
 * - 标准模式：只改证据 selector（kb_edit_doc.evidenceSelectorUpdates）或覆盖
 *   去向（coverageUpdates）后回执保持有效、对象凭据重挂、Leader 状态无待审；
 *   正文非空白字符变化 → 回执失效、重新待审。
 * - 严格模式：同样两类修改均失效并重新待审（精确规则不变）。
 * - 无 subject 键的旧回执：标准模式下仍走精确规则。
 * - workflow 规则升级：标准模式保留带 subject 键的回执，严格模式撤销。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { V2_LEADER_TOOLS } from '../src/agent/tool-specs.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { canPublish, type ReviewReport } from '../src/kb/orchestration-contracts.js';
import { contentResourceHash } from '../src/kb/evidence-locator.js';
import {
  REVIEW_DEP_SUBJECT_PREFIX,
  collectAuthorityValidatedReports,
  missingScopedPassReviewPaths,
  normalizeReviewSubjectContent,
  resolveCurrentReviewDependencies,
  standardReviewSubjectResolver,
} from '../src/kb/review-authority.js';

const RULES_V1 = 'a'.repeat(64);
const RULES_V2 = 'b'.repeat(64);
const DOC_PATH = 'combat/actions.md';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let toolService: AgentToolService;
let buildService: KbBuildService;

interface Fixture { name: string; state: BuildRunState; store: BuildActorStore; token: string; leaderToken: string }

function makeFixture(name: string, strict: boolean | null): Fixture {
  const buildId = `b_${name}`;
  const stagingRoot = path.join(dataRoot, 'staging', name);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  const store = new BuildActorStore({ buildId, stagingRoot, generation: 1 });
  store.load();
  const state: BuildRunState = {
    ...(strict === null ? {} : { gatePolicy: { strict, version: 1 as const } }),
    knowledgeBaseRoot: kbRoot,
    snapshot: RawSourceSnapshot.fromEntries([{
      objToken: 'tokA', objType: 'docx', title: '源A', relPath: 'src-a.md',
      contentHash: computeSourceHash(path.join(kbRoot, 'src-a.md'), [], kbRoot), objEditTime: null,
    }], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] }),
    mode: 'full',
    workset: new Map([['tokA', 'added']]),
    stagingRoot,
    finishInfo: null,
    units: [],
    writtenPaths: new Set<string>(),
    docMeta: new Map(),
    v2: { actorStore: store, generation: 1 },
    v2WorkflowRulesHash: RULES_V1,
  };
  const common = { runKind: 'build' as const, buildId, outputRoot, knowledgeBaseRoot: kbRoot, buildState: state };
  const { token } = toolService.createRunContext({ ...common, allowedToolsOverride: [...V2_CHILD_ALL_TOOLS],
    orchestration: { mode: 'pi-amagi', buildId, generation: 1, credential: 'child', actorStore: store } });
  const { token: leaderToken } = toolService.createRunContext({ ...common, allowedToolsOverride: [...V2_LEADER_TOOLS],
    orchestration: { mode: 'pi-amagi', buildId, generation: 1, credential: 'leader', actorStore: store } });
  return { name, state, store, token, leaderToken };
}

const writer = { amagiTaskId: 'task-w1', amagiAgent: 'luban' };

async function readReceipt(fixture: Fixture): Promise<string> {
  const read = await toolService.executeTool(fixture.token, 'raw_read', { objToken: 'tokA' },
    { toolCallId: `read-${Math.random().toString(36).slice(2, 8)}`, ...writer });
  return (read.details as Record<string, unknown>).readReceiptId as string;
}

async function writeDoc(fixture: Fixture): Promise<void> {
  fixture.store.registerTaskCreation({ nativeTaskId: 'task-w1', requestedRole: 'luban' });
  fixture.store.assignOutputs({ ownerTaskId: 'task-w1', targets: [DOC_PATH] });
  const receiptId = await readReceipt(fixture);
  await toolService.executeTool(fixture.token, 'kb_write_doc', {
    path: DOC_PATH, title: '行动规则', sources: ['tokA'], summary: '怒气消耗规则', operationId: 'op-write-1',
    markdown: ['## 怒气消耗', '', '标准行动消耗 2 点怒气，自由行动消耗 1 点。', ''].join('\n'),
    objects: [{ clientKey: 'actRage', type: 'rule', title: '怒气消耗', familyKey: 'combat', variantKey: 'default',
      scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['怒气消耗'],
      claims: [{ claimKey: 'rage-cost', riskCategory: 'normal' }] }],
    evidenceClaims: [{ clientKey: 'evRage', objectKey: 'actRage', claimKey: 'rage-cost',
      sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
      selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0 },
      role: 'supports', nature: 'direct', readReceiptId: receiptId }],
    coverageUpdates: [{ itemId: 'cov-main', sourceId: 'tokA', category: 'rule', importance: 'normal',
      disposition: 'mapped', targetKeys: ['actRage'] }],
  }, writer);
}

async function review(fixture: Fixture): Promise<Record<string, unknown>> {
  fixture.store.registerTaskCreation({ nativeTaskId: 'task-r1', requestedRole: 'diting' });
  const result = await toolService.executeTool(fixture.token, 'kb_submit_review', {
    operationId: `op-review-${Math.random().toString(36).slice(2, 8)}`,
    coverage: { docPaths: [DOC_PATH], sourceRefs: ['tokA'] },
    checkedDimensions: ['事实与数值'], issues: [], uncheckedScope: [], conclusion: 'pass',
  }, { amagiTaskId: 'task-r1', amagiAgent: 'diting' });
  return result.details as Record<string, unknown>;
}

function draft(fixture: Fixture): { objects: Array<Record<string, any>>; evidence: Array<Record<string, any>>; coverage: Array<Record<string, any>> } {
  return JSON.parse(fs.readFileSync(path.join(fixture.state.stagingRoot, 'knowledge-draft.json'), 'utf8'));
}

async function editSelector(fixture: Fixture, operationId: string): Promise<void> {
  const evidenceId = draft(fixture).evidence[0]!.evidenceId as string;
  await toolService.executeTool(fixture.token, 'kb_edit_doc', {
    path: DOC_PATH, operationId,
    evidenceSelectorUpdates: [{ evidenceId, readReceiptId: await readReceipt(fixture),
      selector: { kind: 'text_span', lineStart: 2, lineEnd: 3, colStart: 1, colEnd: 0 } }],
  }, writer);
}

async function editBody(fixture: Fixture, operationId: string, oldText: string, newText: string): Promise<void> {
  await toolService.executeTool(fixture.token, 'kb_edit_doc', {
    path: DOC_PATH, operationId, patches: [{ anchor: { kind: 'exact_text', oldText }, newText }],
  }, writer);
}

async function pendingReviewPaths(fixture: Fixture): Promise<string[]> {
  const status = await toolService.executeTool(fixture.leaderToken, 'build_checkpoint', { action: 'status' });
  return (status.details as { documentWorkStatus: { pendingIndependentReviewPaths: string[] } })
    .documentWorkStatus.pendingIndependentReviewPaths;
}

/** 发布侧同一权威：collect + missingScopedPassReviewPaths（按冻结策略取主体解析器）。 */
function authority(fixture: Fixture, workflowRulesHash = fixture.state.v2WorkflowRulesHash ?? null) {
  const root = fixture.state.stagingRoot;
  const docFile = path.join(root, 'docs', DOC_PATH);
  const documentHashes = new Map([[DOC_PATH, contentResourceHash(fs.readFileSync(docFile, 'utf8'))]]);
  const subjectOf = standardReviewSubjectResolver(root, fixture.state.gatePolicy);
  const selected = collectAuthorityValidatedReports({ stagingRoot: root, store: fixture.store, documentHashes, subjectOf,
    current: resolveCurrentReviewDependencies({ stagingRoot: root, snapshot: fixture.state.snapshot, workflowRulesHash }) });
  const missing = missingScopedPassReviewPaths({ writtenPaths: [DOC_PATH], documentHashes, basePromotionHashes: {},
    validReportIds: new Set(selected.validReportIds), receipts: fixture.store.listReviews(), subjectOf });
  return { ...selected, missing };
}

/** 真实候选组装 + canPublish（发布侧 review_missing 判定）。 */
function candidatePublishable(fixture: Fixture): boolean {
  const assembled = (buildService as unknown as { assembleCandidateRelease: (input: unknown) => { candidate: never; candidateHash: string } })
    .assembleCandidateRelease({ buildId: `b_${fixture.name}`, entry: {}, buildState: fixture.state, snapshot: fixture.state.snapshot,
      stagingRoot: fixture.state.stagingRoot, programChecks: { passed: true, checkIds: ['fixture'] }, summary: 's',
      specInfo: { publishMode: 'auto', baseReleaseId: null, sourceSnapshotHash: resolveCurrentReviewDependencies({
        stagingRoot: fixture.state.stagingRoot, snapshot: fixture.state.snapshot, workflowRulesHash: null }).sourceSnapshotHash } });
  const reports = (KbBuildService as unknown as { collectReviewReports: (root: string) => ReviewReport[] })
    .collectReviewReports(fixture.state.stagingRoot);
  return canPublish({ candidate: assembled.candidate, reports, requiredReviewDraftHashes: [assembled.candidateHash],
    expectedSourceSnapshotHash: (assembled.candidate as { sourceSnapshotHash: string }).sourceSnapshotHash,
    expectedBaseReleaseId: null }).publishable;
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revsubj-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revsubj-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revsubj-out-'));
  fs.writeFileSync(path.join(kbRoot, 'src-a.md'), '怒气规则表\n标准行动消耗 2 怒气\n自由行动消耗 1 怒气\n', 'utf-8');
  toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  buildService = new KbBuildService({
    dataRoot, configProvider: () => ({ standardKb: { outputRoot }, knowledgeBaseRoot: kbRoot }) as never,
    promptAssets: () => ({ buildRules: '构建规则', styleGuide: '文风规范' }), reviewPrompt: () => '审查规则',
  } as never);
});

afterAll(() => {
  for (const dir of [dataRoot, kbRoot, outputRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('标准门禁：审查主体摘要', () => {
  it('只改证据 selector：回执保持有效、凭据重挂、无需补审、候选可发布', async () => {
    const fixture = makeFixture('std-selector', false);
    await writeDoc(fixture);
    const passed = await review(fixture);
    const receipt = fixture.store.listReviews()[0]!;
    expect(receipt.dependencyHashes[`${REVIEW_DEP_SUBJECT_PREFIX}${DOC_PATH}`]).toMatch(/^[0-9a-f]{64}$/);
    const subjectBefore = receipt.dependencyHashes[`${REVIEW_DEP_SUBJECT_PREFIX}${DOC_PATH}`];
    const evidenceBefore = draft(fixture).evidence[0]!.selector;

    await editSelector(fixture, 'op-edit-selector');

    expect(draft(fixture).evidence[0]!.selector).not.toEqual(evidenceBefore);
    expect(fixture.store.listReviews()[0]).toMatchObject({ status: 'valid', reportId: passed.reportId });
    expect(standardReviewSubjectResolver(fixture.state.stagingRoot, fixture.state.gatePolicy)!(DOC_PATH)).toBe(subjectBefore);
    // 证据集合入 reviewSubjectHash：声明重算后对象重置，再由同一回执重挂
    expect(draft(fixture).objects[0]).toMatchObject({ reviewStatus: 'passed', reviewActorKind: 'machine', reviewerId: passed.reportId });
    expect(await pendingReviewPaths(fixture)).toEqual([]);
    const selected = authority(fixture);
    expect(selected.validReportIds).toEqual([passed.reportId]);
    expect(selected.missing).toEqual([]);
    expect(candidatePublishable(fixture)).toBe(true);
  });

  it('只改覆盖去向：回执保持有效、无需补审', async () => {
    const fixture = makeFixture('std-coverage', false);
    await writeDoc(fixture);
    const passed = await review(fixture);
    const item = draft(fixture).coverage.find((candidate) => candidate.itemId === 'cov-main')!;
    expect(item).toMatchObject({ disposition: 'mapped', importance: 'normal' });
    await toolService.executeTool(fixture.token, 'kb_edit_doc', {
      path: DOC_PATH, operationId: 'op-edit-coverage',
      coverageUpdates: [{ itemId: 'cov-main', disposition: 'mapped', importance: 'important' }],
    }, writer);
    const after = draft(fixture).coverage.find((candidate) => candidate.itemId === item.itemId)!;
    expect(after).not.toEqual(item);
    expect(fixture.store.listReviews()[0]).toMatchObject({ status: 'valid', reportId: passed.reportId });
    expect(await pendingReviewPaths(fixture)).toEqual([]);
    expect(authority(fixture).missing).toEqual([]);
  });

  it('正文非空白字符变化：回执失效、重新待审；仅行尾空白不算主体变化', async () => {
    const fixture = makeFixture('std-body', false);
    await writeDoc(fixture);
    await review(fixture);
    await editBody(fixture, 'op-edit-ws', '自由行动消耗 1 点。', '自由行动消耗 1 点。   ');
    expect(fixture.store.listReviews()[0]!.status).toBe('valid');
    expect(await pendingReviewPaths(fixture)).toEqual([]);

    await editBody(fixture, 'op-edit-body', '标准行动消耗 2 点', '标准行动消耗 3 点');
    expect(fixture.store.listReviews()[0]).toMatchObject({ status: 'stale' });
    expect(await pendingReviewPaths(fixture)).toEqual([DOC_PATH]);
    const selected = authority(fixture);
    expect(selected.validReportIds).toEqual([]);
    expect(selected.missing).toEqual([DOC_PATH]);
    expect(candidatePublishable(fixture)).toBe(false);
  });

  it('对象断言结构变化：主体摘要变化（不靠写后失效也能被发布侧拦截）', async () => {
    const fixture = makeFixture('std-claim', false);
    await writeDoc(fixture);
    const passed = await review(fixture);
    // 直接改声明文件（绕过写后失效），确认发布侧主体核验仍独立拦截
    const file = path.join(fixture.state.stagingRoot, 'knowledge-draft.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.objects[0].claims[0].riskCategory = 'high';
    fs.writeFileSync(file, JSON.stringify(raw));
    fixture.state.knowledgeDraft = undefined;
    const selected = authority(fixture);
    expect(selected.validReportIds).not.toContain(passed.reportId);
    expect(selected.skipped[0]).toMatchObject({ reason: 'subject_stale' });
    expect(selected.missing).toEqual([DOC_PATH]);
  });

  it('workflow 规则升级：带 subject 键的回执在发布侧与恢复修复中均保留', async () => {
    const fixture = makeFixture('std-workflow', false);
    await writeDoc(fixture);
    const passed = await review(fixture);
    expect(authority(fixture, RULES_V2).validReportIds).toEqual([passed.reportId]);
    fixture.state.writtenPaths!.add(DOC_PATH);
    const stale = (buildService as unknown as { repairWorkflowReviewCredentials: (...args: unknown[]) => string[] })
      .repairWorkflowReviewCredentials(fixture.state, `b_${fixture.name}`, RULES_V2, null, outputRoot, null);
    expect(stale).toEqual([]);
    const reloaded = new BuildActorStore({ buildId: `b_${fixture.name}`, stagingRoot: fixture.state.stagingRoot });
    reloaded.load();
    expect(reloaded.listReviews()[0]).toMatchObject({ status: 'valid', reportId: passed.reportId });
    expect(draft(fixture).objects[0]).toMatchObject({ reviewStatus: 'passed', reviewerId: passed.reportId });
  });

  it('无 subject 键的旧回执：标准模式仍按精确规则失效', async () => {
    const fixture = makeFixture('std-legacy', false);
    await writeDoc(fixture);
    const passed = await review(fixture);
    const receipt = fixture.store.listReviews()[0]!;
    delete receipt.dependencyHashes[`${REVIEW_DEP_SUBJECT_PREFIX}${DOC_PATH}`];
    // 精确规则：workflow 漂移即不入选
    expect(authority(fixture, RULES_V2).validReportIds).toEqual([]);
    expect(authority(fixture).validReportIds).toEqual([passed.reportId]);
    await editSelector(fixture, 'op-edit-legacy');
    expect(fixture.store.listReviews()[0]!.status).toBe('stale');
    expect(await pendingReviewPaths(fixture)).toEqual([DOC_PATH]);
    expect(authority(fixture).missing).toEqual([DOC_PATH]);
  });
});

describe('严格门禁：精确规则不变', () => {
  for (const strict of [true, null] as const) {
    const label = strict === null ? '旧检查点无策略' : 'strict=true';
    it(`${label}：回执不记 subject 键；改证据或正文都需补审`, async () => {
      const fixture = makeFixture(`strict-${String(strict)}-selector`, strict);
      await writeDoc(fixture);
      await review(fixture);
      expect(Object.keys(fixture.store.listReviews()[0]!.dependencyHashes)
        .some((key) => key.startsWith(REVIEW_DEP_SUBJECT_PREFIX))).toBe(false);
      await editSelector(fixture, 'op-edit-selector');
      expect(fixture.store.listReviews()[0]!.status).toBe('stale');
      expect(draft(fixture).objects[0]!.reviewStatus).not.toBe('passed');
      expect(await pendingReviewPaths(fixture)).toEqual([DOC_PATH]);
      expect(authority(fixture).missing).toEqual([DOC_PATH]);
      expect(candidatePublishable(fixture)).toBe(false);

      const body = makeFixture(`strict-${String(strict)}-body`, strict);
      await writeDoc(body);
      await review(body);
      await editBody(body, 'op-edit-body', '标准行动消耗 2 点', '标准行动消耗 3 点');
      expect(body.store.listReviews()[0]!.status).toBe('stale');
      expect(await pendingReviewPaths(body)).toEqual([DOC_PATH]);
    });
  }

  it('strict=true：workflow 规则升级仍撤销回执并要求重审', async () => {
    const fixture = makeFixture('strict-workflow', true);
    await writeDoc(fixture);
    await review(fixture);
    expect(authority(fixture, RULES_V2).validReportIds).toEqual([]);
    fixture.state.writtenPaths!.add(DOC_PATH);
    const stale = (buildService as unknown as { repairWorkflowReviewCredentials: (...args: unknown[]) => string[] })
      .repairWorkflowReviewCredentials(fixture.state, `b_${fixture.name}`, RULES_V2, null, outputRoot, null);
    expect(stale).toEqual([DOC_PATH]);
  });
});

describe('主体正文规范化', () => {
  it('去文件头、行尾空白与多余空行；头部来源单列', () => {
    const header = '<!--\nfeishu_sync_kb:\n  doc_id: kd_1\n  sources:\n    - tokB\n    - tokA\n  build_id: b_1\n-->\n';
    const a = normalizeReviewSubjectContent(`${header}# T\r\n\r\n正文  \n\n\n\n\n尾\n\n`);
    const b = normalizeReviewSubjectContent(`${header.replace('b_1', 'b_2')}# T\n\n正文\n\n\n尾`);
    expect(a).toEqual(b);
    expect(a.sources).toEqual(['tokA', 'tokB']);
    expect(normalizeReviewSubjectContent(`${header}# T\n\n正文。\n`).body).not.toBe(a.body);
  });
});
