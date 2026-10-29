/**
 * P2-S4 评论溯源（设计 lark-cli-newcaps-P2 §5.1）全链路测试：
 *
 *  - 解析器：fixture 实测形态（P1-S1 fetch-refmap-comments.json）、键缺失
 *    （RP-3）、tips 截断、无文本条目丢弃、容错双读、长度上限；
 *  - LocalMapStore：两张表双登记、replace 先删后插（不累积）、按源删、
 *    按源查、meta 区分「没有评论」与「从未采集」、生命周期级联；
 *  - SyncEngine：docx 同步事务内采集入库（与引用边同事务）、重同步替换、
 *    TestHooks failAfterMarkDocumentSynced → 评论随基线回滚、无
 *    非 docx 不写 meta；docx 响应省略 reference_map 时记录零评论；
 *  - rebuild（reference-rebuild.ts）不重建评论（纯本地无 refmap，评论只在
 *    同步时采集）；
 *  - raw_comments 工具：登记进 Discuss/Work、构建工具集排除断言、输出
 *    <untrusted_comments> 包裹与转义、404、从未采集说明；
 *  - GET /api/mapping/comments/:objToken：collected true/false 两形态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { extractRefmapComments } from '../src/kb/source-comments.js';
import { rebuildSourceReferences } from '../src/sources/reference-rebuild.js';
import { contentRoutes } from '../src/routes/content.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { toolsForRunKind } from '../src/types/agent-knowledge.js';
import type { ChangedDocument, DocumentRecord } from '../src/types/index.js';

const temporaryDirectories: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

const SRC = 'srcDocxComment000001';
const WIKI = 'wikDocxComment000001';

/** P1-S1 实测 fixture（脱敏）：真实 comments 组结构。 */
const FIXTURE_REFCOM = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/p1s1-lark-cli/fetch-refmap-comments.json'),
    'utf-8',
  ),
) as { data: { document: { reference_map?: unknown } } };

describe('解析器 extractRefmapComments（fixture 驱动，设计 §5.1 / MD-3）', () => {
  it('实测 fixture：单条评论解析出 ref/作者/文本；truncated=false', () => {
    const result = extractRefmapComments(FIXTURE_REFCOM.data.document.reference_map);
    expect(result.truncated).toBe(false);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({
      commentRef: 'c1',
      author: '测试用户',
      text: 'p1s1 探针评论：验证 reference_map comments 组',
      quote: null,
      createdAtCloud: null,
      solved: null,
    });
  });

  it('键整体缺失（RP-3）/ 非对象输入：空结果不抛错', () => {
    expect(extractRefmapComments(undefined)).toEqual({ comments: [], truncated: false });
    expect(extractRefmapComments(null)).toEqual({ comments: [], truncated: false });
    expect(extractRefmapComments('nope')).toEqual({ comments: [], truncated: false });
    expect(extractRefmapComments({})).toEqual({ comments: [], truncated: false });
    // comments 组整体缺失（无评论但 reference_map 存在）。
    expect(extractRefmapComments({ 'html5-block': {} })).toEqual({ comments: [], truncated: false });
  });

  it('comments.tips 存在即截断，且 tips 不算评论条目', () => {
    const result = extractRefmapComments({
      comments: {
        tips: { data: '<tips>截断提示</tips>' },
        c1: { data: '<comment comment-id="a"><msg user="甲">一条</msg></comment>' },
      },
    });
    expect(result.truncated).toBe(true);
    expect(result.comments.map((c) => c.commentRef)).toEqual(['c1']);
  });

  it('解析不出文本的条目丢弃；无 msg 时退化为 comment 内文本', () => {
    const result = extractRefmapComments({
      comments: {
        empty: { data: '<comment comment-id="x"></comment>' },
        nonstr: { data: 123 },
        plain: { data: '<comment>裸文本</comment>' },
      },
    });
    expect(result.comments.map((c) => `${c.commentRef}|${c.text}`)).toEqual(['plain|裸文本']);
  });

  it('多条 msg 按行拼接、作者取首条；内嵌标签剥除 + 实体解码', () => {
    const result = extractRefmapComments({
      comments: {
        c1: {
          data: '<comment comment-id="a"><msg user="甲">A &amp; B <at user_id="ou_x">乙</at></msg><msg user="乙">回复</msg></comment>',
        },
      },
    });
    expect(result.comments[0]).toMatchObject({
      author: '甲',
      text: 'A & B 乙\n回复',
    });
  });

  it('非法 Unicode 数字实体保留原文，不中断评论解析', () => {
    const result = extractRefmapComments({ comments: { c1: { data: '<comment><msg>异常 &#1114112; &#x110000; 正文</msg></comment>' } } });
    expect(result.comments[0].text).toBe('异常 &#1114112; &#x110000; 正文');
  });

  it('容错双读：quote/solved/created 属性与 quote 子元素；未提供为 null', () => {
    const attr = extractRefmapComments({
      comments: {
        c1: { data: '<comment solved="true" created_at="2026-09-12T08:21:00Z"><msg user="张三">正文</msg></comment>' },
        c2: { data: '<comment><quote>划词原文</quote><msg user="李四">正文2</msg></comment>' },
      },
    });
    expect(attr.comments[0]).toMatchObject({ solved: true, createdAtCloud: '2026-09-12T08:21:00Z' });
    expect(attr.comments[1]).toMatchObject({ quote: '划词原文', solved: null });
    // solved=false / 未知取值。
    const solved = extractRefmapComments({
      comments: { c1: { data: '<comment is_solved="false"><msg>正文</msg></comment>' } },
    });
    expect(solved.comments[0].solved).toBe(false);
    const unknown = extractRefmapComments({
      comments: { c1: { data: '<comment solved="maybe"><msg>正文</msg></comment>' } },
    });
    expect(unknown.comments[0].solved).toBeNull();
  });

  it('长度上限：text ≤4000、quote ≤500；条目缺失/非法 commentRef 不入库层再滤', () => {
    const long = 'x'.repeat(5000);
    const result = extractRefmapComments({
      comments: {
        c1: { data: `<comment quote="${long}"><msg user="u">${long}</msg></comment>` },
        c2: { data: '<comment><msg>短文本</msg></comment>' },
      },
    });
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0].text).toHaveLength(4000);
    expect(result.comments[0].quote).toHaveLength(500);
    expect(result.comments[1].text).toBe('短文本');
  });
});

