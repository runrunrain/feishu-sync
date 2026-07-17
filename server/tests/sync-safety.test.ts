import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine } from '../src/modules/sync-engine.js';
import {
  createKnowledgeBaseAudit,
  fallbackMarkdownTarget,
  resolveOperationDirectory,
  resolveSyncMode,
  writeKnowledgeBaseAudit,
} from '../src/modules/operation-manifest.js';
import type { ChangedDocument } from '../src/types/index.js';

const temporaryDirectories: string[] = [];

function makeTempDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeDocument(overrides: Partial<ChangedDocument> = {}): ChangedDocument {
  return {
    objToken: 'doc-token-1',
    objType: 'docx',
    title: '安全核验文档',
    changeType: 'added',
    cloudModifiedTime: '2026-07-17T00:00:00.000Z',
    localSyncedTime: null,
    localMdPath: null,
    ...overrides,
  };
}

function makeEngine(knowledgeBaseRoot: string, operationManifestDir: string) {
  const calls = { logSync: 0 };
  const engine = new SyncEngine({
    config: { knowledgeBaseRoot, operationManifestDir },
    larkCliClient: {
      execute: () => {
        throw new Error('dry-run must not invoke lark-cli');
      },
    },
    localMapStore: {
      logSync: () => {
        calls.logSync += 1;
      },
    },
  } as any);
  return { engine, calls };
}

