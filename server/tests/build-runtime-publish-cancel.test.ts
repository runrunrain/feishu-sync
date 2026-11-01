/**
 * 审核修复批 F11：发布取消/超时与 CURRENT 真相收敛。
 * - prepare 中取消：publishRelease 指针提交点（CURRENT rename 紧前）的
 *   preCommitLease 拦下取消/异常 → CURRENT 不切、release 目录清理。
 * - 发布前取消：executeLeaderPublishRequest 真实入口拒绝（CURRENT 未切）。
 * - CURRENT 已切后收尾取消/DB 异常：按指针/发布回执收敛 published，不落
 *   accepted:false/failed，不回滚删除 current release。
 * 模式：真实 AgentToolService/BuildActorStore/KbBuildService（临时目录，
 * 纯 Markdown fixture + 默认审查回执，不依赖 SQLite/真实模型）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService, ToolError, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { computeCandidateHash } from '../src/kb/orchestration-contracts.js';
import { contentResourceHash } from '../src/kb/evidence-locator.js';
import { computeSnapshotHash } from '../src/kb/build-orchestration.js';

const RULES_HASH = 'c'.repeat(64);

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let toolService: AgentToolService;
let buildService: KbBuildService;

const DOC_PATH = 'combat/overview.md';

interface PublishFixture {
  state: BuildRunState;
  store: BuildActorStore;
  token: string;
  entry: Record<string, unknown>;
  buildId: string;
}

/** 已审查通过的候选 fixture（纯 Markdown 或真实 objects 声明 + 默认 actor 审查回执）。 */
async function makeReviewedCandidate(name: string, options: { withObjects?: boolean } = {}): Promise<PublishFixture> {
  const buildId = `b_${name.replace(/_/g, '-')}`;
  // executeLeaderPublishRequest 按约定路径 <outputRoot>/.staging/<buildId> 解析 staging
  const stagingRoot = path.join(outputRoot, '.staging', buildId);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  const store = new BuildActorStore({ buildId, stagingRoot, generation: 1 });
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
    writtenPaths: new Set([DOC_PATH]),
    docMeta: new Map(),
    v2: { actorStore: store, generation: 1 },
    v2WorkflowRulesHash: RULES_HASH,
  };
  const { token } = toolService.createRunContext({
    runKind: 'build',
    buildId,
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    allowedToolsOverride: [...V2_CHILD_ALL_TOOLS],
    buildState: state,
    orchestration: { mode: 'pi-amagi', buildId, generation: 1, credential: 'child', actorStore: store },
  });
  // writer 写草稿 + diting 默认审查 pass（F07/F08 权威链）
  store.registerTaskCreation({ nativeTaskId: 'task-w1', requestedRole: 'luban' });
  store.assignOutputs({ ownerTaskId: 'task-w1', targets: [DOC_PATH] });
  const writeArgs: Record<string, unknown> = options.withObjects
    ? {
      path: DOC_PATH, title: '战斗总览', markdown: '## 回合制\n\n战斗采用回合制；先手由速度决定。',
      sources: ['tokA'], summary: '回合制与先手判定', operationId: 'op-write-1',
      objects: [{
        clientKey: 'objTurn', type: 'rule', title: '回合制', familyKey: 'combat', variantKey: 'default',
        scopeKey: 'pve', scopeText: 'PVE', headingPath: ['回合制'],
        claims: [{ claimKey: 'turn-order', riskCategory: 'normal' }],
      }],
    }
    : {
      path: DOC_PATH, title: '战斗总览', markdown: '战斗采用回合制；先手由速度决定。',
      sources: ['tokA'], summary: '回合制与先手判定', operationId: 'op-write-1',
    };
  if (options.withObjects) {
    // 真实证据链：raw_read 回执 + text_span 证据
    const read = await toolService.executeTool(token, 'raw_read', { objToken: 'tokA' }, { toolCallId: `read-${buildId}`, amagiTaskId: 'task-w1', amagiAgent: 'luban' });
    const receiptId = (read.details as Record<string, unknown>).readReceiptId as string;
    (writeArgs.evidenceClaims as unknown[]) = [{
      clientKey: 'evTurn', objectKey: 'objTurn', claimKey: 'turn-order',
      sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
      selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0 },
      role: 'supports', nature: 'direct', readReceiptId: receiptId,
    }];
  }
  await toolService.executeTool(token, 'kb_write_doc', writeArgs, { amagiTaskId: 'task-w1', amagiAgent: 'luban' });
  store.registerTaskCreation({ nativeTaskId: 'task-r1', requestedRole: 'diting' });
  await toolService.executeTool(token, 'kb_submit_review', {
    operationId: 'op-review-1', coverage: { sourceRefs: ['tokA'] },
    checkedDimensions: ['事实与数值'], issues: [], uncheckedScope: [], conclusion: 'pass',
  }, { amagiTaskId: 'task-r1', amagiAgent: 'diting' });
  // executeLeaderPublishRequest 的最小 entry（真实入口所需字段）
  const updates: Array<Record<string, unknown>> = [];
  const entry: Record<string, unknown> = {
    id: buildId,
    buildState: state,
    checkpointReady: false, // 检查点落盘不在本测试面
    leaderPipelineContext: {
      effectiveMode: 'full',
      sourceSnapshotHash: computeSnapshotHash(state.snapshot.entries),
      baseReleaseId: null,
      model: null,
      updateKbBuild: (patch: Record<string, unknown>) => { updates.push(patch); },
    },
    leaderRun: {
      generation: 1,
      spec: { publicationPolicy: 'auto', workflowRevision: RULES_HASH },
      publishLock: null,
      publishRequest: null,
    },
    cancelRequested: false,
    events: [],
    nextSeq: 1,
    unitProgress: new Map(),
    singleBatches: [],
    singleCompleted: 0,
  };
  (buildService as unknown as { active: Map<string, unknown> }).active.set(buildId, entry);
  return { state, store, token, entry, buildId };
}

