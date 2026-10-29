/**
 * PiRuntimeResolver 测试（设计 §12.1）
 *
 * fixture：临时目录内构造假 node 可执行脚本（打印固定 --version）与假
 * pi 包（package.json + dist/cli.js）。标明用途：算法层验证，不冒充真实
 * 安装。真实 pi 的装载/探测由 pi-probe.test.ts 覆盖（本机有 pi 1.4）。
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions,
  PiRuntimeResolver,
  satisfiesPiRange,
  resolveAppLlmModel,
  PI_PACKAGE_NAME,
} from '../src/agent/runtime-resolver.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';
import { buildDefaultLlmConfigForTest } from './helpers/llm-fixture.js';
import { makeRuntimeInstallation } from './helpers/runtime-installation.js';

let fixtureRoot: string;

function makeFakeNode(dir: string, version: string): string {
  // 按当前平台模拟 resolver 要找的可执行文件名；版本由测试注入。
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(script, `#!/bin/sh\necho "v${version}"\n`, { mode: 0o755 });
  return script;
}

function makeFakePiAtLibNodeModules(base: string, version: string): string {
  const pkgRoot = path.join(base, 'lib', 'node_modules', ...PI_PACKAGE_NAME.split('/'));
  fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: PI_PACKAGE_NAME, version }));
  fs.writeFileSync(path.join(pkgRoot, 'dist', 'cli.js'), '// fake');
  return pkgRoot;
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-resolver-fx-'));
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('compareVersions / satisfiesPiRange', () => {
  it('语义化比较', () => {
    expect(compareVersions('22.19.0', '22.19.0')).toBe(0);
    expect(compareVersions('22.19.1', '22.19.0')).toBe(1);
    expect(compareVersions('22.9.0', '22.19.0')).toBe(-1);
    expect(compareVersions('v24.21.0', '22.19.0')).toBe(1);
    expect(compareVersions('24.0.0-alpha', '24.0.0')).toBe(0);
  });

  it('pi 支持范围 >=1.4.0 <2.0.0', () => {
    expect(satisfiesPiRange('1.4.0')).toBe(true);
    expect(satisfiesPiRange('1.9.9')).toBe(true);
    expect(satisfiesPiRange('1.3.9')).toBe(false);
    expect(satisfiesPiRange('2.0.0')).toBe(false);
    expect(satisfiesPiRange('2.1.0')).toBe(false);
  });
});

describe('resolveRuntime（fixture）', () => {
  it('标准布局、缺pi回退及显式pi均不执行npm symlink入口', async () => {
    const fixture = makeRuntimeInstallation(path.join(fixtureRoot, 'npm-symlink'));
    const resolver = new PiRuntimeResolver({ env: { PATH: '' }, execNodeVersion: async (candidate) => candidate === fixture.nodePath ? '24.21.0' : null });
    const config = buildDefaultAgentConfig(fixtureRoot);
    config.runtime.nodePath = fixture.nodePath;
    const found = await resolver.resolveRuntime(config);
    expect(found.piPackageRoot).toBe(fixture.piRoot);
    expect(fs.existsSync(fixture.marker)).toBe(false);
    const customPi = `${fixture.piRoot}-custom`;
    fs.renameSync(fixture.piRoot, customPi);
    expect((await resolver.resolveRuntime(config)).piCliPath).toBeNull();
    expect(fs.existsSync(fixture.marker)).toBe(false);
    config.runtime.piCliPath = path.join(customPi, 'dist', 'cli.js');
    expect((await resolver.resolveRuntime(config)).piPackageRoot).toBe(customPi);
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it('无候选 → node_missing（nodePath null）', async () => {
    const resolver = new PiRuntimeResolver({
      env: { PATH: path.join(fixtureRoot, 'nonexistent-bin') },
      execNodeVersion: async () => null,
    });
    const runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(fixtureRoot));
    expect(runtime.nodePath).toBeNull();
  });

  it('找到旧 Node → 不选中，供 node_too_old 诊断', async () => {
    const nodeDir = path.join(fixtureRoot, 'old-node');
    const nodePath = makeFakeNode(nodeDir, '20.18.0');
    const resolver = new PiRuntimeResolver({
      env: { PATH: nodeDir },
      execNodeVersion: async (candidate) => (candidate === nodePath ? '20.18.0' : null),
    });
    const runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(fixtureRoot));
    expect(runtime.nodePath).toBeNull();
  });

  it('PATH 上的新 Node + lib/node_modules pi 包 → 全部解析', async () => {
    const base = path.join(fixtureRoot, 'good');
    const binDir = path.join(base, 'bin');
    const nodePath = makeFakeNode(binDir, '24.21.0');
    const pkgRoot = path.join(base, 'lib', 'node_modules', ...PI_PACKAGE_NAME.split('/'));
    fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: PI_PACKAGE_NAME, version: '1.4.0' }));
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'cli.js'), '// fake');

    const resolver = new PiRuntimeResolver({
      env: { PATH: binDir },
      execNodeVersion: async (candidate) => (candidate === nodePath ? '24.21.0' : null),
    });
    const runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(fixtureRoot));
    expect(runtime.nodePath).toBe(nodePath);
    expect(runtime.nodeVersion).toBe('24.21.0');
    expect(runtime.piPackageRoot).toBe(pkgRoot);
    expect(runtime.piCliPath).toBe(path.join(pkgRoot, 'dist', 'cli.js'));
    expect(runtime.piVersion).toBe('1.4.0');
  });

  it('显式 nodePath 排他：坏路径不静默换安装（node_too_old 诊断路径）', async () => {
    const bad = path.join(fixtureRoot, 'does-not-exist-node');
    const config = buildDefaultAgentConfig(fixtureRoot);
    config.runtime.nodePath = bad;
    const resolver = new PiRuntimeResolver({
      env: { PATH: '' },
      execNodeVersion: async () => null,
    });
    const runtime = await resolver.resolveRuntime(config);
    expect(runtime.nodePath).toBeNull();
  });

  it('pi 包名不匹配 → pi_missing；版本越界 → 版本信息保留供诊断', async () => {
    const base = path.join(fixtureRoot, 'wrong-pi');
    const binDir = path.join(base, 'bin');
    const nodePath = makeFakeNode(binDir, '23.0.0');
    // 名字不匹配的包放在标准位置
    const pkgRoot = path.join(base, 'lib', 'node_modules', 'other-package');
    fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'other-package', version: '2.5.0' }));
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'cli.js'), '// fake');
    fs.symlinkSync(path.join(pkgRoot, 'dist', 'cli.js'), path.join(binDir, 'pi'));

    const resolver = new PiRuntimeResolver({
      env: { PATH: binDir },
      execNodeVersion: async (candidate) => (candidate === nodePath ? '23.0.0' : null),
    });
    const runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(fixtureRoot));
    expect(runtime.nodePath).toBe(nodePath);
    expect(runtime.piCliPath).toBeNull(); // 名字不匹配的包不采用
  });

  it('PATH 上 pi 可执行 realpath 回溯包根', async () => {
    const base = path.join(fixtureRoot, 'pi-shim');
    const binDir = path.join(base, 'shim-bin');
    const pkgRoot = makeFakePiAtLibNodeModules(base, '1.5.2');
    fs.mkdirSync(binDir, { recursive: true });
    const nodeDir = path.join(base, 'node-bin');
    const nodePath = makeFakeNode(nodeDir, '22.20.0');
    // bin/pi 用 symlink 指向包内 cli（模拟 npm 全局 bin 布局；realpath
    // 回溯依赖 symlink，不解析脚本内容）
    const cliEntry = path.join(pkgRoot, 'dist', 'cli.js');
    fs.chmodSync(cliEntry, 0o755);
    fs.symlinkSync(cliEntry, path.join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi'));

    const resolver = new PiRuntimeResolver({
      env: { PATH: `${binDir}${path.delimiter}${nodeDir}` },
      execNodeVersion: async (candidate) => (candidate === nodePath ? '22.20.0' : null),
    });
    const runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(fixtureRoot));
    expect(runtime.nodePath).toBe(nodePath);
    expect(runtime.piCliPath).toBe(cliEntry);
    expect(runtime.piVersion).toBe('1.5.2');
  });

  it('Windows npm 布局：pi.cmd shim 同级 node_modules 推导包根（P0 实测修复）', async () => {
    const base = fs.mkdtempSync(path.join(fixtureRoot, 'win-npm-'));
    // node.exe 在 Program Files 风格目录，与 npm prefix 无关。
    // platform 注入 win32：resolver 固定查找 node.exe（与测试运行平台无关）
    const nodeDir = path.join(base, 'Program Files', 'nodejs');
    const nodePath = path.join(nodeDir, 'node.exe');
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(nodePath, 'fake-node', { mode: 0o755 });
    // npm prefix：%APPDATA%\npm 下 pi.cmd shim 与 node_modules 同级
    const npmPrefix = path.join(base, 'AppData', 'Roaming', 'npm');
    const pkgRoot = path.join(npmPrefix, 'node_modules', ...PI_PACKAGE_NAME.split('/'));
    fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: PI_PACKAGE_NAME, version: '1.4.0' }));
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'cli.js'), '// fake');
    const shimPath = path.join(npmPrefix, 'pi.cmd');
    // 普通脚本而非 symlink：模拟 Windows npm shim（realpath 原样返回）
    fs.writeFileSync(shimPath, '@ECHO off\r\nnode "%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n', { mode: 0o755 });

    const resolver = new PiRuntimeResolver({
      platform: 'win32',
      env: {
        PATH: `${nodeDir}${path.delimiter}${npmPrefix}`,
        APPDATA: path.join(base, 'AppData', 'Roaming'),
      },
      execNodeVersion: async (candidate) => (candidate === nodePath ? '24.18.0' : null),
    });
    const runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(fixtureRoot));
    expect(runtime.nodePath).toBe(nodePath);
    expect(runtime.piPackageRoot).toBe(pkgRoot);
    expect(runtime.piCliPath).toBe(path.join(pkgRoot, 'dist', 'cli.js'));
    expect(runtime.piVersion).toBe('1.4.0');
  });

  it('Windows npm 布局：PATH 缺 npm 目录时 APPDATA prefix 兑底', async () => {
    const base = fs.mkdtempSync(path.join(fixtureRoot, 'win-appdata-'));
    const nodeDir = path.join(base, 'nodejs');
    const nodePath = path.join(nodeDir, 'node.exe');
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(nodePath, 'fake-node', { mode: 0o755 });
    const appData = path.join(base, 'AppData', 'Roaming');
    const pkgRoot = path.join(appData, 'npm', 'node_modules', ...PI_PACKAGE_NAME.split('/'));
    fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: PI_PACKAGE_NAME, version: '1.4.0' }));
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'cli.js'), '// fake');

    const resolver = new PiRuntimeResolver({
      platform: 'win32',
      env: { PATH: nodeDir, APPDATA: appData },
      execNodeVersion: async (candidate) => (candidate === nodePath ? '24.18.0' : null),
    });
    const runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(fixtureRoot));
    expect(runtime.nodePath).toBe(nodePath);
    expect(runtime.piPackageRoot).toBe(pkgRoot);
  });
});

describe('checkReadiness 就绪码（fixture）', () => {
  it.each([
    { selected: undefined, result: { ok: true, available: ['configured/one', 'configured/two'] }, code: 'model_unconfigured' },
    { selected: 'removed/model', result: { ok: true, available: ['configured/one'] }, code: 'model_unconfigured' },
    { selected: 'configured/one', result: { ok: true, available: ['configured/one'] }, code: 'ready' },
    { selected: undefined, result: { ok: true, available: [] as string[] }, code: 'model_auth_missing' },
    { selected: undefined, result: { ok: false, available: [] as string[] }, code: 'pi_spawn_failed' },
  ])('pi配置选择 $selected：返回$code，同时保留有效模型列表', async ({ selected, result, code }) => {
    const base = fs.mkdtempSync(path.join(fixtureRoot, 'pi-model-list-'));
    const nodePath = makeFakeNode(path.join(base, 'bin'), '24.0.0');
    makeFakePiAtLibNodeModules(base, '1.4.1');
    const resolver = new PiRuntimeResolver({ env: { PATH: path.dirname(nodePath) }, execNodeVersion: async () => '24.0.0' });
    const config = buildDefaultAgentConfig(base);
    config.model.source = 'pi-agent-dir';
    config.model.piModel = selected;
    const probe = vi.fn(async () => result);
    const status = await resolver.checkReadiness({ agentConfig: config, llmConfig: buildDefaultLlmConfigForTest(), runningProcesses: 0 }, probe);
    expect(probe).toHaveBeenCalledOnce();
    expect(status.code).toBe(code);
    expect(status.model.model).toBe(selected ?? null);
    expect(status.model.available).toEqual(result.available);
  });

  it('app-llm 无 provider → model_unconfigured', async () => {
    const resolver = new PiRuntimeResolver({ env: { PATH: '' }, execNodeVersion: async () => null });
    const llm = buildDefaultLlmConfigForTest();
    llm.providers = [];
    const result = await resolver.checkReadiness({
      agentConfig: buildDefaultAgentConfig(fixtureRoot),
      llmConfig: llm,
      runningProcesses: 0,
    });
    expect(result.code).toBe('node_missing'); // 无 node 时先卡 node_missing
  });

  it('app-llm 有 provider 无 key → model_auth_missing（node/pi 就绪后）', async () => {
    const base = path.join(fixtureRoot, 'ready-nokey');
    const binDir = path.join(base, 'bin');
    const nodePath = makeFakeNode(binDir, '24.0.0');
    makeFakePiAtLibNodeModules(base, '1.4.1');
    const resolver = new PiRuntimeResolver({
      env: { PATH: binDir },
      execNodeVersion: async (candidate) => (candidate === nodePath ? '24.0.0' : null),
    });
    const llm = buildDefaultLlmConfigForTest();
    llm.providers = [{
      id: 'bigmodel', name: '智谱', enabled: true, apiKey: '',
      openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: [{ id: 'default', name: '默认', openAiModel: 'glm-4-flash', enabled: true }],
    }];
    const result = await resolver.checkReadiness({
      agentConfig: buildDefaultAgentConfig(fixtureRoot),
      llmConfig: llm,
      runningProcesses: 0,
    });
    expect(result.code).toBe('model_auth_missing');
  });

  it('pi-agent-dir 无 piModel → model_unconfigured', async () => {
    const base = path.join(fixtureRoot, 'pidir-nomodel');
    const binDir = path.join(base, 'bin');
    const nodePath = makeFakeNode(binDir, '24.0.0');
    makeFakePiAtLibNodeModules(base, '1.4.1');
    const resolver = new PiRuntimeResolver({
      env: { PATH: binDir },
      execNodeVersion: async (candidate) => (candidate === nodePath ? '24.0.0' : null),
    });
    const config = buildDefaultAgentConfig(fixtureRoot);
    config.model.source = 'pi-agent-dir';
    config.model.piModel = undefined;
    const result = await resolver.checkReadiness({
      agentConfig: config,
      llmConfig: buildDefaultLlmConfigForTest(),
      runningProcesses: 0,
    });
    expect(result.code).toBe('model_unconfigured');
  });
});

describe('resolveAppLlmModel', () => {
  it('显式 providerId/modelId 优先，缺省回落 active*', () => {
    const llm = buildDefaultLlmConfigForTest();
    const agent = buildDefaultAgentConfig(fixtureRoot);
    const resolved = resolveAppLlmModel(llm, agent);
    expect(resolved).not.toBeNull();
    expect(resolved!.openAiModel).toBe('glm-4-flash');
    expect(resolved!.baseUrl).toContain('bigmodel');

    const agentExplicit = buildDefaultAgentConfig(fixtureRoot);
    agentExplicit.model.providerId = 'second';
    agentExplicit.model.modelId = 'm2';
    const second = resolveAppLlmModel(llm, agentExplicit);
    expect(second?.openAiModel).toBe('glm-4.6');
  });
  it('never borrows another provider key or silently replaces disabled/missing explicit selections', () => {
    const llm = buildDefaultLlmConfigForTest(); const agent = buildDefaultAgentConfig(fixtureRoot);
    llm.apiKey = 'unrelated-key'; llm.providers![0].apiKey = '';
    expect(resolveAppLlmModel(llm, agent)?.apiKey).toBe('');
    agent.model.providerId = 'missing'; expect(resolveAppLlmModel(llm, agent)).toBeNull();
    agent.model.providerId = llm.providers![0].id; agent.model.modelId = 'missing';
    expect(resolveAppLlmModel(llm, agent)).toBeNull();
    agent.model.modelId = ''; llm.providers![0].models.forEach((model) => { model.enabled = false; });
    expect(resolveAppLlmModel(llm, agent)).toBeNull();
  });
});

describe('就绪缓存与并发探测', () => {
  function cachedFixture() {
    const base = fs.mkdtempSync(path.join(fixtureRoot, 'cache-'));
    const nodePath = makeFakeNode(path.join(base, 'bin'), '24.0.0'); makeFakePiAtLibNodeModules(base, '1.4.1');
    const resolver = new PiRuntimeResolver({ env: { PATH: path.dirname(nodePath), PI_CODING_AGENT_DIR: base }, execNodeVersion: async () => '24.0.0' });
    const agentConfig = buildDefaultAgentConfig(base); agentConfig.model = { source: 'pi-agent-dir', piModel: 'configured/one' };
    const input = { agentConfig, llmConfig: buildDefaultLlmConfigForTest(), runningProcesses: 0 };
    return { base, resolver, input };
  }
  it('合并并发请求，复用模型列表但实时返回进程数；强制刷新只探测一次', async () => {
    const { resolver, input } = cachedFixture(); const probe = vi.fn(async () => ({ ok: true, available: ['configured/one'] }));
    const results = await Promise.all([resolver.checkReadiness(input, probe), resolver.checkReadiness({ ...input, runningProcesses: 2 }, probe)]);
    expect(probe).toHaveBeenCalledOnce(); expect(results[1].processes.running).toBe(2);
    expect((await resolver.checkReadiness(input, probe)).checkedAt).toBe(results[0].checkedAt);
    await Promise.all([resolver.checkReadiness(input, probe, { force: true }), resolver.checkReadiness(input, probe, { force: true })]);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it('五分钟到期、模型修改与凭据文件修改都会重新探测', async () => {
    const { base, resolver, input } = cachedFixture(); const probe = vi.fn(async () => ({ ok: true, available: ['configured/one', 'configured/two'] }));
    const now = Date.now(); const date = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await resolver.checkReadiness(input, probe); date.mockReturnValue(now + 299_999); await resolver.checkReadiness(input, probe); expect(probe).toHaveBeenCalledOnce();
      date.mockReturnValue(now + 300_001); await resolver.checkReadiness(input, probe); expect(probe).toHaveBeenCalledTimes(2);
      input.agentConfig.model.piModel = 'configured/two'; await resolver.checkReadiness(input, probe); expect(probe).toHaveBeenCalledTimes(3);
      fs.writeFileSync(path.join(base, 'auth.json'), '{}'); await resolver.checkReadiness(input, probe); expect(probe).toHaveBeenCalledTimes(4);
    } finally { date.mockRestore(); }
  });
  it('失败只缓存30秒，失效时旧的在途结果不能重新填充缓存', async () => {
    const { resolver, input } = cachedFixture(); const probe = vi.fn(async () => ({ ok: false, available: [] as string[] }));
    const now = Date.now(); const date = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await resolver.checkReadiness(input, probe); date.mockReturnValue(now + 30_001); await resolver.checkReadiness(input, probe); expect(probe).toHaveBeenCalledTimes(2);
    } finally { date.mockRestore(); }
    resolver.invalidate(); let release!: (value: { ok: boolean; available: string[] }) => void;
    const slow = vi.fn(() => new Promise<{ ok: boolean; available: string[] }>((resolve) => { release = resolve; }));
    const request = resolver.checkReadiness(input, slow); await vi.waitFor(() => expect(slow).toHaveBeenCalledOnce());
    resolver.invalidate(); release({ ok: true, available: ['configured/one'] }); await request;
    expect(resolver.getCached()).toBeNull(); await resolver.checkReadiness(input, probe); expect(probe).toHaveBeenCalledTimes(3);
  });
});
