import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { Hono } = require('hono');
import { syncRoutes } from '../src/routes/sync.js';

const temporaryDirectories: string[] = [];

function createTempDirectory(prefix: string): string {
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

function buildApp(deps: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (context: any, next: () => Promise<void>) => {
    Object.assign(context, deps);
    await next();
  });
  app.route('/', syncRoutes);
  return app;
}

function makeConfig(knowledgeBaseRoot: string, operationManifestDir: string) {
  return {
    knowledgeBaseRoot,
    operationManifestDir,
    watchedRootUrls: [],
    llm: {
      openAiCompatBaseUrl: '',
      claudeCompatBaseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.2,
      primaryChannel: 'direct' as const,
      fallbackOnFailure: false,
    },
  };
}

const document = {
  objToken: 'route-document-token',
  objType: 'docx',
  title: '路由安全测试',
  changeType: 'added',
  cloudModifiedTime: '2026-07-17T00:00:00.000Z',
  localSyncedTime: null,
  localMdPath: null,
};

describe('POST /api/sync P0 safety gate', () => {
  it('treats apply:false as dry-run and does not refresh the knowledge-base snapshot', async () => {
    const temporaryRoot = createTempDirectory('feishu-sync-route-safety-');
    const knowledgeBaseRoot = path.join(temporaryRoot, 'knowledge-base');
    const operationManifestDir = path.join(temporaryRoot, 'operations');
    let snapshotReads = 0;
    const app = buildApp({
      configManager: { load: async () => makeConfig(knowledgeBaseRoot, operationManifestDir) },
      larkCliClient: {},
      localMapStore: {
        getAllDocuments: () => {
          snapshotReads += 1;
          return [];
        },
      },
    });

    const response = await app.fetch(new Request('http://x/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documents: [document],
        options: { enableLLM: false, fullSync: false, apply: false },
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mode).toBe('dry-run');
    expect(body.manifestPath).toContain(operationManifestDir);
    expect(fs.existsSync(body.manifestPath)).toBe(true);
    expect(snapshotReads).toBe(0);
    expect(fs.existsSync(knowledgeBaseRoot)).toBe(false);
  });

  it('rejects apply without the explicit acknowledgement before creating an operation', async () => {
    const temporaryRoot = createTempDirectory('feishu-sync-route-confirm-');
    const knowledgeBaseRoot = path.join(temporaryRoot, 'knowledge-base');
    const operationManifestDir = path.join(temporaryRoot, 'operations');
    const app = buildApp({
      configManager: { load: async () => makeConfig(knowledgeBaseRoot, operationManifestDir) },
      larkCliClient: {},
      localMapStore: {},
    });

    const response = await app.fetch(new Request('http://x/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: [document], options: { apply: true } }),
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('apply_confirmation_required');
    expect(fs.existsSync(operationManifestDir)).toBe(false);
  });

  it('keeps apply closed even when the acknowledgement is supplied', async () => {
    const temporaryRoot = createTempDirectory('feishu-sync-route-apply-closed-');
    const knowledgeBaseRoot = path.join(temporaryRoot, 'knowledge-base');
    const operationManifestDir = path.join(temporaryRoot, 'operations');
    const app = buildApp({
      configManager: { load: async () => makeConfig(knowledgeBaseRoot, operationManifestDir) },
      larkCliClient: {},
      localMapStore: {},
    });

    const response = await app.fetch(new Request('http://x/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documents: [document],
        options: { apply: true, confirmation: 'APPLY' },
      }),
    }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('apply_not_available');
    expect(fs.existsSync(operationManifestDir)).toBe(false);
  });
});
