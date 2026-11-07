/**
 * build-runtime-toolfix-regressions.test.ts — 审核统一修复批（工具写入正确性/权限切片）
 *
 * 正式回归：F01（撤销租约）、F03（对象声明影响面授权 + family 归一化）、
 * F04（exact_text 字符区间保全）、F05（批量读取游标预算重置 + schema 二选一）、
 * F06（kb_edit_doc 锁内幂等 + 稳定声明键 + 崩溃重放）。
 *
 * 来源：独立 full 审核的最小反例（/tmp/feishu-build-v2-review/
 * behavior-probe.ts 与 object-ownership-probe.ts）只读转化为项目测试——
 * 断言方向与原反例一致（原错行为必须被拒/必须保全/必须推进），未改
 * probe 逻辑制造通过。模式：临时目录 + 手工快照（同 build-runtime-tools）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService, ToolError, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import { KB_READ_BATCH_SPEC, V2_LEADER_TOOLS } from '../src/agent/tool-specs.js';
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

const RAW_LONG = `# 长源\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\n`;

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
  return RawSourceSnapshot.fromEntries([entry('tok', 'src.md')], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] });
}

interface V2Setup {
  leader: { token: string };
  child: { token: string };
  store: BuildActorStore;
  state: BuildRunState;
}

function makeV2(stagingName: string): V2Setup {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  const store = new BuildActorStore({ buildId: stagingName, stagingRoot, generation: 1 });
  const state: BuildRunState = {
    knowledgeBaseRoot: kbRoot,
    snapshot: makeSnapshot(),
    mode: 'full',
    workset: new Map([['tok', 'added']]),
    stagingRoot,
    finishInfo: null,
    docMeta: new Map(),
    v2: { actorStore: store, generation: 1 },
  };
  const leader = service.createRunContext({
    runKind: 'build', buildId: stagingName, outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
    allowedToolsOverride: [...V2_LEADER_TOOLS],
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: 1, credential: 'leader', actorStore: store },
  });
  const child = service.createRunContext({
    runKind: 'build', buildId: stagingName, outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
    allowedToolsOverride: V2_CHILD_ALL_TOOLS,
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: 1, credential: 'child', actorStore: store },
  });
  return { leader: { token: leader.token }, child: { token: child.token }, store, state };
}

const meta = (taskId: string, agent = 'luban', toolCallId?: string) =>
  ({ amagiTaskId: taskId, amagiAgent: agent, ...(toolCallId ? { toolCallId } : {}) });
const call = (token: string, tool: string, args: Record<string, unknown>, m?: { amagiTaskId?: string; amagiAgent?: string; toolCallId?: string }) =>
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

/** 占用声明锁（与 withKnowledgeDeclarationLock 同队列语义）：返回释放函数。 */
async function holdDeclarationLock(target: BuildRunState): Promise<() => void> {
  let release!: () => void;
  const prior = target.knowledgeDeclarationQueue ?? Promise.resolve();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  target.knowledgeDeclarationQueue = prior.then(() => gate);
  await prior;
  return release;
}

const draftJson = (setup: V2Setup): Record<string, any> =>
  JSON.parse(fs.readFileSync(path.join(setup.state.stagingRoot, 'knowledge-draft.json'), 'utf-8'));

const docFile = (setup: V2Setup, docPath: string): string =>
  path.join(setup.state.stagingRoot, 'docs', docPath);

const writeDocArgs = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  path: 'x.md', title: 'T', markdown: '正文', sources: ['tok'], summary: 's', operationId: 'op', ...overrides,
});

const sharedObject = (clientKey = 'shared'): Record<string, unknown> => ({
  clientKey, type: 'rule', title: 'Rule', familyKey: 'shared-family', variantKey: 'v', scopeKey: 's', scopeText: '范围',
});

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-toolfix-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-toolfix-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-toolfix-out-'));
  fs.mkdirSync(path.join(outputRoot, 'releases'), { recursive: true });
  writeRaw('src.md', RAW_LONG);
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
});
afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

