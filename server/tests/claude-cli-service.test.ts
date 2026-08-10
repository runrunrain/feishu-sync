import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildClaudeCliEnvironment,
  resolveClaudeCliInvocation,
} from '../src/modules/claude-cli-service.js';

describe('Claude CLI desktop discovery', () => {
  it('finds the common ~/.local/node/bin installation and exposes its Node runtime on PATH', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-claude-cli-'));
    try {
      const binDir = path.join(homeDir, '.local', 'node', 'bin');
      const executable = path.join(binDir, 'claude');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o755 });

      const invocation = resolveClaudeCliInvocation(undefined, {
        homeDir,
        platform: 'darwin',
        env: { PATH: '/usr/bin:/bin' },
      });

      expect(invocation).toMatchObject({
        command: executable,
        source: 'known-location',
        useShell: false,
      });
      expect(buildClaudeCliEnvironment(invocation!, { PATH: '/usr/bin:/bin' }, 'darwin').PATH)
        .toBe(`${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('marks an explicit Windows npm .cmd shim as shell-backed', () => {
    const invocation = resolveClaudeCliInvocation('/tmp/claude.cmd', {
      platform: 'win32',
      env: { PATH: '' },
      homeDir: '/tmp/no-claude-home',
    });
    expect(invocation).toMatchObject({ useShell: true, source: 'configured' });
  });
});
