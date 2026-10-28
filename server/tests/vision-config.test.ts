/**
 * AgentVisionConfig 归一化与交叉校验测试（S2，设计 §3.1）
 *
 * - 旧配置无 vision 段 → load 补默认（disabled）
 * - updateConfig：enabled=true 时引用的 provider/预设必须存在且启用
 *   （invalid_config：agent.vision.providerId / agent.vision.modelId）
 * - llm 侧保存也可能删除被引用 provider —— 同一交叉校验兜底
 * - 结构非法（类型/范围）严格拒绝
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/modules/config-manager.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function newManager(): ConfigManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-cfg-'));
  tmpDirs.push(dir);
  const manager = new ConfigManager(path.join(dir, 'config.json'));
  return manager;
}

const PROVIDERS = [{
  id: 'vp', name: 'Vision Provider', enabled: true, protocol: 'openai-completions' as const,
  apiKey: 'k1', openAiCompatBaseUrl: 'https://vision.example/v1', defaultModelId: 'preset',
  models: [
    { id: 'preset', name: 'Vision Preset', enabled: true, openAiModel: 'vision-model', contextWindow: 64000, maxTokens: 2048 },
    { id: 'off', name: 'Disabled Preset', enabled: false, openAiModel: 'vision-model-off' },
  ],
}];

describe('vision 配置归一化', () => {
  it('旧配置无 vision 段 → load 补默认（disabled + 数值默认）并写回', async () => {
    const manager = newManager();
    const config = await manager.load();
    expect(config.agent.vision).toEqual({
      enabled: false,
      concurrency: 3,
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerBuild: 300,
      timeoutMs: 120_000,
    });
    const persisted = JSON.parse(fs.readFileSync(manager['configPath'], 'utf-8'));
    expect(persisted.agent.vision.enabled).toBe(false);
  });

  it('磁盘上的越界值 → 宽容归一夹回范围', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-cfg-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      llm: { openAiCompatBaseUrl: 'https://x/v1', apiKey: '', model: 'm', temperature: 0.2, primaryChannel: 'direct', fallbackOnFailure: false },
      watchedRoots: [],
      agent: { vision: { enabled: true, concurrency: 99, maxImageBytes: 999, maxImagesPerBuild: -1, timeoutMs: 1 } },
    }));
    const manager = new ConfigManager(path.join(dir, 'config.json'));
    const vision = (await manager.load()).agent.vision;
    expect(vision.concurrency).toBe(8);
    expect(vision.maxImageBytes).toBe(1024);
    expect(vision.maxImagesPerBuild).toBe(0);
    expect(vision.timeoutMs).toBe(5000);
    expect(vision.enabled).toBe(true);
  });
});

describe('vision 交叉校验（updateConfig / updateLLMConfig）', () => {
  let manager: ConfigManager;
  beforeEach(async () => {
    manager = newManager();
    const config = await manager.load();
    await manager.updateConfig({ llm: { ...config.llm, providers: PROVIDERS } as never });
  });

  it('enabled=true + 有效引用 → 保存成功并回读', async () => {
    const base = (await manager.load()).agent;
    await manager.updateConfig({
      agent: { ...base, vision: { ...base.vision, enabled: true, providerId: 'vp', modelId: 'preset' } },
    });
    const vision = (await manager.load()).agent.vision;
    expect(vision.enabled).toBe(true);
    expect(vision.providerId).toBe('vp');
    expect(vision.modelId).toBe('preset');
  });

  it('enabled=true + provider 不存在 → invalid_config{agent.vision.providerId}', async () => {
    const base = (await manager.load()).agent;
    await expect(manager.updateConfig({
      agent: { ...base, vision: { ...base.vision, enabled: true, providerId: 'ghost' } },
    })).rejects.toThrow(/agent\.vision\.providerId/);
  });

  it('enabled=true + 预设不存在/停用 → invalid_config{agent.vision.modelId}', async () => {
    const base = (await manager.load()).agent;
    await expect(manager.updateConfig({
      agent: { ...base, vision: { ...base.vision, enabled: true, providerId: 'vp', modelId: 'ghost' } },
    })).rejects.toThrow(/agent\.vision\.modelId/);
    // enabled:false 时不校验引用（允许先关后修）
    await expect(manager.updateConfig({
      agent: { ...base, vision: { ...base.vision, enabled: false, providerId: 'ghost' } },
    })).resolves.toBeTruthy();
  });

  it('enabled=true 不带显式引用 → 回落 activeProviderId/defaultModelId 仍可保存', async () => {
    const base = (await manager.load()).agent;
    await manager.updateConfig({
      llm: { ...((await manager.load()).llm), activeProviderId: 'vp', activeModelId: 'preset' } as never,
      agent: { ...base, vision: { ...base.vision, enabled: true } },
    });
    expect((await manager.load()).agent.vision.enabled).toBe(true);
  });

  it('llm 侧停用被引用 provider → 拒绝保存（防 vision 悬空）', async () => {
    const base = (await manager.load()).agent;
    await manager.updateConfig({
      agent: { ...base, vision: { ...base.vision, enabled: true, providerId: 'vp', modelId: 'preset' } },
    });
    await expect(manager.updateConfig({
      llm: { providers: [{ ...PROVIDERS[0], enabled: false }] } as never,
    })).rejects.toThrow(/agent\.vision\.providerId/);
  });

  it('结构非法严格拒绝（enabled 类型 / concurrency 越界）', async () => {
    const base = (await manager.load()).agent;
    await expect(manager.updateConfig({
      agent: { ...base, vision: { ...base.vision, enabled: 'yes' as never } },
    })).rejects.toThrow(/agent\.vision\.enabled/);
    await expect(manager.updateConfig({
      agent: { ...base, vision: { ...base.vision, concurrency: 99 } },
    })).rejects.toThrow(/agent\.vision\.concurrency/);
  });
});
