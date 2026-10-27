/** Electron main bundles ConfigManager as CJS; exercise that real build format without launching Electron. */
import { afterAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cjs-config-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('CJS ConfigManager with registered Workspace can update settings without import.meta or wrong application root', async () => {
  const appRoot = path.join(root, 'application');
  const dataRoot = path.join(root, 'data');
  const workspace = path.join(root, 'documents');
  fs.mkdirSync(workspace, { recursive: true });
  const outfile = path.join(appRoot, 'dist-electron', 'config.cjs');
  await build({
    entryPoints: [path.resolve('src/modules/config-manager.ts')],
    outfile, bundle: true, format: 'cjs', platform: 'node', target: 'node20',
    define: { 'import.meta.url': 'undefined' }, logLevel: 'silent',
  });
  const code = `
    const { ConfigManager } = require(process.env.TEST_CONFIG_BUNDLE);
    (async () => {
      const manager = new ConfigManager();
      await manager.load();
      await manager.updateConfig({ agent: { workspaces: [{ id: 'ws_cjsfixture', name: 'Documents', path: process.env.TEST_WORKSPACE, createdAt: new Date().toISOString() }] } });
      await manager.updateConfig({ enableAutoStart: false });
      const config = await manager.load();
      if (config.enableAutoStart !== false || config.agent.workspaces.length !== 1) throw new Error('Settings did not persist');
      console.log('CJS_CONFIG_UPDATE_OK');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, FEISHU_SYNC_HOME: dataRoot, TEST_CONFIG_BUNDLE: outfile, TEST_WORKSPACE: workspace },
    encoding: 'utf8', timeout: 10_000,
  });
  expect(output).toContain('CJS_CONFIG_UPDATE_OK');
});
