/**
 * ConfigManager migration reconcile tests (v0.2.0 direct-channel 401 fix).
 *
 * Covers the root-cause fix for the 2026-06-19 e2e-sync report:
 * persisted configs that still carried the legacy deepseek
 * `openAiCompatBaseUrl` after the P3 migration (because P3 preserved
 * legacy.baseUrl verbatim) produced a 401 when DirectChannel sent a
 * bigmodel Bearer key to the deepseek host.
 *
 * Also covers P2 structured watched-root migration and validation. These
 * cases use an isolated temporary config file; no real user config is read.
 */

import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalizeWatchedRootUrl,
  ConfigManager,
  DEFAULT_REQUIRED_SCOPES,
  looksLikeBigmodelKey,
  normalizeWatchedRootConfig,
  normalizeWatchedRootLocalDir,
  reconcileOpenAiCompatBaseUrl,
  reconcileModelAlias,
} from '../src/modules/config-manager.js';

const BIGMODEL_KEY = '80ca91e556484dfb9126672d6fbaae8c.65LWXDL6NvRyb9RN';
const BIGMODEL_PAAS_V4 = 'https://open.bigmodel.cn/api/paas/v4';
const DEEPSEEK_URL = 'https://api.deepseek.com';
const ROOT_A = 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb';
const ROOT_B = 'https://qcnbafdrjx7n.feishu.cn/wiki/QdZpwOmgBi25JVkAUmYcBiMinIf';
const ROOT_C = 'https://qcnbafdrjx7n.feishu.cn/wiki/NudewPkE9inlGhkEDA1c9FSsnkb';
const ROOT_D = 'https://qcnbafdrjx7n.feishu.cn/wiki/FEaww3vUHieIumk6FdIc92WHnyh';
const tempConfigDirs: string[] = [];

function createTempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-config-'));
  tempConfigDirs.push(dir);
  return path.join(dir, 'config.json');
}

afterEach(() => {
  while (tempConfigDirs.length > 0) {
    const dir = tempConfigDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('config secret retain semantics (P4)', () => {
  it('retains apiKey when partial update sends masked ***', async () => {
    const configPath = createTempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      llm: {
        openAiCompatBaseUrl: BIGMODEL_PAAS_V4,
        claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: BIGMODEL_KEY,
        model: 'glm-4-flash',
        temperature: 0.2,
        primaryChannel: 'claude-cli',
        fallbackOnFailure: true,
        claudeCli: { extraArgs: [] },
      },
      pollIntervalMinutes: 30,
      knowledgeBaseRoot: '/tmp/kb',
      watchedRoots: [],
      requiredScopes: [],
      enableAutoStart: true,
      enableNotifications: true,
    }, null, 2));
    const mgr = new ConfigManager(configPath);
    await mgr.load();
    await mgr.updateConfig({
      llm: {
        model: 'glm-4-flash',
        apiKey: '***',
      } as any,
    });
    const reloaded = await mgr.load();
    expect(reloaded.llm.apiKey).toBe(BIGMODEL_KEY);
  });

  it('retains a masked provider API key while saving a preset edit', async () => {
    const configPath = createTempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      llm: {
        openAiCompatBaseUrl: BIGMODEL_PAAS_V4,
        claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: BIGMODEL_KEY,
        model: 'glm-5.2[1m]',
        directModel: 'glm-4-flash',
        claudeCliModel: 'glm-5.2[1m]',
        temperature: 0.2,
        primaryChannel: 'claude-cli',
        fallbackOnFailure: true,
        providers: [{
          id: 'glm',
          name: '智谱 GLM',
          enabled: true,
          apiKey: 'provider-secret-must-survive',
          openAiCompatBaseUrl: BIGMODEL_PAAS_V4,
          claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
          defaultModelId: 'default',
          models: [{
            id: 'default',
            name: 'GLM 默认',
            openAiModel: 'glm-4-flash',
            claudeCliModel: 'glm-5.2[1m]',
            enabled: true,
          }],
        }],
        activeProviderId: 'glm',
        activeModelId: 'default',
      },
      watchedRoots: [],
      requiredScopes: [],
    }, null, 2));

    const mgr = new ConfigManager(configPath);
    const loaded = await mgr.load();
    await mgr.updateConfig({
      llm: {
        ...loaded.llm,
        providers: loaded.llm.providers?.map((provider) => ({
          ...provider,
          apiKey: '***',
          models: provider.models.map((model) => ({
            ...model,
            name: 'GLM 默认（已编辑）',
          })),
        })),
      },
    });

    const reloaded = await mgr.load();
    expect(reloaded.llm.providers?.[0]?.apiKey).toBe('provider-secret-must-survive');
    expect(reloaded.llm.providers?.[0]?.models[0]?.name).toBe('GLM 默认（已编辑）');
    expect(reloaded.llm.model).toBe('glm-5.2');
    expect(reloaded.llm.providers?.[0]?.models[0]?.openAiModel).toBe('glm-4-flash');
    // v0.2.9：旧配置中的 claude 通道字段（primaryChannel 等）读取时归一。
    expect(reloaded.llm.primaryChannel).toBe('direct');
  });
});

