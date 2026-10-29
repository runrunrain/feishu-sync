/**
 * P1-S3 同步事务内写引用边（设计 P1 §2.2）— SyncEngine 全链路（真实
 * LocalMapStore + docx mock fetch）：
 *
 *  - 同步成功 → 引用边随正文同一 DB 事务入库（body 主体 + refmap 补充
 *    合并归一；comments 保留组排除；自引用丢弃）；
 *  - 重同步 → 旧边被替换而非累积（幂等）；
 *  - TestHooks failAfterMarkDocumentSynced → DB 事务中止：边随基线与正文
 *    一起回滚（设计验收「同步提交失败时边回滚」）；
 *  - fetch 响应无 reference_map 键（RP-3 实测形态）→ 容错零 refmap 边，
 *    body 边照常（既有 mock 无该键时的兼容面）；
 *  - sources.references-rebuild（reference-rebuild.ts）→ 本地 md 纯重算
 *    等价（body 边 == 直接抽取；refmap 边按设计清除、随下次同步补齐；
 *    脏文档跳过）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { rebuildSourceReferences } from '../src/sources/reference-rebuild.js';
import { extractDocumentReferences } from '../src/kb/reference-graph.js';
import { sourcesRoutes } from '../src/routes/sources.js';
import { Hono } from 'hono';
import type { ChangedDocument } from '../src/types/index.js';

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

// token 形态守卫：16–64 位字母数字（与抽取层一致）。
const SRC = 'srcDocxRef000000001';
const WIKI = 'wikSrcRef0000000001';
const TGT_BODY_1 = 'tgtBodyRef00000001';
const TGT_BODY_2 = 'tgtBodyRef00000002';
const TGT_CITE_1 = 'tgtCiteRef00000001';
const TGT_REFMAP_1 = 'tgtRefmapRef000001';

/** docx 全链路 mock：只提供 fetchDocumentMarkdown（无媒体/子表 → 无下载调用）。 */
class DocxRefMockClient {
  constructor(
    private readonly content: string,
    /** undefined = 响应整体没有 reference_map 键（RP-3）。 */
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

const CONTENT_V1 = [
  '# 文档甲',
  '',
  `[目标B](https://example.feishu.cn/docx/${TGT_BODY_1})`,
  '',
  `<cite doc-id="${TGT_CITE_1}" file-type="docx" title="被引标题"></cite>`,
  '',
  // 自引用（wiki node 形态）：丢弃。
  `[自己](https://example.feishu.cn/wiki/${WIKI})`,
  '',
  // 非飞书资源路径：不是边。
  '[外链](https://example.com/none)',
  '',
].join('\n');

const CONTENT_V2 = [
  '# 文档甲（改）',
  '',
  `[新目标](https://example.feishu.cn/docx/${TGT_BODY_2})`,
  '',
].join('\n');

const REFMAP_V1 = {
  comments: { c1: { data: '<comment comment-id="c1"><msg>评论不是引用</msg></comment>' } },
  'html5-block': { html5_1: { token: TGT_REFMAP_1, type: 'docx', title: 'sidecar 引用' } },
};

function makeChangedDoc(kbRoot: string, overrides: Partial<ChangedDocument> = {}): ChangedDocument {
  return {
    objToken: SRC,
    wikiNodeToken: WIKI,
    objType: 'docx',
    title: '文档甲',
    changeType: 'added',
    cloudModifiedTime: '2026-10-28T10:00:00.000Z',
    localSyncedTime: null,
    localMdPath: path.join(kbRoot, '文档甲.md'),
    observedObjEditTime: 1789000000,
    ...overrides,
  };
}

interface Harness {
  store: LocalMapStore;
  kbRoot: string;
  opDir: string;
}

function makeHarness(): Harness {
  const kbRoot = makeTempDir('sync-refs-kb-');
  const opDir = makeTempDir('sync-refs-ops-');
  const dbDir = makeTempDir('sync-refs-db-');
  const store = new LocalMapStore(path.join(dbDir, 'feishu-sync.db'));
  store.initialize();
  return { store, kbRoot, opDir };
}

function makeEngine(harness: Harness, client: DocxRefMockClient, testHooks?: Record<string, boolean>): SyncEngine {
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

const SYNC_OPTIONS = {
  enableLLM: false,
  fullSync: false,
  apply: true,
  confirmation: 'APPLY',
} as const;

/** 与 reference-rebuild.stripSyncHeader 同口径：剥 feishu_sync 头取正文。 */
function stripSyncHeader(content: string): string {
  if (!content.startsWith('<!--')) return content;
  const end = content.indexOf('-->');
  if (end === -1) return content;
  if (!/feishu_sync\s*:/.test(content.slice(0, end))) return content;
  let start = end + 3;
  if (content.slice(start, start + 2) === '\n\n') start += 2;
  return content.slice(start);
}

describe('SyncEngine 引用边入库（P1-S3，设计 §2.2）', () => {
  it('同步成功：body + refmap 合并入库；comments 排除、自引用丢弃；入边可按双键反查', async () => {
    const harness = makeHarness();
    const engine = makeEngine(harness, new DocxRefMockClient(CONTENT_V1, REFMAP_V1));

    const result = await engine.syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(result.success).toBe(true);
    expect(result.failedDocuments).toHaveLength(0);
    expect(result.syncedDocuments[0].referencesTruncated).toBeFalsy();

    const edges = harness.store.listSourceReferencesBySrc(SRC);
    expect(edges.map((row) => `${row.origin}|${row.kind}|${row.targetToken}|${row.label}`).sort()).toEqual([
      `body|cite|${TGT_CITE_1}|被引标题`,
      `body|link|${TGT_BODY_1}|目标B`,
      `refmap|html5-block|${TGT_REFMAP_1}|sidecar 引用`,
    ].sort());
    // comments 保留组与自引用不在结果中。
    expect(edges.some((row) => row.targetToken === WIKI)).toBe(false);

    // 入边：按 obj_token 键命中，附源行元数据。
    const incoming = harness.store.listSourceReferencesByTarget([TGT_BODY_1]);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({
      srcObjToken: SRC,
      srcTitle: '文档甲',
      srcLocalRelPath: '文档甲.md',
      targetType: 'docx',
    });
    harness.store.close();
  });

  it('重同步：旧边被替换而非累积（幂等替换语义）', async () => {
    const harness = makeHarness();
    await makeEngine(harness, new DocxRefMockClient(CONTENT_V1, REFMAP_V1))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(harness.store.listSourceReferencesBySrc(SRC)).toHaveLength(3);

    const second = await makeEngine(harness, new DocxRefMockClient(CONTENT_V2, REFMAP_V1))
      .syncDocuments([
        makeChangedDoc(harness.kbRoot, {
          changeType: 'modified',
          localSyncedTime: '2026-10-28T10:00:00.000Z',
          observedObjEditTime: 1789000100,
        }),
      ], SYNC_OPTIONS);
    expect(second.success).toBe(true);

    // 旧 body/cite 边被替换消失，不累积；refmap 边来自同次 fetch 响应，照常入库。
    const edges = harness.store.listSourceReferencesBySrc(SRC);
    expect(edges.map((row) => `${row.origin}|${row.targetToken}`).sort()).toEqual([
      `body|${TGT_BODY_2}`,
      `refmap|${TGT_REFMAP_1}`,
    ].sort());
    expect(edges.find((row) => row.targetToken === TGT_BODY_2)).toMatchObject({
      origin: 'body', kind: 'link', label: '新目标',
    });
    harness.store.close();
  });

  it('TestHooks failAfterMarkDocumentSynced：DB 事务中止 → 边随基线与正文一起回滚（设计验收）', async () => {
    const harness = makeHarness();
    await makeEngine(harness, new DocxRefMockClient(CONTENT_V1, REFMAP_V1))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    const baseline = harness.store.getDocumentByObjToken(SRC)!.syncedObjEditTime;
    expect(harness.store.listSourceReferencesBySrc(SRC)).toHaveLength(3);

    const failed = await makeEngine(
      harness,
      new DocxRefMockClient(CONTENT_V2, REFMAP_V1),
      { failAfterMarkDocumentSynced: true },
    ).syncDocuments([
      makeChangedDoc(harness.kbRoot, {
        changeType: 'modified',
        localSyncedTime: '2026-10-28T10:00:00.000Z',
        observedObjEditTime: 1789000200,
      }),
    ], SYNC_OPTIONS);

    // 同步失败（注入点在 markDocumentSynced 之后 → 整个事务回滚）。
    expect(failed.success).toBe(false);
    expect(failed.failedDocuments).toHaveLength(1);
    // 基线未推进。
    expect(harness.store.getDocumentByObjToken(SRC)!.syncedObjEditTime).toBe(baseline);
    expect(harness.store.getDocumentByObjToken(SRC)!.syncState).toBe('synced');
    // 边回滚：仍是 v1 的 3 条，v2 边不存在。
    const edges = harness.store.listSourceReferencesBySrc(SRC);
    expect(edges).toHaveLength(3);
    expect(edges.some((row) => row.targetToken === TGT_BODY_2)).toBe(false);
    // 正文回滚：文件仍是 v1（无 v2 链接）。
    const md = fs.readFileSync(path.join(harness.kbRoot, '文档甲.md'), 'utf-8');
    expect(md).toContain(TGT_BODY_1);
    expect(md).not.toContain(TGT_BODY_2);
    harness.store.close();
  });

  it('fetch 响应无 reference_map 键（RP-3）：容错零 refmap 边，body 边照常', async () => {
    const harness = makeHarness();
    const result = await makeEngine(harness, new DocxRefMockClient(CONTENT_V1))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(result.success).toBe(true);

    const edges = harness.store.listSourceReferencesBySrc(SRC);
    expect(edges.map((row) => row.origin)).toEqual(['body', 'body']);
    expect(edges.every((row) => row.origin === 'body')).toBe(true);
    harness.store.close();
  });
});

describe('POST /api/sources/references-rebuild（P1-S3 路由面）', () => {
  it('confirm 门 + 全链路：错误确认 400；REBUILD 确认后重建并返回结果', async () => {
    const harness = makeHarness();
    const app = new Hono();
    app.route('/', sourcesRoutes({
      configManager: { load: async () => ({ knowledgeBaseRoot: harness.kbRoot }) },
      localMapStore: harness.store,
      kbBuild: { isActive: () => false },
      dataRoot: harness.opDir,
    } as any));

    // 现场准备：一篇 synced 文档 + 边。
    await makeEngine(harness, new DocxRefMockClient(CONTENT_V1, REFMAP_V1))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    expect(harness.store.listSourceReferencesBySrc(SRC)).toHaveLength(3);

    // 非 REBUILD 确认值 → 400，且不动边。
    const rejected = await app.request('/api/sources/references-rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'REBUILD-NOPE' }),
    });
    expect(rejected.status).toBe(400);
    expect(await (await rejected.json()).error).toBe('confirmation_required');
    expect(harness.store.listSourceReferencesBySrc(SRC)).toHaveLength(3);

    // 正确确认 → 重建成功（body-only）。缺 body → invalid_json 400。
    const badJson = await app.request('/api/sources/references-rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(badJson.status).toBe(400);

    const ok = await app.request('/api/sources/references-rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'REBUILD' }),
    });
    expect(ok.status).toBe(200);
    const payload = await ok.json();
    expect(payload).toMatchObject({ scanned: 1, rebuilt: 1, skipped: [], truncatedDocs: 0 });
    expect(harness.store.listSourceReferencesBySrc(SRC)).toHaveLength(2); // body 边（refmap 被设计性清除）
    harness.store.close();
  });
});

describe('sources.references-rebuild（P1-S3，设计 §2.2 存量段）', () => {
  it('拒绝指向知识库外的符号链接，并保留旧引用', () => {
    const harness = makeHarness();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'other.md'), `[外部](https://x.feishu.cn/docx/${TGT_BODY_1})`);
      fs.symlinkSync(outside, path.join(harness.kbRoot, 'link'), 'dir');
      harness.store.upsertDocument({
        objToken: SRC, objType: 'docx', title: '链接', status: 'synced',
        localMdPath: path.join(harness.kbRoot, 'link', 'other.md'),
        localRelPath: 'link/other.md', lastSyncedAt: '2026-10-28T00:00:00.000Z',
        lastSyncedModifyTime: '2026-10-28T00:00:00.000Z',
      } as any);
      const prior = extractDocumentReferences({ markdown: `[旧引用](https://x.feishu.cn/docx/${TGT_BODY_2})` }).edges;
      harness.store.replaceSourceReferences(SRC, prior);
      const result = rebuildSourceReferences(harness.store, harness.kbRoot);
      expect(result.rebuilt).toBe(0);
      expect(result.skipped).toContainEqual({ objToken: SRC, title: '链接', reason: 'outside_root' });
      expect(harness.store.listSourceReferencesBySrc(SRC).map((edge) => edge.targetToken)).toEqual([TGT_BODY_2]);
    } finally {
      harness.store.close();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('本地 md 纯重算等价：body 边 == 直接抽取；refmap 边按设计清除；脏文档跳过', async () => {
    const harness = makeHarness();
    await makeEngine(harness, new DocxRefMockClient(CONTENT_V1, REFMAP_V1))
      .syncDocuments([makeChangedDoc(harness.kbRoot)], SYNC_OPTIONS);
    // 同步入库含 refmap 边（3 条）。
    expect(harness.store.listSourceReferencesBySrc(SRC)).toHaveLength(3);

    // 重建：只从本地 md 重抽 body 边（零云端调用）。
    const rebuild = rebuildSourceReferences(harness.store, harness.kbRoot);
    expect(rebuild.scanned).toBe(1);
    expect(rebuild.rebuilt).toBe(1);
    expect(rebuild.skipped).toEqual([]);
    expect(rebuild.truncatedDocs).toBe(0);

    // 等价：与对「文件正文（剥头）」直接跑组合抽取（无 refmap）一致。
    const md = fs.readFileSync(path.join(harness.kbRoot, '文档甲.md'), 'utf-8');
    const expected = extractDocumentReferences({
      markdown: stripSyncHeader(md),
      selfTokens: [SRC, WIKI],
    });
    const edges = harness.store.listSourceReferencesBySrc(SRC);
    expect(edges.map((row) => `${row.origin}|${row.kind}|${row.targetToken}`).sort()).toEqual(
      expected.edges.map((row) => `${row.origin}|${row.kind}|${row.targetToken}`).sort(),
    );
    // refmap 边被设计性清除（随下次同步补齐）。
    expect(edges.some((row) => row.origin === 'refmap')).toBe(false);
    expect(rebuild.totalEdges).toBe(edges.length);
    expect(rebuild.replacedEdges).toBe(3);

    // 幂等：重放 rebuild 结果不变。
    const again = rebuildSourceReferences(harness.store, harness.kbRoot);
    expect(again.totalEdges).toBe(rebuild.totalEdges);
    expect(harness.store.listSourceReferencesBySrc(SRC)).toHaveLength(edges.length);

    // 脏文档不动：source_edits 行 dirty → 跳过，边保持原样。
    harness.store.createSourceEdit({
      objToken: SRC,
      localRelPath: '文档甲.md',
      baseObjEditTime: null,
      baseBodyHash: 'hash-base',
      currentBodyHash: 'hash-current',
      lastActor: 'ui',
    });
    const dirtyRebuild = rebuildSourceReferences(harness.store, harness.kbRoot);
    expect(dirtyRebuild.rebuilt).toBe(0);
    expect(dirtyRebuild.skipped).toEqual([
      { objToken: SRC, title: '文档甲', reason: 'local_edit_pending' },
    ]);
    expect(harness.store.listSourceReferencesBySrc(SRC)).toHaveLength(edges.length);
    harness.store.close();
  });

  it('无成功基线/文件缺失的行跳过并给出 reason，不误删其他文档的边', () => {
    const harness = makeHarness();
    const kbRoot = harness.kbRoot;

    // synced 文档 A（文件在场，正文含指向 B 的链接）。
    fs.writeFileSync(path.join(kbRoot, 'a.md'), `# A\n\n[B](https://x.feishu.cn/docx/${TGT_BODY_1})\n`);
    harness.store.upsertDocument({
      objToken: 'syncedA000000000001',
      wikiNodeToken: null,
      objType: 'docx',
      title: 'A',
      localMdPath: path.join(kbRoot, 'a.md'),
      localRelPath: 'a.md',
      lastSyncedModifyTime: '2026-10-28T00:00:00.000Z',
      lastSyncedAt: '2026-10-28T00:00:00.000Z',
      status: 'synced',
    } as any);
    harness.store.markDocumentSynced({
      objToken: 'syncedA000000000001',
      syncedObjEditTime: 1789000000,
      localMdPath: path.join(kbRoot, 'a.md'),
      lastSyncedModifyTime: '2026-10-28T00:00:00.000Z',
      lastSyncedAt: '2026-10-28T00:00:00.000Z',
    });

    // 从未同步的行（无成功基线）：跳过。
    harness.store.upsertDocument({
      objToken: 'neverSynced0000001',
      wikiNodeToken: null,
      objType: 'docx',
      title: '占位',
      localMdPath: path.join(kbRoot, 'never.md'),
      lastSyncedModifyTime: '',
      lastSyncedAt: '',
      status: 'placeholder',
    } as any);

    // synced 但文件缺失：跳过（file_missing）。
    harness.store.upsertDocument({
      objToken: 'goneFile0000000001',
      wikiNodeToken: null,
      objType: 'docx',
      title: '文件已失',
      localMdPath: path.join(kbRoot, 'gone.md'),
      localRelPath: 'gone.md',
      lastSyncedModifyTime: '2026-10-28T00:00:00.000Z',
      lastSyncedAt: '2026-10-28T00:00:00.000Z',
      status: 'synced',
    } as any);

    const result = rebuildSourceReferences(harness.store, kbRoot);
    expect(result.scanned).toBe(2); // A + goneFile（neverSynced 无基线不计入）
    expect(result.rebuilt).toBe(1);
    expect(result.skipped.map((skip) => [skip.objToken, skip.reason]).sort()).toEqual([
      ['goneFile0000000001', 'file_missing'],
    ]);
    expect(harness.store.listSourceReferencesBySrc('syncedA000000000001')).toHaveLength(1);
    harness.store.close();
  });
});
