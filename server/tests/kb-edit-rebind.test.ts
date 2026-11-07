/**
 * kb-edit-rebind.test.ts — WP-E（增量构建摩擦）：
 * E1 kb_edit_doc/kb_write_doc 继承旧证据的跨构建回执自动重绑
 *    + 缺覆盖回执一次性聚合报出（合并相邻区间）
 * E2 kb_edit_doc.evidenceSelectorUpdates 上限 20→80
 * E3 draft_read limit=0（只读声明）
 * E4 raw_read 多传 kind 容错
 * E5 raw_csv_find 缺 resourceId 的唯一附件解析
 *
 * 模式：临时目录 + 手工快照（同 kb-tool-param-tolerance.test.ts），不依赖
 * SQLite。跨构建场景用「staging1 写入 → 携带 knowledge-draft 与正文到
 * staging2（回执文件不携带，readReceiptId 改写为上一构建的 krr_stage_*）」
 * 模拟增量构建继承（真实机制见 progressive-source-snapshot.ts
 * seedProgressiveCarriedReceipts：阶段发布把继承证据回执改写为
 * krr_stage_<hash(buildId, evidenceId, contentHash)>，跨构建必然失效）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import {
  DRAFT_READ_SPEC,
  KB_EDIT_DOC_SPEC,
  RAW_CSV_FIND_SPEC,
  RAW_READ_SPEC,
  V2_LEADER_TOOLS,
} from '../src/agent/tool-specs.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let service: AgentToolService;

const writeRaw = (rel: string, content: string): string => {
  const target = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
};

const CSV_NAME = '表.csv';
const CSV_CONTENT = '列,值,空列\n1,"多行\n内容",\n3,三,\n';
const CSV1_NAME = '表1.csv';
const CSV2_NAME = '表2.csv';
const BIG_CSV_NAME = '大表.csv';
let CSV_PATH = '';
let CSV1_PATH = '';
let CSV2_PATH = '';
let BIG_CSV_PATH = '';

function entry(objToken: string, relPath: string, csvPaths: string[] = []): RawSourceSnapshotEntry {
  return {
    objToken,
    objType: csvPaths.length > 0 ? 'sheet' : 'docx',
    title: relPath,
    relPath,
    contentHash: computeSourceHash(path.join(kbRoot, relPath), csvPaths, kbRoot),
    objEditTime: null,
  };
}

function makeSnapshot(): RawSourceSnapshot {
  return RawSourceSnapshot.fromEntries(
    [
      entry('tokA', 'src-a.md'),
      entry('tokB', 'sheet-doc.md', [CSV_PATH]),
      entry('tokC', 'sheet-c.md', [CSV1_PATH, CSV2_PATH]),
      entry('tokCH', 'src-changed.md'),
      entry('tokM', 'src-multi.md'),
      entry('tokBIG', 'sheet-big.md', [BIG_CSV_PATH]),
      entry('tokT', 'src-t2400.md'),
      entry('tokL', 'src-t4000.md'),
      entry('tokD', 'src-img.md'),
    ],
    {
      knowledgeBaseRoot: kbRoot,
      sheetCsvPaths: (token) =>
        token === 'tokB' ? [CSV_PATH] : token === 'tokC' ? [CSV1_PATH, CSV2_PATH] : token === 'tokBIG' ? [BIG_CSV_PATH] : [],
    },
  );
}

function makeBuildState(stagingName: string): BuildRunState {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  return {
    knowledgeBaseRoot: kbRoot,
    snapshot: makeSnapshot(),
    mode: 'incremental',
    workset: new Map([['tokA', 'added'], ['tokB', 'added'], ['tokC', 'added'], ['tokCH', 'added'], ['tokM', 'added'],
      ['tokBIG', 'added'], ['tokT', 'added'], ['tokL', 'added'], ['tokD', 'added']]),
    stagingRoot,
    finishInfo: null,
    docMeta: new Map(),
  };
}

function tokenFor(state: BuildRunState): string {
  return service.createRunContext({
    runKind: 'build',
    buildId: 'b-wpe',
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    buildState: state,
  }).token;
}

const call = (token: string, tool: string, args: Record<string, unknown>, m?: { amagiTaskId?: string; amagiAgent?: string }) =>
  service.executeTool(token, tool, args, m);

const meta = (taskId: string, agent: string) => ({ amagiTaskId: taskId, amagiAgent: agent });

interface V2Setup { leader: { token: string }; child: { token: string }; store: BuildActorStore; state: BuildRunState }

/** kb_edit_doc 仅在 v2 编排工具面下发（同 kb-tool-param-tolerance 的 makeV2）。 */
function makeV2(stagingName: string): V2Setup {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  const store = new BuildActorStore({ buildId: stagingName, stagingRoot, generation: 1 });
  const state = makeBuildState(stagingName);
  (state as BuildRunState & { v2?: unknown }).v2 = { actorStore: store, generation: 1 };
  const leader = service.createRunContext({
    runKind: 'build',
    buildId: stagingName,
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    buildState: state,
    allowedToolsOverride: [...V2_LEADER_TOOLS],
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: 1, credential: 'leader', actorStore: store },
  });
  const child = service.createRunContext({
    runKind: 'build',
    buildId: stagingName,
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    buildState: state,
    allowedToolsOverride: V2_CHILD_ALL_TOOLS,
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: 1, credential: 'child', actorStore: store },
  });
  store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
  return { leader: { token: leader.token }, child: { token: child.token }, store, state };
}

