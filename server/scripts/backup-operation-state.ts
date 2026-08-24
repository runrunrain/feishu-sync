#!/usr/bin/env tsx
/**
 * Create an external backup for an operation's SQLite, config and manifest.
 *
 * Example:
 *   npm run backup:state -- \
 *     --database ~/.feishu-sync/feishu-sync.db \
 *     --config ~/.feishu-sync/config.json \
 *     --manifest ~/.feishu-sync/operations/op-xxx.json
 */

import {
  createOperationBackup,
  resolveRecoveryDirectory,
  type BackupSource,
} from '../src/modules/recovery-manager.js';

interface Arguments {
  database?: string;
  config?: string;
  manifest?: string;
  recoveryDir?: string;
  operationId?: string;
}

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} 需要一个路径`);
      index += 1;
      return value;
    };
    if (argument === '--database') parsed.database = next();
    else if (argument === '--config') parsed.config = next();
    else if (argument === '--manifest') parsed.manifest = next();
    else if (argument === '--recovery-dir') parsed.recoveryDir = next();
    else if (argument === '--operation-id') parsed.operationId = next();
    else if (argument === '--help' || argument === '-h') {
      console.info('Usage: backup-operation-state [--database <db>] [--config <config>] [--manifest <operation-manifest>] [--recovery-dir <outside-root>] [--operation-id <id>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return parsed;
}

try {
  const args = parseArguments(process.argv.slice(2));
  const sources: BackupSource[] = [];
  if (args.database) sources.push({ id: 'database', kind: 'sqlite', sourcePath: args.database });
  if (args.config) sources.push({ id: 'config', kind: 'file', sourcePath: args.config });
  if (args.manifest) sources.push({ id: 'operation-manifest', kind: 'file', sourcePath: args.manifest });

  const backup = await createOperationBackup({
    sources,
    recoveryDirectory: resolveRecoveryDirectory(args.recoveryDir),
    operationId: args.operationId,
  });
  console.info(JSON.stringify({
    operationId: backup.operationId,
    backupDirectory: backup.backupDirectory,
    entries: backup.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      size: entry.size,
      sha256: entry.sha256,
    })),
  }, null, 2));
} catch (error) {
  console.error(`[backup-operation-state] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