interface Harness {
  store: LocalMapStore;
  kbRoot: string;
  opDir: string;
}

function makeHarness(): Harness {
  const kbRoot = makeTempDir('p2s4-kb-');
  const opDir = makeTempDir('p2s4-ops-');
  const dbDir = makeTempDir('p2s4-db-');
  const store = new LocalMapStore(path.join(dbDir, 'feishu-sync.db'));
  store.initialize();
  return { store, kbRoot, opDir };
}

function makeDocumentRow(objToken: string, overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    objToken,
    wikiNodeToken: null,
    objType: 'docx',
    title: '评论文档',
    localMdPath: `/tmp/${objToken}.md`,
    lastSyncedModifyTime: '2026-10-28T10:00:00.000Z',
    lastSyncedAt: '2026-10-28T10:00:00.000Z',
    status: 'synced',
    ...overrides,
  };
}

function makeEngine(harness: Harness, client: unknown, testHooks?: Record<string, boolean>): SyncEngine {
  return new SyncEngine({
    larkCliClient: client,
    localMapStore: harness.store,
    config: {
      knowledgeBaseRoot: harness.kbRoot,
      operationManifestDir: harness.opDir,
      watchedRoots: [],
      watchedRootUrls: [],
    },
    ...(testHooks ? { testHooks } : {}),
  } as any);
}

/** docx 全链路 mock：只提供 fetchDocumentMarkdown。 */
class DocxCommentMockClient {
  constructor(
    private readonly content: string,
    /** undefined = docx 响应整体没有 reference_map 键（RP-3）。 */
    private readonly referenceMap?: unknown,
  ) {}

  async fetchDocumentMarkdown() {
    return {
      data: {
        document: {
          content: this.content,
          ...(this.referenceMap !== undefined ? { reference_map: this.referenceMap } : {}),
        },
      },
    };
  }
}

