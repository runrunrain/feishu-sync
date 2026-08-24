/**
 * Staging + atomic commit for knowledge-base file sets (P3).
 *
 * All writes go to an operation-local staging directory first. Commit renames
 * into place after validation; failure restores prior bytes from a rollback
 * snapshot kept outside the knowledge base.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ScanPolicy } from './scan-policy.js';

export type StageAction = 'create' | 'replace' | 'delete';

export interface StagedFileEntry {
  /** POSIX path relative to knowledgeBaseRoot. */
  relativePath: string;
  action: StageAction;
  /** Absolute path of staged new content (null for delete). */
  stagingAbsolutePath: string | null;
  /** Absolute final target under knowledge base. */
  targetAbsolutePath: string;
  previousSha256: string | null;
  newSha256: string | null;
}

export interface AtomicCommitPlan {
  operationId: string;
  knowledgeBaseRoot: string;
  stagingRoot: string;
  rollbackRoot: string;
  files: StagedFileEntry[];
}

export interface AtomicCommitResult {
  ok: boolean;
  committed: string[];
  restored: string[];
  error?: string;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function toAbsolute(root: string, relativePath: string): string {
  return path.resolve(root, ...relativePath.replace(/\\/g, '/').split('/').filter(Boolean));
}

function assertInsideRoot(root: string, absolute: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`路径逃逸知识库根: ${absolute}`);
  }
}

/**
 * Create staging/rollback dirs outside the knowledge base for one operation.
 */
export function createAtomicCommitWorkspace(options: {
  operationId: string;
  knowledgeBaseRoot: string;
  operationDirectory: string;
}): { stagingRoot: string; rollbackRoot: string } {
  const base = path.join(options.operationDirectory, options.operationId);
  const stagingRoot = path.join(base, 'staging');
  const rollbackRoot = path.join(base, 'rollback');
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(rollbackRoot, { recursive: true, mode: 0o700 });
  // Refuse if operation directory sits inside the knowledge base.
  const root = path.resolve(options.knowledgeBaseRoot);
  const op = path.resolve(options.operationDirectory);
  const rel = path.relative(root, op);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('operationDirectory 不能位于知识库根内');
  }
  return { stagingRoot, rollbackRoot };
}

/**
 * Write a new file into the staging tree and register it on the plan.
 */
export function stageFileContent(
  plan: AtomicCommitPlan,
  relativePath: string,
  content: string | Buffer,
): StagedFileEntry {
  const portable = relativePath.replace(/\\/g, '/');
  if (ScanPolicy.shouldSkipFile(path.basename(portable))) {
    throw new Error(`拒绝写入被策略排除的文件: ${portable}`);
  }
  const targetAbsolutePath = toAbsolute(plan.knowledgeBaseRoot, portable);
  assertInsideRoot(plan.knowledgeBaseRoot, targetAbsolutePath);

  const stagingAbsolutePath = toAbsolute(plan.stagingRoot, portable);
  fs.mkdirSync(path.dirname(stagingAbsolutePath), { recursive: true });
  fs.writeFileSync(stagingAbsolutePath, content);

  const exists = fs.existsSync(targetAbsolutePath) && fs.statSync(targetAbsolutePath).isFile();
  const entry: StagedFileEntry = {
    relativePath: portable,
    action: exists ? 'replace' : 'create',
    stagingAbsolutePath,
    targetAbsolutePath,
    previousSha256: exists ? sha256File(targetAbsolutePath) : null,
    newSha256: sha256File(stagingAbsolutePath),
  };
  plan.files.push(entry);
  return entry;
}

/**
 * Stage a binary file by copying from an absolute source into staging.
 */
export function stageFileFromPath(
  plan: AtomicCommitPlan,
  relativePath: string,
  sourceAbsolutePath: string,
): StagedFileEntry {
  const content = fs.readFileSync(sourceAbsolutePath);
  return stageFileContent(plan, relativePath, content);
}

export function stageDelete(
  plan: AtomicCommitPlan,
  relativePath: string,
): StagedFileEntry {
  const portable = relativePath.replace(/\\/g, '/');
  const targetAbsolutePath = toAbsolute(plan.knowledgeBaseRoot, portable);
  assertInsideRoot(plan.knowledgeBaseRoot, targetAbsolutePath);
  const exists = fs.existsSync(targetAbsolutePath);
  const entry: StagedFileEntry = {
    relativePath: portable,
    action: 'delete',
    stagingAbsolutePath: null,
    targetAbsolutePath,
    previousSha256: exists ? sha256File(targetAbsolutePath) : null,
    newSha256: null,
  };
  plan.files.push(entry);
  return entry;
}

