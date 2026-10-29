/**
 * 标准库构建核心测试（设计 §12.1 KbBuildService 行）
 *
 * 纯确定性部分：增量变更集计算、源集合保留规则（changed/error 但有成功
 * 本地版本仍是合法源）、staging 校验失败不动指针、发布原子性（CURRENT
 * rename 前失败保留旧发布）、指针后 DB 失败的启动对账、outputRoot 校验、
 * 原始库构建前后哈希不变。
 *
 * 构建流水线的模型驱动部分（批次 prompt/完成判定）在 pi-probe 集成测试
 * 与真实模型 smoke 覆盖，本文件不 mock 模型冒充。
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupOldStaging,
  computeChangeset,
  KbBuildService,
  validateOutputRoot,
  validateStagingDocs,
  verifySnapshotIntact,
} from '../src/kb/kb-build-service.js';
import {
  RawSourceSnapshot,
  computeSourceHash,
  hasSuccessfulLocalVersion,
} from '../src/kb/raw-source-snapshot.js';
import { StandardKbStore, parseStdHeader } from '../src/kb/standard-kb-store.js';
import { AgentToolService, ToolError, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let dataRoot: string;
let kbRoot: string;      // 原始知识库根（模拟）
let outputRoot: string;  // 标准库输出
let store: LocalMapStore;
const openedStores: LocalMapStore[] = [];

function docRecord(overrides: Partial<DocumentRecord> & { objToken: string; localRelPath: string }): DocumentRecord {
  return {
    wikiNodeToken: null,
    objType: 'docx',
    title: overrides.title ?? overrides.objToken,
    localMdPath: path.join(kbRoot, overrides.localRelPath),
    lastSyncedModifyTime: '',
    lastSyncedAt: new Date().toISOString(),
    status: 'synced',
    ...overrides,
  } as DocumentRecord;
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbbuild-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbbuild-kb-'));
  outputRoot = path.join(dataRoot, 'standard-kb');
  fs.mkdirSync(path.join(dataRoot, 'agent'), { recursive: true });
  store = new LocalMapStore(path.join(dataRoot, 'feishu-sync.db'));
  openedStores.push(store);
  store.initialize();
});

afterAll(() => {
  for (const opened of openedStores) opened.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
});

function writeRaw(rel: string, content: string): void {
  const full = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function entry(token: string, rel: string, hash: string): RawSourceSnapshotEntry {
  return { objToken: token, objType: 'docx', title: token, relPath: rel, contentHash: hash, objEditTime: null };
}

describe('源集合保留规则（§6.1：不能只筛 status=synced）', () => {
  it('changed/error 但有成功本地版本 → 保留；placeholder/从未成功 → 排除', () => {
    expect(hasSuccessfulLocalVersion(docRecord({
      objToken: 'a', localRelPath: 'a.md', status: 'changed', syncedObjEditTime: 100,
    }))).toBe(true);
    expect(hasSuccessfulLocalVersion(docRecord({
      objToken: 'b', localRelPath: 'b.md', status: 'error', syncState: 'synced',
    }))).toBe(true);
    expect(hasSuccessfulLocalVersion(docRecord({
      objToken: 'c', localRelPath: 'c.md', status: 'error', syncState: 'error', syncedObjEditTime: null, lastSyncedAt: '',
    }))).toBe(false);
    expect(hasSuccessfulLocalVersion(docRecord({
      objToken: 'd', localRelPath: 'd.md', status: 'placeholder', lastSyncedAt: '',
    }))).toBe(false);
    // 历史兼容：仅 status='synced'
    expect(hasSuccessfulLocalVersion(docRecord({
      objToken: 'e', localRelPath: 'e.md', status: 'synced',
    }))).toBe(true);
  });

  it('保留旧索引成功时间戳；云端变化/删除观测不改变仍存在的本地源', () => {
    writeRaw('旧索引版本.md', '# 旧索引版本\n本地原始内容仍然存在');
    const old = docRecord({ objToken: 'legacy-observed', localRelPath: '旧索引版本.md',
      status: 'changed', syncState: 'pending_modified', syncedObjEditTime: null,
      lastSyncedAt: '2026-07-17T00:00:00.000Z' });
    expect(hasSuccessfulLocalVersion(old)).toBe(true);
    const before = RawSourceSnapshot.scan(kbRoot, [old]);
    const after = RawSourceSnapshot.scan(kbRoot, [{ ...old, cloudDeleted: 1, status: 'error', syncState: 'deleted_confirmed' }]);
    expect(before.entries).toHaveLength(1);
    expect(after.entries).toEqual(before.entries);
    expect(hasSuccessfulLocalVersion({ ...old, lastSyncedAt: 'not-a-date' })).toBe(false);
    fs.unlinkSync(path.join(kbRoot, old.localRelPath!));
    expect(RawSourceSnapshot.scan(kbRoot, [old]).entries).toHaveLength(0);
  });

  it('scan 产出快照且文件缺失的候选不进快照', () => {
    writeRaw('存在.md', '# 存在\n内容');
    const documents = [
      docRecord({ objToken: 'tok1', localRelPath: '存在.md', status: 'synced' }),
      docRecord({ objToken: 'tok2', localRelPath: '缺失.md', status: 'synced' }),
    ];
    const result = RawSourceSnapshot.scan(kbRoot, documents);
    expect(result.entries.map((item) => item.objToken)).toEqual(['tok1']);
    expect(result.missingFiles.map((item) => item.objToken)).toEqual(['tok2']);
  });
});

describe('CSV 附件与主文档使用同一原始库围栏', () => {
  it('支持根内绝对/相对路径，但拒绝越界附件与后续 symlink 替换', () => {
    writeRaw('表格入口.md', '# 表格入口\n附表为真实原始源的一部分');
    writeRaw('附件/快照.csv', '项目,数值\n体力,10\n');
    const record = docRecord({ objToken: 'csv-guard', localRelPath: '表格入口.md', objType: 'sheet' });
    const csv = path.join(kbRoot, '附件/快照.csv');
    const outside = path.join(dataRoot, 'outside-private-fixture.csv');
    fs.writeFileSync(outside, 'PRIVATE_OUTSIDE_FIXTURE');
    const byRelative = () => ['附件/快照.csv'];
    const scanned = RawSourceSnapshot.scan(kbRoot, [record], byRelative);
    const snapshot = RawSourceSnapshot.fromEntries(scanned.entries, { sheetCsvPaths: byRelative });
    expect(snapshot.readVerified(kbRoot, record.objToken).attachments[0].content).toContain('体力,10');
    expect(RawSourceSnapshot.scan(kbRoot, [record], () => [csv]).entries[0].contentHash).toBe(scanned.entries[0].contentHash);
    expect(() => RawSourceSnapshot.scan(kbRoot, [record], () => [outside])).toThrow();
    fs.unlinkSync(csv);
    fs.symlinkSync(outside, csv);
    expect(() => snapshot.readVerified(kbRoot, record.objToken)).toThrow();
    fs.unlinkSync(csv);
    expect(() => RawSourceSnapshot.scan(kbRoot, [record], byRelative)).toThrow();
  });
});

describe('computeChangeset（§6.4）', () => {
  it('按 objToken 比较 contentHash：added/changed/removed', () => {
    const current = [entry('a', 'a.md', 'h1'), entry('b', 'b.md', 'h2b'), entry('c', 'c.md', 'h3')];
    const base = {
      sourceSnapshot: [entry('a', 'a.md', 'h1'), entry('b', 'b.md', 'h2a'), entry('d', 'd.md', 'h4')],
    };
    const changeset = computeChangeset(current, base as never);
    expect(changeset.added).toEqual(['c']);
    expect(changeset.changed).toEqual(['b']);
    expect(changeset.removed).toEqual(['d']);
    expect(changeset.isEmpty()).toBe(false);
  });

  it('全一致 → isEmpty', () => {
    const current = [entry('a', 'a.md', 'h1')];
    const base = { sourceSnapshot: [entry('a', 'a.md', 'h1')] };
    expect(computeChangeset(current, base as never).isEmpty()).toBe(true);
  });
});

describe('validateOutputRoot（§5.1）', () => {
  it('与知识库根重叠 → 拒绝', () => {
    expect(() => validateOutputRoot(path.join(kbRoot, 'out'), { knowledgeBaseRoot: kbRoot, dataRoot }))
      .toThrow(/知识库根目录/);
    expect(() => validateOutputRoot(kbRoot, { knowledgeBaseRoot: kbRoot, dataRoot }))
      .toThrow(/知识库根目录/);
    // 标准库包含知识库（父目录）也拒绝
    expect(() => validateOutputRoot(path.dirname(kbRoot), { knowledgeBaseRoot: kbRoot, dataRoot }))
      .toThrow(/知识库根目录/);
  });

  it('包含 agent 数据目录 → 拒绝；非空无 CURRENT → 拒绝接管', () => {
    expect(() => validateOutputRoot(dataRoot, { knowledgeBaseRoot: kbRoot, dataRoot }))
      .toThrow(/agent 数据目录/);
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'kbbuild-foreign-'));
    fs.writeFileSync(path.join(foreign, '用户文件.txt'), '用户数据');
    expect(() => validateOutputRoot(foreign, { knowledgeBaseRoot: kbRoot, dataRoot }))
      .toThrow(/kb_output_root_not_empty|非空/);
    fs.rmSync(foreign, { recursive: true, force: true });
  });

  it('合法新目录 → 创建', () => {
    const fresh = path.join(dataRoot, 'fresh-kb-out');
    expect(() => validateOutputRoot(fresh, { knowledgeBaseRoot: kbRoot, dataRoot })).not.toThrow();
    expect(fs.statSync(fresh).isDirectory()).toBe(true);
  });
});

describe('staging 校验（§6.5 validating）', () => {
  function makeState(dir: string): BuildRunState {
    const stagingRoot = path.join(dir, 'staging');
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    writeRaw('src-a.md', '原始A');
    const snapshot = RawSourceSnapshot.fromEntries(
      [entry('tokA', 'src-a.md', computeSourceHash(path.join(kbRoot, 'src-a.md'), []))],
      { knowledgeBaseRoot: kbRoot },
    );
    return {
      mode: 'incremental',
      knowledgeBaseRoot: kbRoot,
      snapshot,
      workset: new Map([['tokA', 'added']]),
      stagingRoot,
      finishInfo: null,
    };
  }

  it('kb_finish 未调用 → issue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbval-'));
    const state = makeState(dir);
    const issues = validateStagingDocs(state, state.snapshot);
    expect(issues.some((issue) => issue.code === 'kb_finish_missing')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('header 缺失 / sources 不在快照 / 非 .md → issues', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbval-'));
    const state = makeState(dir);
    state.finishInfo = { summary: 'done', skipped: [] };
    fs.writeFileSync(path.join(state.stagingRoot, 'docs', '无头.md'), '# 无头\n');
    fs.writeFileSync(path.join(state.stagingRoot, 'docs', '坏源.md'), '<!--\nfeishu_sync_kb:\n  doc_id: kd_x\n  sources:\n    - tokX\n  build_id: b1\n-->\n# 坏源\n');
    fs.writeFileSync(path.join(state.stagingRoot, 'docs', '非md.txt'), 'x');
    const issues = validateStagingDocs(state, state.snapshot);
    expect(issues.some((issue) => issue.code === 'header_missing')).toBe(true);
    expect(issues.some((issue) => issue.code === 'source_not_in_snapshot')).toBe(true);
    // 非 .md 路径在 validateStdDocPath 即被拒（path_invalid 先于 not_markdown）
    expect(issues.some((issue) => issue.code === 'path_invalid' || issue.code === 'not_markdown')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('工作集源未引用且未 skipped → source_not_covered；skipped 后通过', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbval-'));
    const state = makeState(dir);
    state.finishInfo = { summary: 'done', skipped: [] };
    let issues = validateStagingDocs(state, state.snapshot);
    expect(issues.some((issue) => issue.code === 'source_not_covered')).toBe(true);
    state.finishInfo = { summary: 'done', skipped: [{ objToken: 'tokA', reason: '空文档' }] };
    issues = validateStagingDocs(state, state.snapshot);
    expect(issues).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('发布原子性与对账（§6.5 publishing / §5.3）', () => {
  function makeService(): KbBuildService {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const toolService = new AgentToolService({
      dataRoot,
      documentsProvider: () => [],
    });
    const config = {
      standardKb: {
        outputRoot, retainReleases: 3, buildBatchSize: 10,
        promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
      },
    };
    return new KbBuildService({
      dataRoot,
      pool,
      toolService,
      resolver: new PiRuntimeResolver(),
      configProvider: () => config as never,
      documentsProvider: () => [],
      sheetCsvPaths: () => [],
      internalBaseUrl: () => 'http://127.0.0.1:39999',
      extensionPath: () => null,
      promptAssets: () => null,
    });
  }

  function stageReleaseFiles(buildId: string, docs: Array<{ path: string; docId: string; sources: string[]; body: string }>): string {
    const stagingRoot = path.join(outputRoot, '.staging', buildId);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    for (const doc of docs) {
      const full = path.join(stagingRoot, 'docs', doc.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `<!--\nfeishu_sync_kb:\n  doc_id: ${doc.docId}\n  sources:\n${doc.sources.map((s) => `    - ${s}`).join('\n')}\n  build_id: ${buildId}\n-->\n# ${doc.path}\n${doc.body}\n`);
    }
    return stagingRoot;
  }

  it('发布成功：CURRENT rename 生效，release 不可变目录就绪', async () => {
    const service = makeService();
    writeRaw('s1.md', '原始1');
    const snapshot = RawSourceSnapshot.fromEntries(
      [entry('tok1', 's1.md', computeSourceHash(path.join(kbRoot, 's1.md'), []))],
      { knowledgeBaseRoot: kbRoot },
    );
    const stagingRoot = stageReleaseFiles('b_test1', [{ path: '分类/文档一.md', docId: 'kd_0001', sources: ['tok1'], body: '内容' }]);
    const manifest = await service.publishRelease({
      buildId: 'b_test1', releaseId: 'r_test1', mode: 'full', baseReleaseId: null,
      model: 'test/model', snapshot, stagingRoot, outputRoot,
      docMeta: new Map([['分类/文档一.md', { title: '文档一', summary: '摘要', tags: [], sources: ['tok1'] }]]),
      retainReleasesOverride: 3,
    });
    expect(manifest.releaseId).toBe('r_test1');
    expect(manifest.docs).toHaveLength(1);
    expect(manifest.docs[0].docId).toBe('kd_0001');
    const kbStore = new StandardKbStore(outputRoot);
    const pointer = kbStore.readCurrent();
    expect(pointer?.releaseId).toBe('r_test1');
    const readManifest = kbStore.readManifest();
    expect(readManifest?.docs[0].title).toBe('文档一');
    // 发布文件头可解析回来源
    const loaded = kbStore.readReleaseDoc('r_test1', readManifest!.docs[0]);
    expect(parseStdHeader(`<!--\nfeishu_sync_kb:\n  doc_id: ${manifest.docs[0].docId}\n  sources:\n    - tok1\n  build_id: b_test1\n-->`)?.sources).toEqual(['tok1']);
    expect(loaded.markdown.startsWith('# 分类/文档一.md')).toBe(true);
  });

  it('发布失败（staging 缺 docs 目录）→ CURRENT 不动，旧发布保留', async () => {
    const service = makeService();
    const before = new StandardKbStore(outputRoot).readCurrent();
    const emptyStaging = path.join(outputRoot, '.staging', 'b_bad');
    fs.mkdirSync(emptyStaging, { recursive: true });
    const snapshot = RawSourceSnapshot.fromEntries([], { knowledgeBaseRoot: kbRoot });
    await expect(service.publishRelease({
      buildId: 'b_bad', releaseId: 'r_bad', mode: 'full', baseReleaseId: null,
      model: null, snapshot, stagingRoot: emptyStaging, outputRoot,
      docMeta: new Map(), retainReleasesOverride: 3,
    })).rejects.toThrow();
    const after = new StandardKbStore(outputRoot).readCurrent();
    expect(after?.releaseId).toBe(before?.releaseId);
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_bad'))).toBe(false);
  });

  it('指针后 DB 失败的启动对账：以 CURRENT 指针为准补写 DB', () => {
    // 模拟：指针已指向 r_test1，但 DB 无该 published 记录
    const svc = makeService();
    const freshStore = new LocalMapStore(path.join(dataRoot, 'reconcile.db'));
    openedStores.push(freshStore);
    freshStore.initialize();
    freshStore.createKbBuild({
      id: 'b_orphan', mode: 'full', status: 'running',
      baseReleaseId: null, model: null, createdAt: new Date().toISOString(),
    });
    const service = svc as unknown as {
      deps: { configProvider: () => { standardKb: { outputRoot: string } } };
      outputRoot(): string;
    };
    // reconcileOnStartup 需要 LocalMapStore 形状
    const result = (svc as unknown as { reconcileOnStartup(store: LocalMapStore): { interruptedBuildIds: string[] } })
      .reconcileOnStartup(freshStore as never);
    expect(result.interruptedBuildIds).toContain('b_orphan');
    expect(String(freshStore.getKbBuild('b_orphan')!.status)).toBe('interrupted');
    // 指针对账：r_test1 补写 published
    const builds = freshStore.listKbBuilds(50);
    const recovered = builds.find((row) => row.release_id === 'r_test1' && row.status === 'published');
    expect(recovered).toBeTruthy();
    void service;
  });

  it('保留策略：超出 retainReleases 的旧 release 被清理，CURRENT 指向的保留', async () => {
    const service = makeService();
    writeRaw('s2.md', '原始2');
    const snapshot = RawSourceSnapshot.fromEntries(
      [entry('tok2', 's2.md', computeSourceHash(path.join(kbRoot, 's2.md'), []))],
      { knowledgeBaseRoot: kbRoot },
    );
    for (let i = 2; i <= 5; i += 1) {
      const stagingRoot = stageReleaseFiles(`b_r${i}`, [
        { path: `第${i}版.md`, docId: `kd_r${i}`, sources: ['tok2'], body: `v${i}` },
      ]);
      await service.publishRelease({
        buildId: `b_r${i}`, releaseId: `r_t${i}`, mode: 'full', baseReleaseId: null,
        model: null, snapshot, stagingRoot, outputRoot, docMeta: new Map(),
        retainReleasesOverride: 2,
      });
    }
    const releasesDir = path.join(outputRoot, 'releases');
    const remaining = fs.readdirSync(releasesDir).sort();
    expect(remaining.length).toBeLessThanOrEqual(2);
    const pointer = new StandardKbStore(outputRoot).readCurrent();
    expect(remaining).toContain(pointer!.releaseId);
  });
});

describe('cleanupOldStaging', () => {
  it('只保留最近 3 个 staging', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbstage-'));
    for (let i = 0; i < 5; i += 1) {
      const staging = path.join(dir, '.staging', `b_${i}`);
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, 'marker'), String(i));
      // 控制 mtime
      const time = new Date(Date.now() - (5 - i) * 60_000);
      fs.utimesSync(staging, time, time);
    }
    cleanupOldStaging(dir);
    const remaining = fs.readdirSync(path.join(dir, '.staging')).sort();
    expect(remaining.length).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('原始库只读（§12.1：构建前后原始文件哈希不变）', () => {
  it('快照/读取/校验链路不修改原始文件', () => {
    writeRaw('只读检查.md', '# 只读\n内容固定');
    const before = computeSourceHash(path.join(kbRoot, '只读检查.md'), []);
    const documents = [docRecord({ objToken: 'tokRO', localRelPath: '只读检查.md', status: 'synced' })];
    const snapshot = RawSourceSnapshot.scan(kbRoot, documents);
    const snap = RawSourceSnapshot.fromEntries(snapshot.entries, { knowledgeBaseRoot: kbRoot });
    const verified = snap.readVerified(kbRoot, 'tokRO');
    expect(verified.content).toContain('内容固定');
    const after = computeSourceHash(path.join(kbRoot, '只读检查.md'), []);
    expect(after).toBe(before);
  });

  it('构建期间源被改 → readVerified 报 source_changed_during_build', () => {
    writeRaw('会变.md', 'v1');
    const documents = [docRecord({ objToken: 'tokCH', localRelPath: '会变.md', status: 'synced' })];
    const snapshot = RawSourceSnapshot.scan(kbRoot, documents);
    const snap = RawSourceSnapshot.fromEntries(snapshot.entries, { knowledgeBaseRoot: kbRoot });
    writeRaw('会变.md', 'v2-被同步任务修改');
    expect(() => snap.readVerified(kbRoot, 'tokCH')).toThrow(/source_changed_during_build|构建期间/);
  });
});

describe('SQLite additive 迁移（§12.1 配置与迁移）', () => {
  it('kb_builds / agent_sessions 表在 initialize 后可用（含旧库路径）', () => {
    // beforeAll 已在全新库上 initialize；再验证访问器往返
    store.createKbBuild({
      id: 'b_unit1', mode: 'full', status: 'queued',
      baseReleaseId: null, model: 'm/x', createdAt: new Date().toISOString(),
    });
    store.updateKbBuild('b_unit1', { status: 'running', sourceTotal: 5, noChanges: false });
    expect(String(store.getKbBuild('b_unit1')!.status)).toBe('running');
    expect(Number(store.getKbBuild('b_unit1')!.source_total)).toBe(5);
    expect(store.getActiveKbBuild()!.id).toBe('b_unit1');
    store.updateKbBuild('b_unit1', { status: 'failed', errorCode: 'x', finishedAt: new Date().toISOString() });
    expect(store.getActiveKbBuild()).toBeNull();

    store.createAgentSession({
      id: 's_unit1', title: '测试', mode: 'discuss', workspaceId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.updateAgentSession('s_unit1', { mode: 'work', workspaceId: 'ws_x' });
    const row = store.getAgentSession('s_unit1')!;
    expect(String(row.mode)).toBe('work');
    expect(store.listAgentSessions()).toHaveLength(1);
  });
});

describe('ToolError 契约', () => {
  it('code/status 传递（供路由 400/403/404/409/503 映射）', () => {
    const err = new ToolError('agent_not_ready', '未就绪', 503);
    expect(err.code).toBe('agent_not_ready');
    expect(err.status).toBe(503);
  });
});

describe('F3-R07：full 语义（重复 full / 只 finish 不得发布空或局部库）', () => {
  function makeModeState(dir: string, mode: 'full' | 'incremental'): BuildRunState {
    const stagingRoot = path.join(dir, 'staging');
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    writeRaw('full-a.md', '原始A');
    writeRaw('full-b.md', '原始B');
    const snapshot = RawSourceSnapshot.fromEntries([
      entry('tokFA', 'full-a.md', computeSourceHash(path.join(kbRoot, 'full-a.md'), [])),
      entry('tokFB', 'full-b.md', computeSourceHash(path.join(kbRoot, 'full-b.md'), [])),
    ], { knowledgeBaseRoot: kbRoot });
    const workset = new Map<string, 'added' | 'changed' | 'rebuild'>();
    if (mode === 'full') {
      workset.set('tokFA', 'rebuild');
      workset.set('tokFB', 'rebuild'); // full 工作集 = 快照全部源
    } else {
      workset.set('tokFA', 'added');
    }
    return {
      knowledgeBaseRoot: kbRoot, snapshot, mode, workset, stagingRoot, finishInfo: null,
    };
  }

  it('full 零产出（即使全部带理由 skipped）→ full_empty_output 拒绝发布空库', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbr07-'));
    const state = makeModeState(dir, 'full');
    state.finishInfo = {
      summary: '空',
      skipped: [{ objToken: 'tokFA', reason: '空文档' }, { objToken: 'tokFB', reason: '空文档' }],
    };
    const issues = validateStagingDocs(state, state.snapshot);
    expect(issues.some((issue) => issue.code === 'full_empty_output')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('同样的全 skip 在 incremental 不触发 full_empty_output（语义只约束 full）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbr07-'));
    const state = makeModeState(dir, 'incremental');
    state.finishInfo = { summary: '空', skipped: [{ objToken: 'tokFA', reason: '空文档' }] };
    const issues = validateStagingDocs(state, state.snapshot);
    expect(issues.some((issue) => issue.code === 'full_empty_output')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('full 工作集=全量：未引用且未 skipped 的源（即使相对基线无变更）→ source_not_covered', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbr07-'));
    const state = makeModeState(dir, 'full');
    state.finishInfo = { summary: '只写了一半', skipped: [] };
    // 只写 tokFA 的文档；tokFB 未引用未 skipped —— full 必须覆盖全量源
    fs.writeFileSync(path.join(state.stagingRoot, 'docs', 'a.md'),
      '<!--\nfeishu_sync_kb:\n  doc_id: kd_fa\n  sources:\n    - tokFA\n  build_id: b1\n-->\n# A\n');
    const issues = validateStagingDocs(state, state.snapshot);
    expect(issues.some((issue) => issue.code === 'source_not_covered' && issue.objToken === 'tokFB')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('F3-R08：毒化与发布前复核（不可恢复失败，模型无法绕过）', () => {
  it('raw_read 命中源变更 → 报 source_changed_during_build 且 buildState.poisoned 置位', async () => {
    const toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    writeRaw('poison-src.md', 'v1');
    const snapshot = RawSourceSnapshot.fromEntries([
      entry('tokP', 'poison-src.md', computeSourceHash(path.join(kbRoot, 'poison-src.md'), [])),
    ], { knowledgeBaseRoot: kbRoot });
    const stagingRoot = path.join(dataRoot, 'staging-r08');
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    const buildState: BuildRunState = {
      knowledgeBaseRoot: kbRoot, snapshot, mode: 'incremental',
      workset: new Map([['tokP', 'added']]), stagingRoot, finishInfo: null,
    };
    const { token } = toolService.createRunContext({
      runKind: 'build', buildId: 'b_r08', outputRoot: path.join(dataRoot, 'out-r08'),
      knowledgeBaseRoot: kbRoot, buildState,
    });
    // 读取成功（源未变），未毒化
    const ok = await toolService.executeTool(token, 'raw_read', { objToken: 'tokP' });
    expect(ok.content[0]?.type).toBe('text');
    expect(buildState.poisoned).toBeUndefined();
    // 同步任务改写源 → 读取失败且毒化置位（后续 batch/finish/validating 均拒绝）
    writeRaw('poison-src.md', 'v2-被同步任务改写');
    await expect(toolService.executeTool(token, 'raw_read', { objToken: 'tokP' }))
      .rejects.toMatchObject({ code: 'source_changed_during_build' });
    expect(buildState.poisoned?.code).toBe('source_changed_during_build');
  });

  it('verifySnapshotIntact：主文档或 CSV 附件变更 → 拒绝（最后 read 后变更不得切 CURRENT）', () => {
    writeRaw('verify-main.md', '内容 v1');
    writeRaw('附件目录/表.csv', '列,值\nx,1\n');
    const snapshot = RawSourceSnapshot.fromEntries([
      entry('tokV', 'verify-main.md', computeSourceHash(
        path.join(kbRoot, 'verify-main.md'), ['附件目录/表.csv'], kbRoot)),
    ], { knowledgeBaseRoot: kbRoot });
    verifySnapshotIntact(snapshot, kbRoot, () => ['附件目录/表.csv']); // 未变 → 通过
    writeRaw('附件目录/表.csv', '列,值\nx,2-改\n'); // 只改附件
    expect(() => verifySnapshotIntact(snapshot, kbRoot, () => ['附件目录/表.csv']))
      .toThrow(/source_changed_during_build|发布前复核/);
    writeRaw('附件目录/表.csv', '列,值\nx,1\n');
    writeRaw('verify-main.md', '内容 v2-被改'); // 只改主文档
    expect(() => verifySnapshotIntact(snapshot, kbRoot, () => ['附件目录/表.csv']))
      .toThrow(/source_changed_during_build|发布前复核/);
  });
});

describe('发布点源集合与主文件围栏', () => {
  it('新增本地源阻断；仅云端观测变化不误报', () => {
    writeRaw('publish-source-a.md', 'A');
    writeRaw('publish-source-b.md', 'B');
    const a = docRecord({ objToken: 'publish-a', localRelPath: 'publish-source-a.md' });
    const b = docRecord({ objToken: 'publish-b', localRelPath: 'publish-source-b.md' });
    const snapshot = RawSourceSnapshot.fromEntries(RawSourceSnapshot.scan(kbRoot, [a]).entries);
    expect(() => verifySnapshotIntact(snapshot, kbRoot, () => [], [{ ...a, cloudDeleted: 1, observedObjEditTime: 999 }])).not.toThrow();
    expect(() => verifySnapshotIntact(snapshot, kbRoot, () => [], [a, b])).toThrow(/源集合/);
  });

  it('主文件被替换成越界symlink时拒绝，不读取越界内容进行hash', () => {
    writeRaw('publish-main-link.md', '本地源');
    const a = docRecord({ objToken: 'publish-link', localRelPath: 'publish-main-link.md' });
    const snapshot = RawSourceSnapshot.fromEntries(RawSourceSnapshot.scan(kbRoot, [a]).entries);
    const outside = path.join(dataRoot, 'private-outside-main.md');
    fs.writeFileSync(outside, 'OUTSIDE_PRIVATE_FIXTURE');
    const main = path.join(kbRoot, a.localRelPath!);
    fs.unlinkSync(main);
    fs.symlinkSync(outside, main);
    expect(() => verifySnapshotIntact(snapshot, kbRoot, () => [])).toThrow(/越界/);
  });
});

describe('F3-R09：对账 upsert（同 buildId 行 UPDATE 而非撞 PK 吞错）', () => {
  function makeKbService(): KbBuildService {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    const config = {
      standardKb: {
        outputRoot, retainReleases: 3, buildBatchSize: 10,
        promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
      },
    };
    return new KbBuildService({
      dataRoot, pool, toolService,
      resolver: new PiRuntimeResolver(),
      configProvider: () => config as never,
      documentsProvider: () => [],
      sheetCsvPaths: () => [],
      internalBaseUrl: () => 'http://127.0.0.1:39999',
      extensionPath: () => null,
      promptAssets: () => null,
    });
  }

  it('publishing/failed/interrupted 行 → 修复为 published，error 清空，不重复建行', () => {
    const svc = makeKbService();
    const reconcile = svc as unknown as {
      reconcileOnStartup(store: LocalMapStore): { interruptedBuildIds: string[] };
    };
    // CURRENT 指针动态取（保留策略测试后指针已不是首个 release）
    const kbStore = new StandardKbStore(outputRoot);
    const pointer = kbStore.readCurrent()!;
    const manifest = kbStore.readManifest(pointer.releaseId)!;
    const buildId = String(manifest.buildId);
    for (const stale of ['publishing', 'failed', 'interrupted'] as const) {
      const freshStore = new LocalMapStore(path.join(dataRoot, `reconcile-upsert-${stale}.db`));
      openedStores.push(freshStore);
      freshStore.initialize();
      freshStore.createKbBuild({
        id: buildId, mode: 'full', status: stale,
        baseReleaseId: null, model: null, createdAt: new Date().toISOString(),
      });
      if (stale === 'failed') {
        freshStore.updateKbBuild(buildId, { errorCode: 'boom_mid_publish', errorMessage: '发布后崩溃' });
      }
      reconcile.reconcileOnStartup(freshStore as never);
      const row = freshStore.getKbBuild(buildId)!;
      expect(String(row.status), stale).toBe('published');
      expect(String(row.release_id), stale).toBe(pointer.releaseId);
      if (stale === 'failed') {
        expect(row.error_code ?? null, stale).toBeNull(); // 旧 error 被清
      }
      const rows = freshStore.listKbBuilds(50).filter((item) => String(item.id) === buildId);
      expect(rows, stale).toHaveLength(1); // 无撞 PK 重复行
    }
  });
});

describe('F3-R10：指针提交点与提交后清理故障（不删 current release）', () => {
  function makeKbService(): KbBuildService {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    const config = {
      standardKb: {
        outputRoot, retainReleases: 3, buildBatchSize: 10,
        promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
      },
    };
    return new KbBuildService({
      dataRoot, pool, toolService,
      resolver: new PiRuntimeResolver(),
      configProvider: () => config as never,
      documentsProvider: () => [],
      sheetCsvPaths: () => [],
      internalBaseUrl: () => 'http://127.0.0.1:39999',
      extensionPath: () => null,
      promptAssets: () => null,
    });
  }

  function stageReleaseFilesR10(buildId: string, releaseId: string, token: string): string {
    const stagingRoot = path.join(outputRoot, '.staging', buildId);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(stagingRoot, 'docs', '文档.md'),
      `<!--\nfeishu_sync_kb:\n  doc_id: kd_${releaseId}\n  sources:\n    - ${token}\n  build_id: ${buildId}\n-->\n# 文档\nR10 内容\n`);
    return stagingRoot;
  }

  it('cleanupOldReleases 扫描失败（真实故障注入）→ 发布成功、CURRENT 切换、current release 保留', async () => {
    const service = makeKbService();
    writeRaw('r10-src.md', 'R10 源');
    const snapshot = RawSourceSnapshot.fromEntries([
      entry('tokR10', 'r10-src.md', computeSourceHash(path.join(kbRoot, 'r10-src.md'), [])),
    ], { knowledgeBaseRoot: kbRoot });
    // 先发布 A 作为旧 current（retain=5 保留两个 release 供断言）
    const stagingA = stageReleaseFilesR10('b_r10a', 'r_r10a', 'tokR10');
    await service.publishRelease({
      buildId: 'b_r10a', releaseId: 'r_r10a', mode: 'full', baseReleaseId: null,
      model: null, snapshot, stagingRoot: stagingA, outputRoot, docMeta: new Map(),
      retainReleasesOverride: 5,
    });
    // 真实故障注入：releases 目录扫描抛错（权限/并发删除等），只针对该目录
    const releasesDir = path.join(outputRoot, 'releases');
    const original = fs.readdirSync.bind(fs);
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (path.resolve(String(target)) === path.resolve(releasesDir)) {
        throw new Error('EACCES: 注入的扫描故障');
      }
      return original(target as never, options as never);
    }) as typeof fs.readdirSync);
    try {
      // 发布 B（retain=1：若无注入本应清理 A）
      const stagingB = stageReleaseFilesR10('b_r10b', 'r_r10b', 'tokR10');
      const manifest = await service.publishRelease({
        buildId: 'b_r10b', releaseId: 'r_r10b', mode: 'full', baseReleaseId: 'r_r10a',
        model: null, snapshot, stagingRoot: stagingB, outputRoot, docMeta: new Map(),
        retainReleasesOverride: 1,
      });
      expect(manifest.releaseId).toBe('r_r10b');
      // 提交点已过：CURRENT 切换到 B，发布不受清理故障影响
      const pointer = new StandardKbStore(outputRoot).readCurrent();
      expect(pointer?.releaseId).toBe('r_r10b');
      expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_r10b', 'docs', '文档.md'))).toBe(true);
      // current release 不被回滚/删除；A 因清理失败保留（best-effort）
      expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_r10a'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