describe('P0 sync write safety', () => {
  it('defaults to dry-run, writes an external manifest, and leaves the knowledge base untouched', async () => {
    const temporaryRoot = makeTempDirectory('feishu-sync-safety-');
    const knowledgeBaseRoot = path.join(temporaryRoot, 'knowledge-base');
    const operationDirectory = path.join(temporaryRoot, 'operations');
    const { engine, calls } = makeEngine(knowledgeBaseRoot, operationDirectory);

    const result = await engine.syncDocuments([makeDocument()], {
      enableLLM: false,
      fullSync: false,
    });

    expect(result.mode).toBe('dry-run');
    expect(result.success).toBe(true);
    expect(result.syncedDocuments).toEqual([]);
    expect(calls.logSync).toBe(0);
    expect(result.manifestPath).toBeDefined();
    expect(result.manifestPath?.startsWith(`${operationDirectory}${path.sep}`)).toBe(true);
    expect(fs.existsSync(result.manifestPath!)).toBe(true);
    expect(fs.existsSync(fallbackMarkdownTarget(knowledgeBaseRoot, '安全核验文档'))).toBe(false);

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath!, 'utf-8'));
    expect(manifest.mode).toBe('dry-run');
    expect(manifest.summary).toMatchObject({ create: 1, blocked: 0, succeeded: 0, failed: 0 });
    expect(manifest.documents[0]).toMatchObject({
      objToken: 'doc-token-1',
      action: 'create',
      previousSha256: null,
    });
  });

  it('does not enable apply when the acknowledgement is absent or wrong', async () => {
    expect(resolveSyncMode({ apply: true })).toBe('dry-run');
    expect(resolveSyncMode({ apply: true, confirmation: 'confirm' })).toBe('dry-run');
    expect(resolveSyncMode({ apply: true, confirmation: 'APPLY' })).toBe('apply');

    const temporaryRoot = makeTempDirectory('feishu-sync-apply-closed-');
    const { engine } = makeEngine(
      path.join(temporaryRoot, 'knowledge-base'),
      path.join(temporaryRoot, 'operations'),
    );
    await expect(engine.syncDocuments([makeDocument()], {
      enableLLM: false,
      fullSync: false,
      apply: true,
      confirmation: 'APPLY',
    })).rejects.toThrow('正式写入尚未启用');
  });

  it('records unsafe local paths as blocked rather than falling back to a new target', async () => {
    const temporaryRoot = makeTempDirectory('feishu-sync-unsafe-path-');
    const knowledgeBaseRoot = path.join(temporaryRoot, 'knowledge-base');
    const operationDirectory = path.join(temporaryRoot, 'operations');
    const outsidePath = path.join(temporaryRoot, 'outside.md');
    const { engine, calls } = makeEngine(knowledgeBaseRoot, operationDirectory);

    const result = await engine.syncDocuments([
      makeDocument({ localMdPath: outsidePath, changeType: 'modified' }),
    ], {
      enableLLM: false,
      fullSync: false,
    });

    expect(result.mode).toBe('dry-run');
    expect(result.success).toBe(false);
    expect(result.failedDocuments[0]?.retryable).toBe(false);
    expect(result.plannedDocuments?.[0]).toMatchObject({
      action: 'blocked',
      localMdPath: null,
    });
    expect(fs.existsSync(outsidePath)).toBe(false);
    expect(calls.logSync).toBe(0);
  });

  it('blocks every document that collides with another planned target', async () => {
    const temporaryRoot = makeTempDirectory('feishu-sync-path-conflict-');
    const knowledgeBaseRoot = path.join(temporaryRoot, 'knowledge-base');
    const operationDirectory = path.join(temporaryRoot, 'operations');
    const { engine } = makeEngine(knowledgeBaseRoot, operationDirectory);

    const result = await engine.syncDocuments([
      makeDocument({ objToken: 'doc-a', title: '同名文档' }),
      makeDocument({ objToken: 'doc-b', title: '同名文档' }),
    ], {
      enableLLM: false,
      fullSync: false,
    });

    expect(result.success).toBe(false);
    expect(result.plannedDocuments).toEqual([
      expect.objectContaining({ objToken: 'doc-a', action: 'blocked', localMdPath: null }),
      expect.objectContaining({ objToken: 'doc-b', action: 'blocked', localMdPath: null }),
    ]);
    expect(result.failedDocuments).toHaveLength(2);
  });

  it('refuses to store operation artefacts inside the knowledge base', () => {
    const temporaryRoot = makeTempDirectory('feishu-sync-operation-dir-');
    const knowledgeBaseRoot = path.join(temporaryRoot, 'knowledge-base');
    expect(() => resolveOperationDirectory(knowledgeBaseRoot, path.join(knowledgeBaseRoot, 'operations')))
      .toThrow('operation manifest 目录不能位于知识库根目录内');
  });

  it('builds a deterministic read-only corpus baseline and excludes operational artefacts', () => {
    const temporaryRoot = makeTempDirectory('feishu-sync-audit-');
    const knowledgeBaseRoot = path.join(temporaryRoot, 'knowledge-base');
    const operationDirectory = path.join(temporaryRoot, 'operations');
    fs.mkdirSync(path.join(knowledgeBaseRoot, '.staging'), { recursive: true });
    fs.writeFileSync(path.join(knowledgeBaseRoot, 'README.md'), '# 正文\n', 'utf-8');
    fs.writeFileSync(path.join(knowledgeBaseRoot, 'README.md.bak'), 'backup', 'utf-8');
    fs.writeFileSync(path.join(knowledgeBaseRoot, 'README.md.pre-migrate'), 'archive', 'utf-8');
    fs.writeFileSync(path.join(knowledgeBaseRoot, '.staging', 'pending.md'), 'pending', 'utf-8');

    const audit = createKnowledgeBaseAudit(knowledgeBaseRoot);
    const reportPath = writeKnowledgeBaseAudit(
      audit,
      resolveOperationDirectory(knowledgeBaseRoot, operationDirectory),
    );

    expect(audit.files).toEqual([
      expect.objectContaining({ relativePath: 'README.md', size: Buffer.byteLength('# 正文\n') }),
    ]);
    expect(audit.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.skippedPaths).toEqual(expect.arrayContaining([
      '.staging/',
      'README.md.bak',
      'README.md.pre-migrate',
    ]));
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(path.join(knowledgeBaseRoot, '_index.json'))).toBe(false);
  });
});