describe('v2 紧凑写入的服务端幂等键', () => {
  it('省略 operationId 的同载荷重放不推进修订，改正文生成新操作', async () => {
    const setup = makeV2('compact-auto-operation');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['x.md'], ownerTaskId: 'w1' });
    const args = {
      path: 'x.md', markdown: '## 规则\n正文', sources: ['tok'], summary: '规则说明',
      objects: [{ clientKey: 'rule', type: 'rule', title: '规则', familyKey: 'rule', scopeText: '本文规则', headingPath: ['规则'] }],
    };
    const first = await call(setup.child.token, 'kb_write_doc', args, meta('w1'));
    expect((first.details as Record<string, unknown>).draftRevision).toBe(1);
    const replay = await call(setup.child.token, 'kb_write_doc', args, meta('w1'));
    expect((replay.details as Record<string, unknown>).idempotentReplay).toBe(true);
    expect((replay.details as Record<string, unknown>).draftRevision).toBe(1);
    const changed = await call(setup.child.token, 'kb_write_doc', { ...args, markdown: '## 规则\n修订正文' }, meta('w1'));
    expect((changed.details as Record<string, unknown>).draftRevision).toBe(2);
    expect(setup.store.listReceipts().filter((receipt) => receipt.kind === 'write_doc')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F01：生产 revokeToken（非 store.revokeActor 替身）必须使在途写入失效
// ---------------------------------------------------------------------------
describe('F01 撤销租约：已持 ctx 的在途写入在最终落盘前失效', () => {
  it('revokeToken 后锁排队中的 kb_write_doc 被拒：文件/回执/revision 不变，新调用 run_token_invalid', async () => {
    const setup = makeV2('f01-token');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['x.md'], ownerTaskId: 'w1' });
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({ markdown: '基线', objects: [sharedObject('base-obj')] }), meta('w1'));
    const before = fs.readFileSync(docFile(setup, 'x.md'));
    // 占锁 → 在途写入排队 → 生产取消链 revokeToken → 释放锁
    const release = await holdDeclarationLock(setup.state);
    const racing = call(setup.child.token, 'kb_write_doc', writeDocArgs({ markdown: '取消后正文', operationId: 'op-race', objects: [sharedObject('base-obj')] }), meta('w1'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.revokeToken(setup.child.token);
    release();
    await expectToolError(() => racing, 'run_token_revoked');
    expect(fs.readFileSync(docFile(setup, 'x.md'))).toEqual(before);
    expect(setup.store.listReceipts().filter((r) => r.operationId === 'op-race')).toHaveLength(0);
    expect(draftJson(setup).docs['x.md'].revision).toBe(1);
    expect(service.getContext(setup.child.token)).toBeNull();
    await expectToolError(() => call(setup.child.token, 'raw_read', { objToken: 'tok' }, meta('w1')), 'run_token_invalid');
  });

  it('revokeByBuild 同样使在途写入失效（构建收尾/取消路径）', async () => {
    const setup = makeV2('f01-build');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['x.md'], ownerTaskId: 'w1' });
    const release = await holdDeclarationLock(setup.state);
    const racing = call(setup.child.token, 'kb_write_doc', writeDocArgs({ operationId: 'op-race' }), meta('w1'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.revokeByBuild('f01-build');
    release();
    await expectToolError(() => racing, 'run_token_revoked');
    expect(fs.existsSync(docFile(setup, 'x.md'))).toBe(false);
    expect(setup.store.listReceipts()).toHaveLength(0);
  });

  it('kb_edit_doc 在途链同样被撤销租约拦截（正文不被二次修改）', async () => {
    const setup = makeV2('f01-edit');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['x.md'], ownerTaskId: 'w1' });
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({ markdown: 'value' }), meta('w1'));
    const before = fs.readFileSync(docFile(setup, 'x.md'));
    const release = await holdDeclarationLock(setup.state);
    const racing = call(setup.child.token, 'kb_edit_doc', {
      path: 'x.md', operationId: 'op-edit',
      patches: [{ anchor: { kind: 'exact_text', oldText: 'value' }, newText: 'changed' }],
    }, meta('w1'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.revokeToken(setup.child.token);
    release();
    await expectToolError(() => racing, 'run_token_revoked');
    expect(fs.readFileSync(docFile(setup, 'x.md'))).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// F03：对象声明影响面授权（对象/族/旧 canonical 路径）；合法迁移仍可用
// ---------------------------------------------------------------------------
describe('F03 对象影响面授权与 family 归一化', () => {
  it('Leader 材料清单给出同源现有文档路径，重建时可沿用原路径', async () => {
    const { leader, state } = makeV2('manifest-existing-path');
    const doc = path.join(state.stagingRoot, 'docs', '系统框架', '旧主题.md');
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.writeFileSync(doc, '<!--\nfeishu_sync_kb:\n  doc_id: kd_existing\n  sources:\n    - tok\n  build_id: old\n-->\n# 旧主题\n正文\n');
    const result = await call(leader.token, 'build_manifest', { limit: 50 });
    const payload = JSON.parse(result.content[0]!.text!) as { entries: Array<{ objToken: string; existingDocPaths: string[] }> };
    expect(payload.entries.find((entry) => entry.objToken === 'tok')?.existingDocPaths).toEqual(['系统框架/旧主题.md']);
  });
  async function seedAuthorA(setup: V2Setup): Promise<string> {
    setup.store.registerTaskCreation({ nativeTaskId: 'a', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'b', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['a.md'], ownerTaskId: 'a' });
    setup.store.assignOutputs({ targets: ['b.md'], ownerTaskId: 'b' });
    const write = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'a.md', markdown: 'author A definition', objects: [sharedObject()],
    }), meta('a'));
    return (write.details!.objectMap as Record<string, string>)['shared']!;
  }

  it('B 仅持 b.md：用 A 的 clientKey 重申对象被拒（登记不被改写，无部分写入）', async () => {
    const setup = makeV2('f03-clientkey');
    const objectId = await seedAuthorA(setup);
    const before = fs.readFileSync(docFile(setup, 'a.md'));
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'b.md', markdown: 'author B replacement', operationId: 'op-b', objects: [sharedObject()],
    }), meta('b')), 'kb_object_not_authorized');
    // 对象登记原样：canonical 仍在 a.md、revision 不变；b.md 未产生（写入即拒）
    const draft = draftJson(setup);
    const object = draft.objects.find((o: { objectId: string }) => o.objectId === objectId);
    expect(object.canonical.path).toBe('a.md');
    expect(object.revision).toBe(1);
    expect(fs.readFileSync(docFile(setup, 'a.md'))).toEqual(before);
    expect(fs.existsSync(docFile(setup, 'b.md'))).toBe(false);
  });

  it('同 family 三元组命中（不依赖 clientKey）同样被拒', async () => {
    const setup = makeV2('f03-triple');
    const objectId = await seedAuthorA(setup);
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'b.md', markdown: 'author B replacement', operationId: 'op-b',
      objects: [{ ...sharedObject('other-key') }],
    }), meta('b')), 'kb_object_not_authorized');
    const draft = draftJson(setup);
    expect(draft.objects.find((o: { objectId: string }) => o.objectId === objectId).canonical.path).toBe('a.md');
  });

  it('合法跨路径迁移保留：Leader 显式分配 family:<familyKey> 后 B 可重申（objectId 稳定）', async () => {
    const setup = makeV2('f03-family-auth');
    const objectId = await seedAuthorA(setup);
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'b', targets: ['family:shared-family'] });
    const migrated = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'b.md', markdown: 'author B replacement', operationId: 'op-b', objects: [sharedObject()],
    }), meta('b'));
    expect((migrated.details!.objectMap as Record<string, string>)['shared']).toBe(objectId);
    const draft = draftJson(setup);
    expect(draft.objects.find((o: { objectId: string }) => o.objectId === objectId).canonical.path).toBe('b.md');
  });

  it('合法迁移（旧路径显式授权）：分配转移到 B 后可重申 A 文档上的对象', async () => {
    const setup = makeV2('f03-doc-auth');
    const objectId = await seedAuthorA(setup);
    setup.store.revokeOutputs({ ownerTaskId: 'a' });
    setup.store.assignOutputs({ targets: ['a.md'], ownerTaskId: 'b' });
    const migrated = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'a.md', markdown: 'author B rewrite', operationId: 'op-b', objects: [sharedObject()],
    }), meta('b'));
    expect((migrated.details!.objectMap as Record<string, string>)['shared']).toBe(objectId);
  });

  it('族排他：family 已分配给他人时，新对象入族与既有对象编辑重申都被拒', async () => {
    const setup = makeV2('f03-exclusive');
    setup.store.registerTaskCreation({ nativeTaskId: 'a', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'b', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['b.md'], ownerTaskId: 'b' });
    // B 先在未分配的族内声明对象（常规路径不受影响）
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'b.md', markdown: 'v1', objects: [{ ...sharedObject('kb-own'), familyKey: 'foo' }],
    }), meta('b'));
    // 族被 Leader 独占分配给 A 后：B 新对象入族被拒…
    setup.store.assignOutputs({ targets: ['foo'], targetKind: 'family', ownerTaskId: 'a' });
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'b.md', markdown: 'v2', operationId: 'op-2', objects: [{ ...sharedObject('kb-new'), familyKey: 'foo' }],
    }), meta('b')), 'kb_object_not_authorized');
    // …同路径编辑（继承声明重申 foo 族对象）同样被拒；正文不变
    const before = fs.readFileSync(docFile(setup, 'b.md'));
    await expectToolError(() => call(setup.child.token, 'kb_edit_doc', {
      path: 'b.md', operationId: 'op-3',
      patches: [{ anchor: { kind: 'exact_text', oldText: 'v1' }, newText: 'v1x' }],
    }, meta('b')), 'kb_object_not_authorized');
    expect(fs.readFileSync(docFile(setup, 'b.md'))).toEqual(before);
  });

  it('family 分配冲突归一化：两个任务不能同时持有同族（剥前缀探测修复）', async () => {
    const setup = makeV2('f03-conflict');
    setup.store.registerTaskCreation({ nativeTaskId: 'a', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'b', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'a', targets: ['family:foo'] });
    await expectToolError(() => call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'b', targets: ['family:foo'] }), 'kb_output_assignment_conflict');
    // 同 owner 重复分配同族 = 幂等更新（不冲突）
    const again = await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'a', targets: ['family:foo'] });
    expect(again.details!.targetKind).toBe('family');
  });

  it('文档分配拒绝目录前缀，避免作者持有无效目标后一直写入失败', async () => {
    const setup = makeV2('doc-path-assignment');
    setup.store.registerTaskCreation({ nativeTaskId: 'a', requestedRole: 'luban' });
    await expectToolError(() => call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'a', targets: ['系统框架/'] }), 'invalid_request');
    const assigned = await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'a', targets: ['系统框架/回合世界规则.md'] });
    expect(assigned.details!.targets).toEqual(['系统框架/回合世界规则.md']);
  });

  it('旧模式（无 orchestration）不设防：跨路径对象迁移机制原样可用', async () => {
    const stagingRoot = path.join(dataRoot, 'staging', 'f03-legacy');
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    const state: BuildRunState = {
      knowledgeBaseRoot: kbRoot, snapshot: makeSnapshot(), mode: 'full',
      workset: new Map([['tok', 'added']]), stagingRoot, finishInfo: null, docMeta: new Map(),
    };
    const legacy = service.createRunContext({ runKind: 'build', buildId: 'f03-legacy', outputRoot, knowledgeBaseRoot: kbRoot, buildState: state });
    const first = await service.executeTool(legacy.token, 'kb_write_doc', writeDocArgs({ markdown: 'A 正文', objects: [sharedObject()] }));
    const objectId = (first.details!.objectMap as Record<string, string>)['shared'];
    const second = await service.executeTool(legacy.token, 'kb_write_doc', writeDocArgs({ path: 'b.md', markdown: 'B 正文', operationId: 'op-2', objects: [sharedObject()] }));
    expect((second.details!.objectMap as Record<string, string>)['shared']).toBe(objectId);
    const draft = JSON.parse(fs.readFileSync(path.join(stagingRoot, 'knowledge-draft.json'), 'utf-8'));
    expect(draft.objects[0].canonical.path).toBe('b.md');
  });
});

