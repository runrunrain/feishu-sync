/** 指定源回收：全量校验 → 同卷移动 → 元数据事务；失败恢复已移动文件。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInside, resolveRootReal } from '../agent/path-guard.js';
import { ToolError } from '../agent/agent-tool-service.js';
import { localPathState } from '../modules/local-path-state.js';
import { ScanPolicy } from '../modules/scan-policy.js';
import type { LocalMapStore } from '../modules/local-map-store.js';
import { managedWorkbookCompanions } from '../modules/workbook-source.js';
import { pendingLocalEditTokens } from '../sources/source-edit-service.js';
import { projectKnowledgeDocuments, recoveredSourceCsvPaths } from './local-source-projection.js';
import type { DocumentRecord } from '../types/index.js';

export function prepareSourceCleanup(store: LocalMapStore, root: string, sources: Array<{ objToken: string; relPath: string }>, options: { allowMissing?: boolean; commit?: () => void } = {}) {
  const rootReal = resolveRootReal(root);
  const originalRecords = store.getAllDocuments();
  const originals = new Map(originalRecords.map((doc) => [doc.objToken, doc]));
  const records = new Map(projectKnowledgeDocuments(root, originalRecords).filter((doc) => doc.localRelPath || doc.localMdPath).map((doc) => [doc.objToken, doc]));
  const csvPaths = (doc: DocumentRecord) => recoveredSourceCsvPaths(rootReal, doc, store.getSheetSheets(doc.objToken).map((sheet) => sheet.local_csv_path));
  const selected = [...new Map(sources.map((source) => [source.objToken, source])).values()].map((source) => {
    const record = records.get(source.objToken);
    const original = originals.get(source.objToken);
    const matchesLegacyAbsolute = !original?.localRelPath && original?.localMdPath === source.relPath;
    if (!record || record.cloudDeleted || ((record.localRelPath || record.localMdPath) !== source.relPath && !matchesLegacyAbsolute)) throw new ToolError('source_selection_changed', '源文档已变化，请刷新后重新选择', 409);
    return record;
  });
  // S11 守卫（设计 §7.3/§9.1-1a）：存在未写回本地修改（source_edits 非
  // pushed）的源拒绝清理/移动——本接口是全部源清理调用方（kb routes /
  // manual-delete / source-batch）的公共咽喉。store 无该方法（旧替身）时
  // 静默放行，保持既有行为。
  const pendingEdits = pendingLocalEditTokens(store as any, selected.map((doc) => doc.objToken));
  if (pendingEdits.length > 0) {
    throw new ToolError('local_edit_pending', `存在未写回的本地修改（${pendingEdits.join(', ')}），请先写回飞书或放弃修改`, 409);
  }
  const files = new Map<string, string>();
  const relativePath = (input: string) => {
    let rel = path.isAbsolute(input) ? path.relative(path.resolve(root), input) : input;
    if (path.isAbsolute(input) && (rel === '..' || rel.startsWith('..' + path.sep))) rel = path.relative(rootReal, input);
    return rel;
  };
  const addFile = (input: string, optional = false) => {
    const rel = relativePath(input);
    if (rel.split(/[\\/]/).some((part) => ScanPolicy.shouldSkipDirectory(part))) throw new ToolError('path_escape', '不能清理应用工作目录', 400);
    if (optional && localPathState(rootReal, rel) === 'missing') return;
    // write守卫拒绝symlink与硬链接；原文件必须为普通文件。
    let abs: string;
    try { abs = resolveInside(rootReal, rel, 'write'); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!stat && optional) return;
    if (!stat?.isFile()) throw new ToolError('source_selection_changed', '源文件已不存在或类型已变化，请刷新', 409);
    files.set(abs, path.relative(rootReal, abs));
  };
  for (const doc of selected) {
    const md = doc.localRelPath || doc.localMdPath;
    addFile(md, options.allowMissing);
    if (doc.objType === 'sheet') {
      const mdPath = path.resolve(rootReal, relativePath(md));
      for (const companion of managedWorkbookCompanions(mdPath)) addFile(companion, true);
    }
    for (const csv of csvPaths(doc)) addFile(csv, true);
  }
  const selectedTokens = new Set(selected.map((doc) => doc.objToken));
  for (const doc of records.values()) {
    if (selectedTokens.has(doc.objToken)) continue;
    const references = [doc.localRelPath || doc.localMdPath];
    if (doc.objType === 'sheet') {
      try { references.push(...managedWorkbookCompanions(resolveInside(rootReal, relativePath(doc.localRelPath || doc.localMdPath), 'read'))); }
      catch { /* A missing unselected source cannot share a live file. */ }
    }
    if (doc.objType === 'sheet' || doc.objType === 'bitable') references.push(...csvPaths(doc));
    for (const reference of references) {
      let resolved: string;
      try { resolved = resolveInside(rootReal, relativePath(reference), 'read'); } catch { continue; }
      if (files.has(resolved)) throw new ToolError('source_path_shared', '部分文件仍被未选中的文档共用，请先修复重复路径映射', 409);
    }
  }
  return { rootReal, selected, files };
}

export function cleanupSources(store: LocalMapStore, root: string, sources: Array<{ objToken: string; relPath: string }>, options: { allowMissing?: boolean; commit?: () => void } = {}) {
  const { rootReal, selected, files } = prepareSourceCleanup(store, root, sources, options);
  const id = `sources-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const trash = resolveInside(rootReal, `.trash-bin/${id}`, 'mkdir');
  // 保存恢复依据；重新添加或同步时可以使用回收目录中的原文件和映射记录。
  fs.writeFileSync(path.join(trash, 'cleanup.json'), JSON.stringify({ version: 1, root: rootReal, createdAt: new Date().toISOString(),
    documents: selected, sheets: selected.flatMap((doc) => store.getSheetSheets(doc.objToken)), files: [...files.values()] }, null, 2), { flag: 'wx' });
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const [from, relative] of files) {
      const destinationDir = path.dirname(`files/${relative}`).split(path.sep).join('/');
      resolveInside(trash, destinationDir, 'mkdir');
      const to = resolveInside(trash, `files/${relative}`, 'write');
      fs.renameSync(from, to); moved.push({ from, to });
    }
    if (options.commit) options.commit(); else store.withTransaction(() => {
      for (const doc of selected) store.markLocalSourceDeleted(root, doc);
      store.deleteDocumentsByTokens(selected.map((doc) => doc.objToken));
    });
  } catch (error) {
    const failures: string[] = [];
    for (const file of moved.reverse()) { try { fs.renameSync(file.to, file.from); } catch { failures.push(file.from); } }
    if (failures.length) throw new ToolError('source_cleanup_rollback_failed', `清理中断，部分文件保留在回收目录，请恢复：${trash}`, 500);
    fs.rmSync(trash, { recursive: true, force: true });
    throw error;
  }
  return { cleaned: selected.length, movedFiles: moved.length, trashDir: trash };
}
