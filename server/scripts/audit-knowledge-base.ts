#!/usr/bin/env tsx
/**
 * Produce a read-only hash baseline for a local knowledge base.
 *
 * Usage:
 *   npm run audit:corpus -- --root /path/to/copied-fixture
 *   npm run audit:corpus -- --root /path/to/knowledge-base --report-dir /safe/operations
 */

import {
  createKnowledgeBaseAudit,
  resolveOperationDirectory,
  writeKnowledgeBaseAudit,
} from '../src/modules/operation-manifest.js';

interface Arguments {
  root?: string;
  reportDir?: string;
}

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      parsed.root = argv[index + 1];
      index += 1;
    } else if (argument.startsWith('--root=')) {
      parsed.root = argument.slice('--root='.length);
    } else if (argument === '--report-dir') {
      parsed.reportDir = argv[index + 1];
      index += 1;
    } else if (argument.startsWith('--report-dir=')) {
      parsed.reportDir = argument.slice('--report-dir='.length);
    } else if (argument === '--help' || argument === '-h') {
      console.info('Usage: audit-knowledge-base --root <knowledge-base> [--report-dir <outside-root-directory>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return parsed;
}

try {
  const args = parseArguments(process.argv.slice(2));
  if (!args.root) {
    throw new Error('缺少 --root <knowledge-base>');
  }

  const audit = createKnowledgeBaseAudit(args.root);
  const reportDirectory = resolveOperationDirectory(args.root, args.reportDir);
  const reportPath = writeKnowledgeBaseAudit(audit, reportDirectory);
  console.info(JSON.stringify({
    auditId: audit.auditId,
    reportPath,
    summary: audit.summary,
  }, null, 2));
} catch (error) {
  console.error(`[audit-knowledge-base] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