// ---------------------------------------------------------------------------
// F03-R1：声明影响面授权提交期重核（增量复审 family-lease-probe 反例：
// 装配期检查通过后、最终落盘前的异步声明准备窗口内，Leader 真实
// assignOutputs/revokeOutputs 转移族/撤回旧主路径授权 → 在途提交必须拒绝）
// ---------------------------------------------------------------------------
describe('F03-R1 声明影响面授权：异步准备窗口内的分配变更被提交段拒绝', () => {
  /** 在生产 await 边界（writeDocCore 内 `await buildKnowledgeDeclaration`
   * 装配完成后、最终提交段恢复前）执行真实分配变更：只在既有异步让出点插
   * 测试动作，授权装配与终检原样执行（同增量复审 probe 的暂停口径，
   * during=真实 BuildActorStore.assignOutputs/revokeOutputs）。 */
  async function raceAtDeclarationBoundary<T>(fn: () => Promise<T>, during: () => void): Promise<T> {
    const target = service as unknown as { buildKnowledgeDeclaration: (...args: unknown[]) => Promise<unknown> };
    const original = target.buildKnowledgeDeclaration.bind(service);
    target.buildKnowledgeDeclaration = async (...args: unknown[]) => {
      const result = await original(...args);
      during();
      return result;
    };
    try {
      return await fn();
    } finally {
      target.buildKnowledgeDeclaration = original;
    }
  }

  const receiptsOf = (setup: V2Setup, operationId: string) =>
    setup.store.listReceipts().filter((receipt) => receipt.operationId === operationId);

  async function setupTwoWriters(stagingName: string): Promise<V2Setup> {
    const setup = makeV2(stagingName);
    setup.store.registerTaskCreation({ nativeTaskId: 'a', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'b', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['a.md'], ownerTaskId: 'a' });
    setup.store.assignOutputs({ targets: ['b.md'], ownerTaskId: 'b' });
    return setup;
  }

  it('kb_write_doc：族在准备窗口内被转移给他人 → 拒绝；文件/声明 revision/回执均不变（原反例场景）', async () => {
    const setup = await setupTwoWriters('f03r1-family-race');
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        path: 'a.md', markdown: 'A definition', operationId: 'op-race',
        objects: [sharedObject()],
      }), meta('a')), 'kb_object_not_authorized'),
      () => setup.store.assignOutputs({ targets: ['shared-family'], targetKind: 'family', ownerTaskId: 'b' }),
    );
    // 越权未落盘：正文未产生、无声明 revision、无回执；分配变更本身保留
    expect(fs.existsSync(docFile(setup, 'a.md'))).toBe(false);
    expect(fs.existsSync(path.join(setup.state.stagingRoot, 'knowledge-draft.json'))).toBe(false);
    expect(receiptsOf(setup, 'op-race')).toHaveLength(0);
    expect(setup.store.activeFamilyAssignmentFor('shared-family')?.ownerTaskId).toBe('b');
  });

  it('kb_write_doc：跨路径迁移的族授权在窗口内被收回 → 拒绝；旧主登记原样、无部分写入', async () => {
    const setup = await setupTwoWriters('f03r1-migration-race');
    const seeded = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'a.md', markdown: 'author A definition', objects: [sharedObject()],
    }), meta('a'));
    const objectId = (seeded.details!.objectMap as Record<string, string>)['shared']!;
    const grant = setup.store.assignOutputs({ targets: ['shared-family'], targetKind: 'family', ownerTaskId: 'b' });
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        path: 'b.md', markdown: 'author B replacement', operationId: 'op-mig', objects: [sharedObject()],
      }), meta('b')), 'kb_object_not_authorized'),
      () => setup.store.revokeOutputs({ assignmentId: grant.assignmentId }),
    );
    const draft = draftJson(setup);
    const object = draft.objects.find((o: { objectId: string }) => o.objectId === objectId);
    expect(object.canonical.path).toBe('a.md');
    expect(object.revision).toBe(1);
    expect(fs.existsSync(docFile(setup, 'b.md'))).toBe(false);
    expect(draft.docs['b.md']).toBeUndefined();
    expect(receiptsOf(setup, 'op-mig')).toHaveLength(0);
  });

  it('kb_write_doc：旧主文档授权（显式分配）在窗口内被收回 → 同样拒绝', async () => {
    const setup = await setupTwoWriters('f03r1-doc-revoke-race');
    const seeded = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'a.md', markdown: 'author A definition', objects: [sharedObject()],
    }), meta('a'));
    const objectId = (seeded.details!.objectMap as Record<string, string>)['shared']!;
    // Leader 把 a.md（旧主路径，≠本次目标 b.md）显式转移给 b：装配期跨路径
    // 迁移的合法授权通道；窗口内只收回 a.md（b.md 仍由 b 持有 → 目标文档
    // 重检通过，拦截必须来自影响面重核）。
    setup.store.revokeOutputs({ ownerTaskId: 'a' });
    const grant = setup.store.assignOutputs({ targets: ['a.md'], ownerTaskId: 'b' });
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        path: 'b.md', markdown: 'author B replacement', operationId: 'op-doc', objects: [sharedObject()],
      }), meta('b')), 'kb_object_not_authorized'),
      () => setup.store.revokeOutputs({ assignmentId: grant.assignmentId }),
    );
    const draft = draftJson(setup);
    const object = draft.objects.find((o: { objectId: string }) => o.objectId === objectId);
    expect(object.canonical.path).toBe('a.md');
    expect(object.revision).toBe(1);
    expect(fs.existsSync(docFile(setup, 'b.md'))).toBe(false);
    expect(receiptsOf(setup, 'op-doc')).toHaveLength(0);
  });

  it('kb_write_doc（含真实证据装配 await）：证据声明路径同样被提交段重核拦截', async () => {
    const setup = await setupTwoWriters('f03r1-evidence-race');
    const read = await call(setup.child.token, 'raw_read', { objToken: 'tok', offset: 0, limit: 3 }, meta('a'));
    const receipt = (read.details!.readReceipts as Array<{ readReceiptId: string; resourceId: string; lineStart: number; lineEnd: number }>)[0]!;
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        path: 'a.md', markdown: 'A definition with evidence', operationId: 'op-ev',
        objects: [sharedObject()],
        evidenceClaims: [{
          clientKey: 'ev1', objectKey: 'shared', claimKey: 'k',
          sourceRef: { sourceId: 'tok', resourceId: receipt.resourceId },
          selector: { kind: 'text_span', lineStart: receipt.lineStart, lineEnd: receipt.lineStart, colStart: 1, colEnd: 0 },
          role: 'supports', nature: 'direct', readReceiptId: receipt.readReceiptId,
        }],
      }), meta('a')), 'kb_object_not_authorized'),
      () => setup.store.assignOutputs({ targets: ['shared-family'], targetKind: 'family', ownerTaskId: 'b' }),
    );
    expect(fs.existsSync(docFile(setup, 'a.md'))).toBe(false);
    expect(fs.existsSync(path.join(setup.state.stagingRoot, 'knowledge-draft.json'))).toBe(false);
    expect(receiptsOf(setup, 'op-ev')).toHaveLength(0);
  });

  it('kb_edit_doc：继承声明重申的族在窗口内被转移 → 编辑被拒；正文/revision/回执不变', async () => {
    const setup = await setupTwoWriters('f03r1-edit-race');
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'b.md', markdown: 'v1 base', objects: [{ ...sharedObject('kb-edit'), familyKey: 'foo' }],
    }), meta('b'));
    const before = fs.readFileSync(docFile(setup, 'b.md'));
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_edit_doc', {
        path: 'b.md', operationId: 'op-edit',
        patches: [{ anchor: { kind: 'exact_text', oldText: 'base' }, newText: 'edited' }],
      }, meta('b')), 'kb_object_not_authorized'),
      () => setup.store.assignOutputs({ targets: ['foo'], targetKind: 'family', ownerTaskId: 'a' }),
    );
    expect(fs.readFileSync(docFile(setup, 'b.md'))).toEqual(before);
    expect(draftJson(setup).docs['b.md'].revision).toBe(1);
    expect(receiptsOf(setup, 'op-edit')).toHaveLength(0);
  });

  it('无冲突分配不受影响：窗口内变更无关族 → 写入正常成功（不过度拦截）', async () => {
    const setup = await setupTwoWriters('f03r1-unrelated');
    const written = await raceAtDeclarationBoundary(
      () => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        path: 'a.md', markdown: 'A definition', operationId: 'op-ok', objects: [sharedObject()],
      }), meta('a')),
      () => setup.store.assignOutputs({ targets: ['unrelated-family'], targetKind: 'family', ownerTaskId: 'b' }),
    );
    expect(written.details!.path).toBe('a.md');
    expect(fs.existsSync(docFile(setup, 'a.md'))).toBe(true);
    expect(receiptsOf(setup, 'op-ok')).toHaveLength(1);
  });

  it('合法显式授权迁移保留：窗口内族被授予写者本人 → 提交照常成功', async () => {
    const setup = await setupTwoWriters('f03r1-self-grant');
    const written = await raceAtDeclarationBoundary(
      () => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        path: 'a.md', markdown: 'A definition', operationId: 'op-grant', objects: [sharedObject()],
      }), meta('a')),
      () => setup.store.assignOutputs({ targets: ['shared-family'], targetKind: 'family', ownerTaskId: 'a' }),
    );
    expect(written.details!.path).toBe('a.md');
    expect(receiptsOf(setup, 'op-grant')).toHaveLength(1);
    expect(setup.store.activeFamilyAssignmentFor('shared-family')?.ownerTaskId).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// F04：exact_text 精确字符区间替换（行内前后缀与多行边界保全）
