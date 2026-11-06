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
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { KbVersionStore } from '../src/kb/kb-version-store.js';
import { collectAuthorityValidatedReports, resolveCurrentReviewDependencies, scopedReviewDeclarationHash } from '../src/kb/review-authority.js';
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

  it('build_manifest exposes remembered stage blockers without the internal cache key', async () => {
    const setup = makeV2('b-stage-blocked-status');
    setup.state.progressiveBlocked = new Map([['rules.md', { key: 'private-key', at: '2026-01-01',
      groups: [{ code: 'kb_link_invalid', count: 1, examples: ['missing.md'] }] }]]);
    const manifest = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
    expect(manifest.documentWorkStatus.stageBlockedPaths).toEqual([
      { path: 'rules.md', groups: [{ code: 'kb_link_invalid', count: 1, examples: ['missing.md'] }] },
    ]);
  });

  it.each([[false, 'merge', false], [true, 'merge', false], [true, 'remove', false], [true, 'merge', true]] as const)('Leader 可登记有依据的迁移（旧对象无逐条证据=%s，类型=%s，同文档来源细化=%s）', async (legacy, kind, sourceCorrection) => {
    const buildId = `b-leader-migration-${legacy}-${kind}-${sourceCorrection}`;
    const localOutput = path.join(dataRoot, `migration-output-${legacy}-${kind}-${sourceCorrection}`);
    const releaseId = 'migration-base';
    fs.mkdirSync(path.join(localOutput, 'releases', releaseId), { recursive: true });
    fs.writeFileSync(path.join(localOutput, 'CURRENT.json'), JSON.stringify({ releaseId, publishedAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(localOutput, 'releases', releaseId, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, releaseId, buildId: 'prior-build', publishedAt: new Date().toISOString(),
      mode: 'full', baseReleaseId: null, model: null,
      docs: [{ path: '旧篇.md', docId: 'kd_old', title: '旧篇', summary: '旧正式文档', tags: [],
        contentHash: 'sha256:fixture', sources: ['tokA'], bytes: 10 }], sourceSnapshot: [],
    }));
    fs.writeFileSync(path.join(localOutput, 'releases', releaseId, 'knowledge.json'), JSON.stringify({
      schemaVersion: 1, documents: [], objects: [{ objectId: 'ko_old', title: '灾荒事件', familyKey: 'old-event',
        canonical: { path: '旧篇.md' }, claims: [{ claimKey: 'old-event-trigger', bodyRange: { startLine: 2, endLine: 2 }, evidenceIds: [] }] }], evidence: legacy ? [] : [{ objectId: 'ko_old', sourceRef: { sourceId: 'tokA' } }],
      presentations: [], relations: [], coverage: [], migrations: [],
    }));
    fs.mkdirSync(path.join(localOutput, 'releases', releaseId, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(localOutput, 'releases', releaseId, 'docs', '旧篇.md'), '# 旧篇\n旧版灾荒触发规则。\n');
    const setup = makeV2(buildId);
    const nextPath = sourceCorrection ? '旧篇.md' : '新篇.md';
    if (sourceCorrection) setup.state.docMeta!.set(nextPath, { title: '新篇', summary: '来源精确化', tags: [], sources: ['tokA', 'tokB'] });
    const leader = service.createRunContext({
      runKind: 'build', buildId, outputRoot: localOutput, knowledgeBaseRoot: kbRoot,
      buildState: setup.state, allowedToolsOverride: [...V2_LEADER_TOOLS],
      orchestration: { mode: 'pi-amagi', buildId, generation: 1,
        credential: 'leader', actorStore: setup.store },
    });
    fs.writeFileSync(path.join(setup.state.stagingRoot, 'knowledge-draft.json'), JSON.stringify({
      schemaVersion: 1, buildId, docs: { [nextPath]: { docId: 'kd_new', revision: 1 } },
      clientKeys: {}, evidenceKeys: {}, objects: [{ objectId: 'ko_new', title: '灾荒事件', familyKey: 'new-event',
        canonical: { path: nextPath } }], evidence: [{ objectId: 'ko_new', sourceRef: { sourceId: sourceCorrection ? 'tokB' : 'tokA' } }],
      presentations: [], relations: [], coverage: [], calls: {},
    }));
    const before = JSON.parse((await call(leader.token, 'build_manifest', {})).content[0]!.text);
    expect(before.identityGapCount).toBe(1);
    expect(before.identityGaps[0].priorClaims).toEqual([{ claimKey: 'old-event-trigger', text: '旧版灾荒触发规则。' }]);
    expect(before.identityGaps[0].candidates[0].objectId).toBe('ko_new');
    if (legacy) expect(before.identityGaps[0].priorDocumentSources).toEqual(['tokA']);
    await expectToolError(() => call(leader.token, 'build_register_migrations', { migrations: [{
      objectId: 'ko_old', kind: 'merge', successorObjectIds: ['ko_missing'], reason: '规则迁往新篇',
    }] }), 'kb_migration_invalid');
    const migration = { objectId: 'ko_old', kind, successorObjectIds: kind === 'remove' ? [] : ['ko_new'],
      reason: kind === 'remove' ? '核对 tokA 当前来源与独立审查后确认旧规则无据，已从正文和引用中移除' : '规则迁往新篇' };
    const recorded = await call(leader.token, 'build_register_migrations', { migrations: [migration] });
    expect(recorded.details?.accepted).toBe(1);
    const replay = await call(leader.token, 'build_register_migrations', { migrations: [migration] });
    expect(replay.details?.reused).toBe(1);
    const plan = JSON.parse(fs.readFileSync(path.join(setup.state.stagingRoot, 'organization-plan.json'), 'utf8'));
    expect(plan.migrations).toEqual([migration]);
    const after = JSON.parse((await call(leader.token, 'build_manifest', {})).content[0]!.text);
    expect(after.identityGapCount).toBe(0);
  });

  it('build_manifest distinguishes blocking publication failures from historical warnings', async () => {
    const buildId = 'b-publication-severity'; const setup = makeV2(buildId);
    const reportDir = path.join(outputRoot, '.builds', buildId); fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({ issues: [
      { code: 'kb_evidence_unresolved', severity: 'blocking', message: 'missing current evidence' },
      { code: 'kb_evidence_unresolved', severity: 'warning', message: 'legacy nonblocking evidence warning' },
      { code: 'kb_migration_invalid', message: 'old report omitted severity' },
    ] }));
    const body = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
    expect(body.lastPublicationReport).toMatchObject({ blockingCount: 1, warningCount: 1, unknownSeverityCount: 1,
      blockingGroups: [{ code: 'kb_evidence_unresolved', severity: 'blocking', examples: ['missing current evidence'] }],
      warningGroups: [{ code: 'kb_evidence_unresolved', severity: 'warning', examples: ['legacy nonblocking evidence warning'] }] });
  });

  it('build_manifest 分页与 workset changeType', async () => {
    const setup = makeV2('b-leader3');
    setup.state.requiredRewrites = new Set(['docs/rebuild.md']);
    const page1 = await call(setup.leader.token, 'build_manifest', { limit: 1 });
    const body1 = JSON.parse(page1.content[0]!.text);
    expect(body1.entries).toHaveLength(1);
    expect(body1.requiredRewrites).toEqual(['docs/rebuild.md']);
    expect(body1.entries[0].changeType).toBe('added');
    expect(body1.nextCursor).toBeTruthy();
    const page2 = await call(setup.leader.token, 'build_manifest', { limit: 1, cursor: body1.nextCursor });
    expect(JSON.parse(page2.content[0]!.text).entries).toHaveLength(1);
    expect(JSON.parse(page2.content[0]!.text).nextCursor).toBeNull();
  });

  it('工作集清单按 12 项封顶，避免大批量首轮阻塞派发', async () => {
    const setup = makeV2('b-manifest-first-page');
    const sources = Array.from({ length: 13 }, (_, index) => {
      const token = `page-${index}`;
      const relPath = `manifest-page-${index}.md`;
      writeRaw(relPath, `# 来源 ${index}\n\n独立规则 ${index}\n`);
      return entry(token, relPath);
    });
    setup.state.snapshot = RawSourceSnapshot.fromEntries(sources, { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] });
    setup.state.workset = new Map(sources.map((source) => [source.objToken, 'added'] as const));

    const first = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
    expect(first.total).toBe(13);
    expect(first.entries).toHaveLength(12);
    expect(first.nextCursor).toBeTruthy();
    const requestedWide = JSON.parse((await call(setup.leader.token, 'build_manifest', { limit: 50 })).content[0]!.text);
    expect(requestedWide.entries).toHaveLength(12);
    const last = JSON.parse((await call(setup.leader.token, 'build_manifest', { cursor: first.nextCursor })).content[0]!.text);
    expect(last.entries).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    const background = JSON.parse((await call(setup.leader.token, 'build_manifest', { scope: 'all', limit: 50 })).content[0]!.text);
    expect(background.entries).toHaveLength(13);
  });

  it('build_manifest 提前给出长源规模和子表边界，不传全文', async () => {
    const longSource = ['# 长表', '## 子表: ①规则', ...Array.from({ length: 1250 }, () => '规则行'), '## 子表: ②配置', '配置行'].join('\n');
    writeRaw('src-b.md', longSource);
    try {
      const setup = makeV2('b-manifest-shape');
      const body = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
      const shape = body.entries.find((source: { objToken: string }) => source.objToken === 'tokB')?.sourceShape;
      expect(shape).toMatchObject({ totalLines: 1254, sectionCount: 2, attachmentCount: 0,
        sections: [{ line: 2, heading: '子表: ①规则' }, { line: 1253, heading: '子表: ②配置' }] });
      expect(body.entries.find((source: { objToken: string }) => source.objToken === 'tokB')).not.toHaveProperty('content');
    } finally { writeRaw('src-b.md', RAW_B); }
  });

  it('build_manifest 给出 CSV 附件的 raw_read 跳读坐标并识别空白附件', async () => {
    const markdown = '# 源B\n## 子表: ①规则\n正文';
    const csv = writeRaw('rules.csv', '字段,值\n步长,1\n');
    const blank = writeRaw('blank.csv', ' , \n');
    const source = writeRaw('src-b.md', markdown);
    try {
      const setup = makeV2('b-manifest-csv-shape');
      const other = setup.state.snapshot.get('tokA')!;
      setup.state.snapshot = RawSourceSnapshot.fromEntries([
        other, { ...entry('tokB', 'src-b.md'), objType: 'sheet', contentHash: computeSourceHash(source, [csv, blank], kbRoot) },
      ], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: (token) => token === 'tokB' ? [csv, blank] : [] });
      const body = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
      const shape = body.entries.find((item: { objToken: string }) => item.objToken === 'tokB')?.sourceShape;
      expect(shape).toMatchObject({ totalLines: 10, attachmentCount: 2, sections: [{ line: 2, heading: '子表: ①规则' }] });
      expect(shape.attachments[0]).toMatchObject({ label: 'rules.csv', outputStart: 6, outputEnd: 8 });
      expect(shape.attachments[1]).toMatchObject({ label: 'blank.csv', nonEmptyCells: 0, outputStart: null, outputEnd: null });
    } finally {
      writeRaw('src-b.md', RAW_B);
      fs.rmSync(csv, { force: true });
      fs.rmSync(blank, { force: true });
    }
  });

  it('build_manifest 在派发前标记飞书权限占位源', async () => {
    writeRaw('src-b.md', '# 源B\n\n> **注意**: 该文档在飞书侧权限受限（当前账号无访问权限，API 返回 40403 no permission），无法获取内容。\n\n> 如需查阅，请在飞书中向文档所有者申请权限后重新获取。');
    try {
      const setup = makeV2('b-manifest-permission');
      const body = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
      expect(body.entries.find((source: { objToken: string }) => source.objToken === 'tokB')?.sourceAvailability)
        .toBe('permission_denied_placeholder');
      expect(body.entries.find((source: { objToken: string }) => source.objToken === 'tokA')?.sourceAvailability)
        .toBe('available');
    } finally { writeRaw('src-b.md', RAW_B); }
  });

  it('build_manifest 在派发前标记未展开的同步引用', async () => {
    writeRaw('src-b.md', '<!--\nfeishu_sync:\n  obj_type: "docx"\n-->\n# 治理风格\n\n引用200的设计\n\n<synced_reference src-token="ref200"></synced_reference>');
    try {
      const setup = makeV2('b-manifest-unresolved-reference');
      const body = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
      expect(body.entries.find((source: { objToken: string }) => source.objToken === 'tokB')?.sourceAvailability)
        .toBe('unresolved_reference_placeholder');
    } finally { writeRaw('src-b.md', RAW_B); }
  });

  it('build_manifest 不把图片变化的工作集来源标为已发布版未变', async () => {
    const setup = makeV2('b-manifest-media-change');
    const original = setup.state.snapshot.get('tokA')!;
    setup.state.snapshot = RawSourceSnapshot.fromEntries([
      { ...original, mediaHash: 'sha256:new' },
      setup.state.snapshot.get('tokB')!,
    ], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] });
    setup.state.workset.set('tokA', 'changed');
    const readManifest = vi.spyOn(StandardKbStore.prototype, 'readManifest').mockReturnValue({
      sourceSnapshot: [{ ...original, mediaHash: 'sha256:old' }],
      docs: [],
    } as never);
    try {
      const manifest = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
      expect(manifest.entries.find((source: { objToken: string }) => source.objToken === 'tokA')).toMatchObject({
        changeType: 'changed',
        unchangedFromPublished: false,
      });
    } finally {
      readManifest.mockRestore();
    }
  });

  it('build_manifest 给增量任务当前变化的资源与跳读坐标', async () => {
    const setup = makeV2('b-manifest-source-delta');
    setup.state.workset.set('tokA', 'changed');
    const original = setup.state.snapshot.get('tokA')!;
    const readManifest = vi.spyOn(StandardKbStore.prototype, 'readManifest').mockReturnValue({
      releaseId: 'r_delta', sourceSnapshot: [{ ...original, contentHash: 'old' }], docs: [],
    } as never);
    const readContents = vi.spyOn(KbVersionStore.prototype, 'readSourceContents').mockReturnValue({
      tokA: RAW_A.replace('甲节内容行1', '旧规则'),
    });
    try {
      const manifest = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
      expect(manifest.entries.find((source: { objToken: string }) => source.objToken === 'tokA')).toMatchObject({
        changeSummary: { baselineAvailable: true, unchangedResources: 0,
          changes: [{ resourceId: 'tokA', change: 'changed', outputStart: expect.any(Number), outputEnd: expect.any(Number) }] },
      });
      // The hints do not manufacture a read receipt or mark a document written.
      expect(setup.state.writtenPaths?.size ?? 0).toBe(0);
    } finally { readManifest.mockRestore(); readContents.mockRestore(); }
  });

  it('build_manifest 公开按类型归组的发布诊断，不把旧报告当作通过凭据', async () => {
    const setup = makeV2('b-manifest-gate-report');
    const root = path.join(outputRoot, '.builds', 'b-manifest-gate-report');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ generatedAt: '2026-11-04T16:00:00Z',
      issues: [{ code: 'kb_migration_invalid', message: 'missing old identity' },
        { code: 'kb_migration_invalid', message: 'missing another identity' },
        { code: 'kb_coverage_invalid', message: 'ordinary warning' }] }));
    const manifest = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
    expect(manifest.lastPublicationReport).toMatchObject({ generatedAt: '2026-11-04T16:00:00Z',
      groups: [{ code: 'kb_migration_invalid', count: 2, examples: ['missing old identity', 'missing another identity'] },
        { code: 'kb_coverage_invalid', count: 1 }] });
    expect(manifest.lastPublicationReport.note).toContain('不是通过凭据');
  });

  it('build_manifest 不把新识别的旧图片证据当作已发布版未变', async () => {
    const setup = makeV2('b-manifest-vision-improved');
    const original = setup.state.snapshot.get('tokA')!;
    setup.state.workset.set('tokA', 'rebuild');
    setup.state.imageDescriptions = new Map([['tokA', new Map([['diagram.png', {
      src: 'diagram.png', imageHash: 'image-hash', state: 'described' as const, text: '图中的新规则',
    }]])]]);
    const readManifest = vi.spyOn(StandardKbStore.prototype, 'readManifest').mockReturnValue({
      sourceSnapshot: [original], docs: [],
    } as never);
    try {
      const manifest = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
      expect(manifest.entries.find((source: { objToken: string }) => source.objToken === 'tokA')).toMatchObject({
        changeType: 'rebuild', unchangedFromPublished: false,
      });
    } finally { readManifest.mockRestore(); }
  });

  it('增量构建默认清单只含工作集，完整快照必须显式查询', async () => {
    const setup = makeV2('b-manifest-workset');
    setup.state.workset.delete('tokB');
    const workset = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
    expect(workset.scope).toBe('workset');
    expect(workset.total).toBe(1);
    expect(workset.entries.map((entry: { objToken: string }) => entry.objToken)).toEqual(['tokA']);
    const all = JSON.parse((await call(setup.leader.token, 'build_manifest', { scope: 'all' })).content[0]!.text);
    expect(all.scope).toBe('all');
    expect(all.total).toBe(2);
    expect(all.entries.find((entry: { objToken: string }) => entry.objToken === 'tokB')?.changeType).toBeNull();
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
    expect(pendingSpecs).toContain('kb_tool_schema');
    // 无身份头 → 空面（与 amagi_task_missing 拒绝一致）
    const noIdentity = service.getToolSpecsForToken(setup.child.token)!.map((s) => s.name);
    expect(noIdentity).toEqual([]);
    // readOnlyHint 名单：读取类 true，写入类不带（内部 API 层附加 annotations）
    expect(service.isReadOnlyTool('raw_read')).toBe(true);
    expect(service.isReadOnlyTool('kb_write_doc')).toBe(false);
    expect(service.isReadOnlyTool('kb_edit_doc')).toBe(false);
    expect(service.isReadOnlyTool('build_handoff_list')).toBe(true);
    expect(service.isReadOnlyTool('kb_tool_schema')).toBe(true);
  });

  it('工具契约只对当前角色可见，写作可查 edit schema 而审查不可查', async () => {
    const setup = makeV2('b-tool-schema');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    const result = await call(setup.child.token, 'kb_tool_schema', { name: 'kb_edit_doc' }, meta('w1', 'luban'));
    const spec = JSON.parse(result.content[0]!.text!) as { name: string; parameters: unknown };
    expect(spec.name).toBe('kb_edit_doc');
    expect(spec.parameters).toMatchObject({ properties: { evidenceSelectorUpdates: { items: { properties: {
      evidenceId: { type: 'string' }, selector: { type: 'object' },
    } } } } });
    expect(spec.parameters).toMatchObject({ properties: { patches: { items: { properties: { anchor: { properties: { kind: {
      enum: ['exact_text', 'heading_body', 'line_range'],
    } } } } } } } });
    await expectToolError(() => call(setup.child.token, 'kb_tool_schema', { name: 'kb_edit_doc' }, meta('r1', 'diting')), 'tool_not_allowed');
  });
});

