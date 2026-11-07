/**
 * kb-tool-param-tolerance.test.ts — WP-C（R5 回合开销）：构建期工具参数容错
 * 与可自动修复的错误反馈。
 *
 * 覆盖（每项：规范化成功 + 歧义仍报错的对照）：
 * - build_handoff_submit.openIssues 对象项 → 序列化为一句字符串；
 * - raw_search queries 多查询合并 / objToken 限定单源 / root 歧义报错；
 * - draft_search queries 多查询 / path 限定 / filter 歧义报错；
 * - raw_csv_find queries 上限 8→24（超批注明）/ 缺 resourceId 精确报错；
 * - raw_csv_cells columns 忽略 / recordStart=0 规范化为 1 / 负值报错；
 * - draft_read docPath/paths 别名 / kind 忽略 / 多路径与缺 path 报错；
 * - draft_list 多余参数忽略说明；
 * - kb_read_batch 顶层单请求包装 / resources 别名 / 歧义报错；
 * - build_issues_list listId 等忽略说明；
 * - kb_tool_schema tool 别名 / 未授权工具错误列出可用面；
 * - csvTableImports.columns "@A"/"A"/"3" 规范化 / "C5" 歧义报错；
 * - evidenceClaims 同 clientKey 完全相同内容去重 / 不同内容冲突报错；
 * - kb_evidence_unresolved 自动修复提示（非空列 / raw_read / raw_csv_cells 参数）。
 *
 * 模式：临时目录 + 手工快照（同 kb-knowledge-tools.test.ts），不依赖 SQLite。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { AgentToolService, normalizeToolArguments, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import {
  BUILD_HANDOFF_SUBMIT_SPEC,
  BUILD_ISSUES_LIST_SPEC,
  DRAFT_LIST_SPEC,
  DRAFT_READ_SPEC,
  DRAFT_SEARCH_SPEC,
  KB_READ_BATCH_SPEC,
  KB_TOOL_SCHEMA_SPEC,
  RAW_CSV_CELLS_SPEC,
  RAW_CSV_FIND_SPEC,
  RAW_SEARCH_SPEC,
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
let CSV_PATH = '';

function entry(objToken: string, relPath: string, csvPaths: string[] = []): RawSourceSnapshotEntry {
  return {
    objToken,
    objType: relPath === 'sheet-doc.md' ? 'sheet' : 'docx',
    title: relPath,
    relPath,
    contentHash: computeSourceHash(path.join(kbRoot, relPath), csvPaths, kbRoot),
    objEditTime: null,
  };
}

function makeSnapshot(): RawSourceSnapshot {
  return RawSourceSnapshot.fromEntries(
    [entry('tokA', 'src-a.md'), entry('tokB', 'sheet-doc.md', [CSV_PATH])],
    { knowledgeBaseRoot: kbRoot, sheetCsvPaths: (token) => (token === 'tokB' ? [CSV_PATH] : []) },
  );
}

function makeBuildState(stagingName: string): BuildRunState {
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
  };
}

function tokenFor(state: BuildRunState): string {
  return service.createRunContext({
    runKind: 'build',
    buildId: 'b-wpc',
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    buildState: state,
  }).token;
}

interface V2Setup { leader: { token: string }; child: { token: string }; store: BuildActorStore; state: BuildRunState }

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
  return { leader: { token: leader.token }, child: { token: child.token }, store, state };
}

const meta = (taskId: string, agent: string) => ({ amagiTaskId: taskId, amagiAgent: agent });
const call = (token: string, tool: string, args: Record<string, unknown>, m?: { amagiTaskId?: string; amagiAgent?: string }) =>
  service.executeTool(token, tool, args, m);

const BASE_OBJECT = { clientKey: 'damage', type: 'rule', title: '伤害', familyKey: 'damage', scopeText: '伤害规则', claims: [{ claimKey: 'multiplier' }] };

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-out-'));
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  CSV_PATH = path.join(kbRoot, CSV_NAME);
  writeRaw('src-a.md', '伤害倍率表\n倍率 2.0\n上限 500\n');
  writeRaw('sheet-doc.md', 'A1\nA2\n');
  writeRaw(CSV_NAME, CSV_CONTENT);
});

afterAll(() => {
  for (const dir of [dataRoot, kbRoot, outputRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// 1. build_handoff_submit.openIssues 对象项序列化
// ============================================================================
describe('WP-C：build_handoff_submit.openIssues 对象项容错', () => {
  it('对象项序列化为一句字符串（description 优先，附位置字段），记录可被 Leader 读取', async () => {
    const setup = makeV2('b-wpc-handoff');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const submit = await call(setup.child.token, 'build_handoff_submit', {
      summary: '完成文档',
      openIssues: [
        { description: '公式未覆盖', path: 'docs/x.md', severity: 'blocking' },
        '纯字符串问题保持不变',
      ],
    }, meta('w1', 'luban'));
    expect(submit.content[0]!.text).toContain('已提交交接记录');
    expect((submit.content[1]?.text ?? '') + submit.content[0]!.text).toContain('openIssues 对象项序列化');
    const detail = JSON.parse((await call(setup.leader.token, 'build_handoff_list', { taskId: 'w1' })).content[0]!.text);
    expect(detail.handoffs[0].openIssues[0]).toContain('公式未覆盖');
    expect(detail.handoffs[0].openIssues[0]).toContain('path=docs/x.md');
    expect(detail.handoffs[0].openIssues[1]).toBe('纯字符串问题保持不变');
    // 同载荷重放仍幂等（规范化在幂等键派生前完成）
    const replay = await call(setup.child.token, 'build_handoff_submit', {
      summary: '完成文档',
      openIssues: [
        { description: '公式未覆盖', path: 'docs/x.md', severity: 'blocking' },
        '纯字符串问题保持不变',
      ],
    }, meta('w1', 'luban'));
    expect(replay.details!.idempotentReplay).toBe(true);
  });
  it('对照：openIssues 项为数字等无法序列化的值报精确错误', async () => {
    const setup = makeV2('b-wpc-handoff-err');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await expect(call(setup.child.token, 'build_handoff_submit', { summary: 's', openIssues: [42] }, meta('w1', 'luban')))
      .rejects.toThrow(/openIssues 每项须为非空字符串或对象/);
  });
});

// ============================================================================
// 2. raw_search / draft_search 别名
// ============================================================================
describe('WP-C：raw_search 别名容错', () => {
  it('queries 多查询逐个执行合并，附 paramNotes 说明', async () => {
    const state = makeBuildState('raw-queries');
    const result = await call(tokenFor(state), 'raw_search', { queries: ['伤害', '上限'] });
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ objToken: string; matchedQueries?: number }>;
      mergedQueries: number;
      paramNotes: string[];
    };
    expect(payload.mergedQueries).toBe(2);
    expect(payload.results[0]).toMatchObject({ objToken: 'tokA', matchedQueries: 2 });
    expect(payload.paramNotes.join()).toContain('queries');
  });
  it('objToken 限定单源：只返回该文档命中', async () => {
    const state = makeBuildState('raw-scope');
    const result = await call(tokenFor(state), 'raw_search', { query: 'A1', objToken: 'tokB' });
    const payload = JSON.parse(result.content[0]!.text) as { results: Array<{ objToken: string }>; paramNotes: string[] };
    expect(payload.results.every((hit) => hit.objToken === 'tokB')).toBe(true);
    expect(payload.paramNotes.join()).toContain('objToken=tokB');
  });
  it('对照：objToken 不存在与未知参数 root 均报错', async () => {
    const state = makeBuildState('raw-scope-err');
    await expect(call(tokenFor(state), 'raw_search', { query: '伤害', objToken: 'missing' })).rejects.toThrow(/不存在或无成功本地版本/);
    await expect(call(tokenFor(state), 'raw_search', { query: '伤害', root: 'x' })).rejects.toThrow(/raw_search 只接受.*root/);
  });
  it('单查询路径返回形状保持不变（回归）', async () => {
    const state = makeBuildState('raw-single');
    const result = await call(tokenFor(state), 'raw_search', { query: '伤害' });
    const payload = JSON.parse(result.content[0]!.text) as { results: Array<Record<string, unknown>> };
    expect(payload.results[0]).toMatchObject({ objToken: 'tokA', title: 'src-a.md' });
    expect(payload.results[0]).not.toHaveProperty('matchedQueries');
    expect(payload).not.toHaveProperty('paramNotes');
  });
});

describe('WP-C：draft_search 别名容错', () => {
  it('queries 多查询 + path 限定范围', async () => {
    const state = makeBuildState('draft-search');
    const token = tokenFor(state);
    await call(token, 'kb_write_doc', {
      path: '战斗/伤害规则.md', markdown: '## 倍率\n伤害倍率 2.0。', sources: ['tokA'], summary: '倍率',
    });
    await call(token, 'kb_write_doc', {
      path: '其他/说明.md', markdown: '## 说明\n伤害相关说明。', sources: ['tokA'], summary: '说明',
    });
    const scoped = await call(token, 'draft_search', { queries: ['伤害', '倍率'], path: '战斗/伤害规则.md' });
    const payload = JSON.parse(scoped.content[0]!.text) as { results: Array<{ path: string }>; paramNotes: string[] };
    expect(payload.results.map((hit) => hit.path)).toEqual(['战斗/伤害规则.md']);
    expect(payload.paramNotes.length).toBeGreaterThan(0);
    const all = await call(token, 'draft_search', { query: '伤害' });
    expect((JSON.parse(all.content[0]!.text) as { results: unknown[] }).results.length).toBe(2);
  });
  it('对照：filter 等歧义参数报精确错误', async () => {
    const state = makeBuildState('draft-search-err');
    await expect(call(tokenFor(state), 'draft_search', { query: '伤害', filter: 'all' }))
      .rejects.toThrow(/draft_search 只接受.*filter/);
  });
});

// ============================================================================
// 3. raw_csv_find / raw_csv_cells
// ============================================================================
describe('WP-C：raw_csv_find 批量上限容错', () => {
  it('9..24 项查询可执行并在结果中注明超批', async () => {
    const state = makeBuildState('csv-find-cap');
    const queries = Array.from({ length: 9 }, (_, i) => `查询词${i}号`);
    queries[0] = '多行';
    const result = await call(tokenFor(state), 'raw_csv_find', {
      objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, queries,
    });
    const payload = JSON.parse(/\{[\s\S]*\}/.exec(result.content[0]!.text)![0]) as { note?: string };
    expect(payload.note).toContain('9 项查询');
  });
  it('对照：>24 项报精确错误；缺 resourceId 时唯一附件自动选用（WP-E E5）', async () => {
    const state = makeBuildState('csv-find-err');
    const tooMany = Array.from({ length: 25 }, (_, i) => `查询词${i}号`);
    await expect(call(tokenFor(state), 'raw_csv_find', { objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, queries: tooMany }))
      .rejects.toThrow(/1–24/);
    // WP-E（E5）：该来源恰有一个 CSV 附件 → 缺省 resourceId 自动选用并注明
    const auto = await call(tokenFor(state), 'raw_csv_find', { objToken: 'tokB', queries: ['多行'] });
    const payload = JSON.parse(/\{[\s\S]*\}/.exec(auto.content[0]!.text)![0]) as { resourceId: string; note?: string };
    expect(payload.resourceId).toBe(`tokB#csv:${CSV_NAME}`);
    expect(payload.note).toContain('已自动选用');
  });
});

describe('WP-C：raw_csv_cells 参数容错', () => {
  it('columns 被忽略并说明；recordStart=0 规范化为 1', async () => {
    const state = makeBuildState('csv-cells-tol');
    const result = await call(tokenFor(state), 'raw_csv_cells', {
      objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: 0, recordEnd: 1, columns: ['@A'],
    });
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).toContain('"recordStart":1');
    expect(text).toContain('param_notes');
    expect(text).toContain('已忽略参数 columns');
  });
  it('对照：负 recordStart 与未知参数报精确错误', async () => {
    const state = makeBuildState('csv-cells-err');
    await expect(call(tokenFor(state), 'raw_csv_cells', {
      objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: -1, recordEnd: 1,
    })).rejects.toThrow(/recordStart 须为 ≥1/);
    await expect(call(tokenFor(state), 'raw_csv_cells', {
      objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: 1, recordEnd: 1, filter: 'x',
    })).rejects.toThrow(/raw_csv_cells 只接受/);
  });
});

// ============================================================================
// 4. draft_read / draft_list / kb_read_batch / build_issues_list / kb_tool_schema
// ============================================================================
describe('WP-C：draft_read 路径别名容错', () => {
  it('docPath/paths 单项别名与 kind 忽略均可达正文', async () => {
    const state = makeBuildState('draft-read-tol');
    const token = tokenFor(state);
    await call(token, 'kb_write_doc', { path: '规则/行动.md', markdown: '## 行动\n正文。', sources: ['tokA'], summary: 's' });
    const byDocPath = await call(token, 'draft_read', { docPath: '规则/行动.md' });
    expect(byDocPath.content.map((block) => block.text).join()).toContain('正文');
    const byPaths = await call(token, 'draft_read', { paths: ['规则/行动.md'], kind: 'draft' });
    const joined = byPaths.content.map((block) => block.text).join();
    expect(joined).toContain('正文');
    expect(joined).toContain('已忽略参数 kind');
  });
  it('对照：多路径与缺路径报可修复的精确错误', async () => {
    const state = makeBuildState('draft-read-err');
    const token = tokenFor(state);
    await expect(call(token, 'draft_read', { paths: ['a.md', 'b.md'] })).rejects.toThrow(/一次只读一篇.*kb_read_batch/);
    await expect(call(token, 'draft_read', { offset: 0 })).rejects.toThrow(/draft_read 需要参数 path/);
  });
});

describe('WP-C：draft_list / kb_read_batch / build_issues_list / kb_tool_schema', () => {
  it('draft_list 多余参数被忽略并说明', async () => {
    const state = makeBuildState('draft-list-tol');
    const result = await call(tokenFor(state), 'draft_list', { limit: 50 });
    const joined = result.content.map((block) => block.text).join();
    expect(joined).toContain('已忽略参数 limit');
  });
  it('kb_read_batch 顶层单请求对象包装为 requests；resources 别名可用', async () => {
    const state = makeBuildState('batch-wrap');
    const token = tokenFor(state);
    const wrapped = await call(token, 'kb_read_batch', { kind: 'raw', objToken: 'tokA', offset: 0, limit: 5 });
    const joined = wrapped.content.map((block) => block.text).join();
    expect(joined).toContain('tokA');
    expect(joined).toContain('包装为 requests');
    const byResources = await call(token, 'kb_read_batch', { resources: [{ kind: 'raw', objToken: 'tokA', offset: 0, limit: 5 }] });
    expect(byResources.content[0]!.text).toContain('tokA');
  });
  it('对照：kb_read_batch 歧义参数报精确错误', async () => {
    const state = makeBuildState('batch-err');
    await expect(call(tokenFor(state), 'kb_read_batch', { resources: 'junk' })).rejects.toThrow(/kb_read_batch 只接受/);
  });
  it('build_issues_list 忽略 listId/issueListId/revision 并说明；未知参数报错', async () => {
    const setup = makeV2('b-wpc-issues');
    setup.store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    await call(setup.leader.token, 'build_issues_submit', {
      issues: [{ issueKey: 'k1', severity: 'suggestion', description: '建议' }],
    });
    const tolerated = await call(setup.child.token, 'build_issues_list', { listId: 'il_1' }, meta('r1', 'diting'));
    const joined = tolerated.content.map((block) => block.text).join();
    expect(joined).toContain('已忽略参数 listId');
    await expect(call(setup.child.token, 'build_issues_list', { foo: 1 }, meta('r1', 'diting')))
      .rejects.toThrow(/build_issues_list 只接受/);
  });
  it('kb_tool_schema：tool 别名规范化；未授权工具错误列出当前可用面', async () => {
    const setup = makeV2('b-wpc-schema');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const byAlias = await call(setup.child.token, 'kb_tool_schema', { tool: 'raw_read' }, meta('w1', 'luban'));
    expect(byAlias.content.map((block) => block.text).join()).toContain('raw_read');
    await expect(call(setup.child.token, 'kb_tool_schema', { name: 'kb_get_plan' }, meta('w1', 'luban')))
      .rejects.toThrow(/kb_get_plan 不在当前角色工具面.*当前可用：.*raw_read/s);
  });
});

// ============================================================================
// 5. csvTableImports.columns 列坐标规范化
// ============================================================================
describe('WP-C：csvTableImports.columns 列坐标容错', () => {
  it('"@A"/"B"/"1" 规范化为 0 起始整数列位（A→0、B→1）', async () => {
    const state = makeBuildState('csv-cols-tol');
    const result = await call(tokenFor(state), 'kb_write_doc', {
      path: '战斗/列坐标.md', markdown: '## 清单\n{{kb-csv-table:t}}',
      csvTableImports: [{ key: 't', sourceId: 'tokB', csvName: CSV_NAME, columns: ['@A', 'B'], headerRecord: 1, firstRecord: 2 }],
      sources: ['tokB'], summary: '列坐标测试',
    });
    expect(result.content[0]!.text).toContain('已写入草稿');
    const file = fs.readFileSync(path.join(state.stagingRoot, 'docs', '战斗/列坐标.md'), 'utf8');
    expect(file).toContain('| 列 | 值 |');
    expect(file).toContain('| 1 | 多行');
  });
  it('对照：单元格引用 "C5" 等歧义形式报精确错误', async () => {
    const state = makeBuildState('csv-cols-err');
    await expect(call(tokenFor(state), 'kb_write_doc', {
      path: '战斗/列坐标错.md', markdown: '## 清单\n{{kb-csv-table:t}}',
      csvTableImports: [{ key: 't', sourceId: 'tokB', csvName: CSV_NAME, columns: ['C5'], headerRecord: 1, firstRecord: 2 }],
      sources: ['tokB'], summary: '列坐标测试',
    })).rejects.toThrow(/columns\[0\] 无法解析.*C5/s);
  });
});

// ============================================================================
// 6. evidenceClaims 同 clientKey 重复（kb_write_doc / kb_edit_doc）
// ============================================================================
describe('WP-C：evidenceClaims.clientKey 重复声明去重', () => {
  it('kb_write_doc：完全相同内容的重复声明去重容忍', async () => {
    const state = makeBuildState('ev-dup');
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: 'tokA', offset: 0, limit: 10 });
    const evidence = {
      clientKey: 'ev1', objectKey: 'damage', claimKey: 'multiplier',
      selector: { kind: 'text_span' as const, lineStart: 2, lineEnd: 2 },
    };
    await call(token, 'kb_write_doc', {
      path: '战斗/重复证据.md', markdown: '## 倍率\n倍率 2.0。',
      sources: ['tokA'], summary: '重复证据', objects: [BASE_OBJECT],
      evidenceClaims: [evidence, { ...evidence }],
    });
    const draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf8')) as {
      evidence: unknown[];
    };
    expect(draft.evidence).toHaveLength(1);
  });
  it('kb_write_doc：同键不同内容报冲突并指向两种修法', async () => {
    const state = makeBuildState('ev-conflict');
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: 'tokA', offset: 0, limit: 10 });
    await expect(call(token, 'kb_write_doc', {
      path: '战斗/冲突证据.md', markdown: '## 倍率\n倍率 2.0。',
      sources: ['tokA'], summary: '冲突证据', objects: [BASE_OBJECT],
      evidenceClaims: [
        { clientKey: 'ev1', objectKey: 'damage', claimKey: 'multiplier', selector: { kind: 'text_span', lineStart: 2, lineEnd: 2 } },
        { clientKey: 'ev1', objectKey: 'damage', claimKey: 'multiplier', selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 } },
      ],
    })).rejects.toThrow(/clientKey 重复且内容不同.*evidenceSelectorUpdates/s);
  });
  it('kb_edit_doc：重发服务端补齐的 ev_auto_* 键（内容相同）去重容忍；同键不同 selector 报冲突', async () => {
    const setup = makeV2('b-wpc-edit-dup');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const docPath = 'docs/evidence.md';
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: [docPath] });
    await call(setup.child.token, 'raw_read', { objToken: 'tokA', offset: 0, limit: 10 }, meta('w1', 'luban'));
    await call(setup.child.token, 'kb_write_doc', {
      path: docPath, markdown: '## 倍率\n倍率 2.0。', sources: ['tokA'], summary: '证据',
      objects: [BASE_OBJECT],
      evidenceClaims: [{ objectKey: 'damage', claimKey: 'multiplier', selector: { kind: 'text_span', lineStart: 2, lineEnd: 2 } }],
    }, meta('w1', 'luban'));
    // 服务端自动补齐的 ev_auto_* 键登记在 knowledge-draft.evidenceKeys
    const draftFile = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
    const seeded = JSON.parse(fs.readFileSync(draftFile, 'utf8')) as { evidenceKeys: Record<string, string> };
    const autoKey = Object.keys(seeded.evidenceKeys).find((key) => key.startsWith('ev_auto_'));
    expect(autoKey).toBeTruthy();
    // 内容相同 → 去重容忍，编辑成功且证据数不变
    const edit = await call(setup.child.token, 'kb_edit_doc', {
      path: docPath, operationId: 'edit-resend',
      evidenceClaimsAdd: [{
        clientKey: autoKey, objectKey: 'damage', claimKey: 'multiplier',
        selector: { kind: 'text_span', lineStart: 2, lineEnd: 2 },
      }],
    }, meta('w1', 'luban'));
    expect(edit.content[0]!.text).toContain(docPath);
    const afterDedupe = JSON.parse(fs.readFileSync(draftFile, 'utf8')) as { evidence: unknown[] };
    expect(afterDedupe.evidence).toHaveLength(1);
    // 同键不同 selector → 冲突错误并指向两种修法
    await expect(call(setup.child.token, 'kb_edit_doc', {
      path: docPath, operationId: 'edit-conflict',
      evidenceClaimsAdd: [{
        clientKey: autoKey, objectKey: 'damage', claimKey: 'multiplier',
        selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 },
      }],
    }, meta('w1', 'luban'))).rejects.toThrow(/clientKey 重复且内容不同.*evidenceSelectorUpdates/s);
  });
  it('kb_edit_doc：无 clientKey 追加同身份新证据不再被自动键冲突阻断', async () => {
    const setup = makeV2('b-wpc-edit-add');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const docPath = 'docs/evidence3.md';
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: [docPath] });
    await call(setup.child.token, 'raw_read', { objToken: 'tokA', offset: 0, limit: 10 }, meta('w1', 'luban'));
    await call(setup.child.token, 'kb_write_doc', {
      path: docPath, markdown: '## 倍率\n倍率 2.0。', sources: ['tokA'], summary: '证据',
      objects: [BASE_OBJECT],
      evidenceClaims: [{ objectKey: 'damage', claimKey: 'multiplier', selector: { kind: 'text_span', lineStart: 2, lineEnd: 2 } }],
    }, meta('w1', 'luban'));
    const edit = await call(setup.child.token, 'kb_edit_doc', {
      path: docPath, operationId: 'edit-add',
      evidenceClaimsAdd: [{
        objectKey: 'damage', claimKey: 'multiplier',
        selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 },
      }],
    }, meta('w1', 'luban'));
    expect(edit.content[0]!.text).toContain(docPath);
    const draft = JSON.parse(fs.readFileSync(path.join(setup.state.stagingRoot, 'knowledge-draft.json'), 'utf8')) as {
      evidence: unknown[]; evidenceKeys: Record<string, string>;
    };
    expect(draft.evidence).toHaveLength(2);
    expect(new Set(Object.keys(draft.evidenceKeys)).size).toBe(2);
  });
});
// ============================================================================
// 7. kb_evidence_unresolved 自动修复提示
// ============================================================================
describe('WP-C：kb_evidence_unresolved 自动修复提示', () => {
  it('(a) CSV 全空证据附上同 record 范围实际非空列', async () => {
    const state = makeBuildState('hint-empty');
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: 'tokB', offset: 0, limit: 20 });
    await expect(call(token, 'kb_write_doc', {
      path: '战斗/空列提示.md', markdown: '## 空列\n非空断言。',
      sources: ['tokB'], summary: '空列提示', objects: [BASE_OBJECT],
      evidenceClaims: [{ objectKey: 'damage', claimKey: 'multiplier', selector: {
        kind: 'csv_cells', resourcePath: CSV_NAME, parserVersion: 'v1', recordStart: 2, recordEnd: 3, columns: ['空列'],
      } }],
    })).rejects.toThrow(/选中的单元格全为空.*该 record 范围实际非空列：@A, @B/s);
  });
  it('(b) 文本证据无回执时附上精确 raw_read 参数（按 selector 与 segment 交集换算的输出窗口，R4-02）', async () => {
    const state = makeBuildState('hint-text');
    const token = tokenFor(state);
    await expect(call(token, 'kb_write_doc', {
      path: '战斗/无回执.md', markdown: '## 倍率\n倍率 2.0。',
      sources: ['tokA'], summary: '无回执', objects: [BASE_OBJECT],
      evidenceClaims: [{ objectKey: 'damage', claimKey: 'multiplier', selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 } }],
    })).rejects.toThrow(/没有覆盖所选范围的 raw_read 回执.*raw_read\(objToken:"tokA", offset:2, limit:1\).*资源行 3\.\.3/s);
  });
  it('(c) CSV 证据无回执时附上精确 raw_csv_cells 参数', async () => {
    const state = makeBuildState('hint-csv');
    const token = tokenFor(state);
    await expect(call(token, 'kb_write_doc', {
      path: '战斗/无回执csv.md', markdown: '## 表\n引用表格值。',
      sources: ['tokB'], summary: '无回执csv', objects: [BASE_OBJECT],
      evidenceClaims: [{ objectKey: 'damage', claimKey: 'multiplier', selector: {
        kind: 'csv_cells', resourcePath: CSV_NAME, parserVersion: 'v1', recordStart: 2, recordEnd: 2, columns: ['值'],
      } }],
    })).rejects.toThrow(/没有覆盖所选范围的 raw_read 回执.*raw_csv_cells\(objToken:"tokB", resourceId:"tokB#csv:表.csv", recordStart:2, recordEnd:2\)/s);
  });
  it('(d) 显式回执范围不足时（物理行超出回执）同样附补读建议', async () => {
    const state = makeBuildState('hint-range');
    const token = tokenFor(state);
    const firstRecord = await call(token, 'raw_csv_cells', {
      objToken: 'tokB', resourceId: `tokB#csv:${CSV_NAME}`, recordStart: 1, recordEnd: 1,
    });
    const receiptId = (firstRecord.details as Record<string, unknown>).readReceiptId as string;
    expect(receiptId).toMatch(/^rr_/);
    await expect(call(token, 'kb_write_doc', {
      path: '战斗/超范围.md', markdown: '## 表\n引用表格值。',
      sources: ['tokB'], summary: '超范围', objects: [BASE_OBJECT],
      evidenceClaims: [{
        objectKey: 'damage', claimKey: 'multiplier', readReceiptId: receiptId,
        selector: { kind: 'csv_cells', resourcePath: CSV_NAME, parserVersion: 'v1', recordStart: 2, recordEnd: 2, columns: ['值'] },
      }],
    })).rejects.toThrow(/超出回执范围.*raw_csv_cells\(objToken:"tokB", resourceId:"tokB#csv:表.csv", recordStart:2, recordEnd:2\)/s);
  });
});

// ============================================================================
// 8. R4 复审：真实下发 schema 接缝——别名入参必须在客户端校验层（JSON Schema）
//    就能通过，而不是只靠服务端 normalizer。用 ajv 对 tool-specs 导出的
//    spec.parameters 做真校验（与 amagi/pi 客户端同源的下发 schema）。
// ============================================================================
describe('R4 复审：真实下发 schema 接缝（ajv 校验 spec.parameters）', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });

  it.each([
    ['raw_search+queries', RAW_SEARCH_SPEC, { queries: ['伤害'] }],
    ['raw_search+objToken+query', RAW_SEARCH_SPEC, { objToken: 'tokA', query: '伤害' }],
    ['raw_search 仅 objToken（无 query）', RAW_SEARCH_SPEC, { objToken: 'tokA' }],
    ['draft_search+queries', DRAFT_SEARCH_SPEC, { queries: ['伤害'] }],
    ['draft_search+path', DRAFT_SEARCH_SPEC, { query: '伤害', path: '战斗/' }],
    ['draft_read+docPath', DRAFT_READ_SPEC, { docPath: 'a.md' }],
    ['draft_read+paths', DRAFT_READ_SPEC, { paths: ['a.md'] }],
    ['draft_read+kind', DRAFT_READ_SPEC, { path: 'a.md', kind: 'draft' }],
    ['kb_tool_schema+tool', KB_TOOL_SCHEMA_SPEC, { tool: 'draft_read' }],
    ['raw_csv_cells+columns+recordStart0', RAW_CSV_CELLS_SPEC, { objToken: 't', resourceId: 'r', recordStart: 0, recordEnd: 1, columns: ['@A'] }],
    ['raw_csv_find 24 项', RAW_CSV_FIND_SPEC, { objToken: 't', resourceId: 'r', queries: Array.from({ length: 24 }, (_, i) => `词${i}`) }],
    ['kb_read_batch 顶层单对象', KB_READ_BATCH_SPEC, { kind: 'raw', objToken: 't', offset: 0, limit: 5 }],
    ['kb_read_batch 仅 cursor', KB_READ_BATCH_SPEC, { cursor: 'abc' }],
    ['build_issues_list+listId', BUILD_ISSUES_LIST_SPEC, { listId: 'il_1' }],
    ['draft_list+limit', DRAFT_LIST_SPEC, { limit: 50 }],
    ['build_handoff_submit 对象项', BUILD_HANDOFF_SUBMIT_SPEC, { summary: 's', openIssues: [{ description: 'd', path: 'x.md' }] }],
  ])('%s：别名入参通过客户端 schema 校验', (_name, spec, args) => {
    const valid = ajv.validate(spec.parameters as object, args);
    expect(ajv.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it.each([
    ['raw_search 空', RAW_SEARCH_SPEC, {}],
    ['draft_search 空', DRAFT_SEARCH_SPEC, {}],
    ['draft_read 缺 path/docPath/paths', DRAFT_READ_SPEC, { offset: 0 }],
    ['kb_tool_schema 空', KB_TOOL_SCHEMA_SPEC, {}],
  ])('%s：canonical 缺失且无别名时 schema 放行（required 已移除），由服务端拒并给出精确错误', (_name, spec, args) => {
    // required 移除后 schema 不再拦——拒绝语义移到 normalizeToolArguments。
    expect(ajv.validate(spec.parameters as object, args)).toBe(true);
  });

  it.each([
    ['raw_search', 'raw_search 需要参数 query'],
    ['draft_search', 'draft_search 需要参数 query'],
    ['draft_read', 'draft_read 需要参数 path'],
    ['kb_tool_schema', 'kb_tool_schema 需要参数 name'],
  ])('%s：服务端对 canonical 缺失+无别名报精确错误', (tool, message) => {
    expect(() => normalizeToolArguments(tool, tool === 'draft_read' ? { offset: 0 } : {}))
      .toThrow(new RegExp(message.replace(/[()]/g, '\\$&')));
  });

  it('required 保留的工具：缺真实必填项仍在 schema 层被拒（列真实参数名的一次可修复错误）', () => {
    // WP-E（E5）：raw_csv_find 的 resourceId 已移出 required（缺省时服务端
    // 按唯一附件解析），此处不再拦截；raw_csv_cells 仍保持 required。
    expect(ajv.validate(RAW_CSV_FIND_SPEC.parameters as object, { objToken: 't', queries: ['短语'] })).toBe(true);
    expect(ajv.validate(RAW_CSV_CELLS_SPEC.parameters as object, { objToken: 't', resourceId: 'r' })).toBe(false);
  });
});