const readCurrent = (): string | null => new StandardKbStore(outputRoot).readCurrent()?.releaseId ?? null;

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pubcancel-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pubcancel-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pubcancel-out-'));
  fs.writeFileSync(path.join(kbRoot, 'src-a.md'), '战斗规则\n战斗采用回合制\n', 'utf-8');
  toolService = new AgentToolService({ dataRoot, documentsProvider: () => [docRecord()] });
  buildService = new KbBuildService({
    dataRoot,
    documentsProvider: () => [docRecord()],
    sheetCsvPaths: () => [],
    configProvider: () => ({ standardKb: { outputRoot }, knowledgeBaseRoot: kbRoot }) as never,
  } as never);
});

/** verifySnapshotIntact 所需的最小源记录（status=synced + 本地路径）。 */
function docRecord(): Record<string, unknown> {
  return {
    objToken: 'tokA', wikiNodeToken: null, objType: 'docx', title: '源A',
    localMdPath: 'src-a.md', localRelPath: 'src-a.md',
    lastSyncedModifyTime: '2026-01-01T00:00:00Z', lastSyncedAt: '2026-01-01T00:00:00Z',
    status: 'synced',
  };
}

afterAll(() => {
  for (const dir of [dataRoot, kbRoot, outputRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('F11：发布取消与 CURRENT 真相收敛', () => {
  it('prepare 中取消：指针提交点 lease 拦下 → CURRENT 不切、release 目录清理', async () => {
    const fixture = await makeReviewedCandidate('lease-abort');
    const publish = (buildService as unknown as { publishRelease: (input: unknown) => Promise<unknown> }).publishRelease.bind(buildService);
    await expect(publish({
      buildId: fixture.buildId, releaseId: 'r_lease_abort', mode: 'full', baseReleaseId: null,
      model: null, snapshot: fixture.state.snapshot, stagingRoot: fixture.state.stagingRoot,
      outputRoot, docMeta: fixture.state.docMeta ?? new Map(), skippedSources: [], summary: 's',
      knowledgeBaseRoot: kbRoot,
      preCommitLease: () => { throw new Error('build_cancelled: 发布提交点检测到取消'); },
    })).rejects.toThrow('build_cancelled');
    expect(readCurrent()).toBe(null);
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_lease_abort'))).toBe(false);
  });

  it('发布前取消：executeLeaderPublishRequest 真实入口拒绝（CURRENT 未切）', async () => {
    const fixture = await makeReviewedCandidate('pre-cancel');
    fixture.entry.cancelRequested = true;
    const candidateHash = currentCandidateHash(fixture);
    const result = await (buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest({ buildId: fixture.buildId, generation: 1, candidateHash, requestedRevision: null, summary: 's' });
    expect(result.accepted).toBe(false);
    expect(result.result.reason).toBe('build_cancelled');
    expect(readCurrent()).toBe(null);
  });

  it('成功链对照：executeLeaderPublishRequest 真实发布 → published + CURRENT 切换 + publishLock.revision', async () => {
    const fixture = await makeReviewedCandidate('happy');
    const candidateHash = currentCandidateHash(fixture);
    const result = await (buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest({ buildId: fixture.buildId, generation: 1, candidateHash, requestedRevision: null, summary: 's', authorityLease: { validate: () => {} } });
    expect(result.accepted).toBe(true);
    expect(result.result.status).toBe('published');
    const releaseId = result.result.releaseId as string;
    expect(readCurrent()).toBe(releaseId);
    // 1772 收敛的输入条件：发布窗口结算锁记录已发布 revision
    const leaderRun = fixture.entry.leaderRun as { publishLock: { revision: string } | null };
    expect(leaderRun.publishLock?.revision).toBe(releaseId);
    expect((fixture.entry.leaderPipelineContext as { updateKbBuild: (p: Record<string, unknown>) => void }).updateKbBuild).toBeTruthy();
  });

  it('CURRENT 已切后收尾 DB 异常：按指针收敛 published（不落 failed/未发布，不删除 current）', async () => {
    const fixture = await makeReviewedCandidate('db-fail');
    const ctx = fixture.entry.leaderPipelineContext as { updateKbBuild: (patch: Record<string, unknown>) => void };
    let failedOnce = false;
    const patches: Array<Record<string, unknown>> = [];
    fixture.entry.leaderPipelineContext = {
      ...ctx,
      updateKbBuild: (patch: Record<string, unknown>) => {
        // 第一次 published 落库抛 DB 异常（模拟提交后收尾故障）；收敛段重试成功
        if (patch.status === 'published' && !failedOnce) {
          failedOnce = true;
          throw new Error('SQLITE_BUSY: database is locked');
        }
        patches.push(patch);
      },
    };
    const candidateHash = currentCandidateHash(fixture);
    const result = await (buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest({ buildId: fixture.buildId, generation: 1, candidateHash, requestedRevision: null, summary: 's', authorityLease: { validate: () => {} } });
    // 指针真相优先：CURRENT 已切 → accepted published + warning
    expect(result.accepted).toBe(true);
    expect(result.result.status).toBe('published');
    expect(String(result.result.warning)).toContain('按已发布收敛');
    const releaseId = result.result.releaseId as string;
    expect(readCurrent()).toBe(releaseId);
    expect(fs.existsSync(path.join(outputRoot, 'releases', releaseId))).toBe(true);
    // 收敛段重试把 published 落库成功（不留下中间态）
    expect(patches.some((patch) => patch.status === 'published' && patch.releaseId === releaseId)).toBe(true);
    const leaderRun = fixture.entry.leaderRun as { publishLock: { revision: string } | null };
    expect(leaderRun.publishLock?.revision).toBe(releaseId);
  });

  it('manual 确认发布：CURRENT 已切后收尾 DB 异常 → 不回落 awaiting_release，按指针收敛 published', async () => {
    const fixture = await makeReviewedCandidate('confirm-db-fail');
    const state = fixture.state;
    // 基准 = 当前指针（同 outputRoot 前序用例已发布；confirm 候选基于该基准）
    const baseId = readCurrent();
    // 候选落盘（assembleCandidateRelease 真实产物，含 candidate.json）
    const assemble = (buildService as unknown as { assembleCandidateRelease: (input: unknown) => { candidateHash: string; candidate: unknown } }).assembleCandidateRelease.bind(buildService);
    const { computeSnapshotHash } = await import('../src/kb/build-orchestration.js');
    const assembled = assemble({
      buildId: fixture.buildId, entry: fixture.entry, buildState: state, snapshot: state.snapshot,
      stagingRoot: state.stagingRoot,
      programChecks: { passed: true, checkIds: ['fixture'] }, summary: 's',
      specInfo: { publishMode: 'confirm', sourceSnapshotHash: computeSnapshotHash(state.snapshot.entries), baseReleaseId: baseId },
    });
    expect(assembled.candidateHash).toMatch(/^[0-9a-f]{64}$/);
    // 内存 checkpoint（rebuildBuildStateFromCheckpoint 所需字段）
    const checkpoint = {
      schemaVersion: 1, buildId: fixture.buildId,
      knowledgeBaseRoot: kbRoot, baseReleaseId: baseId, requestedMode: 'full', mode: 'full',
      snapshot: state.snapshot.entries, workset: [...state.workset], docMeta: [...(state.docMeta ?? [])],
      writtenPaths: [...(state.writtenPaths ?? [])], preservedDocs: [], requiredRewrites: [], baseDocPaths: [],
      finishInfo: { summary: 's', skipped: [] }, imageDescriptions: [], units: [], unitDone: [], claims: [],
      singleBatches: [], singleCompleted: 0, unitProgress: [], workerCount: 1, wordBudget: 0,
      progress: { stage: 'publishing', batchesDone: 0, batchesTotal: 1, docsWritten: 1, docsDeleted: 0 } as never, updatedAt: new Date().toISOString(),
    };
    // 检查点落盘（releaseConfirm 真实入口从 BuildCheckpointStore 读取）
    const { BuildCheckpointStore } = await import('../src/kb/build-checkpoint.js');
    new BuildCheckpointStore(outputRoot).save(checkpoint as never, state.stagingRoot);
    // 带状态 mock：published 落库第一次抛 DB 异常，收敛段重试成功
    let status = 'awaiting_release';
    let publishedFailures = 0;
    const patches: Array<Record<string, unknown>> = [];
    const localMapStore = {
      getKbBuild: () => ({ status, model: 'm' }),
      updateKbBuild: (_id: string, patch: Record<string, unknown>) => {
        if (patch.status === 'published' && publishedFailures === 0) {
          publishedFailures += 1;
          throw new Error('SQLITE_BUSY: database is locked');
        }
        if (patch.status) status = String(patch.status);
        patches.push(patch);
      },
    };
    const releaseConfirm = (buildService as unknown as { releaseConfirm: (store: unknown, buildId: string, input?: unknown) => Promise<unknown> }).releaseConfirm.bind(buildService);
    await expect(releaseConfirm(localMapStore, fixture.buildId)).rejects.toThrow('SQLITE_BUSY');
    // F11 收敛：不回落 awaiting_release 谎称未发布；按 CURRENT 指针收敛 published
    expect(publishedFailures).toBe(1);
    expect(status).toBe('published');
    expect(readCurrent()).toMatch(/^r_/);
    expect(readCurrent()).not.toBe(baseId);
    const finalPatch = patches.findLast((patch) => patch.status === 'published');
    expect(finalPatch?.releaseId).toBe(readCurrent());
  });
});

/** 当前 staging 候选哈希（与工具侧 candidateHash 同口径）。 */
function currentCandidateHash(fixture: PublishFixture): string {
  const docsDir = path.join(fixture.state.stagingRoot, 'docs');
  const documents: Array<{ path: string; contentHash: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      if (fs.statSync(child).isDirectory()) walk(child, `${prefix}${name}/`);
      else if (name.endsWith('.md')) {
        documents.push({ path: `${prefix}${name}`, contentHash: contentResourceHash(fs.readFileSync(child, 'utf8')) });
      }
    }
  };
  walk(docsDir, '');
  documents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return computeCandidateHash({ documents });
}

// ============================================================================
// F11/F08 补强：ctx 租约接缝与 manual 冷启动 v2 权威
// ============================================================================

const liveLease = { validate: () => {} };

/** manual 确认 fixture：真实 objects 默认 review → confirm 候选 + v2 检查点落盘。 */
async function makeManualConfirmFixture(name: string, options: { rulesHash?: string; withObjects?: boolean } = {}): Promise<{
  fixture: PublishFixture;
  baseId: string | null;
  candidateHash: string;
}> {
  const fixture = await makeReviewedCandidate(name, { withObjects: options.withObjects ?? true });
  // 用例隔离：重置 CURRENT（无基线 → 知识编译不做基线对象继承校验）
  const pointer = path.join(outputRoot, 'CURRENT.json');
  if (fs.existsSync(pointer)) fs.rmSync(pointer);
  const baseId = readCurrent();
  const assemble = (buildService as unknown as { assembleCandidateRelease: (input: unknown) => { candidateHash: string; candidate: unknown } }).assembleCandidateRelease.bind(buildService);
  const assembled = assemble({
    buildId: fixture.buildId, entry: fixture.entry, buildState: fixture.state, snapshot: fixture.state.snapshot,
    stagingRoot: fixture.state.stagingRoot,
    programChecks: { passed: true, checkIds: ['fixture'] }, summary: 's',
    specInfo: { publishMode: 'confirm', sourceSnapshotHash: computeSnapshotHash(fixture.state.snapshot.entries), baseReleaseId: baseId },
  });
  const checkpoint = {
    schemaVersion: 1, buildId: fixture.buildId,
    knowledgeBaseRoot: kbRoot, baseReleaseId: baseId, requestedMode: 'full', mode: 'full',
    snapshot: fixture.state.snapshot.entries, workset: [...fixture.state.workset], docMeta: [...(fixture.state.docMeta ?? [])],
    writtenPaths: [...(fixture.state.writtenPaths ?? [])], preservedDocs: [], requiredRewrites: [], baseDocPaths: [],
    finishInfo: { summary: 's', skipped: [] }, imageDescriptions: [], units: [], unitDone: [], claims: [],
    singleBatches: [], singleCompleted: 0, unitProgress: [], workerCount: 1, wordBudget: 0,
    progress: { stage: 'publishing', batchesDone: 0, batchesTotal: 1, docsWritten: 1, docsDeleted: 0 } as never, updatedAt: new Date().toISOString(),
    // v2 检查点（冷启动权威核验输入：账本在 staging、规则哈希在 spec）
    leaderRun: {
      schemaVersion: 2, orchestrationMode: 'pi-amagi', generation: 1,
      spec: { buildId: fixture.buildId, workflowRevision: options.rulesHash ?? RULES_HASH },
      material: { mode: 'full', sourceSnapshotHash: computeSnapshotHash(fixture.state.snapshot.entries), baseReleaseId: baseId },
      eventCursor: {}, actors: [], binding: null, actorPayload: null, updatedAt: new Date().toISOString(),
    },
  };
  const { BuildCheckpointStore } = await import('../src/kb/build-checkpoint.js');
  new BuildCheckpointStore(outputRoot).save(checkpoint as never, fixture.state.stagingRoot);
  return { fixture, baseId, candidateHash: assembled.candidateHash };
}

/** 带状态 mock DB（releaseConfirm 真实入口所需最小形状）。 */
function makeStateStore(options: { cancelAfterPublishing?: boolean; publishedFailures?: number } = {}): {
  store: { getKbBuild: () => Record<string, unknown>; updateKbBuild: (id: string, patch: Record<string, unknown>) => void };
  status: () => string;
  patches: () => Array<Record<string, unknown>>;
} {
  let status = 'awaiting_release';
  let publishedFailures = 0;
  const patches: Array<Record<string, unknown>> = [];
  return {
    store: {
      getKbBuild: () => ({ status, model: 'm', id: 'row' }),
      updateKbBuild: (_id: string, patch: Record<string, unknown>) => {
        if (patch.status === 'publishing' && options.cancelAfterPublishing) {
          status = 'cancelled'; // 异步准备期间用户 cancel 落库（DB 行是权威）
          patches.push(patch);
          return;
        }
        if (patch.status === 'published' && publishedFailures < (options.publishedFailures ?? 0)) {
          publishedFailures += 1;
          throw new Error('SQLITE_BUSY: database is locked');
        }
        if (patch.status) status = String(patch.status);
        patches.push(patch);
      },
    },
    status: () => status,
    patches: () => patches,
  };
}

describe('F11 补强：ctx 租约与超时在提交点核验（缺证明拒绝）', () => {
  it('整体超时：entry.timedOut → 提交点拒绝（CURRENT 不切）', async () => {
    const fixture = await makeReviewedCandidate('timeout-abort');
    fixture.entry.timedOut = true;
    const candidateHash = currentCandidateHash(fixture);
    const result = await (buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest({ buildId: fixture.buildId, generation: 1, candidateHash, requestedRevision: null, summary: 's', authorityLease: liveLease });
    expect(result.accepted).toBe(false);
    expect(result.result.reason).toBe('build_cancelled');
    const current = readCurrent();
    if (current) expect(current).not.toMatch(new RegExp(fixture.buildId));
  });

  it('撤 ctx：authorityLease.validate 抛 run_token_invalid → 提交点拒绝（CURRENT 不切）', async () => {
    const fixture = await makeReviewedCandidate('ctx-revoked');
    const candidateHash = currentCandidateHash(fixture);
    const result = await (buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest({
        buildId: fixture.buildId, generation: 1, candidateHash, requestedRevision: null, summary: 's',
        authorityLease: { validate: () => { throw new ToolError('run_token_invalid', 'Leader 运行上下文已撤销', 401); } },
      });
    expect(result.accepted).toBe(false);
    expect(result.result.reason).toBe('run_token_invalid');
    const current = readCurrent();
    if (current) expect(current).not.toMatch(new RegExp(fixture.buildId));
  });

  it('缺证明：无 authorityLease 的发布请求 → 提交点拒绝（fail-closed）', async () => {
    const fixture = await makeReviewedCandidate('no-lease');
    const candidateHash = currentCandidateHash(fixture);
    const result = await (buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest({ buildId: fixture.buildId, generation: 1, candidateHash, requestedRevision: null, summary: 's' });
    expect(result.accepted).toBe(false);
    expect(result.result.reason).toBe('run_token_invalid');
    const current = readCurrent();
    if (current) expect(current).not.toMatch(new RegExp(fixture.buildId));
  });
});

describe('F08/F11 补强：manual 冷启动 v2 权威与取消/指针归属', () => {
  it('真实 objects 默认 review → manual 确认（跨 service 实例冷启动）成功发布', async () => {
    const { fixture, baseId } = await makeManualConfirmFixture('manual-ok');
    const db = makeStateStore();
    // 跨实例冷启动：新 KbBuildService（无内存 entry），权威全在检查点+staging
    const coldService = new KbBuildService({
      dataRoot, documentsProvider: () => [docRecord()], sheetCsvPaths: () => [],
      configProvider: () => ({ standardKb: { outputRoot }, knowledgeBaseRoot: kbRoot }) as never,
    } as never);
    await coldService.releaseConfirm(db.store, fixture.buildId);
    expect(db.status()).toBe('published');
    const current = readCurrent();
    expect(current).toMatch(/^r_/);
    expect(current).not.toBe(baseId);
    // v2 知识布局：对象随 release 发布且凭据为 machine passed
    const { StandardKbStore: Store } = await import('../src/kb/standard-kb-store.js');
    const manifest = new Store(outputRoot).readManifest(current!);
    expect(manifest?.buildId).toBe(fixture.buildId);
    const knowledge = JSON.parse(fs.readFileSync(path.join(outputRoot, 'releases', current!, 'knowledge.json'), 'utf8'));
    expect(knowledge.objects.length).toBeGreaterThan(0);
    expect(knowledge.objects[0].reviewStatus).toBe('passed');
  });

  it('manual 规则漂移：检查点 workflowRevision 与回执绑定不一致 → 拒绝（不退回 legacy 文件池）', async () => {
    const { fixture } = await makeManualConfirmFixture('manual-rules-drift', { rulesHash: 'd'.repeat(64) });
    const db = makeStateStore();
    await expect(buildService.releaseConfirm(db.store, fixture.buildId)).rejects.toMatchObject({ code: 'kb_publish_blocked' });
    expect(db.status()).toBe('awaiting_release');
    expect(readCurrent()).toBe(null); // CURRENT 已被 fixture 重置，漂移拒绝后不得被本 build 切换
  });

  it('manual prepare 取消：确认占位后 DB 行 cancelled → 提交点拒绝（CURRENT 不切，状态如实）', async () => {
    const { fixture } = await makeManualConfirmFixture('manual-cancel');
    const db = makeStateStore({ cancelAfterPublishing: true });
    await expect(buildService.releaseConfirm(db.store, fixture.buildId)).rejects.toMatchObject({ code: 'build_cancelled' });
    expect(db.status()).toBe('cancelled');
    const current = readCurrent();
    // CURRENT 未被本 build 切换（可能仍是前序用例指针，但绝不指向本 build）
    const { StandardKbStore: Store } = await import('../src/kb/standard-kb-store.js');
    if (current) {
      expect(new Store(outputRoot).readManifest(current)?.buildId).not.toBe(fixture.buildId);
    }
  });

  it('他 build 指针已变：本 build 基准失效拒绝，不假 published', async () => {
    const baseId = readCurrent();
    const { fixture } = await makeManualConfirmFixture('manual-stale-base');
    // 确认前他 build 已切走 CURRENT（本 build 候选基准失效）
    const other = await makeReviewedCandidate('manual-other-build');
    const otherHash = currentCandidateHash(other);
    const otherResult = await (buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest({ buildId: other.buildId, generation: 1, candidateHash: otherHash, requestedRevision: null, summary: 's', authorityLease: liveLease });
    expect(otherResult.result.status).toBe('published');
    const otherRelease = otherResult.result.releaseId as string;
    expect(readCurrent()).toBe(otherRelease);
    expect(otherRelease).not.toBe(baseId);
    const db = makeStateStore();
    await expect(buildService.releaseConfirm(db.store, fixture.buildId)).rejects.toMatchObject({ code: 'base_release_changed' });
    expect(db.status()).toBe('awaiting_release'); // 不假 published（committedNow 归属他 build）
    expect(readCurrent()).toBe(otherRelease);
  });
});

// ============================================================================
// F11-R1（R2 根因修正）：提交前不移走唯一草稿——v1 逐文件 copy 进 release，
// staging 原字节永不离位；任何 CURRENT 前失败（拒租约/preparation/copy/
// DB）与提交后清理异常都不触碰草稿原件，rmSync(releaseDir) 只删未提交副本。
// 断言面：草稿字节级完整 + CURRENT/release 真相 + 二次重试成功（v1/v2/manual）。
// ============================================================================

/** staging docs 全量字节快照（含子目录；草稿保留断言用）。 */
function snapshotStagingDocs(stagingRoot: string): Map<string, Buffer> {
  const docsDir = path.join(stagingRoot, 'docs');
  const snapshot = new Map<string, Buffer>();
  if (!fs.existsSync(docsDir)) return snapshot;
  const walk = (dir: string, prefix: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      if (fs.statSync(child).isDirectory()) walk(child, `${prefix}${name}/`);
      else snapshot.set(`${prefix}${name}`, fs.readFileSync(child));
    }
  };
  walk(docsDir, '');
  return snapshot;
}

/** staging docs 与快照逐文件字节相等（key 集合一致 + Buffer.equals）。 */
function expectDocsBytePreserved(stagingRoot: string, before: Map<string, Buffer>): void {
  const after = snapshotStagingDocs(stagingRoot);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [rel, bytes] of before) {
    expect(after.get(rel)?.equals(bytes), `草稿 ${rel} 字节被改变`).toBe(true);
  }
}

const publishWithLease = async (fixture: PublishFixture, releaseId: string, leaseError: Error): Promise<unknown> => {
  const publish = (buildService as unknown as { publishRelease: (input: unknown) => Promise<unknown> }).publishRelease.bind(buildService);
  return publish({
    buildId: fixture.buildId, releaseId, mode: 'full', baseReleaseId: null,
    model: null, snapshot: fixture.state.snapshot, stagingRoot: fixture.state.stagingRoot,
    outputRoot, docMeta: fixture.state.docMeta ?? new Map(), skippedSources: [], summary: 's',
    knowledgeBaseRoot: kbRoot,
    preCommitLease: () => { throw leaseError; },
  });
};

describe('F11-R1：提交点失败保留已接受 staging 草稿（v1/v2/manual 同类路径）', () => {
  it('v1 纯 Markdown 拒租约：草稿原字节保留 + CURRENT 不切 + 二次发布恢复成功', async () => {
    const fixture = await makeReviewedCandidate('f11r1-v1');
    const before = snapshotStagingDocs(fixture.state.stagingRoot);
    expect(before.size).toBeGreaterThan(0);
    const currentBefore = readCurrent();
    await expect(publishWithLease(fixture, 'r_f11r1_v1', new ToolError('run_token_invalid', 'revoked', 401)))
      .rejects.toMatchObject({ code: 'run_token_invalid' });
    // 根因修正回归：v1 不再 rename 唯一副本，staging 原件从未离位
    expectDocsBytePreserved(fixture.state.stagingRoot, before);
    expect(readCurrent()).toBe(currentBefore); // CURRENT 不切
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_f11r1_v1'))).toBe(false); // release 无残留
    // 二次发布恢复：同一 staging 经真实 Leader 入口发布成功
    const candidateHash = currentCandidateHash(fixture);
    const result = await (buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest({ buildId: fixture.buildId, generation: 1, candidateHash, requestedRevision: null, summary: 'retry', authorityLease: liveLease });
    expect(result.accepted).toBe(true);
    expect(result.result.status).toBe('published');
    expect(readCurrent()).toBe(result.result.releaseId);
    // 成功发布后 v1 staging 草稿仍完整保留（与 v2 同语义，供恢复/审计）
    expectDocsBytePreserved(fixture.state.stagingRoot, before);
    const manifest = new StandardKbStore(outputRoot).readManifest(result.result.releaseId as string);
    expect(manifest?.buildId).toBe(fixture.buildId);
    expect(manifest?.docs.map((doc) => doc.path)).toContain(DOC_PATH);
  });

  it('cleanup 失败（提交后尽力而为）：发布成功、CURRENT 已切、staging 原草稿完整，二次重试可用', async () => {
    const fixture = await makeReviewedCandidate('f11r1-cleanup');
    const before = snapshotStagingDocs(fixture.state.stagingRoot);
    expect(before.size).toBeGreaterThan(0);
    // 故障注入（正式注入口=原型方法替换）：旧 release 清理抛错——生产为提交后尽力而为，不得冒泡也不得影响草稿
    const proto = KbBuildService.prototype as unknown as { cleanupOldReleases: (root: string, retain?: number) => void };
    const original = proto.cleanupOldReleases;
    proto.cleanupOldReleases = () => { throw new Error('cleanup boom: 旧 release 清理故障'); };
    try {
      const publish = (buildService as unknown as { publishRelease: (input: unknown) => Promise<unknown> }).publishRelease.bind(buildService);
      await publish({
        buildId: fixture.buildId, releaseId: 'r_f11r1_cleanup', mode: 'full', baseReleaseId: null,
        model: null, snapshot: fixture.state.snapshot, stagingRoot: fixture.state.stagingRoot,
        outputRoot, docMeta: fixture.state.docMeta ?? new Map(), skippedSources: [], summary: 's',
        knowledgeBaseRoot: kbRoot,
      });
      // 发布成功真相不受清理故障影响；staging 原草稿完整保留
      expect(readCurrent()).toBe('r_f11r1_cleanup');
      expectDocsBytePreserved(fixture.state.stagingRoot, before);
      expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_f11r1_cleanup', 'docs', DOC_PATH))).toBe(true);
    } finally {
      proto.cleanupOldReleases = original;
    }
    // 二次重试不受残留清理故障影响：恢复正常清理后再次发布成功（新 releaseId）
    const candidateHash = currentCandidateHash(fixture);
    const result = await (buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest({ buildId: fixture.buildId, generation: 1, candidateHash, requestedRevision: null, summary: 'retry', authorityLease: liveLease });
    expect(result.accepted).toBe(true);
    expect(result.result.status).toBe('published');
    expect(readCurrent()).toBe(result.result.releaseId);
    expectDocsBytePreserved(fixture.state.stagingRoot, before);
  });

  it('v2（objects 声明）拒租约：staging 草稿原字节保留（不被编译产物覆盖）', async () => {
    const fixture = await makeReviewedCandidate('f11r1-v2', { withObjects: true });
    // 真实候选组装（写入 candidate.json —— v2 门禁验收凭据；与 manual 确认同源生产材料）
    const assemble = (buildService as unknown as { assembleCandidateRelease: (input: unknown) => { candidateHash: string; candidate: unknown } }).assembleCandidateRelease.bind(buildService);
    assemble({
      buildId: fixture.buildId, entry: fixture.entry, buildState: fixture.state, snapshot: fixture.state.snapshot,
      stagingRoot: fixture.state.stagingRoot,
      programChecks: { passed: true, checkIds: ['fixture'] }, summary: 's',
      specInfo: { publishMode: 'confirm', sourceSnapshotHash: computeSnapshotHash(fixture.state.snapshot.entries), baseReleaseId: null },
    });
    const before = snapshotStagingDocs(fixture.state.stagingRoot);
    expect(before.size).toBeGreaterThan(0);
    const currentBefore = readCurrent();
    await expect(publishWithLease(fixture, 'r_f11r1_v2', new ToolError('build_cancelled', 'cancelled at commit point', 409)))
      .rejects.toMatchObject({ code: 'build_cancelled' });
    // v2 发布的是编译产物；staging 原始草稿（含 feishu_sync_kb 头）必须原字节保留
    expectDocsBytePreserved(fixture.state.stagingRoot, before);
    expect(fs.readFileSync(path.join(fixture.state.stagingRoot, 'docs', DOC_PATH), 'utf8')).toContain('feishu_sync_kb:');
    expect(readCurrent()).toBe(currentBefore);
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_f11r1_v2'))).toBe(false);
  });

  it('v2 preparation 失败（声明损坏）：rename 前拒绝 → 草稿同样原字节保留', async () => {
    const fixture = await makeReviewedCandidate('f11r1-prep', { withObjects: true });
    const before = snapshotStagingDocs(fixture.state.stagingRoot);
    // 损坏知识声明 → prepareKnowledgePublish 在任何 rename/CURRENT 前抛 kb_publish_blocked
    fs.writeFileSync(path.join(fixture.state.stagingRoot, 'knowledge-draft.json'), '{ corrupted', 'utf8');
    await expect(publishWithLease(fixture, 'r_f11r1_prep', new Error('unreachable')))
      .rejects.toMatchObject({ code: 'kb_publish_blocked' });
    expectDocsBytePreserved(fixture.state.stagingRoot, before);
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_f11r1_prep'))).toBe(false);
  });

  it('manual 确认（v1 布局）取消：提交点拒租约 → 草稿原字节保留，重新确认可恢复发布', async () => {
    const { fixture } = await makeManualConfirmFixture('f11r1-manual', { withObjects: false });
    const before = snapshotStagingDocs(fixture.state.stagingRoot);
    expect(before.size).toBeGreaterThan(0);
    // 冷实例（无内存 entry）：与真实确认端点同形——成功路径 toDto 不依赖本测试的内存 entry
    const coldService = new KbBuildService({
      dataRoot, documentsProvider: () => [docRecord()], sheetCsvPaths: () => [],
      configProvider: () => ({ standardKb: { outputRoot }, knowledgeBaseRoot: kbRoot }) as never,
    } as never);
    const db = makeStateStore({ cancelAfterPublishing: true });
    await expect(coldService.releaseConfirm(db.store, fixture.buildId)).rejects.toMatchObject({ code: 'build_cancelled' });
    expect(db.status()).toBe('cancelled');
    expectDocsBytePreserved(fixture.state.stagingRoot, before);
    const current = readCurrent();
    if (current) {
      const { StandardKbStore: Store } = await import('../src/kb/standard-kb-store.js');
      expect(new Store(outputRoot).readManifest(current)?.buildId).not.toBe(fixture.buildId);
    }
    // 恢复：取消落库后用户重新确认（DB 行回到 awaiting_release）→ 同一 staging 发布成功
    const retry = makeStateStore();
    await coldService.releaseConfirm(retry.store, fixture.buildId);
    expect(retry.status()).toBe('published');
    expect(readCurrent()).toMatch(/^r_/);
    const { StandardKbStore: Store } = await import('../src/kb/standard-kb-store.js');
    expect(new Store(outputRoot).readManifest(readCurrent()!)?.buildId).toBe(fixture.buildId);
  });
});
