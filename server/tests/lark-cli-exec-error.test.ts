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

import { LarkCliClient, LarkCliError } from '../src/modules/lark-cli-client.js';

function makeClient(): LarkCliClient {
  return new LarkCliClient({
    requiredScopes: [],
    timeout: 5_000,
    // The binary is never actually run — execFile is mocked — so a placeholder
    // path is fine and matches the convention in lark-cli-client.test.ts.
    larkCliPath: 'lark-cli-not-invoked-by-these-tests',
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
