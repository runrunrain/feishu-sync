/**
 * Operation manifest and write-safety primitives.
 *
 * The synchronizer must be able to explain every intended local change before
 * it fetches cloud content or touches the knowledge base.  Manifests live
 * outside the knowledge base so an audit cannot pollute a user's corpus.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ChangedDocument,
  PlannedSyncDocument,
  SyncPlanReasonCode,
  SyncMode,
  WatchedRootConfig,
} from '../types/index.js';
import { ScanPolicy } from './scan-policy.js';
import {
  resolveAbsolute,
  resolveLocalTarget,
  sanitizePathSegment as sanitizeResolverSegment,
  toPortableRelative,
} from './path-resolver.js';

export interface OperationManifest {
  schemaVersion: 1;
  operationId: string;
  mode: SyncMode;
  createdAt: string;
  completedAt?: string;
  knowledgeBaseRoot: string;
  documents: PlannedSyncDocument[];
  summary: {
    create: number;
    replace: number;
    blocked: number;
    succeeded?: number;
    failed?: number;
  };
}

export interface ManifestResultSummary {
  succeeded: number;
  failed: number;
}

export interface CreateOperationManifestOptions {
  knowledgeBaseRoot: string;
  documents: ChangedDocument[];
  mode: SyncMode;
  /** When provided, dry-run planning uses profile-aware PathResolver. */
  watchedRoots?: WatchedRootConfig[];
}

export interface KnowledgeBaseAudit {
  schemaVersion: 1;
  auditId: string;
  createdAt: string;
  knowledgeBaseRoot: string;
  files: Array<{
    relativePath: string;
    size: number;
    sha256: string;
  }>;
  skippedPaths: string[];
  summary: {
    fileCount: number;
    totalBytes: number;
    skippedCount: number;
  };
}

/**
 * Only an explicit, human-readable acknowledgement can enable a write.
 * Every legacy caller therefore becomes a dry-run automatically.
 */
export function resolveSyncMode(options: {
  apply?: boolean;
  confirmation?: string;
} | null | undefined): SyncMode {
  return options?.apply === true && options.confirmation === 'APPLY'
    ? 'apply'
    : 'dry-run';
}

/**
 * Operation artefacts must never be created alongside synced documents.
 */
export function resolveOperationDirectory(
  knowledgeBaseRoot: string,
  configuredDirectory?: string,
): string {
  const root = path.resolve(knowledgeBaseRoot);
  const directory = path.resolve(
    configuredDirectory || path.join(os.homedir(), '.feishu-sync', 'operations'),
  );

  if (isPathInside(root, directory) || root === directory) {
    throw new Error('operation manifest 目录不能位于知识库根目录内');
  }

  return directory;
}

/**
 * Produce a reviewable plan without any network or knowledge-base writes.
 */
export function createOperationManifest(
  options: CreateOperationManifestOptions,
): OperationManifest {
  if (!options.knowledgeBaseRoot || !options.knowledgeBaseRoot.trim()) {
    throw new Error('knowledgeBaseRoot 未配置，无法生成同步计划');
  }

  const root = path.resolve(options.knowledgeBaseRoot);
  const watchedRoots = options.watchedRoots ?? [];
  const occupied = new Set<string>();
  const documents = options.documents.map((document) => {
    const planned = planDocument(root, document, watchedRoots, occupied);
    if (planned.localRelPath) {
      occupied.add(planned.localRelPath);
    }
    return planned;
  });
  blockConflictingTargets(documents);

  return {
    schemaVersion: 1,
    operationId: `op-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`,
    mode: options.mode,
    createdAt: new Date().toISOString(),
    knowledgeBaseRoot: root,
    documents,
    summary: {
      create: documents.filter((item) => item.action === 'create').length,
      replace: documents.filter((item) => item.action === 'replace').length,
      blocked: documents.filter((item) => item.action === 'blocked').length,
    },
  };
}

/**
 * Persist a manifest atomically.  This is deliberately the first write of an
 * apply operation: if it cannot be recorded, the synchronizer must not run.
 */
