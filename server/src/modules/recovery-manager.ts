/**
 * External operation backup and explicit restore primitives.
 *
 * Backups are kept outside the knowledge base and SQLite snapshots use the
 * online backup API instead of copying a potentially live WAL database file.
 * Restore remains deliberately opt-in and is not wired to the UI.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export type BackupSourceKind = 'file' | 'sqlite';

export interface BackupSource {
  id: string;
  kind: BackupSourceKind;
  sourcePath: string;
}

export interface OperationBackupManifest {
  schemaVersion: 1;
  operationId: string;
  createdAt: string;
  backupDirectory: string;
  entries: Array<{
    id: string;
    kind: BackupSourceKind;
    sourcePath: string;
    backupRelativePath: string;
    size: number;
    sha256: string;
  }>;
}

export interface CreateOperationBackupOptions {
  sources: BackupSource[];
  recoveryDirectory?: string;
  operationId?: string;
}

/** Resolve the external recovery location used by all operation backups. */
export function resolveRecoveryDirectory(configuredDirectory?: string): string {
  return path.resolve(
    configuredDirectory || path.join(os.homedir(), '.feishu-sync', 'recovery'),
  );
}

/**
 * Create recoverable copies of configuration, operation manifests and SQLite
 * state. The returned manifest is itself written into the backup directory.
 */
export async function createOperationBackup(
  options: CreateOperationBackupOptions,
): Promise<OperationBackupManifest> {
  validateSources(options.sources);

  const recoveryDirectory = resolveRecoveryDirectory(options.recoveryDirectory);
  const operationId = options.operationId || createOperationId();
  const backupDirectory = path.join(recoveryDirectory, operationId);
  fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backupDirectory, { recursive: false, mode: 0o700 });

  try {
    const entries: OperationBackupManifest['entries'] = [];
    for (const source of options.sources) {
      const sourcePath = path.resolve(source.sourcePath);
      const extension = path.extname(sourcePath) || (source.kind === 'sqlite' ? '.db' : '');
      const backupRelativePath = `${source.id}${extension}`;
      const backupPath = path.join(backupDirectory, backupRelativePath);

      if (source.kind === 'sqlite') {
        await backupSqlite(sourcePath, backupPath);
      } else {
        fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
      }
      fs.chmodSync(backupPath, 0o600);
      const stat = fs.statSync(backupPath);
      entries.push({
        id: source.id,
        kind: source.kind,
        sourcePath,
        backupRelativePath,
        size: stat.size,
        sha256: sha256File(backupPath),
      });
    }

    const manifest: OperationBackupManifest = {
      schemaVersion: 1,
      operationId,
      createdAt: new Date().toISOString(),
      backupDirectory,
      entries,
    };
    writeJsonAtomically(path.join(backupDirectory, 'manifest.json'), manifest);
    return manifest;
  } catch (error) {
    fs.rmSync(backupDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Read and minimally validate an operation backup manifest. */
export function readOperationBackupManifest(manifestPath: string): OperationBackupManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (!isOperationBackupManifest(parsed)) {
    throw new Error('无效的 operation backup manifest');
  }
  return parsed;
}

/**
 * Restore selected backup entries using an explicit destination map.
 *
 * The caller must stop any process that has an open SQLite connection first.
 * A literal `RESTORE` acknowledgement prevents accidental use from generic
 * automation. Each file is atomically replaced after its backup hash is
 * verified; cross-file transactional recovery remains P3 work.
 */
export function restoreOperationBackup(
  manifest: OperationBackupManifest,
  destinations: Record<string, string>,
  confirmation: string,
): Array<{ id: string; destinationPath: string; sha256: string }> {
  if (confirmation !== 'RESTORE') {
    throw new Error('恢复需要 confirmation="RESTORE"');
  }

  const restored: Array<{ id: string; destinationPath: string; sha256: string }> = [];
  const backupDirectory = path.resolve(manifest.backupDirectory);
  for (const entry of manifest.entries) {
    const requestedDestination = destinations[entry.id];
    if (!requestedDestination) {
      throw new Error(`缺少 ${entry.id} 的恢复目标`);
    }

    const backupPath = path.resolve(backupDirectory, entry.backupRelativePath);
    const destinationPath = path.resolve(requestedDestination);
    if (!isPathInside(backupDirectory, backupPath)) {
      throw new Error(`备份条目路径越界：${entry.id}`);
    }
    if (destinationPath === backupDirectory || isPathInside(backupDirectory, destinationPath)) {
      throw new Error(`恢复目标不能位于备份目录内：${entry.id}`);
    }
    if (!fs.existsSync(backupPath) || sha256File(backupPath) !== entry.sha256) {
      throw new Error(`备份校验失败：${entry.id}`);
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      path.dirname(destinationPath),
      `.${path.basename(destinationPath)}.${process.pid}.${crypto.randomUUID()}.restore`,
    );
    fs.copyFileSync(backupPath, temporaryPath);
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, destinationPath);

    const restoredHash = sha256File(destinationPath);
    if (restoredHash !== entry.sha256) {
      throw new Error(`恢复后校验失败：${entry.id}`);
    }
    restored.push({ id: entry.id, destinationPath, sha256: restoredHash });
  }

  return restored;
}

async function backupSqlite(sourcePath: string, destinationPath: string): Promise<void> {
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destinationPath);
  } finally {
    database.close();
  }
}

function validateSources(sources: BackupSource[]): void {
  if (sources.length === 0) {
    throw new Error('至少需要一个备份源');
  }
  const ids = new Set<string>();
  for (const source of sources) {
    if (!/^[A-Za-z0-9_-]+$/.test(source.id)) {
      throw new Error(`备份源 id 非法：${source.id}`);
    }
    if (ids.has(source.id)) {
      throw new Error(`备份源 id 重复：${source.id}`);
    }
    ids.add(source.id);
    if (!fs.existsSync(source.sourcePath) || !fs.statSync(source.sourcePath).isFile()) {
      throw new Error(`备份源不可读取：${source.sourcePath}`);
    }
  }
}

function createOperationId(): string {
  return `backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function writeJsonAtomically(filePath: string, value: OperationBackupManifest): void {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
}

function isOperationBackupManifest(value: unknown): value is OperationBackupManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OperationBackupManifest>;
  return candidate.schemaVersion === 1
    && typeof candidate.operationId === 'string'
    && typeof candidate.backupDirectory === 'string'
    && Array.isArray(candidate.entries);
}