// ---------------------------------------------------------------------------
describe('F04 exact_text 字符区间保全', () => {
  async function setupDraft(stagingName: string, markdown: string): Promise<V2Setup> {
    const setup = makeV2(stagingName);
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['x.md'], ownerTaskId: 'w1' });
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({ markdown }), meta('w1'));
    return setup;
  }
  const bodyOf = (setup: V2Setup): string => fs.readFileSync(docFile(setup, 'x.md'), 'utf-8');

  it('行内替换保留同行 prefix/suffix（原反例：整行扩大删除）', async () => {
    const setup = await setupDraft('f04-inline', 'prefix OLD suffix\nnext line');
    const edit = await call(setup.child.token, 'kb_edit_doc', {
      path: 'x.md', operationId: 'op-e',
      patches: [{ anchor: { kind: 'exact_text', oldText: 'OLD' }, newText: 'NEW' }],
    }, meta('w1'));
    expect(edit.details!.edit.patches).toEqual([{ startLine: 1, endLine: 1, newLineCount: 1, anchor: 'exact_text' }]);
    expect(bodyOf(setup)).toContain('prefix NEW suffix');
    expect(bodyOf(setup)).toContain('next line');
    expect(bodyOf(setup)).not.toMatch(/^NEW$/m);
  });

  it('跨行命中：只删命中区间，两端的行内残余保留', async () => {
    const setup = await setupDraft('f04-multiline', 'start\nmid1 OLD2\nOLD3 end\ntail');
    const edit = await call(setup.child.token, 'kb_edit_doc', {
      path: 'x.md', operationId: 'op-e',
      patches: [{ anchor: { kind: 'exact_text', oldText: 'OLD2\nOLD3' }, newText: 'X' }],
    }, meta('w1'));
    expect(edit.details!.edit.patches).toEqual([{ startLine: 2, endLine: 3, newLineCount: 1, anchor: 'exact_text' }]);
    const body = bodyOf(setup);
    expect(body).toContain('mid1 X end');
    expect(body).toContain('start');
    expect(body).toContain('tail');
  });

  it('newText 多行展开：行内前后缀并入首尾行', async () => {
    const setup = await setupDraft('f04-expand', 'a OLD b');
    const edit = await call(setup.child.token, 'kb_edit_doc', {
      path: 'x.md', operationId: 'op-e',
      patches: [{ anchor: { kind: 'exact_text', oldText: 'OLD' }, newText: 'A\nB' }],
    }, meta('w1'));
    expect(edit.details!.edit.patches).toEqual([{ startLine: 1, endLine: 1, newLineCount: 2, anchor: 'exact_text' }]);
    expect(bodyOf(setup)).toContain('a A');
    expect(bodyOf(setup)).toContain('B b');
  });

  it('声明坐标随行内编辑正确平移（区间内加一行 → bodyRange 同步 +1）', async () => {
    const setup = makeV2('f04-decl');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['x.md'], ownerTaskId: 'w1' });
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      markdown: 'head\n\n## S\n\nline1 OLD\nline2\n\n## T\n\ntail',
      objects: [{ clientKey: 'o', type: 'rule', title: '规则', familyKey: 'f', variantKey: 'v', scopeKey: 's', scopeText: '范围', headingPath: ['S'] }],
    }), meta('w1'));
    const before = draftJson(setup).objects[0].canonical.bodyRange;
    await call(setup.child.token, 'kb_edit_doc', {
      path: 'x.md', operationId: 'op-e',
      patches: [{ anchor: { kind: 'exact_text', oldText: 'OLD' }, newText: 'X\nY' }],
    }, meta('w1'));
    const after = draftJson(setup).objects[0].canonical.bodyRange;
    expect(after.startLine).toBe(before.startLine);
    expect(after.endLine).toBe(before.endLine + 1);
  });
});