export function writeOperationManifest(
  manifest: OperationManifest,
  operationDirectory: string,
): string {
  fs.mkdirSync(operationDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(operationDirectory, `${manifest.operationId}.json`);
  writeJsonAtomically(manifestPath, manifest);
  return manifestPath;
}

/** Update the same manifest after a dry-run or apply operation finishes. */
export function completeOperationManifest(
  manifest: OperationManifest,
  manifestPath: string,
  result: ManifestResultSummary,
): void {
  manifest.completedAt = new Date().toISOString();
  manifest.summary.succeeded = result.succeeded;
  manifest.summary.failed = result.failed;
  writeJsonAtomically(manifestPath, manifest);
}

/**
 * Build a deterministic, read-only hash baseline of a knowledge base. The
 * same narrow ScanPolicy used by indexing excludes operational artefacts from
 * the baseline, so regenerated reports and recovery files cannot create
 * misleading content diffs.
 */
export function createKnowledgeBaseAudit(knowledgeBaseRoot: string): KnowledgeBaseAudit {
  if (!knowledgeBaseRoot || !knowledgeBaseRoot.trim()) {
    throw new Error('knowledgeBaseRoot 未配置，无法建立审计基线');
  }

  const root = path.resolve(knowledgeBaseRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`知识库根目录不可读取：${root}`);
  }

  const files: KnowledgeBaseAudit['files'] = [];
  const skippedPaths: string[] = [];
  const walk = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        skippedPaths.push(relativePath);
      } else if (entry.isDirectory()) {
        if (ScanPolicy.shouldSkipDirectory(entry.name)) {
          skippedPaths.push(`${relativePath}/`);
        } else {
          walk(absolutePath);
        }
      } else if (entry.isFile()) {
        if (ScanPolicy.shouldSkipFile(entry.name)) {
          skippedPaths.push(relativePath);
        } else {
          const stat = fs.statSync(absolutePath);
          files.push({
            relativePath,
            size: stat.size,
            sha256: sha256File(absolutePath),
          });
        }
      }
    }
  };
  walk(root);

  return {
    schemaVersion: 1,
    auditId: `audit-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    knowledgeBaseRoot: root,
    files,
    skippedPaths,
    summary: {
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      skippedCount: skippedPaths.length,
    },
  };
}

/** Write a read-only audit baseline outside the knowledge base. */
export function writeKnowledgeBaseAudit(
  audit: KnowledgeBaseAudit,
  operationDirectory: string,
): string {
  fs.mkdirSync(operationDirectory, { recursive: true, mode: 0o700 });
  const auditPath = path.join(operationDirectory, `${audit.auditId}.json`);
  writeJsonAtomically(auditPath, audit);
  return auditPath;
}

/**
 * Legacy fallback when no watchedRoot can be resolved for a document.
 * Prefer PathResolver via watchedRoots; this keeps dry-run callable without
 * configuration during unit tests.
 */
export function fallbackMarkdownTarget(root: string, title: string): string {
  const safeTitle = sanitizeResolverSegment(title) || sanitizePathSegment(title) || 'untitled';
  return path.join(root, `${safeTitle}.md`);
}

function findWatchedRoot(
  document: ChangedDocument,
  watchedRoots: WatchedRootConfig[],
): WatchedRootConfig | null {
  if (!watchedRoots.length) return null;
  if (document.watchedRootId) {
    // A claimed root that is no longer configured is not an invitation to
    // silently place a document under another root, even if only one happens
    // to be enabled today.
    return watchedRoots.find((root) => root.id === document.watchedRootId) ?? null;
  }
  // Single enabled root: unambiguous default for fixtures.
  const enabled = watchedRoots.filter((root) => root.enabled);
  if (enabled.length === 1) return enabled[0];
  return null;
}

function documentPlanContext(document: ChangedDocument): Pick<
  PlannedSyncDocument,
  'watchedRootId' | 'wikiNodeToken' | 'parentChainTitles'
> {
  return {
    watchedRootId: document.watchedRootId ?? null,
    wikiNodeToken: document.wikiNodeToken ?? null,
    parentChainTitles: document.parentChainTitles ?? null,
  };
}

function blockedPlan(
  document: ChangedDocument,
  details: {
    reasonCode: SyncPlanReasonCode;
    reason: string;
    localRelPath?: string | null;
    candidateLocalRelPath?: string | null;
    suggestedResolution?: string;
  },
): PlannedSyncDocument {
  return {
    objToken: document.objToken,
    title: document.title,
    objType: document.objType,
    changeType: document.changeType,
    action: 'blocked',
    localMdPath: null,
    localRelPath: details.localRelPath ?? null,
    previousSha256: null,
    ...documentPlanContext(document),
    reasonCode: details.reasonCode,
    reason: details.reason,
    candidateLocalRelPath: details.candidateLocalRelPath ?? null,
    suggestedResolution: details.suggestedResolution,
  };
}

function reasonCodeForPathConflicts(
  conflicts: Array<{ kind: string }>,
): SyncPlanReasonCode {
  if (conflicts.some((conflict) => conflict.kind === 'missing-parent-chain')) {
    return 'missing_parent_chain';
  }
  if (conflicts.some((conflict) => conflict.kind === 'escape-root')) {
    return 'unsafe_path';
  }
  return 'path_conflict';
}

function planDocument(
  root: string,
  document: ChangedDocument,
  watchedRoots: WatchedRootConfig[],
  occupied: Set<string>,
): PlannedSyncDocument {
  if (document.changeType === 'deleted') {
    return blockedPlan(document, {
      reasonCode: 'deleted_requires_confirmation',
      reason: '删除需要独立的人工确认流程，当前同步操作不会删除本地文件',
      suggestedResolution: '通过独立删除确认流程复核后再执行。',
    });
  }

  const watchedRoot = findWatchedRoot(document, watchedRoots);
  if (watchedRoots.length > 0 && !watchedRoot) {
    return blockedPlan(document, {
      reasonCode: 'unknown_watched_root',
      reason: '文档的 watchedRootId 未匹配到当前启用配置，拒绝跨根或根目录回退',
      suggestedResolution: '核对 watchedRootId 与当前配置，再重新生成同步计划。',
    });
  }

  if (watchedRoot) {
    const resolved = resolveLocalTarget({
      knowledgeBaseRoot: root,
      watchedRoot,
      title: document.title,
      hasChild: document.hasChild === true,
      parentChainTitles: document.parentChainTitles,
      isWatchedRootNode: document.isWatchedRootNode,
      existingLocalRelPath: document.localRelPath ?? null,
      existingLocalMdPath: document.localMdPath,
      objType: document.objType,
      occupiedRelPaths: occupied,
      // Existing localMdPath that already points at a file is a replace, not
      // an overwrite of a foreign body — PathResolver handles this via
      // existing-mapping preference.
      rejectExistingFiles: !document.localMdPath && !document.localRelPath,
    });

    if (!resolved.ok || !resolved.target) {
      const candidateLocalRelPath =
        resolved.conflicts.find((conflict) => conflict.relativePath)?.relativePath ?? null;
      const reasonCode = reasonCodeForPathConflicts(resolved.conflicts);
      return blockedPlan(document, {
        reasonCode,
        reason:
          resolved.conflicts.map((item) => item.message).join('; ') ||
          'PathResolver 无法解析目标路径',
        candidateLocalRelPath,
        suggestedResolution:
          reasonCode === 'missing_parent_chain'
            ? '重新完成该 watched root 的云端遍历，补齐父链后再生成计划。'
            : '根据候选路径和冲突详情修正映射或布局后再生成计划。',
      });
    }

    const candidate = resolveAbsolute(root, resolved.target.relativeMarkdownPath);
    const unsafeReason = unsafePathReason(root, candidate);
    if (unsafeReason) {
      return blockedPlan(document, {
        reasonCode: 'unsafe_path',
        reason: unsafeReason,
        candidateLocalRelPath: resolved.target.relativeMarkdownPath,
        suggestedResolution: '修正映射或符号链接后重新生成计划。',
      });
    }

    const exists = fs.existsSync(candidate);
    if (exists && !fs.statSync(candidate).isFile()) {
      return blockedPlan(document, {
        reasonCode: 'path_conflict',
        reason: '目标路径存在但不是普通文件',
        localRelPath: resolved.target.relativeMarkdownPath,
        candidateLocalRelPath: resolved.target.relativeMarkdownPath,
        suggestedResolution: '人工处理同名目录或文件后重新生成计划。',
      });
    }

    const action = resolved.target.plannedMoveFrom
      ? 'move'
      : exists
        ? 'replace'
        : 'create';

    return {
      objToken: document.objToken,
      title: document.title,
      objType: document.objType,
      changeType: document.changeType,
      action,
      localMdPath: candidate,
      localRelPath: resolved.target.relativeMarkdownPath,
      previousSha256: exists ? sha256File(candidate) : null,
      ...documentPlanContext(document),
      plannedMoveFrom: resolved.target.plannedMoveFrom ?? null,
      pathSource: resolved.target.source,
      reasonCode: resolved.target.plannedMoveFrom ? 'planned_move' : undefined,
      reason: resolved.target.plannedMoveFrom
        ? `计划从 ${resolved.target.plannedMoveFrom} 迁移到规范路径`
        : undefined,
      suggestedResolution: resolved.target.plannedMoveFrom
        ? '通过独立迁移流程复核旧路径与新路径后再执行。'
        : undefined,
    };
  }

  const candidate = document.localMdPath
    ? resolveDocumentPath(root, document.localMdPath)
    : fallbackMarkdownTarget(root, document.title);
  const unsafeReason = unsafePathReason(root, candidate);

  if (unsafeReason) {
    return blockedPlan(document, {
      reasonCode: 'unsafe_path',
      reason: unsafeReason,
      suggestedResolution: '修正映射后重新生成计划。',
    });
  }

  const exists = fs.existsSync(candidate);
  if (exists && !fs.statSync(candidate).isFile()) {
    return blockedPlan(document, {
      reasonCode: 'path_conflict',
      reason: '计划目标不是常规文件，拒绝覆盖',
      candidateLocalRelPath: toPortableRelative(root, candidate),
      suggestedResolution: '人工处理同名目录或文件后重新生成计划。',
    });
  }

  return {
    objToken: document.objToken,
    title: document.title,
    objType: document.objType,
    changeType: document.changeType,
    action: exists ? 'replace' : 'create',
    localMdPath: candidate,
    localRelPath: toPortableRelative(root, candidate),
    previousSha256: exists ? sha256File(candidate) : null,
    ...documentPlanContext(document),
    pathSource: 'legacy-fallback',
  };
}

/**
 * A batch may contain duplicate titles or stale mappings that resolve to the
 * same file.  Do not pick a winner: both entries are blocked so a later
 * profile-aware resolver can surface a deterministic conflict report.
 */
function blockConflictingTargets(documents: PlannedSyncDocument[]): void {
  const firstByTarget = new Map<string, number>();
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    if (document.action === 'blocked' || !document.localMdPath) continue;

    const previousIndex = firstByTarget.get(document.localMdPath);
    if (previousIndex === undefined) {
      firstByTarget.set(document.localMdPath, index);
      continue;
    }

    const previous = documents[previousIndex];
    const reason = '多个云端文档解析到同一目标路径，已阻止自动覆盖';
    previous.action = 'blocked';
    previous.localMdPath = null;
    previous.previousSha256 = null;
    previous.reasonCode = 'path_conflict';
    previous.reason = reason;
    previous.candidateLocalRelPath = previous.localRelPath ?? null;
    previous.suggestedResolution = '为每个云端文档建立唯一映射后重新生成计划。';
    document.action = 'blocked';
    document.localMdPath = null;
    document.previousSha256 = null;
    document.reasonCode = 'path_conflict';
    document.reason = reason;
    document.candidateLocalRelPath = document.localRelPath ?? null;
    document.suggestedResolution = '为每个云端文档建立唯一映射后重新生成计划。';
  }
}

function resolveDocumentPath(root: string, rawPath: string): string {
  return path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(root, rawPath);
}

function unsafePathReason(root: string, candidate: string): string | null {
  if (!isPathInside(root, candidate)) {
    return '计划路径位于知识库根目录之外，已拒绝';
  }

  const relative = path.relative(root, candidate);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      return '计划路径经过符号链接目录，已拒绝';
    }
  }

  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
    return '计划目标是符号链接，已拒绝';
  }

  return null;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function sanitizePathSegment(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[.\s]+$/g, '')
    .trim();
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tempPath, filePath);
}
