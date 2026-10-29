/**
 * Agent 状态路由新鲜度回归（Leader steer #4）
 *
 * 场景：启动时未配置（app-llm 无 key）→ HTTP PUT /api/config 保存
 * pi-agent-dir + piModel → GET /api/agent/status 与 /status/recheck 必须
 * 用最新配置判定（修复前 factory 顶层捕获旧 config 对象，保存后永远
 * 报 model_auth_missing）。
 *
 * 显式使用 Pi 基座与临时运行时布局，避免默认基座或机器上是否安装 Pi
 * 影响测试；不启动假 CLI，专门验证保存后状态路由读取的是最新配置。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/index.js';
import { PI_PACKAGE_NAME } from '../src/agent/runtime-resolver.js';
import type { Hono } from 'hono';

let configPath: string;
let configDir: string;
let app: Hono;

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-reg-'));
  configPath = path.join(configDir, 'config.json');
  const piRoot = path.join(configDir, 'pi');
  fs.mkdirSync(path.join(piRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(piRoot, 'package.json'), JSON.stringify({ name: PI_PACKAGE_NAME, version: '1.4.0' }));
  fs.writeFileSync(path.join(piRoot, 'dist', 'cli.js'), '// fixture: status probe does not spawn when no server port exists');
  app = await buildServer({ desktopMode: false, configPath }) as unknown as Hono;
  const setup = await app.fetch(new Request('http://127.0.0.1:1/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: { runtime: { backend: 'pi', nodePath: process.execPath, piCliPath: piRoot } } }),
  }));
  expect(setup.status).toBe(200);
});

afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function getStatus(
  endpoint = '/api/agent/status',
  method: 'GET' | 'POST' = 'GET',
): Promise<{
  status: number;
  body: { code: string; model: { source: string; model: string | null } };
}> {
  const response = await app.fetch(new Request(`http://127.0.0.1:1${endpoint}`, { method }));
  const body = await response.json() as { code: string; model: { source: string; model: string | null } };
  return { status: response.status, body };
}

describe('agent status 配置新鲜度（steer #4 回归）', () => {
  it('启动未配置：app-llm 无 key → model_auth_missing / model_unconfigured', async () => {
    const first = await getStatus();
    expect(first.status).toBe(200);
    expect(first.body.model.source).toBe('app-llm');
    expect(['model_auth_missing', 'model_unconfigured']).toContain(first.body.code);
  });

  it('HTTP 保存 pi-agent-dir + piModel → status 与 recheck 都用新配置', async () => {
    const put = await app.fetch(new Request('http://127.0.0.1:1/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: {
          model: {
            source: 'pi-agent-dir',
            piModel: 'amagi-glm/glm-5.3-flash',
            thinkingLevel: 'off',
            contextWindow: 128000,
            maxTokens: 8192,
          },
        },
      }),
    }));
    expect(put.status).toBe(200);

    for (const [endpoint, method] of [
      ['/api/agent/status', 'GET'],
      ['/api/agent/status/recheck', 'POST'],
    ] as const) {
      const result = await getStatus(endpoint, method);
      expect(result.status).toBe(200);
      // 修复前：闭包捕获旧 config → source 仍 app-llm、仍报 key 缺失
      expect(result.body.model.source).toBe('pi-agent-dir');
      expect(result.body.model.model).toBe('amagi-glm/glm-5.3-flash');
      expect(['model_auth_missing', 'model_unconfigured']).not.toContain(result.body.code);
      expect(result.body.code).toBe('ready');
    }
  });
});