/**
 * Commit all staged files. On any failure, restore prior content for every
 * file already committed in this call and return ok=false.
 */
export function commitAtomicPlan(plan: AtomicCommitPlan): AtomicCommitResult {
  const committed: string[] = [];
  const restored: string[] = [];

  try {
    for (const file of plan.files) {
      assertInsideRoot(plan.knowledgeBaseRoot, file.targetAbsolutePath);

      if (file.action === 'delete') {
        if (fs.existsSync(file.targetAbsolutePath)) {
          const rollbackPath = toAbsolute(plan.rollbackRoot, file.relativePath);
          fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
          fs.copyFileSync(file.targetAbsolutePath, rollbackPath);
          fs.unlinkSync(file.targetAbsolutePath);
        }
        committed.push(file.relativePath);
        continue;
      }

      if (!file.stagingAbsolutePath || !fs.existsSync(file.stagingAbsolutePath)) {
        throw new Error(`staging 文件缺失: ${file.relativePath}`);
      }

      // Snapshot previous target for rollback.
      if (fs.existsSync(file.targetAbsolutePath)) {
        const rollbackPath = toAbsolute(plan.rollbackRoot, file.relativePath);
        fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
        fs.copyFileSync(file.targetAbsolutePath, rollbackPath);
      }

      fs.mkdirSync(path.dirname(file.targetAbsolutePath), { recursive: true });
      // Copy then replace: rename across devices is not guaranteed for staging
      // outside the KB, so use copyFile + rename from a same-dir temp.
      const tempTarget = path.join(
        path.dirname(file.targetAbsolutePath),
        `.${path.basename(file.targetAbsolutePath)}.${process.pid}.tmp`,
      );
      fs.copyFileSync(file.stagingAbsolutePath, tempTarget);
      fs.renameSync(tempTarget, file.targetAbsolutePath);
      committed.push(file.relativePath);
    }

    return { ok: true, committed, restored };
  } catch (error) {
    // Restore already-committed files from rollback snapshots.
    for (const relative of committed.reverse()) {
      const entry = plan.files.find((file) => file.relativePath === relative);
      if (!entry) continue;
      const rollbackPath = toAbsolute(plan.rollbackRoot, relative);
      try {
        if (fs.existsSync(rollbackPath)) {
          fs.mkdirSync(path.dirname(entry.targetAbsolutePath), { recursive: true });
          fs.copyFileSync(rollbackPath, entry.targetAbsolutePath);
          restored.push(relative);
        } else if (entry.action === 'create' && fs.existsSync(entry.targetAbsolutePath)) {
          fs.unlinkSync(entry.targetAbsolutePath);
          restored.push(relative);
        }
      } catch {
        // Keep attempting remaining restores.
      }
    }
    return {
      ok: false,
      committed,
      restored,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Restore every file listed in the plan from the rollback tree (explicit
 * post-success undo / RESTORE drill).
 */
export function rollbackAtomicPlan(plan: AtomicCommitPlan): AtomicCommitResult {
  const restored: string[] = [];
  try {
    for (const file of plan.files) {
      const rollbackPath = toAbsolute(plan.rollbackRoot, file.relativePath);
      if (fs.existsSync(rollbackPath)) {
        fs.mkdirSync(path.dirname(file.targetAbsolutePath), { recursive: true });
        fs.copyFileSync(rollbackPath, file.targetAbsolutePath);
        restored.push(file.relativePath);
      } else if (file.action === 'create' && fs.existsSync(file.targetAbsolutePath)) {
        fs.unlinkSync(file.targetAbsolutePath);
        restored.push(file.relativePath);
      }
    }
    return { ok: true, committed: [], restored };
  } catch (error) {
    return {
      ok: false,
      committed: [],
      restored,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function emptyCommitPlan(options: {
  operationId: string;
  knowledgeBaseRoot: string;
  stagingRoot: string;
  rollbackRoot: string;
}): AtomicCommitPlan {
  return {
    operationId: options.operationId,
    knowledgeBaseRoot: path.resolve(options.knowledgeBaseRoot),
    stagingRoot: path.resolve(options.stagingRoot),
    rollbackRoot: path.resolve(options.rollbackRoot),
    files: [],
  };
}
