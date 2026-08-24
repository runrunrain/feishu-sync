import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  createOperationBackup,
  readOperationBackupManifest,
  restoreOperationBackup,
} from '../src/modules/recovery-manager.js';

const temporaryDirectories: string[] = [];

function createTempDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('operation recovery backup', () => {
  it('backs up config, manifest and a SQLite snapshot, then restores byte-verified artifacts', async () => {
    const root = createTempDirectory('feishu-sync-recovery-');
    const configPath = path.join(root, 'state', 'config.json');
    const operationManifestPath = path.join(root, 'state', 'operation.json');
    const databasePath = path.join(root, 'state', 'feishu-sync.db');
    const recoveryDirectory = path.join(root, 'recovery');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"safe":true}\n', 'utf-8');
    fs.writeFileSync(operationManifestPath, '{"operation":"dry-run"}\n', 'utf-8');

    const sourceDatabase = new Database(databasePath);
    sourceDatabase.exec('CREATE TABLE snapshots (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO snapshots(value) VALUES (\'before\');');
    sourceDatabase.close();

    const backup = await createOperationBackup({
      recoveryDirectory,
      operationId: 'p0-recovery-drill',
      sources: [
        { id: 'config', kind: 'file', sourcePath: configPath },
        { id: 'operation-manifest', kind: 'file', sourcePath: operationManifestPath },
        { id: 'database', kind: 'sqlite', sourcePath: databasePath },
      ],
    });

    expect(backup.entries).toHaveLength(3);
    expect(fs.existsSync(path.join(backup.backupDirectory, 'manifest.json'))).toBe(true);
    expect(readOperationBackupManifest(path.join(backup.backupDirectory, 'manifest.json'))).toMatchObject({
      operationId: 'p0-recovery-drill',
    });

    fs.writeFileSync(configPath, '{"safe":false}\n', 'utf-8');
    fs.writeFileSync(operationManifestPath, '{"operation":"changed"}\n', 'utf-8');
    const changedDatabase = new Database(databasePath);
    changedDatabase.exec("DELETE FROM snapshots; INSERT INTO snapshots(value) VALUES ('after');");
    changedDatabase.close();

    expect(() => restoreOperationBackup(backup, {
      config: configPath,
      'operation-manifest': operationManifestPath,
      database: databasePath,
    }, 'NOPE')).toThrow('恢复需要 confirmation="RESTORE"');

    const restored = restoreOperationBackup(backup, {
      config: configPath,
      'operation-manifest': operationManifestPath,
      database: databasePath,
    }, 'RESTORE');
    expect(restored).toHaveLength(3);

    for (const entry of backup.entries) {
      const destination = entry.id === 'config'
        ? configPath
        : entry.id === 'operation-manifest'
          ? operationManifestPath
          : databasePath;
      expect(sha256(destination)).toBe(entry.sha256);
    }

    const restoredDatabase = new Database(databasePath, { readonly: true });
    expect(restoredDatabase.prepare('SELECT value FROM snapshots').all()).toEqual([{ value: 'before' }]);
    restoredDatabase.close();
  });
});
