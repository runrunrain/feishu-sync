import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-auto-resume-'));
  roots.push(root);
  const outputRoot = path.join(root, 'standard-kb');
  fs.mkdirSync(outputRoot);
  const service = new KbBuildService({
    dataRoot: root,
    pool: new AgentProcessPool({ maxConcurrentProcesses: 1 }),
    toolService: new AgentToolService({ dataRoot: root, documentsProvider: () => [] }),
    resolver: new PiRuntimeResolver(),
    configProvider: () => ({ standardKb: { outputRoot } }) as never,
    documentsProvider: () => [], sheetCsvPaths: () => [],
    internalBaseUrl: () => '', extensionPath: () => null, promptAssets: () => null,
  });
  const row: Record<string, unknown> = {
    id: 'b_retry', status: 'failed', orchestration_mode: 'pi-amagi',
    error_code: 'kb_leader_failed', error_message: 'Leader prompt 失败：model_timeout',
  };
  const store = { getKbBuild: () => row, getActiveKbBuild: () => null };
  vi.spyOn(BuildCheckpointStore.prototype, 'summary').mockReturnValue({
    checkpointAt: new Date().toISOString(), draftCount: 1, sourceCount: 1,
    completedBatches: 0, totalBatches: 0, progress: {} as never,
    baseReleaseId: null, knowledgeBaseRoot: root,
  });
  return { service, root, outputRoot, row, store };
}

it('automatically resumes a transient Leader timeout from the checkpoint and caps retries across restarts', async () => {
  vi.useFakeTimers();
  const { service, outputRoot, row, store } = fixture();
  const resume = vi.spyOn(service, 'resumeBuild').mockResolvedValue({} as never);
  const schedule = (service as unknown as { scheduleAutoResume(store: unknown, id: string): void }).scheduleAutoResume.bind(service);
  schedule(store, 'b_retry');
  schedule(store, 'b_retry'); // duplicate scheduling is idempotent
  const statePath = path.join(outputRoot, '.builds', 'b_retry', 'auto-resume.json');
  expect(JSON.parse(fs.readFileSync(statePath, 'utf-8')).attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(resume).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledWith(store, 'b_retry', 'RESUME', 'rebuild');
  schedule(store, 'b_retry');
  expect(JSON.parse(fs.readFileSync(statePath, 'utf-8')).attempts).toBe(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(resume).toHaveBeenCalledTimes(2);
  schedule(store, 'b_retry');
  expect(vi.getTimerCount()).toBe(0);
  row.error_code = 'kb_validation_failed';
  fs.rmSync(statePath);
  schedule(store, 'b_retry');
  expect(fs.existsSync(statePath)).toBe(false);
});
