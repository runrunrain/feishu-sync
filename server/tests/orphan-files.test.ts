/**
 * watchedRoot 删除级联清理 + 孤立文件扫描/清理测试（2026-09-04）
 *
 * 覆盖：
 *   1. purgeWatchedRootData：documents/sheet_sheets/feishu_pending_items/
 *      localDirs 按 watched_root_url / watched_root_id 级联清除，其他根
 *      的数据不受影响（实测主诉：删除根后残留「未分类」）。
 *   2. scanOrphanFiles：含 feishu_sync 头的无主目录/散档被列出；有主
 *      （watchedRoot localDir / custom_folder / ScanPolicy 保留名）不列；
 *      无同步标记的用户自有目录不误伤。
 *   3. cleanupOrphanFiles：APPLY 移动到 .trash-bin 保持相对路径；
 *      非 APPLY 干跑零副作用；越界路径被拒。
 */

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { scanOrphanFiles, cleanupOrphanFiles, type OrphanItem } from '../src/modules/orphan-files.js';
import type { WatchedRootConfig } from '../src/types/index.js';

const temporaryDirectories: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SYNC_MD = `<!--\nfeishu_sync:\n  obj_token: tok-x\n  obj_type: docx\n-->\n\n# 内容\n`;
const PLAIN_MD = `# 用户自己的笔记，无云身份\n`;

describe('purgeWatchedRootData', () => {
  it('级联清理目标根的 documents/sheets/pending/localDirs，其他根不受影响', () => {
    const dbPath = path.join(createTempDir('feishu-purge-'), 'db.sqlite');
    const store = new LocalMapStore(dbPath);
    store.initialize();

    const upsert = (objToken: string, watchedRootUrl: string) => {
      store.upsertDocument({
        objToken,
        wikiNodeToken: `wiki-${objToken}`,
        objType: 'docx',
        title: `文档 ${objToken}`,
        localMdPath: `/tmp/dir-a/${objToken}.md`,
        lastSyncedModifyTime: '2026-09-04T00:00:00.000Z',
        lastSyncedAt: '2026-09-04T00:00:00.000Z',
        status: 'synced',
        watchedRootUrl,
      });
    };

    upsert('tok-keep', 'https://keep.feishu.cn/wiki/rootKeep');
    upsert('tok-del-1', 'https://del.feishu.cn/wiki/rootDel');
    upsert('tok-del-2', 'https://del.feishu.cn/wiki/rootDel');

    const purged = store.purgeWatchedRootData('https://del.feishu.cn/wiki/rootDel', 'rootDel');

    expect(purged.documents).toBe(2);
    const remaining = store.getAllDocuments().map((d) => d.objToken);
    expect(remaining).toContain('tok-keep');
    expect(remaining).not.toContain('tok-del-1');
    expect(remaining).not.toContain('tok-del-2');

    // 幂等：重复清理零计数
    expect(store.purgeWatchedRootData('https://del.feishu.cn/wiki/rootDel', 'rootDel'))
      .toEqual({ documents: 0, sheets: 0, pendingItems: 0, localDirs: 0 });
  });
});

function seedOrphanFixture(): { rootDir: string; roots: WatchedRootConfig[]; custom: string[] } {
  const rootDir = createTempDir('feishu-orphan-');
  // 有主：watchedRoot localDir
  fs.mkdirSync(path.join(rootDir, '技术 - Dev'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '技术 - Dev', 'doc.md'), SYNC_MD);
  // 有主：custom_folder（_custom/收藏/）
  fs.mkdirSync(path.join(rootDir, '_custom', '收藏'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '_custom', '收藏', 'a.md'), SYNC_MD);
  // 孤立目录：已删除根的残留，含同步标记
  fs.mkdirSync(path.join(rootDir, '旧知识库'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '旧知识库', 'old.md'), SYNC_MD);
  // 用户自有目录：无同步标记 → 不得列出
  fs.mkdirSync(path.join(rootDir, '我的私人资料'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '我的私人资料', 'note.md'), PLAIN_MD);
  // 孤立散档：根下带头的 md
  fs.writeFileSync(path.join(rootDir, '孤儿散档.md'), SYNC_MD);
  // 用户自有散档：无头 → 不列
  fs.writeFileSync(path.join(rootDir, '随手记.md'), PLAIN_MD);
  // _custom 空壳子目录（无 md）→ 孤立
  fs.mkdirSync(path.join(rootDir, '_custom', '空壳'), { recursive: true });
  // 系统保留目录 → 跳过
  fs.mkdirSync(path.join(rootDir, '.staging'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.staging', 'x.md'), SYNC_MD);

  const roots: WatchedRootConfig[] = [{
    id: 'rootKeep',
    url: 'https://keep.feishu.cn/wiki/rootKeep',
    localDir: '技术 - Dev',
    layoutProfile: 'mirror-title-file',
    enabled: true,
  }];
  return { rootDir, roots, custom: ['_custom/收藏'] };
}

describe('scanOrphanFiles / cleanupOrphanFiles', () => {
  it('只列出无主且含同步标记的孤立项', () => {
    const { rootDir, roots, custom } = seedOrphanFixture();
    const result = scanOrphanFiles(rootDir, roots, custom);
    const paths = result.items.map((i) => i.relPath).sort();
    expect(paths).toEqual(['_custom/空壳', '孤儿散档.md', '旧知识库']);
  });

  it('停用 watchedRoot 的目录仍受保护（不算孤立）', () => {
    const { rootDir, custom } = seedOrphanFixture();
    const roots: WatchedRootConfig[] = [{
      id: 'rootDisabled',
      url: 'https://x.feishu.cn/wiki/disabled',
      localDir: '旧知识库',
      layoutProfile: 'mirror-title-file',
      enabled: false,
    }];
    const result = scanOrphanFiles(rootDir, roots, custom);
    expect(result.items.map((i) => i.relPath)).not.toContain('旧知识库');
  });

  it('cleanup APPLY 移动到 .trash-bin 保持结构；非 APPLY 干跑', () => {
    const { rootDir, roots, custom } = seedOrphanFixture();
    const scanned = scanOrphanFiles(rootDir, roots, custom);

    const dry = cleanupOrphanFiles(rootDir, scanned.items, 'DRY_RUN');
    expect(dry.dryRun).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '旧知识库'))).toBe(true);

    const applied = cleanupOrphanFiles(rootDir, scanned.items, 'APPLY');
    expect(applied.dryRun).toBe(false);
    expect(applied.failed).toEqual([]);
    expect(applied.moved.length).toBe(3);
    // 原位置消失，回收站内结构保持
    expect(fs.existsSync(path.join(rootDir, '旧知识库'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '孤儿散档.md'))).toBe(false);
    const trashBase = applied.trashDir;
    expect(fs.existsSync(path.join(trashBase, '旧知识库', 'old.md'))).toBe(true);
    expect(fs.existsSync(path.join(trashBase, '孤儿散档.md'))).toBe(true);
    // 有主内容原封不动
    expect(fs.existsSync(path.join(rootDir, '技术 - Dev', 'doc.md'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '_custom', '收藏', 'a.md'))).toBe(true);
  });

  it('越界路径被拒（构造恶意 relPath）', () => {
    const { rootDir } = seedOrphanFixture();
    const evil: OrphanItem[] = [{ relPath: '../outside', type: 'dir', evidence: null }];
    const result = cleanupOrphanFiles(rootDir, evil, 'APPLY');
    expect(result.moved).toEqual([]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].error).toMatch(/escapes/);
  });
});