describe('写入链（§4.2/§4.4）', () => {
  it('automatically removes a verified blank workbook from source metadata on write and edit', async () => {
    const setup = makeV2('b-blank-source-filter');
    const md = writeRaw('blank.md', '# 空表\n\n## 子表: Sheet1\n\n[CSV 原始数据](blank.csv-data/Sheet1.csv)\n');
    const csvDir = path.join(kbRoot, 'blank.csv-data'); fs.mkdirSync(csvDir);
    const csv = path.join(csvDir, 'Sheet1.csv'); fs.writeFileSync(csv, ' , ,\n');
    setup.state.snapshot = RawSourceSnapshot.fromEntries([
      ...setup.state.snapshot.entries,
      { objToken: 'tokBlank', objType: 'sheet', title: '空表', relPath: 'blank.md',
        contentHash: computeSourceHash(md, [csv], kbRoot), objEditTime: null },
    ], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: (token) => token === 'tokBlank' ? [csv] : [] });
    setup.state.workset.set('tokBlank', 'added');
    setup.store.registerTaskCreation({ nativeTaskId: 'w-blank', requestedRole: 'luban' });
    const docPath = 'docs/normalized.md';
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w-blank', targets: [docPath] });
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', {
      path: docPath, title: '空表', markdown: '正文', sources: ['tokBlank'], summary: '摘要', operationId: 'blank-only',
    }, meta('w-blank', 'luban')), 'kb_source_empty_placeholder');
    await call(setup.child.token, 'kb_write_doc', {
      path: docPath, title: '正文', markdown: '正文', sources: ['tokA', 'tokBlank'], summary: '摘要', operationId: 'mixed',
    }, meta('w-blank', 'luban'));
    const file = path.join(setup.state.stagingRoot, 'docs', docPath);
    expect(fs.readFileSync(file, 'utf8')).toContain('    - tokA');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('tokBlank');
    // Simulate an older draft whose header still cites the empty workbook.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('    - tokA', '    - tokA\n    - tokBlank'));
    await call(setup.child.token, 'kb_edit_doc', {
      path: docPath, patches: [{ anchor: { kind: 'exact_text', oldText: '正文' }, newText: '正文修订' }], operationId: 'normalize-old',
    }, meta('w-blank', 'luban'));
    expect(fs.readFileSync(file, 'utf8')).not.toContain('tokBlank');
  });

  it('新目录尚无草稿时返回 not_found，随后可在该目录写入', async () => {
    const setup = makeV2('b-new-directory');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const path = '数据化舞台/地图数据结构.md';
    await expectToolError(() => call(setup.child.token, 'draft_read', { path }, meta('w1', 'luban')), 'not_found');
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: [path] });
    await call(setup.child.token, 'kb_write_doc', {
      path, title: '地图数据结构', markdown: '地图正文', sources: ['tokA'], summary: '地图摘要', operationId: 'op-new-directory',
    }, meta('w1', 'luban'));
    const draft = await call(setup.child.token, 'draft_read', { path }, meta('w1', 'luban'));
    expect(draft.content[0]!.text).toContain('地图正文');
  });

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

  it.each(['resume', 'fallback'] as const)('同篇阻断修订优先保留原作者分配（%s）', async (strategy) => {
    const setup = makeV2(`b-revision-${strategy}`);
    const docPath = 'docs/a.md';
    const leader = setup.leader.token;
    setup.store.registerTaskCreation({ nativeTaskId: 'writer', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'replacement', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'reviewer', requestedRole: 'diting' });
    await call(leader, 'build_assign_output', { ownerTaskId: 'writer', targets: [docPath] });
    const draft = { path: docPath, title: '初稿', markdown: '正文', sources: ['tokA'], summary: '摘要' };
    await call(setup.child.token, 'kb_write_doc', { ...draft, operationId: 'initial' }, meta('writer', 'luban'));
    const review = setup.store.recordReview({
      reviewerTaskId: 'reviewer', draftHash: 'draft', scopePaths: [docPath],
      dependencyHashes: { [`doc:${docPath}`]: 'body' }, ruleVersion: 'kb-review/1', verdict: 'needs_revision',
      issues: [{ issueId: 'missing-evidence', severity: 'blocking', draftLocation: docPath,
        sourceLocation: null, description: '补齐正文断言的源证据' }],
    });
    const manifest = await call(leader, 'build_manifest', {});
    expect(JSON.parse(manifest.content[0].text).documentWorkStatus.revisionContinuations).toEqual([
      { path: docPath, authorTaskId: 'writer', reviewId: review.reviewId },
    ]);
    await expectToolError(() => call(leader, 'build_revoke_output', { ownerTaskId: 'writer' }), 'kb_revision_resume_required');
    await expectToolError(() => call(leader, 'build_assign_output', { ownerTaskId: 'replacement', targets: [docPath] }), 'kb_revision_resume_required');
    expect(setup.store.activeAssignmentFor(docPath)?.ownerTaskId).toBe('writer');

    if (strategy === 'resume') {
      setup.store.registerTaskCreation({ nativeTaskId: 'continued', parentTaskId: 'writer', requestedRole: 'luban' });
      expect(setup.store.activeAssignmentFor(docPath)?.ownerTaskId).toBe('continued');
      expect(setup.store.revisionContinuationFor(docPath)?.authorTaskId).toBe('continued');
      expect(setup.store.lookupActor('writer')?.status).toBe('revoked');
      await call(setup.child.token, 'kb_write_doc', { ...draft, markdown: '修订正文', operationId: 'revision' }, meta('continued', 'luban'));
      expect(setup.store.listReviews().find((item) => item.reviewId === review.reviewId)?.status).toBe('stale');
      return;
    }

    const revisionFallback = { kind: 'resume_failed', reason: '原会话恢复失败，原作者上下文不可用' };
    await expectToolError(() => call(leader, 'build_revoke_output', { ownerTaskId: 'writer',
      revisionFallback: { kind: 'resume_failed', reason: ' ' } }), 'invalid_request');
    await call(leader, 'build_revoke_output', { ownerTaskId: 'writer', revisionFallback });
    await expectToolError(() => call(leader, 'build_assign_output', { ownerTaskId: 'replacement', targets: [docPath] }), 'kb_revision_resume_required');
    await call(leader, 'build_assign_output', { ownerTaskId: 'replacement', targets: [docPath], revisionFallback });
    expect(setup.store.activeAssignmentFor(docPath)?.ownerTaskId).toBe('replacement');
    expect(setup.store.eventsSince()).toContainEqual(expect.objectContaining({
      type: 'revision_reassigned', taskId: 'replacement', payload: {
        targets: [{ path: docPath, authorTaskId: 'writer', reviewId: review.reviewId }], fallback: revisionFallback,
      },
    }));
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
  async function writeDraftWithObject(setup: V2Setup, taskId: string, withCoverage = false, mergeTarget = false): Promise<void> {
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
      }, ...(mergeTarget ? [{
        clientKey: 'obj-successor', type: 'concept', title: '后继对象', familyKey: 'fam-successor',
        variantKey: 'default', scopeKey: 'scope', scopeText: '范围', headingPath: ['其他节'],
      }] : [])],
      evidenceClaims: [{
        clientKey: 'ev-1',
        objectKey: 'obj-main',
        claimKey: 'no-claim',
        sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
        selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 },
        role: 'supports',
        nature: 'direct',
        readReceiptId,
      }, ...(mergeTarget ? [{
        clientKey: 'ev-successor', objectKey: 'obj-successor', claimKey: 'no-claim',
        sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
        selector: { kind: 'text_span', lineStart: 3, lineEnd: 3 },
        role: 'supports', nature: 'direct', readReceiptId,
      }] : [])],
      ...(withCoverage ? { coverageUpdates: [{ itemId: 'cov-main', sourceId: 'tokA', category: 'rule',
        importance: 'important', disposition: mergeTarget ? 'mapped' : 'unresolved',
        ...(mergeTarget ? { targetKeys: ['obj-main'] } : { reason: '待映射' }) }] } : {}),
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

  it('draft_read metadataOnly 给出可见的编辑哈希和来源且不输出长正文', async () => {
    const setup = makeV2('b-read-metadata');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    const result = await call(setup.child.token, 'draft_read', { path: 'docs/edit.md', metadataOnly: true }, meta('w1', 'luban'));
    expect(result.content[0]!.text).toContain('<draft_metadata>');
    expect(result.content[0]!.text).toContain('"editContentHash"');
    expect(result.content[0]!.text).toContain('"sources":["tokA"]');
    expect(result.content[0]!.text).not.toContain('甲节内容行1');
  });

  it('exact_text 编辑：声明继承（objectId 稳定、坐标平移）、审查失效、幂等', async () => {
    const setup = makeV2('b-edit1');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    setup.state.requiredRewrites = new Set(['docs/edit.md']);
    setup.state.writtenPaths = new Set();
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
    expect(setup.state.writtenPaths.has('docs/edit.md')).toBe(true);
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

  it('只更新已有证据的 selector：服务端继承其余声明并重新校验来源', async () => {
    const setup = makeV2('b-edit-evidence');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    const draftPath = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
    const bodyPath = path.join(setup.state.stagingRoot, 'docs', 'docs', 'edit.md');
    const before = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
    const body = fs.readFileSync(bodyPath, 'utf-8');
    const evidenceId = before.evidenceKeys['ev-1'] as string;
    const objectId = before.clientKeys['obj-main'] as string;

    const edited = await call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md', operationId: 'op-evidence',
      evidenceSelectorUpdates: [{ evidenceId, selector: { kind: 'text_span', lineStart: 4, lineEnd: 4 } }],
    }, meta('w1', 'luban'));
    expect(edited.details).toMatchObject({ edit: { inheritedDeclarations: true, patches: [] } });
    const after = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
    expect(fs.readFileSync(bodyPath, 'utf-8')).toBe(body);
    expect(after.evidenceKeys['ev-1']).toBe(evidenceId);
    expect(after.evidence.find((item: { evidenceId: string }) => item.evidenceId === evidenceId).selector)
      .toMatchObject({ kind: 'text_span', lineStart: 4, lineEnd: 4 });
    expect(after.objects.find((item: { objectId: string }) => item.objectId === objectId).reviewSubjectHash)
      .not.toBe(before.objects.find((item: { objectId: string }) => item.objectId === objectId).reviewSubjectHash);

    await expectToolError(() => call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md', operationId: 'op-evidence-bad',
      evidenceSelectorUpdates: [{ evidenceId: 'kev_other', selector: { kind: 'text_span', lineStart: 4, lineEnd: 4 } }],
    }, meta('w1', 'luban')), 'invalid_request');
  });

  it('只追加新证据时保留旧证据、对象身份和正文，并拒绝其他文档对象', async () => {
    const setup = makeV2('b-edit-evidence-add');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    const draftPath = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
    const bodyPath = path.join(setup.state.stagingRoot, 'docs', 'docs', 'edit.md');
    const before = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
    const body = fs.readFileSync(bodyPath, 'utf-8');
    const firstEvidenceId = before.evidenceKeys['ev-1'] as string;
    const objectId = before.clientKeys['obj-main'] as string;

    const args = { path: 'docs/edit.md', operationId: 'op-evidence-add', evidenceClaimsAdd: [{
      objectKey: 'obj-main', claimKey: 'no-claim',
      selector: { kind: 'text_span', lineStart: 4, lineEnd: 4 },
    }] };
    const edited = await call(setup.child.token, 'kb_edit_doc', args, meta('w1', 'luban'));
    expect(edited.details).toMatchObject({ edit: { inheritedDeclarations: true, evidenceAdded: 1 } });
    const after = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
    expect(fs.readFileSync(bodyPath, 'utf-8')).toBe(body);
    expect(after.clientKeys['obj-main']).toBe(objectId);
    expect(after.evidenceKeys['ev-1']).toBe(firstEvidenceId);
    expect(after.evidence.filter((item: { objectId: string }) => item.objectId === objectId)).toHaveLength(2);
    expect(after.evidence.find((item: { evidenceId: string }) => item.evidenceId === firstEvidenceId)).toBeTruthy();
    const replay = await call(setup.child.token, 'kb_edit_doc', args, meta('w1', 'luban'));
    expect(replay.details!.idempotentReplay).toBe(true);

    await expectToolError(() => call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md', operationId: 'op-evidence-wrong-object',
      evidenceClaimsAdd: [{ objectKey: 'ko_other', claimKey: 'no-claim', selector: { kind: 'text_span', lineStart: 4, lineEnd: 4 } }],
    }, meta('w1', 'luban')), 'invalid_request');
  });

  it('整体重写遗漏证据数组时拒绝清空已登记证据', async () => {
    const setup = makeV2('b-write-evidence-guard');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1');
    const draftPath = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
    const before = fs.readFileSync(draftPath, 'utf-8');
    await expectToolError(() => call(setup.child.token, 'kb_write_doc', {
      path: 'docs/edit.md', title: '编辑测试', markdown: '## 目标节\n\n重写正文',
      sources: ['tokA'], summary: '重写摘要', operationId: 'op-omit-evidence',
      objects: [{ clientKey: 'obj-main', type: 'concept', title: '主对象', familyKey: 'fam',
        variantKey: 'default', scopeKey: 'scope', scopeText: '范围', headingPath: ['目标节'] }],
    }, meta('w1', 'luban')), 'kb_evidence_registry_stale');
    expect(fs.readFileSync(draftPath, 'utf-8')).toBe(before);
  });

  it('只更新已有覆盖项去向：服务端继承来源、分类与对象证据', async () => {
    const setup = makeV2('b-edit-coverage');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1', true);
    const draftPath = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
    const bodyPath = path.join(setup.state.stagingRoot, 'docs', 'docs', 'edit.md');
    const before = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
    const body = fs.readFileSync(bodyPath, 'utf-8');
    const objectId = before.clientKeys['obj-main'];
    await call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md', operationId: 'op-coverage',
      coverageUpdates: [{ itemId: 'cov-main', disposition: 'mapped', targetKeys: ['obj-main'] }],
    }, meta('w1', 'luban'));
    const after = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
    expect(fs.readFileSync(bodyPath, 'utf-8')).toBe(body);
    expect(after.evidenceKeys).toEqual(before.evidenceKeys);
    expect(after.clientKeys['obj-main']).toBe(objectId);
    expect(after.coverage.find((item: { itemId: string }) => item.itemId === 'cov-main')).toMatchObject({
      category: 'rule', importance: 'important', disposition: 'mapped', targetObjectIds: [objectId],
    });
    await expectToolError(() => call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md', operationId: 'op-coverage-bad',
      coverageUpdates: [{ itemId: 'cov-main', sourceId: 'other', disposition: 'mapped', targetKeys: ['obj-main'] }],
    }, meta('w1', 'luban')), 'kb_coverage_invalid');
  });

  it('重复对象局部合并由服务端转移覆盖映射，不重填整篇声明或虚假排除', async () => {
    const setup = makeV2('b-edit-merge');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await writeDraftWithObject(setup, 'w1', true, true);
    const draftPath = path.join(setup.state.stagingRoot, 'knowledge-draft.json');
    const before = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
    const fromObjectId = before.clientKeys['obj-main'] as string;
    const toObjectId = before.clientKeys['obj-successor'] as string;
    await expectToolError(() => call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md', operationId: 'op-false-exclusion',
      coverageUpdates: [{ itemId: 'cov-main', disposition: 'excluded_nonknowledge', reason: '已转到别篇' }],
    }, meta('w1', 'luban')), 'kb_coverage_invalid');
    const result = await call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/edit.md', operationId: 'op-merge',
      objectMerges: [{ fromObjectId, toObjectId, reason: '同源重复对象由后继持有规则' }],
    }, meta('w1', 'luban'));
    expect(result.details?.edit).toMatchObject({ objectMerges: [{ fromObjectId, toObjectId }] });
    const after = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
    expect(after.objects.some((object: { objectId: string }) => object.objectId === fromObjectId)).toBe(false);
    expect(after.objects.some((object: { objectId: string }) => object.objectId === toObjectId)).toBe(true);
    expect(after.coverage.find((item: { itemId: string }) => item.itemId === 'cov-main'))
      .toMatchObject({ disposition: 'mapped', targetObjectIds: [toObjectId] });
    expect(after.evidence.some((evidence: { objectId: string }) => evidence.objectId === fromObjectId)).toBe(false);
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

  it('小 limit 的 draft 只返回一页且续页不重复声明', async () => {
    const setup = makeV2('b-batch-declarations');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/long.md'] });
    await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/long.md', title: '长稿', markdown: '第一行\n第二行\n第三行',
      sources: ['tokA'], summary: '分页声明', operationId: 'op-long',
    }, meta('w1', 'luban'));
    const first = JSON.parse((await call(setup.child.token, 'kb_read_batch', {
      requests: [{ kind: 'draft', path: 'docs/long.md', limit: 1, includeDeclarations: true }],
      maxLines: 400,
    }, meta('w1', 'luban'))).content[0]!.text);
    expect(first.results).toHaveLength(1);
    expect(first.linesUsed).toBe(1);
    expect(first.results[0].declarations).toBeTruthy();
    expect(first.nextCursor).toBeTruthy();
    const second = JSON.parse((await call(setup.child.token, 'kb_read_batch', {
      requests: [], cursor: first.nextCursor, maxLines: 400,
    }, meta('w1', 'luban'))).content[0]!.text);
    expect(second.results).toHaveLength(1);
    expect(second.results[0].offset).toBe(1);
    expect(second.results[0].declarations).toBeUndefined();
  });
});

