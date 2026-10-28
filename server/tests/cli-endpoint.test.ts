/**
 * CLI 认证与端点（S8，设计 kb-agent-upgrade §6.2）集成测试
 *
 *  - CliEndpoint 单元：endpoint.json 发布（0700/0600/schema）、revoke 的
 *    pid 所有权判定、rotate、timing-safe verify
 *  - buildServer 真实入口 + app.fetch：
 *    安全四态（令牌正确/错误/带 Origin/非回环 Host）、
 *    desktop token 与 CLI token 双向隔离、
 *    enable/rotate 管理面（desktop token 域）、关闭即失效、
 *    命令执行的 confirm 分支与审计落盘
 * 全程 FEISHU_SYNC_HOME 由 vitest globalSetup 隔离为临时目录。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/index.js';
import { CliEndpoint } from '../src/cli-endpoint.js';
import type { CliEndpointFile } from '../src/cli-endpoint.js';
import type { Hono } from 'hono';

const DESKTOP_TOKEN = 'test-desktop-token-0123456789abcdef';

let app: Hono;
let cliEndpoint: CliEndpoint;
let home: string;
let previousHome: string | undefined;

/** 独立临时数据根：vitest 文件间并行，全局 home 的 config.json 是竞态
 * 资源（兄弟套件 vision-routes 等按序读写同一文件），本套件频繁
 * enable/rotate 写配置，必须自占一个隔离根（CLAUDE.md：测试一律临时
 * FEISHU_SYNC_HOME）。 */
function isolateHome(): string {
  previousHome = process.env.FEISHU_SYNC_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-cli-test-'));
  process.env.FEISHU_SYNC_HOME = dir;
  return dir;
}

