/** 将可验证的历史本地版本投影为只读构建源，不改写索引或云端同步状态。 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../agent/path-guard.js';
import { localPathState } from '../modules/local-path-state.js';
import { toPortableRelative } from '../modules/path-resolver.js';
import { recoverLocalDocument } from '../modules/recover-local-document.js';
import type { DocumentRecord } from '../types/index.js';
import { hasSuccessfulLocalVersion } from './raw-source-snapshot.js';

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

/** 历史表格缺少子表索引时，同时冻结其同名 CSV 附件，避免只构建摘要。 */
export function recoveredSourceCsvPaths(root: string, doc: DocumentRecord | undefined, mapped: string[]): string[] {
  if (!doc?.recoveredLocalVersion || !doc.localRelPath || !['sheet', 'bitable'].includes(doc.objType)) return mapped;
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