describe('审查（§4.3）与交接/问题/发布（§5）', () => {
  async function seedDraft(setup: V2Setup, taskId: string, docPath: string, source = 'tokA'): Promise<void> {
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: taskId, targets: [docPath] });
    await call(setup.child.token, 'kb_write_doc', { path: docPath, title: 'T', markdown: `# 内容 ${docPath}\n正文`, sources: [source], summary: 's', operationId: `op-${docPath}` }, meta(taskId, 'luban'));
  }

  it('单篇审查只绑定其来源与正文；其他文档写入不使回执失效', async () => {
    const setup = makeV2('b-review-scope');
    setup.state.v2WorkflowRulesHash = 'test-workflow-hash';
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'w2', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    await seedDraft(setup, 'w1', 'docs/a.md', 'tokA');
    const scopedBefore = scopedReviewDeclarationHash(setup.state.stagingRoot, ['docs/a.md'], ['tokA']);
    await call(setup.child.token, 'kb_submit_review', { coverage: { sourceRefs: ['tokA'] }, issues: [], conclusion: 'pass' }, meta('r1', 'diting'));
    const receipt = setup.store.listReviews()[0]!;
    expect(receipt.scopePaths).toEqual(['docs/a.md']);
    expect(receipt.dependencyHashes['doc:docs/a.md']).toBeTruthy();
    expect(receipt.dependencyHashes['doc:docs/b.md']).toBeUndefined();
    await seedDraft(setup, 'w2', 'docs/b.md', 'tokB');
    expect(setup.store.listReviews()[0]!.status).toBe('valid');
    expect(scopedReviewDeclarationHash(setup.state.stagingRoot, ['docs/a.md'], ['tokA'])).toBe(scopedBefore);
    const authority = collectAuthorityValidatedReports({
      stagingRoot: setup.state.stagingRoot,
      store: setup.store,
      current: resolveCurrentReviewDependencies({ stagingRoot: setup.state.stagingRoot,
        snapshot: setup.state.snapshot, workflowRulesHash: setup.state.v2WorkflowRulesHash }),
      documentHashes: new Map(['a', 'b'].map((name) => {
        const docPath = `docs/${name}.md`;
        return [docPath, computeSourceHash(path.join(setup.state.stagingRoot, 'docs', docPath), [])];
      })),
    });
    expect(authority.skipped).toEqual([]);
    expect(authority.validReportIds).toEqual([setup.store.listReviews()[0]!.reportId]);
  });

  it('重要未解决覆盖项在复审提交时即阻止 pass，而不是拖到整批发布', async () => {
    const setup = makeV2('b-review-unresolved');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    await seedDraft(setup, 'w1', 'docs/a.md');
    setup.state.knowledgeDraft = { schemaVersion: 1, buildId: 'b-review-unresolved', docs: {}, clientKeys: {},
      evidenceKeys: {}, objects: [], presentations: [], relations: [], evidence: [], calls: {},
      coverage: [{ itemId: 'empty-sheet', sourceRef: { sourceId: 'tokA' },
        category: '占位配置表', importance: 'important', disposition: 'unresolved', targetObjectIds: [], reason: '待确认' }],
    } as any;
    await expectToolError(() => call(setup.child.token, 'kb_submit_review',
      { coverage: { sourceRefs: ['tokA'] }, issues: [], conclusion: 'pass' }, meta('r1', 'diting')),
    'kb_review_coverage_blocked');
    expect(setup.store.listReviews()).toHaveLength(0);
  });

  it('reviewer 提交审查：绑定 draftHash 与 ReviewReceipt；作者自审被拒；修订后审查失效', async () => {
    const setup = makeV2('b-review');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    setup.store.registerTaskCreation({ nativeTaskId: 'r1', requestedRole: 'diting' });
    await seedDraft(setup, 'w1', 'docs/r1.md');
    const reviewArgs = {
      coverage: { sourceRefs: ['tokA'] },
      issues: [{ draftLocation: 'docs/r1.md#L2', sourceLocation: '源A#甲节', description: '描述', severity: 'blocking' }],
      conclusion: 'needs_revision',
    };
    // 作者自审 → 拒
    await expectToolError(() => call(setup.child.token, 'kb_submit_review', reviewArgs, meta('w1', 'luban')), 'tool_not_allowed');
    const review = await call(setup.child.token, 'kb_submit_review', reviewArgs, meta('r1', 'diting'));
    expect(review.details!.draftHash).toBeTruthy();
    const replayedReview = await call(setup.child.token, 'kb_submit_review', reviewArgs, meta('r1', 'diting'));
    expect(replayedReview.details!.idempotentReplay).toBe(true);
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
    setup.store.registerTaskCreation({ nativeTaskId: 'w2', requestedRole: 'luban' });
    const submit = await call(setup.child.token, 'build_handoff_submit', { summary: '完成定位文档', artifactRefs: ['docs/h.md@1'], openIssues: ['公式未覆盖'], nextInfo: '请独立复核公式' }, meta('w1', 'luban'));
    expect(submit.details!.handoffId).toBeTruthy();
    const replay = await call(setup.child.token, 'build_handoff_submit', { summary: '完成定位文档', artifactRefs: ['docs/h.md@1'], openIssues: ['公式未覆盖'], nextInfo: ['请独立复核公式'] }, meta('w1', 'luban'));
    expect(replay.details!.idempotentReplay).toBe(true);
    const list = await call(setup.leader.token, 'build_handoff_list', {});
    const body = JSON.parse(list.content[0]!.text);
    expect(body.handoffs).toHaveLength(1);
    expect(body.handoffs[0].role).toBe('luban');
    expect(body.summaryOnly).toBe(true);
    const longSummary = `完成第二篇：${'规则和证据。'.repeat(90)}`;
    await call(setup.child.token, 'build_handoff_submit', {
      summary: longSummary, artifactRefs: ['docs/second.md@1'], openIssues: ['待复核公式完整范围'],
    }, meta('w2', 'luban'));
    const firstPage = JSON.parse((await call(setup.leader.token, 'build_handoff_list', { limit: 1 })).content[0]!.text);
    expect(firstPage.total).toBe(2);
    expect(firstPage.nextOffset).toBe(1);
    const secondPage = JSON.parse((await call(setup.leader.token, 'build_handoff_list', { offset: 1, limit: 1 })).content[0]!.text);
    expect(firstPage.handoffs[0].summary.length).toBe(160);
    expect(firstPage.handoffs[0].summaryTruncated).toBe(true);
    expect(firstPage.handoffs[0].openIssueCount).toBe(1);
    expect(secondPage.handoffs[0].summary).toBe('完成定位文档');
    const detail = JSON.parse((await call(setup.leader.token, 'build_handoff_list', { taskId: 'w2' })).content[0]!.text);
    expect(detail.handoffs[0].summary).toBe(longSummary);
    expect(detail.summaryOnly).toBeUndefined();
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

  it('跳过声明只接受工作集来源并原样传递到发布管线', async () => {
    const handler = vi.fn(async (_input: { skipped?: Array<{ objToken: string; reason: string }> }) => ({ accepted: true, result: {} }));
    const setup = makeV2('b-publish-skipped', handler);
    await expectToolError(() => call(setup.leader.token, 'build_request_publish', { skipped: [{ objToken: 'outside', reason: '空白' }] }), 'invalid_request');
    await expectToolError(() => call(setup.leader.token, 'build_request_publish', { skipped: [{ objToken: 'tokA', reason: '  ' }] }), 'invalid_request');
    expect(handler).not.toHaveBeenCalled();
    const result = await call(setup.leader.token, 'build_request_publish', { skipped: [{ objToken: 'tokA', reason: '无知识' }] });
    expect(result.details?.accepted).toBe(true);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ skipped: [{ objToken: 'tokA', reason: '无知识' }] });
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

  it('发布校验拒绝时把具体文档路径和问题写进模型可读正文与检查点', async () => {
    const setup = makeV2('b-publish-details', async () => ({ accepted: false, result: {
      reason: 'kb_validation_failed', reasons: ['affected_doc_not_updated'],
      details: { issues: [{ path: 'docs/old.md', code: 'affected_doc_not_updated', message: '来源已变化，需重写正文' }] },
    } }));
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await seedDraft(setup, 'w1', 'docs/old.md');
    const publish = await call(setup.leader.token, 'build_request_publish', {});
    expect(publish.content[0]!.text).toContain('affected_doc_not_updated [docs/old.md]：来源已变化，需重写正文');
    const status = await call(setup.leader.token, 'build_checkpoint', { action: 'status' });
    expect(JSON.parse(status.content[0]!.text).lastPublishRejection.issues[0].path).toBe('docs/old.md');
  });

  it('检查点不把已由阶段发布解决或上一代的拒绝当作当前阻断', async () => {
    const setup = makeV2('b-stale-publish-rejection');
    const request = setup.store.beginPublishWindow('candidate', null);
    setup.store.settlePublishRequest(request.requestId, 'rejected', {
      reason: 'kb_publish_blocked', message: '旧证据预算已超限',
    });
    const statusOf = async (token: string) => JSON.parse((await call(token, 'build_checkpoint', { action: 'status' })).content[0]!.text);
    expect((await statusOf(setup.leader.token)).lastPublishRejection.message).toContain('旧证据预算');

    const manifestSpy = vi.spyOn(StandardKbStore.prototype, 'readManifest').mockReturnValue({
      buildId: 'b-stale-publish-rejection', publishedAt: new Date(Date.now() + 60_000).toISOString(),
      docs: [], sourceSnapshot: [],
    } as never);
    try {
      expect((await statusOf(setup.leader.token)).lastPublishRejection).toBeNull();
    } finally { manifestSpy.mockRestore(); }

    setup.store.rotateGeneration(2, 'resume');
    setup.state.v2!.generation = 2;
    const resumed = service.createRunContext({
      runKind: 'build', buildId: 'b-stale-publish-rejection', outputRoot, knowledgeBaseRoot: kbRoot,
      buildState: setup.state, allowedToolsOverride: [...V2_LEADER_TOOLS],
      orchestration: { mode: 'pi-amagi', buildId: 'b-stale-publish-rejection', generation: 2,
        credential: 'leader', actorStore: setup.store },
    });
    expect((await statusOf(resumed.token)).lastPublishRejection).toBeNull();
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

  it('Leader 只把未发布草稿列为待处理，正式承接与未变化的阶段发布文档不触发补审', async () => {
    const setup = makeV2('b-document-work-status');
    const docs = { carried: 'docs/carried.md', promoted: 'docs/promoted.md', pending: 'docs/pending.md' };
    for (const docPath of Object.values(docs)) {
      const file = path.join(setup.state.stagingRoot, 'docs', docPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# ${docPath}\n`, 'utf8');
    }
    const promotedHash = contentResourceHash(fs.readFileSync(path.join(setup.state.stagingRoot, 'docs', docs.promoted), 'utf8'));
    const draft = { schemaVersion: 1, buildId: 'b-document-work-status', docs: {
      [docs.carried]: { docId: 'c', revision: 0, basis: 'published' },
      [docs.promoted]: { docId: 'p', revision: 2, basis: 'draft' },
      [docs.pending]: { docId: 'n', revision: 1, basis: 'draft' },
    }, objects: [] as Array<Record<string, unknown>> };
    fs.writeFileSync(path.join(setup.state.stagingRoot, 'knowledge-draft.json'), JSON.stringify(draft));
    setup.state.requiredRewrites = new Set([docs.promoted, docs.pending]);
    const manifestSpy = vi.spyOn(StandardKbStore.prototype, 'readManifest').mockReturnValue({
      buildId: 'b-document-work-status', releaseId: 'r_status', publicationStage: 'progressive',
      promotionHashes: { [docs.promoted]: promotedHash }, sourceSnapshot: [],
    } as never);
    const knowledgeSpy = vi.spyOn(KbVersionStore.prototype, 'readKnowledgeManifest').mockReturnValue({ objects: [] } as never);
    try {
      const manifest = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
      const status = JSON.parse((await call(setup.leader.token, 'build_checkpoint', { action: 'status' })).content[0]!.text);
      for (const value of [manifest.documentWorkStatus, status.documentWorkStatus]) {
        expect(value.carriedPublishedPaths).toEqual([docs.carried]);
        expect(value.promotedUnchangedPaths).toEqual([docs.promoted]);
        expect(value.unpublishedDraftPaths).toEqual([docs.pending]);
        expect(value.pendingRequiredRewrites).toEqual([docs.pending]);
        expect(value.pendingIndependentReviewPaths).toEqual([docs.pending]);
        expect(value.reviewedUnpublishedDraftPaths).toEqual([]);
      }
      setup.state.requiredRewrites.add(docs.carried);
      const visionRewrite = JSON.parse((await call(setup.leader.token, 'build_manifest', {})).content[0]!.text);
      expect(visionRewrite.documentWorkStatus.carriedPublishedPaths).toEqual([]);
      expect(visionRewrite.documentWorkStatus.unpublishedDraftPaths).toContain(docs.carried);
      expect(visionRewrite.documentWorkStatus.pendingRequiredRewrites).toContain(docs.carried);
      setup.state.requiredRewrites.delete(docs.carried);
      draft.objects.push({ objectId: 'o1', canonical: { path: docs.promoted }, reviewSubjectHash: 'changed' });
      fs.writeFileSync(path.join(setup.state.stagingRoot, 'knowledge-draft.json'), JSON.stringify(draft));
      const changed = JSON.parse((await call(setup.leader.token, 'build_checkpoint', { action: 'status' })).content[0]!.text);
      expect(changed.documentWorkStatus.promotedUnchangedPaths).toEqual([]);
      expect(changed.documentWorkStatus.unpublishedDraftPaths).toEqual([docs.pending, docs.promoted]);
    } finally {
      manifestSpy.mockRestore();
      knowledgeSpy.mockRestore();
    }
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
