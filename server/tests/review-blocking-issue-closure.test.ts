/**
 * WP-B1（kb-build-speedup R3.2）：阻断问题关闭语义——selector/声明-only 修订
 * 无法关闭 blocking issue 的事故回归。
 *
 * 事故（构建 b_20261105233621_7161f7，2026-11-06 02:07–02:44）：
 * 作者用 kb_edit_doc.evidenceSelectorUpdates 修好证据列位（正文不变），复核者
 * 给出 pass，但 build_request_publish 连续 3 次返回 kb_publish_blocked /
 * blocking_issue_open——问题关闭绑定正文内容哈希，selector-only 修订未推进
 * 候选，旧 needs_revision 回执被 F01 主体保留视为有效，closureBasis 在 v2
 * 流程无人写入，最终只能伪造一处正文改动才关闭（浪费约 37 分钟）。
 *
 * 修复语义（review-authority.ts WP-B1 段）：
 * - 回执侧：主体绑定的 needs_revision 回执声明漂移且每个 blocking 问题路径都有
 *   「精确绑定当前候选（正文+声明哈希）的独立 pass 复核」覆盖 → 旧报告不再
 *   入选有效报告（blocking_issue_open 消除）。
 * - 问题清单侧（build-actors.openBlockingIssues）：targetPath 被当前候选 pass
 *   回执覆盖的 blocking 问题按已关闭计；Leader 重登记同 issueKey 不重开。
 * - 对照组：无复核、复核 needs_revision、候选在复核后再变化 → 仍被拦截。
 *
 * 真实 AgentToolService/BuildActorStore/KbBuildService 工具链（临时目录 +
 * fixture 快照，不依赖 SQLite/真实模型/真实 ~/.feishu-sync）。
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
  blockingIssueTargetPath,
  collectAuthorityValidatedReports,
  currentPathCandidateBinding,
  passReviewClosureForIssues,
  resolveCurrentReviewDependencies,
  reviewSubjectDigest,
  scopedKnowledgeDeclarationHash,
  standardReviewSubjectResolver,
} from '../src/kb/review-authority.js';
import type { ReviewReceipt } from '../src/kb/build-actors.js';
import { computeSnapshotHash } from '../src/kb/build-orchestration.js';

const RULES_V1 = 'a'.repeat(64);
const DOC_PATH = 'combat/actions.md';
const ISSUE_KEY = 'A5-B1-selector-columns';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let toolService: AgentToolService;
let buildService: KbBuildService;

interface Fixture { name: string; state: BuildRunState; store: BuildActorStore; token: string; leaderToken: string }

function makeFixture(name: string, strict = false): Fixture {
  const buildId = `b_${name}`;
  const stagingRoot = path.join(dataRoot, 'staging', name);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  const store = new BuildActorStore({ buildId, stagingRoot, generation: 1 });
  store.load();
  const state: BuildRunState = {
    gatePolicy: { strict, version: 1 as const },
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

/** 复审（needs_revision 时带 blocking 问题；复现事故里 diting 的微复核链）。 */
async function review(fixture: Fixture, options: {
  task: string; conclusion: 'pass' | 'needs_revision'; issues?: Array<{ description: string }>;
}): Promise<Record<string, unknown>> {
  fixture.store.registerTaskCreation({ nativeTaskId: options.task, requestedRole: 'diting' });
  const result = await toolService.executeTool(fixture.token, 'kb_submit_review', {
    operationId: `op-review-${options.task}-${Math.random().toString(36).slice(2, 8)}`,
    coverage: { docPaths: [DOC_PATH], sourceRefs: ['tokA'] },
    checkedDimensions: ['事实与数值'],
    issues: (options.issues ?? []).map((issue) => ({
      draftLocation: `${DOC_PATH} 怒气消耗`,
      sourceLocation: '源A 第2行',
      description: issue.description,
      severity: 'blocking',
    })),
    uncheckedScope: [], conclusion: options.conclusion,
  }, { amagiTaskId: options.task, amagiAgent: 'diting' });
  return result.details as Record<string, unknown>;
}

function draft(fixture: Fixture): { objects: Array<Record<string, any>>; evidence: Array<Record<string, any>> } {
  return JSON.parse(fs.readFileSync(path.join(fixture.state.stagingRoot, 'knowledge-draft.json'), 'utf8'));
}

async function editSelector(fixture: Fixture, operationId: string): Promise<void> {
  const evidenceId = draft(fixture).evidence[0]!.evidenceId as string;
  const current = draft(fixture).evidence[0]!.selector as { lineStart: number };
  await toolService.executeTool(fixture.token, 'kb_edit_doc', {
    path: DOC_PATH, operationId,
    evidenceSelectorUpdates: [{ evidenceId, readReceiptId: await readReceipt(fixture),
      selector: { kind: 'text_span', lineStart: current.lineStart, lineEnd: current.lineEnd + 1, colStart: 1, colEnd: 0 } }],
  }, writer);
}

