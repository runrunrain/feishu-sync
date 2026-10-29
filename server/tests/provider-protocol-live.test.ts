import { ContentBackendRegistry } from '../src/modules/content-backend-registry.js';
/** Real Pi, native wire adapters, SessionService and full standard-library publication. No remote models. */
import { afterAll, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { agentInternalRoutes } from '../src/routes/agent-internal.js';
import { piExtensionPath } from '../src/agent/agent-assets.js';
import { SessionService } from '../src/agent/session-service.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import type { LlmProtocol } from '../src/types/index.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
interface Call { name: string; args: Record<string, unknown> }
/** Wire fixtures deliberately match each vendor protocol, including native tool-call events. */
function wire(api: LlmProtocol, model: string, text: string, tool?: Call): string {
  const args = JSON.stringify(tool?.args ?? {}); const callId = 'call_fixture';
  if (api === 'openai-completions') {
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool.name, arguments: args } }] } : { role: 'assistant', content: text }, null)
      + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n';
  }
  const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  if (api === 'openai-responses') {
    const item = tool ? { type: 'function_call', id: 'fc_fixture', call_id: callId, name: tool.name, arguments: args, status: 'completed' }
      : { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    return event('response.created', { response: { id: 'r', model, status: 'in_progress', output: [] } })
      + event('response.output_item.added', { output_index: 0, item: tool ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } })
      + (tool ? event('response.function_call_arguments.delta', { output_index: 0, delta: args }) : event('response.output_text.delta', { output_index: 0, content_index: 0, delta: text }))
      + event('response.output_item.done', { output_index: 0, item })
      + event('response.completed', { response: { id: 'r', model, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } });
  }
  return event('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } })
    + event('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: callId, name: tool.name, input: {} } : { type: 'text', text: '' } })
    + event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: args } : { type: 'text_delta', text } })
    + event('content_block_stop', { index: 0 })
    + event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    + event('message_stop', {});
}

