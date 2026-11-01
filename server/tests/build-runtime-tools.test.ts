/**
 * build-runtime-tools.test.ts — v2 编排工具闭环（设计 v2 §3.4/§4/§5/§7）
 *
 * 覆盖：Leader 工具面（无正文写工具/task 族）、child 身份链（无头 401/
 * pending 只读/confirmed 角色面）、写入链（分配→幂等→回执→审查失效）、
 * kb_edit_doc（稳定定位/声明继承平移/expectedContentHash/结构化错误）、
 * kb_read_batch（预算/游标/截断/回执）、审查独立性、问题清单与发布窗口、
 * 代次轮换拒绝、kb_read_batch 恢复旧模式可用（不回归）。
 *
 * 模式：临时目录 + 手工快照（同 kb-knowledge-tools.test.ts），不依赖 SQLite。
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService, type BuildRunState, ToolError, draftEditCoordinates } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import { contentResourceHash } from '../src/kb/evidence-locator.js';
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

const RAW_A = '# 源A\n\n第一段内容，包含稳定锚点文本。\n\n## 甲节\n\n甲节内容行1\n甲节内容行2\n';
const RAW_B = '# 源B\n\nB 文档内容\n';

function entry(objToken: string, relPath: string): RawSourceSnapshotEntry {
  return {
    objToken,
    objType: 'docx',
    title: relPath,
    relPath,
    contentHash: computeSourceHash(path.join(kbRoot, relPath), [], kbRoot),
    objEditTime: null,
  };
}

function makeSnapshot(): RawSourceSnapshot {
  return RawSourceSnapshot.fromEntries([entry('tokA', 'src-a.md'), entry('tokB', 'src-b.md')], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] });
}

function makeBuildState(stagingName: string, store?: BuildActorStore): BuildRunState {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  return {
    knowledgeBaseRoot: kbRoot,
    snapshot: makeSnapshot(),
    mode: 'incremental',
    workset: new Map([['tokA', 'added'], ['tokB', 'added']]),
    stagingRoot,
    finishInfo: null,
    docMeta: new Map(),
    ...(store ? { v2: { actorStore: store, generation: store.activeGeneration } } : {}),
  };
}

interface V2Setup {
  leader: { token: string };
  child: { token: string };
  store: BuildActorStore;
  state: BuildRunState;
}

function makeV2(stagingName: string, publishHandler?: V2Setup['store'] extends never ? never : unknown): V2Setup {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  const store = new BuildActorStore({ buildId: stagingName, stagingRoot, generation: 1 });
  const state = makeBuildState(stagingName, store);
  const leader = service.createRunContext({
    runKind: 'build',
    buildId: stagingName,
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    buildState: state,
    allowedToolsOverride: [...V2_LEADER_TOOLS],
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: 1, credential: 'leader', actorStore: store, ...(publishHandler ? { publishHandler: publishHandler as never } : {}) },
  });
  const child = service.createRunContext({
    runKind: 'build',
    buildId: stagingName,
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    buildState: state,
    allowedToolsOverride: V2_CHILD_ALL_TOOLS,
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: 1, credential: 'child', actorStore: store, ...(publishHandler ? { publishHandler: publishHandler as never } : {}) },
  });
  return { leader: { token: leader.token }, child: { token: child.token }, store, state };
}

const meta = (taskId: string, agent: string) => ({ amagiTaskId: taskId, amagiAgent: agent });
const call = (token: string, tool: string, args: Record<string, unknown>, m?: { amagiTaskId?: string; amagiAgent?: string }) =>
  service.executeTool(token, tool, args, m);
const expectToolError = async (fn: () => unknown, code: string) => {
  try {
    await fn();
    throw new Error(`期望 ToolError(${code})，但未抛出`);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    expect(error.code).toBe(code);
  }
};

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-out-'));
  fs.mkdirSync(path.join(outputRoot, 'releases'), { recursive: true });
  writeRaw('src-a.md', RAW_A);
  writeRaw('src-b.md', RAW_B);
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
});
afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

describe('Leader 工具面（§3.4）', () => {
  it('Leader 白名单 = V2_LEADER_TOOLS：无正文写工具、无 task 族、无 kb_finish', () => {
    const setup = makeV2('b-leader');
    const specs = service.getToolSpecsForToken(setup.leader.token)!;
    const names = specs.map((spec) => spec.name);
    expect(names).toEqual([...V2_LEADER_TOOLS]);
    for (const banned of ['kb_write_doc', 'kb_delete_doc', 'kb_finish', 'task_submit', 'app_command', 'ws_write']) {
      expect(names).not.toContain(banned);
    }
  });

  it('Leader 调正文写工具与旧收尾工具被拒；build_manifest 可用', async () => {
    const setup = makeV2('b-leader2');
    await expectToolError(() => call(setup.leader.token, 'kb_write_doc', { path: 'docs/x.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's' }), 'tool_not_allowed');
    await expectToolError(() => call(setup.leader.token, 'kb_finish', { summary: 'x' }), 'tool_not_allowed');
    const manifest = await call(setup.leader.token, 'build_manifest', {});
    expect(JSON.parse(manifest.content[0]!.text).total).toBe(2);
  });

  it('build_manifest 分页与 workset changeType', async () => {
    const setup = makeV2('b-leader3');
    const page1 = await call(setup.leader.token, 'build_manifest', { limit: 1 });
    const body1 = JSON.parse(page1.content[0]!.text);
    expect(body1.entries).toHaveLength(1);
    expect(body1.entries[0].changeType).toBe('added');
    expect(body1.nextCursor).toBeTruthy();
    const page2 = await call(setup.leader.token, 'build_manifest', { limit: 1, cursor: body1.nextCursor });
    expect(JSON.parse(page2.content[0]!.text).entries).toHaveLength(1);
    expect(JSON.parse(page2.content[0]!.text).nextCursor).toBeNull();
  });
});

describe('child 身份链（§4.1）', () => {
  it('无身份头 → 401 amagi_task_missing；pending 只读', async () => {
    const setup = makeV2('b-child1');
    setup.store.ensurePendingIdentity('w-early', 'luban');
    await expectToolError(() => call(setup.child.token, 'raw_read', { objToken: 'tokA' }), 'amagi_task_missing');
    await call(setup.child.token, 'raw_read', { objToken: 'tokA' }, meta('w-early', 'luban'));
    // pending：读可用、写拒绝
    await call(setup.child.token, 'raw_search', { query: '稳定锚点' }, meta('w-early', 'luban'));
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', { path: 'docs/a.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's', operationId: 'op1' }, meta('w-early', 'luban')), 'actor_pending');
  });

  it('角色与登记不一致 → actor_role_mismatch；角色面不含的工具被拒', async () => {
    const setup = makeV2('b-child2');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['docs/a.md'], ownerTaskId: 'w1' });
    await expectToolError(
      () => call(setup.child.token, 'raw_read', { objToken: 'tokA' }, meta('w1', 'diting')),
      'actor_role_mismatch',
    );
    // diting（审查角色）没有 kb_write_doc
    setup.store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    await expectToolError(
      () => call(setup.child.token, 'kb_write_doc', { path: 'docs/z.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's', operationId: 'op1' }, meta('r1', 'diting')),
      'tool_not_allowed',
    );
  });

  it('getToolSpecsForToken 按身份下发子集（pending→只读；角色→专属面）', () => {
    const setup = makeV2('b-child3');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    setup.store.ensurePendingIdentity('p1', 'luban');
    const writerSpecs = service.getToolSpecsForToken(setup.child.token, { amagiTaskId: 'w1', amagiAgent: 'luban' })!.map((s) => s.name);
    expect(writerSpecs).toContain('kb_write_doc');
    expect(writerSpecs).not.toContain('kb_submit_review');
    const reviewerSpecs = service.getToolSpecsForToken(setup.child.token, { amagiTaskId: 'r1', amagiAgent: 'diting' })!.map((s) => s.name);
    expect(reviewerSpecs).toContain('kb_submit_review');
    expect(reviewerSpecs).not.toContain('kb_write_doc');
    const pendingSpecs = service.getToolSpecsForToken(setup.child.token, { amagiTaskId: 'p1', amagiAgent: 'luban' })!.map((s) => s.name);
    expect(pendingSpecs).not.toContain('kb_write_doc');
    expect(pendingSpecs).toContain('raw_read');
    // 无身份头 → 空面（与 amagi_task_missing 拒绝一致）
    const noIdentity = service.getToolSpecsForToken(setup.child.token)!.map((s) => s.name);
    expect(noIdentity).toEqual([]);
    // readOnlyHint 名单：读取类 true，写入类不带（内部 API 层附加 annotations）
    expect(service.isReadOnlyTool('raw_read')).toBe(true);
    expect(service.isReadOnlyTool('kb_write_doc')).toBe(false);
    expect(service.isReadOnlyTool('kb_edit_doc')).toBe(false);
    expect(service.isReadOnlyTool('build_handoff_list')).toBe(true);
  });
});

describe('写入链（§4.2/§4.4）', () => {
  it('未分配 → 可重试 409；分配后写入成功并留回执；重放返回原回执；异载荷拒绝', async () => {
    const setup = makeV2('b-write1');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const writeArgs = { path: 'docs/a.md', title: '文档A', markdown: '正文一', sources: ['tokA'], summary: '概要一', operationId: 'op-w1' };
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeArgs, meta('w1', 'luban')), 'kb_output_not_assigned');
    // Leader 分配
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/a.md'] });
    const first = await call(setup.child.token, 'kb_write_doc', writeArgs, meta('w1', 'luban'));
    expect(first.content[0]!.text).toContain('docs/a.md');
    expect(setup.store.listReceipts()).toHaveLength(1);
    // 同 operationId 同载荷 → 幂等重放
    const replay = await call(setup.child.token, 'kb_write_doc', writeArgs, meta('w1', 'luban'));
    expect(replay.details!.idempotentReplay).toBe(true);
    // 同 operationId 异载荷 → 拒绝
    await expectToolError(
      () => call(setup.child.token, 'kb_write_doc', { ...writeArgs, markdown: '不同的正文' }, meta('w1', 'luban')),
      'kb_idempotency_conflict',
    );
    expect(fs.existsSync(path.join(setup.state.stagingRoot, 'docs', 'docs', 'a.md'))).toBe(true);
  });

  it('分配冲突在 Leader 侧暴露（409 带持有者）；revoke 后写入被拒', async () => {
    const setup = makeV2('b-write2');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'w2', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/a.md'] });
    await expectToolError(() => call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w2', targets: ['docs/a.md'] }), 'kb_output_assignment_conflict');
    await call(setup.leader.token, 'build_revoke_output', { ownerTaskId: 'w1' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w2', targets: ['docs/a.md'] });
    const write = call(setup.child.token, 'kb_write_doc', { path: 'docs/a.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's', operationId: 'op1' }, meta('w2', 'luban'));
    await expect(write).resolves.toBeTruthy();
  });

  it('续接继承分配：新任务 ID 直接可写，旧任务写入撤销', async () => {
    const setup = makeV2('b-write3');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/a.md'] });
    setup.store.registerTaskCreation({ nativeTaskId: 'w2', parentTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.child.token, 'kb_write_doc', { path: 'docs/a.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's', operationId: 'op1' }, meta('w2', 'luban'));
    await expectToolError(
      () => call(setup.child.token, 'kb_write_doc', { path: 'docs/a.md', title: 't', markdown: 'm2', sources: ['tokA'], summary: 's', operationId: 'op2' }, meta('w1', 'luban')),
      'actor_revoked',
    );
  });

  it('kb_delete_doc 同走写入链（分配+幂等）', async () => {
    const setup = makeV2('b-del');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/a.md'] });
    await call(setup.child.token, 'kb_write_doc', { path: 'docs/a.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's', operationId: 'op1' }, meta('w1', 'luban'));
    await expectToolError(() => call(setup.child.token, 'kb_delete_doc', { path: 'docs/a.md' }, meta('w1', 'luban')), 'invalid_request');
    await call(setup.child.token, 'kb_delete_doc', { path: 'docs/a.md', operationId: 'del1' }, meta('w1', 'luban'));
    expect(fs.existsSync(path.join(setup.state.stagingRoot, 'docs', 'docs', 'a.md'))).toBe(false);
    // 幂等重放
    const replay = await call(setup.child.token, 'kb_delete_doc', { path: 'docs/a.md', operationId: 'del1' }, meta('w1', 'luban'));
    expect(replay.details!.idempotentReplay).toBe(true);
  });

  it('代次轮换后旧凭据全部失效（401 credential_generation_revoked）', async () => {
    const setup = makeV2('b-gen');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/a.md'] });
    setup.store.rotateGeneration(2, 'test');
    await expectToolError(() => call(setup.leader.token, 'build_manifest', {}), 'credential_generation_revoked');
    await expectToolError(() => call(setup.child.token, 'raw_read', { objToken: 'tokA' }, meta('w1', 'luban')), 'credential_generation_revoked');
  });
});

describe('kb_edit_doc（§7 局部编辑）', () => {
  async function writeDraftWithObject(setup: V2Setup, taskId: string): Promise<void> {
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: taskId, targets: ['docs/edit.md'] });
    // 先 raw_read 拿真实回执（证据声明 hard 约束：text_span 必须带 readReceiptId）
    const read = await call(setup.child.token, 'raw_read', { objToken: 'tokA', limit: 10 }, meta(taskId, 'luban'));
    const readReceiptId = (read.details!.readReceipts as Array<{ readReceiptId: string }>)[0]!.readReceiptId;
    const write = await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/edit.md',
      title: '编辑测试',
      markdown: '开头段\n\n## 目标节\n\n目标内容甲\n目标内容乙\n\n## 其他节\n\n别的内容\n',
      sources: ['tokA'],
      summary: '编辑前摘要',
      operationId: 'op-base',
      objects: [{
        clientKey: 'obj-main',
        type: 'concept',
        title: '主对象',
        familyKey: 'fam',
        variantKey: 'default',
        scopeKey: 'scope',
        scopeText: '范围',
        headingPath: ['目标节'],
      }],
      evidenceClaims: [{
        clientKey: 'ev-1',
        objectKey: 'obj-main',
        claimKey: 'no-claim',
        sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
        selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 },
        role: 'supports',
        nature: 'direct',
        readReceiptId,
      }],
    }, meta(taskId, 'luban'));
    expect(write.details!.objectMap).toBeTruthy();
  }

  it('draft_read 的正文与编辑哈希来自同次读取，避免并发替换混入新哈希', async () => {
    const setup = makeV2('b-read-snapshot');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    const target = path.join(setup.state.stagingRoot, 'docs', 'docs', 'edit.md');
    const expected = contentResourceHash(draftEditCoordinates(fs.readFileSync(target, 'utf-8')).paramLines.join('\n'));
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const result = await call(setup.child.token, 'draft_read', { path: 'docs/edit.md' }, meta('w1', 'luban'));
      expect(read.mock.calls.filter(([file]) => path.basename(String(file)) === 'edit.md')).toHaveLength(1);
      expect(result.details!.editContentHash).toBe(expected);
    } finally {
      read.mockRestore();
    }
  });

  it('exact_text 编辑：声明继承（objectId 稳定、坐标平移）、审查失效、幂等', async () => {
    const setup = makeV2('b-edit1');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    // 审查者在编辑后提交 → 失效旧审查
    setup.store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    const draftRead = await call(setup.child.token, 'draft_read', { path: 'docs/edit.md' }, meta('r1', 'diting'));
    const contentHash = draftRead.details!.editContentHash as string;
    const objectId = (writeDetails(setup) as { objectMap: Record<string, string> }).objectMap['obj-main'];
    // 编辑：把「目标内容乙」替换为两行
    const edit = await call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md',
      operationId: 'op-edit1',
      patches: [{ anchor: { kind: 'exact_text', oldText: '目标内容乙' }, newText: '目标内容乙-改\n追加一行' }],
    }, meta('w1', 'luban'));
    expect(edit.details!.edit).toBeTruthy();
    expect(edit.details).toMatchObject({ edit: { inheritedDeclarations: true } });
    // 正文生效
    const after = fs.readFileSync(path.join(setup.state.stagingRoot, 'docs', 'docs', 'edit.md'), 'utf-8');
    expect(after).toContain('目标内容乙-改');
    expect(after).toContain('追加一行');
    // 声明继承：objectId 稳定、平移后区间仍在正文内
    const draftFile = JSON.parse(fs.readFileSync(path.join(setup.state.stagingRoot, 'knowledge-draft.json'), 'utf-8'));
    const kept = draftFile.objects.find((o: { objectId: string }) => o.objectId === objectId);
    expect(kept).toBeTruthy();
    expect(kept.canonical.bodyRange.endLine).toBeGreaterThan(kept.canonical.bodyRange.startLine);
    // 重放
    const replay = await call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md',
      operationId: 'op-edit1',
      patches: [{ anchor: { kind: 'exact_text', oldText: '目标内容乙' }, newText: '目标内容乙-改\n追加一行' }],
    }, meta('w1', 'luban'));
    expect(replay.details!.idempotentReplay).toBe(true);
    void contentHash;
  });

  it('expectedContentHash 防漂移：草稿已变 → 结构化冲突；幂等键不漂移（排除该字段）', async () => {
    const setup = makeV2('b-edit2');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    const read1 = await call(setup.child.token, 'draft_read', { path: 'docs/edit.md' }, meta('w1', 'luban'));
    const hash1 = read1.details!.editContentHash as string;
    const patch = { anchor: { kind: 'exact_text', oldText: '目标内容甲' }, newText: '目标内容甲改' };
    // 先用旧 hash 成功提交
    const ok = await call(setup.child.token, 'kb_edit_doc', { path: 'docs/edit.md', operationId: 'op-e1', expectedContentHash: hash1, patches: [patch] }, meta('w1', 'luban'));
    expect(ok.details!.edit).toBeTruthy();
    // 再用旧 hash 编辑（内容已变）→ 冲突
    await expectToolError(
      () => call(setup.child.token, 'kb_edit_doc', { path: 'docs/edit.md', operationId: 'op-e2', expectedContentHash: hash1, patches: [patch] }, meta('w1', 'luban')),
      'kb_edit_conflict',
    );
  });

  it('锚点未命中/歧义返回结构化错误（候选信息在消息内）', async () => {
    const setup = makeV2('b-edit3');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    await expectToolError(
      () => call(setup.child.token, 'kb_edit_doc', { path: 'docs/edit.md', operationId: 'op-x', patches: [{ anchor: { kind: 'exact_text', oldText: '不存在的文本' }, newText: 'y' }] }, meta('w1', 'luban')),
      'kb_edit_anchor_not_found',
    );
    // 歧义：两处「目标内容」前缀
    await expectToolError(
      () => call(setup.child.token, 'kb_edit_doc', { path: 'docs/edit.md', operationId: 'op-y', patches: [{ anchor: { kind: 'exact_text', oldText: '目标内容' }, newText: 'z' }] }, meta('w1', 'luban')),
      'kb_edit_anchor_ambiguous',
    );
  });

  it('heading_body 与 line_range 定位；未分配路径拒绝', async () => {
    const setup = makeV2('b-edit4');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    // 分配只覆盖 docs/edit.md
    await expectToolError(
      () => call(setup.child.token, 'kb_edit_doc', { path: 'docs/other.md', operationId: 'op-o', patches: [{ anchor: { kind: 'line_range', startLine: 1, endLine: 1 }, newText: 'x' }] }, meta('w1', 'luban')),
      'not_found',
    );
    const headingEdit = await call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md',
      operationId: 'op-h1',
      patches: [{ anchor: { kind: 'heading_body', headingPath: ['其他节'] }, newText: '整节替换内容' }],
    }, meta('w1', 'luban'));
    expect(headingEdit.details).toMatchObject({ edit: { patches: [{ anchor: 'heading_body' }] } });
    const after = fs.readFileSync(path.join(setup.state.stagingRoot, 'docs', 'docs', 'edit.md'), 'utf-8');
    expect(after).toContain('整节替换内容');
    expect(after).not.toContain('别的内容');
  });

  function writeDetails(setup: V2Setup): unknown {
    const draftFile = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
    return { objectMap: Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(draftFile, 'utf-8')).clientKeys)) };
  }
});

describe('kb_read_batch（§7 批量读取）', () => {
  it('多资源一次读取：预算截断、游标续读、回执登记', async () => {
    const setup = makeV2('b-batch');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const result = await call(setup.child.token, 'kb_read_batch', {
      requests: [
        { kind: 'raw', objToken: 'tokA', limit: 5 },
        { kind: 'raw', objToken: 'tokB', limit: 5 },
      ],
      maxLines: 6,
    }, meta('w1', 'luban'));
    const body = JSON.parse(result.content[0]!.text);
    expect(body.results).toHaveLength(2);
    expect(body.linesUsed).toBeLessThanOrEqual(6);
    // tokA 截断（RAW_A > 5 行），tokB 预算剩余不足
    expect(body.results[0].truncated).toBe(true);
    expect(body.nextCursor).toBeTruthy();
    // 续读：游标携带剩余队列
    const page2 = await call(setup.child.token, 'kb_read_batch', { requests: [], cursor: body.nextCursor }, meta('w1', 'luban'));
    const body2 = JSON.parse(page2.content[0]!.text);
    expect(body2.results.length).toBeGreaterThan(0);
    // 回执已登记（供证据声明）
    const receiptsFile = path.join(setup.state.stagingRoot, 'read-receipts.jsonl');
    expect(fs.existsSync(receiptsFile)).toBe(true);
    const receipts = fs.readFileSync(receiptsFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts[0].buildId).toBe('b-batch');
  });

  it('draft 请求返回参数坐标与声明（局部编辑前置读取）', async () => {
    const setup = makeV2('b-batch2');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/b.md'] });
    await call(setup.child.token, 'kb_write_doc', { path: 'docs/b.md', title: 'T', markdown: 'a\n\n## H\n\nb\n', sources: ['tokA'], summary: 's', operationId: 'op1' }, meta('w1', 'luban'));
    const result = await call(setup.child.token, 'kb_read_batch', {
      requests: [{ kind: 'draft', path: 'docs/b.md', includeDeclarations: true }],
    }, meta('w1', 'luban'));
    const body = JSON.parse(result.content[0]!.text);
    const draft = body.results.find((item: { kind: string }) => item.kind === 'draft');
    expect(draft.coordinateBasis).toBe('param');
    expect(draft.text).toContain('## H');
    expect(draft.declarations).toBeTruthy();
  });
});

describe('审查（§4.3）与交接/问题/发布（§5）', () => {
  async function seedDraft(setup: V2Setup, taskId: string, docPath: string): Promise<void> {
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: taskId, targets: [docPath] });
    await call(setup.child.token, 'kb_write_doc', { path: docPath, title: 'T', markdown: `# 内容 ${docPath}\n正文`, sources: ['tokA'], summary: 's', operationId: `op-${docPath}` }, meta(taskId, 'luban'));
  }

  it('reviewer 提交审查：绑定 draftHash 与 ReviewReceipt；作者自审被拒；修订后审查失效', async () => {
    const setup = makeV2('b-review');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    await seedDraft(setup, 'w1', 'docs/r1.md');
    const reviewArgs = {
      coverage: { sourceRefs: ['tokA'] },
      issues: [{ draftLocation: 'docs/r1.md#L2', sourceLocation: '源A#甲节', description: '描述', severity: 'blocking' }],
      conclusion: 'needs_revision',
      operationId: 'rev-1',
    };
    // 作者自审 → 拒
    await expectToolError(() => call(setup.child.token, 'kb_submit_review', reviewArgs, meta('w1', 'luban')), 'tool_not_allowed');
    const review = await call(setup.child.token, 'kb_submit_review', reviewArgs, meta('r1', 'diting'));
    expect(review.details!.draftHash).toBeTruthy();
    expect(setup.store.listReviews()).toHaveLength(1);
    expect(setup.store.listReviews()[0]!.status).toBe('valid');
    expect(setup.store.listReviews()[0]!.dependencyHashes['doc:docs/r1.md']).toBeTruthy();
    // 作者修订（重写同路径）→ 审查失效
    await call(setup.child.token, 'kb_write_doc', { path: 'docs/r1.md', title: 'T', markdown: '修订后正文', sources: ['tokA'], summary: 's', operationId: 'op-fix1' }, meta('w1', 'luban'));
    expect(setup.store.listReviews()[0]!.status).toBe('stale');
  });

  it('交接提交/读取（子任务交、Leader 收）', async () => {
    const setup = makeV2('b-handoff');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const submit = await call(setup.child.token, 'build_handoff_submit', { operationId: 'ho-1', summary: '完成定位文档', artifactRefs: ['docs/h.md@1'], openIssues: ['公式未覆盖'] }, meta('w1', 'luban'));
    expect(submit.details!.handoffId).toBeTruthy();
    const replay = await call(setup.child.token, 'build_handoff_submit', { operationId: 'ho-1', summary: '完成定位文档', artifactRefs: ['docs/h.md@1'], openIssues: ['公式未覆盖'] }, meta('w1', 'luban'));
    expect(replay.details!.idempotentReplay).toBe(true);
    const list = await call(setup.leader.token, 'build_handoff_list', {});
    const body = JSON.parse(list.content[0]!.text);
    expect(body.handoffs).toHaveLength(1);
    expect(body.handoffs[0].role).toBe('luban');
  });

  it('问题清单：blocking 阻止发布；清零后发布管线结算 accepted；发布窗口内写入被拒', async () => {
    const seen: string[] = [];
    const setup = makeV2('b-publish', async (input: { candidateHash: string }) => {
      seen.push(input.candidateHash);
      return { accepted: true, result: { published: true } };
    });
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await seedDraft(setup, 'w1', 'docs/p1.md');
    await call(setup.leader.token, 'build_issues_submit', {
      issues: [{ issueKey: 'k1', severity: 'blocking', targetPath: 'docs/p1.md', description: '阻断问题' }],
    });
    await expectToolError(() => call(setup.leader.token, 'build_request_publish', {}), 'build_blocking_issues');
    // 清零（新 revision 无 blocking）
    await call(setup.leader.token, 'build_issues_submit', { summary: '全部修复', issues: [] });
    const issueList = await call(setup.leader.token, 'build_issues_list', {});
    expect(JSON.parse(issueList.content[0]!.text).revision).toBe(2);
    const publish = await call(setup.leader.token, 'build_request_publish', { summary: '收尾' });
    expect(publish.details!.accepted).toBe(true);
    expect(seen).toHaveLength(1);
    // 未接线场景：新构建无 handler → 501 not_wired
    const setup2 = makeV2('b-publish2');
    setup2.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await seedDraft(setup2, 'w1', 'docs/p2.md');
    await expectToolError(() => call(setup2.leader.token, 'build_request_publish', {}), 'build_publish_not_wired');
  });

  it('发布校验窗口内写入被拒（窗口由 handler 异步耗时暴露）', async () => {
    let releaseWindow: (() => void) | null = null;
    const setup = makeV2('b-window', async () => {
      await new Promise<void>((resolve) => { releaseWindow = resolve; });
      return { accepted: true, result: {} };
    });
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await seedDraft(setup, 'w1', 'docs/w1.md');
    const publishPromise = call(setup.leader.token, 'build_request_publish', {});
    // 等 handler 进入（窗口已开）
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expectToolError(
      () => call(setup.child.token, 'kb_write_doc', { path: 'docs/w1.md', title: 'T', markdown: '抢写', sources: ['tokA'], summary: 's', operationId: 'op-race' }, meta('w1', 'luban')),
      'build_publishing',
    );
    releaseWindow!();
    const publish = await publishPromise;
    expect(publish.details!.accepted).toBe(true);
    // 窗口关闭后写入恢复
    const after = await call(setup.child.token, 'kb_write_doc', { path: 'docs/w1.md', title: 'T', markdown: '窗口后写入', sources: ['tokA'], summary: 's', operationId: 'op-after' }, meta('w1', 'luban'));
    expect(after.details!.path).toBe('docs/w1.md');
  });

  it('build_checkpoint save/status', async () => {
    const setup = makeV2('b-ckpt');
    let saved = 0;
    setup.state.onCheckpoint = () => { saved += 1; };
    const save = await call(setup.leader.token, 'build_checkpoint', { action: 'save' });
    expect(save.content[0]!.text).toContain('检查点已保存');
    expect((save.details as { generation: number }).generation).toBe(1);
    expect(saved).toBe(1);
    const status = await call(setup.leader.token, 'build_checkpoint', { action: 'status' });
    expect(JSON.parse(status.content[0]!.text).buildId).toBe('b-ckpt');
  });
});

describe('§4.4 硬验收 race（Leader steer #6）：锁链 + 落盘前重检', () => {
  /** 占用声明锁（同 withKnowledgeDeclarationLock 的队列语义）：返回释放函数。 */
  async function holdDeclarationLock(target: BuildRunState): Promise<() => void> {
    let release!: () => void;
    const prior = target.knowledgeDeclarationQueue ?? Promise.resolve();
    const gate = new Promise<void>((resolve) => { release = resolve; });
    target.knowledgeDeclarationQueue = prior.then(() => gate);
    await prior;
    return release;
  }

  const draftRevisionOf = (setup: V2Setup, docPath: string): number => {
    const file = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
    if (!fs.existsSync(file)) return 0;
    const draft = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return draft.docs[docPath]?.revision ?? 0;
  };

  it('阻塞声明锁 → 取消 → 释放 → 旧写拒绝，文件与 revision 不变', async () => {
    const setup = makeV2('b-race1');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['docs/race.md'], ownerTaskId: 'w1' });
    // 基线：先写一份带声明的草稿（revision=1）
    await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/race.md', title: 'T', markdown: '基线正文', sources: ['tokA'], summary: 's', operationId: 'op-base',
      objects: [{ clientKey: 'o1', type: 'rule', title: '规则', familyKey: 'f', variantKey: 'default', scopeKey: 's', scopeText: '范围' }],
    }, meta('w1', 'luban'));
    expect(draftRevisionOf(setup, 'docs/race.md')).toBe(1);
    const beforeBytes = fs.readFileSync(path.join(setup.state.stagingRoot, 'docs', 'docs', 'race.md'));
    // 占锁 → 发起竞争写 → 排队期间取消任务 → 释放锁
    const release = await holdDeclarationLock(setup.state);
    const racing = call(setup.child.token, 'kb_write_doc', {
      path: 'docs/race.md', title: 'T', markdown: '被取消的正文', sources: ['tokA'], summary: 's', operationId: 'op-race',
    }, meta('w1', 'luban'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    setup.store.revokeActor('w1', 'cancelled');
    release();
    await expectToolError(() => racing, 'actor_revoked');
    // 文件字节与 revision 完全不变；未产生新回执
    expect(fs.readFileSync(path.join(setup.state.stagingRoot, 'docs', 'docs', 'race.md'))).toEqual(beforeBytes);
    expect(draftRevisionOf(setup, 'docs/race.md')).toBe(1);
    expect(setup.store.listReceipts().filter((receipt) => receipt.operationId === 'op-race')).toHaveLength(0);
  });

  it('阻塞声明锁 → 分配转移 → 释放 → 旧写拒绝（新持有者落盘）', async () => {
    const setup = makeV2('b-race2');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'w2', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['docs/race.md'], ownerTaskId: 'w1' });
    const release = await holdDeclarationLock(setup.state);
    const racing = call(setup.child.token, 'kb_write_doc', {
      path: 'docs/race.md', title: 'T', markdown: '旧持有者正文', sources: ['tokA'], summary: 's', operationId: 'op-old',
    }, meta('w1', 'luban'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 排队期间 Leader 收回并转移分配
    setup.store.revokeOutputs({ ownerTaskId: 'w1' });
    setup.store.assignOutputs({ targets: ['docs/race.md'], ownerTaskId: 'w2' });
    release();
    await expectToolError(() => racing, 'kb_output_owned_by_other_task');
    const file = path.join(setup.state.stagingRoot, 'docs', 'docs', 'race.md');
    expect(fs.existsSync(file)).toBe(false);
    // 新持有者正常写入
    const fresh = await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/race.md', title: 'T', markdown: '新持有者正文', sources: ['tokA'], summary: 's', operationId: 'op-new',
    }, meta('w2', 'luban'));
    expect(fresh.details!.path).toBe('docs/race.md');
  });

  it('相同 operationId 两个并发：只提交一次（一条回执，revision 只 +1）', async () => {
    const setup = makeV2('b-race3');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['docs/race.md'], ownerTaskId: 'w1' });
    const args = {
      path: 'docs/race.md', title: 'T', markdown: '并发正文', sources: ['tokA'], summary: 's', operationId: 'op-dup',
      objects: [{ clientKey: 'o1', type: 'rule', title: '规则', familyKey: 'f', variantKey: 'default', scopeKey: 's', scopeText: '范围' }],
    };
    const outcomes = await Promise.allSettled([
      call(setup.child.token, 'kb_write_doc', args, meta('w1', 'luban')),
      call(setup.child.token, 'kb_write_doc', args, meta('w1', 'luban')),
    ]);
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const results = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>).value);
    // 恰一份提交、一份幂等重放（顺序不保证）
    const replays = results.filter((result) => result.details?.idempotentReplay === true);
    expect(replays).toHaveLength(1);
    expect(setup.store.listReceipts().filter((receipt) => receipt.operationId === 'op-dup')).toHaveLength(1);
    expect(draftRevisionOf(setup, 'docs/race.md')).toBe(1);
  });

  it('回执持久化丢失（崩溃重启语义）后重放：不重复推进 draftRevision', async () => {
    const setup = makeV2('b-race4');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['docs/race.md'], ownerTaskId: 'w1' });
    const args = {
      path: 'docs/race.md', title: 'T', markdown: '唯一正文', sources: ['tokA'], summary: 's', operationId: 'op-crash',
      objects: [{ clientKey: 'o1', type: 'rule', title: '规则', familyKey: 'f', variantKey: 'default', scopeKey: 's', scopeText: '范围' }],
    };
    const first = await call(setup.child.token, 'kb_write_doc', args, meta('w1', 'luban'));
    expect(first.details!.draftRevision).toBe(1);
    // 模拟崩溃重启：回执丢失（receipts.json 清空 + 新 store 从盘 load），
    // 身份/分配从盘恢复；替换运行上下文引用的 store（白盒：集成者重建链路）
    fs.rmSync(path.join(setup.state.stagingRoot, 'build-actors', 'receipts.json'));
    const rebooted = new BuildActorStore({ buildId: setup.store.buildId, stagingRoot: setup.state.stagingRoot });
    rebooted.load();
    expect(rebooted.replayReceipt(`nonexistent`, 'x')).toBeNull(); // 回执已空
    const context = service.getContext(setup.child.token) as unknown as { options: { orchestration: { actorStore: BuildActorStore } } };
    const originalStore = context.options.orchestration.actorStore;
    context.options.orchestration.actorStore = rebooted;
    try {
      const replayed = await call(setup.child.token, 'kb_write_doc', args, meta('w1', 'luban'));
      // 声明幂等账本（calls，稳定键 v2_<task>_<op>）命中：不重复落盘、不推进
      expect(replayed.details!.draftRevision).toBe(1);
      expect(replayed.details!.idempotentReplay).toBe(true);
      expect(draftRevisionOf(setup, 'docs/race.md')).toBe(1);
    } finally {
      context.options.orchestration.actorStore = originalStore;
    }
  });
});

describe('旧模式不回归（§11）', () => {
  it('无 orchestration 的 build 上下文：旧工具集原样可用（raw_read/kb_write_doc 不需 operationId）', async () => {
    const state = makeBuildState('legacy-1');
    const legacy = service.createRunContext({ runKind: 'build', buildId: 'legacy-1', outputRoot, knowledgeBaseRoot: kbRoot, buildState: state });
    await expect(service.executeTool(legacy.token, 'raw_read', { objToken: 'tokA' })).resolves.toBeTruthy();
    const write = await service.executeTool(legacy.token, 'kb_write_doc', { path: 'docs/legacy.md', title: '旧模式', markdown: '正文', sources: ['tokA'], summary: '概要' });
    expect(write.content[0]!.text).toContain('docs/legacy.md');
    // 旧 build 白名单不含 v2 Leader 工具
    const specs = service.getToolSpecsForToken(legacy.token)!.map((spec) => spec.name);
    expect(specs).not.toContain('build_manifest');
    expect(specs).not.toContain('kb_edit_doc');
    expect(specs).toContain('kb_read_batch');
  });
});
