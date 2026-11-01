/**
 * R2-LC-01 专项：shutdown 与新写者准入的完整接缝。
 *
 * 背景（r2-review-report §3 R2-LC-01）：HTTP 已进入 createBuild 停在异步
 * checkReadiness 时执行 shutdown——请求尚未进入 active/pipelineRuns，磁盘
 * 无启动事实，shutdown 扫描空并返回 quiesced=true；随后 readiness 返回
 * ready，createBuild 继续写库、登记 active 并启动流水线，已发布的
 * 「OS 全部收口/允许清理」结论立即被应用自身的新运行推翻。
 *
 * 修复契约（本文件验证）：
 * 1. shutdown 第一步（任何 await/快照前）封印新写者准入；
 * 2. createBuild/resumeBuild/releaseConfirm（manual publish）首部即拒；
 * 3. 跨 readiness/锁/其它 await 的请求在最终入列/启动/落盘前重核同一租约
 *    （封印后拒绝：不写库、不登记 active、不启动流水线、CURRENT 不切）；
 * 4. 在途准入纳入 shutdown 有界等待与未收口报告（quiesced/timedOut 覆盖
 *    准入写者；超时如实 unsettled，不假装已收敛）；
 * 5. 内部 cancel/shutdown 与流水线内发布执行器不受封印影响（迟到回调由
 *    既有取消链拦下，不引入死锁）。
 *
 * 复现脚本来源：r2-review-evidence/shutdown-admission-probe.mts（真实
 * createBuild/shutdown/readiness 就绪依赖暂停，无准入/pipeline 替换）。
 * 模式：真实 KbBuildService + 临时目录 fixture（发布用例复用
 * build-runtime-publish-cancel 的真实 AgentToolService 审查链）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { computeSnapshotHash } from '../src/kb/build-orchestration.js';
import { KbBuildService, resolveKbShutdownQuiescence } from '../src/kb/kb-build-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { buildDefaultAgentConfig, buildDefaultStandardKbConfig } from '../src/types/agent-knowledge.js';

const tmpRoots: string[] = [];
afterAll(() => { for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true }); });
const mkTmp = (prefix: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
};

// ============================================================================
// 纯判定：准入未收口进入报告（quiesced/timedOut 语义覆盖准入写者）
// ============================================================================

describe('resolveKbShutdownQuiescence：准入接缝（纯判定）', () => {
  const base = {
    cancelled: ['b1'],
    unsettledRuns: [] as string[],
    memoryFacts: [{ buildId: 'b1', hasLeader: true, terminationState: 'confirmed' as const }],
    diskOutcomes: [{ buildId: 'b1', outcome: 'confirmed' as const }],
  };

  it('在途准入未返回 → unsettledAdmissions 列出、timedOut=true、quiesced=false', () => {
    const report = resolveKbShutdownQuiescence({
      ...base,
      unsettledAdmissions: [{ operation: '新建构建', startedAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(report.unsettledAdmissions).toEqual([{ operation: '新建构建', startedAt: '2026-01-01T00:00:00.000Z' }]);
    expect(report.timedOut).toBe(true);
    expect(report.quiesced).toBe(false);
  });

  it('准入全部返回（无在途）→ 不制造未收口；与流水线/对账事实独立', () => {
    const report = resolveKbShutdownQuiescence({ ...base, unsettledAdmissions: [] });
    expect(report.quiesced).toBe(true);
    expect(report.unsettledAdmissions).toEqual([]);
    expect(report.timedOut).toBe(false);
  });

  it('准入与流水线同时未收口 → 两者都在报告里，不互相覆盖', () => {
    const report = resolveKbShutdownQuiescence({
      ...base,
      unsettledRuns: ['b1'],
      unsettledAdmissions: [{ operation: '确认发布', startedAt: 't' }],
    });
    expect(report.unsettled).toEqual(['b1']);
    expect(report.unsettledAdmissions.map((fact) => fact.operation)).toEqual(['确认发布']);
    expect(report.quiesced).toBe(false);
  });
});

// ============================================================================
// createBuild 跨 readiness（复现脚本转正式用例）
// ============================================================================

/** 门控 readiness 的准入世界：真实 KbBuildService，就绪依赖可暂停/放行。 */
function makeAdmissionWorld(options: { pauseReadiness: boolean }) {
  const root = mkTmp('kb-admission-');
  const kb = path.join(root, 'raw');
  fs.mkdirSync(kb);
  const config = {
    knowledgeBaseRoot: kb,
    agent: { ...buildDefaultAgentConfig(root), runtime: { backend: 'pi' as const } },
    standardKb: { ...buildDefaultStandardKbConfig(root), orchestrationMode: 'pi-amagi' as const },
    llm: { providers: [] },
  };
  let signalEntered: (() => void) | null = null;
  let releaseGate: (() => void) | null = null;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const service = new KbBuildService({
    dataRoot: root,
    configProvider: () => config,
    documentsProvider: () => [],
    sheetCsvPaths: () => [],
    buildRuntime: {} as never,
    toolService: { revokeByBuild: () => undefined } as never,
    resolver: {
      checkReadiness: async () => {
        if (options.pauseReadiness) {
          signalEntered?.();
          await gate;
        }
        return { code: 'ready', model: { model: 'fixture/model' } };
      },
    } as never,
    pool: { runningCount: () => 0 } as never,
  } as never);
  let row: Record<string, unknown> | null = null;
  const patches: Array<Record<string, unknown>> = [];
  const store = {
    getActiveKbBuild: () => (row && ['queued', 'preflight', 'running'].includes(String(row.status)) ? row : null),
    getKbBuild: () => row,
    createKbBuild: (input: Record<string, unknown>) => { row = { ...input, created_at: input.createdAt }; },
    updateKbBuild: (_id: string, patch: Record<string, unknown>) => { row = { ...(row ?? {}), ...patch }; patches.push(patch); },
  };
  return { root, service, store, entered, release: () => releaseGate?.(), rowRef: () => row, patchesRef: () => patches };
}

