import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDataRoot } from '../src/modules/data-root.js';

it('uses a disposable data root before application modules are imported', () => {
  const home = process.env.FEISHU_SYNC_HOME;
  expect(home).toBeTruthy();
  expect(path.basename(home!)).toMatch(/^feishu-sync-vitest-/);
  expect(path.dirname(home!)).toBe(path.resolve(tmpdir()));
  expect(resolveDataRoot()).toBe(home);
  expect(existsSync(home!)).toBe(true);
});
