import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These tests exercise the REAL execLarkCli non-zero-exit error chain by
 * mocking only the deepest layer — `child_process.execFile`. Everything above
 * it (execLarkCli's catch block, extractUpstreamCode, classifyError) runs for
 * real. This is distinct from custom-folders.test.ts, whose getNode mock
 * throws a pre-built LarkCliError with upstreamCode already set, which hid the
 * bug where the real non-zero-exit path dropped the upstream code.
 */

// vi.hoisted runs before module imports are evaluated, so the mock factory can
// safely reference the holder.
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('child_process', () => ({ execFile: mocks.execFile }));

import {
  LARK_CLI_NOT_FOUND_MESSAGE,
  LarkCliClient,
  LarkCliError,
} from '../src/modules/lark-cli-client.js';

function makeClient(): LarkCliClient {
  return new LarkCliClient({
    requiredScopes: [],
    timeout: 5_000,
    // The binary is never actually run — execFile is mocked — so a placeholder
    // path is fine. NOTE: it MUST contain a path separator ("./…"): bare
    // command names are now intercepted pre-spawn by execLarkCli's not-found
    // fail-fast (see the P0-Win regression tests below), so a bare sentinel
    // would never reach the mocked execFile layer these tests exercise.
    larkCliPath: './lark-cli-not-invoked-by-these-tests',
  });
}

/**
 * Make the mocked execFile reject the way Node's execFile does on a non-zero
 * child exit: `util.promisify(execFile)` surfaces an Error whose `.stdout` /
 * `.stderr` / `.code` carry the captured process output. This is the REAL
 * failure shape that the execLarkCli catch block must handle.
 */
function rejectNonZero(stdout: string, stderr = '', exitCode = 1): void {
  mocks.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
    const err = new Error(`Command failed: lark-cli (exit ${exitCode})`);
    Object.assign(err, { code: exitCode, stdout, stderr });
    callback(err, stdout, stderr);
  });
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error('expected promise to reject'); },
    (e: unknown) => e,
  );
}

describe('execLarkCli non-zero-exit error chain (real path, no direct-throw mock)', () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  // Regression for the P0 bug: pure /docx/ cloud links failed to archive
  // because getNode's 131005 lost its upstreamCode on the non-zero-exit path,
  // so custom-folders.ts `upstreamCode === '131005'` was always false.
  it('preserves upstream code 131005 from a JSON error body on non-zero exit', async () => {
    // lark-cli --format json writes the structured API error to stdout then
    // exits non-zero. This is the real shape for "document is not in wiki".
    rejectNonZero('{"ok":false,"code":131005,"msg":"document is not in wiki"}');
    const client = makeClient();

    const error = (await captureRejection(client.getNode('https://feishu.cn/docx/objPureDoc'))) as LarkCliError;

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error.upstreamCode).toBe('131005');
    // The exact predicate custom-folders.ts uses to gate the pure-docx fallback.
    expect(error instanceof LarkCliError && error.upstreamCode === '131005').toBe(true);
  });

  it('recovers 131005 from stderr text when no JSON body is present (regex fallback)', async () => {
    rejectNonZero('', 'ERROR 131005: the document is not in wiki space');
    const client = makeClient();

    const error = (await captureRejection(client.getNode('https://feishu.cn/docx/objPureDoc2'))) as LarkCliError;

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error.upstreamCode).toBe('131005');
  });

  it('does NOT report 131005 for a permission error (fallback must not trigger)', async () => {
    rejectNonZero('{"ok":false,"code":40403,"msg":"forbidden"}');
    const client = makeClient();

    const error = (await captureRejection(client.getNode('https://feishu.cn/docx/objForbidden'))) as LarkCliError;

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error.code).toBe('permission');
    expect(error.upstreamCode).toBe('40403');
    // The custom-folders fallback predicate must be FALSE for permission errors.
    expect(error instanceof LarkCliError && error.upstreamCode === '131005').toBe(false);
  });

  it('leaves upstreamCode undefined for an unknown non-zero exit (no false code)', async () => {
    // No JSON, and "42" / "1" are not in the known code set.
    rejectNonZero('transient network blip, wrote 42 bytes');
    const client = makeClient();

    const error = (await captureRejection(client.getNode('https://feishu.cn/docx/objUnknown'))) as LarkCliError;

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error.upstreamCode).toBeUndefined();
    expect(error.code).toBe('upstream');
  });
});