it.for<LlmProtocol>(['openai-completions', 'openai-responses', 'anthropic-messages'])('%s: session and full KB build use the selected protocol/preset', async (api, ctx) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-live-')); roots.push(root);
  const manager = new ConfigManager(path.join(root, 'config.json')); const config = await manager.load();
  config.agent.runtime.backend = 'pi';
  const resolver = new PiRuntimeResolver(); const runtime = await resolver.resolveRuntime(config.agent);
  if (!runtime.nodePath || !runtime.piCliPath) { ctx.skip(); return; }
  const raw = path.join(root, 'raw'); fs.mkdirSync(raw); const source = '# 阅读规则\n阅读时应先掌握基础规则，再结合实际情境理解细节。';
  const file = path.join(raw, '规则.md'); fs.writeFileSync(file, source);
  const store = new LocalMapStore(path.join(root, 'db.sqlite')); store.initialize();
  store.upsertDocument({ objToken: 'protocol-source', objType: 'docx', title: '阅读规则', localMdPath: file, localRelPath: '规则.md', lastSyncedAt: new Date().toISOString(), lastSyncedModifyTime: 'fixture', status: 'synced' });
  const calls: Array<{ url: string; auth?: string; key?: string; body: any }> = []; let buildStep = 0; let adaptationMode: 'normal' | 'length' | 'cut' | 'error' | 'delay' = 'normal';
  const endpoint = http.createServer(async (req, res) => {
    let bytes = ''; for await (const part of req) bytes += part; const body = JSON.parse(bytes || '{}');
    calls.push({ url: req.url!, auth: req.headers.authorization, key: req.headers['x-api-key'] as string, body });
    if (adaptationMode === 'delay') return;
    if (adaptationMode === 'error') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Denied protocol-fixture-key', type: 'invalid_request_error' } })); return; }
    if (adaptationMode === 'cut') {
      const full = wire(api, body.model, 'partial content');
      const marker = api === 'anthropic-messages' ? 'event: message_delta' : api === 'openai-responses' ? 'event: response.completed' : 'data:';
      const end = api === 'openai-completions' ? full.indexOf(marker, 6) : full.indexOf(marker);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(full.slice(0, end)); return;
    }
    const isBuild = (body.tools ?? []).some((t: any) => (t.name ?? t.function?.name) === 'kb_write_doc');
    let tool: Call | undefined;
    if (isBuild) {
      buildStep++;
      if (buildStep === 1) tool = { name: 'raw_read', args: { objToken: 'protocol-source' } };
      if (buildStep === 2) tool = { name: 'kb_write_doc', args: { path: '阅读指南.md', title: '阅读指南', summary: '基础阅读方法', tags: ['阅读'], sources: ['protocol-source'], markdown: '# 阅读指南\n\n阅读时应先掌握基础规则，再结合实际情境理解细节。' } };
      if (buildStep === 4) tool = { name: 'kb_finish', args: { summary: '整理阅读方法', skipped: [] } };
    }
    if (body.stream !== true) {
      const text = `PROTOCOL_ACK_${api}`; res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(api === 'anthropic-messages' ? { id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: adaptationMode === 'length' ? 'max_tokens' : 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }
        : api === 'openai-responses' ? { id: 'r', object: 'response', status: adaptationMode === 'length' ? 'incomplete' : 'completed', incomplete_details: adaptationMode === 'length' ? { reason: 'max_output_tokens' } : null, model: body.model, output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } }
        : { id: 'c', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: adaptationMode === 'length' ? 'length' : 'stop' }], usage: { total_tokens: 10 } }));
    } else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(wire(api, body.model, `PROTOCOL_ACK_${api}`, tool)); }
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const port = (endpoint.address() as AddressInfo).port;
  const pool = new AgentProcessPool(); const tools = new AgentToolService({ dataRoot: root, documentsProvider: () => store.getAllDocuments() });
  const app = new Hono(); app.route('/', agentInternalRoutes(tools)); let internalPort = 0;
  const internal = await new Promise<ReturnType<typeof serve>>((resolve) => { const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => { internalPort = info.port; resolve(s); }); });
  config.knowledgeBaseRoot = raw; config.standardKb.outputRoot = path.join(root, 'standard');
  config.agent.model.source = 'app-llm'; config.agent.model.providerId = 'gateway'; config.agent.model.modelId = 'preset';
  config.llm.providers = [{ id: 'gateway', name: 'Fixture', enabled: true, protocol: api, apiKey: 'protocol-fixture-key', openAiCompatBaseUrl: `http://127.0.0.1:${port}${api === 'anthropic-messages' ? '' : '/v1'}`, defaultModelId: 'preset', models: [{ id: 'preset', name: 'Fixture', enabled: true, openAiModel: 'protocol-model', contextWindow: 64000, maxTokens: 2048 }] }];
  const shared = { dataRoot: root, pool, toolService: tools, resolver, configProvider: () => config, internalBaseUrl: () => `http://127.0.0.1:${internalPort}`, extensionPath: piExtensionPath };
  const sessions = new SessionService({ ...shared, workspaceGuards: () => ({ dataRoot: root, knowledgeBaseRoot: raw, outputRoot: config.standardKb.outputRoot }) });
  const builds = new KbBuildService({ ...shared, documentsProvider: () => store.getAllDocuments(), sheetCsvPaths: () => [], promptAssets: () => null });
  try {
    const session = sessions.create(store, { title: 'Protocol fixture' }); await sessions.sendMessage(store, session.id, { text: 'Reply with acknowledgement' });
    await vi.waitFor(() => expect(sessions.isRunning(session.id)).toBe(false), { timeout: 30000, interval: 25 });
    expect(sessions.get(store, config, session.id)?.lastError).toBeFalsy();
    expect(JSON.stringify(sessions.messages(store, session.id))).toContain(`PROTOCOL_ACK_${api}`);
    const build = await builds.createBuild(store, { mode: 'full', confirm: 'BUILD' });
    await vi.waitFor(() => expect(builds.hasActiveRun()).toBe(false), { timeout: 30000, interval: 25 });
    expect(store.getKbBuild(build.id)?.status, JSON.stringify(store.getKbBuild(build.id))).toBe('published');
    const kb = new StandardKbStore(config.standardKb.outputRoot); const current = kb.readCurrent()!;
    expect(kb.readManifest(current.releaseId)?.docs).toHaveLength(1); expect(fs.readFileSync(file, 'utf8')).toBe(source);
    const adapter = new ContentBackendRegistry({ llm: config.llm, selection: config.agent.model }).get();
    const direct = await adapter.adapt({ rawContent: source, localOldContent: null, options: { enableStreaming: false, timeoutMs: 5000 } });
    expect(direct.finishReason, direct.errorMessage).toBe('stop'); expect(direct.adaptedMarkdown).toContain(`PROTOCOL_ACK_${api}`); expect(direct.tokensUsed).toBe(10);
    const pieces: string[] = [];
    const streamed = await adapter.adapt({ rawContent: source, localOldContent: null, options: { enableStreaming: true, onProgress: (chunk) => pieces.push(chunk), timeoutMs: 5000 } });
    expect(streamed.finishReason, streamed.errorMessage).toBe('stop'); expect(pieces.join('')).toBe(streamed.adaptedMarkdown); expect(streamed.adaptedMarkdown).toContain(`PROTOCOL_ACK_${api}`);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    const expected = api === 'anthropic-messages' ? '/v1/messages' : api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions';
    for (const call of calls) {
      expect(call.url.split('?')[0]).toBe(expected); expect(call.body.model).toBe('protocol-model');
      expect(call.body.max_output_tokens ?? call.body.max_completion_tokens ?? call.body.max_tokens).toBe(2048);
      expect(api === 'anthropic-messages' ? call.key : call.auth).toBe(api === 'anthropic-messages' ? 'protocol-fixture-key' : 'Bearer protocol-fixture-key');
      expect(JSON.stringify(call.body)).not.toContain('protocol-fixture-key');
    }
    config.llm.providers![0].models.push({ id: 'session-alt', name: 'Session alternate', enabled: true, openAiModel: 'protocol-model-alt', contextWindow: 64000, maxTokens: 4096, reasoning: true });
    const oldProcess = pool.get(session.id)!.id;
    const selected = sessions.setModel(store, session.id, { source: 'app-llm', providerId: 'gateway', modelId: 'session-alt', thinkingLevel: 'low' });
    expect(selected.model?.modelId).toBe('session-alt'); expect(sessions.get(store, config, session.id)?.model?.thinkingLevel).toBe('low');
    await sessions.sendMessage(store, session.id, { text: 'Use the selected session model' });
    expect(() => sessions.setModel(store, session.id, null)).toThrow('运行结束后');
    await vi.waitFor(() => expect(sessions.isRunning(session.id)).toBe(false), { timeout: 30000, interval: 25 });
    expect(sessions.get(store, config, session.id)?.lastError).toBeFalsy();
    expect(pool.get(session.id)!.id).not.toBe(oldProcess); expect(calls.at(-1)!.body.model).toBe('protocol-model-alt');
    expect(config.agent.model.modelId).toBe('preset'); expect(config.agent.model.thinkingLevel).toBe('off');
    expect(calls.at(-1)!.body.reasoning_effort ?? calls.at(-1)!.body.reasoning?.effort ?? calls.at(-1)!.body.thinking?.type).toBe(api === 'anthropic-messages' ? 'enabled' : 'low');
    sessions.setModel(store, session.id, null);
    await sessions.sendMessage(store, session.id, { text: 'Follow defaults again' });
    await vi.waitFor(() => expect(sessions.isRunning(session.id)).toBe(false), { timeout: 30000, interval: 25 });
    expect(calls.at(-1)!.body.model).toBe('protocol-model');
    expect(JSON.stringify(sessions.messages(store, session.id))).toContain('Use the selected session model');
    adaptationMode = 'length';
    expect((await adapter.adapt({ rawContent: source, localOldContent: null, options: {} })).finishReason).toBe('length');
    adaptationMode = 'cut';
    expect((await adapter.adapt({ rawContent: source, localOldContent: null, options: { enableStreaming: true, onProgress: () => {} } })).finishReason).toBe('error');
    adaptationMode = 'error';
    const denied = await adapter.adapt({ rawContent: source, localOldContent: null, options: {} });
    expect(denied.finishReason).toBe('error'); expect(denied.errorMessage).not.toContain('protocol-fixture-key');
    adaptationMode = 'delay';
    expect((await adapter.adapt({ rawContent: source, localOldContent: null, options: { timeoutMs: 60 } })).finishReason).toBe('timeout');

  } finally { await pool.closeAll(); store.close(); await new Promise<void>((r) => internal.close(() => r())); await new Promise<void>((r) => endpoint.close(() => r())); }
}, 90000);
