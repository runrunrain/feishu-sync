import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseScopedProcesses, recoverOrphanDispatches, scanScopedProcesses } from '../src/agent/build-runtime/automatic-recovery.js';
import type { TerminationOutcome } from '../src/agent/build-runtime/contracts.js';
import { reconcileBuildRootResiduals } from '../src/agent/build-runtime/adapter.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-orphan-')); roots.push(buildRoot);
  const home = path.join(buildRoot, 'epochs/e2/home');
  const taskId = 'old-dispatch'; const dir = path.join(home, 'amagi/v2-store', taskId);
  fs.mkdirSync(dir, { recursive: true });
  const record = { version: 1, taskId, specId: taskId, ownerId: 'old-leader', execution: 'running',
    processState: 'not-started', stateSeq: 3, revision: 0, launchIntent: { nonce: 'old-nonce', at: 1 } };
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(record));
  const outcome: TerminationOutcome = { state: 'unconfirmed', at: '', leaderExit: null, note: 'missing anchor',
    children: [{ taskId, pid: 0, source: 'v2-store', verdict: 'unconfirmed', proof: 'none', detail: 'missing anchor' }] };
  const fence = vi.fn(() => true);
  return { buildId: 'build', buildRoot, homes: [home], outcome, fence, home, record, dir };
}

describe('application automatic orphan recovery', () => {
  it('matches exact private homes and their descendants, without exposing environments or touching unrelated processes', () => {
    const raw = '11 1 501 node PI_CODING_AGENT_DIR=/private/build/home SECRET=hidden\n'
      + '12 11 501 helper\n13 1 501 node PI_CODING_AGENT_DIR=/private/build/home-other\n'
      + '14 1 502 node PI_CODING_AGENT_DIR=/private/build/home\n15 1 501 rg /private/build/home';
    expect(parseScopedProcesses(raw, ['/private/build/home'], 501)).toEqual([
      { pid: 11, ppid: 1, uid: 501 }, { pid: 12, ppid: 11, uid: 501 },
    ]);
    expect(parseScopedProcesses('', ['/private/build/home'], 501)).toBeNull();
    expect(parseScopedProcesses('invalid output', ['/private/build/home'], 501)).toBeNull();
    // macOS pi process.title makes ps omit argv and environment entirely.
    expect(parseScopedProcesses('21 1 501 pi\n22 1 501 pi', ['/private/build/epochs/e2/home'], 501,
      new Map([[21, path.resolve('/private/build/epochs/e2/work')], [22, path.resolve('/private/build-other/epochs/e2/work')]])))
      .toEqual([{ pid: 21, ppid: 1, uid: 501 }]);
  });

  it('revokes old writes and retires missing-anchor records without human attestation or native success/exit mutation', async () => {
    const f = fixture(); const before = fs.readFileSync(path.join(f.dir, 'current.json'), 'utf8');
    const scan = vi.fn(async () => { expect(f.fence).toHaveBeenCalledOnce(); return []; });
    const result = await recoverOrphanDispatches(f, { scan, sleep: async () => {} });
    expect(result.state).toBe('confirmed'); expect(result.children[0]).toMatchObject({ verdict: 'abandoned', proof: 'scope-scan' });
    expect(scan).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(path.join(f.dir, 'current.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(f.dir, 'exit-attested.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(f.buildRoot, 'automatic-recovery.json'), 'utf8')))
      .toMatchObject({ physicalExitAsserted: false, taskIds: ['old-dispatch'] });
  });

  it('cleans only namespace processes whose birth identities still match', async () => {
    const f = fixture(); const scan = vi.fn().mockResolvedValueOnce([{ pid: 111, ppid: 1, uid: 501 }]).mockResolvedValue([]);
    const signal = vi.fn(); const birth = vi.fn(async () => new Map([[111, 'birth-1']]));
    const result = await recoverOrphanDispatches(f, { scan, signal, birth, sleep: async () => {} });
    expect(result.state).toBe('confirmed'); expect(signal).toHaveBeenCalledOnce(); expect(signal).toHaveBeenCalledWith(111, 'SIGTERM');
    const g = fixture(); const replaced = vi.fn().mockResolvedValueOnce(new Map([[111, 'old']])).mockResolvedValue(new Map([[111, 'new']]));
    signal.mockClear(); scan.mockClear().mockResolvedValueOnce([{ pid: 111, ppid: 1, uid: 501 }]).mockResolvedValue([]);
    await recoverOrphanDispatches(g, { scan, signal, birth: replaced, sleep: async () => {} });
    expect(signal).not.toHaveBeenCalled();
  });

  it('rechecks newly visible children and leaves technical failures retryable', async () => {
    const f = fixture(); const scan = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ pid: 222, ppid: 1, uid: 501 }]);
    expect((await recoverOrphanDispatches(f, { scan, sleep: async () => {} })).state).toBe('unconfirmed');
    expect((await recoverOrphanDispatches(f, { scan: async () => null })).state).toBe('unconfirmed');
    f.fence.mockReturnValue(false); scan.mockClear();
    expect((await recoverOrphanDispatches(f, { scan })).state).toBe('unconfirmed'); expect(scan).not.toHaveBeenCalled();
  });

  it('does not retire corrupt native records or a known live/unknown Leader', async () => {
    const f = fixture(); const scan = vi.fn(async () => []);
    f.outcome.children.push({ taskId: null, pid: 333, source: 'ledger', verdict: 'unconfirmed', proof: 'none', detail: 'Leader alive' });
    expect((await recoverOrphanDispatches(f, { scan })).state).toBe('unconfirmed'); expect(f.fence).not.toHaveBeenCalled();
    f.outcome.children.pop(); fs.writeFileSync(path.join(f.dir, 'current.json'), '{}');
    expect((await recoverOrphanDispatches(f, { scan })).state).toBe('unconfirmed'); expect(scan).not.toHaveBeenCalled();
  });

  it('the build-root recovery path clears an old anchorless intent using the application fence', async () => {
    const f = fixture();
    const result = await reconcileBuildRootResiduals({ buildId: f.buildId, buildRoot: f.buildRoot, binding: null }, {
      reap: true, fenceBuildCredentials: f.fence, recoveryDeps: { scan: async () => [], sleep: async () => {} },
    });
    expect(f.fence).toHaveBeenCalledOnce(); expect(result?.state).toBe('confirmed');
    expect(result?.children.find(child => child.taskId === 'old-dispatch')?.verdict).toBe('abandoned');
  });

  it('detects and reaps an actual renamed Pi process in the private workspace', async ctx => {
    if (!['darwin', 'linux'].includes(process.platform)) { ctx.skip(); return; }
    const f = fixture(); const work = path.join(path.dirname(f.home), 'work'); fs.mkdirSync(work);
    const child = spawn(process.execPath, ['-e', "process.title='pi'; process.send('ready'); setInterval(()=>{},1000)"],
      { cwd: work, env: { ...process.env, PI_CODING_AGENT_DIR: f.home }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const closed = once(child, 'exit');
    try {
      await once(child, 'message');
      expect(await scanScopedProcesses(f.homes)).toEqual(expect.arrayContaining([expect.objectContaining({ pid: child.pid })]));
      const result = await recoverOrphanDispatches(f);
      expect(result.state).toBe('confirmed'); expect(f.fence).toHaveBeenCalledOnce();
      expect((await closed)[1]).toBe('SIGTERM');
      expect(await scanScopedProcesses(f.homes)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 15_000);
});