const assignDoc = async (setup: V2Setup, docPath: string) => {
  await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: [docPath] });
};

const BASE_OBJECT = { clientKey: 'damage', type: 'rule', title: '伤害', familyKey: 'damage', scopeText: '伤害规则', claims: [{ claimKey: 'multiplier' }] };

interface DraftShape {
  evidence: Array<{ evidenceId: string; readReceiptId?: string; clientKeyOf?: string }>;
  evidenceKeys: Record<string, string>;
}

const readDraft = (state: BuildRunState): DraftShape =>
  JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf8'));

const readReceiptIds = (state: BuildRunState): Set<string> =>
  new Set(
    fs.readFileSync(path.join(state.stagingRoot, 'read-receipts.jsonl'), 'utf8')
      .split('\n').filter((line) => line.trim())
      .map((line) => (JSON.parse(line) as { readReceiptId: string }).readReceiptId),
  );

/** 模拟增量构建的草稿携带：正文与声明随草稿进入新构建 staging；读取回执
 * 不携带（新构建回执登记从空开始），继承证据的 readReceiptId 改写为上一
 * 构建的阶段发布回执（krr_stage_*，跨构建必然不在新登记中）。 */
function carryDraftToNewBuild(fromName: string, toName: string): void {
  const from = path.join(dataRoot, 'staging', fromName);
  const to = path.join(dataRoot, 'staging', toName);
  fs.mkdirSync(path.join(to, 'docs'), { recursive: true });
  fs.cpSync(path.join(from, 'docs'), path.join(to, 'docs'), { recursive: true });
  const draft = JSON.parse(fs.readFileSync(path.join(from, 'knowledge-draft.json'), 'utf8'));
  for (const evidence of draft.evidence ?? []) {
    if (typeof evidence.readReceiptId === 'string') {
      evidence.readReceiptId = `krr_stage_${evidence.evidenceId.replace(/kev_/g, '').padEnd(12, '0').slice(0, 12)}`;
    }
  }
  fs.writeFileSync(path.join(to, 'knowledge-draft.json'), JSON.stringify(draft));
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpe-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpe-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpe-out-'));
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  CSV_PATH = writeRaw(CSV_NAME, CSV_CONTENT);
  CSV1_PATH = writeRaw(CSV1_NAME, 'a,b\n1,2\n');
  CSV2_PATH = writeRaw(CSV2_NAME, 'x\ny\nz\n');
  BIG_CSV_PATH = writeRaw(BIG_CSV_NAME, `k,v\n${Array.from({ length: 30 }, (_, i) => `${i},v${i}`).join('\n')}\n`);
  writeRaw('sheet-big.md', 'B1\nB2\n');
  writeRaw('src-a.md', '伤害倍率表\n倍率 2.0\n上限 500\n');
  writeRaw('sheet-doc.md', 'A1\nA2\n');
  writeRaw('sheet-c.md', 'C1\nC2\n');
  writeRaw('src-changed.md', '标题行\n倍率 2.0\n尾行\n');
  writeRaw('src-multi.md', Array.from({ length: 30 }, (_, i) => `第${i + 1}行内容`).join('\n') + '\n');
  writeRaw('src-t2400.md', Array.from({ length: 2400 }, (_, i) => `x${i + 1}`).join('\n') + '\n');
  writeRaw('src-t4000.md', Array.from({ length: 4000 }, (_, i) => `x${i + 1}`).join('\n') + '\n');
  writeRaw('src-img.md', '第1行\n![图](pic1.png)\n第3行\n第4行\n第5行\n');
});

