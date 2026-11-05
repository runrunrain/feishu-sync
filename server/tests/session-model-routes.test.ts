import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { SessionService } from '../src/agent/session-service.js';
import { agentRoutes } from '../src/routes/agent.js';
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-model-route-'));
  const manager = new ConfigManager(path.join(root, 'config.json')); await manager.load();
  await manager.updateConfig({ agent: { ...manager.getConfig().agent, runtime: { ...manager.getConfig().agent.runtime, backend: 'pi' } } });
  await manager.updateConfig({ llm: { providers: [{ id: 'fixture', name: 'Fixture', enabled: true, apiKey: 'route-fixture-secret', protocol: 'openai-responses', openAiCompatBaseUrl: 'http://127.0.0.1:9999/v1', defaultModelId: 'fast', models: [
    { id: 'fast', name: 'Fast', openAiModel: 'fast-code', enabled: true, reasoning: false },
    { id: 'deep', name: 'Deep', openAiModel: 'deep-code', enabled: true, reasoning: true, thinkingLevels: ['low', 'high', 'xhigh', 'max'] },
    { id: 'disabled', name: 'Disabled', openAiModel: 'disabled-code', enabled: false },
  ] }], activeProviderId: 'fixture', activeModelId: 'fast' } } as never);
  const dbPath = path.join(root, 'db.sqlite');
  let store = new LocalMapStore(dbPath); store.initialize(); const pool = new AgentProcessPool(); const resolver = new PiRuntimeResolver();
  const tools = new AgentToolService({ dataRoot: root, documentsProvider: () => [] });
  const makeService = () => new SessionService({ dataRoot: root, pool, resolver, toolService: tools, configProvider: () => manager.getConfig(), internalBaseUrl: () => '', extensionPath: () => null, workspaceGuards: () => ({ dataRoot: root, knowledgeBaseRoot: '', outputRoot: '' }) });
  const service = makeService();
  const app = await agentRoutes({ sessionService: service, resolver, toolService: tools, pool, configManager: manager, localMapStore: store, internalPort: () => null });
  cleanups.push(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = service.create(store, { title: 'Fixture' }); const other = service.create(store, { title: 'Other' });
  const patch = (model: unknown, id = session.id) => app.fetch(new Request(`http://x/api/agent/sessions/${id}/model`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }));
  const restart = () => {
    store.close();
    store = new LocalMapStore(dbPath);
    store.initialize();
    return { store, service: makeService() };
  };
  return { app, manager, store, service, session, other, patch, restart };
}
it('local resources route accepts only idle Pi work sessions and persists the choice', async () => {
  const f = await fixture();
  const put = (id: string, enabled: unknown) => f.app.fetch(new Request(`http://x/api/agent/sessions/${id}/local-resources`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }));
  expect((await put(f.session.id, true)).status).toBe(400);
  f.store.updateAgentSession(f.session.id, { mode: 'work' });
  expect((await put(f.session.id, 'true')).status).toBe(400);
  const result = await put(f.session.id, true); expect(result.status).toBe(200); expect((await result.json()).localResources).toBe(true);
  expect(f.store.getAgentSession(f.session.id)?.local_resources).toBe(1);
  const claude = f.service.create(f.store, { backend: 'claude-code' }); f.store.updateAgentSession(claude.id, { mode: 'work' });
  expect((await put(claude.id, true)).status).toBe(400);
  vi.spyOn(f.service, 'isRunning').mockReturnValue(true);
  expect((await put(f.session.id, false)).status).toBe(409);
  expect(f.store.getAgentSession(f.session.id)?.local_resources).toBe(1);
});
it('catalog exposes only usable presets; model/effort persists per session without changing global config or another session', async () => {
  const f = await fixture(); const before = fs.readFileSync((f.manager as unknown as { configPath: string }).configPath, 'utf8');
  const catalog = await f.app.fetch(new Request('http://x/api/agent/models')); const data = await catalog.json();
  expect(data.items.map((m: any) => m.modelId)).toEqual(['fast', 'deep']); expect(JSON.stringify(data)).not.toContain('route-fixture-secret');
  const response = await f.patch({ source: 'app-llm', providerId: 'fixture', modelId: 'deep', thinkingLevel: 'high', apiKey: 'ignored', contextWindow: 999 });
  expect(response.status).toBe(200); const result = await response.json();
  expect(result.model).toEqual({ source: 'app-llm', providerId: 'fixture', modelId: 'deep', thinkingLevel: 'high' });
  expect(f.service.get(f.store, f.manager.getConfig(), f.session.id)?.model).toEqual(result.model);
  expect(f.service.get(f.store, f.manager.getConfig(), f.other.id)?.model).toBeNull();
  expect(fs.readFileSync((f.manager as unknown as { configPath: string }).configPath, 'utf8')).toBe(before);
  expect(f.service.configForSession(f.store, f.session.id).agent.model.thinkingLevel).toBe('high');
  expect((await f.patch({ source: 'app-llm', providerId: 'fixture', modelId: 'deep', thinkingLevel: 'max' })).status).toBe(200);
  expect((await f.patch(null)).status).toBe(200); expect(f.service.get(f.store, f.manager.getConfig(), f.session.id)?.model).toBeNull();
  expect(f.service.create(f.store, { backend: 'pi' }).model).toBeNull();
});

