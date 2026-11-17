/**
 * 构建角色模型前置预检（precheckLeaderModels / resolveLeaderRoleModel）与
 * createBuild/resumeBuild 准入回归（新用户默认模型构建阻断修复）：
 *
 * - checkReadiness 对 app-llm 源不限协议（openai-responses /
 *   anthropic-messages 均判 ready），而 Pi 编排构建只接受
 *   openai-completions——此前该契约要到异步流水线内 buildLeaderInput →
 *   resolveLeaderModels 才失败，kb_builds 已入库，用户看到「Agent 就绪、
 *   构建启动后阻断」。修复后 createBuild 在入库前拒绝：
 *   - 非 completions 协议 → build_mode_unavailable，消息含角色名/当前
 *     协议/修正指引；kb_builds 无新行、无 active 登记、流水线不启动。
 *   - 缺 API Key → agent_not_ready（原为流水线内失败，前置后同样拒绝）。
 *   - pi-agent-dir 本机模型源（无 providerId/baseUrl）→ 同样创建即拒绝。
 *   - 角色显式预设（reviewer 指向 anthropic 提供商）→ 消息指明角色名。
 *   - openai-completions 正常配置 → 创建成功（queued 行入表）。
 * - resumeBuild（interrupted 的 pi-amagi 检查点）在置 queued 前同源预检：
 *   失败 409 且检查点状态保持 interrupted 不被改写。
 *
 * readiness/runPipeline 用受控替身（真实 ConfigManager 归一化、真实
 * LocalMapStore SQLite、真实 BuildCheckpointStore 保存/读取链路；不起
 * 真实运行时/模型/飞书，临时 FEISHU_SYNC_HOME 目录外无副作用）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { Config, LlmProviderConfig } from '../src/types/index.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });

function makeProvider(protocol: LlmProviderConfig['protocol'], overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    id: 'p1', name: 'Fixture', enabled: true, apiKey: 'fixture-key',
    protocol, openAiCompatBaseUrl: 'https://example.invalid/v1',
    defaultModelId: 'm1',
    models: [{ id: 'm1', name: '默认预设', enabled: true, openAiModel: 'fixture-model' }],
    ...overrides,
  };
}

interface Harness {
  service: KbBuildService;
  store: LocalMapStore;
  raw: string;
  outputRoot: string;
  runPipeline: ReturnType<typeof vi.fn>;
}

async function harness(options: {
  providers: LlmProviderConfig[];
  agentModel?: Record<string, unknown>;
  buildRoles?: Record<string, unknown>;
}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-model-precheck-'));
  const raw = path.join(root, 'raw'); fs.mkdirSync(raw);
  const outputRoot = path.join(root, 'standard');
  const manager = new ConfigManager(path.join(root, 'config.json')); await manager.load();
  await manager.updateConfig({
    knowledgeBaseRoot: raw,
    llm: { providers: options.providers },
    agent: { runtime: { backend: 'pi' }, model: { source: 'app-llm', ...(options.agentModel ?? {}) } },
    standardKb: { outputRoot, ...(options.buildRoles ? { buildRoles: options.buildRoles } : {}) },
  } as never);
  const store = new LocalMapStore(path.join(root, 'db.sqlite')); store.initialize();
  cleanups.push(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // readiness 替身：恒 ready（协议/密钥缺口正是 readiness 不覆盖、预检要补的面）
  const resolver = new PiRuntimeResolver();
  vi.spyOn(resolver, 'checkReadiness').mockResolvedValue({ code: 'ready', model: { model: 'feishu-sync-llm/fixture-model' } } as never);
  const service = new KbBuildService({ dataRoot: root, pool: new AgentProcessPool(), resolver,
    toolService: new AgentToolService({ dataRoot: root, documentsProvider: () => [] }),
    configProvider: () => manager.getConfig(), documentsProvider: () => [], sheetCsvPaths: () => [],
    internalBaseUrl: () => '', extensionPath: () => null, promptAssets: () => null,
    buildRuntime: {} as never });
  const internal = service as unknown as { runPipeline: () => Promise<void>; active: Map<string, unknown> };
  const runPipeline = vi.spyOn(internal, 'runPipeline').mockResolvedValue(undefined);
  return { service, store, raw, outputRoot, runPipeline, active: internal.active };
}

describe('createBuild 构建角色模型前置预检（入库前拒绝，无副作用）', () => {
  for (const protocol of ['openai-responses', 'anthropic-messages'] as const) {
    it(`${protocol} 协议创建即拒绝：消息含角色/协议/指引，无 DB 行、无 active、不启动流水线`, async () => {
      const h = await harness({ providers: [makeProvider(protocol)] });
      await expect(h.service.createBuild(h.store as never, { mode: 'full', confirm: 'BUILD' }))
        .rejects.toMatchObject({ code: 'build_mode_unavailable', status: 400 });
      await expect(h.service.createBuild(h.store as never, { mode: 'full', confirm: 'BUILD' }))
        .rejects.toThrow(new RegExp(`只支持 OpenAI Chat Completions 兼容端点（写作 当前 ${protocol}）`));
      await expect(h.service.createBuild(h.store as never, { mode: 'full', confirm: 'BUILD' }))
        .rejects.toThrow(/设置→模型提供商/);
      expect(h.store.listKbBuilds(10)).toHaveLength(0);
      expect(h.active.size).toBe(0);
      expect(h.runPipeline).not.toHaveBeenCalled();
    });
  }

  it('openai-completions 正常配置创建成功（queued 行入表，流水线启动）', async () => {
    const h = await harness({ providers: [makeProvider('openai-completions')] });
    const dto = await h.service.createBuild(h.store as never, { mode: 'full', confirm: 'BUILD' });
    expect(dto.status).toBe('queued');
    expect(dto.orchestrationMode).toBe('pi-amagi');
    expect(h.store.listKbBuilds(10)).toHaveLength(1);
    expect(h.active.size).toBe(1);
  });

  it('缺 API Key 时创建即拒绝（原行为为流水线内失败）', async () => {
    const h = await harness({ providers: [makeProvider('openai-completions', { apiKey: '' })] });
    await expect(h.service.createBuild(h.store as never, { mode: 'full', confirm: 'BUILD' }))
      .rejects.toMatchObject({ code: 'agent_not_ready', status: 503 });
    await expect(h.service.createBuild(h.store as never, { mode: 'full', confirm: 'BUILD' }))
      .rejects.toThrow('Pi 编排的写作角色缺少提供商 API 密钥');
    expect(h.store.listKbBuilds(10)).toHaveLength(0);
    expect(h.active.size).toBe(0);
  });

  it('pi-agent-dir 本机模型源（无提供商端点）创建即拒绝并指明角色', async () => {
    const h = await harness({
      providers: [makeProvider('openai-completions')],
      agentModel: { source: 'pi-agent-dir', piModel: 'fixture/model' },
    });
    await expect(h.service.createBuild(h.store as never, { mode: 'full', confirm: 'BUILD' }))
      .rejects.toMatchObject({ code: 'build_mode_unavailable', status: 400 });
    await expect(h.service.createBuild(h.store as never, { mode: 'full', confirm: 'BUILD' }))
      .rejects.toThrow('Pi 编排需要为写作角色配置 OpenAI 兼容端点');
    expect(h.store.listKbBuilds(10)).toHaveLength(0);
    expect(h.active.size).toBe(0);
  });

  it('reviewer 显式预设指向 anthropic 提供商时按角色名拒绝', async () => {
    const h = await harness({
      providers: [
        makeProvider('openai-completions'),
        makeProvider('anthropic-messages', { id: 'p2', name: 'AnthropicFixture', defaultModelId: 'm2', models: [{ id: 'm2', name: '审查预设', enabled: true, openAiModel: 'fixture-claude' }] }),
      ],
      buildRoles: { reviewer: { modelPresetId: 'm2', providerId: 'p2' } },
    });
    await expect(h.service.createBuild(h.store as never, { mode: 'full', confirm: 'BUILD' }))
      .rejects.toThrow('只支持 OpenAI Chat Completions 兼容端点（审查 当前 anthropic-messages）');
    expect(h.store.listKbBuilds(10)).toHaveLength(0);
  });
});

describe('resumeBuild 恢复路径同源预检（置 queued 前拒绝，检查点不动）', () => {
  it('pi-amagi interrupted 检查点 + 非 completions 协议 → 409 拒绝且状态保持 interrupted', async () => {
    const h = await harness({ providers: [makeProvider('openai-responses')] });
    const buildId = 'b_fixture_resume_precheck';
    h.store.createKbBuild({ id: buildId, mode: 'full', orchestrationMode: 'pi-amagi', status: 'queued', baseReleaseId: null, model: 'x', createdAt: new Date().toISOString() });
    h.store.updateKbBuild(buildId, { status: 'interrupted' });
    const staging = path.join(h.outputRoot, '.staging', buildId); fs.mkdirSync(staging, { recursive: true });
    // 真实 BuildCheckpointStore.save/read 链路（空快照最小检查点）
    new BuildCheckpointStore(h.outputRoot).save({
      schemaVersion: 1, buildId, knowledgeBaseRoot: h.raw, baseReleaseId: null,
      requestedMode: 'full', mode: 'full', backend: 'pi', orchestrationMode: 'pi-amagi',
      rebuildSelected: false, snapshot: [], workset: [], docMeta: [], writtenPaths: [],
      preservedDocs: [], requiredRewrites: [], baseDocPaths: [], finishInfo: null,
      imageDescriptions: [], units: [], unitDone: [], claims: [], singleBatches: [],
      singleCompleted: 0, unitProgress: [], workerCount: 1, wordBudget: 0,
      progress: { batchIndex: 0, batchTotal: 1, stage: 'units', units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 }, workers: [], images: { total: 0, described: 0, cached: 0, unavailable: 0 } },
      updatedAt: new Date().toISOString(),
    }, staging);
    await expect(h.service.resumeBuild(h.store as never, buildId, 'RESUME'))
      .rejects.toMatchObject({ code: 'build_mode_unavailable', status: 409 });
    await expect(h.service.resumeBuild(h.store as never, buildId, 'RESUME'))
      .rejects.toThrow('恢复构建的模型配置不满足 Pi 编排要求');
    expect(String(h.store.getKbBuild(buildId)!.status)).toBe('interrupted');
    expect(h.active.size).toBe(0);
    expect(h.runPipeline).not.toHaveBeenCalled();
  });
});

/** precheckLeaderModels 与 resolveLeaderModels 同源（共用
 * resolveLeaderRoleModel）：派发路径的等价行为经原型直测交叉验证。 */
describe('resolveLeaderModels 派发路径与预检同源', () => {
  it('非 completions 协议在派发解析处抛出与预检一致的错误', async () => {
    const h = await harness({ providers: [makeProvider('anthropic-messages')] });
    const host = Object.create(KbBuildService.prototype) as {
      resolveLeaderModels: (c: Config) => unknown;
      precheckLeaderModels: (c: Config) => { ok: boolean; code?: string; message?: string };
    };
    const configProvider = (h.service as unknown as { deps: { configProvider: () => Config } }).deps.configProvider;
    const cfg = configProvider();
    const precheck = host.precheckLeaderModels(cfg);
    expect(precheck.ok).toBe(false);
    expect(precheck.code).toBe('build_mode_unavailable');
    expect(precheck.message).toContain('写作 当前 anthropic-messages');
    expect(() => host.resolveLeaderModels(cfg)).toThrow(precheck.message!);
  });
});