// ---------------------------------------------------------------------------
// F05：批量读取每请求预算重置、游标推进到 null、schema 二选一
// ---------------------------------------------------------------------------
describe('F05 kb_read_batch 游标预算', () => {
  it('跨预算边界多页遍历：每页预算重置、游标每页前进、最终 nextCursor=null（原反例：死游标）', async () => {
    const setup = makeV2('f05-pages');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    let cursor: string | null = null;
    const pages: Array<{ results: unknown[]; linesUsed: number; cursor: string | null }> = [];
    for (let i = 0; i < 20; i += 1) {
      const page = await call(setup.child.token, 'kb_read_batch', {
        ...(cursor ? { cursor } : { requests: [{ kind: 'raw', objToken: 'tok' }] }),
        maxLines: 3,
      }, meta('w1'));
      const body = JSON.parse(page.content[0]!.text);
      pages.push(body);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull(); // 20 行源必然在有限页内读完
    expect(pages.length).toBeGreaterThan(3);
    // 第一页之后每页都推进（原错：第二页空结果 + 相同 cursor 永久循环）
    for (const page of pages.slice(1)) {
      expect(page.results.length).toBeGreaterThan(0);
      expect(page.linesUsed).toBeGreaterThan(0);
      expect(page.linesUsed).toBeLessThanOrEqual(3);
    }
    const cursors = pages.map((page) => page.nextCursor);
    expect(new Set(cursors).size).toBe(cursors.length); // 无重复游标（无死循环）
    // 全量行按序恰好一次（offset 连续推进）
    const allText = pages.flatMap((page) => page.results.flatMap((r) => String((r as { text?: string }).text ?? '').split('\n')));
    const sourceLines = RAW_LONG.split('\n');
    const got = allText.filter((line) => line.startsWith('line ') || line === '# 长源');
    expect(got).toEqual(sourceLines.filter((line) => line.startsWith('line ') || line === '# 长源'));
  });

  it('cursor 单独续页：服务端不要求 requests 同时在场（WP-C 后 schema 不再 anyOf 二选一）', async () => {
    const setup = makeV2('f05-schema');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const schema = KB_READ_BATCH_SPEC.parameters as Record<string, unknown>;
    expect(schema.required).toBeUndefined();
    // WP-C（R5 回合开销）：anyOf 已移除——顶层单请求对象/别名改由服务端
    // normalizeToolArguments 规范化或报精确错误；schema 层二选一会把误填
    // 整回合拒在 amagi/pi 校验层（每次浪费一个完整 LLM 回合）。
    expect(schema.anyOf).toBeUndefined();
    // 服务端：仅 cursor（无 requests 键）可续页；requests+cursor 同时携带时 cursor 优先
    const first = JSON.parse((await call(setup.child.token, 'kb_read_batch', { requests: [{ kind: 'raw', objToken: 'tok' }], maxLines: 4 }, meta('w1'))).content[0]!.text);
    expect(first.nextCursor).toBeTruthy();
    const second = JSON.parse((await call(setup.child.token, 'kb_read_batch', { cursor: first.nextCursor, maxLines: 4 }, meta('w1'))).content[0]!.text);
    expect(second.results.length).toBeGreaterThan(0);
    const secondBoth = JSON.parse((await call(setup.child.token, 'kb_read_batch', { requests: [], cursor: first.nextCursor, maxLines: 4 }, meta('w1'))).content[0]!.text);
    expect(secondBoth.results.length).toBeGreaterThan(0);
  });

  it('draft 请求同样跨页推进（剩余队列/位置在 cursor 内）', async () => {
    const setup = makeV2('f05-draft');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['x.md'], ownerTaskId: 'w1' });
    const longBody = Array.from({ length: 10 }, (_, i) => `draft line ${i}`).join('\n');
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({ markdown: longBody }), meta('w1'));
    let cursor: string | null = null;
    const collected: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const page = JSON.parse((await call(setup.child.token, 'kb_read_batch', {
        ...(cursor ? { cursor } : { requests: [{ kind: 'draft', path: 'x.md' }] }),
        maxLines: 3,
      }, meta('w1'))).content[0]!.text);
      for (const result of page.results) collected.push(...String(result.text).split('\n'));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(collected).toEqual([...longBody.split('\n'), '']);
  });

  it('损坏/伪造 cursor 拒绝（invalid_request）', async () => {
    const setup = makeV2('f05-bad');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await expectToolError(() => call(setup.child.token, 'kb_read_batch', { cursor: '%%%not-json%%%' }, meta('w1')), 'invalid_request');
    const badQueue = Buffer.from(JSON.stringify({ queue: [{ kind: 'nope' }] })).toString('base64url');
    await expectToolError(() => call(setup.child.token, 'kb_read_batch', { cursor: badQueue }, meta('w1')), 'invalid_request');
    const emptyQueue = Buffer.from(JSON.stringify({ queue: [] })).toString('base64url');
    await expectToolError(() => call(setup.child.token, 'kb_read_batch', { cursor: emptyQueue }, meta('w1')), 'invalid_request');
    // 无 cursor 且无 requests → invalid_request（二选一的服务端底线）
    await expectToolError(() => call(setup.child.token, 'kb_read_batch', {}, meta('w1')), 'invalid_request');
  });
});