it('restores session choices from disk and inherits the latest preferences in new sessions', async () => {
  const f = await fixture();
  const model = { source: 'app-llm', providerId: 'fixture', modelId: 'deep', thinkingLevel: 'high' };
  expect((await f.patch(model)).status).toBe(200);
  await f.service.switchMode(f.store, f.session.id, { mode: 'work', confirm: 'WORK' });
  f.service.setApprovalMode(f.store, f.session.id, 'auto');

  const { store, service } = f.restart();
  expect(service.get(store, f.manager.getConfig(), f.session.id)).toMatchObject({ model, approvalMode: 'auto' });
  expect(service.approvalMode(store, f.session.id)).toBe('auto');
  expect(service.get(store, f.manager.getConfig(), f.other.id)).toMatchObject({ model: null, approvalMode: 'ask' });
  expect(service.create(store, { backend: 'claude-code' }).model).toBeNull();

  const created = service.create(store, { backend: 'pi' });
  expect(created).toMatchObject({ model, mode: 'discuss', approvalMode: 'ask' });
  expect(service.approvalMode(store, created.id)).toBe('ask');
  expect((await service.switchMode(store, created.id, { mode: 'work', confirm: 'WORK' }))?.approvalMode).toBe('auto');
  service.setApprovalMode(store, created.id, 'ask');
  expect(service.approvalMode(store, f.session.id)).toBe('auto');
  const next = service.create(store, { backend: 'pi' });
  expect((await service.switchMode(store, next.id, { mode: 'work', confirm: 'WORK' }))?.approvalMode).toBe('ask');
});
it('rejects missing/disabled/unconfigured models, invalid levels and busy switches without writing stale choices', async () => {
  const f = await fixture();
  for (const patch of [null, 'medium', 'bad']) {
    const response = await f.patch({ source: 'app-llm', providerId: 'fixture', modelId: 'deep', thinkingLevel: patch }); expect(response.status).toBe(400);
  }
  for (const modelId of ['missing', 'disabled']) expect((await f.patch({ source: 'app-llm', providerId: 'fixture', modelId, thinkingLevel: 'off' })).status).toBe(400);
  expect((await f.patch({ source: 'app-llm', providerId: 'fixture', modelId: 'fast', thinkingLevel: 'high' })).status).toBe(400);
  expect((await f.patch({ source: 'pi-agent-dir', piModel: 'unconfigured/model', thinkingLevel: 'off' })).status).toBe(400);
  vi.spyOn(f.service, 'isRunning').mockReturnValue(true);
  expect((await f.patch({ source: 'app-llm', providerId: 'fixture', modelId: 'deep', thinkingLevel: 'low' })).status).toBe(409);
  expect(f.store.getAgentSession(f.session.id)?.model_config_json).toBeNull();
});

it('new conversations choose their own backend without changing the application backend or existing sessions', async () => {
  const f = await fixture();
  const historyPath = path.join(path.dirname((f.manager as unknown as { configPath: string }).configPath), 'existing.jsonl');
  fs.writeFileSync(historyPath, JSON.stringify({ type: 'message', id: 'prior', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: '旧会话内容' } }));
  f.store.updateAgentSession(f.session.id, { piSessionFile: historyPath });
  const create = (body: unknown) => f.app.fetch(new Request('http://x/api/agent/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  const claudeResponse = await create({ mode: 'discuss', backend: 'claude-code' });
  expect(claudeResponse.status).toBe(201);
  const claude = await claudeResponse.json();
  const piResponse = await create({ mode: 'discuss', backend: 'pi' });
  expect(piResponse.status).toBe(201);
  const pi = await piResponse.json();
  expect(claude.backend).toBe('claude-code');
  expect(pi.backend).toBe('pi');
  expect(f.manager.getConfig().agent.runtime.backend).toBe('pi');
  expect(f.service.configForSession(f.store, claude.id).agent.runtime.backend).toBe('claude-code');
  expect(f.service.configForSession(f.store, pi.id).agent.runtime.backend).toBe('pi');

  await f.manager.updateConfig({ agent: { ...f.manager.getConfig().agent, runtime: { ...f.manager.getConfig().agent.runtime, backend: 'claude-code' } } });
  expect(f.manager.getConfig().agent.runtime.backend).toBe('claude-code');
  expect(f.service.get(f.store, f.manager.getConfig(), pi.id)?.backend).toBe('pi');
  expect(f.service.get(f.store, f.manager.getConfig(), claude.id)?.backend).toBe('claude-code');
  expect(f.service.get(f.store, f.manager.getConfig(), f.session.id)?.backend).toBe('pi');
  expect(f.service.messages(f.store, f.session.id)).toMatchObject([{ id: 'prior', role: 'user', text: '旧会话内容' }]);
  expect((await (await create({ mode: 'discuss' })).json()).backend).toBe('claude-code');
  for (const backend of ['other', null, 123]) {
    expect((await create({ backend })).status).toBe(400);
  }
});
