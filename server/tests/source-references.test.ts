/**
 * P1-S3 引用入库（source_references，设计 P1 §2.2/§2.3）— LocalMapStore 层：
 *
 *  - 迁移双登记断言（fresh 库建表 + getCreateTablesDDL + 旧库重建，与
 *    source_push_log / kb_publications 同款验收口径）；
 *  - replaceSourceReferences：先删旧边再插新边（替换幂等、零边清空）；
 *  - 按源查 / 按目标查（双键并集 + 源行元数据 LEFT JOIN）/ 计数；
 *  - 生命周期钩：deleteDocumentByToken / clearLocalDocument（pending 分支）/
 *    purgeCloudDeleted / purgeWatchedRootData / pruneMissingLocalDocs 孤儿清扫。
 *
 * 真实 better-sqlite3（与生产同绑定）：证明 initialize() 建出的表正是方法
 * 所需的表，而非 SQL 镜像推断。
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import type { SourceReferenceInsert } from '../src/modules/local-map-store.js';
import type { DocumentRecord } from '../src/types/index.js';

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-src-refs-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'feishu-sync.db');
}

function createRootDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-src-refs-kb-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

const TOKEN_MIN = 16;
const t = (prefix: string, n: number) => `${prefix}${String(n).padStart(TOKEN_MIN - prefix.length, '0')}`;

function edge(overrides: Partial<SourceReferenceInsert> = {}): SourceReferenceInsert {
  return {
    targetToken: t('tgt', 1),
    targetType: 'docx',
    title: '目标标题',
    origin: 'body',
    kind: 'link',
    occurrences: 1,
    ...overrides,
  };
}

function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    objToken: t('src', 1),
    wikiNodeToken: t('wik', 1),
    objType: 'docx',
    title: '源文档',
    localMdPath: '',
    lastSyncedModifyTime: '2026-10-28T00:00:00.000Z',
    lastSyncedAt: '2026-10-28T00:00:00.000Z',
    status: 'synced',
    ...overrides,
  };
}

describe('LocalMapStore source_references（P1-S3，设计 §2.2）', () => {
  it('双登记断言：fresh 库建表 + getCreateTablesDDL 与 applyAdditiveMigrations 两处 DDL 一致', () => {
    const dbPath = createDatabasePath();
    const store = new LocalMapStore(dbPath);
    store.initialize();
    store.close();

    // ① fresh 库（getCreateTablesDDL 侧）：表、索引、列序就位。
    const database = new Database(dbPath, { readonly: true });
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    const indexes = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'source_references'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    const columns = (database.prepare('PRAGMA table_info(source_references)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    const pk = (database.prepare('PRAGMA table_info(source_references)').all() as Array<{ pk: number; name: string }>)
      .filter((row) => row.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((row) => row.name);
    database.close();
    expect(tables).toContain('source_references');
    expect(indexes).toContain('idx_source_references_target');
    expect(columns).toEqual([
      'src_obj_token', 'target_token', 'target_type', 'origin', 'kind',
      'label', 'occurrences', 'updated_at',
    ]);
    // §2.2 主键：(src_obj_token, target_token, origin, kind)
    expect(pk).toEqual(['src_obj_token', 'target_token', 'origin', 'kind']);

    // ② getCreateTablesDDL() 登记侧：DDL 文本携带建表语句。
    const probe = new LocalMapStore(dbPath);
    const ddl = (probe as unknown as { getCreateTablesDDL(): string }).getCreateTablesDDL();
    probe.close();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS source_references');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_source_references_target');

    // ③ applyAdditiveMigrations 登记侧：旧库（表被移除）再 initialize 重建。
    const legacy = new Database(dbPath);
    legacy.exec('DROP TABLE source_references');
    legacy.close();
    const upgraded = new LocalMapStore(dbPath);
    upgraded.initialize();
    expect(upgraded.listSourceReferencesBySrc(t('src', 1))).toEqual([]);
    upgraded.close();
    const reopened = new Database(dbPath, { readonly: true });
    expect((reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'source_references'").get() as { name: string } | undefined)?.name)
      .toBe('source_references');
    reopened.close();
  });

  it('replaceSourceReferences：先删旧边再插新边（替换幂等、零边清空、嵌套事务安全）', () => {
    const store = new LocalMapStore(createDatabasePath());
    store.initialize();
    const src = t('src', 1);

    const first = store.replaceSourceReferences(src, [
      edge({ targetToken: t('tgt', 1), occurrences: 2 }),
      edge({ targetToken: t('tgt', 2), origin: 'refmap', kind: 'html5-block', label: null }),
    ]);
    expect(first).toEqual({ deleted: 0, inserted: 2 });
    expect(store.listSourceReferencesBySrc(src)).toHaveLength(2);

    // 替换：目标集变化后旧边消失而非累积。
    const second = store.replaceSourceReferences(src, [
      edge({ targetToken: t('tgt', 3), occurrences: 5 }),
    ]);
    expect(second).toEqual({ deleted: 2, inserted: 1 });
    const rows = store.listSourceReferencesBySrc(src);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetToken: t('tgt', 3), srcObjToken: src, occurrences: 5, origin: 'body', kind: 'link' });

    // 幂等：同一集合重放，结果不变。
    store.replaceSourceReferences(src, [edge({ targetToken: t('tgt', 3), occurrences: 5 })]);
    expect(store.listSourceReferencesBySrc(src)).toHaveLength(1);

    // 零边清空：正文不再含引用 → 边集归零（§2.2 替换语义）。
    expect(store.replaceSourceReferences(src, [])).toEqual({ deleted: 1, inserted: 0 });
    expect(store.listSourceReferencesBySrc(src)).toEqual([]);

    // 嵌套事务：外层 withTransaction 内替换 → savepoint 语义，外层提交后可见。
    store.withTransaction(() => {
      store.replaceSourceReferences(src, [edge({ targetToken: t('tgt', 4) })]);
    });
    expect(store.listSourceReferencesBySrc(src)).toHaveLength(1);
    store.close();
  });

  it('按目标查入边：obj/wiki 双键并集 + 源行元数据 LEFT JOIN（源行已删时为 null）', () => {
    const store = new LocalMapStore(createDatabasePath());
    store.initialize();
    const srcA = t('src', 1);
    const srcB = t('src', 2);
    store.upsertDocument(makeDocument({ objToken: srcA, wikiNodeToken: t('wik', 1), title: '文档甲', localRelPath: '甲.md' }));
    // srcB 不建 documents 行：源行已删时入边保留（§2.2 生命周期）。
    store.replaceSourceReferences(srcA, [edge({ targetToken: t('tgt', 1), title: '甲的引用' })]);
    store.replaceSourceReferences(srcB, [
      edge({ targetToken: t('tgt', 1), occurrences: 3, title: null }),
      edge({ targetToken: t('wik', 9), origin: 'body', kind: 'cite', title: null }),
    ]);

    const intoTgt1 = store.listSourceReferencesByTarget([t('tgt', 1)]);
    expect(intoTgt1).toHaveLength(2);
    const fromA = intoTgt1.find((row) => row.srcObjToken === srcA);
    const fromB = intoTgt1.find((row) => row.srcObjToken === srcB);
    expect(fromA).toMatchObject({ srcTitle: '文档甲', srcLocalRelPath: '甲.md', label: '甲的引用' });
    // 源行已删：元数据为 null，但入边保留（真实信息）。
    expect(fromB).toMatchObject({ srcTitle: null, srcLocalRelPath: null, occurrences: 3 });

    // 双键并集：同一文档的 obj_token 与 wiki_node_token 两个键都命中。
    store.upsertDocument(makeDocument({ objToken: t('doc', 7), wikiNodeToken: t('wik', 9), title: '被引文档' }));
    const intoBoth = store.listSourceReferencesByTarget([t('doc', 7), t('wik', 9)]);
    expect(intoBoth.map((row) => row.srcObjToken)).toEqual([srcB]);
    // 空入参/无效键安全。
    expect(store.listSourceReferencesByTarget([])).toEqual([]);
    expect(store.listSourceReferencesByTarget([null, ''] as unknown as string[])).toEqual([]);

    // 计数（列表徽标）：按 target 分组。
    const counts = store.countSourceReferencesByTarget();
    expect(counts.get(t('tgt', 1))).toBe(2);
    expect(counts.get(t('wik', 9))).toBe(1);
    store.close();
  });

  it('生命周期：deleteDocumentByToken 删出边、保留指向它的入边', () => {
    const store = new LocalMapStore(createDatabasePath());
    store.initialize();
    const srcA = t('src', 1);
    const srcB = t('src', 2);
    store.upsertDocument(makeDocument({ objToken: srcA }));
    store.upsertDocument(makeDocument({ objToken: srcB }));
    store.replaceSourceReferences(srcA, [edge({ targetToken: t('tgt', 1) })]);
    store.replaceSourceReferences(srcB, [edge({ targetToken: srcA })]); // 指向 srcA 的入边

    expect(store.deleteDocumentByToken(srcA)).toBe(true);
    // 出边随源行同删；作为 target 的边保留。
    expect(store.listSourceReferencesBySrc(srcA)).toEqual([]);
    expect(store.listSourceReferencesByTarget([srcA])).toHaveLength(1);
    expect(store.listSourceReferencesBySrc(srcB)).toHaveLength(1);
    store.close();
  });

  it('生命周期：clearLocalDocument pending 分支（移出/屏蔽）清本地基线同时删出边', () => {
    const store = new LocalMapStore(createDatabasePath());
    store.initialize();
    const src = t('src', 1);
    store.upsertDocument(makeDocument({ objToken: src, status: 'synced', syncState: 'synced', localRelPath: 'x.md' }));
    store.replaceSourceReferences(src, [edge({ targetToken: t('tgt', 1) })]);

    // pending=true：行保留、本地基线清除 → 边同删（下次同步自然重算）。
    store.clearLocalDocument(src, { pending: true });
    expect(store.getDocumentByObjToken(src)).not.toBeNull();
    expect(store.listSourceReferencesBySrc(src)).toEqual([]);

    // 非 pending 且未屏蔽：行硬删 → 边同删（deleteDocumentByToken 路径）。
    store.replaceSourceReferences(src, [edge({ targetToken: t('tgt', 2) })]);
    store.clearLocalDocument(src, { pending: false });
    expect(store.getDocumentByObjToken(src)).toBeNull();
    expect(store.listSourceReferencesBySrc(src)).toEqual([]);
    store.close();
  });

  it('生命周期：purgeCloudDeleted 仅在行确实被硬删时删边；purgeWatchedRootData 级联清边', () => {
    const dbPath = createDatabasePath();
    const store = new LocalMapStore(dbPath);
    store.initialize();

    // 行非 deleted_confirmed → 不删行、不删边。
    const live = t('src', 1);
    store.upsertDocument(makeDocument({ objToken: live, status: 'synced', syncState: 'synced' }));
    store.replaceSourceReferences(live, [edge({ targetToken: t('tgt', 1) })]);
    store.purgeCloudDeleted(live);
    expect(store.getDocumentByObjToken(live)).not.toBeNull();
    expect(store.listSourceReferencesBySrc(live)).toHaveLength(1);

    // deleted_confirmed → 行与边同删。（sync_state 不在 upsertDocument 面，
    // 用独立连接直写 v5 列，模拟回收站确认态。）
    const dead = t('src', 2);
    store.upsertDocument(makeDocument({ objToken: dead, status: 'error', syncState: 'deleted_confirmed', cloudDeleted: 1 }));
    const writer = new Database(dbPath);
    writer.prepare("UPDATE documents SET sync_state = 'deleted_confirmed', cloud_deleted = 1 WHERE obj_token = ?").run(dead);
    writer.close();
    store.replaceSourceReferences(dead, [edge({ targetToken: t('tgt', 2) })]);
    store.purgeCloudDeleted(dead);
    expect(store.getDocumentByObjToken(dead)).toBeNull();
    expect(store.listSourceReferencesBySrc(dead)).toEqual([]);

    // watchedRoot 移除：根下全部出边级联清理（入边保留）。
    const rootUrl = 'https://example.feishu.cn/wiki/root0000000000001';
    const inRoot = t('src', 3);
    store.upsertDocument(makeDocument({
      objToken: inRoot, watchedRootUrl: rootUrl, watchedRootId: 'root0000000000001',
      status: 'synced', syncState: 'synced',
    }));
    store.replaceSourceReferences(inRoot, [
      edge({ targetToken: t('tgt', 3) }),
      edge({ targetToken: live }),
    ]);
    store.purgeWatchedRootData(rootUrl, 'root0000000000001');
    expect(store.getDocumentByObjToken(inRoot)).toBeNull();
    expect(store.listSourceReferencesBySrc(inRoot)).toEqual([]);
    store.close();
  });

  it('生命周期：pruneMissingLocalDocs 删行同时删边，并防御式清扫无源行孤儿边', () => {
    const rootDir = createRootDir();
    const store = new LocalMapStore(createDatabasePath());
    store.initialize();

    // 本地文件缺失的 synced 行 → 行与边同删。
    const missing = t('src', 1);
    store.upsertDocument(makeDocument({
      objToken: missing, status: 'synced', syncState: 'synced',
      localRelPath: 'missing.md', localMdPath: path.join(rootDir, 'missing.md'),
    }));
    store.replaceSourceReferences(missing, [edge({ targetToken: t('tgt', 1) })]);

    // 文件在场的 synced 行 → 保留。
    const present = t('src', 2);
    fs.writeFileSync(path.join(rootDir, 'present.md'), '# 在场\n');
    store.upsertDocument(makeDocument({
      objToken: present, status: 'synced', syncState: 'synced',
      localRelPath: 'present.md', localMdPath: path.join(rootDir, 'present.md'),
    }));

    const pruned = store.pruneMissingLocalDocs(rootDir);
    expect(pruned.prunedTokens).toEqual([missing]);
    expect(store.listSourceReferencesBySrc(missing)).toEqual([]);

    // 孤儿边（源行不在 documents）：NOT EXISTS 防御式清扫（与孤立
    // sheet_sheets 同款语义；正常删除路径不会产生孤儿，这里是克漏）。
    const orphan = t('src', 9);
    store.replaceSourceReferences(orphan, [edge({ targetToken: t('tgt', 1) })]);
    expect(store.listSourceReferencesBySrc(orphan)).toHaveLength(1);
    store.pruneMissingLocalDocs(rootDir);
    expect(store.listSourceReferencesBySrc(orphan)).toEqual([]);
    store.close();
  });
});