describe('looksLikeBigmodelKey', () => {
  it('accepts a real bigmodel <id>.<secret> key', () => {
    expect(looksLikeBigmodelKey(BIGMODEL_KEY)).toBe(true);
  });

  it('rejects OpenAI-style keys (sk- prefix, no dot)', () => {
    expect(looksLikeBigmodelKey('sk-proj-abcdef123456')).toBe(false);
  });

  it('rejects Anthropic-style keys (sk-ant- prefix)', () => {
    expect(looksLikeBigmodelKey('sk-ant-api03-xxxxxxxxxxxx')).toBe(false);
  });

  it('rejects empty / null / undefined', () => {
    expect(looksLikeBigmodelKey('')).toBe(false);
    expect(looksLikeBigmodelKey(null)).toBe(false);
    expect(looksLikeBigmodelKey(undefined)).toBe(false);
  });
});

describe('reconcileOpenAiCompatBaseUrl', () => {
  it('substitutes bigmodel paas/v4 when key is bigmodel but host is deepseek', () => {
    // This is the exact 2026-06-19 e2e-sync failure scenario.
    expect(reconcileOpenAiCompatBaseUrl(DEEPSEEK_URL, BIGMODEL_KEY)).toBe(
      BIGMODEL_PAAS_V4,
    );
  });

  it('substitutes bigmodel paas/v4 when key is bigmodel but host is openai.com', () => {
    expect(
      reconcileOpenAiCompatBaseUrl('https://api.openai.com', BIGMODEL_KEY),
    ).toBe(BIGMODEL_PAAS_V4);
  });

  it('leaves bigmodel host unchanged when key is bigmodel', () => {
    expect(reconcileOpenAiCompatBaseUrl(BIGMODEL_PAAS_V4, BIGMODEL_KEY)).toBe(
      BIGMODEL_PAAS_V4,
    );
  });

  it('leaves custom OpenAI-compat gateway unchanged (non-bigmodel key)', () => {
    // A user's self-hosted gateway with a non-bigmodel key must NOT be
    // silently rewritten — respect the user's config.
    expect(
      reconcileOpenAiCompatBaseUrl(
        'https://my-gateway.example.com/v1',
        'sk-proj-something',
      ),
    ).toBe('https://my-gateway.example.com/v1');
  });

  it('leaves custom gateway unchanged even with bigmodel key (unknown host)', () => {
    // Unknown host + bigmodel key: we do NOT assume the user misconfigured.
    // Only the known deepseek/openai.com hosts are auto-corrected.
    expect(
      reconcileOpenAiCompatBaseUrl(
        'https://my-proxy.example.com/v1',
        BIGMODEL_KEY,
      ),
    ).toBe('https://my-proxy.example.com/v1');
  });

  it('falls back to bigmodel default when url is empty', () => {
    expect(reconcileOpenAiCompatBaseUrl('', BIGMODEL_KEY)).toBe(
      BIGMODEL_PAAS_V4,
    );
  });

  it('falls back to bigmodel default when url is null', () => {
    expect(reconcileOpenAiCompatBaseUrl(null, BIGMODEL_KEY)).toBe(
      BIGMODEL_PAAS_V4,
    );
  });

  it('handles malformed url gracefully', () => {
    expect(reconcileOpenAiCompatBaseUrl('not-a-url', BIGMODEL_KEY)).toBe(
      'not-a-url',
    );
  });
});

