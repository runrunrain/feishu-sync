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
  const store = new LocalMapStore(path.join(root, 'db.sqlite')); store.initialize(); const pool = new AgentProcessPool(); const resolver = new PiRuntimeResolver();
  const tools = new AgentToolService({ dataRoot: root, documentsProvider: () => [] });
  const service = new SessionService({ dataRoot: root, pool, resolver, toolService: tools, configProvider: () => manager.getConfig(), internalBaseUrl: () => '', extensionPath: () => null, workspaceGuards: () => ({ dataRoot: root, knowledgeBaseRoot: '', outputRoot: '' }) });
  const app = await agentRoutes({ sessionService: service, resolver, toolService: tools, pool, configManager: manager, localMapStore: store, internalPort: () => null });
  cleanups.push(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = service.create(store, { title: 'Fixture' }); const other = service.create(store, { title: 'Other' });
  const patch = (model: unknown, id = session.id) => app.fetch(new Request(`http://x/api/agent/sessions/${id}/model`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }));
  return { app, manager, store, service, session, other, patch };
}
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
