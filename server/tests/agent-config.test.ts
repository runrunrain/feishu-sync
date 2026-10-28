/**
 * Agent/StandardKb 配置段测试（设计 §12.1 配置与迁移行）
 *
 * - 旧 config.json 无 agent/standardKb 段 → load 补默认并写回一次
 * - 已有段缺字段 → 宽容归一
 * - updateConfig：workspaces 被忽略（防绕过路径校验）、非法值严格拒绝
 * - GET /api/config 的 agent/standardKb 段无秘密字段
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/modules/config-manager.js';

const tmpDirs: string[] = [];

function newConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cfg-'));
  tmpDirs.push(dir);
  return path.join(dir, 'config.json');
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('旧配置兼容（additive 默认合并）', () => {
  it('无 agent/standardKb 段 → load 补默认并写回', async () => {
    const configPath = newConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      llm: {
        openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: '',
        model: 'glm-4-flash',
        temperature: 0.2,
        primaryChannel: 'direct',
        fallbackOnFailure: false,
      },
      pollIntervalMinutes: 30,
      knowledgeBaseRoot: '/tmp/kb',
      watchedRoots: [],
      requiredScopes: [],
      enableAutoStart: true,
      enableNotifications: true,
    }));
    const manager = new ConfigManager(configPath);
    const config = await manager.load();
    expect(config.agent).toBeTruthy();
    expect(config.agent.model.source).toBe('app-llm');
    expect(config.agent.model.thinkingLevel).toBe('off');
    expect(config.agent.maxConcurrentProcesses).toBe(3);
    expect(config.agent.workspaces).toEqual([]);
    expect(config.standardKb.retainReleases).toBe(3);
    expect(config.standardKb.buildBatchSize).toBe(10);
    // 写回：磁盘上出现两段
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.agent).toBeTruthy();
    expect(persisted.standardKb).toBeTruthy();
  });

  it('第二次 load 不再触发写回（内容稳定）', async () => {
    const configPath = newConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      llm: {
        openAiCompatBaseUrl: 'https://x/v1', apiKey: '', model: 'm',
        temperature: 0.2, primaryChannel: 'direct', fallbackOnFailure: false,
      },
      watchedRoots: [],
    }));
    const manager = new ConfigManager(configPath);
    await manager.load();
    const firstWrite = fs.statSync(configPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.load();
    const secondWrite = fs.statSync(configPath).mtimeMs;
    expect(secondWrite).toBe(firstWrite);
  });

  it('已有 agent 段缺字段 → 宽容归一补默认', async () => {
    const configPath = newConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      llm: {
        openAiCompatBaseUrl: 'https://x/v1', apiKey: '', model: 'm',
        temperature: 0.2, primaryChannel: 'direct', fallbackOnFailure: false,
      },
      watchedRoots: [],
      agent: { model: { source: 'pi-agent-dir' } },
    }));
    const manager = new ConfigManager(configPath);
    const config = await manager.load();
    expect(config.agent.model.source).toBe('pi-agent-dir');
    expect(config.agent.model.thinkingLevel).toBe('off'); // 缺省补默认
    expect(config.agent.maxConcurrentProcesses).toBe(3);
  });
});

describe('updateConfig 校验', () => {
  let manager: ConfigManager;
  beforeEach(async () => {
    manager = new ConfigManager(newConfigPath());
    await manager.load();
  });

  it.each(['amagi-公司中转站/claude-fable-5', 'amagi-个人版API- GPT/gpt-6-luna', 'router/vendor/model:latest'])(
    'pi实际模型标识可保存并回读：%s', async (piModel) => {
      const base = (await manager.load()).agent;
      await manager.updateConfig({ agent: { ...base, model: { ...base.model, source: 'pi-agent-dir', piModel } } });
      expect((await manager.load()).agent.model.piModel).toBe(piModel);
    },
  );

  it.each(['provider-only', '/model', 'provider/', ' provider/model', 'provider/model\n', 'provider/\u0000model'])(
    '拒绝残缺或控制字符pi标识：%j', async (piModel) => {
      const base = (await manager.load()).agent;
      await expect(manager.updateConfig({ agent: { ...base, model: { ...base.model, source: 'pi-agent-dir', piModel } } }))
        .rejects.toThrow(/piModel/);
    },
  );

  it('agent.workspaces 在 PUT 中被忽略', async () => {
    await manager.updateConfig({
      agent: {
        ...(await manager.load()).agent,
        workspaces: [{ id: 'ws_evil', name: 'evil', path: '/etc', createdAt: new Date().toISOString() }],
      },
    } as never);
    expect((await manager.load()).agent.workspaces).toEqual([]);
  });

  it('非法 source 严格拒绝（invalid_config）', async () => {
    await expect(manager.updateConfig({
      agent: { ...((await manager.load()).agent), model: { ...((await manager.load()).agent).model, source: 'bad-source' as never } },
    } as never)).rejects.toThrow(/配置校验失败/);
  });

  it('maxConcurrentProcesses 越界拒绝', async () => {
    const base = (await manager.load()).agent;
    await expect(manager.updateConfig({
      agent: { ...base, maxConcurrentProcesses: 9 },
    } as never)).rejects.toThrow(/maxConcurrentProcesses/);
  });

  it('合法 runtime 覆盖与 thinkingLevel 保存', async () => {
    const base = (await manager.load()).agent;
    const updated = await manager.updateConfig({
      agent: { ...base, runtime: { nodePath: '/usr/local/bin/node' }, model: { ...base.model, thinkingLevel: 'medium' } },
    } as never);
    expect(updated.agent.runtime.nodePath).toBe('/usr/local/bin/node');
    expect(updated.agent.model.thinkingLevel).toBe('medium');
  });
});