describe('reconcileModelAlias', () => {
  it('resets deepseek-chat to bigmodel OpenAI default alias when key is bigmodel', () => {
    expect(reconcileModelAlias('deepseek-chat', BIGMODEL_KEY)).toBe(
      'glm-4-flash',
    );
  });

  it('resets deepseek-reasoner to bigmodel OpenAI default alias when key is bigmodel', () => {
    expect(reconcileModelAlias('deepseek-reasoner', BIGMODEL_KEY)).toBe(
      'glm-4-flash',
    );
  });

  it('canonicalizes capacity labels in GLM model names', () => {
    expect(reconcileModelAlias('glm-5.2[1m]', BIGMODEL_KEY)).toBe('glm-5.2');
    expect(reconcileModelAlias('glm-4-flash', BIGMODEL_KEY)).toBe('glm-4-flash');
  });

  it('leaves deepseek-chat unchanged when key is NOT bigmodel (deepseek user)', () => {
    // A real deepseek user keeps deepseek-chat; we must not rewrite it.
    expect(reconcileModelAlias('deepseek-chat', 'sk-deepseek-xxx')).toBe(
      'deepseek-chat',
    );
  });

  it('defaults to bigmodel OpenAI alias when model is empty', () => {
    expect(reconcileModelAlias('', BIGMODEL_KEY)).toBe('glm-4-flash');
    expect(reconcileModelAlias(null, BIGMODEL_KEY)).toBe('glm-4-flash');
  });
});

