/** Vitest lifecycle: production data roots must never be used by the test suite. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export default function setup() {
  const previousHome = process.env.FEISHU_SYNC_HOME;
  const home = mkdtempSync(path.join(tmpdir(), 'feishu-sync-vitest-'));
  process.env.FEISHU_SYNC_HOME = home;
  return () => {
    if (previousHome === undefined) delete process.env.FEISHU_SYNC_HOME;
    else process.env.FEISHU_SYNC_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  };
}