/** 发布侧同一权威：collect（含 WP-B1 取代判定）。 */
function authority(fixture: Fixture) {
  const root = fixture.state.stagingRoot;
  const docFile = path.join(root, 'docs', DOC_PATH);
  const documentHashes = new Map([[DOC_PATH, contentResourceHash(fs.readFileSync(docFile, 'utf8'))]]);
  return collectAuthorityValidatedReports({ stagingRoot: root, store: fixture.store, documentHashes,
    subjectOf: standardReviewSubjectResolver(root, fixture.state.gatePolicy),
    current: resolveCurrentReviewDependencies({ stagingRoot: root, snapshot: fixture.state.snapshot,
      workflowRulesHash: fixture.state.v2WorkflowRulesHash }) });
}

/** 真实候选组装 + canPublish（事故出口：blocking_issue_open）。 */
function candidateGate(fixture: Fixture): { publishable: boolean; reasons: string[] } {
  const assembled = (buildService as unknown as { assembleCandidateRelease: (input: unknown) => { candidate: never; candidateHash: string } })
    .assembleCandidateRelease({ buildId: `b_${fixture.name}`, entry: {}, buildState: fixture.state, snapshot: fixture.state.snapshot,
      stagingRoot: fixture.state.stagingRoot, programChecks: { passed: true, checkIds: ['fixture'] }, summary: 's',
      specInfo: { publishMode: 'auto', baseReleaseId: null, sourceSnapshotHash: resolveCurrentReviewDependencies({
        stagingRoot: fixture.state.stagingRoot, snapshot: fixture.state.snapshot, workflowRulesHash: null }).sourceSnapshotHash } });
  const reports = (KbBuildService as unknown as { collectReviewReports: (root: string) => ReviewReport[] })
    .collectReviewReports(fixture.state.stagingRoot);
  const gate = canPublish({ candidate: assembled.candidate, reports, requiredReviewDraftHashes: [assembled.candidateHash],
    expectedSourceSnapshotHash: (assembled.candidate as unknown as { sourceSnapshotHash: string }).sourceSnapshotHash,
    expectedBaseReleaseId: null });
  return { publishable: gate.publishable, reasons: [...gate.reasons] };
}

