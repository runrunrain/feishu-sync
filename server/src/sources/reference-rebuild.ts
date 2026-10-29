/**
 * sources.references-rebuild — 引用边全量重建（P1-S3，设计 P1 §2.2）。
 *
 * 语义（设计 §2.2「存量」段）：
 *  - 只从本地 md 重新提取 **body 边**（零云端调用）；refmap 边随各文档
 *    下次自然同步补齐——为补 refmap 对全库重新 fetch 的代价与限流风险
 *    远大于 refmap 独有边的增量价值。
 *  - 每个源「先删旧边再插新边」（replaceSourceReferences），全库一批
 *    一个事务；重建结果与下次同步重算等价（body 部分）。
 *  - 脏文档（source_edits dirty/pushing/conflict）跳过不动——本地正文
 *    含未写回修改，重算会产生与任何同步基线都不一致的边；下次成功
 *    同步自然重算（与生命周期「脏文档不动」同一原则）。
 *
 * 输入口径：只扫「有成功同步基线且本地身份存在」的活行（cloud_deleted
 * 行的文件已被移入 .trash-bin，不在原路径）。成功判定与
 * LocalMapStore.pruneMissingLocalDocs 同款（status/sync_state/synced 基线/
 * lastSyncedAt 任一成立）。
 *
 * 头部处理：当前规范 feishu_sync 头（YAML-in-HTML-comment）整体剥除后再
 * 抽取——同步链抽取的是无头 finalContent，两端输入一致；头内的
 * original_link 自引用本就被 selfTokens 过滤，剥头是口径对齐而非防误判。
 * 其他 HTML 注释不是同步头，保持原样（宽容）。
 *
 * 路由：POST /api/sources/references-rebuild（confirm:'REBUILD'）；
 * 命令：sources.references-rebuild（mutate，agentExposed=false）。
 */

import fs from 'node:fs';
import { extractDocumentReferences } from '../kb/reference-graph.js';
import { toPortableRelative } from '../modules/path-resolver.js';
import { PathGuardError, resolveInside } from '../agent/path-guard.js';
import type { LocalMapStore } from '../modules/local-map-store.js';
import type { DocumentRecord } from '../types/index.js';

export type ReferencesRebuildSkipReason =
  | 'local_edit_pending'
  | 'file_missing'
  | 'outside_root'
  | 'read_failed';

export interface ReferencesRebuildSkip {
  objToken: string;
  title: string;
  reason: ReferencesRebuildSkipReason;
}

export interface ReferencesRebuildResult {
  /** 进入重建考量的已同步文档数（不含 cloud_deleted / 无本地身份 / 无成功基线的行）。 */
  scanned: number;
  /** 实际完成边替换的文档数。 */
  rebuilt: number;
  skipped: ReferencesRebuildSkip[];
  /** 重建后入库的出边总数。 */
  totalEdges: number;
  /** 重建时被删除的旧边总数（含被替换与被清空的）。 */
  replacedEdges: number;
  /** 引用边超上限被截断的文档数（references_truncated，§2.1）。 */
  truncatedDocs: number;
}

/** 重建读取上限：同步产物 md 均为应用生成，超限视为异常读而非慢读。 */
const REBUILD_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** 剥除当前规范 feishu_sync 头；非同步头的 HTML 注释与其他格式保持原样。 */
function stripSyncHeader(content: string): string {
  if (!content.startsWith('<!--')) return content;
  const commentEnd = content.indexOf('-->');
  if (commentEnd === -1) return content;
  if (!/feishu_sync\s*:/.test(content.slice(0, commentEnd))) return content;
  let bodyStart = commentEnd + 3;
  if (content.slice(bodyStart, bodyStart + 2) === '\n\n') bodyStart += 2;
  return content.slice(bodyStart);
}

/** 与 pruneMissingLocalDocs 同款的成功基线判定（任一成立即视为已同步过）。 */
function hasSuccessfulBaseline(doc: DocumentRecord): boolean {
  if (doc.status === 'synced' || doc.syncState === 'synced' || doc.syncedObjEditTime != null) {
    return true;
  }
  const parsed = Date.parse(doc.lastSyncedAt ?? '');
  return Number.isFinite(parsed) && parsed > 0;
}

export function rebuildSourceReferences(
  store: LocalMapStore,
  knowledgeBaseRoot: string,
): ReferencesRebuildResult {
  const result: ReferencesRebuildResult = {
    scanned: 0,
    rebuilt: 0,
    skipped: [],
    totalEdges: 0,
    replacedEdges: 0,
    truncatedDocs: 0,
  };
  if (!knowledgeBaseRoot) {
    throw new Error('knowledgeBaseRoot 未配置，无法重建引用边');
  }

  interface PendingRebuild {
    objToken: string;
    edges: ReturnType<typeof extractDocumentReferences>['edges'];
    truncated: boolean;
  }
  const pending: PendingRebuild[] = [];

  for (const doc of store.getAllDocuments()) {
    // 回收站行（文件已移 .trash-bin）与无本地身份/无成功基线的行不参与。
    if ((doc.cloudDeleted ?? 0) === 1) continue;
    if (!doc.localRelPath && !doc.localMdPath) continue;
    if (!hasSuccessfulBaseline(doc)) continue;
    result.scanned += 1;

    // 脏文档不动（任务书生命周期原则；下次同步自然重算）。
    const edit = typeof store.getSourceEdit === 'function' ? store.getSourceEdit(doc.objToken) : null;
    if (edit && edit.state !== 'pushed') {
      result.skipped.push({ objToken: doc.objToken, title: doc.title, reason: 'local_edit_pending' });
      continue;
    }

    const rel =
      (doc.localMdPath ? toPortableRelative(knowledgeBaseRoot, doc.localMdPath) : null) ??
      (doc.localRelPath ? toPortableRelative(knowledgeBaseRoot, doc.localRelPath) : null);
    if (!rel) {
      result.skipped.push({ objToken: doc.objToken, title: doc.title, reason: 'file_missing' });
      continue;
    }
    let abs: string;
    let stat: fs.Stats;
    try {
      abs = resolveInside(knowledgeBaseRoot, rel, 'read');
      stat = fs.statSync(abs);
    } catch (error) {
      const reason = error instanceof PathGuardError && error.code !== 'not_found'
        ? 'outside_root' : 'file_missing';
      result.skipped.push({ objToken: doc.objToken, title: doc.title, reason });
      continue;
    }
    try {
      if (!stat.isFile() || stat.size > REBUILD_MAX_FILE_BYTES) {
        result.skipped.push({ objToken: doc.objToken, title: doc.title, reason: 'read_failed' });
        continue;
      }
      const content = fs.readFileSync(abs, 'utf-8');
      // body-only：referenceMap 缺省（不重新 fetch，refmap 边随下次同步补齐）。
      const extraction = extractDocumentReferences({
        markdown: stripSyncHeader(content),
        selfTokens: [doc.objToken, doc.wikiNodeToken],
      });
      pending.push({ objToken: doc.objToken, edges: extraction.edges, truncated: extraction.truncated });
    } catch {
      result.skipped.push({ objToken: doc.objToken, title: doc.title, reason: 'read_failed' });
    }
  }

  // 全库一批一个事务：重建要么整体落库，要么整体不动。
  store.withTransaction(() => {
    for (const item of pending) {
      const replaced = store.replaceSourceReferences(item.objToken, item.edges);
      result.rebuilt += 1;
      result.totalEdges += replaced.inserted;
      result.replacedEdges += replaced.deleted;
      if (item.truncated) result.truncatedDocs += 1;
    }
  });

  return result;
}
