/**
 * build-runtime-authority-impact.test.ts — R2-F03-01（完整授权影响面）正式回归
 *
 * 来源：R2 full Gate（r2-review-report.md §3 R2-F03-01）两个独立反例
 * r2-review-evidence/authority-probe.mts（change-prior-family：同路径重申
 * 移出旧族）与 authority-delete-probe.mts（remove-objects：objects:[]
 * 删除旧族对象）只读转化为项目测试——断言方向与原反例一致（原错行为
 * 必须被拒），未改 probe 逻辑制造通过；并补齐任务要求的完整影响面：
 * 旧族 await 窗口转让 race（冻结集含旧族+新族）、kb_delete_doc 授权门、
 * 显式授权的合法移族/删除/迁移正例（不靠禁用功能解决）。
 *
 * 判据（与装配期/提交期一致）：同路径移出旧族、未重申删除对象、kb_delete_doc
 * 移除规范主位，都改写旧族对象面——旧族活动持有人必须为空或本人；Doc
 * 写权不覆盖 Family 排他。旧模式（无 orchestration）不设防，既有用例覆盖。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService, ToolError, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
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
  const child = service.createRunContext({
    runKind: 'build', buildId: stagingName, outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
    allowedToolsOverride: V2_CHILD_ALL_TOOLS,
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: 1, credential: 'child', actorStore: store },
  });
  return { child: { token: child.token }, store, state };
}

const meta = (taskId: string, agent = 'luban') => ({ amagiTaskId: taskId, amagiAgent: agent });
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

const draftJson = (setup: V2Setup): Record<string, any> =>
  JSON.parse(fs.readFileSync(path.join(setup.state.stagingRoot, 'knowledge-draft.json'), 'utf-8'));

const docFile = (setup: V2Setup, docPath: string): string =>
  path.join(setup.state.stagingRoot, 'docs', docPath);

const writeDocArgs = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  path: 'a.md', title: 'A', markdown: 'A definition', sources: ['tok'], summary: 's', operationId: 'op', ...overrides,
});

/** 与原反例同形状的对象声明（authority-probe 的 obj）。 */
const familyObject = (clientKey: string, familyKey: string): Record<string, unknown> => ({
  clientKey, type: 'rule', title: 'Rule', familyKey, variantKey: 'v', scopeKey: 's', scopeText: 'scope',
});

/** 在生产 await 边界（buildKnowledgeDeclaration 装配完成后、最终提交段
 * 恢复前）执行真实分配变更——只在既有异步让出点插测试动作，授权装配与
 * 终检原样执行（同 build-runtime-toolfix-regressions 的 F03-R1 口径）。 */
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

/** 基线：a/b 双写者（a.md/b.md 各自分配）；A 在 a.md 登记对象（族
 * familyKey），返回 objectId。 */
async function seed(setup: V2Setup, familyKey: string, clientKey = 'obj'): Promise<string> {
  setup.store.registerTaskCreation({ nativeTaskId: 'a', requestedRole: 'luban' });
  setup.store.registerTaskCreation({ nativeTaskId: 'b', requestedRole: 'luban' });
  setup.store.assignOutputs({ targets: ['a.md'], ownerTaskId: 'a' });
  setup.store.assignOutputs({ targets: ['b.md'], ownerTaskId: 'b' });
  const write = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
    objects: [familyObject(clientKey, familyKey)],
  }), meta('a'));
  return (write.details!.objectMap as Record<string, string>)[clientKey]!;
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-authority-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-authority-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-authority-out-'));
  fs.mkdirSync(path.join(outputRoot, 'releases'), { recursive: true });
  writeRaw('src.md', '# 源\nsource body\n');
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
});
afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