describe('R2-LC-01：createBuild 跨 readiness（复现脚本转正式用例）', () => {
  it('在途准入被拒且收编：封印 → readiness 返回 → 重核拒绝；quiesced=true 且无新行/无 active', async () => {
    const world = makeAdmissionWorld({ pauseReadiness: true });
    const pending = world.service.createBuild(world.store as never, { mode: 'full', confirm: 'BUILD' });
    pending.catch(() => undefined); // 先挂 handler，避免拒诺窗口被记 unhandled rejection
    await world.entered; // 请求已停在 readiness await（shutdown 扫描看不到它）
    // shutdown 的封印是其第一同步步——本行返回时封印已生效
    const shutdownPromise = world.service.shutdown(world.store as never, { timeoutMs: 2_000 });
    world.release(); // readiness 现在返回 ready——旧实现会继续写库并启动流水线
    const report = await shutdownPromise;
    await expect(pending).rejects.toMatchObject({ code: 'kb_shutdown_in_progress', status: 503 });
    expect(report.quiesced).toBe(true); // 在途准入已在有界等待内返回（被拒）
    expect(report.unsettledAdmissions).toEqual([]);
    expect(report.timedOut).toBe(false);
    expect(world.rowRef()).toBeNull(); // 不写库（CREATE_ROW_AFTER_SHUTDOWN 不再发生）
    expect(world.service.hasActiveRun()).toBe(false); // 不登记 active、不启动流水线
  }, 20_000);

  it('超时如实 unknown 保留：在途准入不放行 → quiesced=false/timedOut，事后放行也不落库', async () => {
    const world = makeAdmissionWorld({ pauseReadiness: true });
    const pending = world.service.createBuild(world.store as never, { mode: 'full', confirm: 'BUILD' });
    pending.catch(() => undefined);
    await world.entered;
    const report = await world.service.shutdown(world.store as never, { timeoutMs: 150 });
    expect(report.quiesced).toBe(false); // 不能在准入仍可能在途时出具收口
    expect(report.timedOut).toBe(true);
    expect(report.unsettledAdmissions).toEqual([expect.objectContaining({ operation: '新建构建' })]);
    // 报告之后放行：重核点拒绝，写者从未越过关闭边界
    world.release();
    await expect(pending).rejects.toMatchObject({ code: 'kb_shutdown_in_progress' });
    expect(world.rowRef()).toBeNull();
    expect(world.service.hasActiveRun()).toBe(false);
  }, 20_000);

  it('对照正例：未封印（无 shutdown）时准入正常——行创建、dto queued', async () => {
    const world = makeAdmissionWorld({ pauseReadiness: false });
    const dto = await world.service.createBuild(world.store as never, { mode: 'full', confirm: 'BUILD' });
    // 流水线同步段可能已把 queued 推进到 preflight——两者都证明准入成功
    expect(['queued', 'preflight']).toContain(dto.status);
    expect(world.rowRef()).toBeTruthy();
    expect(world.service.hasActiveRun()).toBe(true);
    // 流水线在最小 fixture 上会尽快失败（launchPipeline onError 吸收）；
    // 等一个事件循环刻度让失败落定，不冒充流水线成功。
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }, 20_000);
});