async function call(
  method: 'GET' | 'POST',
  urlPath: string,
  body: unknown = undefined,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const request = new Request(`http://127.0.0.1${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Host: '127.0.0.1',
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const response = await app.fetch(request);
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

function readEndpointFile(dir: string): CliEndpointFile {
  return JSON.parse(fs.readFileSync(path.join(dir, 'run', 'endpoint.json'), 'utf-8')) as CliEndpointFile;
}

beforeAll(async () => {
  home = isolateHome();
  app = await buildServer({ desktopMode: true, desktopToken: DESKTOP_TOKEN }) as unknown as Hono;
  cliEndpoint = (app as unknown as { __cliEndpoint: CliEndpoint }).__cliEndpoint;
});

afterAll(() => {
  try { cliEndpoint?.revoke(); } catch { /* ignore */ }
  if (previousHome === undefined) delete process.env.FEISHU_SYNC_HOME;
  else process.env.FEISHU_SYNC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CliEndpoint 单元
// ---------------------------------------------------------------------------

describe('CliEndpoint 单元', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-ep-'));

  it('publish 写出 0700 目录 + 0600 文件，schema 完整，无 tmp 残留', () => {
    const endpoint = new CliEndpoint(tmp, { appVersion: '0.0.0-test' });
    endpoint.publish('http://127.0.0.1:3001');
    const file = path.join(tmp, 'run', 'endpoint.json');
    expect(fs.existsSync(file)).toBe(true);
    const payload = readEndpointFile(tmp);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.url).toBe('http://127.0.0.1:3001');
    expect(payload.pid).toBe(process.pid);
    expect(payload.appVersion).toBe('0.0.0-test');
    expect(typeof payload.cliToken).toBe('string');
    expect(payload.cliToken.length).toBeGreaterThanOrEqual(40);
    // 权限：目录 0700、文件 0600（POSIX；Windows 跳过 mode 断言）
    if (process.platform !== 'win32') {
      const dirMode = fs.statSync(path.join(tmp, 'run')).mode & 0o777;
      const fileMode = fs.statSync(file).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(endpoint.verify(payload.cliToken)).toBe(true);
  });

  it('verify 拒绝错误/异长令牌与未发布实例', () => {
    const endpoint = new CliEndpoint(tmp);
    endpoint.publish('http://127.0.0.1:2');
    const token = readEndpointFile(tmp).cliToken;
    expect(endpoint.verify(token)).toBe(true);
    expect(endpoint.verify(`${token}x`)).toBe(false);
    expect(endpoint.verify('')).toBe(false);
    const fresh = new CliEndpoint(tmp);
    expect(fresh.verify(token)).toBe(false);
    endpoint.revoke();
  });

  it('revoke：pid 匹配删文件并失效令牌；pid 不匹配保留文件', () => {
    const endpoint = new CliEndpoint(tmp);
    endpoint.publish('http://127.0.0.1:3');
    const token = readEndpointFile(tmp).cliToken;
    endpoint.revoke();
    expect(fs.existsSync(path.join(tmp, 'run', 'endpoint.json'))).toBe(false);
    expect(endpoint.verify(token)).toBe(false);

    // 他实例（pid 不匹配）的文件不被删除
    const foreign: CliEndpointFile = {
      schemaVersion: 1, url: 'http://127.0.0.1:4', pid: 999999,
      startedAt: new Date().toISOString(), appVersion: 'x', cliToken: 'foreign',
    };
    fs.writeFileSync(path.join(tmp, 'run', 'endpoint.json'), JSON.stringify(foreign));
    endpoint.revoke();
    expect(fs.existsSync(path.join(tmp, 'run', 'endpoint.json'))).toBe(true);
    fs.rmSync(path.join(tmp, 'run', 'endpoint.json'), { force: true });
  });

  it('rotate：重生成令牌并保持文件在位；未发布时抛错', () => {
    const endpoint = new CliEndpoint(tmp);
    expect(() => endpoint.rotate()).toThrowError();
    endpoint.publish('http://127.0.0.1:5');
    const oldToken = readEndpointFile(tmp).cliToken;
    endpoint.rotate();
    const newToken = readEndpointFile(tmp).cliToken;
    expect(newToken).not.toBe(oldToken);
    expect(endpoint.verify(oldToken)).toBe(false);
    expect(endpoint.verify(newToken)).toBe(true);
    endpoint.revoke();
  });
});

// ---------------------------------------------------------------------------
// 集成：管理面 + CLI 域
// ---------------------------------------------------------------------------

describe('CLI 管理面（desktop token 域）', () => {
  it('无 desktop token / 错 token → 401', async () => {
    const noToken = await call('POST', '/api/cli/enable', { enabled: true });
    expect(noToken.status).toBe(401);
    const badToken = await call('POST', '/api/cli/enable', { enabled: true }, {
      'X-Desktop-Token': 'wrong-token',
    });
    expect(badToken.status).toBe(401);
  });

  it('CLI 令牌调 enable → 403 cli_forbidden_route（不能自我提权）', async () => {
    const result = await call('POST', '/api/cli/enable', { enabled: true }, {
      'X-Cli-Token': 'any-cli-token',
      'X-Desktop-Token': DESKTOP_TOKEN,
    });
    expect(result.status).toBe(403);
    expect(result.json.error).toBe('cli_forbidden_route');
  });

  it('enabled 非 boolean → 400 invalid_body', async () => {
    const result = await call('POST', '/api/cli/enable', { enabled: 'yes' }, {
      'X-Desktop-Token': DESKTOP_TOKEN,
    });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('invalid_body');
  });

  it('开启 → 200 且 endpoint.json 发布（0600）', async () => {
    const result = await call('POST', '/api/cli/enable', { enabled: true }, {
      'X-Desktop-Token': DESKTOP_TOKEN,
    });
    expect(result.status).toBe(200);
    expect(result.json.enabled).toBe(true);
    expect(result.json.published).toBe(true);
    const file = path.join(home, 'run', 'endpoint.json');
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('rotate 在开启态成功、关闭态 400 cli_disabled', async () => {
    const ok = await call('POST', '/api/cli/token/rotate', {}, {
      'X-Desktop-Token': DESKTOP_TOKEN,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.rotated).toBe(true);

    await call('POST', '/api/cli/enable', { enabled: false }, {
      'X-Desktop-Token': DESKTOP_TOKEN,
    });
    const disabled = await call('POST', '/api/cli/token/rotate', {}, {
      'X-Desktop-Token': DESKTOP_TOKEN,
    });
    expect(disabled.status).toBe(400);
    expect(disabled.json.error).toBe('cli_disabled');
    // 恢复开启，供后续用例
    await call('POST', '/api/cli/enable', { enabled: true }, {
      'X-Desktop-Token': DESKTOP_TOKEN,
    });
  });
});

describe('CLI 命令域安全四态', () => {
  let cliToken: string;

  it('前置：开启后可读取令牌', async () => {
    cliToken = readEndpointFile(home).cliToken;
    expect(typeof cliToken).toBe('string');
  });

  it('① 正确令牌 + 回环 Host + 无 Origin → 200', async () => {
    const result = await call('POST', '/api/cli/config.get', { args: {} }, {
      'X-Cli-Token': cliToken,
    });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    // 转发的是脱敏后的 GET /api/config
    expect(result.json.data.pollIntervalMinutes).toBeTruthy();
  });

  it('② 错误令牌 → 401 cli_token_invalid', async () => {
    const result = await call('POST', '/api/cli/config.get', { args: {} }, {
      'X-Cli-Token': 'wrong-cli-token',
    });
    expect(result.status).toBe(401);
    expect(result.json.error).toBe('cli_token_invalid');
  });

  it('③ 带-Origin（浏览器来源）→ 401 cli_token_invalid', async () => {
    const result = await call('POST', '/api/cli/config.get', { args: {} }, {
      'X-Cli-Token': cliToken,
      Origin: 'http://localhost:5173',
    });
    expect(result.status).toBe(401);
    expect(result.json.error).toBe('cli_token_invalid');
  });

  it('④ 非回环 Host → 401 cli_token_invalid', async () => {
    const request = new Request('http://evil.example.com/api/cli/config.get', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'evil.example.com',
        'X-Cli-Token': cliToken,
      },
      body: JSON.stringify({ args: {} }),
    });
    const response = await app.fetch(request);
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe('cli_token_invalid');
  });

  it('desktop token 在 CLI 域不被接受（分离域）', async () => {
    const result = await call('POST', '/api/cli/config.get', { args: {} }, {
      'X-Desktop-Token': DESKTOP_TOKEN,
    });
    expect(result.status).toBe(401);
    expect(result.json.error).toBe('cli_token_invalid');
  });

  it('无任何令牌 → 401', async () => {
    const result = await call('POST', '/api/cli/config.get', { args: {} });
    expect(result.status).toBe(401);
  });
});

describe('命令执行（confirm 分支与转发）', () => {
  let cliToken: string;

  it('前置令牌', async () => {
    cliToken = readEndpointFile(home).cliToken;
  });

  it('GET /api/cli/commands 返回命令清单', async () => {
    const result = await call('GET', '/api/cli/commands', undefined, {
      'X-Cli-Token': cliToken,
    });
    expect(result.status).toBe(200);
    const names = result.json.commands.map((c: { name: string }) => c.name);
    expect(names).toContain('kb.build');
    expect(names).toContain('clean.orphans');
    expect(names).toContain('clean.trash.purge');
    expect(names).toContain('config.set');
  });

  it('未知命令 → 404 unknown_command', async () => {
    const result = await call('POST', '/api/cli/no.such', { args: {} }, {
      'X-Cli-Token': cliToken,
    });
    expect(result.status).toBe(404);
    expect(result.json.error).toBe('unknown_command');
  });

  it('kb.build 无确认 → 422 confirmation_required（不触达构建）', async () => {
    const result = await call('POST', '/api/cli/kb.build', { args: {} }, {
      'X-Cli-Token': cliToken,
    });
    expect(result.status).toBe(422);
    expect(result.json.error.code).toBe('confirmation_required');
    expect(result.json.error.details).toEqual({ field: 'confirm', value: 'BUILD' });
  });

  it('clean.trash.purge 无确认 → 422；带 PURGE 确认后放行转发', async () => {
    const blocked = await call('POST', '/api/cli/clean.trash.purge', { args: { objToken: 'tok-x' } }, {
      'X-Cli-Token': cliToken,
    });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error.code).toBe('confirmation_required');

    const forwarded = await call('POST', '/api/cli/clean.trash.purge', {
      args: { objToken: 'tok-not-exist' },
      confirm: 'PURGE',
    }, { 'X-Cli-Token': cliToken });
    // 确认门已过：不再返回 confirmation_required（后端对不存在文档给出自身语义）
    expect(forwarded.json?.error?.code).not.toBe('confirmation_required');
    expect(forwarded.status).not.toBe(422);
  });

  it('clean.orphans 缺省 dry-run → GET 转发（无需确认）', async () => {
    const result = await call('POST', '/api/cli/clean.orphans', { args: {} }, {
      'X-Cli-Token': cliToken,
    });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(Array.isArray(result.json.data.items)).toBe(true);
  });

  it('config.set 禁止路径 → 400 forbidden_path（不触达 PUT）', async () => {
    const result = await call('POST', '/api/cli/config.set', {
      args: { path: 'cli.enabled', value: true },
    }, { 'X-Cli-Token': cliToken });
    expect(result.status).toBe(400);
    expect(result.json.error.code).toBe('forbidden_path');
  });

  it('必填参数缺失 → 400 invalid_args', async () => {
    const result = await call('POST', '/api/cli/kb.cancel', { args: {} }, {
      'X-Cli-Token': cliToken,
    });
    expect(result.status).toBe(400);
    expect(result.json.error.code).toBe('invalid_args');
  });

  it('非 GET 命令写入审计 cli.jsonl（不记 body）', async () => {
    const auditFile = path.join(home, 'agent', 'audit', 'cli.jsonl');
    expect(fs.existsSync(auditFile)).toBe(true);
    const lines = fs.readFileSync(auditFile, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.method).toBe('POST');
    expect(last.path).toBe('/api/cli/kb.cancel');
    expect(typeof last.status).toBe('number');
    expect(JSON.stringify(last)).not.toContain('buildId');
  });
});

describe('关闭即失效', () => {
  it('disable 后旧令牌 401 且文件删除', async () => {
    const before = readEndpointFile(home).cliToken;
    const disable = await call('POST', '/api/cli/enable', { enabled: false }, {
      'X-Desktop-Token': DESKTOP_TOKEN,
    });
    expect(disable.status).toBe(200);
    expect(fs.existsSync(path.join(home, 'run', 'endpoint.json'))).toBe(false);
    const denied = await call('POST', '/api/cli/config.get', { args: {} }, {
      'X-Cli-Token': before,
    });
    expect(denied.status).toBe(401);
  });
});
