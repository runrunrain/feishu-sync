/** Route-level regression tests for structured watchedRoots updates. */

import { describe, expect, it, vi } from 'vitest';

const { Hono } = require('hono');
import { configRoutes } from '../src/routes/config.js';

const ROOT = {
  id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
  url: 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb',
  localDir: '策划 - Designer',
  layoutProfile: 'mirror-title-file' as const,
  enabled: true,
};

function makeConfig() {
  return {
    llm: {
      openAiCompatBaseUrl: 'https://example.test/openai',
      claudeCompatBaseUrl: 'https://example.test/anthropic',
      apiKey: 'secret-key-must-not-leak',
      model: 'model',
      directModel: 'direct-model',
      claudeCliModel: 'cli-model',
      temperature: 0.2,
      timeoutMs: 10_000,
      claudeCli: { extraArgs: [] },
      primaryChannel: 'claude-cli' as const,
      fallbackOnFailure: true,
    },
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: '/tmp/kb',
    watchedRoots: [ROOT],
    watchedRootUrls: [ROOT.url],
    requiredScopes: [],
    enableAutoStart: true,
    enableNotifications: true,
  };
}

function buildApp(configManager: any) {
  const app = new Hono();
  app.use('*', async (context: any, next: any) => {
    context.configManager = configManager;
    await next();
  });
  app.route('/', configRoutes);
  return app;
}

describe('config routes', () => {
  it('redacts LLM api keys while exposing structured roots', async () => {
    const config = makeConfig();
    const app = buildApp({ load: vi.fn(async () => config) });

    const response = await app.fetch(new Request('http://x/api/config'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.llm.apiKey).toBe('***');
    expect(body.watchedRoots).toEqual([ROOT]);
  });

  it('delegates PUT validation and persistence to ConfigManager.updateConfig', async () => {
    const config = makeConfig();
    const updateConfig = vi.fn(async (partial: unknown) => ({ ...config, ...(partial as object) }));
    const app = buildApp({ updateConfig });

    const response = await app.fetch(new Request('http://x/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchedRoots: [{ ...ROOT, enabled: false }] }),
    }));

    expect(response.status).toBe(200);
    expect(updateConfig).toHaveBeenCalledWith({ watchedRoots: [{ ...ROOT, enabled: false }] });
    expect((await response.json()).config.llm.apiKey).toBe('***');
  });

  it('returns 400 when ConfigManager rejects a root contract violation', async () => {
    const app = buildApp({
      updateConfig: vi.fn(async () => {
        throw new Error('watchedRoot.localDir 必须是非空、不可越界的根相对 POSIX 路径');
      }),
    });

    const response = await app.fetch(new Request('http://x/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchedRoots: [{ ...ROOT, localDir: '../escape' }] }),
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('config_validation_failed');
  });

  it('returns 400 for malformed JSON before configuration updates run', async () => {
    const updateConfig = vi.fn();
    const app = buildApp({ updateConfig });

    const response = await app.fetch(new Request('http://x/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_json');
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
