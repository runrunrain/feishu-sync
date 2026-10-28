/**
 * VisionChannel 三协议直连测试（S2，设计 §3.2）
 *
 * 真实 OpenAI/Anthropic SDK + 本地回环 HTTP fixture（沿
 * provider-protocol-live.test.ts 模式）——不 mock SDK、不触外网：
 *   - 三协议请求体断言（多模态块形态、模型别名、max_tokens、鉴权头）
 *   - 成功解析 / length 映射 / 超时分类 / 错误不抛异常 / apiKey 脱敏
 *   - 外部 signal 中止 → error(aborted by caller)
 */

import { afterAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LlmConfig } from '../src/modules/content-backend.js';
import type { LlmProtocol } from '../src/types/index.js';
import { VisionChannel } from '../src/agent/vision/vision-channel.js';

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG = Buffer.from(TINY_PNG_B64, 'base64');
const API_KEY = 'vision-fixture-key';

interface Captured { url: string; auth?: string; xApiKey?: string; body: Record<string, any> }

async function startFixture(handler: http.RequestListener): Promise<{ server: http.Server; port: number; calls: Captured[] }> {
  const calls: Captured[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      calls.push({ url: req.url!, auth: req.headers.authorization, xApiKey: req.headers['x-api-key'] as string, body: JSON.parse(raw || '{}') });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port, calls };
}

function fixtureLlm(api: LlmProtocol, port: number): LlmConfig {
  const base = `http://127.0.0.1:${port}${api === 'anthropic-messages' ? '' : '/v1'}`;
  return {
    openAiCompatBaseUrl: base,
    apiKey: 'legacy-flat-key',
    model: 'legacy-model',
    providers: [{
      id: 'vision-prov', name: 'Vision Fixture', enabled: true, protocol: api,
      apiKey: API_KEY, openAiCompatBaseUrl: base, defaultModelId: 'preset',
      models: [
        { id: 'preset', name: 'Vision Preset', enabled: true, openAiModel: 'vision-model', contextWindow: 64000, maxTokens: 1024 },
        { id: 'alt', name: 'Vision Alt', enabled: true, openAiModel: 'vision-model-alt', contextWindow: 32000, maxTokens: 512 },
      ],
    }],
  } as unknown as LlmConfig;
}

function wireSuccess(api: LlmProtocol, model: string, text: string, stopReason?: string) {
  if (api === 'anthropic-messages') {
    return { id: 'msg', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: stopReason ?? 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } };
  }
  if (api === 'openai-responses') {
    const incomplete = stopReason === 'length';
    return {
      id: 'r', object: 'response', model,
      status: incomplete ? 'incomplete' : 'completed',
      incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
      output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
    };
  }
  return { id: 'c', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: stopReason ?? 'stop' }], usage: { total_tokens: 10 } };
}

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

