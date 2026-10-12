import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LarkCliManager } from '../src/modules/lark-cli-manager.js';
import type { Config } from '../src/types/index.js';

describe('device auth subprocess argument boundary', () => {
  it('passes all requested scopes and the complete device code through a real shell', async () => {
    // Windows CI exercises cmd.exe + a .cmd shim. On Unix, /bin/sh reproduces
    // the same whitespace splitting using a script shim. No real login occurs.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu auth shell '));
    const shim = path.join(root, 'lark-cli.cmd');
    const script = path.join(root, 'fake-cli.cjs');
    const granted = ['auth:user.id:read', 'wiki:node:retrieve', 'offline_access'];
    const missing = ['wiki:space:retrieve', 'sheets:spreadsheet:read', 'slides:presentation:read'];
    const required = ['wiki:node:retrieve', ...missing, 'offline_access'];
    const requested = [...granted, ...missing];
    const deviceCode = 'dc-test=1&state=2';
    try {
      fs.writeFileSync(script, `
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args.includes('--no-wait')) {
  assert.deepEqual(args, ['auth', 'login', '--no-wait', '--json', '--scope', ${JSON.stringify(requested.join(' '))}]);
  console.log(JSON.stringify({ device_code: ${JSON.stringify(deviceCode)}, expires_in: 600, verification_url: 'https://example.com/auth' }));
} else {
  assert.deepEqual(args, ['auth', 'login', '--device-code', ${JSON.stringify(deviceCode)}, '--json']);
  console.log(JSON.stringify({ event: 'authorization_complete', user_open_id: 'ou-test' }));
}
`);
      fs.writeFileSync(shim, process.platform === 'win32'
        ? `@"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { mode: 0o755 });
      let authorized = false;
      const client = {
        checkAuthReady: async () => ({
          ready: authorized, verified: authorized, account: { id: 'ou-test' },
          identity: 'user',
          currentScopes: authorized ? requested : granted,
          missingScopes: authorized ? [] : missing,
        }),
      };
      const config = { requiredScopes: required } as Config;
      const manager = new LarkCliManager(client, {
        getConfig: () => config,
        load: async () => config,
      }, { platform: 'win32', homeDir: root, env: { LARK_CLI_PATH: shim } });

      const session = await manager.startDeviceAuth();
      expect(session.requestedScopes).toEqual(requested);
      expect(session.deviceCode).toBe(deviceCode);
      authorized = true;
      await expect(manager.completeDeviceAuth(session.deviceCode)).resolves.toMatchObject({
        ok: true, ready: true, missingScopes: [],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
