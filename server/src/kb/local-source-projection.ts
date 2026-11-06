/** 将可验证的历史本地版本投影为只读构建源，不改写索引或云端同步状态。 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../agent/path-guard.js';
import { localPathState } from '../modules/local-path-state.js';
import { toPortableRelative } from '../modules/path-resolver.js';
import { readLocalDocumentIdentity, recoverLocalDocument } from '../modules/recover-local-document.js';
import type { RawSourceSnapshotEntry } from '../types/agent-knowledge.js';
import type { DocumentRecord } from '../types/index.js';
import { hasSuccessfulLocalVersion } from './raw-source-snapshot.js';

/** A published identity can outlive its local index row, e.g. after removal of
 * a watched root. Reattach only a matching file at its published location. */
export function recoverPublishedSource(root: string, source: RawSourceSnapshotEntry): DocumentRecord | null {
  try {
    const file = resolveInside(root, source.relPath, 'read');
    if (!fs.statSync(file).isFile()) return null;
    const identity = readLocalDocumentIdentity(file);
    if (identity?.obj_token !== source.objToken) return null;
    const type = source.objType;
    return {
      objToken: source.objToken, title: source.title,
      objType: type === 'docx' || type === 'sheet' || type === 'slides' || type === 'bitable' ? type : 'unknown',
      wikiNodeToken: identity.wiki_node_token ?? null, originalLink: identity.original_link ?? null,
      localMdPath: file, localRelPath: source.relPath,
      lastSyncedAt: '', lastSyncedModifyTime: '', status: 'synced', recoveredLocalVersion: true,
    };
  } catch { return null; }
}

export function recoverUnindexedPublishedSources(root: string, documents: DocumentRecord[],
  published: RawSourceSnapshotEntry[], deleted: ReadonlySet<string>): DocumentRecord[] {
  if (!root || !published.length) return documents;
  const tokens = new Set(documents.map(doc => doc.objToken));
  const pathKey = (file: string) => process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);
  const occupied = new Set(documents.flatMap(doc => doc.localRelPath ? [pathKey(doc.localRelPath)]
    : doc.localMdPath ? [pathKey(path.relative(root, doc.localMdPath))] : []));
  const recovered = [];
  for (const source of published) {
    const key = pathKey(source.relPath);
    if (tokens.has(source.objToken) || deleted.has(source.objToken) || occupied.has(key)) continue;
    const doc = recoverPublishedSource(root, source);
    if (!doc) continue;
    recovered.push(doc);
    occupied.add(key);
    tokens.add(source.objToken);
  }
  return [...documents, ...recovered];
}

export function projectKnowledgeDocuments(root: string, documents: DocumentRecord[]): DocumentRecord[] {
  if (!root) return documents;
  const owners = new Map<string, Set<string>>();
  const key = (rel: string) => process.platform === 'win32' ? rel.toLowerCase() : rel;
  for (const doc of documents) {
    const rel = doc.localRelPath || (doc.localMdPath ? toPortableRelative(root, doc.localMdPath) : null);
    if (!rel) continue;
    const normalized = key(rel.replace(/\\/g, '/'));
    const tokens = owners.get(normalized) ?? new Set<string>();
    tokens.add(doc.objToken); owners.set(normalized, tokens);
  }
  return documents.map((doc) => {
    if (doc.pendingReason === 'local_deleted') return doc;
    const mdRel = doc.localMdPath ? toPortableRelative(root, doc.localMdPath) : null;
    if (doc.localMdPath && !mdRel) return doc;
    if (doc.localRelPath && mdRel && key(doc.localRelPath.replace(/\\/g, '/')) !== key(mdRel)) return doc;
    const mapped = doc.localRelPath || mdRel;
    if (mapped && hasSuccessfulLocalVersion(doc)) return doc.localRelPath ? doc : { ...doc, localRelPath: mapped };
    // 标识唯一、Wiki 身份相符，且路径位于原始库内时才能使用历史文件。
    const recovered = recoverLocalDocument(root, { ...doc, localMdPath: '' }, { allowAnyState: true });
    const rel = recovered ? toPortableRelative(root, recovered) : null;
    if (!recovered || !rel || (mapped && key(mapped.replace(/\\/g, '/')) !== key(rel))) return doc;
    const pathOwners = owners.get(key(rel));
    if (pathOwners && [...pathOwners].some((token) => token !== doc.objToken)) return doc;
    return { ...doc, localMdPath: recovered, localRelPath: rel, recoveredLocalVersion: true };
  });
}

/** 子表索引可能缺失于正常同步记录和历史记录；同名 CSV 附件都必须
 * 进入来源快照，供 raw_read 与证据门禁读取并在构建期间校验变更。 */
export function recoveredSourceCsvPaths(root: string, doc: DocumentRecord | undefined, mapped: string[]): string[] {
  if (!doc?.localRelPath || !['sheet', 'bitable'].includes(doc.objType)) return mapped;
  const rel = doc.localRelPath.replace(/\\/g, '/');
  const csvDir = path.posix.join(path.posix.dirname(rel), `${path.posix.basename(rel).replace(/\.md$/i, '')}.csv-data`);
  const state = localPathState(root, csvDir, 'directory');
  if (state === 'missing') return mapped;
  if (state !== 'present') throw new Error('历史表格附件目录不可读取或越出知识库，请检查后重试');
  const dir = resolveInside(root, csvDir, 'read');
  const discovered = fs.readdirSync(dir, { withFileTypes: true })
    .filter((item) => /\.csv$/i.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => {
      const file = resolveInside(root, `${csvDir}/${item.name}`, 'read');
      if (!fs.statSync(file).isFile()) throw new Error('历史表格附件不是普通文件');
      return file;
    });
  const unique = new Map<string, string>();
  for (const file of [...mapped, ...discovered]) {
    const absolute = path.resolve(root, file);
    unique.set(process.platform === 'win32' ? absolute.toLowerCase() : absolute, absolute);
  }
  return [...unique.values()];
}
