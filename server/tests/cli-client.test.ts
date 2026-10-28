/**
 * CLI 客户端端到端（S9，设计 kb-agent-upgrade §6.1/§6.4）
 *
 * vitest 内起真实 startServer 测试实例（127.0.0.1 随机端口），CLI 以
 * esbuild 单文件产物子进程真实调用（产物缺失时按 build 同配置打包，
 * 共享入口 scripts/lib/cli-bundle.mjs——与 mcp-kb.test.ts 同法）：
 *
 *  - status --json 形状（{ok:true,data:{health,larkCli,agent,kb}}）
 *  - config get / config set 往返
 *  - kb build 无 confirm → 退出码 4（本地预检，不打扰服务器）
 *  - clean orphans dry-run / --apply（无 --yes → 4）/ --apply --yes 走通
 *  - 未开启 CLI（无 endpoint.json / 令牌失效）→ 退出码 3
 *  - 错误命令 / 非法参数 → 退出码 2
 *  - shim：install-shim 端点（desktop token 域）写盘 + shim 真实调起
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startServer, type StartedServer } from '../src/index.js';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

const DESKTOP_TOKEN = 'test-desktop-token-s9-0123456789abcdef';
/** 与 cli-bundle.mjs 相同的默认产物路径（install-shim 的 cliAvailable 判定面）。 */
const CLI_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'feishu-sync-cli.cjs');

let server: StartedServer;
let home: string;
let previousHome: string | undefined;

/** 独立临时数据根（vitest 文件级并行，见 cli-endpoint.test.ts 同款说明）。 */
function isolateHome(): string {
  previousHome = process.env.FEISHU_SYNC_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-cli-e2e-'));
  process.env.FEISHU_SYNC_HOME = dir;
  return dir;
}

async function api(
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${server.url}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': DESKTOP_TOKEN, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

interface CliRun { code: number; stdout: string; stderr: string }

/** 子进程真实调用 CLI bundle（--home 显式指定，不依赖环境继承）。 */
async function cli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_SCRIPT, '--home', home, ...args], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

function endpointFile(dir: string): string {
  return path.join(dir, 'run', 'endpoint.json');
}

beforeAll(async () => {
  home = isolateHome();
  if (!fs.existsSync(CLI_SCRIPT)) {
    const { bundleCli } = await import('../scripts/lib/cli-bundle.mjs');
    await bundleCli();
  }
  // configPath 显式指定：ConfigManager 缺省路径在模块求值期冻结，与并行
  // 套件（cli-endpoint.test.ts 同样改 FEISHU_SYNC_HOME）在同 worker 内
  // 存在 env 竞态；显式路径使本套件配置读写始终落在自己的隔离根。
  server = await startServer({
    desktopMode: true,
    desktopToken: DESKTOP_TOKEN,
    configPath: path.join(home, 'config.json'),
    port: 0,
    hostname: '127.0.0.1',
  });
  // 开启命令行访问（desktop token 域）→ 发布 endpoint.json
  const enabled = await api('POST', '/api/cli/enable', { enabled: true });
  expect(enabled.status).toBe(200);
  expect(fs.existsSync(endpointFile(home))).toBe(true);
}, 240_000);

afterAll(async () => {
  await server.close().catch(() => undefined);
  if (previousHome === undefined) delete process.env.FEISHU_SYNC_HOME;
  else process.env.FEISHU_SYNC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
}, 120_000);

// ---------------------------------------------------------------------------
// 端到端命令
// ---------------------------------------------------------------------------