// ---------------------------------------------------------------------------
// P0-Win 回归（2026-10 实测事故）：未安装 lark-cli 的 Windows 机器上报
// 「认证检查失败：lark-cli 执行失败：'lark-cli.cmd' 不是内部或外部命令…」。
// 根因：win32 下 execFile 以 shell:true 启动，命令不存在时 cmd.exe 自己
// exit 1 + 本地化文案（GBK 环境下乱码），Node 不抛 ENOENT → 唯一的未找到
// 分类器不命中 → 通用「执行失败」且 retryable → getToolStatus 的未安装
// 正则也匹配不到 → larkCliInstalled 误判为 true，「一键安装」面板不出现。
// ---------------------------------------------------------------------------
describe('execLarkCli not-installed classification (P0-Win regression)', () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it('fails fast before spawn when resolution yields a bare command name', async () => {
    // 裸哨兵名（无路径分隔符）：PATH 与全部发现目录必未命中，模拟
    // 「未安装任何 lark-cli」的机器。确定性拦截：不 spawn、不依赖本地化文本。
    const client = new LarkCliClient({
      requiredScopes: [],
      timeout: 5_000,
      larkCliPath: 'lark-cli-missing-everywhere',
    });

    const error = (await captureRejection(client.execute(['--version'], 'auth'))) as LarkCliError;

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error.message).toBe(LARK_CLI_NOT_FOUND_MESSAGE);
    expect(error.retryable).toBe(false);
    // 未找到时绝不能碰真实子进程（否则真实机器上会真的去 spawn）。
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('classifies cmd.exe localized command-not-found stderr as 未找到 (non-retryable)', async () => {
    // 用户实测原文形态（部分中文 Windows 下 stderr 解码后即此文本；
    // GBK 乱码场景由上方 fail-fast 兕底，不依赖文本匹配）。
    rejectNonZero(
      '',
      "'lark-cli.cmd' 不是内部或外部命令，也不是可运行的程序或批处理文件。",
    );
    const client = makeClient();

    const error = (await captureRejection(client.execute(['--version'], 'auth'))) as LarkCliError;

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error.message).toBe(LARK_CLI_NOT_FOUND_MESSAGE);
    expect(error.retryable).toBe(false);
  });

  it('classifies English cmd.exe not-recognized stderr as 未找到', async () => {
    rejectNonZero(
      '',
      "'lark-cli.cmd' is not recognized as an internal or external command, operable program or batch file.",
    );
    const client = makeClient();

    const error = (await captureRejection(client.execute(['--version'], 'auth'))) as LarkCliError;

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error.message).toBe(LARK_CLI_NOT_FOUND_MESSAGE);
  });

  it('classifies 系统找不到指定的路径 for an explicit but missing configured path', async () => {
    // 显式路径配置指向不存在的文件：绕过裸名 fail-fast，靠 catch 分支的
    // 文本兕底归类为未找到（引导用户回「设置」修正路径）。
    rejectNonZero('', '系统找不到指定的路径。');
    const client = makeClient();

    const error = (await captureRejection(client.execute(['--version'], 'auth'))) as LarkCliError;

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error.message).toBe(LARK_CLI_NOT_FOUND_MESSAGE);
    expect(error.retryable).toBe(false);
  });

  it('checkAuthReady passes the not-found message through without 认证检查失败 prefix', async () => {
    // 端到端：未安装 → execute 抛未找到 → checkAuthReady 透传 →
    // getToolStatus（lark-cli-manager）的 /未安装|未找到/ 正则点亮
    // larkCliInstalled=false → 前端出现「一键安装」面板。
    const client = new LarkCliClient({
      requiredScopes: [],
      timeout: 5_000,
      larkCliPath: 'lark-cli-missing-everywhere',
    });

    const readiness = await client.checkAuthReady();

    expect(readiness.ready).toBe(false);
    expect(readiness.error).toBe(LARK_CLI_NOT_FOUND_MESSAGE);
    // 与 getToolStatus 的 notInstalledHint 同源判定，防止文案漂移后误判。
    expect(/(?:未安装|未找到|not installed|not found|ENOENT)/i.test(readiness.error ?? '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0 回归二（2026-10 实测）：用户手动装好 lark-cli 后重新检测，auth status
// 以非零退出 + {type:'config',subtype:'not_configured'} JSON 体报告未初始
// 配置。旧代码：① classifyError 无此分支 → 落通用「lark-cli 执行失败：…」
// （retryable）；② checkAuthReady 的 catch 丢失已拿到的 larkCliVersion →
// getToolStatus 拿不到版本，前端无法显示已安装版本。
// ---------------------------------------------------------------------------
const NOT_CONFIGURED_JSON =
  '{ "ok": false, "error": { "type": "config", "subtype": "not_configured", "message": "not configured", "hint": "run `lark-cli config init --new` in the background. It blocks and outputs a verification URL — retrieve the URL and open it in a browser to complete setup." } }';

describe('execLarkCli config/not_configured classification (P0 regression)', () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it('classifies auth status not_configured as a non-retryable setup guidance error', async () => {
    rejectNonZero('', NOT_CONFIGURED_JSON);
    const client = makeClient();

    const error = (await captureRejection(client.execute(['auth', 'status'], 'auth'))) as LarkCliError;

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error.code).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('尚未完成初始配置');
    expect(error.message).toContain('config init');
  });

  it('checkAuthReady keeps larkCliVersion and surfaces setup guidance when not configured', async () => {
    // 端到端（真实 execLarkCli 链，仅 mock 最底层 execFile）：
    // 第 1 次 --version 成功，第 2 次 auth status 非零退出 + not_configured。
    // mock 的 vi.fn() 没有真实 execFile 的 promisify.custom 符号，通用
    // promisify 只取回调首参：成功路径必须直接 resolve {stdout, stderr}。
    let call = 0;
    mocks.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (...cbArgs: unknown[]) => void;
      call += 1;
      if (call === 1) {
        callback(null, { stdout: 'lark-cli 1.2.3\n', stderr: '' });
        return;
      }
      const err = new Error('Command failed: lark-cli.cmd auth status');
      Object.assign(err, { code: 1, stdout: '', stderr: NOT_CONFIGURED_JSON });
      callback(err, '', NOT_CONFIGURED_JSON);
    });
    const client = makeClient();

    const readiness = await client.checkAuthReady();

    expect(readiness.ready).toBe(false);
    expect(readiness.error).toContain('尚未完成初始配置');
    // 版本不能随 catch 丢失：前端据此显示已安装版本，getToolStatus 据此
    // 判定 larkCliInstalled=true。
    expect(readiness.larkCliVersion).toBe('lark-cli 1.2.3');
    // notInstalledHint 正则不得误命中（「已安装」≠「未安装」）。
    expect(/(?:未安装|未找到)/.test(readiness.error ?? '')).toBe(false);
  });
});