describe.each<LlmProtocol>(['openai-completions', 'openai-responses', 'anthropic-messages'])('VisionChannel[%s]', (api) => {
  it('发送正确形态的多模态请求体并解析成功响应', async () => {
    const { server, port, calls } = await startFixture((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(wireSuccess(api, 'vision-model', '图类型：图标表情')));
    });
    servers.push(server);
    const channel = new VisionChannel(fixtureLlm(api, port), { providerId: 'vision-prov' });
    const result = await channel.describe({ bytes: TINY_PNG, mime: 'image/png', prompt: '描述这张图' }, { timeoutMs: 5000 });

    expect(result.finishReason, result.errorMessage).toBe('stop');
    expect(result.text).toBe('图类型：图标表情');
    expect(result.model).toBe('vision-model');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    // 端点与鉴权（anthropic 走 x-api-key，openai 系走 Bearer）
    expect(call.url.split('?')[0]).toBe(api === 'anthropic-messages' ? '/v1/messages' : api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions');
    if (api === 'anthropic-messages') expect(call.xApiKey).toBe(API_KEY);
    else expect(call.auth).toBe(`Bearer ${API_KEY}`);
    expect(call.body.model).toBe('vision-model');
    // 多模态 content 块：image 为 base64 data URL / base64 source（按协议适配）
    const blocks = api === 'anthropic-messages'
      ? call.body.messages[0].content
      : api === 'openai-responses' ? call.body.input[0].content : call.body.messages[0].content;
    const textBlock = blocks.find((b: any) => b.type === 'text' || b.type === 'input_text');
    const imageBlock = blocks.find((b: any) => b.type === 'image_url' || b.type === 'input_image' || b.type === 'image');
    expect(textBlock?.text).toBe('描述这张图');
    if (api === 'anthropic-messages') {
      expect(imageBlock.source).toEqual({ type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 });
      expect(call.body.max_tokens).toBe(1024);
    } else if (api === 'openai-responses') {
      expect(imageBlock.image_url).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
      expect(call.body.max_output_tokens).toBe(1024);
    } else {
      expect(imageBlock.image_url.url).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
      expect(call.body.max_tokens).toBe(1024);
    }
  });

  it('finishReason=length 映射（输出被截断仍算成功）', async () => {
    const { server, port, calls } = await startFixture((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(wireSuccess(api, 'vision-model', 'partial', api === 'anthropic-messages' ? 'max_tokens' : 'length')));
    });
    servers.push(server);
    const channel = new VisionChannel(fixtureLlm(api, port), { providerId: 'vision-prov' });
    const result = await channel.describe({ bytes: TINY_PNG, mime: 'image/png', prompt: 'p' }, { timeoutMs: 5000 });
    expect(result.finishReason).toBe('length');
    expect(result.text).toBe('partial');
    expect(calls).toHaveLength(1);
  });

  it('服务端 4xx：不抛异常，返回 error 且错误消息脱敏 apiKey', async () => {
    const { server, port } = await startFixture((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Denied for key ${API_KEY}`, type: 'invalid_request_error' } }));
    });
    servers.push(server);
    const channel = new VisionChannel(fixtureLlm(api, port), { providerId: 'vision-prov' });
    const result = await channel.describe({ bytes: TINY_PNG, mime: 'image/png', prompt: 'p' }, { timeoutMs: 5000 });
    expect(result.finishReason).toBe('error');
    expect(result.text).toBe('');
    expect(result.errorMessage).toBeTruthy();
    expect(result.errorMessage!).not.toContain(API_KEY);
    expect(result.errorMessage!).toContain('***');
  });

  it('超时：finishReason=timeout 且不抛异常', async () => {
    const { server, port } = await startFixture(() => { /* 挂起不响应 */ });
    servers.push(server);
    const channel = new VisionChannel(fixtureLlm(api, port), { providerId: 'vision-prov' });
    const result = await channel.describe({ bytes: TINY_PNG, mime: 'image/png', prompt: 'p' }, { timeoutMs: 150 });
    expect(result.finishReason).toBe('timeout');
    expect(result.errorMessage).toMatch(/timed out after 150ms/);
  });
});

describe('VisionChannel[通用]', () => {
  it('配置缺失（apiKey/baseUrl/model 为空）不触网直接 error', async () => {
    const channel = new VisionChannel({
      openAiCompatBaseUrl: '', apiKey: '', model: '',
      providers: [{ id: 'p', name: 'P', enabled: true, apiKey: '', openAiCompatBaseUrl: '', models: [{ id: 'm', name: 'M', enabled: true, openAiModel: '' }] }],
    } as unknown as LlmConfig, { providerId: 'p' });
    const result = await channel.describe({ bytes: TINY_PNG, mime: 'image/png', prompt: 'p' }, { timeoutMs: 1000 });
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/apiKey is empty/);
  });

  it('按 selection.modelId 切换预设（vision-model-alt）', async () => {
    const { server, port, calls } = await startFixture((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(wireSuccess('openai-completions', 'vision-model-alt', 'ok-alt')));
    });
    servers.push(server);
    const channel = new VisionChannel(fixtureLlm('openai-completions', port), { providerId: 'vision-prov', modelId: 'alt' });
    const result = await channel.describe({ bytes: TINY_PNG, mime: 'image/png', prompt: 'p' }, { timeoutMs: 5000 });
    expect(result.model).toBe('vision-model-alt');
    expect(result.text).toBe('ok-alt');
    expect(calls[0].body.max_tokens).toBe(512); // alt 预设的 maxTokens
  });

  it('外部 signal 已中止 → error(aborted by caller)', async () => {
    const { server, port, calls } = await startFixture((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(wireSuccess('openai-completions', 'vision-model', 'x')));
    });
    servers.push(server);
    const controller = new AbortController();
    controller.abort();
    const channel = new VisionChannel(fixtureLlm('openai-completions', port), { providerId: 'vision-prov' });
    const result = await channel.describe({ bytes: TINY_PNG, mime: 'image/png', prompt: 'p' }, { timeoutMs: 5000, signal: controller.signal });
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/aborted by caller/);
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
