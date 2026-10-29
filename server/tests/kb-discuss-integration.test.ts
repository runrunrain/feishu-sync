/** Real Discuss Pi RPC + forwarding extension + internal HTTP; the model and release are synthetic. */
import { expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { SessionService } from '../src/agent/session-service.js';
import { piExtensionPath } from '../src/agent/agent-assets.js';
import { agentInternalRoutes } from '../src/routes/agent-internal.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';

it('forwards search, section read and literal grep through a real Discuss session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-discuss-live-'));
  vi.stubEnv('FEISHU_SYNC_HOME', root);
  vi.stubEnv('FEISHU_KB_RANKER', 'lex-v1');
  const pool = new AgentProcessPool();
  let store: LocalMapStore | undefined;
  let internal: ReturnType<typeof serve> | undefined;
  let llm: http.Server | undefined;
  try {
    const config = await new ConfigManager(path.join(root, 'config.json')).load();
    config.agent.runtime.backend = 'pi';
    const resolver = new PiRuntimeResolver();
    const runtime = await resolver.resolveRuntime(config.agent);
    expect(runtime.nodePath, 'Node runtime required for real Pi').toBeTruthy();
    expect(runtime.piCliPath, 'Pi CLI required for real session').toBeTruthy();
    const raw = path.join(root, 'raw'); fs.mkdirSync(raw);
    const output = path.join(root, 'published');
    writeSearchRelease(output, 'fixture-release', [
      { path: '战斗/伤害.md', title: '伤害', docId: 'damage', body: '# 伤害\n## 暴击\n伤害按暴击倍率结算。\n### 技能表\n| skill_id | 倍率 |\n| --- | --- |\n| 1001 | 120% |\n## 护甲\n护甲减伤。\n' },
      { path: '战斗系统/引用.md', title: '引用', body: '# 引用\n## 说明\n暴击 1001 的引用。\n' },
    ]);
    config.knowledgeBaseRoot = raw; config.standardKb.outputRoot = output;
    store = new LocalMapStore(path.join(root, 'db.sqlite')); store.initialize();

    const requests: Array<{ tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; tool_call_id?: string; content?: string }>; model: string }> = [];
    const steps = [
      { name: 'kb_search', args: { query: '暴击 伤害', pathPrefix: '战斗', limit: 10 } },
      { name: 'kb_read', args: { docId: 'damage', section: '暴击 › 技能表', offset: 1, limit: 3 } },
      { name: 'kb_grep', args: { pattern: '1001', mode: 'literal', pathPrefix: '战斗', context: 0, maxMatches: 10 } },
    ];
    llm = http.createServer(async (req, res) => {
      let bytes = ''; for await (const part of req) bytes += part;
      const body = JSON.parse(bytes); requests.push(body);
      const step = steps[requests.length - 1];
      const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      const delta = step ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
        : { role: 'assistant', content: 'FIXTURE_COMPLETE' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame(delta, null) + frame({}, step ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => llm!.listen(0, '127.0.0.1', resolve));
    const port = (llm.address() as AddressInfo).port;
    config.agent.model.source = 'app-llm'; config.agent.model.providerId = 'fixture'; config.agent.model.modelId = 'fixture';
    config.llm.providers = [{ id: 'fixture', name: 'Local fixture', enabled: true, protocol: 'openai-completions', apiKey: 'fixture-only', openAiCompatBaseUrl: `http://127.0.0.1:${port}/v1`, defaultModelId: 'fixture', models: [{ id: 'fixture', name: 'fixture', enabled: true, openAiModel: 'fixture', contextWindow: 64000, maxTokens: 2048 }] }];

    const tools = new AgentToolService({ dataRoot: root, documentsProvider: () => [] });
    const app = new Hono();
    const forwarded: Array<{ name: string; body: unknown; status: number; response: any }> = [];
    app.use('/api/agent-internal/tools/*', async (c, next) => {
      if (c.req.method !== 'POST') { await next(); return; }
      const body = await c.req.raw.clone().json();
      await next();
      forwarded.push({ name: c.req.path.split('/').at(-1)!, body, status: c.res.status, response: await c.res.clone().json() });
    });
    app.route('/', agentInternalRoutes(tools));
    let internalPort = 0;
    internal = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => { internalPort = info.port; resolve(server); });
    });
    const sessions = new SessionService({ dataRoot: root, pool, toolService: tools, resolver, configProvider: () => config,
      internalBaseUrl: () => `http://127.0.0.1:${internalPort}`, extensionPath: piExtensionPath,
      workspaceGuards: () => ({ dataRoot: root, knowledgeBaseRoot: raw, outputRoot: output }) });
    const session = sessions.create(store, { title: 'Synthetic retrieval', mode: 'discuss', backend: 'pi' });
    expect(session.backend).toBe('pi'); expect(session.mode).toBe('discuss');
    await sessions.sendMessage(store, session.id, { text: 'Search then read the selected section.' });
    await vi.waitFor(() => expect(sessions.isRunning(session.id)).toBe(false), { timeout: 35000, interval: 25 });
    expect(sessions.get(store, config, session.id)?.lastError).toBeFalsy();
    expect(requests).toHaveLength(4);
    expect(requests.every((r) => r.model === 'fixture')).toBe(true);
    const allowed = requests[0].tools.map((t) => t.function.name);
    expect(allowed.sort()).toEqual(['kb_grep', 'kb_read', 'kb_search', 'raw_comments', 'raw_links', 'raw_read', 'raw_read_image', 'raw_search'].sort());
    expect(forwarded.map((f) => f.name)).toEqual(steps.map((s) => s.name));
    for (const [i, item] of forwarded.entries()) {
      expect(item.status).toBe(200);
      expect(item.body).toEqual({ toolCallId: `call_${i + 1}`, args: steps[i].args });
    }
    const search = JSON.parse(forwarded[0].response.content[0].text);
    expect(search.releaseId).toBe('fixture-release');
    expect(search.results.map((r: { path: string }) => r.path)).toEqual(['战斗/伤害.md']);
    expect(search.results[0].hits).toEqual(expect.arrayContaining([expect.objectContaining({ anchor: '战斗/伤害.md#暴击', line: 3 })]));
    const read = forwarded[1].response;
    expect(read.details).toMatchObject({ docId: 'damage', path: '战斗/伤害.md', releaseId: 'fixture-release', offset: 1, returnedLines: 3 });
    expect(read.content[0].text).toContain('lines="5-7/');
    expect(read.content[0].text).toContain('     5\t| skill_id | 倍率 |');
    expect(read.content[0].text).toContain('     7\t| 1001 | 120% |');
    expect(read.content[0].text).not.toContain('护甲');
    expect(read.content[0].text).not.toContain('伤害按暴击');
    const grep = JSON.parse(forwarded[2].response.content[0].text);
    expect(grep).toMatchObject({ releaseId: 'fixture-release', totalMatches: 1, totalFiles: 1, complete: true });
    expect(grep.files[0]).toMatchObject({ path: '战斗/伤害.md', matches: [expect.objectContaining({ line: 7, text: '| 1001 | 120% |' })] });
    for (let i = 0; i < steps.length; i++) {
      expect(requests[i + 1].messages.find((m) => m.role === 'tool' && m.tool_call_id === `call_${i + 1}`)?.content).toBe(forwarded[i].response.content[0].text);
    }
    expect(JSON.stringify(sessions.messages(store, session.id))).toContain('FIXTURE_COMPLETE');
  } finally {
    await pool.closeAll();
    store?.close();
    if (internal) await new Promise<void>((resolve) => internal!.close(() => resolve()));
    if (llm) await new Promise<void>((resolve) => llm!.close(() => resolve()));
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
