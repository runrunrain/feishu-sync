import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });

it('基础能力基座在创建构建时固定，设置更改只影响后续构建', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-backend-'));
  const raw = path.join(root, 'raw'); fs.mkdirSync(raw);
  const manager = new ConfigManager(path.join(root, 'config.json')); await manager.load();
  await manager.updateConfig({ knowledgeBaseRoot: raw, standardKb: { outputRoot: path.join(root, 'standard') },
    agent: { ...manager.getConfig().agent, runtime: { backend: 'pi' } } } as never);
  const store = new LocalMapStore(path.join(root, 'db.sqlite')); store.initialize();
  cleanups.push(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const resolver = new PiRuntimeResolver();
  vi.spyOn(resolver, 'checkReadiness').mockResolvedValue({ code: 'ready', model: { model: 'fixture' } } as never);
  const resolve = vi.spyOn(resolver, 'resolveRuntime').mockRejectedValue(new Error('停止在运行时探测'));
  const service = new KbBuildService({ dataRoot: root, pool: new AgentProcessPool(), resolver,
    toolService: new AgentToolService({ dataRoot: root, documentsProvider: () => [] }), configProvider: () => manager.getConfig(),
    documentsProvider: () => [], sheetCsvPaths: () => [], internalBaseUrl: () => '', extensionPath: () => null, promptAssets: () => null });
  const internal = service as unknown as {
    runPipeline: () => Promise<void>;
    spawnBuildProcess: (id: string, state: BuildRunState) => Promise<unknown>;
    spawnWorkerProcess: (input: Record<string, unknown>) => Promise<void>;
  };
  vi.spyOn(internal, 'runPipeline').mockResolvedValue(undefined);

  const first = await service.createBuild(store, { mode: 'full', confirm: 'BUILD' });
  await manager.updateConfig({ agent: { ...manager.getConfig().agent, runtime: { backend: 'claude-code' } } });
  await expect(internal.spawnBuildProcess(first.id, {} as BuildRunState)).rejects.toThrow('停止在运行时探测');
  expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ backend: 'pi' }) }));
  await expect(internal.spawnWorkerProcess({ buildId: first.id })).rejects.toThrow('停止在运行时探测');
  expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ backend: 'pi' }) }));

  store.updateKbBuild(first.id, { status: 'cancelled' });
  const second = await service.createBuild(store, { mode: 'full', confirm: 'BUILD' });
  await expect(internal.spawnBuildProcess(second.id, {} as BuildRunState)).rejects.toThrow('停止在运行时探测');
  expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ backend: 'claude-code' }) }));
});