afterAll(() => {
  for (const dir of [dataRoot, kbRoot, outputRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

/** 基线草稿：3 条证据（tokA 行 2、行 3 相邻 + tokB CSV record 2）。 */
async function seedCarriedDraft(staging: string): Promise<{ state: BuildRunState; token: string; evidenceIds: string[] }> {
  const state = makeBuildState(staging);
  const token = tokenFor(state);
  await call(token, 'raw_read', { objToken: 'tokA', offset: 0, limit: 10 });
  await call(token, 'raw_csv_cells', { objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: 1, recordEnd: 3 });
  await call(token, 'kb_write_doc', {
    path: '战斗/部队数据.md', markdown: '## 倍率\n倍率 2.0。\n上限 500。\n',
    sources: ['tokA', 'tokB'], summary: '部队数据', objects: [BASE_OBJECT],
    evidenceClaims: [
      { clientKey: 'ev_text', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokA', resourceId: 'tokA' }, selector: { kind: 'text_span', lineStart: 2, lineEnd: 2 } },
      { clientKey: 'ev_text2', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokA', resourceId: 'tokA' }, selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 } },
      { clientKey: 'ev_csv', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokB', resourceId: `tokB#csv:${CSV_NAME}` }, selector: { kind: 'csv_cells', resourcePath: CSV_NAME, parserVersion: 'rfc4180-v1', recordStart: 2, recordEnd: 2, columns: ['值'] } },
    ],
  });
  const ids = Object.values(readDraft(state).evidenceKeys);
  return { state, token, evidenceIds: ids };
}

const DOC_PATH = '战斗/部队数据.md';

// ============================================================================
// E1：继承证据重绑
// ============================================================================
describe('WP-E E1：kb_edit_doc 继承旧证据跨构建回执重绑', () => {
  it('继承证据（krr_stage 回执）+ 作者已读覆盖范围 → 编辑成功且证据重绑到本构建回执', async () => {
    const seed = await seedCarriedDraft('e1-b1');
    carryDraftToNewBuild('e1-b1', 'e1-b2');
    const setup = makeV2('e1-b2');
    await assignDoc(setup, DOC_PATH);
    // 新构建内没有任何 krr_stage_* 回执；作者按当前源重读了覆盖范围。
    await call(setup.child.token, 'raw_read', { objToken: 'tokA', offset: 0, limit: 10 }, meta('w1', 'luban'));
    await call(setup.child.token, 'raw_csv_cells', { objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: 1, recordEnd: 3 }, meta('w1', 'luban'));
    const edit = await call(setup.child.token, 'kb_edit_doc', {
      path: DOC_PATH, operationId: 'edit-rebind', summaryUpdate: '部队数据',
      patches: [{ anchor: { kind: 'exact_text', oldText: '倍率 2.0。' }, newText: '倍率 2.0（含暴击加成）。' }],
      evidenceClaimsAdd: [{ clientKey: 'ev_new', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokA', resourceId: 'tokA' }, selector: { kind: 'text_span', lineStart: 2, lineEnd: 2 } }],
    }, meta('w1', 'luban'));
    expect(edit.content[0]!.text).toContain(DOC_PATH);
    const draft2 = readDraft(setup.state);
    expect(draft2.evidence).toHaveLength(4);
    const ids2 = readReceiptIds(setup.state);
    for (const evidence of draft2.evidence) {
      expect(evidence.readReceiptId).toMatch(/^rr_/); // 不再是上一构建的 krr_stage_*
      expect(ids2.has(evidence.readReceiptId!)).toBe(true); // 重绑到本构建真实回执
    }
    // 继承证据的 evidenceId 身份稳定
    for (const id of seed.evidenceIds) expect(draft2.evidence.some((e) => e.evidenceId === id)).toBe(true);
  });

  it('kb_write_doc 整篇重申携带旧回执同样自动重绑（共享 writeDocCore 校验链）', async () => {
    const seed = await seedCarriedDraft('e1-b1-fullrewrite');
    carryDraftToNewBuild('e1-b1-fullrewrite', 'e1-b2-fullrewrite');
    const state2 = makeBuildState('e1-b2-fullrewrite');
    const token2 = tokenFor(state2);
    await call(token2, 'raw_read', { objToken: 'tokA', offset: 0, limit: 10 });
    await call(token2, 'raw_csv_cells', { objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: 1, recordEnd: 3 });
    // 模型从 draft_read 声明里原样复制了继承证据（含旧 krr_stage_* 回执）
    const rewrite = await call(token2, 'kb_write_doc', {
      path: DOC_PATH, markdown: '## 倍率\n倍率 2.0（重申）。\n上限 500。\n',
      sources: ['tokA', 'tokB'], summary: '部队数据', objects: [BASE_OBJECT],
      evidenceClaims: [
        { clientKey: 'ev_text', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokA', resourceId: 'tokA' }, readReceiptId: 'krr_stage_copied_from_declarations', selector: { kind: 'text_span', lineStart: 2, lineEnd: 2 } },
        { clientKey: 'ev_text2', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokA', resourceId: 'tokA' }, readReceiptId: 'krr_stage_copied_from_declarations', selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 } },
        { clientKey: 'ev_csv', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokB', resourceId: `tokB#csv:${CSV_NAME}` }, readReceiptId: 'krr_stage_copied_from_declarations', selector: { kind: 'csv_cells', resourcePath: CSV_NAME, parserVersion: 'rfc4180-v1', recordStart: 2, recordEnd: 2, columns: ['值'] } },
      ],
    });
    expect(rewrite.content[0]!.text).toContain(DOC_PATH);
    const draft2 = readDraft(state2);
    expect(draft2.evidence).toHaveLength(3);
    const ids2 = readReceiptIds(state2);
    for (const evidence of draft2.evidence) {
      expect(evidence.readReceiptId).toMatch(/^rr_/);
      expect(ids2.has(evidence.readReceiptId!)).toBe(true);
    }
    for (const id of seed.evidenceIds) expect(draft2.evidence.some((e) => e.evidenceId === id)).toBe(true);
  });

  it('对照（修复前实测形状）：未读 → 一次性列出全部缺失范围（合并相邻区间）', async () => {
    await seedCarriedDraft('e1-b1-agg');
    carryDraftToNewBuild('e1-b1-agg', 'e1-b2-agg');
    const setup = makeV2('e1-b2-agg');
    await assignDoc(setup, DOC_PATH);
    // 未读本构建任何范围：三条证据的缺失范围一次报出——
    // tokA 行 2..2 与 3..3 合并为一个窗口（交集换算输出行 2..3，R4-02），
    // CSV 单列一条（R4-01：窗口不切断 selector）。
    await expect(call(setup.child.token, 'kb_edit_doc', {
      path: DOC_PATH, operationId: 'edit-agg', summaryUpdate: '部队数据',
      patches: [{ anchor: { kind: 'exact_text', oldText: '倍率 2.0。' }, newText: '倍率 2.5。' }],
    }, meta('w1', 'luban'))).rejects.toThrow(new RegExp(
      '共 3 条证据在本构建没有覆盖回执[\\s\\S]*' +
      'raw_read\\(objToken:"tokA", offset:1, limit:2\\)[\\s\\S]*覆盖资源行 2\\.\\.3[\\s\\S]*' +
      'raw_csv_cells\\(objToken:"tokB", resourceId:"tokB#csv:表.csv", recordStart:2, recordEnd:2\\)[\\s\\S]*' +
      '继承自旧构建的证据'));
    // 补读后同一提交原样重试即可成功（聚合提示可执行）
    await call(setup.child.token, 'raw_read', { objToken: 'tokA', offset: 1, limit: 2 }, meta('w1', 'luban'));
    await call(setup.child.token, 'raw_csv_cells', { objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: 2, recordEnd: 2 }, meta('w1', 'luban'));
    const retry = await call(setup.child.token, 'kb_edit_doc', {
      path: DOC_PATH, operationId: 'edit-agg-retry', summaryUpdate: '部队数据',
      patches: [{ anchor: { kind: 'exact_text', oldText: '倍率 2.0。' }, newText: '倍率 2.5。' }],
    }, meta('w1', 'luban'));
    expect(retry.content[0]!.text).toContain(DOC_PATH);
  });

  it('对照：来源内容已变（quoteHash 不符）→ 报错并指出 evidenceId（即使已重读）', async () => {
    // 独立源 tokCH：上一构建后行 2 内容变更（新构建重新冻结）
    const state1 = makeBuildState('e1-changed-b1');
    const token1 = tokenFor(state1);
    await call(token1, 'raw_read', { objToken: 'tokCH', offset: 0, limit: 10 });
    await call(token1, 'kb_write_doc', {
      path: DOC_PATH, markdown: '## 倍率\n倍率 2.0。\n上限 500。\n',
      sources: ['tokCH'], summary: '部队数据', objects: [BASE_OBJECT],
      evidenceClaims: [
        { clientKey: 'ev_text', objectKey: 'damage', claimKey: 'multiplier', selector: { kind: 'text_span', lineStart: 2, lineEnd: 2 } },
      ],
    });
    const textEvidenceId = readDraft(state1).evidenceKeys['ev_text']!;
    writeRaw('src-changed.md', '标题行\n倍率 9.9\n尾行\n');
    carryDraftToNewBuild('e1-changed-b1', 'e1-changed-b2');
    const setup = makeV2('e1-changed-b2');
    await assignDoc(setup, DOC_PATH);
    await call(setup.child.token, 'raw_read', { objToken: 'tokCH', offset: 0, limit: 10 }, meta('w1', 'luban'));
    await expect(call(setup.child.token, 'kb_edit_doc', {
      path: DOC_PATH, operationId: 'edit-changed', summaryUpdate: '部队数据',
      patches: [{ anchor: { kind: 'exact_text', oldText: '倍率 2.0。' }, newText: '倍率 2.5。' }],
    }, meta('w1', 'luban'))).rejects.toThrow(new RegExp(`${textEvidenceId}[\\s\\S]*内容已变（quoteHash 不符）[\\s\\S]*不能静默继承`));
  });

  it('对照：新证据伪造回执（无一致既有记录）仍被拒绝', async () => {
    await seedCarriedDraft('e1-b1-forged');
    carryDraftToNewBuild('e1-b1-forged', 'e1-b2-forged');
    const setup = makeV2('e1-b2-forged');
    await assignDoc(setup, DOC_PATH);
    await call(setup.child.token, 'raw_read', { objToken: 'tokA', offset: 0, limit: 10 }, meta('w1', 'luban'));
    await call(setup.child.token, 'raw_csv_cells', { objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: 1, recordEnd: 3 }, meta('w1', 'luban'));
    await expect(call(setup.child.token, 'kb_edit_doc', {
      path: DOC_PATH, operationId: 'edit-forged', summaryUpdate: '部队数据',
      patches: [{ anchor: { kind: 'exact_text', oldText: '倍率 2.0。' }, newText: '倍率 2.5。' }],
      evidenceClaimsAdd: [{
        clientKey: 'ev_forged', objectKey: 'damage', claimKey: 'multiplier',
        sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
        readReceiptId: 'rr_forged_deadbeef',
        selector: { kind: 'text_span', lineStart: 2, lineEnd: 2 },
      }],
    }, meta('w1', 'luban'))).rejects.toThrow(/伪造或跨构建引用.*rr_forged_deadbeef/s);
  });

  it('对照：被修改的继承证据携带旧回执（evidenceSelectorUpdates + 显式 krr_stage）仍被拒绝', async () => {
    const seed = await seedCarriedDraft('e1-b1-modified');
    carryDraftToNewBuild('e1-b1-modified', 'e1-b2-modified');
    const setup = makeV2('e1-b2-modified');
    await assignDoc(setup, DOC_PATH);
    await call(setup.child.token, 'raw_read', { objToken: 'tokA', offset: 0, limit: 10 }, meta('w1', 'luban'));
    await call(setup.child.token, 'raw_csv_cells', { objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: 1, recordEnd: 3 }, meta('w1', 'luban'));
    await expect(call(setup.child.token, 'kb_edit_doc', {
      path: DOC_PATH, operationId: 'edit-modified', summaryUpdate: '部队数据',
      evidenceSelectorUpdates: [{
        evidenceId: seed.evidenceIds[0]!,
        selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 },
        readReceiptId: 'krr_stage_stale_previous_build',
      }],
    }, meta('w1', 'luban'))).rejects.toThrow(/伪造或跨构建引用.*krr_stage_stale_previous_build/s);
  });
});

// ============================================================================
// E2：evidenceSelectorUpdates 上限 20→80
// ============================================================================
describe('WP-E E2：kb_edit_doc.evidenceSelectorUpdates 上限 80', () => {
  it('25 项 selector 更新一次提交成功（旧上限 20 在客户端即拒绝）', async () => {
    const state1 = makeBuildState('e2-b1');
    const token1 = tokenFor(state1);
    await call(token1, 'raw_read', { objToken: 'tokM', offset: 0, limit: 30 });
    await call(token1, 'kb_write_doc', {
      path: '战斗/批量重定位.md', markdown: '## 多行\n' + Array.from({ length: 25 }, (_, i) => `引用第${i + 1}行。`).join('\n'),
      sources: ['tokM'], summary: '批量重定位', objects: [BASE_OBJECT],
      evidenceClaims: Array.from({ length: 25 }, (_, i) => ({
        clientKey: `ev_m${i + 1}`, objectKey: 'damage', claimKey: 'multiplier',
        selector: { kind: 'text_span', lineStart: i + 1, lineEnd: i + 1 },
      })),
    });
    carryDraftToNewBuild('e2-b1', 'e2-b2');
    const setup = makeV2('e2-b2');
    await assignDoc(setup, '战斗/批量重定位.md');
    await call(setup.child.token, 'raw_read', { objToken: 'tokM', offset: 0, limit: 30 }, meta('w1', 'luban'));
    const draft = readDraft(setup.state);
    const updates = Array.from({ length: 25 }, (_, i) => ({
      evidenceId: draft.evidenceKeys[`ev_m${i + 1}`]!,
      selector: { kind: 'text_span', lineStart: i + 1, lineEnd: i + 1 },
    }));
    const edit = await call(setup.child.token, 'kb_edit_doc', {
      path: '战斗/批量重定位.md', operationId: 'edit-bulk', summaryUpdate: '批量重定位',
      evidenceSelectorUpdates: updates,
    }, meta('w1', 'luban'));
    expect(edit.content[0]!.text).toContain('战斗/批量重定位.md');
    const after = readDraft(setup.state);
    expect(after.evidence).toHaveLength(25);
    const ids2 = readReceiptIds(setup.state);
    for (const evidence of after.evidence) {
      expect(evidence.readReceiptId).toMatch(/^rr_/);
      expect(ids2.has(evidence.readReceiptId!)).toBe(true);
    }
  });

  it('服务端上限：81 项仍拒绝（80 封顶，原子语义不变）', async () => {
    const plain = makeBuildState('e2-cap');
    await call(tokenFor(plain), 'kb_write_doc', {
      path: '战斗/封顶.md', markdown: '## 倍率\n倍率 2.0。', sources: ['tokA'], summary: '封顶',
    });
    const setup = makeV2('e2-cap');
    await assignDoc(setup, '战斗/封顶.md');
    await expect(call(setup.child.token, 'kb_edit_doc', {
      path: '战斗/封顶.md', operationId: 'edit-cap', summaryUpdate: '封顶',
      evidenceSelectorUpdates: Array.from({ length: 81 }, () => ({
        evidenceId: 'kev_nonexistent', selector: { kind: 'text_span', lineStart: 1, lineEnd: 1 },
      })),
    }, meta('w1', 'luban'))).rejects.toThrow(/至少一项非空，且分别不超过 50\/50\/80\/20\/20 项/);
  });

  it('真实下发 schema：80 项通过客户端校验、81 项被拒', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const mk = (n: number) => ({
      path: 'a.md',
      evidenceSelectorUpdates: Array.from({ length: n }, () => ({
        evidenceId: 'kev_x', selector: { kind: 'text_span', lineStart: 1, lineEnd: 1 },
      })),
    });
    expect(ajv.validate(KB_EDIT_DOC_SPEC.parameters as object, mk(80))).toBe(true);
    expect(ajv.validate(KB_EDIT_DOC_SPEC.parameters as object, mk(81))).toBe(false);
  });
});

// ============================================================================
// E3：draft_read limit=0（只读声明）
// ============================================================================
describe('WP-E E3：draft_read limit=0 只读声明', () => {
  it('limit:0 + includeDeclarations → 只返回声明不返回正文行', async () => {
    const state = makeBuildState('e3');
    const token = tokenFor(state);
    await call(token, 'kb_write_doc', {
      path: '规则/声明.md', markdown: '## 倍率\n正文行内容。', sources: ['tokA'], summary: '声明',
      objects: [BASE_OBJECT],
    });
    const result = await call(token, 'draft_read', { path: '规则/声明.md', limit: 0, includeDeclarations: true });
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain('existing_knowledge_declarations');
    expect(text).not.toContain('正文行内容。');
    expect((result.details as Record<string, unknown>).returnedLines).toBe(0);
    // metadataOnly 同理（limit 不参与正文读取）
    const meta = await call(token, 'draft_read', { path: '规则/声明.md', limit: 0, metadataOnly: true });
    expect(meta.content[0]!.text).toContain('draft_metadata');
  });

  it('对照：limit:0 无声明请求 → 精确错误（不做无语义的空读）', async () => {
    const state = makeBuildState('e3-err');
    const token = tokenFor(state);
    await call(token, 'kb_write_doc', {
      path: '规则/声明错.md', markdown: '## 倍率\n正文。', sources: ['tokA'], summary: '声明',
    });
    await expect(call(token, 'draft_read', { path: '规则/声明错.md', limit: 0 }))
      .rejects.toThrow(/limit=0 只在与 includeDeclarations\/declarationClaimKey\/declarationObjectKey 或 metadataOnly 同用/);
  });

  it('真实下发 schema：limit:0 在客户端校验层放行（minimum 0）', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    expect(ajv.validate(DRAFT_READ_SPEC.parameters as object, { path: 'a.md', limit: 0, includeDeclarations: true })).toBe(true);
    expect(ajv.validate(DRAFT_READ_SPEC.parameters as object, { path: 'a.md', limit: -1 })).toBe(false);
  });
});

// ============================================================================
// E4：raw_read 多传 kind
// ============================================================================
describe('WP-E E4：raw_read 容忍多余字段 kind', () => {
  it('多传 kind 被忽略并说明（paramNotes），读取与回执正常', async () => {
    const state = makeBuildState('e4');
    const token = tokenFor(state);
    const result = await call(token, 'raw_read', { kind: 'raw_read', objToken: 'tokA', offset: 0, limit: 3 });
    const joined = result.content.map((block) => block.text).join('\n');
    expect(joined).toContain('伤害倍率表');
    expect(joined).toContain('已忽略参数 kind');
  });

  it('对照：未知参数（非 kind）仍报精确错误', async () => {
    const state = makeBuildState('e4-err');
    const token = tokenFor(state);
    await expect(call(token, 'raw_read', { objToken: 'tokA', foo: 1 }))
      .rejects.toThrow(/raw_read 只接受/);
  });

  it('真实下发 schema：raw_read+kind 在客户端校验层放行', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    expect(ajv.validate(RAW_READ_SPEC.parameters as object, { kind: 'raw_read', objToken: 'tokA' })).toBe(true);
  });
});

// ============================================================================
// E5：raw_csv_find 缺 resourceId
// ============================================================================
describe('WP-E E5：raw_csv_find 缺省 resourceId 的唯一附件解析', () => {
  it('该来源恰有一个 CSV 附件 → 自动选用并在结果中注明', async () => {
    const state = makeBuildState('e5-unique');
    const token = tokenFor(state);
    const result = await call(token, 'raw_csv_find', { objToken: 'tokB', queries: ['多行'] });
    const payload = JSON.parse(/\{[\s\S]*\}/.exec(result.content[0]!.text)![0]) as { resourceId: string; note?: string };
    expect(payload.resourceId).toBe(`tokB#csv:${CSV_NAME}`);
    expect(payload.note).toContain(`已自动选用 tokB#csv:${CSV_NAME}`);
  });

  it('对照：多附件 → 精确错误列出候选（含名称与行数）；无附件 → 明确说明', async () => {
    const state = makeBuildState('e5-multi');
    const token = tokenFor(state);
    await expect(call(token, 'raw_csv_find', { objToken: 'tokC', queries: ['短语'] }))
      .rejects.toThrow(new RegExp(
        `有 2 个 CSV 附件[\\s\\S]*tokC#csv:${CSV1_NAME}（${CSV1_NAME}，2 条 record）[\\s\\S]*tokC#csv:${CSV2_NAME}（${CSV2_NAME}，3 条 record）`));
    await expect(call(token, 'raw_csv_find', { objToken: 'tokA', queries: ['短语'] }))
      .rejects.toThrow(/没有 CSV 附件资源/);
  });

  it('真实下发 schema：缺 resourceId 在客户端校验层放行（required 已移除）', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    expect(ajv.validate(RAW_CSV_FIND_SPEC.parameters as object, { objToken: 'tokB', queries: ['短语'] })).toBe(true);
  });
});

// ============================================================================
// 复审 R4（review-4.md）：聚合建议窗口不切断 selector + 输出坐标交集换算
// ============================================================================
describe('WP-E 复审 R4：聚合建议可满足性与输出坐标换算', () => {
  /** 提交并捕获错误文本（缺回执聚合报错），返回错误消息。 */
  const captureReject = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
      throw new Error('unexpected accepted');
    } catch (error) {
      if (String(error).includes('unexpected accepted')) throw error;
      return String(error);
    }
  };
  const readHints = (message: string, pattern: RegExp): RegExpMatchArray[] =>
    [...message.matchAll(pattern)];

  it('R4-01：相邻 CSV 证据（record 1..15 与 16..30）按全部建议补读后原样重试成功', async () => {
    const docPath = '战斗/相邻CSV.md';
    const rid = `tokBIG#csv:${BIG_CSV_NAME}`;
    const state1 = makeBuildState('r4-csv-b1');
    const token1 = tokenFor(state1);
    await call(token1, 'raw_csv_cells', { objToken: 'tokBIG', resourceId: rid, recordStart: 1, recordEnd: 15 });
    await call(token1, 'raw_csv_cells', { objToken: 'tokBIG', resourceId: rid, recordStart: 16, recordEnd: 30 });
    await call(token1, 'kb_write_doc', {
      path: docPath, markdown: '## 表\n相邻证据。', sources: ['tokBIG'], summary: '相邻CSV', objects: [BASE_OBJECT],
      evidenceClaims: [
        { clientKey: 'ev_c1', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokBIG', resourceId: rid }, selector: { kind: 'csv_cells', resourcePath: BIG_CSV_NAME, parserVersion: 'rfc4180-v1', recordStart: 1, recordEnd: 15, columns: ['v'] } },
        { clientKey: 'ev_c2', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokBIG', resourceId: rid }, selector: { kind: 'csv_cells', resourcePath: BIG_CSV_NAME, parserVersion: 'rfc4180-v1', recordStart: 16, recordEnd: 30, columns: ['v'] } },
      ],
    });
    carryDraftToNewBuild('r4-csv-b1', 'r4-csv-b2');
    const setup = makeV2('r4-csv-b2');
    await assignDoc(setup, docPath);
    const message = await captureReject(call(setup.child.token, 'kb_edit_doc', {
      path: docPath, operationId: 'edit-r4csv', summaryUpdate: '相邻CSV',
      patches: [{ anchor: { kind: 'exact_text', oldText: '相邻证据。' }, newText: '相邻证据（修订）。' }],
    }, meta('w1', 'luban')));
    expect(message).toMatch(/共 2 条证据在本构建没有覆盖回执/);
    const suggestions = readHints(message, /raw_csv_cells\(objToken:"([^"]+)", resourceId:"([^"]+)", recordStart:(\d+), recordEnd:(\d+)\)/g);
    // R4-01 核心：合并相邻区间不得切断 selector——16..30 必须被单张窗口完整覆盖
    expect(suggestions.map((m) => [+m[3], +m[4]] as [number, number]).sort((a, b) => a[0] - b[0]))
      .toEqual([[1, 15], [16, 30]]);
    for (const m of suggestions) {
      await call(setup.child.token, 'raw_csv_cells', { objToken: m[1]!, resourceId: m[2]!, recordStart: +m[3]!, recordEnd: +m[4]! }, meta('w1', 'luban'));
    }
    const retry = await call(setup.child.token, 'kb_edit_doc', {
      path: docPath, operationId: 'edit-r4csv-retry', summaryUpdate: '相邻CSV',
      patches: [{ anchor: { kind: 'exact_text', oldText: '相邻证据。' }, newText: '相邻证据（修订）。' }],
    }, meta('w1', 'luban'));
    expect(retry.content[0]!.text).toContain(docPath);
  });

  it('R4-01：相邻文本证据（1..1200 与 1201..2400）切块边界同构，补读后重试成功', async () => {
    const docPath = '战斗/相邻文本.md';
    const state1 = makeBuildState('r4-t2400-b1');
    const token1 = tokenFor(state1);
    await call(token1, 'raw_read', { objToken: 'tokT', offset: 0, limit: 600 });
    await call(token1, 'raw_read', { objToken: 'tokT', offset: 600, limit: 600 });
    await call(token1, 'kb_write_doc', {
      path: docPath, markdown: '## 长文\n相邻长区间证据。', sources: ['tokT'], summary: '相邻文本', objects: [BASE_OBJECT],
      evidenceClaims: [
        { clientKey: 'ev_t1', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokT', resourceId: 'tokT' }, selector: { kind: 'text_span', lineStart: 1, lineEnd: 600 } },
        { clientKey: 'ev_t2', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokT', resourceId: 'tokT' }, selector: { kind: 'text_span', lineStart: 601, lineEnd: 1200 } },
      ],
    });
    carryDraftToNewBuild('r4-t2400-b1', 'r4-t2400-b2');
    const setup = makeV2('r4-t2400-b2');
    await assignDoc(setup, docPath);
    const message = await captureReject(call(setup.child.token, 'kb_edit_doc', {
      path: docPath, operationId: 'edit-r4t', summaryUpdate: '相邻文本',
      patches: [{ anchor: { kind: 'exact_text', oldText: '相邻长区间证据。' }, newText: '相邻长区间证据（修订）。' }],
    }, meta('w1', 'luban')));
    const suggestions = readHints(message, /raw_read\(objToken:"([^"]+)", offset:(\d+), limit:(\d+)\)/g);
    // 合并后 1200 行的渲染字节超 raw_read 单页预算 → 拆为两张互不切断
    // selector 且各自可单次整窗返回的窗口
    expect(suggestions.map((m) => [+m[2], +m[2]! + +m[3]! - 1] as [number, number]).sort((a, b) => a[0] - b[0]))
      .toEqual([[0, 599], [600, 1199]]);
    expect(suggestions.every((m) => +m[3]! <= 2000)).toBe(true);
    for (const m of suggestions) {
      await call(setup.child.token, 'raw_read', { objToken: m[1], offset: +m[2], limit: +m[3] }, meta('w1', 'luban'));
    }
    const retry = await call(setup.child.token, 'kb_edit_doc', {
      path: docPath, operationId: 'edit-r4t-retry', summaryUpdate: '相邻文本',
      patches: [{ anchor: { kind: 'exact_text', oldText: '相邻长区间证据。' }, newText: '相邻长区间证据（修订）。' }],
    }, meta('w1', 'luban'));
    expect(retry.content[0]!.text).toContain(docPath);
  });

  it('R4-02：4000 行正文第 3000 行的建议精确命中（旧实现固定 offset:0 永不覆盖）', async () => {
    const payload = {
      path: '战斗/四千行.md', markdown: '## 长文\n第 3000 行断言。', sources: ['tokL'], summary: '四千行',
      objects: [BASE_OBJECT],
      evidenceClaims: [{ clientKey: 'ev_l3k', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokL', resourceId: 'tokL' }, selector: { kind: 'text_span', lineStart: 3000, lineEnd: 3000 } }],
    };
    const state = makeBuildState('r4-t4000');
    const token = tokenFor(state);
    const message = await captureReject(call(token, 'kb_write_doc', payload));
    expect(message).toMatch(/raw_read\(objToken:"tokL", offset:2999, limit:1\)/);
    expect(message).not.toMatch(/offset:0, limit:2000/);
    const suggestions = readHints(message, /raw_read\(objToken:"([^"]+)", offset:(\d+), limit:(\d+)\)/g);
    for (const m of suggestions) {
      await call(token, 'raw_read', { objToken: m[1], offset: +m[2], limit: +m[3] });
    }
    const write = await call(token, 'kb_write_doc', payload);
    expect(write.content[0]!.text).toContain('战斗/四千行.md');
  });

  it('R4-02：派生行位移——图片描述块后的资源行按交集换算输出坐标', async () => {
    const state = makeBuildState('r4-img');
    // 行 2 引用 pic1.png → 输出在行 2 后插入 3 行派生描述（输出 3..5），
    // 资源行 4 实际位于输出行 7：建议必须是 offset:6, limit:1 而非朴素 offset:3。
    state.imageDescriptions = new Map([['tokD', new Map([['pic1.png', {
      src: 'pic1.png', imageHash: 'img-hash-1', state: 'described' as const, text: '图内文字描述',
    }]])]]);
    const token = tokenFor(state);
    const payload = {
      path: '战斗/位移.md', markdown: '## 图\n引用图片与第4行。', sources: ['tokD'], summary: '位移',
      objects: [BASE_OBJECT],
      evidenceClaims: [{ clientKey: 'ev_d4', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokD', resourceId: 'tokD' }, selector: { kind: 'text_span', lineStart: 4, lineEnd: 4 } }],
    };
    const message = await captureReject(call(token, 'kb_write_doc', payload));
    expect(message).toMatch(/raw_read\(objToken:"tokD", offset:6, limit:1\)/);
    const suggestions = readHints(message, /raw_read\(objToken:"([^"]+)", offset:(\d+), limit:(\d+)\)/g);
    for (const m of suggestions) {
      await call(token, 'raw_read', { objToken: m[1], offset: +m[2], limit: +m[3] });
    }
    const write = await call(token, 'kb_write_doc', payload);
    expect(write.content[0]!.text).toContain('战斗/位移.md');
  });

  it('R4-01 对照：单条 selector 超单次上限时给「拆分证据」精确错误，不给无法满足的建议', async () => {
    const state = makeBuildState('r4-oversize');
    const token = tokenFor(state);
    const message = await captureReject(call(token, 'kb_write_doc', {
      path: '战斗/超限.md', markdown: '## 超限\n超限证据。', sources: ['tokT'], summary: '超限',
      objects: [BASE_OBJECT],
      evidenceClaims: [{ clientKey: 'ev_huge', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokT', resourceId: 'tokT' }, selector: { kind: 'text_span', lineStart: 1, lineEnd: 2400 } }],
    }));
    expect(message).toMatch(/资源行 1\.\.2400（2400 行）超过 raw_read 单次 2000 行上限.*拆成更小区间/s);
    expect(message).not.toMatch(/raw_read\(objToken:"tokT", offset:\d+, limit:\d+\)/);
    const csvMessage = await captureReject(call(token, 'kb_write_doc', {
      path: '战斗/超限csv.md', markdown: '## 超限\nCSV 超限。', sources: ['tokBIG'], summary: '超限csv',
      objects: [BASE_OBJECT],
      evidenceClaims: [{ clientKey: 'ev_huge_csv', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokBIG', resourceId: `tokBIG#csv:${BIG_CSV_NAME}` }, selector: { kind: 'csv_cells', resourcePath: BIG_CSV_NAME, parserVersion: 'rfc4180-v1', recordStart: 1, recordEnd: 30, columns: ['v'] } }],
    }));
    expect(csvMessage).toMatch(/record 1\.\.30（30 条）超过 raw_csv_cells 单次 20 record 上限.*拆成更小区间/s);
    expect(csvMessage).not.toMatch(/raw_csv_cells\(objToken:"tokBIG"[^\n]*\)/);
    // 派生内容分隔的区间：raw_read 每段单独登记回执，单张回执永远无法
    // 覆盖——给「拆分证据」精确错误而非无法满足的补读建议。
    const imgState = makeBuildState('r4-img-split');
    imgState.imageDescriptions = new Map([['tokD', new Map([['pic1.png', {
      src: 'pic1.png', imageHash: 'img-hash-1', state: 'described' as const, text: '图内文字描述',
    }]])]]);
    const splitMessage = await captureReject(call(tokenFor(imgState), 'kb_write_doc', {
      path: '战斗/跨图.md', markdown: '## 图\n跨图区间。', sources: ['tokD'], summary: '跨图',
      objects: [BASE_OBJECT],
      evidenceClaims: [{ clientKey: 'ev_split', objectKey: 'damage', claimKey: 'multiplier', sourceRef: { sourceId: 'tokD', resourceId: 'tokD' }, selector: { kind: 'text_span', lineStart: 2, lineEnd: 4 } }],
    }));
    expect(splitMessage).toMatch(/资源行 2\.\.4 被派生内容（图片描述\/白板文字）分隔成 2 段.*拆成更小区间/s);
    expect(splitMessage).not.toMatch(/raw_read\(objToken:"tokD", offset:\d+, limit:\d+\)/);
  });
});
