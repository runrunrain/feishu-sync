/**
 * Vision API 路由测试（S2，设计 §3.6）
 *
 * buildServer 真实入口（沿 agent-status-regression 模式，独立临时
 * configPath，不污染共享 FEISHU_SYNC_HOME）。用例按共享配置状态递进
 * 排序：缺省态 → 启用态 → 显式覆盖测试（fixture 回环端点）。
 *   - GET /api/agent/vision/status：缺省 disabled / 配置后 ready
 *   - POST /api/agent/vision/test：未配置 400；无效引用 400；
 *     有效引用 → 内置测试图真实走一次本地回环 vision 端点
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildServer } from '../src/index.js';
import type { Hono } from 'hono';

let configDir: string;
let app: Hono;
const servers: http.Server[] = [];
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  for (const s of servers) s.close();
});

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-routes-'));
  app = await buildServer({ desktopMode: false, configPath: path.join(configDir, 'config.json') }) as unknown as Hono;
});

function json<T>(method: string, endpoint: string, body?: unknown): Promise<{ status: number; body: T }> {
  return app.fetch(new Request(`http://127.0.0.1:1${endpoint}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  })).then(async (res) => ({ status: res.status, body: await res.json() as T }));
}

async function visionFixture(): Promise<{ port: number; captured: () => any }> {
  let captured: any = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      captured = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c', object: 'chat.completion', model: captured.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '识别到「识图测试」字样' }, finish_reason: 'stop' }],
        usage: { total_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, captured: () => captured };
}

describe('Vision API（共享配置状态，按序执行）', () => {
  it('GET status 缺省：disabled、无模型、零缓存', async () => {
    const { status, body } = await json<{ enabled: boolean; state: string; model: string | null; cachedCount: number }>('GET', '/api/agent/vision/status');
    expect(status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.state).toBe('disabled');
    expect(body.model).toBeNull();
    expect(body.cachedCount).toBe(0);
  });

  it('POST test 未启用且无显式覆盖 → 400 vision_unconfigured', async () => {
    const { status, body } = await json<{ error: string }>('POST', '/api/agent/vision/test', {});
    expect(status).toBe(400);
    expect(body.error).toBe('vision_unconfigured');
  });

  it('POST test 显式覆盖不存在的 provider → 400 invalid_config', async () => {
    const { status, body } = await json<{ error: string }>('POST', '/api/agent/vision/test', { providerId: 'ghost' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_config');
  });

  it('PUT 启用有效引用 → GET status ready + 引用信息', async () => {
    const fixture = await visionFixture();
    const put = await json('PUT', '/api/config', {
      llm: {
        providers: [{
          id: 'vp', name: 'Vision Fixture', enabled: true, protocol: 'openai-completions',
          apiKey: 'vision-fixture-key', openAiCompatBaseUrl: `http://127.0.0.1:${fixture.port}/v1`, defaultModelId: 'preset',
          models: [{ id: 'preset', name: 'Vision Preset', enabled: true, openAiModel: 'vision-model', contextWindow: 64000, maxTokens: 1024 }],
        }],
      },
      agent: { vision: { enabled: true, providerId: 'vp', modelId: 'preset' } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const { status, body } = await json<{ enabled: boolean; state: string; provider: string; model: string | null; cachedCount: number }>('GET', '/api/agent/vision/status');
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.state).toBe('ready');
    expect(body.provider).toBe('vp');
    expect(body.model).toBe('vision-model');
    expect(body.cachedCount).toBe(0); // test 端点不写缓存
  });

  it('POST test 有效引用：内置测试图真实走一次本地回环 vision 端点', async () => {
    const fixture = await visionFixture();
    // 注册第二个 provider，用显式覆盖测试（设置页「换一个试试」语义）。
    // providers 按 id 合并且仅保留传入列表——vp 仍被 vision 引用，必须一并回传。
    const vp = (await json<any>('GET', '/api/config')).body?.llm?.providers?.find((p: any) => p.id === 'vp');
    const put = await json('PUT', '/api/config', {
      llm: {
        providers: [
          vp,
          {
            id: 'vp2', name: 'Vision Fixture 2', enabled: true, protocol: 'openai-completions',
            apiKey: 'vision-fixture-key', openAiCompatBaseUrl: `http://127.0.0.1:${fixture.port}/v1`, defaultModelId: 'preset',
            models: [{ id: 'preset', name: 'Vision Preset', enabled: true, openAiModel: 'vision-model', contextWindow: 64000, maxTokens: 1024 }],
          },
        ],
      },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const result = await json<{ ok: boolean; finishReason: string; model: string; latencyMs: number; sample: string }>('POST', '/api/agent/vision/test', { providerId: 'vp2' });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.finishReason).toBe('stop');
    expect(result.body.model).toBe('vision-model');
    expect(result.body.sample).toContain('识图测试');
    expect(result.body.latencyMs).toBeGreaterThanOrEqual(0);
    // 请求体：多模态块携带 PNG data URL（内置测试图字节）
    const captured = fixture.captured();
    expect(captured?.model).toBe('vision-model');
    const blocks = captured?.messages?.[0]?.content ?? [];
    const imageUrl = blocks.find((b: any) => b.type === 'image_url')?.image_url?.url;
    expect(imageUrl).toMatch(/^data:image\/png;base64,/);
    const image = Buffer.from(imageUrl.slice('data:image/png;base64,'.length), 'base64');
    expect(image.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(image.readUInt32BE(16)).toBe(320);
    expect(image.readUInt32BE(20)).toBe(320);
    // test 不写缓存（fixture 与生产资料严格分离）
    const status = await json<{ cachedCount: number }>('GET', '/api/agent/vision/status');
    expect(status.body.cachedCount).toBe(0);
  });
});