// ---------------------------------------------------------------------------
// F06：kb_edit_doc 并发幂等（锁内重查）+ 稳定声明键 + 崩溃重放
// ---------------------------------------------------------------------------
describe('F06 kb_edit_doc 幂等与崩溃重放', () => {
  async function setupValueDraft(stagingName: string): Promise<V2Setup> {
    const setup = makeV2(stagingName);
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['x.md'], ownerTaskId: 'w1' });
    // 携带对象声明写入：knowledge-draft.json（docs/calls 账本）落地，
    // 编辑链的声明继承与崩溃重放（calls 稳定键）才有真实载体
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({ markdown: 'value', objects: [sharedObject('seed-obj')] }), meta('w1'));
    return setup;
  }
  const editArgs = (operationId: string, oldText = 'value', newText = 'changed'): Record<string, unknown> => ({
    path: 'x.md', operationId,
    patches: [{ anchor: { kind: 'exact_text', oldText }, newText }],
  });

  it('并发同 operationId 同载荷（桥接随机 toolCallId）：一次提交 + 一份幂等重放，正文只改一次（原反例：第二个 anchor_not_found）', async () => {
    const setup = await setupValueDraft('f06-dup');
    const outcomes = await Promise.allSettled([
      call(setup.child.token, 'kb_edit_doc', editArgs('same'), meta('w1', 'luban', 'bridge-1')),
      call(setup.child.token, 'kb_edit_doc', editArgs('same'), meta('w1', 'luban', 'bridge-2')),
    ]);
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    const results = outcomes.map((o) => (o as PromiseFulfilledResult<{ details?: Record<string, unknown> }>).value);
    expect(results.filter((r) => r.details?.idempotentReplay === true)).toHaveLength(1);
    expect(setup.store.listReceipts().filter((r) => r.operationId === 'same')).toHaveLength(1);
    expect(fs.readFileSync(docFile(setup, 'x.md'), 'utf-8')).toContain('changed');
    expect(draftJson(setup).docs['x.md'].revision).toBe(2);
  });

  it('并发同 operationId 异载荷：kb_idempotency_conflict', async () => {
    const setup = await setupValueDraft('f06-conflict');
    const [first, second] = await Promise.allSettled([
      call(setup.child.token, 'kb_edit_doc', editArgs('dup', 'value', 'A'), meta('w1', 'luban', 'bridge-1')),
      call(setup.child.token, 'kb_edit_doc', editArgs('dup', 'value', 'B'), meta('w1', 'luban', 'bridge-2')),
    ]);
    const codes = [first, second].map((o) => (o.status === 'fulfilled' ? 'ok' : (o.reason as ToolError).code));
    expect(codes.filter((code) => code === 'ok')).toHaveLength(1);
    expect(codes).toContain('kb_idempotency_conflict');
    expect(fs.readFileSync(docFile(setup, 'x.md'), 'utf-8')).toMatch(/A|B/);
  });

  it('顺序不同 operationId 的非幂等补丁都生效', async () => {
    const setup = await setupValueDraft('f06-seq');
    await call(setup.child.token, 'kb_edit_doc', editArgs('e1', 'value', 'mid'), meta('w1'));
    await call(setup.child.token, 'kb_edit_doc', editArgs('e2', 'mid', 'final'), meta('w1'));
    const body = fs.readFileSync(docFile(setup, 'x.md'), 'utf-8');
    expect(body).toContain('final');
    expect(setup.store.listReceipts().filter((r) => r.kind === 'edit_doc')).toHaveLength(2);
  });

  it('v2 回执丢失（崩溃重启语义）后同键重试：经 calls 稳定键重放原结果，不重复改/不误报冲突', async () => {
    const setup = await setupValueDraft('f06-crash');
    const first = await call(setup.child.token, 'kb_edit_doc', editArgs('op-edit', 'value', 'changed'), meta('w1', 'luban', 'bridge-1'));
    expect(first.details!.edit).toBeTruthy();
    const afterEdit = fs.readFileSync(docFile(setup, 'x.md'), 'utf-8');
    // 崩溃语义：回执账本丢失（receipts.json 未持久），身份/分配从盘恢复
    fs.rmSync(path.join(setup.state.stagingRoot, 'build-actors', 'receipts.json'));
    const rebooted = new BuildActorStore({ buildId: setup.store.buildId, stagingRoot: setup.state.stagingRoot });
    rebooted.load();
    const context = service.getContext(setup.child.token) as unknown as { options: { orchestration: { actorStore: BuildActorStore } } };
    const originalStore = context.options.orchestration.actorStore;
    context.options.orchestration.actorStore = rebooted;
    try {
      // 重试携带同载荷（含原编辑基准 expectedContentHash 语义由内容锚点承载）；
      // calls 条目在原子落盘时记录了可核验的 payloadHash
      const callEntry = draftJson(setup).calls['v2_w1_op-edit'];
      expect(typeof callEntry.payloadHash).toBe('string');
      const replayed = await call(setup.child.token, 'kb_edit_doc', editArgs('op-edit', 'value', 'changed'), meta('w1', 'luban', 'bridge-9'));
      expect(replayed.details!.idempotentReplay).toBe(true);
      expect(fs.readFileSync(docFile(setup, 'x.md'), 'utf-8')).toBe(afterEdit);
      expect(draftJson(setup).docs['x.md'].revision).toBe(2);
    } finally {
      context.options.orchestration.actorStore = originalStore;
    }
  });

  it('回执丢失后同键异载荷（改 patch）：kb_idempotency_conflict，正文/声明/revision 不变（不得假成功）', async () => {
    const setup = await setupValueDraft('f06-crash-patch');
    await call(setup.child.token, 'kb_edit_doc', editArgs('op-edit', 'value', 'changed'), meta('w1'));
    const afterEdit = fs.readFileSync(docFile(setup, 'x.md'), 'utf-8');
    const afterDraft = JSON.stringify(draftJson(setup));
    fs.rmSync(path.join(setup.state.stagingRoot, 'build-actors', 'receipts.json'));
    const rebooted = new BuildActorStore({ buildId: setup.store.buildId, stagingRoot: setup.state.stagingRoot });
    rebooted.load();
    const context = service.getContext(setup.child.token) as unknown as { options: { orchestration: { actorStore: BuildActorStore } } };
    const originalStore = context.options.orchestration.actorStore;
    context.options.orchestration.actorStore = rebooted;
    try {
      await expectToolError(
        () => call(setup.child.token, 'kb_edit_doc', editArgs('op-edit', 'value', 'EVIL-REWRITE'), meta('w1')),
        'kb_idempotency_conflict',
      );
      // 正文/声明账本/revision 完全不变（冲突在核验点拦截，未触盘）
      expect(fs.readFileSync(docFile(setup, 'x.md'), 'utf-8')).toBe(afterEdit);
      expect(JSON.stringify(draftJson(setup))).toBe(afterDraft);
      expect(draftJson(setup).docs['x.md'].revision).toBe(2);
      expect(rebooted.listReceipts().filter((r) => r.operationId === 'op-edit')).toHaveLength(0);
    } finally {
      context.options.orchestration.actorStore = originalStore;
    }
  });

  it('回执丢失后同键异载荷（改 path）：同样 kb_idempotency_conflict', async () => {
    const setup = await setupValueDraft('f06-crash-path');
    setup.store.assignOutputs({ targets: ['y.md'], ownerTaskId: 'w1' });
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({ path: 'y.md', markdown: 'y 正文', operationId: 'op-y', objects: [{ clientKey: 'y-obj', type: 'rule', title: 'Y 规则', familyKey: 'y-fam', variantKey: 'v', scopeKey: 's', scopeText: '范围' }] }), meta('w1'));
    await call(setup.child.token, 'kb_edit_doc', editArgs('op-edit', 'value', 'changed'), meta('w1'));
    const afterDraft = JSON.stringify(draftJson(setup));
    fs.rmSync(path.join(setup.state.stagingRoot, 'build-actors', 'receipts.json'));
    const rebooted = new BuildActorStore({ buildId: setup.store.buildId, stagingRoot: setup.state.stagingRoot });
    rebooted.load();
    const context = service.getContext(setup.child.token) as unknown as { options: { orchestration: { actorStore: BuildActorStore } } };
    const originalStore = context.options.orchestration.actorStore;
    context.options.orchestration.actorStore = rebooted;
    try {
      await expectToolError(
        () => call(setup.child.token, 'kb_edit_doc', {
          path: 'y.md', operationId: 'op-edit',
          patches: [{ anchor: { kind: 'exact_text', oldText: 'y 正文' }, newText: '被夺取的编辑' }],
        }, meta('w1')),
        'kb_idempotency_conflict',
      );
      expect(JSON.stringify(draftJson(setup))).toBe(afterDraft);
      expect(fs.readFileSync(docFile(setup, 'y.md'), 'utf-8')).toContain('y 正文');
    } finally {
      context.options.orchestration.actorStore = originalStore;
    }
  });

  it('旧账本缺 payloadHash（旧代次写入）：明确拒绝不盲重放（kb_idempotency_unverifiable）', async () => {
    const setup = await setupValueDraft('f06-old-ledger');
    await call(setup.child.token, 'kb_edit_doc', editArgs('op-edit', 'value', 'changed'), meta('w1'));
    const afterEdit = fs.readFileSync(docFile(setup, 'x.md'), 'utf-8');
    // 模拟本修复前的旧代次账本：剥离 payloadHash 字段 + 回执丢失
    const draftPath = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
    const raw = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
    delete raw.calls['v2_w1_op-edit'].payloadHash;
    fs.writeFileSync(draftPath, JSON.stringify(raw), 'utf-8');
    setup.state.knowledgeDraft = undefined; // 丢弃内存缓存，从盘重读旧形状
    fs.rmSync(path.join(setup.state.stagingRoot, 'build-actors', 'receipts.json'));
    const rebooted = new BuildActorStore({ buildId: setup.store.buildId, stagingRoot: setup.state.stagingRoot });
    rebooted.load();
    const context = service.getContext(setup.child.token) as unknown as { options: { orchestration: { actorStore: BuildActorStore } } };
    const originalStore = context.options.orchestration.actorStore;
    context.options.orchestration.actorStore = rebooted;
    try {
      await expectToolError(
        () => call(setup.child.token, 'kb_edit_doc', editArgs('op-edit', 'value', 'changed'), meta('w1')),
        'kb_idempotency_unverifiable',
      );
      expect(fs.readFileSync(docFile(setup, 'x.md'), 'utf-8')).toBe(afterEdit);
      expect(draftJson(setup).docs['x.md'].revision).toBe(2);
    } finally {
      context.options.orchestration.actorStore = originalStore;
    }
  });

  it('write 侧同类缺口：kb_write_doc 回执丢失后同键异载荷 → kb_idempotency_conflict，正文/revision 不变', async () => {
    const setup = makeV2('f06-write-crash');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['x.md'], ownerTaskId: 'w1' });
    const args = writeDocArgs({ markdown: '唯一正文', objects: [sharedObject('w-obj')] });
    await call(setup.child.token, 'kb_write_doc', args, meta('w1'));
    const afterWrite = fs.readFileSync(docFile(setup, 'x.md'), 'utf-8');
    fs.rmSync(path.join(setup.state.stagingRoot, 'build-actors', 'receipts.json'));
    const rebooted = new BuildActorStore({ buildId: setup.store.buildId, stagingRoot: setup.state.stagingRoot });
    rebooted.load();
    const context = service.getContext(setup.child.token) as unknown as { options: { orchestration: { actorStore: BuildActorStore } } };
    const originalStore = context.options.orchestration.actorStore;
    context.options.orchestration.actorStore = rebooted;
    try {
      await expectToolError(
        () => call(setup.child.token, 'kb_write_doc', writeDocArgs({ markdown: '被改写的重试载荷', objects: [sharedObject('w-obj')] }), meta('w1')),
        'kb_idempotency_conflict',
      );
      expect(fs.readFileSync(docFile(setup, 'x.md'), 'utf-8')).toBe(afterWrite);
      expect(draftJson(setup).docs['x.md'].revision).toBe(1);
      // 同载荷重试仍安全重放（不重复落盘、不推进）
      const replayed = await call(setup.child.token, 'kb_write_doc', args, meta('w1'));
      expect(replayed.details!.idempotentReplay).toBe(true);
      expect(draftJson(setup).docs['x.md'].revision).toBe(1);
    } finally {
      context.options.orchestration.actorStore = originalStore;
    }
  });
});