// ============================================================================
// 封印后的入口行为与内部链可执行性
// ============================================================================

describe('R2-LC-01：封印后公开入口首部拒绝、内部链可执行', () => {
  async function sealedWorld() {
    const world = makeAdmissionWorld({ pauseReadiness: false });
    const report = await world.service.shutdown(world.store as never, { timeoutMs: 50 });
    expect(report.quiesced).toBe(true);
    return world;
  }

  it('createBuild/resumeBuild/releaseConfirm 封印后首部即拒（503，不触碰后续依赖）', async () => {
    const world = await sealedWorld();
    await expect(world.service.createBuild(world.store as never, { mode: 'full', confirm: 'BUILD' }))
      .rejects.toMatchObject({ code: 'kb_shutdown_in_progress', status: 503 });
    await expect(world.service.resumeBuild(world.store as never, 'b_x', 'RESUME'))
      .rejects.toMatchObject({ code: 'kb_shutdown_in_progress' });
    await expect(world.service.releaseConfirm(world.store as never, 'b_x'))
      .rejects.toMatchObject({ code: 'kb_shutdown_in_progress' });
    expect(world.rowRef()).toBeNull();
  }, 20_000);

  it('重复 shutdown 共用封印：第二次仍正常返回，不抛错不误报', async () => {
    const world = await sealedWorld();
    const again = await world.service.shutdown(world.store as never, { timeoutMs: 50 });
    expect(again.quiesced).toBe(true);
    expect(again.unsettledAdmissions).toEqual([]);
  }, 20_000);

  it('cancelBuild 封印后仍可执行（关闭链自身不受准入影响，无死锁）', async () => {
    const world = await sealedWorld();
    const dto = await world.service.cancelBuild(world.store as never, 'b_missing');
    expect(dto).toBeNull();
  }, 20_000);
});

// ============================================================================
// resumeBuild 跨 readiness：恢复也是新流水线写者
// ============================================================================

