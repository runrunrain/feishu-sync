/**
 * publish-readiness.test.ts — 发布门「早发现」预览（kb-build-speedup R3.1/R3.3）
 *
 * 覆盖：
 * - 共用纯函数一致性：gatherWorksetCoverageFacts + uncoveredWorksetTokens
 *   与发布门 validateStagingDocs 的 source_not_covered 在同一 state 上
 *   产出完全一致的未覆盖源集合（预览=发布时拒绝）；
 * - classifyUncoveredSources：真遗漏（unassigned / processed_not_referenced）
 *   与在途写作（活跃分配且未交接 → 不提示只计数）的区分；已交接的持有者
 *   不再抑制预览（实测 b_20261105233621：已完成任务的分配长期保持 active）；
 * - 占位源（权限 40403 / 未展开引用）不出现在预览（与发布门自动跳过同口径）；
 * - 工具面暴露：build_manifest 工作集首页附带 publishReadiness（翻页不附）、
 *   build_checkpoint(action=status) 附带 publishReadiness 与计数、
 *   build_request_publish 拒绝文本带未覆盖源 objToken。
 *
 * 模式：临时目录 + 手工快照（同 build-runtime-tools.test.ts），不依赖
 * SQLite、不读写真实 ~/.feishu-sync、不调真实模型。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService, validateStdDocPath, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { BuildActorStore } from '../src/kb/build-actors.js';
import { validateStagingDocs } from '../src/kb/kb-build-service.js';
import {
  classifyUncoveredSources,
  coverageSourceIdsOf,
  gatherWorksetCoverageFacts,
  uncoveredWorksetTokens,
} from '../src/kb/publish-readiness.js';
import { V2_LEADER_TOOLS } from '../src/agent/tool-specs.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let service: AgentToolService;

const writeRaw = (rel: string, content: string): string => {
  const target = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
  return target;
};

const RAW_A = '# 源A\n\n第一段内容。\n';
const RAW_B = '# 源B\n\nB 文档内容\n';
const RAW_DENIED = '# 权限受限\n\n> **注意**: 该文档在飞书侧权限受限（当前账号无访问权限，API 返回 40403 no permission），无法获取内容。\n\n> 如需查阅，请在飞书中向文档所有者申请权限后重新获取。';
const RAW_REF = '<!--\nfeishu_sync:\n  obj_type: "docx"\n-->\n# 治理风格\n\n引用200的设计\n\n<synced_reference src-token="ref200"></synced_reference>';

const DOC_A = '<!--\nfeishu_sync_kb:\n  doc_id: kd_a\n  sources:\n    - tokA\n  build_id: b1\n-->\n# 甲\n正文';

function entry(objToken: string, relPath: string, title: string): RawSourceSnapshotEntry {
  return {
    objToken,
    objType: 'docx',
    title,
    relPath,
    contentHash: computeSourceHash(path.join(kbRoot, relPath), [], kbRoot),
    objEditTime: null,
  };
}

function makeSnapshot(): RawSourceSnapshot {
  return RawSourceSnapshot.fromEntries([
    entry('tokA', 'src-a.md', '源A'),
    entry('tokB', 'src-b.md', '源B'),
    entry('tokDenied', 'src-denied.md', '权限受限源'),
    entry('tokRef', 'src-reference.md', '未展开引用源'),
  ], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] });
}

function makeState(stagingName: string, store?: BuildActorStore): BuildRunState {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, 'docs', '甲.md'), DOC_A);
  return {
    knowledgeBaseRoot: kbRoot,
    snapshot: makeSnapshot(),
    mode: 'incremental',
    workset: new Map([['tokA', 'added'], ['tokB', 'added'], ['tokDenied', 'added'], ['tokRef', 'added']]),
    stagingRoot,
    finishInfo: { summary: 'done', skipped: [] },
    docMeta: new Map(),
    ...(store ? { v2: { actorStore: store, generation: store.activeGeneration } } : {}),
  };
}

function makeLeader(stagingName: string, store: BuildActorStore,
  publishHandler?: (input: Record<string, unknown>) => Promise<{ accepted: boolean; result: Record<string, unknown> }>): string {
  const state = makeState(stagingName, store);
  const context = service.createRunContext({
    runKind: 'build',
    buildId: stagingName,
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    buildState: state,
    allowedToolsOverride: [...V2_LEADER_TOOLS],
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: store.activeGeneration, credential: 'leader', actorStore: store,
      ...(publishHandler ? { publishHandler: publishHandler as never } : {}) },
  });
  return context.token;
}

const call = async (token: string, tool: string, args: Record<string, unknown>) =>
  service.executeTool(token, tool, args) as Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;

const stdHeaderDoc = (docId: string, sources: string[]): string =>
  `<!--\nfeishu_sync_kb:\n  doc_id: ${docId}\n  sources:\n${sources.map((token) => `    - ${token}`).join('\n')}\n  build_id: b1\n-->\n# ${docId}\n正文`;

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-ready-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-ready-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-ready-out-'));
  fs.mkdirSync(path.join(outputRoot, 'releases'), { recursive: true });
  writeRaw('src-a.md', RAW_A);
  writeRaw('src-b.md', RAW_B);
  writeRaw('src-denied.md', RAW_DENIED);
  writeRaw('src-reference.md', RAW_REF);
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
});
afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

describe('覆盖判定共用纯函数（预览=发布门）', () => {
  it('uncoveredWorksetTokens 与 validateStagingDocs 的 source_not_covered 完全一致；占位源不计入', () => {
    const staging = path.join(dataRoot, 'staging', 'parity');
    fs.mkdirSync(path.join(staging, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'docs', '甲.md'), DOC_A);
    const state: BuildRunState = {
      knowledgeBaseRoot: kbRoot,
      snapshot: makeSnapshot(),
      mode: 'incremental',
      workset: new Map([['tokA', 'added'], ['tokB', 'added'], ['tokDenied', 'added'], ['tokRef', 'added']]),
      stagingRoot: staging,
      finishInfo: { summary: 'done', skipped: [] },
    };
    // 发布门：tokA 已引用；tokDenied/tokRef 占位自动跳过；tokB 未覆盖
    const issues = validateStagingDocs(state, state.snapshot).filter((issue) => issue.code === 'source_not_covered');
    expect(issues.map((issue) => issue.objToken)).toEqual(['tokB']);
    // 预览：同一 state、同一纯函数 → 同一集合（含分类）
    const facts = gatherWorksetCoverageFacts(state, validateStdDocPath);
    const uncovered = uncoveredWorksetTokens(facts);
    expect(uncovered).toEqual(['tokB']);
    const classified = classifyUncoveredSources({ uncovered, snapshot: state.snapshot, actorStore: null, coverageSourceIds: new Set() });
    expect(classified.trueGaps.map((gap) => gap.objToken)).toEqual(['tokB']);
    expect(classified.trueGaps[0]).toMatchObject({ title: '源B', reason: 'unassigned' });
    expect(classified.inFlightCount).toBe(0);
    // 占位源被草稿误引时不影响一致性（发布门另有 source_permission_denied）
    fs.writeFileSync(path.join(staging, 'docs', '误引.md'), stdHeaderDoc('kd_bad', ['tokDenied']));
    const issues2 = validateStagingDocs(state, state.snapshot);
    expect(issues2.some((issue) => issue.code === 'source_permission_denied' && issue.objToken === 'tokDenied')).toBe(true);
    expect(issues2.filter((issue) => issue.code === 'source_not_covered').map((issue) => issue.objToken)).toEqual(['tokB']);
    expect(uncoveredWorksetTokens(gatherWorksetCoverageFacts(state, validateStdDocPath))).toEqual(['tokB']);
  });

  it('skipped 登记（unitDone ∪ finishInfo）后预览与发布门同步通过', () => {
    const staging = path.join(dataRoot, 'staging', 'parity-skip');
    fs.mkdirSync(path.join(staging, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'docs', '甲.md'), DOC_A);
    const state: BuildRunState = {
      knowledgeBaseRoot: kbRoot,
      snapshot: makeSnapshot(),
      mode: 'incremental',
      workset: new Map([['tokA', 'added'], ['tokB', 'added'], ['tokDenied', 'added'], ['tokRef', 'added']]),
      stagingRoot: staging,
      finishInfo: { summary: 'done', skipped: [{ objToken: 'tokB', reason: '纯明细表，无知识' }] },
    };
    expect(validateStagingDocs(state, state.snapshot).some((issue) => issue.code === 'source_not_covered')).toBe(false);
    const facts = gatherWorksetCoverageFacts(state, validateStdDocPath);
    expect(uncoveredWorksetTokens(facts)).toEqual([]);
  });
});

describe('真遗漏 vs 在途分类', () => {
  it('活跃写作分配（未交接）→ 在途不提示；提交交接后持有者不再抑制', () => {
    const stagingRoot = path.join(dataRoot, 'staging', 'inflight');
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(stagingRoot, 'docs', '甲.md'), DOC_A);
    const store = new BuildActorStore({ buildId: 'b-inflight', stagingRoot, generation: 1 });
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['系统/乙.md'], ownerTaskId: 'w1' });
    const state: BuildRunState = {
      knowledgeBaseRoot: kbRoot, snapshot: makeSnapshot(), mode: 'incremental',
      workset: new Map([['tokA', 'added'], ['tokB', 'added'], ['tokDenied', 'added'], ['tokRef', 'added']]),
      stagingRoot, finishInfo: { summary: 'done', skipped: [] },
    };
    const uncovered = uncoveredWorksetTokens(gatherWorksetCoverageFacts(state));
    expect(uncovered).toEqual(['tokB']);
    // w1 在途（活跃分配 + 已确认写者 + 未交接）→ tokB 不提示
    let classified = classifyUncoveredSources({ uncovered, snapshot: state.snapshot, actorStore: store, coverageSourceIds: new Set() });
    expect(classified.trueGaps).toEqual([]);
    expect(classified.inFlightCount).toBe(1);
    // w1 提交交接（任务收尾）→ 残留 active 分配不再抑制：tokB 变真遗漏
    store.recordReceipt({ authorTaskId: 'w1', kind: 'handoff', operationId: 'op-h1', payloadHash: 'h', paths: [], result: {} });
    classified = classifyUncoveredSources({ uncovered, snapshot: state.snapshot, actorStore: store, coverageSourceIds: new Set() });
    expect(classified.trueGaps.map((gap) => gap.objToken)).toEqual(['tokB']);
    expect(classified.trueGaps[0]!.reason).toBe('unassigned');
    expect(classified.inFlightCount).toBe(0);
  });

  it('覆盖项已处置却无 sources 引用 → processed_not_referenced 真遗漏（即使有在途写作）', () => {
    const stagingRoot = path.join(dataRoot, 'staging', 'processed');
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(stagingRoot, 'docs', '甲.md'), DOC_A);
    const store = new BuildActorStore({ buildId: 'b-processed', stagingRoot, generation: 1 });
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['系统/甲.md'], ownerTaskId: 'w1' });
    const state: BuildRunState = {
      knowledgeBaseRoot: kbRoot, snapshot: makeSnapshot(), mode: 'incremental',
      workset: new Map([['tokA', 'added'], ['tokB', 'added'], ['tokDenied', 'added'], ['tokRef', 'added']]),
      stagingRoot, finishInfo: { summary: 'done', skipped: [] },
    };
    const uncovered = uncoveredWorksetTokens(gatherWorksetCoverageFacts(state));
    const coverageSourceIds = coverageSourceIdsOf({ coverage: [
      { sourceRef: { sourceId: 'tokB' } },
    ] });
    const classified = classifyUncoveredSources({ uncovered, snapshot: state.snapshot, actorStore: store, coverageSourceIds });
    // 实测 b_20261105233621 buff/天下大势签名：内容已处置但 sources 头缺声明
    expect(classified.trueGaps.map((gap) => gap.objToken)).toEqual(['tokB']);
    expect(classified.trueGaps[0]!.reason).toBe('processed_not_referenced');
    expect(classified.inFlightCount).toBe(0);
  });
});

describe('工具面暴露（manifest / checkpoint / 发布拒绝）', () => {
  it('build_manifest 工作集首页附带 publishReadiness（真遗漏 + 计数）；翻页不附带', async () => {
    const stagingRoot = path.join(dataRoot, 'staging', 'b-manifest');
    const store = new BuildActorStore({ buildId: 'b-manifest', stagingRoot, generation: 1 });
    const leader = makeLeader('b-manifest', store);
    const first = await call(leader, 'build_manifest', { limit: 1 });
    const payload = JSON.parse(first.content[0]!.text) as {
      publishReadiness?: { uncoveredWorksetSources: Array<{ objToken: string; reason: string }>; inFlightWorksetSourceCount: number; openBlockingIssues: number; identityGapCount: number } | null;
      nextCursor: string | null;
    };
    // 无在途任务：tokB 是真遗漏；占位源不计入；计数齐全
    expect(payload.publishReadiness).toBeTruthy();
    const readiness = payload.publishReadiness!;
    expect(readiness.uncoveredWorksetSources.map((gap) => gap.objToken)).toEqual(['tokB']);
    expect(readiness.uncoveredWorksetSources[0]!.reason).toBe('unassigned');
    expect(readiness.inFlightWorksetSourceCount).toBe(0);
    expect(readiness.openBlockingIssues).toBe(0);
    expect(readiness.identityGapCount).toBe(0);
    // 翻页（limit=1 → 第二页）不重复附带
    expect(payload.nextCursor).toBeTruthy();
    const second = await call(leader, 'build_manifest', { cursor: payload.nextCursor });
    const payload2 = JSON.parse(second.content[0]!.text) as { publishReadiness?: unknown };
    expect(payload2.publishReadiness).toBeUndefined();
  });

  it('build_checkpoint(action=status) 附带 publishReadiness：在途写作被剔除、只计真遗漏', async () => {
    const stagingRoot = path.join(dataRoot, 'staging', 'b-checkpoint');
    const store = new BuildActorStore({ buildId: 'b-checkpoint', stagingRoot, generation: 1 });
    store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    store.assignOutputs({ targets: ['系统/乙.md'], ownerTaskId: 'w1' });
    const leader = makeLeader('b-checkpoint', store);
    const result = await call(leader, 'build_checkpoint', { action: 'status' });
    const details = result.details as { publishReadiness: { uncoveredWorksetSources: unknown[]; inFlightWorksetSourceCount: number } | null };
    expect(details.publishReadiness).toBeTruthy();
    expect(details.publishReadiness!.uncoveredWorksetSources).toEqual([]);
    expect(details.publishReadiness!.inFlightWorksetSourceCount).toBe(1);
    // w1 交接后：tokB 立即出现在真遗漏（早于发布申请即可见）
    store.recordReceipt({ authorTaskId: 'w1', kind: 'handoff', operationId: 'op-h1', payloadHash: 'h', paths: [], result: {} });
    const after = await call(leader, 'build_checkpoint', { action: 'status' });
    const readiness = (after.details as { publishReadiness: { uncoveredWorksetSources: Array<{ objToken: string }> } }).publishReadiness;
    expect(readiness.uncoveredWorksetSources.map((gap) => gap.objToken)).toEqual(['tokB']);
  });

  it('build_request_publish 拒绝文本带未覆盖源 objToken（不必反查 manifest）', async () => {
    const stagingRoot = path.join(dataRoot, 'staging', 'b-publish');
    const store = new BuildActorStore({ buildId: 'b-publish', stagingRoot, generation: 1 });
    const handler = async () => ({
      accepted: false,
      result: { reason: 'kb_validation_failed', details: { issues: [
        { objToken: 'tokB', code: 'source_not_covered', message: '源既未被文档引用也未列入 skipped' },
      ] }, reasons: ['source_not_covered'] },
    });
    const leader = makeLeader('b-publish', store, handler);
    const result = await call(leader, 'build_request_publish', { summary: '测试申请' });
    expect(result.content[0]!.text).toContain('source_not_covered {tokB}');
    expect(result.content[0]!.text).toContain('rejected');
  });
});
