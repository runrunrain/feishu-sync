/**
 * Orphan local files - 孤立本地文件扫描与清理（2026-09-04）
 *
 * 需求背景：同步根 URL 从配置移除后，其 <localDir>/ 目录及散档仍留在
 * 知识库根目录下（DB 数据已由 purgeWatchedRootData 级联清理，但文件
 * 属于用户数据，不做静默删除）。本模块提供「扫描 → dry-run 列表 →
 * 点击清理到回收站」链路。
 *
 * 归属判定（保守优先，绝不误伤用户自有内容）：
 *   - 一级目录：在任一 watchedRoot（含停用）的 localDir 顶层段内 → 有主；
 *     否则仅当目录内存在带 feishu_sync 头的 .md（同步产物标记）才列为孤立
 *   - 根下散文件 / _custom 根散档：必须带 feishu_sync 头才列为孤立
 *   - _custom 一级子目录：custom_folders.local_rel_path 有记录 → 有主；
 *     无记录且不含任何 .md → 空壳孤立（含 .md 的会被 reconcile 自动纳管）
 *   - ScanPolicy 保留目录（.staging/.trash-bin 等）永远跳过
 *
 * 清理动作：移动到 <root>/.trash-bin/orphan-<timestamp>/<原相对路径>，
 * 可恢复，绝不直接删除（.trash-bin 在 ScanPolicy 排除清单内，不进索引）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WatchedRootConfig } from '../types/index.js';
import { ScanPolicy } from './scan-policy.js';

export interface OrphanItem {
  /** 相对知识库根的 POSIX 风格路径（展示与清理寻址用） */
  relPath: string;
  type: 'dir' | 'file';
  /** 目录/文件内首个发现的同步产物标记路径（证据，展示用） */
  evidence: string | null;
}

export interface OrphanScanResult {
  rootDir: string;
  items: OrphanItem[];
}

export interface OrphanCleanupResult {
  trashDir: string;
  moved: Array<{ relPath: string }>;
  failed: Array<{ relPath: string; error: string }>;
}

/** 文件内是否带 feishu_sync 头部标记（只做标记探测，不完整 parse）。 */
function hasFeishuSyncMarker(absolutePath: string): boolean {
  try {
    const fd = fs.openSync(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead).toString('utf-8');
      return head.includes('feishu_sync:');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 目录内（递归）是否存在带 feishu_sync 头的 .md；找到首个即停。 */
function dirContainsSyncMarker(absoluteDir: string): string | null {
  let stack: string[] = [absoluteDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ScanPolicy.shouldSkipDirectory(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (hasFeishuSyncMarker(full)) return path.relative(absoluteDir, full);
      }
    }
  }
  return null;
}

/** 路径越界守卫：目标必须仍在 rootDir 内。 */
function assertInsideRoot(rootDir: string, target: string): void {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path escapes knowledge base root: ${target}`);
  }
}

export function scanOrphanFiles(
  rootDir: string,
  watchedRoots: WatchedRootConfig[],
  customFolderRelPaths: string[],
): OrphanScanResult {
  const items: OrphanItem[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return { rootDir, items };
  }

  // 有主一级目录名集合：所有 watchedRoot（含停用，停用根的文件仍受保护）
  // 的 localDir 首段 + _custom + 系统保留名
  const ownedTopDirs = new Set<string>(['_custom']);
  for (const root of watchedRoots) {
    const first = root.localDir.split('/')[0];
    if (first) ownedTopDirs.add(first);
  }
  const ownedCustomSet = new Set(customFolderRelPaths.map((p) => p.split('/')[0]));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      if (ScanPolicy.shouldSkipDirectory(entry.name)) continue;
      if (entry.name === '_custom') {
        // _custom 一级子目录：有 custom_folder 记录 → 有主；
        // 无记录且不含 .md → 空壳孤立（含 .md 的由 reconcile 自动纳管）
        let customEntries: fs.Dirent[];
        try {
          customEntries = fs.readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ce of customEntries) {
          if (!ce.isDirectory() || ScanPolicy.shouldSkipDirectory(ce.name)) continue;
          if (ownedCustomSet.has(ce.name)) continue;
          const sub = path.join(full, ce.name);
          const hasMd = fs.readdirSync(sub, { withFileTypes: true })
            .some((x) => x.isFile() && x.name.endsWith('.md'));
          if (!hasMd) {
            items.push({ relPath: `_custom/${ce.name}`, type: 'dir', evidence: null });
          }
        }
        continue;
      }
      if (ownedTopDirs.has(entry.name)) continue;
      // 无主目录：必须是同步产物（内含 feishu_sync 头）才列为孤立
      const evidence = dirContainsSyncMarker(full);
      if (evidence !== null) {
        items.push({ relPath: entry.name, type: 'dir', evidence });
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md') && !ScanPolicy.shouldSkipFile(entry.name)) {
      if (hasFeishuSyncMarker(full)) {
        items.push({ relPath: entry.name, type: 'file', evidence: entry.name });
      }
    }
  }

  return { rootDir, items };
}

/**
 * 清理孤立项到 <root>/.trash-bin/orphan-<ts>/，保持原相对路径结构。
 * 逐项隔离失败（单项失败不影响其余），返回成功/失败明细。
 * 与同步引擎同款安全语义：需要 confirmation === 'APPLY' 才执行，
 * 否则视为 dry-run 只返回将要移动的清单。
 */
export function cleanupOrphanFiles(
  rootDir: string,
  items: OrphanItem[],
  confirmation: string,
): OrphanCleanupResult & { dryRun: boolean } {
  if (confirmation !== 'APPLY') {
    return { dryRun: true, trashDir: '', moved: [], failed: [] };
  }
  const trashDir = path.join(rootDir, '.trash-bin', `orphan-${Date.now()}`);
  const moved: Array<{ relPath: string }> = [];
  const failed: Array<{ relPath: string; error: string }> = [];

  fs.mkdirSync(trashDir, { recursive: true });
  for (const item of items) {
    try {
      const src = path.join(rootDir, ...item.relPath.split('/'));
      assertInsideRoot(rootDir, src);
      if (!fs.existsSync(src)) {
        failed.push({ relPath: item.relPath, error: 'not_found' });
        continue;
      }
      const dest = path.join(trashDir, ...item.relPath.split('/'));
      assertInsideRoot(trashDir, dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      moved.push({ relPath: item.relPath });
    } catch (error) {
      failed.push({ relPath: item.relPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { dryRun: false, trashDir, moved, failed };
}