describe('R2-LC-01：resumeBuild 跨 readiness', () => {
  it('封印后重核拒绝：不置 queued、不登记 active、不启动流水线', async () => {
    const world = makeAdmissionWorld({ pauseReadiness: true });
    const outputRoot = buildDefaultStandardKbConfig(world.root).outputRoot;
    const buildId = 'b_resume_gate';
    const stagingRoot = path.join(outputRoot, '.staging', buildId, 'docs');
    fs.mkdirSync(stagingRoot, { recursive: true });
    new BuildCheckpointStore(outputRoot).save({
      schemaVersion: 1, buildId,
      knowledgeBaseRoot: path.join(world.root, 'raw'),
      baseReleaseId: null, requestedMode: 'full', mode: 'full', backend: 'pi',
      snapshot: [], workset: [], docMeta: [], writtenPaths: [], preservedDocs: [],
      requiredRewrites: [], baseDocPaths: [], finishInfo: null, imageDescriptions: [],
      units: [], unitDone: [], claims: [], singleBatches: [], singleCompleted: 0,
      unitProgress: [], workerCount: 1, wordBudget: 0,
      progress: { stage: 'running', batchesDone: 0, batchesTotal: 1, docsWritten: 0, docsDeleted: 0 } as never,
      updatedAt: new Date().toISOString(),
    } as never, path.dirname(stagingRoot));
    let status = 'interrupted';
    const patches: Array<Record<string, unknown>> = [];
    const store = {
      getActiveKbBuild: () => null,
      getKbBuild: () => ({ id: buildId, status, error_code: null }),
      createKbBuild: () => undefined,
      updateKbBuild: (_id: string, patch: Record<string, unknown>) => { if (patch.status) status = String(patch.status); patches.push(patch); },
    };
    const pending = world.service.resumeBuild(store as never, buildId, 'RESUME');
    pending.catch(() => undefined);
    await world.entered; // 停在 readiness
    const shutdownPromise = world.service.shutdown(store as never, { timeoutMs: 2_000 });
    world.release();
    const report = await shutdownPromise;
    await expect(pending).rejects.toMatchObject({ code: 'kb_shutdown_in_progress' });
    expect(report.quiesced).toBe(true);
    expect(patches).toEqual([]); // 从未置 queued
    expect(world.service.hasActiveRun()).toBe(false);
  }, 20_000);
});

// ============================================================================
// releaseConfirm（manual publish）：指针提交点重核同一租约
// ============================================================================

const RULES_HASH = 'c'.repeat(64);
const DOC_PATH = 'combat/overview.md';

/** 发布世界：真实 AgentToolService + KbBuildService（独立临时目录）。 */
function makePublishWorld() {
  const dataRoot = mkTmp('kb-admission-pub-data-');
  const kbRoot = mkTmp('kb-admission-pub-kb-');
  const outputRoot = mkTmp('kb-admission-pub-out-');
  fs.writeFileSync(path.join(kbRoot, 'src-a.md'), '战斗规则\n战斗采用回合制\n', 'utf-8');
  const docRecord = () => ({
    objToken: 'tokA', wikiNodeToken: null, objType: 'docx', title: '源A',
    localMdPath: 'src-a.md', localRelPath: 'src-a.md',
    lastSyncedModifyTime: '2026-01-01T00:00:00Z', lastSyncedAt: '2026-01-01T00:00:00Z', status: 'synced',
  });
  const toolService = new AgentToolService({ dataRoot, documentsProvider: () => [docRecord()] as never });
  const buildService = new KbBuildService({
    dataRoot,
    documentsProvider: () => [docRecord()] as never,
    sheetCsvPaths: () => [],
    configProvider: () => ({ standardKb: { outputRoot }, knowledgeBaseRoot: kbRoot }) as never,
  } as never);
  return { dataRoot, kbRoot, outputRoot, toolService, buildService, docRecord };
}

const readCurrent = (outputRoot: string): string | null =>
  new StandardKbStore(outputRoot).readCurrent()?.releaseId ?? null;

