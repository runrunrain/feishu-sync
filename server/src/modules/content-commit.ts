/**
 * ContentCommitCoordinator (P3) — stage DocumentIR outputs and commit
 * atomically, then advance the SQLite synced baseline.
 *
 * Separates pure planning/rendering from I/O so fault-injection tests can
 * exercise the shipped commit path without the full Feishu fetch stack.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  commitAtomicPlan,
  createAtomicCommitWorkspace,
  emptyCommitPlan,
  rollbackAtomicPlan,
  stageFileContent,
  type AtomicCommitPlan,
} from './atomic-commit.js';
import {
  renderDocumentMarkdown,
  type DocumentIR,
} from './document-ir.js';
import { toPortableRelative } from './path-resolver.js';

export interface ContentCommitInput {
  operationId: string;
  knowledgeBaseRoot: string;
  operationDirectory: string;
  /** Absolute final markdown path. */
  localMdPath: string;
  ir: DocumentIR;
  /** Additional binary/text files relative to knowledge root → absolute source. */
  extraFiles?: Array<{ relativePath: string; absoluteSource: string }>;
  /** Injected for tests: fail after staging but before commit. */
  failBeforeCommit?: boolean;
  /** Injected for tests: fail after file commit but before DB callback. */
  failAfterFileCommit?: boolean;
}

export interface ContentCommitResult {
  ok: boolean;
  operationId: string;
  plan: AtomicCommitPlan;
  relativeMdPath: string;
  error?: string;
  rolledBack?: boolean;
}

/**
 * Stage rendered markdown + required resources, validate, atomic commit.
 * Does NOT touch SQLite — callers must markDocumentSynced only on ok=true.
 */
export function commitDocumentContent(
  input: ContentCommitInput,
): ContentCommitResult {
  const root = path.resolve(input.knowledgeBaseRoot);
  const relativeMd =
    toPortableRelative(root, input.localMdPath) ||
    path.basename(input.localMdPath);

  const { stagingRoot, rollbackRoot } = createAtomicCommitWorkspace({
    operationId: `${input.operationId}-${input.ir.objToken.slice(0, 12)}`,
    knowledgeBaseRoot: root,
    operationDirectory: input.operationDirectory,
  });

  const plan = emptyCommitPlan({
    operationId: input.operationId,
    knowledgeBaseRoot: root,
    stagingRoot,
    rollbackRoot,
  });

  try {
    const rendered = renderDocumentMarkdown(input.ir);
    stageFileContent(plan, relativeMd, rendered.markdown);

    const mdDirRel = relativeMd.includes('/')
      ? relativeMd.slice(0, relativeMd.lastIndexOf('/'))
      : '';

    // Stage sheet CSV / resources from IR contents.
    for (const sheet of input.ir.sheets) {
      if (!sheet.csvContent || !sheet.csvContent.trim()) {
        throw new Error(`子表 CSV 为空: ${sheet.title}`);
      }
      const rel = mdDirRel
        ? `${mdDirRel}/${sheet.csvRelativePath}`
        : sheet.csvRelativePath;
      stageFileContent(plan, rel, sheet.csvContent);
    }

    for (const extra of input.extraFiles ?? []) {
      if (!fs.existsSync(extra.absoluteSource)) {
        throw new Error(`附加资源不存在: ${extra.absoluteSource}`);
      }
      stageFileContent(plan, extra.relativePath, fs.readFileSync(extra.absoluteSource));
    }

    // Validate required paths exist in staging
    for (const rel of rendered.requiredRelativePaths) {
      const fullRel = mdDirRel ? `${mdDirRel}/${rel}` : rel;
      const staged = path.join(stagingRoot, ...fullRel.split('/'));
      if (!fs.existsSync(staged) || fs.statSync(staged).size <= 0) {
        throw new Error(`资源完整性校验失败: ${fullRel}`);
      }
    }

    if (input.failBeforeCommit) {
      throw new Error('注入失败：commit 前中止');
    }

    const commit = commitAtomicPlan(plan);
    if (!commit.ok) {
      return {
        ok: false,
        operationId: input.operationId,
        plan,
        relativeMdPath: relativeMd,
        error: commit.error,
        rolledBack: true,
      };
    }

    if (input.failAfterFileCommit) {
      // Simulate DB failure: restore files so synced baseline stays aligned.
      rollbackAtomicPlan(plan);
      return {
        ok: false,
        operationId: input.operationId,
        plan,
        relativeMdPath: relativeMd,
        error: '注入失败：文件提交后数据库事务失败，已回滚文件',
        rolledBack: true,
      };
    }

    return {
      ok: true,
      operationId: input.operationId,
      plan,
      relativeMdPath: relativeMd,
    };
  } catch (error) {
    return {
      ok: false,
      operationId: input.operationId,
      plan,
      relativeMdPath: relativeMd,
      error: error instanceof Error ? error.message : String(error),
      rolledBack: false,
    };
  }
}
