import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeInstaller } from '../src/agent/runtime-installer.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
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
