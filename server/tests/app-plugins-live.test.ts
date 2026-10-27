/** 真实Pi + 本地SSE；验证实际扩展加载与会话重启，无远端模型/真实凭据。 */
import { afterAll, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { PiPluginService } from '../src/agent/pi-plugin-service.js';
import { AppPluginStore } from '../src/agent/app-plugin-store.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { SessionService } from '../src/agent/session-service.js';
import { piExtensionPath } from '../src/agent/agent-assets.js';
import { agentInternalRoutes } from '../src/routes/agent-internal.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-plugin-live-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('真实Pi插件快照进入system；运行中编辑不改变当前任务，后续运行重启且停用不残留，未变则复用', async (ctx) => {
  const manager = new ConfigManager(path.join(root, 'config.json')); const config = await manager.load();
  const resolver = new PiRuntimeResolver(); const runtime = await resolver.resolveRuntime(config.agent);
  if (!runtime.nodePath || !runtime.piCliPath) { ctx.skip(); return; }
  const store = new LocalMapStore(path.join(root, 'db.sqlite')); store.initialize();
  const pool = new AgentProcessPool();
  const fixturePackage = path.join(root, 'native-fixture'); fs.mkdirSync(fixturePackage);
  fs.writeFileSync(path.join(fixturePackage, 'package.json'), JSON.stringify({ name: '@fixture/native-live', type: 'module', pi: { extensions: ['./index.ts'] } }));
  fs.writeFileSync(path.join(fixturePackage, 'index.ts'), `export default function(pi) {
    pi.on('before_agent_start', (event) => ({systemPrompt:event.systemPrompt+' NATIVE_EXTERNAL_CONTEXT'}));
    pi.registerTool({name:'plugin_echo', label:'Plugin Echo', description:'Native plugin fixture', parameters:{type:'object',properties:{message:{type:'string'}},required:['message']},
      async execute(id,args){return {content:[{type:'text',text:'NATIVE_TOOL_RESULT:'+args.message}],details:{}};}});
  }`);
  const native = new PiPluginService({ dataRoot: root, resolver, agentConfig: () => config.agent, running: () => false, retireIdle: () => pool.retireIdle() });
  const nativeState = await native.refresh();
  await native.mutate('install', { source: fixturePackage, expectedRevision: nativeState.revision });
  const plugins = new AppPluginStore(root, () => ({ buildRules: 'BUILD_ONLY', styleGuide: 'STYLE_ONLY' }), () => native.runtimeResources());
  plugins.mutate('update', 'discuss-context', plugins.list().revision, { content: 'PLUGIN_CONTEXT_A_7f91' });
  const requests: any[] = [];
  let releaseFirst: (() => void) | undefined;
  const llm = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const respond = () => {
        if (res.writableEnded || res.destroyed) return;
        const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'plugin-local', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(requests.length === 4
          ? frame({role:'assistant',tool_calls:[{index:0,id:'native_tool_1',type:'function',function:{name:'plugin_echo',arguments:'{"message":"NATIVE_TOOL_PAYLOAD"}'}}]},null)+frame({},'tool_calls')+'data: [DONE]\n\n'
          : frame({ role: 'assistant', content: 'PLUGIN_FIXTURE_OK' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n');
      };
      if (requests.length === 1) releaseFirst = respond;
      else respond();
    });
  });
  await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve));
  const llmPort = (llm.address() as AddressInfo).port;
  config.llm.providers = [{ id: 'local', name: 'Local Fixture', enabled: true, apiKey: 'plugin-local-sentinel',
    openAiCompatBaseUrl: `http://127.0.0.1:${llmPort}/v1`, defaultModelId: 'fixture',
    models: [{ id: 'fixture', name: 'Fixture', openAiModel: 'fixture', enabled: true }] }] as never;
  config.agent.model.source = 'app-llm';
  config.agent.model.providerId = 'local'; config.agent.model.modelId = 'fixture';
  config.agent.model.contextWindow = 8192; config.agent.model.maxTokens = 512;
  const tools = new AgentToolService({ dataRoot: root, documentsProvider: () => [] });
  const app = new Hono(); app.route('/', agentInternalRoutes(tools));
  let port = 0;
  const internal = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => { port = info.port; resolve(server); });
  });
  const service = new SessionService({ dataRoot: root, pool, toolService: tools, resolver, configProvider: () => config,
    internalBaseUrl: () => `http://127.0.0.1:${port}`, extensionPath: piExtensionPath, pluginStore: plugins,
    workspaceGuards: () => ({ dataRoot: root, knowledgeBaseRoot: '', outputRoot: '' }) });
  const session = service.create(store, { title: '插件验收' });
  const complete = async (message: string, count: number) => {
    await service.sendMessage(store, session.id, { text: message });
    await vi.waitFor(() => { expect(requests).toHaveLength(count); expect(service.isRunning(session.id)).toBe(false); }, { timeout: 35000, interval: 25 });
    expect(service.get(store, config, session.id)?.lastError).toBeFalsy();
    return pool.get(session.id)!.id;
  };
  try {
    await service.sendMessage(store, session.id, { text: '第一轮' });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'), { timeout: 35000, interval: 25 });
    plugins.mutate('update', 'discuss-context', plugins.list().revision, { content: 'PLUGIN_CONTEXT_B_83ad' });
    const firstId = pool.get(session.id)!.id;
    releaseFirst!();
    await vi.waitFor(() => expect(service.isRunning(session.id)).toBe(false), { timeout: 10000, interval: 25 });
    const systems = (index: number) => JSON.stringify(requests[index].messages.filter((message: any) => message.role === 'system' || message.role === 'developer'));
    expect(systems(0)).toContain('PLUGIN_CONTEXT_A_7f91'); expect(systems(0)).not.toContain('PLUGIN_CONTEXT_B_83ad');
    const secondId = await complete('第二轮', 2); expect(secondId).not.toBe(firstId);
    expect(systems(1)).toContain('PLUGIN_CONTEXT_B_83ad'); expect(systems(1)).not.toContain('PLUGIN_CONTEXT_A_7f91');
    expect(systems(1)).not.toContain('BUILD_ONLY');
    plugins.mutate('update', 'discuss-context', plugins.list().revision, { enabled: false });
    const thirdId = await complete('第三轮', 3); expect(thirdId).not.toBe(secondId);
    expect(systems(2)).not.toContain('PLUGIN_CONTEXT_');
    expect(await complete('第四轮', 5)).toBe(thirdId);
    expect(JSON.stringify(requests[4].messages)).toContain('NATIVE_TOOL_RESULT:NATIVE_TOOL_PAYLOAD');
    const allowed = requests[0].tools.map((tool: any) => tool.function.name);
    expect(allowed).toEqual(expect.arrayContaining(['kb_search', 'kb_read', 'raw_search', 'raw_read']));
    expect(allowed).toContain('plugin_echo');
    expect(systems(0)).toContain('NATIVE_EXTERNAL_CONTEXT');
    expect(allowed).not.toContain('bash'); expect(allowed).not.toContain('ws_write');
  } finally {
    releaseFirst?.(); await pool.closeAll();
    await new Promise<void>((resolve) => internal.close(() => resolve()));
    await new Promise<void>((resolve) => llm.close(() => resolve()));
  }
}, 120000);
