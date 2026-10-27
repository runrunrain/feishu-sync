/**
 * RawSourceSnapshot — 原始库快照（设计 §6.1）
 *
 * 源集合 = documents 中已有成功本地同步版本、local_rel_path 非空且文件
 * 存在的行（结构树成员与 _custom/ 归档都算）。成功版本由
 * synced_obj_edit_time / sync_state / 历史 status='synced' 等基线证据判断
 * —— 不能只过滤当前 status='synced'：检测把状态改成 changed、后续同步
 * 失败标 error 时，已有本地版本仍是合法原始源。
 *
 * 原始库在全链路只有读操作；读取时校验 realpath 围栏与 sha256。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPathInside, PathGuardError, resolveInside } from '../agent/path-guard.js';
import type { DocumentRecord } from '../types/index.js';
import type { RawSourceSnapshotEntry } from '../types/agent-knowledge.js';

/** 判断一行是否有成功本地版本的基线证据。 */
export function hasSuccessfulLocalVersion(record: DocumentRecord): boolean {
  if (record.syncedObjEditTime !== null && record.syncedObjEditTime !== undefined) return true;
  if (record.syncState === 'synced') return true;
  if (record.status === 'synced') return true;
  // 旧 IndexScanner 的成功本地版本可能只有时间戳，后续云端观测可把状态改为 changed/error。
  if (typeof record.lastSyncedAt === 'string' && record.lastSyncedAt.trim()
    && Number.isFinite(Date.parse(record.lastSyncedAt)) && Date.parse(record.lastSyncedAt) > 0) return true;
  // 首次未成功同步的 placeholder 排除；error 行若从未成功过也排除
  return false;
}

/** 从 DB 行构造候选源集合（不读文件）。 */
export function collectSourceCandidates(documents: DocumentRecord[]): DocumentRecord[] {
  const seen = new Set<string>();
  const result: DocumentRecord[] = [];
  for (const record of documents) {
    if (!record.objToken || seen.has(record.objToken)) continue;
    if (!record.localRelPath || record.localRelPath.trim().length === 0) continue;
    // cloudDeleted 是云端观测；只要成功本地版本仍在，就不能冒充本地源删除。
    if (!hasSuccessfulLocalVersion(record)) continue;
    seen.add(record.objToken);
    result.push(record);
  }
  return result;
}

export interface SnapshotBuildResult {
  entries: RawSourceSnapshotEntry[];
  /** 候选存在但文件缺失（不算源删除——只是暂不可读） */
  missingFiles: Array<{ objToken: string; relPath: string }>;
}

/** 计算一个源的完整性哈希：主文档 + sheet CSV 附件（scan/readVerified 共用）。 */
function resolveAttachment(root: string, csvPath: string): string {
  const rootReal = fs.realpathSync.native(root);
  // macOS /var ↔ /private/var、/tmp ↔ /private/tmp 等根别名先归一，不能误拒合法绝对路径。
  const relative = path.isAbsolute(csvPath) ? path.relative(rootReal, fs.realpathSync.native(csvPath)) : csvPath;
  const resolved = resolveInside(rootReal, relative, 'read');
  if (!fs.statSync(resolved).isFile()) throw new PathGuardError('not_found', 'CSV 附件不是普通文件');
  return resolved;
}

export function computeSourceHash(realPath: string, csvPaths: string[], root = path.dirname(realPath)): string {
  const combined = crypto.createHash('sha256');
  combined.update(fs.readFileSync(realPath));
  for (const csv of csvPaths) {
    combined.update(fs.readFileSync(resolveAttachment(root, csv)));
  }
  return `sha256:${combined.digest('hex')}`;
}

export class RawSourceSnapshot {
  private readonly entriesByToken = new Map<string, RawSourceSnapshotEntry>();

  constructor(
    entries: RawSourceSnapshotEntry[],
    private readonly options: {
      knowledgeBaseRoot?: string;
      sheetCsvPaths?: (objToken: string) => string[];
    } = {},
  ) {
    for (const entry of entries) {
      this.entriesByToken.set(entry.objToken, entry);
    }
  }

  static fromEntries(
    entries: RawSourceSnapshotEntry[],
    options: {
      knowledgeBaseRoot?: string;
      sheetCsvPaths?: (objToken: string) => string[];
    } = {},
  ): RawSourceSnapshot {
    return new RawSourceSnapshot(entries, options);
  }