describe('P2 watchedRoots configuration contract', () => {
  it('canonicalizes only HTTPS Feishu wiki-root URLs', () => {
    expect(canonicalizeWatchedRootUrl(`${ROOT_A}/?from=copy`)).toEqual({
      id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
      url: ROOT_A,
    });
    expect(canonicalizeWatchedRootUrl('http://qcnbafdrjx7n.feishu.cn/wiki/root')).toBeNull();
    expect(canonicalizeWatchedRootUrl('https://qcnbafdrjx7n.feishu.cn:8443/wiki/root')).toBeNull();
    expect(canonicalizeWatchedRootUrl('https://qcnbafdrjx7n.feishu.cn/wiki/root/child')).toBeNull();
  });

  it('rejects non-portable root-relative local directories', () => {
    expect(normalizeWatchedRootLocalDir('技术 - Dev/服务端')).toBe('技术 - Dev/服务端');
    expect(normalizeWatchedRootLocalDir('/absolute/path')).toBeNull();
    expect(normalizeWatchedRootLocalDir('D:\\knowledge-base')).toBeNull();
    expect(normalizeWatchedRootLocalDir('../escape')).toBeNull();
    expect(normalizeWatchedRootLocalDir('safe/../escape')).toBeNull();
    expect(normalizeWatchedRootLocalDir('CON')).toBeNull();
    expect(normalizeWatchedRootLocalDir('unsafe:name')).toBeNull();
  });

  it('requires root id to equal the wiki token in its URL', () => {
    expect(() => normalizeWatchedRootConfig({
      id: 'different-token',
      url: ROOT_A,
      localDir: '策划 - Designer',
      layoutProfile: 'mirror-title-file',
      enabled: true,
    })).toThrow(/id/);
  });

  it('migrates legacy URLs to structured roots and persists no legacy URL list', async () => {
    const configPath = createTempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({ watchedRootUrls: [ROOT_A, ROOT_B, ROOT_C, ROOT_D] }), 'utf-8');
    const manager = new ConfigManager(configPath);

    const config = await manager.load();

    expect(config.watchedRoots).toEqual([
      expect.objectContaining({
        id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
        url: ROOT_A,
        localDir: '策划 - Designer',
        layoutProfile: 'mirror-title-file',
        enabled: true,
      }),
      expect.objectContaining({
        id: 'QdZpwOmgBi25JVkAUmYcBiMinIf',
        url: ROOT_B,
        localDir: '技术 - Dev',
        layoutProfile: 'directory-readme',
        enabled: true,
      }),
      expect.objectContaining({
        id: 'NudewPkE9inlGhkEDA1c9FSsnkb',
        url: ROOT_C,
        localDir: '[必读] 研发规范',
        layoutProfile: 'directory-readme',
        enabled: true,
      }),
      expect.objectContaining({
        id: 'FEaww3vUHieIumk6FdIc92WHnyh',
        url: ROOT_D,
        localDir: '开发环境指引',
        layoutProfile: 'directory-readme',
        enabled: true,
      }),
    ]);
    expect(config.watchedRootUrls).toEqual([ROOT_A, ROOT_B, ROOT_C, ROOT_D]);

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.watchedRootUrls).toBeUndefined();
    expect(persisted.watchedRoots).toHaveLength(4);
  });

  it('does not drop legacy URLs when a transitional config also has an empty structured array', async () => {
    const configPath = createTempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({ watchedRoots: [], watchedRootUrls: [ROOT_A] }), 'utf-8');

    const config = await new ConfigManager(configPath).load();

    expect(config.watchedRoots).toEqual([
      expect.objectContaining({ id: 'Wramw1XxRihIgnkCrhqcdEbRnHb', url: ROOT_A }),
    ]);
  });

  it('keeps disabled roots visible in structured config but excludes them from runtime URL consumers', async () => {
    const configPath = createTempConfigPath();
    const manager = new ConfigManager(configPath);
    await manager.load();

    const saved = await manager.updateConfig({
      watchedRoots: [
        {
          id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
          url: ROOT_A,
          localDir: '策划 - Designer',
          layoutProfile: 'mirror-title-file',
          enabled: true,
        },
        {
          id: 'QdZpwOmgBi25JVkAUmYcBiMinIf',
          url: ROOT_B,
          localDir: '技术 - Dev',
          layoutProfile: 'directory-readme',
          enabled: false,
        },
      ],
    });

    expect(saved.watchedRoots).toHaveLength(2);
    expect(saved.watchedRootUrls).toEqual([ROOT_A]);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).watchedRootUrls).toBeUndefined();
  });

  it('rejects invalid structured updates without changing the saved root authority', async () => {
    const configPath = createTempConfigPath();
    const manager = new ConfigManager(configPath);
    await manager.load();
    await manager.updateConfig({
      watchedRoots: [{
        id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
        url: ROOT_A,
        localDir: '策划 - Designer',
        layoutProfile: 'mirror-title-file',
        enabled: true,
      }],
    });

    await expect(manager.updateConfig({
      watchedRoots: [{
        id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
        url: ROOT_A,
        localDir: '../unsafe',
        layoutProfile: 'mirror-title-file',
        enabled: true,
      }],
    })).rejects.toThrow(/localDir/);

    expect((await manager.load()).watchedRoots).toEqual([
      expect.objectContaining({ id: 'Wramw1XxRihIgnkCrhqcdEbRnHb', localDir: '策划 - Designer' }),
    ]);
  });
});