/** Leader 登记问题清单（kil 层）；返回最新清单的 openBlockingIssues 计数。 */
async function registerIssue(fixture: Fixture, fromReviewId: string | null = null): Promise<number> {
  await toolService.executeTool(fixture.leaderToken, 'build_issues_submit', {
    issues: [{ issueKey: ISSUE_KEY, severity: 'blocking', targetPath: DOC_PATH,
      draftLocation: `${DOC_PATH} 怒气消耗`, sourceLocation: '源A 第2行',
      description: '证据 selector 列位与表格实际数据列不符', fromReviewId }],
  }, { amagiTaskId: 'task-leader', amagiAgent: 'amagi' });
  return fixture.store.openBlockingIssues();
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpb1-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpb1-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpb1-out-'));
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

describe('WP-B1 事故回归：selector-only 修订 + 针对新候选的 pass 复核', () => {
  it('修订与 pass 复核后：发布不再被 blocking_issue_open 拦截；重登记同 issueKey 立即关闭', async () => {
    const fixture = makeFixture('incident-main');
    await writeDoc(fixture);
    const blocking = await review(fixture, { task: 'task-r1', conclusion: 'needs_revision',
      issues: [{ description: '证据 selector 列位 [@C,@D,@G]，@G 为空列，应为 [@C,@D,@F]' }] });
    // 事故前半段：未修复时门禁照常拦截（不放宽）
    expect(fixture.store.listReviews().map((receipt) => receipt.status)).toEqual(['valid']);
    expect(candidateGate(fixture)).toMatchObject({ publishable: false, reasons: ['blocking_issue_open'] });
    expect(await registerIssue(fixture)).toBe(1);

    // 作者修复：selector-only 修订（正文不变）
    await editSelector(fixture, 'op-edit-selector');
    // 旧 needs_revision 回执被 F01 主体保留（status 仍 valid），但无 pass 证据 → 仍拦截
    const retained = fixture.store.listReviews().find((receipt) => receipt.reportId === blocking.reportId);
    expect(retained).toMatchObject({ status: 'valid' });
    expect(candidateGate(fixture)).toMatchObject({ publishable: false, reasons: ['blocking_issue_open'] });
    expect(fixture.store.openBlockingIssues()).toBe(1);

    // 独立复核者针对推进后候选给出 pass
    const passed = await review(fixture, { task: 'task-r2', conclusion: 'pass' });
    expect(passed.reportId).not.toBe(blocking.reportId);

    // 修复后：旧阻断报告不再入选有效报告，发布不再被 blocking_issue_open 拦截
    const selected = authority(fixture);
    expect(selected.validReportIds).toEqual([passed.reportId]);
    expect(selected.skipped).toContainEqual(expect.objectContaining({
      reviewId: expect.any(String), reason: 'blocking_issues_closed_by_current_pass' }));
    expect(candidateGate(fixture).publishable).toBe(true);
    // kil 层：当前候选 pass 证据立即关闭，无需等下一份回执
    expect(fixture.store.openBlockingIssues()).toBe(0);
    // Leader 重登记同 issueKey（事故 02:24 路径）→ 不重新打开
    expect(await registerIssue(fixture)).toBe(0);
  });

  it('对照组：无复核（作者自述修复不关闭）', async () => {
    const fixture = makeFixture('incident-no-recheck');
    await writeDoc(fixture);
    await review(fixture, { task: 'task-r1', conclusion: 'needs_revision',
      issues: [{ description: '证据 selector 列位错误' }] });
    await registerIssue(fixture);
    await editSelector(fixture, 'op-edit-selector');
    expect(authority(fixture).validReportIds.length).toBe(1); // 旧报告仍在有效集合
    expect(candidateGate(fixture)).toMatchObject({ publishable: false, reasons: ['blocking_issue_open'] });
    expect(fixture.store.openBlockingIssues()).toBe(1);
  });

  it('对照组：复核 needs_revision（问题仍在）→ 仍被拦截', async () => {
    const fixture = makeFixture('incident-recheck-blocking');
    await writeDoc(fixture);
    await review(fixture, { task: 'task-r1', conclusion: 'needs_revision',
      issues: [{ description: '证据 selector 列位错误' }] });
    await registerIssue(fixture);
    await editSelector(fixture, 'op-edit-selector');
    // 复核者针对当前候选再次报 blocking：新回执精确绑定当前候选，必须继续拦截
    await review(fixture, { task: 'task-r2', conclusion: 'needs_revision',
      issues: [{ description: '证据 selector 仍指向空列' }] });
    const selected = authority(fixture);
    expect(selected.validReportIds.length).toBe(2);
    expect(selected.skipped.some((item) => item.reason === 'blocking_issues_closed_by_current_pass')).toBe(false);
    expect(candidateGate(fixture)).toMatchObject({ publishable: false, reasons: ['blocking_issue_open'] });
    // needs_revision 复核不构成关闭证据（回执非 pass）
    expect(fixture.store.openBlockingIssues()).toBe(1);
  });

  it('对照组：候选在 pass 复核后再变化（第二次 selector-only 修订）→ 关闭失效、重新拦截', async () => {
    const fixture = makeFixture('incident-drift-after-pass');
    await writeDoc(fixture);
    await review(fixture, { task: 'task-r1', conclusion: 'needs_revision',
      issues: [{ description: '证据 selector 列位错误' }] });
    await registerIssue(fixture);
    await editSelector(fixture, 'op-edit-selector-1');
    await review(fixture, { task: 'task-r2', conclusion: 'pass' });
    expect(fixture.store.openBlockingIssues()).toBe(0);
    expect(candidateGate(fixture).publishable).toBe(true);

    // pass 复核后候选又变了（声明再修订、无人复审）→ pass 回执不再绑定当前候选
    await editSelector(fixture, 'op-edit-selector-2');
    const selected = authority(fixture);
    expect(selected.validReportIds.length).toBe(2); // 旧阻断报告重新入选
    expect(candidateGate(fixture)).toMatchObject({ publishable: false, reasons: ['blocking_issue_open'] });
    expect(fixture.store.openBlockingIssues()).toBe(1);
  });

  it('对照组：同候选 pass 与 blocking 分歧（无候选推进）→ blocking 仍拦截', async () => {
    const fixture = makeFixture('incident-disagreement');
    await writeDoc(fixture);
    await review(fixture, { task: 'task-r1', conclusion: 'needs_revision',
      issues: [{ description: '证据 selector 列位错误' }] });
    await registerIssue(fixture);
    // 未做任何修订，另一审查者直接 pass 同一候选：分歧不能关闭 blocking
    await review(fixture, { task: 'task-r2', conclusion: 'pass' });
    const selected = authority(fixture);
    expect(selected.validReportIds.length).toBe(2);
    expect(candidateGate(fixture)).toMatchObject({ publishable: false, reasons: ['blocking_issue_open'] });
    // 复审 R2：问题清单层同样不被同候选 pass 关闭（起始候选 == 当前候选）
    expect(fixture.store.openBlockingIssues()).toBe(1);
  });

  it('复审 R2 反例：当前候选已有完整 pass，同候选新登记的 blocking 不被旧 pass 吞掉', async () => {
    const fixture = makeFixture('r2-same-candidate-new-issue');
    await writeDoc(fixture);
    // 先有针对当前候选的完整独立 pass（未核范围为空、检查维度非空）
    await review(fixture, { task: 'task-r1', conclusion: 'pass' });
    // Leader 随后新登记该路径的 blocking（新 issueKey；登记时起始候选 = 当前候选）
    expect(await registerIssue(fixture)).toBe(1);
    // 重登记同 issueKey 也不关闭（继承首次起始候选，仍等于当前候选）
    expect(await registerIssue(fixture)).toBe(1);
    expect(authority(fixture).validReportIds.length).toBe(1);
  });

  it('复审 R2：严格模式清单不记录起始候选 → pass 不关闭任何 blocking（保持既有策略）', async () => {
    const fixture = makeFixture('r2-strict', true);
    await writeDoc(fixture);
    await review(fixture, { task: 'task-r1', conclusion: 'needs_revision',
      issues: [{ description: '证据 selector 列位错误' }] });
    await registerIssue(fixture);
    await editSelector(fixture, 'op-edit-selector');
    await review(fixture, { task: 'task-r2', conclusion: 'pass' });
    expect(fixture.store.openBlockingIssues()).toBe(1);
  });

  it('复审 R2-A 反例：严格模式 + fromReviewId 指向真实 needs_revision 报告 + 修订后完整 pass → 计数仍为 1', async () => {
    const fixture = makeFixture('r2a-strict-fromreview', true);
    await writeDoc(fixture);
    const blocking = await review(fixture, { task: 'task-r1', conclusion: 'needs_revision',
      issues: [{ description: '证据 selector 列位错误' }] });
    // 严格模式：清单带 gatePolicy='strict' 且不记录 originBinding，但 fromReviewId
    // 指向真实报告——旧回执依赖漂移 + 新 pass 覆盖也不得自动关闭
    expect(await registerIssue(fixture, blocking.reportId as string)).toBe(1);
    await editSelector(fixture, 'op-edit-selector');
    await review(fixture, { task: 'task-r2', conclusion: 'pass' });
    expect(fixture.store.openBlockingIssues()).toBe(1);
  });

  it('复审 R2-A 对照：标准模式 fromReviewId 回退（originBinding 缺失时）在候选漂移 + pass 后关闭', async () => {
    const fixture = makeFixture('r2a-standard-fromreview');
    await writeDoc(fixture);
    const blocking = await review(fixture, { task: 'task-r1', conclusion: 'needs_revision',
      issues: [{ description: '证据 selector 列位错误' }] });
    // 登记时带 fromReviewId；模拟 originBinding 登记时不可计算（置空）
    const registered = await registerIssue(fixture, blocking.reportId as string);
    expect(registered).toBe(1);
    const latest = fixture.store.listIssueLists().at(-1)!;
    expect(latest.gatePolicy).toBe('standard');
    for (const issue of latest.issues) issue.originBinding = undefined;
    await editSelector(fixture, 'op-edit-selector');
    await review(fixture, { task: 'task-r2', conclusion: 'pass' });
    expect(fixture.store.openBlockingIssues()).toBe(0);
  });
});

describe('复审 R2：问题清单起始候选豁免（直连 store）', () => {
  const r2Roots: string[] = [];
  /** 复现 review.md 附录 R2：完整当前候选 pass + 新登记 blocking。 */
  function r2Fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpb1-r2-')); r2Roots.push(root);
    const stagingRoot = path.join(root, '.staging/b_r2');
    fs.mkdirSync(path.join(stagingRoot, 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    const docContent = '# 标题\n\n正文。\n';
    fs.writeFileSync(path.join(stagingRoot, 'docs/a.md'), docContent);
    const draft: Record<string, any> = { schemaVersion: 1, buildId: 'b_r2', docs: { 'a.md': {} },
      clientKeys: {}, evidenceKeys: {}, objects: [], presentations: [], relations: [],
      evidence: [], calls: {}, coverage: [] };
    fs.writeFileSync(path.join(stagingRoot, 'knowledge-draft.json'), JSON.stringify(draft));
    const sourceRefs = ['src'];
    const declarationHash = scopedKnowledgeDeclarationHash(draft as never, ['a.md'], sourceRefs);
    fs.writeFileSync(path.join(stagingRoot, 'reviews/complete-pass.json'), JSON.stringify({
      reportId: 'kr-complete', buildId: 'b_r2', draftHash: 'candidate',
      coverage: { draftHashes: ['candidate'], sourceRefs }, checkedDimensions: ['事实与数值'],
      issues: [], uncheckedScope: [], conclusion: 'pass', serverVersionTag: 'kb-review/1' }));
    const store = new BuildActorStore({ buildId: 'b_r2', stagingRoot, generation: 1 });
    store.recordReview({ reviewerTaskId: 'task-r9', draftHash: 'candidate', scopePaths: ['a.md'],
      dependencyHashes: { 'doc:a.md': contentResourceHash(docContent),
        'knowledge-declaration': declarationHash, 'declaration-scope': 'document-v2',
        'source-snapshot': 'snapshot', 'workflow-rules': 'rules' },
      ruleVersion: 'kb-review/1', reportUnitId: 'complete-pass', reportId: 'kr-complete',
      issues: [], verdict: 'pass' });
    const newBlocking = (key = 'new-problem') => ({ issueKey: key, severity: 'blocking' as const,
      targetPath: 'a.md', draftLocation: 'a.md', sourceLocation: 'src',
      description: 'pass 后新发现的问题', fromReviewId: null });
    return { store, newBlocking, declarationHash, docContent, stagingRoot };
  }
  afterAll(() => { for (const root of r2Roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  it('无策略标记（旧清单/直连登记）：pass 不是永久豁免，新 blocking 计数 = 1（fail-closed）', () => {
    const fixture = r2Fixture();
    fixture.store.recordIssueList({ summary: null, issues: [fixture.newBlocking()] });
    expect(fixture.store.openBlockingIssues()).toBe(1);
  });

  it('严格模式标记：即使起始候选已漂移且当前 pass 覆盖，也保持既有计数（R2-A）', () => {
    const fixture = r2Fixture();
    fixture.store.recordIssueList({ summary: null, gatePolicy: 'strict', issues: [{ ...fixture.newBlocking('strict-issue'),
      originBinding: { docHash: contentResourceHash(fixture.docContent), declarationHash: 'old-candidate-declaration' } }] });
    expect(fixture.store.openBlockingIssues()).toBe(1);
  });

  it('标准模式标记 + 起始候选等于当前候选（originBinding 未漂移）：同候选新 blocking 不被 pass 关闭', () => {
    const fixture = r2Fixture();
    const binding = currentPathCandidateBinding(fixture.stagingRoot, 'a.md');
    expect(binding).not.toBeNull();
    fixture.store.recordIssueList({ summary: null, gatePolicy: 'standard',
      issues: [{ ...fixture.newBlocking(), originBinding: binding }] });
    expect(fixture.store.openBlockingIssues()).toBe(1);
  });

  it('标准模式标记 + 起始候选已漂移 + 当前 pass 覆盖 → 关闭；重登记同 issueKey 继承首次起始候选仍关闭', () => {
    const fixture = r2Fixture();
    // 首次登记绑定旧候选（selector 不同 → 声明哈希不同）
    fixture.store.recordIssueList({ summary: null, gatePolicy: 'standard',
      issues: [{ ...fixture.newBlocking('drifted-issue'),
      originBinding: { docHash: contentResourceHash(fixture.docContent), declarationHash: 'old-candidate-declaration' } }] });
    expect(fixture.store.openBlockingIssues()).toBe(0);
    fixture.store.recordIssueList({ summary: null, gatePolicy: 'standard',
      issues: [{ ...fixture.newBlocking('drifted-issue'),
      originBinding: { docHash: contentResourceHash(fixture.docContent), declarationHash: fixture.declarationHash } }] });
    // 重登记携带的“新起始候选”被忽略：继承首次登记的漂移候选 → 仍关闭
    expect(fixture.store.openBlockingIssues()).toBe(0);
  });
});

describe('WP-B1 权威选取取代判定（collectAuthorityValidatedReports）', () => {
  const supersessionRoots: string[] = [];
  /** 直接构造 staging + 回执（不经工具链）：声明漂移的 needs_revision 回执与
   * （可选）绑定当前候选的 pass 回执，验证有效报告选取。 */
  function supersessionFixture(input: {
    selectorAfter: 'unchanged' | 'fixed' | 'changed-again';
    passReview: 'none' | 'pass' | 'needs_revision';
    /** 复审 R1：pass 报告的未核范围声明（默认空 = 全范围已核） */
    passUncheckedScope?: string[];
    /** 复审 R1：pass 报告的检查维度（默认非空；[] 应使关闭不成立） */
    passCheckedDimensions?: string[];
    /** 额外审阅范围路径（uncheckedScope 提及其它已知路径时仍可关闭的反例用） */
    extraScopePath?: string;
  }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpb1-sel-')); supersessionRoots.push(root);
    const stagingRoot = path.join(root, '.staging/b_sel');
    fs.mkdirSync(path.join(stagingRoot, 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(stagingRoot, 'docs/combat'), { recursive: true });
    const docContent = '# 标题\n\n正文。\n';
    fs.writeFileSync(path.join(stagingRoot, 'docs', DOC_PATH), docContent);
    const otherContent = '# 其他\n\n其他正文。\n';
    const scopePaths = input.extraScopePath ? [DOC_PATH, input.extraScopePath] : [DOC_PATH];
    if (input.extraScopePath) fs.writeFileSync(path.join(stagingRoot, 'docs', input.extraScopePath), otherContent);
    const sourceRefs = ['tokA'];
    const withSelector = (lineEnd: number): Record<string, any> => ({
      schemaVersion: 1, buildId: 'b_sel', docs: { [DOC_PATH]: {} }, clientKeys: {}, evidenceKeys: {},
      objects: [{ objectId: 'o1', title: 'A', canonical: { path: DOC_PATH } }],
      presentations: [], relations: [],
      evidence: [{ evidenceId: 'ev1', objectId: 'o1', selector: { kind: 'text_span', lineStart: 2, lineEnd } }],
      calls: {}, coverage: [],
    });
    const pre = withSelector(2);          // 审阅时声明（selector 列位错误版本）
    const fixed = withSelector(3);        // 作者 selector-only 修订后
    const current = input.selectorAfter === 'unchanged' ? pre
      : input.selectorAfter === 'fixed' ? fixed : withSelector(4);
    fs.writeFileSync(path.join(stagingRoot, 'knowledge-draft.json'), JSON.stringify(current));
    const snapHash = computeSnapshotHash([]);
    const makeReceipt = (input2: {
      reviewId: string; reviewerTaskId: string; reportUnitId: string; reportId: string;
      verdict: 'pass' | 'needs_revision'; declarationDraft: Record<string, any>; createdAt: string;
    }): ReviewReceipt => ({
      reviewId: input2.reviewId, buildId: 'b_sel', generation: 1, reviewerTaskId: input2.reviewerTaskId,
      draftHash: `candidate-${input2.reportId}`, scopePaths,
      dependencyHashes: {
        [`doc:${DOC_PATH}`]: contentResourceHash(docContent),
        ...(input.extraScopePath ? { [`doc:${input.extraScopePath}`]: contentResourceHash(otherContent) } : {}),
        'knowledge-declaration': scopedKnowledgeDeclarationHash(input2.declarationDraft as never, scopePaths, sourceRefs),
        'declaration-scope': 'document-v2',
        'source-snapshot': snapHash, 'workflow-rules': 'rules',
        [`${REVIEW_DEP_SUBJECT_PREFIX}${DOC_PATH}`]: reviewSubjectDigest(current as never, DOC_PATH, docContent),
        ...(input.extraScopePath
          ? { [`${REVIEW_DEP_SUBJECT_PREFIX}${input.extraScopePath}`]: reviewSubjectDigest(current as never, input.extraScopePath, otherContent) }
          : {}),
      },
      ruleVersion: 'kb-review/1', reportUnitId: input2.reportUnitId, reportId: input2.reportId,
      issues: input2.verdict === 'needs_revision'
        ? [{ issueId: 'kri_1_x', severity: 'blocking', draftLocation: `${DOC_PATH} 某节`,
            sourceLocation: '源A 第2行', description: 'selector 列位错误' }]
        : [],
      verdict: input2.verdict, status: 'valid', staleReason: null, createdAt: input2.createdAt,
    });
    const blockReceipt = makeReceipt({ reviewId: 'krev_block', reviewerTaskId: 'task-r1',
      reportUnitId: 'actor_block', reportId: 'kr_block', verdict: 'needs_revision',
      declarationDraft: pre, createdAt: '2026-11-06T01:30:00.000Z' });
    fs.writeFileSync(path.join(stagingRoot, 'reviews/actor_block.json'), JSON.stringify({
      reportId: 'kr_block', buildId: 'b_sel', draftHash: 'candidate-kr_block',
      coverage: { draftHashes: ['candidate-kr_block'], sourceRefs }, checkedDimensions: ['事实与数值'],
      issues: blockReceipt.issues, uncheckedScope: [], conclusion: 'needs_revision',
      serverVersionTag: 'kb-review/1' }));
    const receipts: ReviewReceipt[] = [blockReceipt];
    if (input.passReview !== 'none') {
      const passReceipt = makeReceipt({ reviewId: 'krev_pass', reviewerTaskId: 'task-r2',
        reportUnitId: 'actor_pass', reportId: 'kr_pass',
        verdict: input.passReview === 'pass' ? 'pass' : 'needs_revision',
        // pass 复核绑定其发生时刻的声明（unchanged=pre / 其余=fixed 版本）；
        // changed-again 时当前声明已再变 → pass 回执不再构成关闭证据
        declarationDraft: input.selectorAfter === 'unchanged' ? pre : fixed,
        createdAt: '2026-11-06T02:01:00.000Z' });
      if (input.passReview === 'needs_revision') {
        passReceipt.issues = [{ issueId: 'kri_2_x', severity: 'blocking',
          draftLocation: `${DOC_PATH} 某节`, sourceLocation: '源A 第2行', description: 'selector 仍错' }];
      }
      fs.writeFileSync(path.join(stagingRoot, 'reviews/actor_pass.json'), JSON.stringify({
        reportId: 'kr_pass', buildId: 'b_sel', draftHash: 'candidate-kr_pass',
        coverage: { draftHashes: ['candidate-kr_pass'], sourceRefs },
        checkedDimensions: input.passCheckedDimensions ?? ['事实与数值'],
        issues: passReceipt.issues, uncheckedScope: input.passUncheckedScope ?? [],
        conclusion: passReceipt.verdict, serverVersionTag: 'kb-review/1' }));
      receipts.push(passReceipt);
    }
    const collect = () => collectAuthorityValidatedReports({
      stagingRoot, store: { listReviews: () => receipts } as never,
      current: { declarationHash: 'unused', sourceSnapshotHash: snapHash, workflowRulesHash: 'rules' },
      documentHashes: new Map(scopePaths.map((docPath) => [docPath,
        contentResourceHash(fs.readFileSync(path.join(stagingRoot, 'docs', docPath), 'utf8'))])),
      subjectOf: standardReviewSubjectResolver(stagingRoot, { strict: false, version: 1 }),
    });
    return { collect, receipts, stagingRoot };
  }
  afterAll(() => { for (const root of supersessionRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  it('事故主链：selector 修订 + 针对新候选的 pass → 旧阻断报告被取代，不再入选', () => {
    const fixture = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass' });
    const selected = fixture.collect();
    expect(selected.validReportIds).toEqual(['kr_pass']);
    expect(selected.skipped).toContainEqual({ reviewId: 'krev_block', reviewerTaskId: 'task-r1',
      reason: 'blocking_issues_closed_by_current_pass' });
  });

  it('无 pass 复核：作者 selector 修订不关闭，旧报告继续入选拦截', () => {
    const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'none' }).collect();
    expect(selected.validReportIds).toEqual(['kr_block']);
    expect(selected.skipped).toEqual([]);
  });

  it('复审 needs_revision：新回执绑定当前候选，两份报告都入选拦截', () => {
    const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'needs_revision' }).collect();
    expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
    expect(selected.skipped).toEqual([]);
  });

  it('pass 后候选再变：关闭失效，旧阻断报告重新入选', () => {
    // pass 回执声明绑定 fixed 版本，当前已是 changed-again → 无关闭证据
    const fixture = supersessionFixture({ selectorAfter: 'changed-again', passReview: 'pass' });
    const selected = fixture.collect();
    expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
    expect(selected.skipped).toEqual([]);
  });

  it('候选未推进时的 pass/blocking 分歧：不关闭（声明未漂移照旧拦截）', () => {
    const selected = supersessionFixture({ selectorAfter: 'unchanged', passReview: 'pass' }).collect();
    expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
    expect(selected.skipped).toEqual([]);
  });

  it('复审 R1 反例：pass 明确声明未核该问题范围（uncheckedScope 提及问题路径）→ 不取代，旧报告继续拦截', () => {
    const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass',
      passUncheckedScope: [`${DOC_PATH} 的证据列位未检查`] }).collect();
    expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
    expect(selected.skipped).toEqual([]);
  });

  it('复审 R1：uncheckedScope 为泛化排除（不提任何已知路径）→ 保守不关闭', () => {
    const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass',
      passUncheckedScope: ['证据列位未检查'] }).collect();
    expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
    expect(selected.skipped).toEqual([]);
  });

  it('终轮 R1-B：非空 uncheckedScope 一律不关闭（含明确归属其它路径的条目，不再做自然语言排除判定）', () => {
    const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass',
      extraScopePath: 'combat/other.md',
      passUncheckedScope: ['combat/other.md 链接未检查'] }).collect();
    expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
    expect(selected.skipped).toEqual([]);
  });

  it('终轮 R1-B 反例（review-3）：英文同义表达（Nothing but…/Everything besides…）不能绕过 → 不关闭', () => {
    for (const entry of ['Nothing but combat/other.md was checked', 'Everything besides combat/other.md was not checked',
      'all documents except combat/other.md were not checked']) {
      const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass',
        extraScopePath: 'combat/other.md', passUncheckedScope: [entry] }).collect();
      expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
      expect(selected.skipped).toEqual([]);
    }
  });

  it('终轮 R1-B：中英混合句与零宽字符句去除空白/零宽后非空 → 不关闭；纯空白 → 完整复核可关闭', () => {
    for (const entry of [`除 combat/other.md 外，Everything was not checked`, 'combat/a\u200bctions.md 未检查']) {
      const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass',
        passUncheckedScope: [entry] }).collect();
      expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
      expect(selected.skipped).toEqual([]);
    }
    // 纯空白（含零宽字符）不表达未核承诺 → 仍可作为完整复核关闭
    const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass',
      passUncheckedScope: ['   ', '\u200b\u200c'] }).collect();
    expect(selected.validReportIds).toEqual(['kr_pass']);
    expect(selected.skipped).toContainEqual(expect.objectContaining({ reason: 'blocking_issues_closed_by_current_pass' }));
  });

  it('复审 R1-A 反例：混合句（除其它路径外全部…均未检查）提及其它路径也不能证明不涉及 → 不关闭', () => {
    const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass',
      extraScopePath: 'combat/other.md',
      passUncheckedScope: [`除 combat/other.md 外，全部文档的证据列位均未检查`] }).collect();
    expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
    expect(selected.skipped).toEqual([]);
  });

  it('复审 R1-A：否定限定句（除…外/全部/其余）即使提及其它路径也一律视为涉及 → 不关闭', () => {
    for (const entry of ['除排版维度外，其余均未复核', `除 combat/other.md 链接外全部未核`, '全部维度仅抽样检查']) {
      const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass',
        extraScopePath: 'combat/other.md', passUncheckedScope: [entry] }).collect();
      expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
      expect(selected.skipped).toEqual([]);
    }
  });

  it('复审 R1：pass 无任何检查维度 → 不构成复核，不关闭', () => {
    const selected = supersessionFixture({ selectorAfter: 'fixed', passReview: 'pass',
      passCheckedDimensions: [] }).collect();
    expect(selected.validReportIds.sort()).toEqual(['kr_block', 'kr_pass']);
    expect(selected.skipped).toEqual([]);
  });
});