function makeChangedDoc(kbRoot: string, overrides: Partial<ChangedDocument> = {}): ChangedDocument {
  return {
    objToken: SRC,
    wikiNodeToken: WIKI,
    objType: 'docx',
    title: '评论文档',
    changeType: 'added',
    cloudModifiedTime: '2026-10-28T10:00:00.000Z',
    localSyncedTime: null,
    localMdPath: path.join(kbRoot, '评论文档.md'),
    observedObjEditTime: 1789000000,
    ...overrides,
  };
}

const SYNC_OPTIONS = {
  enableLLM: false,
  fullSync: false,
  apply: true,
  confirmation: 'APPLY',
} as const;

const REFMAP_WITH_COMMENTS = {
  comments: {
    c1: { data: '<comment comment-id="7701642957111200774" is_whole="true"><msg user="测试用户">第一版评论</msg></comment>' },
    c2: { data: '<comment comment-id="7701642957111200775" solved="false" created_at="2026-09-12T08:21:00Z"><msg user="张三">这里的上限按什么口径？</msg></comment>' },
  },
};

describe('LocalMapStore source_comments / source_comment_meta（两张表 + 生命周期）', () => {
  it('双登记：fresh 库建表列齐全 + DDL 文本携带 + 旧库（表被删）再 initialize 重建', () => {
    const dbDir = makeTempDir('p2s4-ddl-');
    const dbPath = path.join(dbDir, 'feishu-sync.db');
    const store = new LocalMapStore(dbPath);
    store.initialize();
    store.upsertDocument(makeDocumentRow(SRC));
    store.close();

    const database = new Database(dbPath, { readonly: true });
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    const commentCols = (database.prepare('PRAGMA table_info(source_comments)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    const metaCols = (database.prepare('PRAGMA table_info(source_comment_meta)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    database.close();
    expect(tables).toContain('source_comments');
    expect(tables).toContain('source_comment_meta');
    expect(commentCols).toEqual([
      'src_obj_token', 'comment_ref', 'text', 'quote', 'author',
      'created_at_cloud', 'solved', 'updated_at',
    ]);
    expect(metaCols).toEqual(['src_obj_token', 'total', 'truncated', 'updated_at']);

    const probe = new LocalMapStore(dbPath);
    const ddl = (probe as unknown as { getCreateTablesDDL(): string }).getCreateTablesDDL();
    probe.close();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS source_comments');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS source_comment_meta');

    const legacy = new Database(dbPath);
    legacy.exec('DROP TABLE source_comments; DROP TABLE source_comment_meta');
    legacy.close();
    const upgraded = new LocalMapStore(dbPath);
    upgraded.initialize();
    expect(upgraded.getSourceCommentMeta(SRC)).toBeNull();
    upgraded.close();
    const reopened = new Database(dbPath, { readonly: true });
    const present = (reopened.prepare("SELECT name FROM sqlite_master WHERE name IN ('source_comments','source_comment_meta')").all() as Array<{ name: string }>)
      .map((row) => row.name).sort();
    reopened.close();
    expect(present).toEqual(['source_comment_meta', 'source_comments']);
  });

  it('replace 先删后插（重同步替换不累积）；零评论也写 meta（total=0）；主键去重；按源删/按源查', () => {
    const { store } = makeHarness();
    store.upsertDocument(makeDocumentRow(SRC));

    const first = store.replaceSourceComments(SRC, [
      { commentRef: 'c1', text: '一', author: '甲', solved: true },
      { commentRef: 'c2', text: '二' },
    ], { truncated: true });
    expect(first).toEqual({ deleted: 0, inserted: 2 });
    expect(store.listSourceCommentsBySrc(SRC).map((row) => row.commentRef)).toEqual(['c1', 'c2']);
    expect(store.getSourceCommentMeta(SRC)).toMatchObject({ total: 2, truncated: true });

    // 重同步：c1 被替换、c2 消失、c3 新增——不累积。
    const second = store.replaceSourceComments(SRC, [
      { commentRef: 'c1', text: '一（改）', quote: '划词' },
      { commentRef: 'c3', text: '三', createdAtCloud: '2026-09-12T08:21:00Z' },
    ], { truncated: false });
    expect(second).toEqual({ deleted: 2, inserted: 2 });
    const rows = store.listSourceCommentsBySrc(SRC);
    expect(rows.map((row) => `${row.commentRef}|${row.text}`)).toEqual(['c1|一（改）', 'c3|三']);
    expect(rows[0]).toMatchObject({ quote: '划词', author: null, solved: null });
    expect(rows[1]).toMatchObject({ createdAtCloud: '2026-09-12T08:21:00Z', solved: null });
    expect(store.getSourceCommentMeta(SRC)).toMatchObject({ total: 2, truncated: false });

    // 零评论也写 meta（与「从未采集」区分）。
    store.replaceSourceComments(SRC, [], { truncated: false });
    expect(store.listSourceCommentsBySrc(SRC)).toEqual([]);
    expect(store.getSourceCommentMeta(SRC)).toMatchObject({ total: 0, truncated: false });

    // 主键去重：同 commentRef 首次为准（解析层防御的入库层对偶）。
    store.replaceSourceComments(SRC, [
      { commentRef: 'c1', text: '首次' },
      { commentRef: 'c1', text: '重复应被丢弃' },
    ], { truncated: false });
    const deduped = store.listSourceCommentsBySrc(SRC);
    expect(deduped.map((row) => row.text)).toEqual(['首次']);
    expect(store.getSourceCommentMeta(SRC)).toMatchObject({ total: 1 });

    // 按源删：评论 + meta 同时清除 → 回到「从未采集」。
    expect(store.deleteSourceCommentsBySrc(SRC)).toEqual({ comments: 1, meta: 1 });
    expect(store.getSourceCommentMeta(SRC)).toBeNull();
    store.close();
  });

  it('生命周期：源行硬删同事务清评论；本地基线清除同删；同步根级联清理', () => {
    const { store } = makeHarness();
    store.upsertDocument(makeDocumentRow(SRC, { watchedRootUrl: 'https://example.feishu.cn/wiki/root1' }));
    store.replaceSourceComments(SRC, [{ commentRef: 'c1', text: '一' }], { truncated: false });

    // 本地基线清除 → pending：评论同删。
    store.clearLocalDocument(SRC, { pending: true });
    expect(store.getSourceCommentMeta(SRC)).toBeNull();
    expect(store.listSourceCommentsBySrc(SRC)).toEqual([]);

    // 重新采集 → 源行硬删 → 评论与 meta 级联清理。
    store.replaceSourceComments(SRC, [{ commentRef: 'c1', text: '一' }], { truncated: false });
    expect(store.deleteDocumentByToken(SRC)).toBe(true);
    expect(store.getSourceCommentMeta(SRC)).toBeNull();
    expect(store.listSourceCommentsBySrc(SRC)).toEqual([]);

    // 同步根移除级联。
    store.upsertDocument(makeDocumentRow('srcRootComment0002', { watchedRootUrl: 'https://example.feishu.cn/wiki/root2' }));
    store.replaceSourceComments('srcRootComment0002', [{ commentRef: 'c1', text: '一' }], { truncated: false });
    store.purgeWatchedRootData('https://example.feishu.cn/wiki/root2', null);
    expect(store.getSourceCommentMeta('srcRootComment0002')).toBeNull();
    store.close();
  });
});

describe('SyncEngine 同步事务内采集（P2-S4，设计 §5.1）', () => {
  it('未知云端回滚阻断同步，不读取云端或推进本地基线', async () => {
    const harness = makeHarness();
    const id = harness.store.insertSourcePushLog({ objToken: SRC, localRelPath: '文档甲.md', mode: 'revert', actor: 'ui' });
    harness.store.updateSourcePushLogRevert(id, { revertState: 'unknown' });
    const client = new DocxCommentMockClient('# 正文\n');
    const fetch = vi.spyOn(client, 'fetchDocumentMarkdown');
    const result = await makeEngine(harness, client).syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(result.success).toBe(false);
    expect(result.failedDocuments[0].reasonCode).toBe('cloud_operation_pending');
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.store.getDocumentByObjToken(SRC)?.syncedObjEditTime ?? null).toBeNull();
    harness.store.close();
  });

  it.each(['unknown', 'moved'] as const)('移出状态 %s 在预览与执行时均阻断同步', async (state) => {
    const harness = makeHarness();
    const id = harness.store.insertCloudMove({ objToken: SRC, wikiNodeToken: WIKI, actor: 'ui' });
    harness.store.updateCloudMove(id, { state });
    const client = new DocxCommentMockClient('# 正文\n');
    const fetch = vi.spyOn(client, 'fetchDocumentMarkdown');
    const expected = state === 'moved' ? 'source_moved_out' : 'cloud_operation_pending';
    const dryRun = await makeEngine(harness, client).syncDocuments([makeChangedDoc(harness.kbRoot)], { enableLLM: false, fullSync: false });
    expect(dryRun.failedDocuments[0].reasonCode).toBe(expected);
    const applied = await makeEngine(harness, client).syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(applied.failedDocuments[0].reasonCode).toBe(expected);
    expect(fetch).not.toHaveBeenCalled();
    harness.store.close();
  });
  it('docx 同步成功：评论与引用边同事务入库；meta 如实标注', async () => {
    const harness = makeHarness();
    const result = await makeEngine(harness, new DocxCommentMockClient('# 正文\n', REFMAP_WITH_COMMENTS))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(result.success).toBe(true);

    const rows = harness.store.listSourceCommentsBySrc(SRC);
    expect(rows.map((row) => `${row.commentRef}|${row.author}|${row.text}`).sort()).toEqual([
      'c1|测试用户|第一版评论',
      'c2|张三|这里的上限按什么口径？',
    ].sort());
    expect(rows.find((row) => row.commentRef === 'c2')).toMatchObject({
      solved: false,
      createdAtCloud: '2026-09-12T08:21:00Z',
    });
    expect(harness.store.getSourceCommentMeta(SRC)).toMatchObject({ total: 2, truncated: false });
    harness.store.close();
  });

  it('重同步：评论被替换而非累积（幂等替换语义）', async () => {
    const harness = makeHarness();
    await makeEngine(harness, new DocxCommentMockClient('# 正文\n', REFMAP_WITH_COMMENTS))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(harness.store.listSourceCommentsBySrc(SRC)).toHaveLength(2);

    const v2 = {
      comments: {
        c1: { data: '<comment comment-id="7701642957111200774"><msg user="测试用户">第一版评论（更新）</msg></comment>' },
        tips: { data: '<tips>截断</tips>' },
      },
    };
    const second = await makeEngine(harness, new DocxCommentMockClient('# 正文（改）\n', v2))
      .syncDocuments([
        makeChangedDoc(harness.kbRoot, {
          changeType: 'modified',
          localSyncedTime: '2026-10-28T10:00:00.000Z',
          observedObjEditTime: 1789000100,
        }),
      ], SYNC_OPTIONS);
    expect(second.success).toBe(true);

    const rows = harness.store.listSourceCommentsBySrc(SRC);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ commentRef: 'c1', text: '第一版评论（更新）' });
    expect(harness.store.getSourceCommentMeta(SRC)).toMatchObject({ total: 1, truncated: true });
    harness.store.close();
  });

  it('TestHooks failAfterMarkDocumentSynced：DB 事务中止 → 评论随基线与正文一起回滚', async () => {
    const harness = makeHarness();
    await makeEngine(harness, new DocxCommentMockClient('# 正文\n', REFMAP_WITH_COMMENTS))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    const baseline = harness.store.getDocumentByObjToken(SRC)!.syncedObjEditTime;

    const v2 = {
      comments: { c9: { data: '<comment comment-id="9"><msg user="乙">新版评论不应入库</msg></comment>' } },
    };
    const failed = await makeEngine(
      harness,
      new DocxCommentMockClient('# 正文（改）\n', v2),
      { failAfterMarkDocumentSynced: true },
    ).syncDocuments([
      makeChangedDoc(harness.kbRoot, {
        changeType: 'modified',
        localSyncedTime: '2026-10-28T10:00:00.000Z',
        observedObjEditTime: 1789000200,
      }),
    ], SYNC_OPTIONS);

    expect(failed.success).toBe(false);
    expect(harness.store.getDocumentByObjToken(SRC)!.syncedObjEditTime).toBe(baseline);
    // 评论回滚：仍是 v1 的 2 条，v2 评论不存在。
    const rows = harness.store.listSourceCommentsBySrc(SRC);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.commentRef === 'c9')).toBe(false);
    expect(harness.store.getSourceCommentMeta(SRC)).toMatchObject({ total: 2, truncated: false });
    harness.store.close();
  });

  it('docx 响应无 reference_map 键：清除旧评论并记录已采集的零评论', async () => {
    const harness = makeHarness();
    await makeEngine(harness, new DocxCommentMockClient('# 正文\n', REFMAP_WITH_COMMENTS))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(harness.store.listSourceCommentsBySrc(SRC)).toHaveLength(2);
    const result = await makeEngine(harness, new DocxCommentMockClient('# 正文\n'))
      .syncDocuments([makeChangedDoc(harness.kbRoot, { changeType: 'modified' })], SYNC_OPTIONS);
    expect(result.success).toBe(true);
    expect(harness.store.listSourceCommentsBySrc(SRC)).toEqual([]);
    expect(harness.store.getSourceCommentMeta(SRC)).toMatchObject({ total: 0, truncated: false });
    harness.store.close();
  });

  it('reference_map 存在但无 comments 组（无评论）：meta 记 total=0（与从未采集区分）', async () => {
    const harness = makeHarness();
    const result = await makeEngine(harness, new DocxCommentMockClient('# 正文\n', { 'html5-block': {} }))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(result.success).toBe(true);
    expect(harness.store.listSourceCommentsBySrc(SRC)).toEqual([]);
    expect(harness.store.getSourceCommentMeta(SRC)).toMatchObject({ total: 0, truncated: false });
    harness.store.close();
  });

  it('rebuild（references-rebuild）不重建评论：行与采集状态原样保留', async () => {
    const harness = makeHarness();
    await makeEngine(harness, new DocxCommentMockClient('# 正文\n', REFMAP_WITH_COMMENTS))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    // 另一篇已同步文档没有评论。
    const OTHER = 'srcDocxComment000002';
    await makeEngine(harness, new DocxCommentMockClient('# 其他\n'))
      .syncDocuments([makeChangedDoc(harness.kbRoot, {
        objToken: OTHER,
        wikiNodeToken: 'wikDocxComment000002',
        title: '无评论文档',
        localMdPath: path.join(harness.kbRoot, '无评论文档.md'),
      })], SYNC_OPTIONS);
    const otherMeta = harness.store.getSourceCommentMeta(OTHER);
    expect(otherMeta).toMatchObject({ total: 0 });

    const before = harness.store.listSourceCommentsBySrc(SRC);
    const metaBefore = harness.store.getSourceCommentMeta(SRC);
    const rebuild = rebuildSourceReferences(harness.store, harness.kbRoot);
    expect(rebuild.rebuilt).toBeGreaterThanOrEqual(1);

    // 评论只在同步时采集：rebuild 纯本地无 refmap → 行与 meta 逐字不变，
    // 也不改变 OTHER 的采集状态。
    expect(harness.store.listSourceCommentsBySrc(SRC)).toEqual(before);
    expect(harness.store.getSourceCommentMeta(SRC)).toEqual(metaBefore);
    expect(harness.store.getSourceCommentMeta(OTHER)).toEqual(otherMeta);
    harness.store.close();
  });
});

