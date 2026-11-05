// Isolated native runtime regression; never loads or mutates the live build store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const rootRequire = createRequire(import.meta.url);
const JSZip = rootRequire('../../server/node_modules/jszip');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bundled-shutdown-proof-'));
try {
  const zip = await JSZip.loadAsync(fs.readFileSync('server/bundled/amagi-pi/package.zip'));
  const packageRoot = path.join(root, 'package');
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const target = path.resolve(packageRoot, name);
    assert.ok(target.startsWith(packageRoot + path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async('nodebuffer'));
  }
  const sdkRoot = path.join(os.homedir(), '.feishu-sync/agent/runtime-packages/amagi-pi@2.21.36/package/node_modules/@earendil-works/pi-coding-agent');
  const sdkRequire = createRequire(path.join(sdkRoot, 'package.json'));
  const { createJiti } = await import(pathToFileURL(sdkRequire.resolve('jiti')));
  const alias = {};
  for (const suffix of ['', '/compile', '/value']) {
    alias[`typebox${suffix}`] = sdkRequire.resolve(`typebox${suffix}`);
    alias[`@sinclair/typebox${suffix}`] = sdkRequire.resolve(`typebox${suffix}`);
  }
  for (const prefix of ['@earendil-works', '@mariozechner']) {
    for (const name of ['pi-coding-agent', 'pi-agent-core', 'pi-tui'])
      alias[`${prefix}/${name}`] = path.join(path.dirname(sdkRoot), name, 'dist/index.js');
    alias[`${prefix}/pi-ai`] = path.join(path.dirname(sdkRoot), 'pi-ai/dist/compat.js');
    for (const suffix of ['/compat', '/oauth', '/providers/all'])
      alias[`${prefix}/pi-ai${suffix}`] = path.join(path.dirname(sdkRoot), `pi-ai/dist${suffix}.js`);
  }
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'home');
  process.env.AMAGI_CONTRACT_ROOT = path.join(root, 'v2-store');
  process.env.AMAGI_DATA_DIR = path.join(root, 'data');
  const jiti = createJiti(import.meta.url, { alias, interopDefault: true, tryNative: false });
  const core = fs.realpathSync.native(path.join(packageRoot, 'extensions/amagi-core'));
  const { registry } = await jiti.import(path.join(core, 'task-registry.ts'));
  const { submitTaskKernel, getTaskKernel } = await jiti.import(path.join(core, 'task-service.ts'));
  const admission = await jiti.import(path.join(core, 'admission.ts'));
  const { cleanupChildrenOnShutdown } = await jiti.import(path.join(core, 'task-run.ts'));
  admission._setAdmissionCapacityForTest(1);
  assert.equal(admission.tryOccupy('busy-holder'), 'running');
  const ids = ['shutdown-waiting-1', 'shutdown-waiting-2'];
  for (const taskId of ids) {
    const result = await submitTaskKernel({ taskId, agent: 'luban', assignment: 'queued shutdown fixture', cwd: root, mode: 'background' });
    assert.equal(result.ok, true, result.message);
    assert.equal(admission.tryOccupy(taskId), 'queued');
  }
  const waits = ids.map(id => admission.waitForGrant(id));
  registry.setShuttingDown(true);
  await cleanupChildrenOnShutdown(10);
  admission.release('busy-holder');
  assert.deepEqual(await Promise.all(waits), ['cancelled', 'cancelled']);
  for (const taskId of ids) {
    const run = getTaskKernel().get(taskId)?.run;
    assert.equal(run?.execution, 'cancelled');
    assert.equal(run?.processState, 'exited');
    assert.equal(run?.launchIntent, undefined);
    const disk = JSON.parse(fs.readFileSync(path.join(root, 'v2-store', taskId, 'current.json')));
    assert.equal(disk.execution, 'cancelled');
    assert.equal(disk.processState, 'exited');
  }
  console.log(JSON.stringify({ passed: true, queuedTasks: ids.length, execution: 'cancelled', processState: 'exited', launchIntents: 0, liveStoreTouched: false }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
