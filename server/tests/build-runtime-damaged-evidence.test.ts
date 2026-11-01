import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { reconcileBuildRootResiduals } from '../src/agent/build-runtime/adapter.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const taskId = '12345678-1234-4234-8234-123456789abc';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damaged-evidence-'));
  roots.push(root);
  const buildId = 'b_damage';
  const buildRoot = path.join(root, 'agent', 'builds', buildId);
  const home = path.join(buildRoot, 'epochs', 'e1', 'home');
  fs.mkdirSync(home, { recursive: true });
  return { root, buildId, buildRoot, home };
}
type Fixture = ReturnType<typeof fixture>;
function current(f: Fixture, value: unknown) {
  const dir = path.join(f.home, 'amagi', 'v2-store', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(value));
  return dir;
}
function anchor(f: Fixture, fields: Record<string, unknown>) {
  const dir = path.join(f.home, 'amagi', 'data', 'process-audits', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'launch-anchor.json'), JSON.stringify({ version: 1, taskId, runs: [{
    rootPid: 999999, pgid: 999999, leaderPid: 999998, at: 1, ...fields,
  }] }));
}
async function quiescence(f: Fixture) {
  const store = { getKbBuild: () => null, updateKbBuild: () => undefined } as never;
  return new KbBuildService({ dataRoot: f.root } as ConstructorParameters<typeof KbBuildService>[0])
    .shutdown(store, { timeoutMs: 100 });
}

describe('R2-F10-02 全层损坏事实不得产生退出证明（无进程/信号副作用）', () => {
  const damaged: Array<[string, (f: Fixture) => void]> = [
    ['epoch home为普通文件', f => { fs.rmdirSync(f.home); fs.writeFileSync(f.home, 'bad'); }],
    ['legacy home为普通文件', f => { fs.writeFileSync(path.join(f.buildRoot, 'home'), 'bad'); }],
    ['home为不可达link', f => { fs.rmdirSync(f.home); fs.symlinkSync(path.join(f.root, 'missing'), f.home); }],
    ['epochs为不可达link', f => { fs.rmSync(path.join(f.buildRoot, 'epochs'), { recursive: true }); fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.buildRoot, 'epochs')); }],
    ['UUID task位置为普通文件', f => { const dir = current(f, { execution: 'running', processState: 'alive' }); fs.rmSync(dir, { recursive: true }); fs.writeFileSync(dir, 'bad'); }],
    ['UUID task位置为不可达link', f => { const dir = current(f, { execution: 'running', processState: 'alive' }); fs.rmSync(dir, { recursive: true }); fs.symlinkSync(path.join(f.root, 'missing'), dir); }],
    ['v2-store根为不可达link', f => { const dir = path.join(f.home, 'amagi'); fs.mkdirSync(dir); fs.symlinkSync(path.join(f.root, 'missing'), path.join(dir, 'v2-store')); }],
    ['未知execution字符串', f => { current(f, { execution: 'corrupted-state', processState: 'alive' }); }],
    ['缺少必需processState', f => { current(f, { execution: 'done' }); }],
    ['未知processState字符串', f => { current(f, { execution: 'done', processState: 'corrupted' }); }],
    ['终态仍声明alive', f => { current(f, { execution: 'done', processState: 'alive' }); }],
    ['小数rootPid', f => { anchor(f, { rootPid: 999999.5 }); }],
    ['小数pgid', f => { anchor(f, { pgid: 999999.5 }); }],
    ['小数leaderPid', f => { anchor(f, { leaderPid: 999998.5 }); }],
    ['超范围PID', f => { anchor(f, { rootPid: 2147483648 }); }],
    ['非法时间字段', f => { anchor(f, { at: -1 }); }],
    ['bootId半缺', f => { anchor(f, { bootId: taskId }); }],
    ['bootTime半缺', f => { anchor(f, { bootTimeMs: 1 }); }],
    ['boot字段坏类型', f => { anchor(f, { bootId: 23, bootTimeMs: -1 }); }],
    ['boot时间为小数', f => { anchor(f, { bootId: taskId, bootTimeMs: 1.5 }); }],
    ['bootId非UUID', f => { anchor(f, { bootId: 'bad', bootTimeMs: 1 }); }],
    ['显式null pgid不是缺席', f => { anchor(f, { pgid: null }); }],
    ['显式null birth不是缺席', f => { anchor(f, { rootIdentityToken: null }); }],
  ];
  it.each(damaged)('%s：adapter与shutdown均不能confirmed', async (_name, damage) => {
    const f = fixture();
    damage(f);
    const outcome = await reconcileBuildRootResiduals({ buildId: f.buildId, buildRoot: f.buildRoot, binding: null });
    expect(outcome?.state).toBe('unconfirmed');
    expect((await quiescence(f)).quiesced).toBe(false);
  });

  it('真正缺省/空home允许确认', async () => {
    expect((await quiescence(fixture())).quiesced).toBe(true);
  });
  it('合法辅助文件不伪造任务意图', async () => {
    const f = fixture();
    const store = path.join(f.home, 'amagi', 'v2-store');
    fs.mkdirSync(store, { recursive: true });
    for (const name of ['README', 'README.md', '.DS_Store', '.gitkeep']) fs.writeFileSync(path.join(store, name), 'aux');
    expect((await quiescence(f)).quiesced).toBe(true);
  });
  it.each(['done', 'error', 'answered', 'cancelled', 'truncated', 'resolved-external'])('合法终态%s及exited保留正例', async execution => {
    const f = fixture();
    current(f, { execution, processState: 'exited' });
    expect((await quiescence(f)).quiesced).toBe(true);
  });
  it('合法整数PID确证退出正例', async () => {
    const f = fixture();
    anchor(f, {});
    expect((await quiescence(f)).quiesced).toBe(true);
  });
  it('合法Native boot字段成对保留正例', async () => {
    const f = fixture();
    anchor(f, { bootId: taskId, bootTimeMs: 1 });
    expect((await quiescence(f)).quiesced).toBe(true);
  });
  for (const execution of ['queued', 'running', 'done', 'blocked', 'error', 'answering', 'answered', 'cancelled', 'truncated', 'resolved-external']) {
    it.each(['not-started', 'alive', 'exited', 'unknown'])(`${execution}/%s：仅独立exited事实允许空锚点收口`, async processState => {
      const f = fixture();
      current(f, { execution, processState });
      expect((await quiescence(f)).quiesced).toBe(processState === 'exited');
    });
  }
});