describe('R2-F03-01 完整授权影响面：旧族移出/删除/await 竞态/kb_delete_doc', () => {
  it('change-prior-family 原反例（authority-probe）：同路径重申移出旧族 → 拒绝；登记/正文/回执不变', async () => {
    const setup = makeV2('f0301-move-out');
    const objectId = await seed(setup, 'family-owned-by-b');
    setup.store.assignOutputs({ targets: ['family-owned-by-b'], targetKind: 'family', ownerTaskId: 'b' });
    const before = fs.readFileSync(docFile(setup, 'a.md'));
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-move', objects: [familyObject('obj', 'unassigned-new-family')],
    }), meta('a')), 'kb_object_not_authorized');
    // 对象登记原样：仍在旧族、canonical 不变、revision 不变；正文不变；无回执
    const draft = draftJson(setup);
    const object = draft.objects.find((o: { objectId: string }) => o.objectId === objectId);
    expect(object.familyKey).toBe('family-owned-by-b');
    expect(object.canonical.path).toBe('a.md');
    expect(object.revision).toBe(1);
    expect(draft.docs['a.md'].revision).toBe(1);
    expect(fs.readFileSync(docFile(setup, 'a.md'))).toEqual(before);
    expect(receiptsOf(setup, 'op-move')).toHaveLength(0);
  });

  it('remove-objects 原反例（authority-delete-probe·独立场景）：objects:[] 删除旧族对象 → 拒绝', async () => {
    const setup = makeV2('f0301-remove-all');
    const objectId = await seed(setup, 'family-owned-by-b');
    // 独立场景：不先移族，直接把族独占给 B 后用 objects:[] 整体删除
    setup.store.assignOutputs({ targets: ['family-owned-by-b'], targetKind: 'family', ownerTaskId: 'b' });
    const before = fs.readFileSync(docFile(setup, 'a.md'));
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-remove', objects: [],
    }), meta('a')), 'kb_object_not_authorized');
    const draft = draftJson(setup);
    expect(draft.objects).toHaveLength(1);
    expect(draft.objects[0].objectId).toBe(objectId);
    expect(draft.objects[0].familyKey).toBe('family-owned-by-b');
    expect(draft.clientKeys['obj']).toBe(objectId);
    expect(draft.docs['a.md'].revision).toBe(1);
    expect(fs.readFileSync(docFile(setup, 'a.md'))).toEqual(before);
    expect(receiptsOf(setup, 'op-remove')).toHaveLength(0);
  });

  it('旧族 await 窗口内被转让（移出场景）：装配期未分配 → 提交段拒绝（旧族在冻结集合内）', async () => {
    const setup = makeV2('f0301-race-move-out');
    const objectId = await seed(setup, 'old-family');
    const before = fs.readFileSync(docFile(setup, 'a.md'));
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        operationId: 'op-race', objects: [familyObject('obj', 'new-family')],
      }), meta('a')), 'kb_object_not_authorized'),
      () => setup.store.assignOutputs({ targets: ['old-family'], targetKind: 'family', ownerTaskId: 'b' }),
    );
    const draft = draftJson(setup);
    expect(draft.objects.find((o: { objectId: string }) => o.objectId === objectId).familyKey).toBe('old-family');
    expect(draft.docs['a.md'].revision).toBe(1);
    expect(fs.readFileSync(docFile(setup, 'a.md'))).toEqual(before);
    expect(receiptsOf(setup, 'op-race')).toHaveLength(0);
  });

  it('旧族 await 窗口内被转让（objects:[] 删除场景）：提交段拒绝', async () => {
    const setup = makeV2('f0301-race-remove');
    const objectId = await seed(setup, 'old-family');
    const before = fs.readFileSync(docFile(setup, 'a.md'));
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        operationId: 'op-race', objects: [],
      }), meta('a')), 'kb_object_not_authorized'),
      () => setup.store.assignOutputs({ targets: ['old-family'], targetKind: 'family', ownerTaskId: 'b' }),
    );
    const draft = draftJson(setup);
    expect(draft.objects).toHaveLength(1);
    expect(draft.objects[0].objectId).toBe(objectId);
    expect(fs.readFileSync(docFile(setup, 'a.md'))).toEqual(before);
    expect(receiptsOf(setup, 'op-race')).toHaveLength(0);
  });

  it('移出场景的完整冻结集合：新族在窗口内被转让 → 同样拒绝（不只旧族）', async () => {
    const setup = makeV2('f0301-race-new-family');
    const objectId = await seed(setup, 'old-family');
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        operationId: 'op-race', objects: [familyObject('obj', 'target-family')],
      }), meta('a')), 'kb_object_not_authorized'),
      () => setup.store.assignOutputs({ targets: ['target-family'], targetKind: 'family', ownerTaskId: 'b' }),
    );
    const draft = draftJson(setup);
    expect(draft.objects.find((o: { objectId: string }) => o.objectId === objectId).familyKey).toBe('old-family');
    expect(receiptsOf(setup, 'op-race')).toHaveLength(0);
  });

  it('合法移族正例：旧族未分配 → 移出成功（objectId 稳定、族更新）；objects:[] 删除成功（登记清理）', async () => {
    const setup = makeV2('f0301-legit-unassigned');
    const objectId = await seed(setup, 'free-family');
    // 旧族未分配：同路径移出到新族照常可用（不禁用功能）
    const moved = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-move', objects: [familyObject('obj', 'moved-family')],
    }), meta('a'));
    expect((moved.details!.objectMap as Record<string, string>)['obj']).toBe(objectId);
    const afterMove = draftJson(setup);
    expect(afterMove.objects.find((o: { objectId: string }) => o.objectId === objectId).familyKey).toBe('moved-family');
    // 未分配族的 objects:[] 删除同样照常（常规重写不重申对象的既有路径）
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-remove', objects: [],
    }), meta('a'));
    const afterRemove = draftJson(setup);
    expect(afterRemove.objects).toHaveLength(0);
    expect(afterRemove.clientKeys['obj']).toBeUndefined();
    expect(receiptsOf(setup, 'op-remove')).toHaveLength(1);
  });

  it('合法移族正例：旧族归写者本人（装配期已持有）→ 移出成功', async () => {
    const setup = makeV2('f0301-legit-self');
    const objectId = await seed(setup, 'own-family');
    setup.store.assignOutputs({ targets: ['own-family'], targetKind: 'family', ownerTaskId: 'a' });
    const moved = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-move', objects: [familyObject('obj', 'another-family')],
    }), meta('a'));
    expect((moved.details!.objectMap as Record<string, string>)['obj']).toBe(objectId);
    expect(draftJson(setup).objects.find((o: { objectId: string }) => o.objectId === objectId).familyKey).toBe('another-family');
  });

  it('合法授权竞态正例：旧族在窗口内授予写者本人 → 提交照常成功（显式授权迁移保留）', async () => {
    const setup = makeV2('f0301-legit-race');
    const objectId = await seed(setup, 'granted-family');
    const moved = await raceAtDeclarationBoundary(
      () => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        operationId: 'op-move', objects: [familyObject('obj', 'final-family')],
      }), meta('a')),
      () => setup.store.assignOutputs({ targets: ['granted-family'], targetKind: 'family', ownerTaskId: 'a' }),
    );
    expect((moved.details!.objectMap as Record<string, string>)['obj']).toBe(objectId);
    expect(draftJson(setup).objects.find((o: { objectId: string }) => o.objectId === objectId).familyKey).toBe('final-family');
    expect(receiptsOf(setup, 'op-move')).toHaveLength(1);
  });

  it('kb_delete_doc：文档登记他族独占对象 → 拒绝；文件保留、无回执', async () => {
    const setup = makeV2('f0301-delete-held');
    const objectId = await seed(setup, 'family-owned-by-b');
    setup.store.assignOutputs({ targets: ['family-owned-by-b'], targetKind: 'family', ownerTaskId: 'b' });
    await expectToolError(() => call(setup.child.token, 'kb_delete_doc', {
      path: 'a.md', operationId: 'op-del',
    }, meta('a')), 'kb_object_not_authorized');
    expect(fs.existsSync(docFile(setup, 'a.md'))).toBe(true);
    expect(draftJson(setup).objects.find((o: { objectId: string }) => o.objectId === objectId).canonical.path).toBe('a.md');
    expect(receiptsOf(setup, 'op-del')).toHaveLength(0);
  });

  it('kb_delete_doc 正例：族未分配 → 删除成功；族归本人 → 删除成功', async () => {
    const setup = makeV2('f0301-delete-ok');
    await seed(setup, 'free-family');
    await call(setup.child.token, 'kb_delete_doc', { path: 'a.md', operationId: 'op-del-1' }, meta('a'));
    expect(fs.existsSync(docFile(setup, 'a.md'))).toBe(false);
    expect(receiptsOf(setup, 'op-del-1')).toHaveLength(1);
    // 族归删除者本人：Doc 与 Family 权利同源，放行
    const setup2 = makeV2('f0301-delete-self');
    await seed(setup2, 'own-family');
    setup2.store.assignOutputs({ targets: ['own-family'], targetKind: 'family', ownerTaskId: 'a' });
    await call(setup2.child.token, 'kb_delete_doc', { path: 'a.md', operationId: 'op-del-2' }, meta('a'));
    expect(fs.existsSync(docFile(setup2, 'a.md'))).toBe(false);
    expect(receiptsOf(setup2, 'op-del-2')).toHaveLength(1);
  });

  it('kb_edit_doc 继承声明正例：族归写者本人时改写正文成功（对象经同一影响面放行，revision+1）', async () => {
    const setup = makeV2('f0301-edit-self');
    const objectId = await seed(setup, 'own-family');
    setup.store.assignOutputs({ targets: ['own-family'], targetKind: 'family', ownerTaskId: 'a' });
    await call(setup.child.token, 'kb_edit_doc', {
      path: 'a.md', operationId: 'op-edit',
      patches: [{ anchor: { kind: 'exact_text', oldText: 'A definition' }, newText: 'A definition (revised)' }],
    }, meta('a'));
    const object = draftJson(setup).objects.find((o: { objectId: string }) => o.objectId === objectId);
    expect(object.familyKey).toBe('own-family');
    expect(object.revision).toBe(2); // 正文变化 → 重申对象载荷变化 → revision+1
    expect(receiptsOf(setup, 'op-edit')).toHaveLength(1);
  });
});