describe('larkCliPath removal (2026-10：路径不可配置 + 存量清理)', () => {
  const baseConfig = {
    llm: {
      openAiCompatBaseUrl: BIGMODEL_PAAS_V4,
      claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: BIGMODEL_KEY,
      model: 'glm-4-flash',
      temperature: 0.2,
      primaryChannel: 'claude-cli',
      fallbackOnFailure: false,
    },
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: '/tmp/kb',
    watchedRoots: [],
    requiredScopes: [],
    enableAutoStart: true,
    enableNotifications: true,
  };

  it('drops a stale larkCliPath on load and physically removes it from config.json', async () => {
    const configPath = createTempConfigPath();
    // 复现事故形态：用户填入错误路径后无法清空，错误值永久留在磁盘。
    fs.writeFileSync(configPath, JSON.stringify({
      ...baseConfig,
      larkCliPath: '/nonexistent/wrong/lark-cli',
    }), 'utf-8');
    const manager = new ConfigManager(configPath);

    const config = await manager.load();

    // 运行时配置不再携带该键。
    expect((config as Record<string, unknown>).larkCliPath).toBeUndefined();
    // 一次性迁移写回后，磁盘上的废弃键被物理清除。
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Object.prototype.hasOwnProperty.call(persisted, 'larkCliPath')).toBe(false);
    // 其余字段不受迁移影响。
    expect(persisted.knowledgeBaseRoot).toBe('/tmp/kb');
    expect(persisted.llm.apiKey).toBe(BIGMODEL_KEY);
  });

  it('stops rewriting config.json after the one-time cleanup (no write loop)', async () => {
    const configPath = createTempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(baseConfig), 'utf-8');
    const manager = new ConfigManager(configPath);
    // 首次 load 可能因 llm 归一化/度弃键清理写回一次，这里只关心之后稳定。
    await manager.load();
    const before = fs.statSync(configPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await manager.load();

    // 不再因迁移标记反复写盘，且不会重新长出废弃键。
    expect(fs.statSync(configPath).mtimeMs).toBe(before);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Object.prototype.hasOwnProperty.call(persisted, 'larkCliPath')).toBe(false);
  });

  it('strips larkCliPath from partial updates (stale cached frontend cannot resurrect it)', async () => {
    const configPath = createTempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(baseConfig), 'utf-8');
    const manager = new ConfigManager(configPath);
    await manager.load();

    // 旧版前端/第三方脚本仍回传废弃键的防御：合并点直接剔除。
    await manager.updateConfig({
      pollIntervalMinutes: 45,
      larkCliPath: '/also/wrong',
    } as Partial<Config> & { larkCliPath: string });

    const reloaded = await manager.load();
    expect(reloaded.pollIntervalMinutes).toBe(45);
    expect((reloaded as Record<string, unknown>).larkCliPath).toBeUndefined();
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Object.prototype.hasOwnProperty.call(persisted, 'larkCliPath')).toBe(false);
  });
});

describe('retired scope cleanup (2026-10：docs:document:read 上游失效)', () => {
  const baseConfig = {
    llm: {},
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: '/tmp/kb',
    watchedRoots: [],
    requiredScopes: [
      'wiki:node:retrieve',
      'wiki:space:retrieve',
      'docs:document.content:read',
      'sheets:spreadsheet:read',
      'docx:document:readonly',
      // 2026-09 additive 迁移写入的交替名，现已上游失效。
      'docs:document:read',
      'drive:drive.metadata:readonly',
      'docs:document.media:download',
      'slides:presentation:read',
      'offline_access',
    ],
  };

  it('removes the retired scope from stored config and persists the cleaned list', async () => {
    const configPath = createTempConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(baseConfig), 'utf-8');
    const manager = new ConfigManager(configPath);

    const config = await manager.load();

    expect(config.requiredScopes).not.toContain('docs:document:read');
    expect(config.requiredScopes).toContain('docx:document:readonly');
    expect(config.requiredScopes).toHaveLength(9);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.requiredScopes).not.toContain('docs:document:read');
  });

  it('default required scopes exclude the retired name', () => {
    expect(DEFAULT_REQUIRED_SCOPES).not.toContain('docs:document:read');
    expect(DEFAULT_REQUIRED_SCOPES).toContain('docx:document:readonly');
    expect(DEFAULT_REQUIRED_SCOPES).toHaveLength(9);
  });
});