  /**
   * 扫描原始库生成快照：sha256 冻结 + realpath 围栏。
   * knowledgeBaseRoot 为空或不存在时返回空快照（构建前置校验另行报错）。
   */
  static scan(
    knowledgeBaseRoot: string,
    documents: DocumentRecord[],
    sheetCsvPaths: (objToken: string) => string[] = () => [],
  ): SnapshotBuildResult {
    const entries: RawSourceSnapshotEntry[] = [];
    const missingFiles: Array<{ objToken: string; relPath: string }> = [];
    if (!knowledgeBaseRoot) return { entries, missingFiles };

    let rootReal: string | null = null;
    try {
      rootReal = fs.realpathSync.native(knowledgeBaseRoot);
    } catch {
      return { entries, missingFiles };
    }

    for (const record of collectSourceCandidates(documents)) {
      const target = path.join(rootReal, record.localRelPath!);
      let targetReal: string;
      try {
        targetReal = fs.realpathSync.native(target);
      } catch {
        missingFiles.push({ objToken: record.objToken, relPath: record.localRelPath! });
        continue;
      }
      if (!isPathInside(rootReal, targetReal)) {
        // 越出围栏的行不进快照（防御：localRelPath 被污染）
        missingFiles.push({ objToken: record.objToken, relPath: record.localRelPath! });
        continue;
      }
      // 主文件已确认存在；附件失效/逃逸必须使整次扫描失败，不能静默把已有源当成删除。
      const contentHash = computeSourceHash(targetReal, sheetCsvPaths(record.objToken), rootReal);
      entries.push({
        objToken: record.objToken,
        objType: record.objType,
        title: record.title || record.localRelPath!,
        relPath: record.localRelPath!,
        contentHash,
        objEditTime: record.observedObjEditTime != null
          ? String(record.observedObjEditTime)
          : record.objEditTime != null ? String(record.objEditTime) : null,
      });
    }
    return { entries, missingFiles };
  }

  get entries(): RawSourceSnapshotEntry[] {
    return [...this.entriesByToken.values()];
  }

  get(objToken: string): RawSourceSnapshotEntry | null {
    return this.entriesByToken.get(objToken) ?? null;
  }

  has(objToken: string): boolean {
    return this.entriesByToken.has(objToken);
  }

  get size(): number {
    return this.entriesByToken.size;
  }

  /**
   * 计算一个源的完整性哈希：主文档 + sheet CSV 附件。scan 与
   * readVerified 必须用同一函数，否则 sheet 文档会被误判为构建期间变更。
   */
  private computeHash(realPath: string, objToken: string, root: string): string {
    return computeSourceHash(realPath, this.options.sheetCsvPaths?.(objToken) ?? [], root);
  }

  /**
   * 读取快照内原始文件并校验：realpath 在 root 内且当前 sha256 与快照
   * 一致。不一致 → source_changed_during_build。
   */
  readVerified(
    knowledgeBaseRoot: string,
    objToken: string,
  ): { content: string; realPath: string; entry: RawSourceSnapshotEntry; attachments: Array<{ path: string; content: string }> } {
    const entry = this.entriesByToken.get(objToken);
    if (!entry) {
      throw new PathGuardError('not_found', `objToken 不在快照内: ${objToken}`);
    }
    const rootReal = fs.realpathSync.native(knowledgeBaseRoot);
    const target = path.join(rootReal, entry.relPath);
    const targetReal = fs.realpathSync.native(target);
    if (!isPathInside(rootReal, targetReal)) {
      throw new PathGuardError('path_escape', `原始源越出知识库根: ${entry.relPath}`);
    }
    const stat = fs.statSync(targetReal);
    if (!stat.isFile()) {
      throw new PathGuardError('not_found', `原始源不是文件: ${entry.relPath}`);
    }
    const currentHash = this.computeHash(targetReal, objToken, rootReal);
    if (currentHash !== entry.contentHash) {
      throw new PathGuardError(
        'source_changed_during_build',
        `原始源在构建期间被修改: ${entry.relPath}（期望 ${entry.contentHash.slice(0, 16)}… 实际 ${currentHash.slice(0, 16)}…）`,
      );
    }
    const attachments: Array<{ path: string; content: string }> = [];
    for (const csv of this.options.sheetCsvPaths?.(objToken) ?? []) {
      attachments.push({ path: csv, content: fs.readFileSync(resolveAttachment(rootReal, csv), 'utf-8') });
    }
    return { content: fs.readFileSync(targetReal, 'utf-8'), realPath: targetReal, entry, attachments };
  }
}

export function hashPath(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}