/** 已审查候选 fixture（纯 Markdown + 默认 actor 审查回执；不登记 active）。 */
async function makeReviewedCandidate(world: ReturnType<typeof makePublishWorld>, name: string) {
  const { kbRoot, outputRoot, toolService } = world;
  const buildId = `b_${name.replace(/_/g, '-')}`;
  const stagingRoot = path.join(outputRoot, '.staging', buildId);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  const store = new BuildActorStore({ buildId, stagingRoot, generation: 1 });
  store.load();
  const state: BuildRunState = {
    knowledgeBaseRoot: kbRoot,
    snapshot: RawSourceSnapshot.fromEntries(
      [{ objToken: 'tokA', objType: 'docx', title: '源A', relPath: 'src-a.md',
        contentHash: computeSourceHash(path.join(kbRoot, 'src-a.md'), [], kbRoot), objEditTime: null }],
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
    runKind: 'build', buildId, outputRoot, knowledgeBaseRoot: kbRoot,
    allowedToolsOverride: [...V2_CHILD_ALL_TOOLS], buildState: state,
    orchestration: { mode: 'pi-amagi', buildId, generation: 1, credential: 'child', actorStore: store },
  });
  store.registerTaskCreation({ nativeTaskId: 'task-w1', requestedRole: 'luban' });
  store.assignOutputs({ ownerTaskId: 'task-w1', targets: [DOC_PATH] });
  await toolService.executeTool(token, 'kb_write_doc', {
    path: DOC_PATH, title: '战斗总览', markdown: '战斗采用回合制；先手由速度决定。',
    sources: ['tokA'], summary: '回合制与先手判定', operationId: 'op-write-1',
  }, { toolCallId: `write-${buildId}`, amagiTaskId: 'task-w1', amagiAgent: 'luban' });
  store.registerTaskCreation({ nativeTaskId: 'task-r1', requestedRole: 'diting' });
  await toolService.executeTool(token, 'kb_submit_review', {
    operationId: 'op-review-1', coverage: { sourceRefs: ['tokA'] },
    checkedDimensions: ['事实与数值'], issues: [], uncheckedScope: [], conclusion: 'pass',
  }, { toolCallId: `review-${buildId}`, amagiTaskId: 'task-r1', amagiAgent: 'diting' });
  // assembleCandidateRelease 输入所需的最小 entry（不入 service.active——
  // manual confirm 不依赖内存 entry，检查点才是真相源）
  const entry: Record<string, unknown> = {
    id: buildId, buildState: state, checkpointReady: false,
    leaderPipelineContext: {
      effectiveMode: 'full',
      sourceSnapshotHash: computeSnapshotHash(state.snapshot.entries),
      baseReleaseId: null, model: null,
      updateKbBuild: () => undefined,
    },
    leaderRun: { generation: 1, spec: { publicationPolicy: 'auto', workflowRevision: RULES_HASH }, publishLock: null, publishRequest: null },
    cancelRequested: false, events: [], nextSeq: 1, unitProgress: new Map(), singleBatches: [], singleCompleted: 0,
    // cancelBuild 所需字段（shutdown 取消链会遍历 workers/process）
    workers: new Map(), cancelController: null, process: null, timedOut: false,
  };
  return { buildId, state, entry, stagingRoot };
}

/** manual confirm 候选落盘（candidate.json + v1 检查点）。 */
async function materializeConfirmCandidate(world: ReturnType<typeof makePublishWorld>, buildId: string, state: BuildRunState, entry: Record<string, unknown>) {
  const { buildService, kbRoot, outputRoot } = world;
  const assemble = (buildService as unknown as { assembleCandidateRelease: (input: unknown) => { candidateHash: string } })
    .assembleCandidateRelease.bind(buildService);
  assemble({
    buildId, entry, buildState: state, snapshot: state.snapshot, stagingRoot: state.stagingRoot,
    programChecks: { passed: true, checkIds: ['fixture'] }, summary: 's',
    specInfo: { publishMode: 'confirm', sourceSnapshotHash: computeSnapshotHash(state.snapshot.entries), baseReleaseId: null },
  });
  new BuildCheckpointStore(outputRoot).save({
    schemaVersion: 1, buildId,
    knowledgeBaseRoot: kbRoot, baseReleaseId: null, requestedMode: 'full', mode: 'full',
    snapshot: state.snapshot.entries, workset: [...state.workset], docMeta: [...(state.docMeta ?? [])],
    writtenPaths: [...(state.writtenPaths ?? [])], preservedDocs: [], requiredRewrites: [], baseDocPaths: [],
    finishInfo: { summary: 's', skipped: [] }, imageDescriptions: [], units: [], unitDone: [], claims: [],
    singleBatches: [], singleCompleted: 0, unitProgress: [], workerCount: 1, wordBudget: 0,
    progress: { stage: 'publishing', batchesDone: 0, batchesTotal: 1, docsWritten: 1, docsDeleted: 0 } as never,
    updatedAt: new Date().toISOString(),
  } as never, state.stagingRoot);
}