describe('R2-F03-01 补强（Leader steer）：基线漂移守卫与影响面补充形态', () => {
  /** 在装配 await 窗口内模拟绕过声明锁的登记写者：直接改盘并同步内存登记
   * （saveKnowledgeDraft 同语义，但不经 withKnowledgeDeclarationLock）。
   * 声明锁内的合法写者不可能出现在此窗口——本组用例证明漂移守卫不依赖
   * 锁的完备性，绕锁漂移也不会被整包保存覆盖。 */
  const driftDraftDuringWindow = (setup: V2Setup, mutate: (draft: Record<string, any>) => void): (() => void) => {
    return () => {
      const file = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
      const current = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, any>;
      mutate(current);
      fs.writeFileSync(file, JSON.stringify(current));
      setup.state.knowledgeDraft = current as never;
    };
  };

  it('旧基线漂移：装配 await 期间登记被绕锁写者修改 → 提交拒绝；他人变更保留、正文/回执无变化', async () => {
    const setup = makeV2('f0301-drift');
    const objectId = await seed(setup, 'free-family');
    const before = fs.readFileSync(docFile(setup, 'a.md'));
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        operationId: 'op-drift', objects: [familyObject('obj', 'free-family')],
      }), meta('a')), 'kb_declaration_baseline_drifted'),
      driftDraftDuringWindow(setup, (draft) => {
        draft.objects.push({
          objectId: 'ko_intruder', type: 'rule', title: 'Intruder', aliases: [], domainIds: [],
          familyKey: 'intruder-family', variantKey: 'v', scopeKey: 's', scopeText: 'scope',
          canonical: { docId: 'kd_x', path: 'b.md', anchor: 'ko_intruder', bodyRange: { startLine: 1, endLine: 1 } },
          revision: 1, locationRevision: 0, payloadHash: 'h', reviewSubjectHash: 'h',
          businessStatus: 'unknown', reviewStatus: 'pending', claims: [],
        });
      }),
    );
    // 他人登记保留（未被本次整包保存覆盖）；本次正文/回执/revision 无变化
    const draft = draftJson(setup);
    expect(draft.objects.some((o: { objectId: string }) => o.objectId === 'ko_intruder')).toBe(true);
    expect(draft.objects.find((o: { objectId: string }) => o.objectId === objectId).familyKey).toBe('free-family');
    expect(draft.docs['a.md'].revision).toBe(1);
    expect(fs.readFileSync(docFile(setup, 'a.md'))).toEqual(before);
    expect(receiptsOf(setup, 'op-drift')).toHaveLength(0);
  });

  it('基线漂移不依赖族分配：未分配族场景同样拒绝（守卫与授权面正交）', async () => {
    const setup = makeV2('f0301-drift-noassign');
    await seed(setup, 'free-family');
    await raceAtDeclarationBoundary(
      () => expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
        operationId: 'op-drift', objects: [],
      }), meta('a')), 'kb_declaration_baseline_drifted'),
      driftDraftDuringWindow(setup, (draft) => {
        draft.objects[0].title = '被绕锁写者改过的标题';
      }),
    );
    expect(draftJson(setup).objects[0].title).toBe('被绕锁写者改过的标题');
    expect(receiptsOf(setup, 'op-drift')).toHaveLength(0);
  });

  it('删除部分：同文档两对象分属两族，只重申其一 → 未重申对象按删除面核族；正例照常', async () => {
    // 负例：dropped 族被他人独占 → 拒绝（删除面，非声明面）
    const setup = makeV2('f0301-partial-del');
    setup.store.registerTaskCreation({ nativeTaskId: 'a', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'b', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['a.md'], ownerTaskId: 'a' });
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-seed',
      objects: [familyObject('keep', 'keep-family'), familyObject('drop', 'drop-family')],
    }), meta('a'));
    setup.store.assignOutputs({ targets: ['drop-family'], targetKind: 'family', ownerTaskId: 'b' });
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-partial', objects: [familyObject('keep', 'keep-family')],
    }), meta('a')), 'kb_object_not_authorized');
    expect(draftJson(setup).objects).toHaveLength(2);
    expect(receiptsOf(setup, 'op-partial')).toHaveLength(0);
    // 正例：dropped 族未分配 → 部分删除照常
    const setup2 = makeV2('f0301-partial-ok');
    setup2.store.registerTaskCreation({ nativeTaskId: 'a', requestedRole: 'luban' });
    setup2.store.assignOutputs({ targets: ['a.md'], ownerTaskId: 'a' });
    await call(setup2.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-seed',
      objects: [familyObject('keep', 'keep-family'), familyObject('drop', 'drop-family')],
    }), meta('a'));
    await call(setup2.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-partial', objects: [familyObject('keep', 'keep-family')],
    }), meta('a'));
    const draft = draftJson(setup2);
    expect(draft.objects).toHaveLength(1);
    expect(draft.objects[0].familyKey).toBe('keep-family');
    expect(draft.clientKeys['drop']).toBeUndefined();
  });

  it('跨path同时改族：即使旧新Doc均归本人，也不能移出他人的旧族', async () => {
    const setup = makeV2('f0301-cross-old-family');
    const objectId = await seed(setup, 'old-family');
    setup.store.assignOutputs({ targets: ['c.md'], ownerTaskId: 'a' });
    setup.store.assignOutputs({ targets: ['old-family'], targetKind: 'family', ownerTaskId: 'b' });
    const before = fs.readFileSync(docFile(setup, 'a.md'));
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'c.md', operationId: 'cross-with-old-doc', objects: [familyObject('obj', 'new-family')],
    }), meta('a')), 'kb_object_not_authorized');
    expect(fs.existsSync(docFile(setup, 'c.md'))).toBe(false);
    expect(fs.readFileSync(docFile(setup, 'a.md'))).toEqual(before);
    expect(receiptsOf(setup, 'cross-with-old-doc')).toHaveLength(0);
    setup.store.revokeOutputs({ ownerTaskId: 'b' });
    setup.store.assignOutputs({ targets: ['old-family'], targetKind: 'family', ownerTaskId: 'a' });
    await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'c.md', operationId: 'authorized-cross', objects: [familyObject('obj', 'new-family')],
    }), meta('a'));
    const moved = draftJson(setup).objects.find((o: { objectId: string }) => o.objectId === objectId);
    expect(moved.familyKey).toBe('new-family');
    expect(moved.canonical.path).toBe('c.md');
  });

  it('跨path+改族：未授权拒绝；族通道显式授权后迁移+改族成功（旧canonical/旧族/新族全入面）', async () => {
    // B 先在 b.md 登记对象（族 src-family）
    const setup = makeV2('f0301-cross-move');
    setup.store.registerTaskCreation({ nativeTaskId: 'a', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'b', requestedRole: 'luban' });
    setup.store.assignOutputs({ targets: ['a.md'], ownerTaskId: 'a' });
    setup.store.assignOutputs({ targets: ['b.md'], ownerTaskId: 'b' });
    const write = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      path: 'b.md', operationId: 'op-seed', objects: [familyObject('shared', 'src-family')],
    }), meta('b'));
    const objectId = (write.details!.objectMap as Record<string, string>)['shared']!;
    // A 在 a.md 跨路径重申同时改族 → 未持 b.md 也未持 src-family → 拒绝
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-cross', objects: [familyObject('shared', 'dst-family')],
    }), meta('a')), 'kb_object_not_authorized');
    expect(draftJson(setup).objects.find((o: { objectId: string }) => o.objectId === objectId).canonical.path).toBe('b.md');
    // Leader 显式授权（族通道）：src-family → a 后迁移+改族成功
    setup.store.assignOutputs({ targets: ['src-family'], targetKind: 'family', ownerTaskId: 'a' });
    const migrated = await call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-cross-2', objects: [familyObject('shared', 'dst-family')],
    }), meta('a'));
    expect((migrated.details!.objectMap as Record<string, string>)['shared']).toBe(objectId);
    const object = draftJson(setup).objects.find((o: { objectId: string }) => o.objectId === objectId);
    expect(object.canonical.path).toBe('a.md');
    expect(object.familyKey).toBe('dst-family');
  });

  it('clientKey 重绑定：旧键丢弃改用新键+新族 → 旧族对象按删除面拒绝；正例照常', async () => {
    const setup = makeV2('f0301-rebind');
    const objectId = await seed(setup, 'old-bound-family');
    setup.store.assignOutputs({ targets: ['old-bound-family'], targetKind: 'family', ownerTaskId: 'b' });
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-rebind', objects: [familyObject('fresh-key', 'fresh-family')],
    }), meta('a')), 'kb_object_not_authorized');
    const draft = draftJson(setup);
    expect(draft.objects).toHaveLength(1);
    expect(draft.objects[0].objectId).toBe(objectId);
    expect(draft.clientKeys['obj']).toBe(objectId);
    expect(receiptsOf(setup, 'op-rebind')).toHaveLength(0);
    // 正例：旧族未分配时重绑定照常（旧对象移除、新键登记）
    const setup2 = makeV2('f0301-rebind-ok');
    await seed(setup2, 'old-bound-family');
    await call(setup2.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-rebind', objects: [familyObject('fresh-key', 'fresh-family')],
    }), meta('a'));
    const draft2 = draftJson(setup2);
    expect(draft2.objects).toHaveLength(1);
    expect(draft2.objects[0].familyKey).toBe('fresh-family');
    expect(draft2.clientKeys['fresh-key']).toBe(draft2.objects[0].objectId);
  });

  it('objects 省略/[]/非空三态不混同：省略走 registry_stale 门禁；[] 与非空走授权影响面', async () => {
    const setup = makeV2('f0301-three-forms');
    await seed(setup, 'held-family');
    setup.store.assignOutputs({ targets: ['held-family'], targetKind: 'family', ownerTaskId: 'b' });
    // 省略：旧式参数重写门禁（形态判定，与族无关）
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', {
      path: 'a.md', title: 'A', markdown: '旧式重写', sources: ['tok'], summary: 's', operationId: 'op-omit',
    }, meta('a')), 'kb_object_registry_stale');
    // []：整体删除面 → 旧族排他拒绝
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-empty', objects: [],
    }), meta('a')), 'kb_object_not_authorized');
    // 非空：重申面 → 族排他拒绝（同一错误码但不同触发面，登记不变）
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', writeDocArgs({
      operationId: 'op-redeclare', objects: [familyObject('obj', 'held-family')],
    }), meta('a')), 'kb_object_not_authorized');
    expect(draftJson(setup).objects).toHaveLength(1);
    expect(receiptsOf(setup, 'op-omit').concat(receiptsOf(setup, 'op-empty'), receiptsOf(setup, 'op-redeclare'))).toHaveLength(0);
  });
});