describe('WP-B1 关闭证据纯函数', () => {
  const roots: string[] = [];
  function directFixture(mutate?: (draft: Record<string, any>) => void, removeReport = false,
    reportOverrides: Record<string, unknown> = {},
    receiptOverrides: (receipt: ReviewReceipt) => void = () => {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpb1-unit-')); roots.push(root);
    const stagingRoot = path.join(root, '.staging/b_unit');
    fs.mkdirSync(path.join(stagingRoot, 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(stagingRoot, 'docs/combat'), { recursive: true });
    const docContent = '# 标题\n\n正文一\n';
    fs.writeFileSync(path.join(stagingRoot, 'docs', DOC_PATH), docContent);
    const draftFile: Record<string, any> = { schemaVersion: 1, buildId: 'b_unit',
      docs: { [DOC_PATH]: {} }, clientKeys: {}, evidenceKeys: {},
      objects: [{ objectId: 'o1', title: 'A', canonical: { path: DOC_PATH } }],
      presentations: [], relations: [],
      evidence: [{ evidenceId: 'ev1', objectId: 'o1', selector: { kind: 'text_span', lineStart: 2 } }],
      calls: {}, coverage: [] };
    // 回执声明绑定「审阅时」的声明；mutate 模拟审阅后的 selector-only 修订
    const sourceRefs = ['tokA'];
    const declarationHash = scopedKnowledgeDeclarationHash(draftFile as never, [DOC_PATH], sourceRefs);
    if (mutate) mutate(draftFile);
    fs.writeFileSync(path.join(stagingRoot, 'knowledge-draft.json'), JSON.stringify(draftFile));
    const receipt: ReviewReceipt = {
      reviewId: 'krev_pass', buildId: 'b_unit', generation: 1, reviewerTaskId: 'task-r9',
      draftHash: 'candidate-hash', scopePaths: [DOC_PATH],
      dependencyHashes: { [`doc:${DOC_PATH}`]: contentResourceHash(docContent),
        'knowledge-declaration': declarationHash, 'declaration-scope': 'document-v2',
        'source-snapshot': 'snap', 'workflow-rules': 'rules' },
      ruleVersion: 'kb-review/1', reportUnitId: 'actor_pass', reportId: 'kr_pass',
      issues: [], verdict: 'pass', status: 'valid', staleReason: null, createdAt: '2026-11-06T00:00:00.000Z',
    };
    receiptOverrides(receipt);
    if (!removeReport) {
      fs.writeFileSync(path.join(stagingRoot, 'reviews/actor_pass.json'), JSON.stringify({
        reportId: 'kr_pass', draftHash: 'candidate-hash', conclusion: 'pass',
        checkedDimensions: ['事实与数值'], uncheckedScope: [],
        coverage: { draftHashes: ['candidate-hash'], sourceRefs }, ...reportOverrides }));
    }
    const issueRef = { targetPath: DOC_PATH, draftLocation: `${DOC_PATH} 怒气消耗` };
    const collect = () => passReviewClosureForIssues({ stagingRoot, receipts: [receipt], issues: [issueRef] })[0];
    return { stagingRoot, receipt, collect, draftFile };
  }
  afterAll(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  it('精确绑定当前候选且覆盖问题范围的 pass 回执构成关闭证据', () => {
    expect(directFixture().collect()).toBe(true);
  });

  it('声明漂移（selector 修订后无人复审）→ 不构成关闭证据', () => {
    const fixture = directFixture((draftFile) => {
      draftFile.evidence[0].selector = { kind: 'text_span', lineStart: 2, lineEnd: 3 };
    });
    expect(fixture.collect()).toBe(false);
  });

  it('报告文件被删除/覆盖 → 不构成关闭证据', () => {
    expect(directFixture(undefined, true).collect()).toBe(false);
  });

  it('回执非 pass 或 stale → 不构成关闭证据', () => {
    const fixture = directFixture();
    fixture.receipt.verdict = 'needs_revision';
    expect(fixture.collect()).toBe(false);
    fixture.receipt.verdict = 'pass';
    fixture.receipt.status = 'stale';
    expect(fixture.collect()).toBe(false);
  });

  it('复审 R1/R1-B：uncheckedScope 非空（去除空白/零宽后）一律不构成关闭证据；纯空白/空可关闭', () => {
    expect(directFixture(undefined, false, { uncheckedScope: [`${DOC_PATH} 的证据列位未检查`] }).collect()).toBe(false);
    expect(directFixture(undefined, false, { uncheckedScope: [`${DOC_PATH} 怒气消耗未复核`] }).collect()).toBe(false);
    expect(directFixture(undefined, false, { uncheckedScope: ['证据列位未检查'] }).collect()).toBe(false);
    expect(directFixture(undefined, false, { checkedDimensions: [] }).collect()).toBe(false);
    // 终轮 R1-B：不再按路径归属/关键词判定——任何非空未核范围都可能涉及本问题
    expect(directFixture(undefined, false, { uncheckedScope: ['docs/other.md 链接未检查'] }).collect()).toBe(false);
    expect(directFixture(undefined, false, { uncheckedScope: ['Nothing but docs/other.md was checked'] }).collect()).toBe(false);
    expect(directFixture(undefined, false, { uncheckedScope: [`combat/a\u200bctions.md 未检查`] }).collect()).toBe(false);
    // 纯空白（含零宽）不表达未核承诺 → 完整复核仍可关闭
    expect(directFixture(undefined, false, { uncheckedScope: ['   ', '\u200b'] }).collect()).toBe(true);
  });

  it('blockingIssueTargetPath：单路径范围直接归属；多路径含唯一提及才归属；否则 fail-closed', () => {
    const single = ['docs/a.md'];
    expect(blockingIssueTargetPath({ draftLocation: 'docs/a.md 某节' }, single)).toBe('docs/a.md');
    expect(blockingIssueTargetPath({ draftLocation: '某节（无路径）' }, single)).toBe('docs/a.md');
    const multi = ['docs/a.md', 'docs/b.md'];
    expect(blockingIssueTargetPath({ draftLocation: 'docs/b.md 某节' }, multi)).toBe('docs/b.md');
    expect(blockingIssueTargetPath({ draftLocation: 'docs/a.md 与 docs/b.md 某节' }, multi)).toBeNull();
    expect(blockingIssueTargetPath({ draftLocation: '某节' }, multi)).toBeNull();
    expect(blockingIssueTargetPath({ draftLocation: 'docs/a.md' }, undefined)).toBeNull();
    expect(blockingIssueTargetPath({ draftLocation: 'docs/a.md' }, [])).toBeNull();
  });
});
