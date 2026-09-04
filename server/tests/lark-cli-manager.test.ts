/**
 * LarkCliManager + feishu device-auth routes tests
 *
 * 覆盖（需求 §5）：
 * - npm 不可用分支（installOrUpdateLarkCli → npm_not_found，不 spawn）
 * - install 成功 + `--version` 验证；npm 失败分类
 * - startDeviceAuth JSON 容错解析（日志前缀 / 尾随杂行）
 * - completeDeviceAuth deviceCode 校验（不 spawn 子进程）
 * - 单例进行中标记：重复 start 返回 409 语义冲突；complete 后清除
 * - complete 绕过 LarkCliClient 串行队列（直接 execFile）+ 超时契约
 * - 路由层关键路径（status / install npm_not_found / start 409 / complete 400）
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Hono } = require('hono');

// ---------------------------------------------------------------------------
// child_process mock：promisify 兼容（callback 最后一位），handler 可逐用例注入
// ---------------------------------------------------------------------------

type ExecHandlerResult = {
  error?: Error | null;
  stdout?: string;
  stderr?: string;
};

const { execFileMock, setExecHandler } = vi.hoisted(() => {
  type Handler = (file: string, args: string[]) => ExecHandlerResult;
  let handler: Handler = () => ({ stdout: '' });
  return {
    execFileMock: vi.fn(
      (
        file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        Promise.resolve()
          .then(() => handler(file, args))
          .then((result) => {
            callback(result?.error ?? null, {
              stdout: result?.stdout ?? '',
              stderr: result?.stderr ?? '',
            });
          })
          .catch((error) => callback(error as Error));
      },
    ),
    setExecHandler: (next: Handler) => {
      handler = next;
    },
  };
});

vi.mock('child_process', () => ({ execFile: execFileMock }));

import {
  LarkCliManager,
  LarkCliManagerError,
  parseLenientDeviceAuthJson,
} from '../src/modules/lark-cli-manager.js';
import { feishuRoutes } from '../src/routes/feishu.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function makeBinDir(withNpm: boolean, withLarkCli = false): string {
  const binDir = path.join(tmpRoot, withNpm ? 'bin' : 'empty-bin');
  fs.mkdirSync(binDir, { recursive: true });
  if (withNpm) {
    fs.writeFileSync(path.join(binDir, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
  }
  if (withLarkCli) {
    fs.writeFileSync(path.join(binDir, 'lark-cli'), '#!/usr/bin/env node\n', { mode: 0o755 });
  }
  return binDir;
}

function createManager(options: {
  binDir?: string;
  authReadiness?: Record<string, unknown>;
  config?: Record<string, unknown>;
} = {}) {
  const client = {
    checkAuthReady: vi.fn(
      async () =>
        options.authReadiness ?? {
          ready: false,
          error: '未认证，请执行 lark-cli auth login',
        },
    ),
  };
  const config = {
    requiredScopes: ['wiki:node:retrieve', 'offline_access'],
    ...options.config,
  };
  const configManager = {
    getConfig: vi.fn(() => config),
    load: vi.fn(async () => config),
  };
  const manager = new LarkCliManager(client, configManager, {
    platform: 'darwin',
    env: { PATH: options.binDir ?? path.join(tmpRoot, 'empty-bin') },
    homeDir: tmpRoot,
  });
  return { manager, client, configManager };
}

describe('getToolStatus latest version query', () => {
  it('surfaces latestLarkCliVersion from npm view and soft-fails to undefined', async () => {
    const binDir = makeBinDir(true);
    const client = {
      checkAuthReady: vi.fn(async () => ({
        ready: true,
        larkCliVersion: 'lark-cli version 1.0.89',
      })),
    };
    const configManager = {
      getConfig: vi.fn(() => ({ requiredScopes: ['offline_access'] })),
      load: vi.fn(async () => ({ requiredScopes: ['offline_access'] })),
    };
    const manager = new LarkCliManager(client, configManager, {
      platform: 'darwin',
      env: { PATH: binDir },
      homeDir: tmpRoot,
    });

    // 1. npm view 成功：输出裸版本号
    setExecHandler((file, args) => {
      if (args.includes('view')) return { stdout: '1.0.93\n', stderr: '' };
      throw new Error(`unexpected call: ${file} ${args.join(' ')}`);
    });
    const ok = await manager.getToolStatus();
    expect(ok.larkCliVersion).toBe('lark-cli version 1.0.89');
    expect(ok.latestLarkCliVersion).toBe('1.0.93');

    // 2. npm view 失败（网络/registry）：软缺省，不影响状态
    setExecHandler((file, args) => {
      if (args.includes('view')) {
        const error = new Error('Command failed: npm view') as Error & { stderr: string };
        error.stderr = 'network unreachable';
        return { error };
      }
      throw new Error(`unexpected call: ${file} ${args.join(' ')}`);
    });
    const degraded = await manager.getToolStatus();
    expect(degraded.latestLarkCliVersion).toBeUndefined();
    expect(degraded.larkCliInstalled).toBe(true);
  });
});

const DEVICE_AUTH_JSON =
  '{"device_code":"dc-123","expires_in":600,"verification_url":"https://open.feishu.cn/device-verify?dc=dc-123","hint":"agent instructions, ignore"}';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-lark-cli-manager-'));
  vi.clearAllMocks();
  setExecHandler(() => ({ error: new Error('unexpected execFile call'), stdout: '' }));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseLenientDeviceAuthJson
// ---------------------------------------------------------------------------

describe('parseLenientDeviceAuthJson', () => {
  it('parses JSON with log prefix, ANSI codes and trailing junk', () => {
    const raw = '\u001b[32mINFO starting device flow\u001b[0m\n'
      + DEVICE_AUTH_JSON
      + '\nprogress: done';
    expect(parseLenientDeviceAuthJson(raw)).toMatchObject({
      device_code: 'dc-123',
      expires_in: 600,
      verification_url: 'https://open.feishu.cn/device-verify?dc=dc-123',
    });
  });

  it('rejects output without any JSON object', () => {
    try {
      parseLenientDeviceAuthJson('纯文本输出，没有 JSON');
      throw new Error('expected parse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LarkCliManagerError);
      expect((error as LarkCliManagerError).code).toBe('parse_failed');
    }
  });
});

// ---------------------------------------------------------------------------
// installOrUpdateLarkCli
// ---------------------------------------------------------------------------

describe('installOrUpdateLarkCli', () => {
  it('E2BIG 回归：fnm multishells 累积海量目录时 env PATH 受限且以 npm 目录开头', async () => {
    // 2026-09 实测事故：重度用户机器上 fnm_multishells 累积 15 万个目录，
    // 全量拼入 PATH → spawn E2BIG，npm 更新永远失败。
    const binDir = makeBinDir(true);

    // 伪造 200 个 multishell 目录 + 差异化 mtime（旧→新）。
    const multiDir = path.join(tmpRoot, '.local', 'state', 'fnm_multishells');
    fs.mkdirSync(multiDir, { recursive: true });
    for (let i = 0; i < 200; i += 1) {
      const shellDir = path.join(multiDir, `shell_${String(i).padStart(4, '0')}`);
      fs.mkdirSync(shellDir, { recursive: true });
      const stamp = new Date(Date.now() - (200 - i) * 60_000);
      fs.utimesSync(shellDir, stamp, stamp);
    }

    const client = { checkAuthReady: vi.fn(async () => ({ ready: true })) };
    const configManager = {
      getConfig: vi.fn(() => ({ requiredScopes: ['offline_access'] })),
      load: vi.fn(async () => ({ requiredScopes: ['offline_access'] })),
    };
    const manager = new LarkCliManager(client, configManager, {
      platform: 'darwin',
      env: { PATH: binDir },
      homeDir: tmpRoot,
    });

    setExecHandler((_file, args) => {
      if (args.includes('install')) return { stdout: 'added 1 package in 1s', stderr: '' };
      if (args[0] === '--version') return { stdout: 'lark-cli/2.3.4\n' };
      return { stdout: '' };
    });

    const result = await manager.installOrUpdateLarkCli();
    expect(result.ok).toBe(true);

    // 捕获 npm install 的 env：PATH 必须以 npm 所在目录开头且总长受限。
    const installCall = execFileMock.mock.calls.find((call) =>
      (call[1] as string[]).includes('install'),
    ) as unknown as [string, string[], { env?: { PATH?: string } }] | undefined;
    expect(installCall).toBeDefined();
    const envPath = installCall![2]?.env?.PATH ?? '';
    expect(envPath.startsWith(binDir)).toBe(true);
    expect(envPath.length).toBeLessThan(5_000);
    // 注入段绝不能包含海量 multishell：最多允许限量后的少数几个。
    const multishellEntries = envPath
      .split(path.delimiter)
      .filter((entry) => entry.includes('fnm_multishells'));
    expect(multishellEntries.length).toBeLessThanOrEqual(8);
  });

  it('win32 regression: npm path with spaces is shell-quoted (C:\\Program\\...\\npm.cmd)', async () => {
    // 2026-09 Win 实测：spawn(shell:true) 裸拼含空格路径，cmd.exe 把
    // `C:\Program` 当命令 → 「不是内部或外部命令」→ npm_failed。
    const spacedDir = path.join(tmpRoot, 'Program Files', 'nodejs');
    fs.mkdirSync(spacedDir, { recursive: true });
    fs.writeFileSync(path.join(spacedDir, 'npm.cmd'), '@echo off\n', { mode: 0o755 });

    const client = { checkAuthReady: vi.fn(async () => ({ ready: true })) };
    const configManager = {
      getConfig: vi.fn(() => ({ requiredScopes: ['offline_access'] })),
      load: vi.fn(async () => ({ requiredScopes: ['offline_access'] })),
    };
    const manager = new LarkCliManager(client, configManager, {
      platform: 'win32',
      env: { PATH: spacedDir },
      homeDir: tmpRoot,
    });

    setExecHandler((_file, args) => {
      if (args.includes('install')) return { stdout: 'added 1 package in 1s', stderr: '' };
      if (args[0] === '--version') return { stdout: 'lark-cli/2.3.4\n' };
      return { stdout: '' };
    });

    const result = await manager.installOrUpdateLarkCli();
    expect(result.ok).toBe(true);

    const installCall = execFileMock.mock.calls.find((call) =>
      (call[1] as string[]).includes('install'),
    ) as unknown as [string] | undefined;
    expect(installCall).toBeDefined();
    // 关键断言：file 已被双引号包裹，cmd.exe 不再把 `C:\Program` 拆成命令。
    expect(installCall![0]).toBe(`"${path.join(spacedDir, 'npm.cmd')}"`);
  });

  it('returns npm_not_found without spawning when npm is unavailable', async () => {
    const binDir = makeBinDir(false);
    const { manager } = createManager({ binDir });

    const result = await manager.installOrUpdateLarkCli();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('npm_not_found');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('installs via execFile argument array and verifies the installed version', async () => {
    const binDir = makeBinDir(true);
    const { manager } = createManager({ binDir });
    setExecHandler((_file, args) => {
      if (args.includes('install')) return { stdout: 'added 1 package in 2s', stderr: 'npm warn deprecated' };
      if (args[0] === '--version') return { stdout: 'lark-cli/2.3.4\n' };
      return { error: new Error(`unexpected args: ${args.join(' ')}`) };
    });

    const result = await manager.installOrUpdateLarkCli();

    expect(result.ok).toBe(true);
    expect(result.version).toBe('lark-cli/2.3.4');
    expect(result.output).toContain('added 1 package');
    // 安全红线：execFile + 参数数组（绝无 shell 字符串拼接）
    expect(execFileMock).toHaveBeenCalledWith(
      path.join(binDir, 'npm'),
      ['install', '-g', '@larksuite/cli@latest'],
      expect.objectContaining({ timeout: 5 * 60_000 }),
      expect.any(Function),
    );
  });

  it('classifies npm failure and verify failure distinctly', async () => {
    const binDir = makeBinDir(true);

    // npm 本身失败（非零退出码 → execFile error 携带 stderr）
    const failing = createManager({ binDir });
    setExecHandler((_file, args) => {
      if (args.includes('install')) {
        const error = new Error('Command failed: npm install -g @larksuite/cli@latest') as Error & {
          stderr: string;
        };
        error.stderr = 'EACCES: permission denied';
        return { error };
      }
      return { stdout: '' };
    });
    const npmFailed = await failing.manager.installOrUpdateLarkCli();
    expect(npmFailed.ok).toBe(false);
    expect(npmFailed.reason).toBe('npm_failed');
    expect(npmFailed.output).toContain('EACCES');

    // npm 成功但 lark-cli --version 验证失败
    const unverifiable = createManager({ binDir });
    setExecHandler((_file, args) => {
      if (args.includes('install')) return { stdout: 'added 1 package' };
      if (args[0] === '--version') return { error: new Error('spawn lark-cli ENOENT') };
      return { stdout: '' };
    });
    const verifyFailed = await unverifiable.manager.installOrUpdateLarkCli();
    expect(verifyFailed.ok).toBe(false);
    expect(verifyFailed.reason).toBe('verify_failed');
  });
});

// ---------------------------------------------------------------------------
// startDeviceAuth / completeDeviceAuth
// ---------------------------------------------------------------------------

describe('device auth flow', () => {
  it('starts with configured scopes and parses the no-wait JSON leniently', async () => {
    const { manager } = createManager();
    setExecHandler((_file, args) => {
      if (args.includes('--no-wait')) {
        return {
          stdout: `INFO device flow initiated\n${DEVICE_AUTH_JSON}\nhint-line`,
          stderr: '',
        };
      }
      return { error: new Error(`unexpected args: ${args.join(' ')}`) };
    });

    const session = await manager.startDeviceAuth();

    expect(session).toEqual({
      deviceCode: 'dc-123',
      verificationUrl: 'https://open.feishu.cn/device-verify?dc=dc-123',
      expiresIn: 600,
    });
    expect(execFileMock).toHaveBeenCalledWith(
      expect.any(String),
      ['auth', 'login', '--no-wait', '--json', '--scope', 'wiki:node:retrieve offline_access'],
      expect.anything(),
      expect.any(Function),
    );
    expect(manager.hasPendingDeviceAuth()).toBe(true);
  });

  it('falls back to DEFAULT_REQUIRED_SCOPES when config has none', async () => {
    const binDir = makeBinDir(true);
    const { manager } = createManager({
      binDir,
      config: { requiredScopes: [] },
    });
    // getConfig 返回空 scopes → load 同样空 → DEFAULT（9 项）
    setExecHandler((_file, args) => {
      if (args.includes('--no-wait')) return { stdout: DEVICE_AUTH_JSON };
      return { error: new Error('unexpected') };
    });

    await manager.startDeviceAuth();

    const scopeArg = execFileMock.mock.calls[0][1].at(-1) as string;
    expect(scopeArg.split(' ')).toContain('wiki:node:retrieve');
    expect(scopeArg.split(' ')).toContain('offline_access');
    // 2026-10：docs:document:read 已在上游失效（带上即整单被拒），从
    // DEFAULT 需求集退役；docx:document:readonly 始终有效。
    expect(scopeArg.split(' ')).not.toContain('docs:document:read');
    expect(scopeArg.split(' ')).toContain('docx:document:readonly');
    expect(scopeArg.split(' ')).toHaveLength(9);
  });

  it('filters retired scopes from a config that still carries them (2026-10 upstream invalidation)', async () => {
    const binDir = makeBinDir(true);
    // 手改配置/旧进程缓存回灌场景：requiredScopes 仍带已退役名字。
    const { manager } = createManager({
      binDir,
      config: {
        requiredScopes: ['wiki:node:retrieve', 'docs:document:read', 'offline_access'],
      },
    });
    setExecHandler((_file, args) => {
      if (args.includes('--no-wait')) return { stdout: DEVICE_AUTH_JSON };
      return { error: new Error('unexpected') };
    });

    await manager.startDeviceAuth();

    const scopeArg = execFileMock.mock.calls[0][1].at(-1) as string;
    expect(scopeArg.split(' ')).toEqual(['wiki:node:retrieve', 'offline_access']);
  });

  it('requests the union of granted and required scopes (preserve existing grants, 2026-09-04)', async () => {
    const binDir = makeBinDir(true);
    // 用户案例：已授权 46 项里缺 sheets/slides；重授权必须并集而非最小集，
    // 否则 token 被降级，破坏其他 lark-cli 工作流。
    const { manager } = createManager({
      binDir,
      authReadiness: {
        ready: false,
        currentScopes: [
          'im:chat:read',
          'docx:document:readonly',
          // 旧 token 里的已退役名：不能混进请求集，否则整单被拒。
          'docs:document:read',
          'wiki:node:retrieve',
        ],
        missingScopes: ['offline_access'],
      },
    });
    setExecHandler((_file, args) => {
      if (args.includes('--no-wait')) return { stdout: DEVICE_AUTH_JSON };
      return { error: new Error('unexpected') };
    });

    await manager.startDeviceAuth();

    const scopeArg = execFileMock.mock.calls[0][1].at(-1) as string;
    expect(scopeArg.split(' ')).toEqual([
      'im:chat:read',
      'docx:document:readonly',
      'wiki:node:retrieve',
      'offline_access',
    ]);
    expect(scopeArg.split(' ')).not.toContain('docs:document:read');
  });

  it('falls back to the minimal required set when the union request is rejected as invalid scopes', async () => {
    const binDir = makeBinDir(true);
    const { manager } = createManager({
      binDir,
      authReadiness: {
        ready: false,
        currentScopes: ['im:chat:read'],
        missingScopes: ['offline_access'],
      },
    });
    setExecHandler((_file, args) => {
      if (!args.includes('--no-wait')) return { error: new Error('unexpected') };
      const scopeArg = args.at(-1) as string;
      // 并集请求（含 im:chat:read）被上游整单拒绝：exit 0 + 错误 JSON。
      if (scopeArg.includes('im:chat:read')) {
        return {
          stdout: JSON.stringify({
            ok: false,
            error: {
              type: 'authentication',
              message: 'device authorization failed: Device authorization failed: The provided scope list contains invalid or malformed scopes. Please ensure all scopes are valid.',
            },
          }),
        };
      }
      return { stdout: DEVICE_AUTH_JSON };
    });

    const session = await manager.startDeviceAuth();

    expect(session.deviceCode).toBe('dc-123');
    expect(execFileMock).toHaveBeenCalledTimes(2);
    const secondScopeArg = execFileMock.mock.calls[1][1].at(-1) as string;
    expect(secondScopeArg).toBe('wiki:node:retrieve offline_access');
  });

  it('surfaces the upstream error message instead of the misleading missing-device_code fallback', async () => {
    const binDir = makeBinDir(true);
    const { manager } = createManager({ binDir });
    setExecHandler((_file, args) => {
      if (args.includes('--no-wait')) {
        return {
          stdout: JSON.stringify({
            ok: false,
            error: { type: 'authentication', message: 'device authorization failed: boom' },
          }),
        };
      }
      return { error: new Error('unexpected') };
    });

    await expect(manager.startDeviceAuth()).rejects.toMatchObject({
      code: 'device_auth_start_failed',
      message: expect.stringContaining('boom'),
    });
    expect(manager.hasPendingDeviceAuth()).toBe(false);
  });

  it('rejects a second start while a flow is pending (409), and clears after complete', async () => {
    const { manager, client } = createManager();
    setExecHandler((_file, args) => {
      if (args.includes('--no-wait')) return { stdout: DEVICE_AUTH_JSON };
      if (args.includes('--device-code')) return { stdout: 'authorized' };
      return { error: new Error('unexpected') };
    });

    await manager.startDeviceAuth();

    // 进行中：重复 start → 409 语义冲突，且不再 spawn 子进程
    const callsBefore = execFileMock.mock.calls.length;
    await expect(manager.startDeviceAuth()).rejects.toMatchObject({
      code: 'device_auth_in_progress',
      status: 409,
    });
    expect(execFileMock.mock.calls.length).toBe(callsBefore);

    // complete 成功 → 清除标记
    client.checkAuthReady.mockResolvedValue({
      ready: true,
      larkCliVersion: 'lark-cli/2.3.4',
      currentScopes: ['wiki:node:retrieve'],
      missingScopes: [],
    });
    const result = await manager.completeDeviceAuth('dc-123');
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(manager.hasPendingDeviceAuth()).toBe(false);

    // 清除后可再次 start
    await expect(manager.startDeviceAuth()).resolves.toMatchObject({ deviceCode: 'dc-123' });
  });

  it('validates deviceCode before spawning anything', async () => {
    const { manager } = createManager();

    await expect(manager.completeDeviceAuth('')).rejects.toMatchObject({
      code: 'invalid_device_code',
      status: 400,
    });
    await expect(manager.completeDeviceAuth('x'.repeat(500))).rejects.toMatchObject({
      code: 'invalid_device_code',
      status: 400,
    });
    await expect(manager.completeDeviceAuth(42 as never)).rejects.toMatchObject({
      code: 'invalid_device_code',
      status: 400,
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('completes via direct execFile (bypassing the client queue) with an 11-minute timeout', async () => {
    const { manager, client } = createManager();
    const clientExecute = vi.fn(); // 若误走 LarkCliClient 队列会暴露（此处 client 根本没有 execute）
    void clientExecute;
    setExecHandler((_file, args) => {
      if (args.includes('--no-wait')) return { stdout: DEVICE_AUTH_JSON };
      if (args.includes('--device-code')) return { stdout: 'authorized', stderr: '' };
      return { error: new Error('unexpected') };
    });

    await manager.startDeviceAuth();
    // startDeviceAuth 也会调一次 checkAuthReady（2026-09-04 并集重授权探测
    // granted scope）；这里记录基线，验证 complete 只额外再核对一次。
    const callsAfterStart = client.checkAuthReady.mock.calls.length;
    client.checkAuthReady.mockResolvedValue({
      ready: true,
      missingScopes: [],
      currentScopes: ['wiki:node:retrieve', 'offline_access'],
    });

    const result = await manager.completeDeviceAuth('dc-123');

    expect(result).toMatchObject({ ok: true, ready: true, missingScopes: [] });
    expect(execFileMock).toHaveBeenCalledWith(
      expect.any(String),
      ['auth', 'login', '--device-code', 'dc-123'],
      expect.objectContaining({ timeout: 11 * 60_000 }),
      expect.any(Function),
    );
    // 最终就绪状态经 checkAuthReady 汇报（含 missingScopes 如实返回）
    expect(client.checkAuthReady).toHaveBeenCalledTimes(callsAfterStart + 1);
  });

  it('reports flow failure with the final readiness state and clears pending', async () => {
    const { manager, client } = createManager();
    setExecHandler((_file, args) => {
      if (args.includes('--no-wait')) return { stdout: DEVICE_AUTH_JSON };
      if (args.includes('--device-code')) {
        const error = new Error('device code expired') as Error & { stderr: string };
        error.stderr = 'verification expired after 600s';
        return { error };
      }
      return { error: new Error('unexpected') };
    });

    await manager.startDeviceAuth();
    client.checkAuthReady.mockResolvedValue({
      ready: false,
      error: '未认证，请执行 lark-cli auth login',
      missingScopes: ['wiki:node:retrieve', 'offline_access'],
    });

    const result = await manager.completeDeviceAuth('dc-123');

    expect(result.ok).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.error).toContain('expired');
    expect(result.missingScopes).toEqual(['wiki:node:retrieve', 'offline_access']);
    expect(manager.hasPendingDeviceAuth()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routes（参照 config-routes.test.ts 的 Hono 直连模式）
// ---------------------------------------------------------------------------

function buildApp(manager: unknown) {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.larkCliClient = { checkAuthReady: vi.fn(async () => ({ ready: false })) };
    if (manager) c.larkCliManager = manager;
    await next();
  });
  app.route('/', feishuRoutes);
  return app;
}

describe('feishu lark-cli routes', () => {
  it('GET /api/feishu/lark-cli/status returns the composed tool status', async () => {
    const app = buildApp({
      getToolStatus: vi.fn(async () => ({
        larkCliInstalled: false,
        authReady: false,
        missingScopes: [],
        error: '未找到 lark-cli',
        npmAvailable: true,
        npmPath: '/usr/local/bin/npm',
      })),
    });

    const response = await app.fetch(new Request('http://x/api/feishu/lark-cli/status'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      larkCliInstalled: false,
      authReady: false,
      npmAvailable: true,
      npmPath: '/usr/local/bin/npm',
    });
  });

  it('POST /api/feishu/lark-cli/install surfaces npm_not_found as 200 environment state', async () => {
    const installOrUpdateLarkCli = vi.fn(async () => ({
      ok: false,
      reason: 'npm_not_found',
      output: '未找到可用的 npm。',
    }));
    const app = buildApp({ installOrUpdateLarkCli });

    const response = await app.fetch(
      new Request('http://x/api/feishu/lark-cli/install', { method: 'POST' }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'npm_not_found' });
    expect(installOrUpdateLarkCli).toHaveBeenCalledTimes(1);
  });

  it('POST /api/feishu/auth/device/start maps an in-progress conflict to 409', async () => {
    const app = buildApp({
      startDeviceAuth: vi.fn(async () => {
        throw new LarkCliManagerError(
          '已有进行中的设备授权流程，请先完成或等待其结束',
          'device_auth_in_progress',
          409,
        );
      }),
    });

    const response = await app.fetch(
      new Request('http://x/api/feishu/auth/device/start', { method: 'POST' }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'device_auth_in_progress' });
  });

  it('POST /api/feishu/auth/device/complete rejects malformed deviceCode with 400', async () => {
    const completeDeviceAuth = vi.fn();
    const app = buildApp({ completeDeviceAuth });

    const response = await app.fetch(new Request('http://x/api/feishu/auth/device/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: '' }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(completeDeviceAuth).not.toHaveBeenCalled();
  });

  it('returns 500 dependencies_not_injected when the manager is missing', async () => {
    const app = buildApp(null);

    const response = await app.fetch(new Request('http://x/api/feishu/lark-cli/status'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'dependencies_not_injected' });
  });
});