describe('CLI 子进程端到端（对本地真实 server）', () => {
  it('status --json：包络与四步聚合形状', async () => {
    const run = await cli(['--json', 'status']);
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(true);
    expect(Object.keys(envelope.data).sort()).toEqual(['agent', 'health', 'kb', 'larkCli']);
    expect(envelope.data.health.status).toBe('ok');
  }, 60_000);

  it('status 人类模式：非空、含 health', async () => {
    const run = await cli(['status']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('health');
    expect(run.stdout).not.toContain('"ok"');
  }, 60_000);

  it('config get / config set 往返', async () => {
    const before = await cli(['--json', 'config', 'get']);
    expect(before.code).toBe(0);
    const beforeData = JSON.parse(before.stdout).data;
    expect(typeof beforeData.pollIntervalMinutes).toBe('number');

    const target = beforeData.enableNotifications === true ? false : true;
    const set = await cli(['--json', 'config', 'set', 'enableNotifications', String(target)]);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout).ok).toBe(true);

    const after = await cli(['--json', 'config', 'get']);
    expect(JSON.parse(after.stdout).data.enableNotifications).toBe(target);
    // 还原，避免影响同库其他用例
    await cli(['--json', 'config', 'set', 'enableNotifications', String(beforeData.enableNotifications)]);
  }, 60_000);

  it('config get <path> 裁剪输出', async () => {
    const run = await cli(['--json', 'config', 'get', 'pollIntervalMinutes']);
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(true);
    expect(typeof envelope.data).toBe('number');
  }, 60_000);

  it('kb build 无 confirm → 退出码 4（confirmation_required）', async () => {
    const run = await cli(['--json', 'kb', 'build']);
    expect(run.code).toBe(4);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('confirmation_required');
    expect(envelope.error.details).toEqual({ field: 'confirm', value: 'BUILD' });
  }, 60_000);

  it('kb build --full --yes 参数解析可达服务器（业务错误也是 exit 1 而非 4）', async () => {
    // 测试环境无 pi 运行时/模型：构建会在业务层失败（如 agent 未就绪），
    // 但 confirm 门已过、mode=full 已注入——证明旗标解析与 confirm 透传正确。
    const run = await cli(['--json', 'kb', 'build', '--full', '--yes']);
    expect(run.code).not.toBe(4);
    expect(run.code).not.toBe(2);
    expect(run.code).not.toBe(3);
  }, 120_000);

  it('clean orphans：dry-run 免确认；--apply 无 --yes → 4；--apply --yes 走通', async () => {
    const dry = await cli(['--json', 'clean', 'orphans']);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout).ok).toBe(true);

    const unconfirmed = await cli(['--json', 'clean', 'orphans', '--apply']);
    expect(unconfirmed.code).toBe(4);
    expect(JSON.parse(unconfirmed.stdout).error.code).toBe('confirmation_required');

    const applied = await cli(['--json', 'clean', 'orphans', '--apply', '--yes']);
    expect(applied.code).toBe(0);
    const envelope = JSON.parse(applied.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.dryRun).toBe(false);
  }, 60_000);

  it('未知命令 / 非法参数 → 退出码 2', async () => {
    const unknown = await cli(['--json', 'frobnicate']);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.stdout).error.code).toBe('usage_error');

    const badParam = await cli(['--json', 'kb', 'builds', '--limit', 'abc']);
    expect(badParam.code).toBe(2);

    const unknownFlag = await cli(['--json', 'status', '--bogus']);
    expect(unknownFlag.code).toBe(2);
  }, 60_000);

  it('missing 必填参数（表内 request 校验）→ 退出码 2', async () => {
    const run = await cli(['--json', 'clean', 'trash', 'purge']);
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.error.code).toBe('invalid_args');
  }, 60_000);

  it('未开启 CLI：无 endpoint.json → 退出码 3 app_not_running', async () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-cli-off-'));
    try {
      const { code, stdout } = await exec(
        process.execPath,
        [CLI_SCRIPT, '--home', emptyHome, '--json', 'status'],
        { timeout: 30_000 },
      ).catch((error) => error as { code: number; stdout: string });
      expect(code).toBe(3);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('app_not_running');
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  }, 60_000);

  it('陈旧/坏令牌 → 退出码 3（cli_token_invalid 归入不可达语义）', async () => {
    const staleHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-cli-stale-'));
    try {
      fs.mkdirSync(path.join(staleHome, 'run'), { recursive: true });
      fs.writeFileSync(endpointFile(staleHome), JSON.stringify({
        schemaVersion: 1,
        url: server.url,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        appVersion: 'test',
        cliToken: 'stale-token-not-valid',
      }));
      const { code, stdout } = await exec(
        process.execPath,
        [CLI_SCRIPT, '--home', staleHome, '--json', 'config', 'get'],
        { timeout: 30_000 },
      ).catch((error) => error as { code: number; stdout: string });
      expect(code).toBe(3);
      const envelope = JSON.parse(stdout);
      expect(envelope.error.code).toBe('cli_token_invalid');
    } finally {
      fs.rmSync(staleHome, { recursive: true, force: true });
    }
  }, 60_000);

  it('服务不可达（端点指向死端口）→ 退出码 3 app_not_reachable', async () => {
    const deadHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-cli-dead-'));
    try {
      fs.mkdirSync(path.join(deadHome, 'run'), { recursive: true });
      fs.writeFileSync(endpointFile(deadHome), JSON.stringify({
        schemaVersion: 1,
        url: 'http://127.0.0.1:1',
        pid: 1,
        startedAt: new Date().toISOString(),
        appVersion: 'test',
        cliToken: 'whatever',
      }));
      const { code, stdout } = await exec(
        process.execPath,
        [CLI_SCRIPT, '--home', deadHome, '--json', 'status'],
        { timeout: 30_000 },
      ).catch((error) => error as { code: number; stdout: string });
      expect(code).toBe(3);
      expect(JSON.parse(stdout).error.code).toBe('app_not_reachable');
    } finally {
      fs.rmSync(deadHome, { recursive: true, force: true });
    }
  }, 60_000);

  it('auth login 类命令走命令表映射（不直连 manager）', async () => {
    // complete 缺 deviceCode → 本地必填校验（exit 2），不触达
    // LarkCliManager（无网络副作用）。
    const run = await cli(['--json', 'auth', 'login', 'complete']);
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.error.code).toBe('usage_error');
    expect(envelope.error.message).toContain('deviceCode');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// shim 管理端点（desktop token 域）+ shim 真实调起
// ---------------------------------------------------------------------------

describe('CLI shim 安装（POST /api/cli/install-shim + GET /api/cli/info）', () => {
  it('install-shim 只接受 desktop token（CLI 令牌 403 / 无令牌 401）', async () => {
    const noToken = await fetch(`${server.url}/api/cli/install-shim`, { method: 'POST' });
    expect(noToken.status).toBe(401);

    const endpoint = JSON.parse(fs.readFileSync(endpointFile(home), 'utf-8'));
    const cliToken = await fetch(`${server.url}/api/cli/install-shim`, {
      method: 'POST',
      headers: { 'X-Cli-Token': endpoint.cliToken },
    });
    expect(cliToken.status).toBe(403);
    expect((await cliToken.json()).error).toBe('cli_forbidden_route');
  }, 30_000);

  it('install-shim 写出可执行 shim，info 反映安装状态', async () => {
    const installed = await api('POST', '/api/cli/install-shim');
    expect(installed.status).toBe(200);
    expect(installed.json.installed).toBe(true);
    const shimPath: string = installed.json.shimPath;
    expect(fs.existsSync(shimPath)).toBe(true);
    expect(fs.existsSync(installed.json.cmdPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(shimPath).mode & 0o777).toBe(0o755);
    }
    const content = fs.readFileSync(shimPath, 'utf-8');
    expect(content).toContain(CLI_SCRIPT);
    expect(content).toContain(home);
    expect(content).toContain('FEISHU_SYNC_HOME');

    const info = await api('GET', '/api/cli/info');
    expect(info.status).toBe(200);
    expect(info.json.enabled).toBe(true);
    expect(info.json.shimInstalled).toBe(true);
    expect(info.json.cliAvailable).toBe(true);
    expect(info.json.command).toBeTruthy();
    expect(Array.isArray(info.json.args)).toBe(true);
    expect(info.json.pathHint).toContain(path.join(home, 'bin'));
  }, 30_000);

  it('shim 真实调起：status --json 经 shim 出站', async () => {
    if (process.platform === 'win32') return; // POSIX sh shim 在 Windows 不适用
    const info = await api('GET', '/api/cli/info');
    const { stdout } = await exec(info.json.shimPath, ['--json', 'status'], { timeout: 60_000 });
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.health.status).toBe('ok');
  }, 90_000);
});