describe('raw_comments 只读工具（agent 工具面，设计 §5.1 硬约束）', () => {
  const documents: DocumentRecord[] = [
    { objToken: SRC, objType: 'docx', title: '评论文档' } as DocumentRecord,
  ];

  function makeService(commentsMap: Map<string, { meta: unknown; comments: unknown[] }> = new Map()) {
    return new AgentToolService({
      dataRoot: os.tmpdir(),
      documentsProvider: () => documents,
      comments: (objToken: string) => ({
        meta: (commentsMap.get(objToken)?.meta ?? null) as never,
        comments: (commentsMap.get(objToken)?.comments ?? []) as never,
      }),
    });
  }

  it('登记断言：discuss/work 白名单含 raw_comments；build 白名单不含（不变量 1）', () => {
    // pi --tools 参数面（构建 spawn 的 tools 即此面）。
    expect(toolsForRunKind('discuss')).toContain('raw_comments');
    expect(toolsForRunKind('work')).toContain('raw_comments');
    expect(toolsForRunKind('build')).not.toContain('raw_comments');
    // 服务白名单面（族注册表派生）。
    const service = makeService();
    expect(service.createRunContext({ runKind: 'discuss', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).context.allowedTools)
      .toContain('raw_comments');
    expect(service.createRunContext({ runKind: 'work', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).context.allowedTools)
      .toContain('raw_comments');
    expect(service.createRunContext({ runKind: 'build', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).context.allowedTools)
      .not.toContain('raw_comments');
  });

  it('执行：输出 <untrusted_comments> 包裹、属性与转义、details 元数据', async () => {
    const service = makeService(new Map([
      [SRC, {
        meta: { srcObjToken: SRC, total: 2, truncated: true, updatedAt: '2026-10-28T10:00:00.000Z' },
        comments: [
          { commentRef: 'c1', text: '含 <标签> 与 "引号"', quote: '划词 & 原文', author: '张三', createdAtCloud: '2026-09-12T08:21:00Z', solved: false },
          { commentRef: 'c2', text: '已解决', quote: null, author: null, createdAtCloud: null, solved: true },
        ],
      }],
    ]));
    const { token } = service.createRunContext({ runKind: 'discuss', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() });
    const result = await service.executeTool(token, 'raw_comments', { objToken: SRC });
    const text = result.content[0].text;
    expect(text).toContain('<untrusted_comments obj_token="srcDocxComment000001" total="2" truncated="true">');
    expect(text).toContain('</untrusted_comments>');
    expect(text).toContain('<comment ref="c1" author="张三" at="2026-09-12T08:21:00Z" solved="false">');
    expect(text).toContain('<quote>划词 &amp; 原文</quote>');
    expect(text).toContain('含 &lt;标签&gt; 与 &quot;引号&quot;');
    expect(text).toContain('<comment ref="c2" solved="true">');
    expect(result.details).toMatchObject({ objToken: SRC, total: 2, truncated: true, collected: true });
  });

  it('文档不存在 → 404 not_found；从未采集（meta null）→ 包裹内说明、collected=false', async () => {
    const service = makeService();
    const { token } = service.createRunContext({ runKind: 'work', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() });
    await expect(service.executeTool(token, 'raw_comments', { objToken: 'missingToken0000001' }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });

    const result = await service.executeTool(token, 'raw_comments', { objToken: SRC });
    expect(result.content[0].text).toContain('该文档没有采集过评论');
    expect(result.details).toMatchObject({ collected: false, total: 0, truncated: false });
  });

  it('零评论（已采集）：total=0 + 「（无评论）」占位', async () => {
    const service = makeService(new Map([
      [SRC, {
        meta: { srcObjToken: SRC, total: 0, truncated: false, updatedAt: '2026-10-28T10:00:00.000Z' },
        comments: [],
      }],
    ]));
    const { token } = service.createRunContext({ runKind: 'discuss', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() });
    const result = await service.executeTool(token, 'raw_comments', { objToken: SRC });
    expect(result.content[0].text).toContain('total="0" truncated="false"');
    expect(result.content[0].text).toContain('（无评论）');
  });
});

describe('GET /api/mapping/comments/:objToken（预览面板数据面）', () => {
  function makeApp(store: LocalMapStore) {
    const app = new Hono();
    app.use('*', (c, next) => {
      (c as any).localMapStore = store;
      (c as any).configManager = { getConfig: () => ({ knowledgeBaseRoot: '/unused' }) };
      return next();
    });
    app.route('/', contentRoutes);
    return app;
  }

  it('已采集：collected=true + total/truncated/列表；文档不存在 404；从未采集 collected=false', async () => {
    const harness = makeHarness();
    harness.store.upsertDocument(makeDocumentRow(SRC));
    harness.store.replaceSourceComments(SRC, [
      { commentRef: 'c1', text: '评论一', author: '张三', solved: false },
    ], { truncated: true });
    const app = makeApp(harness.store);

    const ok = await app.request(`/api/mapping/comments/${SRC}`);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ objToken: SRC, collected: true, total: 1, truncated: true });
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]).toMatchObject({ commentRef: 'c1', author: '张三', solved: false });

    const missing = await app.request('/api/mapping/comments/missingToken0000001');
    expect(missing.status).toBe(404);

    harness.store.upsertDocument(makeDocumentRow('srcNeverCollected02', { objType: 'sheet' }));
    const never = await app.request('/api/mapping/comments/srcNeverCollected02');
    expect(never.status).toBe(200);
    expect(await never.json()).toMatchObject({ collected: false, total: 0, truncated: false, comments: [] });
    harness.store.close();
  });
});
