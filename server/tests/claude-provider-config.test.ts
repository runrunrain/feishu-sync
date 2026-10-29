import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ConfigManager } from '../src/modules/config-manager.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { resolveClaudeCodePath } from '../src/agent/claude-runtime.js';
import { buildClaudeEnvironment, type ClaudeCodeOptions } from '../src/agent/claude-code-process.js';
import { testClaudeConnection } from '../src/agent/claude-connection-test.js';
import { agentInternalRoutes } from '../src/routes/agent-internal.js';

it('launch environment uses only app credentials and pins native model aliases to the preset', () => {
  const base = { apiKey: 'app-key', model: 'chosen-model', baseUrl: 'https://gateway.example/anthropic', parentEnv: {
    ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_AUTH_TOKEN: 'old-token', ANTHROPIC_MODEL: 'old-model',
    CLAUDE_CODE_USE_BEDROCK: '1', HTTP_PROXY: 'http://proxy.example',
  } } as ClaudeCodeOptions;
  const bearer = buildClaudeEnvironment({ ...base, authType: 'auth-token' });
  expect(bearer.ANTHROPIC_AUTH_TOKEN).toBe('app-key');
  expect(bearer.ANTHROPIC_API_KEY).toBeUndefined();
  expect(bearer.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  expect(bearer.HTTP_PROXY).toBe('http://proxy.example');
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) expect(bearer[name]).toBe('chosen-model');
  const key = buildClaudeEnvironment({ ...base, authType: 'api-key' });
  expect(key.ANTHROPIC_API_KEY).toBe('app-key'); expect(key.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
});

function wire(model: string) {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } })
    + event('content_block_stop', { index: 0 })
    + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    + event('message_stop', {});
}

const executable = resolveClaudeCodePath();
it.skipIf(!executable).each(['api-key', 'auth-token'] as const)('saved app config → Claude CLI → wire request uses %s and its Anthropic URL/preset', async (authType) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-provider-config-'));
  const calls: Array<{ url: string; key?: string; auth?: string; body: Record<string, any> }> = [];
  let reject = false;
  const endpoint = http.createServer(async (req, res) => {
    let bytes = ''; for await (const part of req) bytes += part;
    calls.push({ url: req.url!, key: req.headers['x-api-key'] as string, auth: req.headers.authorization, body: JSON.parse(bytes || '{}') });
    const authorized = authType === 'auth-token' ? req.headers.authorization === 'Bearer fixture-key' && !req.headers['x-api-key']
      : req.headers['x-api-key'] === 'fixture-key' && !req.headers.authorization;
    if (reject || !authorized) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Rejected fixture-key' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(wire('app-configured-model'));
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const port = (endpoint.address() as AddressInfo).port;
  const manager = new ConfigManager(path.join(root, 'config.json')); await manager.load();
  const config = await manager.updateConfig({ agent: { ...manager.getConfig().agent,
    runtime: { backend: 'pi', claudeCliPath: executable! }, model: { ...manager.getConfig().agent.model, source: 'pi-agent-dir', providerId: 'fixture', modelId: 'chosen' } },
    llm: { providers: [{ id: 'fixture', name: '应用提供商', enabled: true, apiKey: 'fixture-key', protocol: 'openai-completions',
      openAiCompatBaseUrl: `http://127.0.0.1:${port}/openai/v1`, protocolBaseUrls: { 'anthropic-messages': `http://127.0.0.1:${port}/anthropic` }, anthropicAuthType: authType,
      defaultModelId: 'default', models: [{ id: 'default', name: 'Default', openAiModel: 'wrong-model', enabled: true },
        { id: 'chosen', name: 'Chosen', openAiModel: 'app-configured-model', enabled: true, contextWindow: 64000, maxTokens: 512 }] }] } });
  const pool = new AgentProcessPool();
  const tools = new AgentToolService({ dataRoot: root, documentsProvider: () => [] });
  const context = vi.spyOn(tools, 'createRunContext');
  const app = new Hono(); app.route('/', agentInternalRoutes(tools));
  const internal = await new Promise<ReturnType<typeof serve>>((resolve) => { const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(server)); });
  const input = { config, dataRoot: root, pool, toolService: tools, resolver: new PiRuntimeResolver(), internalBaseUrl: `http://127.0.0.1:${(internal.address() as AddressInfo).port}` };
  try {
    const result = await testClaudeConnection(input);
    expect(result).toMatchObject({ ok: true, providerName: '应用提供商', model: 'app-configured-model' });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.url.startsWith('/anthropic/v1/messages'))).toBe(true);
    expect(calls.at(-1)?.body.model).toBe('app-configured-model');
    expect(calls.at(-1)?.body.max_tokens).toBe(512);
    expect(calls.at(-1)?.body.tools ?? []).toHaveLength(0);
    expect(manager.getConfig().agent.runtime.backend).toBe('pi');
    expect(pool.loadCount()).toBe(0);
    const token = context.mock.results[0].value.token;
    expect(tools.getToolSpecsForToken(token)).toBeNull();
    expect(JSON.stringify(result)).not.toContain('fixture-key');
    expect(fs.readdirSync(path.join(root, 'agent', 'sessions', 'claude-ephemeral'))).toHaveLength(0);
    reject = true;
    const failed = await testClaudeConnection(input);
    expect(failed.ok).toBe(false);
    expect(failed.errorMessage).toContain('认证失败');
    expect(failed.errorMessage).not.toContain('fixture-key');
    expect(pool.loadCount()).toBe(0);
  } finally {
    await new Promise<void>((resolve) => internal.close(() => resolve()));
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
