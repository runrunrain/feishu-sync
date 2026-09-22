/** Route-level regression tests for structured watchedRoots updates. */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
      providers: [{
        id: 'example',
        name: 'Example provider',
        enabled: true,
        apiKey: 'provider-secret-must-not-leak',
        openAiCompatBaseUrl: 'https://example.test/openai',
        claudeCompatBaseUrl: 'https://example.test/anthropic',
        defaultModelId: 'default',
        models: [{
          id: 'default',
          name: 'Default',
          openAiModel: 'direct-model',
          claudeCliModel: 'cli-model',
          enabled: true,
        }],
      }],
      activeProviderId: 'example',
      activeModelId: 'default',
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
    expect(body.llm.providers[0].apiKey).toBe('***');
    expect(body.watchedRoots).toEqual([ROOT]);
  });

  it('reveals a provider key only through the explicit POST action', async () => {
    const config = makeConfig();
    const app = buildApp({ load: vi.fn(async () => config) });

    const response = await app.fetch(new Request('http://x/api/config/reveal-provider-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'example' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ apiKey: 'provider-secret-must-not-leak' });
  });

  it('does not reveal a missing provider key', async () => {
    const config = makeConfig();
    const app = buildApp({ load: vi.fn(async () => config) });

    const response = await app.fetch(new Request('http://x/api/config/reveal-provider-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'does-not-exist' }),
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'provider_not_found' });
  });

  it('delegates PUT validation and persistence to ConfigManager.updateConfig', async () => {
    const config = makeConfig();
    const updateConfig = vi.fn(async (partial: unknown) => ({ ...config, ...(partial as object) }));
    const app = buildApp({ load: vi.fn(async () => config), updateConfig });

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

// ---------------------------------------------------------------------------
// 知识库根目录缺省建议 / 采用（2026-10 首次配置引导）
// ---------------------------------------------------------------------------

describe('knowledge root suggestion endpoints', () => {
  it('GET /api/config/knowledge-root-suggestion returns the suggested root without touching disk', async () => {
    const app = buildApp(null);
    const response = await app.fetch(new Request('http://x/api/config/knowledge-root-suggestion'));
    expect(response.status).toBe(200);
    const body = await response.json();
    // 形状契约：非空字符串路径（具体值平台相关，纯函数单测覆盖）。
    expect(typeof body.root).toBe('string');
    expect(body.root.length).toBeGreaterThan(0);
  });

  it('POST adopt creates the directory and persists knowledgeBaseRoot', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-adopt-'));
    const target = path.join(tmpRoot, 'nested', '飞书知识库');
    const updateConfig = vi.fn(async (partial: any) => ({ ...makeConfig(), ...partial }));
    const app = buildApp({ updateConfig });

    try {
      const response = await app.fetch(
        new Request('http://x/api/config/knowledge-root-suggestion/adopt', {
          method: 'POST',
          body: JSON.stringify({ root: target }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ root: target });
      // 目录已实际创建（recursive）。
      expect(fs.existsSync(target)).toBe(true);
      // 配置已保存为采用路径。
      expect(updateConfig).toHaveBeenCalledWith({ knowledgeBaseRoot: target });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('POST adopt without body uses the platform suggestion', async () => {
    const updateConfig = vi.fn(async (partial: any) => ({ ...makeConfig(), ...partial }));
    const app = buildApp({ updateConfig });

    const response = await app.fetch(
      new Request('http://x/api/config/knowledge-root-suggestion/adopt', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.root).toBe('string');
    expect(updateConfig).toHaveBeenCalledWith({ knowledgeBaseRoot: body.root });
  });

  it('POST adopt surfaces mkdir failure instead of swallowing it', async () => {
    // 用一个「文件占位路径」制造 ENOTDIR：target 的父级是普通文件。
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-adopt-fail-'));
    const blocker = path.join(tmpRoot, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf-8');
    const app = buildApp({ updateConfig: vi.fn() });

    try {
      const response = await app.fetch(
        new Request('http://x/api/config/knowledge-root-suggestion/adopt', {
          method: 'POST',
          body: JSON.stringify({ root: path.join(blocker, 'sub', 'kb') }),
        }),
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('knowledge_root_create_failed');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