describe('R2-LC-01：releaseConfirm（manual publish）跨 await 提交点拒绝', () => {
  it('发布主体执行中 shutdown 封印 → 指针提交点重核拒绝（CURRENT 未切、回落 awaiting_release）', async () => {
    const world = makePublishWorld();
    const fixture = await makeReviewedCandidate(world, 'admission_confirm');
    await materializeConfirmCandidate(world, fixture.buildId, fixture.state, fixture.entry);
    let status = 'awaiting_release';
    const store = {
      getActiveKbBuild: () => null,
      getKbBuild: () => ({ id: fixture.buildId, status, model: 'm' }),
      createKbBuild: () => undefined,
      updateKbBuild: (_id: string, patch: Record<string, unknown>) => { if (patch.status) status = String(patch.status); },
    };
    // releaseConfirm 同步段：awaiting_release 校验 → 占位 publishing → 首个
    // await 让出；此时同步调用 shutdown（封印立即生效），发布主体恢复后
    // 在指针提交点（releaseLease）重核被拒。
    const pending = world.buildService.releaseConfirm(store as never, fixture.buildId);
    pending.catch(() => undefined);
    const shutdownPromise = world.buildService.shutdown(store as never, { timeoutMs: 3_000 });
    await expect(pending).rejects.toMatchObject({ code: 'kb_shutdown_in_progress' });
    const report = await shutdownPromise;
    expect(report.quiesced).toBe(true); // 准入已返回（被拒），无 active/流水线
    expect(report.unsettledAdmissions).toEqual([]);
    expect(readCurrent(world.outputRoot)).toBe(null); // CURRENT 未切
    expect(status).toBe('awaiting_release'); // 失败回落待确认（不假 published）
    const releasesDir = path.join(world.outputRoot, 'releases');
    expect(fs.existsSync(releasesDir) ? fs.readdirSync(releasesDir) : []).toEqual([]); // 未提交副本清理
  }, 30_000);

  it('迟到发布回调对照：shutdown 取消活动构建后，流水线内发布执行器被既有取消链拒绝', async () => {
    const world = makePublishWorld();
    const fixture = await makeReviewedCandidate(world, 'late_callback');
    // 该用例需要真实 Leader 运行入口：登记 active entry 后 shutdown 会先取消。
    // entry 不带 leaderRun（无 OS 写者事实）——迟到回调由 cancelRequested 拦下。
    const entry = { ...fixture.entry, leaderRun: undefined };
    (world.buildService as unknown as { active: Map<string, unknown> }).active.set(fixture.buildId, entry);
    const store = {
      getActiveKbBuild: () => ({ id: fixture.buildId, status: 'publishing' }),
      getKbBuild: () => ({ id: fixture.buildId, status: 'publishing', model: 'm' }),
      createKbBuild: () => undefined,
      updateKbBuild: () => undefined,
    };
    const report = await world.buildService.shutdown(store as never, { timeoutMs: 2_000 });
    expect(report.quiesced).toBe(true);
    const publish = (world.buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest.bind(world.buildService);
    const result = await publish({ buildId: fixture.buildId, generation: 1, candidateHash: '0'.repeat(64), requestedRevision: null, summary: 's' });
    expect(result.accepted).toBe(false);
    expect(String(result.result.reason)).toMatch(/build_cancelled|candidate_conflict/); // 取消链拦下，不越权写
    expect(readCurrent(world.outputRoot)).toBe(null);
  }, 30_000);

  it('发布锁排队：窗口已结算后 shutdown 并释放全部屏障，迟到/排队发布回调仍无新写', async () => {
    const world = makePublishWorld();
    const fixture = await makeReviewedCandidate(world, 'lock_settled');
    // 窗口已结算（revision 已发布/候选已锁定）+ 终止已确认（OS 对账正例形状）
    const entry = {
      ...fixture.entry,
      leaderRun: {
        ...(fixture.entry.leaderRun as Record<string, unknown>),
        publishLock: { candidateHash: '0'.repeat(64), revision: 'r_prior', settledAt: new Date().toISOString() },
        termination: { state: 'confirmed', evidence: 'fixture', at: new Date().toISOString() },
      },
    };
    (world.buildService as unknown as { active: Map<string, unknown> }).active.set(fixture.buildId, entry);
    const store = {
      getActiveKbBuild: () => ({ id: fixture.buildId, status: 'publishing' }),
      getKbBuild: () => ({ id: fixture.buildId, status: 'publishing', model: 'm' }),
      createKbBuild: () => undefined,
      updateKbBuild: () => undefined,
    };
    const report = await world.buildService.shutdown(store as never, { timeoutMs: 2_000 });
    expect(report.quiesced).toBe(true); // 终止 confirmed + 无在途准入
    // 排队/迟到发布回调（屏障全部释放后到达）：锁已结算 → 无条件拒绝，不写不启动
    const publish = (world.buildService as unknown as { executeLeaderPublishRequest: (req: unknown) => Promise<{ accepted: boolean; result: Record<string, unknown> }> })
      .executeLeaderPublishRequest.bind(world.buildService);
    const queued = await publish({ buildId: fixture.buildId, generation: 1, candidateHash: '0'.repeat(64), requestedRevision: null, summary: 's' });
    expect(queued.accepted).toBe(false);
    expect(queued.result.reason).toBe('publish_window_settled');
    expect(readCurrent(world.outputRoot)).toBe(null);
  }, 30_000);

  it('已过 CURRENT 正例：确认发布已提交指针后 shutdown —— 不回滚指针，后续确认/新写入口全部拒绝', async () => {
    const world = makePublishWorld();
    const fixture = await makeReviewedCandidate(world, 'committed_current');
    await materializeConfirmCandidate(world, fixture.buildId, fixture.state, fixture.entry);
    let status = 'awaiting_release';
    const store = {
      getActiveKbBuild: () => null,
      getKbBuild: () => ({ id: fixture.buildId, status, model: 'm' }),
      createKbBuild: () => undefined,
      updateKbBuild: (_id: string, patch: Record<string, unknown>) => { if (patch.status) status = String(patch.status); },
    };
    // 第一次确认发布：CURRENT 真实提交（含安全 DB/状态收尾，不回滚）
    const dto = await world.buildService.releaseConfirm(store as never, fixture.buildId);
    expect(dto.status).toBe('published');
    const committed = readCurrent(world.outputRoot);
    expect(committed).toMatch(/^r_/);
    // shutdown（封印单向，永不解封）
    const report = await world.buildService.shutdown(store as never, { timeoutMs: 2_000 });
    expect(report.quiesced).toBe(true);
    // 已过 CURRENT 后的新写入口：二次确认首部拒绝；指针不被回滚
    await expect(world.buildService.releaseConfirm(store as never, fixture.buildId))
      .rejects.toMatchObject({ code: 'kb_shutdown_in_progress' });
    await expect(world.buildService.createBuild(store as never, { mode: 'full', confirm: 'BUILD' }))
      .rejects.toMatchObject({ code: 'kb_shutdown_in_progress' });
    expect(readCurrent(world.outputRoot)).toBe(committed);
    expect(fs.existsSync(path.join(world.outputRoot, 'releases', committed))).toBe(true);
  }, 30_000);
});
