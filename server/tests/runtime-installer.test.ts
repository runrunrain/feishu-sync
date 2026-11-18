import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeInstaller } from '../src/agent/runtime-installer.js';
import { PiRuntimeResolver, PI_PACKAGE_NAME } from '../src/agent/runtime-resolver.js';
import { ensurePiLauncher } from '../src/agent/windows-pi-launcher.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';

describe('managed runtime installation', () => {
  it('refuses updates while capacity is in use and leaves custom installations alone', async () => {
    const config = buildDefaultAgentConfig('');
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const installer = new RuntimeInstaller(os.tmpdir(), new PiRuntimeResolver(), pool, () => config);
    const slot = pool.reserveSlot()!;
    await expect(installer.install('pi')).rejects.toThrow('请先结束');
    slot.release();
    config.runtime.claudeCliPath = 'custom';
    await expect(installer.install('claude-code')).rejects.toThrow('自定义运行时路径');
    await pool.closeAll();
  });

  it('publishes an existing app-managed Pi without replacing launchers owned by another installer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-launcher-'));
    const resolver = new PiRuntimeResolver();
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const prefix = path.join(root, 'agent', 'runtimes', 'pi');
    const packageRoot = path.join(prefix, 'node_modules', PI_PACKAGE_NAME);
    const cliPath = path.join(packageRoot, 'dist', 'bundle', 'cli.js');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '');
    const runtime = { nodePath: process.execPath, nodeVersion: process.version,
      piPackageRoot: packageRoot, piCliPath: cliPath, piVersion: '1.5.2' };
    const resolve = vi.spyOn(resolver, 'resolveRuntime').mockResolvedValue(runtime);
    const publish = vi.fn(async (dir: string, node: string, cli: string) => ensurePiLauncher(dir, node, cli));
    const config = buildDefaultAgentConfig(root);
    const installer = new RuntimeInstaller(root, resolver, pool, () => config, publish);
    const launcher = path.join(prefix, 'pi.cmd');
    try {
      await installer.ensureMissing();
      expect(publish).toHaveBeenCalledWith(fs.realpathSync(prefix), process.execPath, fs.realpathSync(cliPath));
      expect(fs.readFileSync(launcher, 'utf8')).toContain('%~dp0node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js');
      fs.writeFileSync(launcher, '@echo another installer');
      expect(() => ensurePiLauncher(prefix, process.execPath, cliPath)).toThrow('占用');
      expect(fs.readFileSync(launcher, 'utf8')).toBe('@echo another installer');

      publish.mockClear();
      resolve.mockResolvedValue({ ...runtime, piPackageRoot: path.join(root, 'global-pi') });
      await installer.ensureMissing();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await pool.closeAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.env.FEISHU_SYNC_INSTALL_TEST !== '1')('installs both official runtimes in an isolated data directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-install-'));
    const oldRoot = process.env.FEISHU_SYNC_HOME;
    process.env.FEISHU_SYNC_HOME = root;
    const config = buildDefaultAgentConfig(root);
    config.runtime.nodePath = process.execPath;
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const resolver = new PiRuntimeResolver();
    try {
      const installer = new RuntimeInstaller(root, resolver, pool, () => config);
      await installer.install('claude-code');
      await installer.install('pi');
      const runtime = await resolver.resolveRuntime(config);
      expect(runtime.piCliPath).toContain('runtimes');
      expect(runtime.claudeCliPath).toContain('runtimes');
    } finally {
      await pool.closeAll();
      if (oldRoot === undefined) delete process.env.FEISHU_SYNC_HOME; else process.env.FEISHU_SYNC_HOME = oldRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
