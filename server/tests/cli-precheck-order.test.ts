/**
 * CLI 本地预检前置（D 项）+ --timeout（H 项）+ --version（F 项）。
 *
 * 预检顺序契约：parseInvocation → buildCommandArgs → request 评估 →
 * confirm 预检全部在端点发现/探活之前——应用未运行（无 endpoint.json）
 * 时：参数错误返回 2、缺 --yes 返回 4；本地预检通过后才进入端点发现
 * （返回 3）。全部进程内 runCli，FEISHU_SYNC_HOME 隔离为空临时目录。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInvocation, UsageError } from '../src/cli/args.js';
import { runCli } from '../src/cli/cli-app.js';

let home: string;
let previousHome: string | undefined;

beforeAll(() => {
  previousHome = process.env.FEISHU_SYNC_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-cli-precheck-'));
  process.env.FEISHU_SYNC_HOME = home; // 空目录：无 run/endpoint.json → 应用未运行
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.FEISHU_SYNC_HOME;
  else process.env.FEISHU_SYNC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** 捕获 runCli 输出（stdout+stderr 合并；本地预检不发起网络请求）。 */
async function runCapture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
  try {
    const code = await runCli(argv);
    return { code, out: chunks.join('') };
  } finally {
    (process.stdout as unknown as { write: (s: string) => boolean }).write = origOut;
    (process.stderr as unknown as { write: (s: string) => boolean }).write = origErr;
  }
}

describe('预检前置（应用未运行：无 endpoint.json）', () => {
  it('缺 --yes → 退出码 4（confirm 预检不依赖应用运行）', async () => {
    const run = await runCapture(['kb', 'build']);
    expect(run.code).toBe(4);
    expect(run.out).toContain('confirmation_required');
    expect(run.out).toContain('BUILD');
  });

  it('参数错误 → 退出码 2（先于端点发现）', async () => {
    const badParam = await runCapture(['kb', 'builds', '--limit', 'abc']);
    expect(badParam.code).toBe(2);
    const missingRequired = await runCapture(['auth', 'login', 'complete']);
    expect(missingRequired.code).toBe(2);
  });

  it('表内 request 校验错误（禁止路径）→ 退出码 2', async () => {
    const run = await runCapture(['config', 'set', 'cli.enabled', 'true']);
    expect(run.code).toBe(2);
    expect(run.out).toContain('forbidden_path');
  });

  it('destructive/remote_write 同样前置（cloud revert / source push）', async () => {
    expect((await runCapture(['cloud', 'revert', 'doxcnX', '2048'])).code).toBe(4);
    expect((await runCapture(['source', 'push', 'doxcnX'])).code).toBe(4);
  });

  it('本地预检通过后才进入端点发现 → 退出码 3', async () => {
    const run = await runCapture(['status']);
    expect(run.code).toBe(3);
    expect(run.out).toContain('app_not_running');
  });

  it('read 级命令不做 confirm 预检（无 --yes 也走到端点发现）', async () => {
    const run = await runCapture(['cloud', 'move_status', 'mv_1']);
    expect(run.code).toBe(3);
  });

  it('--json 模式下预检错误仍走包络输出', async () => {
    const run = await runCapture(['--json', 'kb', 'build']);
    expect(run.code).toBe(4);
    const envelope = JSON.parse(run.out.slice(run.out.indexOf('{')));
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('confirmation_required');
  });
});

describe('--timeout 全局旗标（H 项）', () => {
  it('合法值解析（独立与 = 形态、小数）', () => {
    expect(parseInvocation(['--timeout', '30', 'status']).flags.timeoutSec).toBe(30);
    expect(parseInvocation(['status', '--timeout=0.5']).flags.timeoutSec).toBe(0.5);
    expect(parseInvocation(['status']).flags.timeoutSec).toBeUndefined();
  });

  it('非法值 → 用法错误', () => {
    expect(() => parseInvocation(['--timeout', 'abc', 'status'])).toThrowError(UsageError);
    expect(() => parseInvocation(['--timeout', '0', 'status'])).toThrowError(UsageError);
    expect(() => parseInvocation(['--timeout', '-5', 'status'])).toThrowError(UsageError);
    expect(() => parseInvocation(['--timeout'])).toThrowError(UsageError);
  });

  it('runCli 层：--timeout 非法值 → 退出码 2', async () => {
    const run = await runCapture(['--timeout', 'nope', 'status']);
    expect(run.code).toBe(2);
    expect(run.out).toContain('--timeout');
  });
});

describe('--version（F 项：tsx/ESM 非打包形态）', () => {
  it('读出应用版本号（仓库根 package.json），不再 unknown', async () => {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    const run = await runCapture(['--version']);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`v${pkg.version}`);
    expect(run.out).not.toContain('unknown');
  });
});
