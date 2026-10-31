/**
 * diting F05-R + N01（增量复审第二轮修复）回归：
 *
 * F05-R：ResolvedRoleModel 冻结面升级为「经默认值展开后的完整非密钥有效
 * 参数」（maxTokens/contextWindow/reasoning/thinkingLevels/authHeader +
 * 角色有效 thinking）；三角色全部冻结（integrator 未配置时冻结 writer
 * 副本 origin='follows_writer'）；frozenRoleMismatches 完整比对（派发与
 * 恢复共用）；派发直接使用冻结 descriptor（凭据仍动态取）。
 * 本文件单元层与 diting 复审报告内联取证脚本同构（内存级，无进程/盘），
 * 断言为「期望拒绝」的反转基线。
 *
 * N01：BuildSpec 增加冻结 pipelineMode 标记；无标记的旧快照按 T7 之前的
 * 旧门控语义（reviewer 显式非空才启用新流水）恢复，旧任务 ID 不进新执行
 * 器。端到端用例验证旧 writer-only 检查点（含 running 旧任务）恢复后完
 * 整走旧路径续跑。
 *
 * 端到端沿用 build-pipeline.test.ts 的 FakeRpcProcess 模式（真实检查点/
 * 恢复/发布链路，仅模型进程为受控替身）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { BuildOrchestration, buildSpecFromConfig, reviewPipelineActive } from '../src/kb/build-orchestration.js';
import { computeBuildSpecHash, type BuildSpec } from '../src/kb/orchestration-contracts.js';
import { kbRoutes } from '../src/routes/kb.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import type { PiRpcProcess, RunOutcome } from '../src/agent/pi-rpc-process.js';
import type { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { Config } from '../src/types/index.js';
import type { DocumentRecord } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// F05-R 单元层：diting 复现脚本同构（内存级）
// ---------------------------------------------------------------------------

/** diting 复审报告 F05-R 取证脚本同构配置（合成 fixture，无真实凭据）。 */
function makeDriftConfig(): Config {
  return {
    agent: { runtime: { backend: 'pi' }, model: { source: 'app-llm', thinkingLevel: 'off' }, maxConcurrentProcesses: 3 },
    llm: {
      activeProviderId: 'p', activeModelId: 'm', providers: [{
        id: 'p', name: 'p', enabled: true, protocol: 'openai-completions',
        openAiCompatBaseUrl: 'https://example.invalid/v1', apiKey: 'fixture-key',
        models: [{ id: 'm', openAiModel: 'before', enabled: true, contextWindow: 128000, maxTokens: 8192, reasoning: true, thinkingLevels: ['low', 'high'] }],
      }],
    },
    standardKb: {
      buildRoles: { writer: { modelPresetId: 'm' }, reviewer: { modelPresetId: 'm', thinking: 'off' } },
      publishMode: 'confirm',
    },
  } as unknown as Config;
}

/** 内存级服务（不拉进程）：prototype 复用 + deps/active 注入。 */
function makeMemoryService(config: Config): KbBuildService {
  const service = Object.create(KbBuildService.prototype) as KbBuildService;
  (service as unknown as { deps: unknown }).deps = { configProvider: () => config };
  (service as unknown as { active: Map<string, unknown> }).active = new Map([['b', { backend: 'pi', orchestration: { spec: null } }]]);
  return service;
}

/** 按当前配置冻结 BuildSpec 并挂到内存服务（模拟构建启动冻结）。 */
function freezeSpec(service: KbBuildService, config: Config): BuildSpec {
  const describe = (service as unknown as {
    describeRoleModel(cfg: Config, role: { modelPresetId: string; providerId?: string; thinking?: string }, v: string): unknown;
  }).describeRoleModel.bind(service);
  const spec = buildSpecFromConfig({
    buildId: 'b', snapshotEntries: [], baseReleaseId: null,
    standardKb: config.standardKb,
    resolveRoleModel: ({ config: roleConfig }) => describe(config, roleConfig, 'v1') as never,
  });
  ((service as unknown as { active: Map<string, { backend: string; orchestration: { spec: BuildSpec } }> }).active.get('b')!).orchestration.spec = spec;
  return spec;
}

describe('diting F05-R：完整有效参数冻结（单元层，复现基线反转）', () => {
  it('冻结面含经默认展开的完整有效参数与 thinking；三角色全部冻结，integrator 未配置时为 writer 显式副本（follows_writer）', () => {
    const config = makeDriftConfig();
    const service = makeMemoryService(config);
    const spec = freezeSpec(service, config);
    expect(spec.resolvedRoles?.writer).toMatchObject({
      modelId: 'before', providerId: 'p', protocol: 'openai-completions',
      thinking: 'off', maxTokens: 8192, contextWindow: 128000, reasoning: true, origin: 'explicit',
    });
    expect(spec.resolvedRoles?.writer?.thinkingLevels).toEqual(['low', 'high']);
    // reviewer 显式 off：角色有效 thinking 为角色覆盖
    expect(spec.resolvedRoles?.reviewer).toMatchObject({ thinking: 'off', maxTokens: 8192 });
    // integrator 未配置：显式冻结 writer 结果的副本，不留空
    expect(spec.resolvedRoles?.integrator).toMatchObject({ modelId: 'before', origin: 'follows_writer', maxTokens: 8192, thinking: 'off' });
    expect(spec.pipelineMode).toBe('orchestrated');
    expect(spec.specHash).toBe(computeBuildSpecHash(spec));
  });

  it('参数漂移（maxTokens/contextWindow/reasoning/全局 thinking/thinkingLevels 任一变化）→ frozenRoleMismatches 非空且明示差异字段，派发拒绝', () => {
    const drifts: Array<[string, (config: Config) => void]> = [
      ['maxTokens', (c) => { c.llm.providers![0]!.models![0]!.maxTokens = 1234; }],
      ['contextWindow', (c) => { c.llm.providers![0]!.models![0]!.contextWindow = 64000; }],
      ['reasoning', (c) => { c.llm.providers![0]!.models![0]!.reasoning = false; }],
      ['thinking', (c) => { c.agent.model.thinkingLevel = 'high'; }],
      ['thinkingLevels', (c) => { c.llm.providers![0]!.models![0]!.thinkingLevels = ['low']; }],
    ];
    for (const [name, drift] of drifts) {
      const config = makeDriftConfig();
      const service = makeMemoryService(config);
      const spec = freezeSpec(service, config);
      const probe = service as unknown as {
        frozenRoleMismatches(cfg: Config, s: BuildSpec): string[];
        resolveRoleModel(buildId: string, role: string): { model: string } | null;
      };
      drift(config);
      const mismatches = probe.frozenRoleMismatches(config, spec);
      expect(mismatches.length, `${name} 漂移必须产生 mismatch`).toBeGreaterThan(0);
      expect(mismatches.join('\n'), `${name} 差异必须明示字段名`).toContain(name);
      expect(() => probe.resolveRoleModel('b', 'write'), `${name} 漂移必须拒绝派发`).toThrowError(/不静默换模型|已不可解析/);
    }
  });

  it('diting 复现基线反转 A：冻结后改 maxTokens+全局 thinking → mismatches 非空；派发 providerJson 用冻结值（1234 漂移不再进入派发）', () => {
    const config = makeDriftConfig();
    const service = makeMemoryService(config);
    freezeSpec(service, config);
    const svc = service as unknown as {
      frozenRoleMismatches(c: Config, s: BuildSpec): string[];
      resolveRoleModel(b: string, r: string): { model: string; providerJson?: string; thinking?: string };
    };
    config.llm.providers![0]!.models![0]!.maxTokens = 1234;
    config.agent.model.thinkingLevel = 'high';
    // 反转断言 1：原复现输出 []，修复后非空
    const mismatches = svc.frozenRoleMismatches(config, ((service as unknown as { active: Map<string, { orchestration: { spec: BuildSpec } }> }).active.get('b')!).orchestration.spec);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.join('\n')).toContain('maxTokens：8192 → 1234');
    expect(mismatches.join('\n')).toContain('thinking：off → high');
    // 反转断言 2：派发拒绝（原复现 providerJson.models[0].maxTokens=1234）
    expect(() => svc.resolveRoleModel('b', 'review')).toThrowError(/不静默换模型/);
    // 参数还原后：派发直接使用冻结 descriptor（凭据动态取）
    config.llm.providers![0]!.models![0]!.maxTokens = 8192;
    config.agent.model.thinkingLevel = 'off';
    const run = svc.resolveRoleModel('b', 'review');
    expect(run.providerJson).toBeDefined();
    const provider = JSON.parse(run.providerJson!);
    expect(provider.models[0].maxTokens).toBe(8192);
    expect(provider.models[0].contextWindow).toBe(128000);
    expect(provider.models[0].reasoning).toBe(true);
    expect(run.thinking).toBe('off'); // reviewer 角色有效 thinking（角色覆盖）
  });

  it('diting 复现基线反转 B：integrator 未配置、启动后改 writer 预设实际模型 → 整合派发拒绝（不再返回 after）', () => {
    const config = makeDriftConfig();
    const service = makeMemoryService(config);
    const spec = freezeSpec(service, config);
    const svc = service as unknown as { resolveRoleModel(b: string, r: string): { model: string } | null };
    config.llm.providers![0]!.models![0]!.openAiModel = 'after';
    // 原复现：resolveRoleModel('b','integrate').model === 'feishu-sync-llm/after'
    expect(() => svc.resolveRoleModel('b', 'integrate')).toThrowError(/不静默换模型/);
    try { svc.resolveRoleModel('b', 'integrate'); } catch (error) {
      expect((error as Error).message).toContain('integrate');
      expect((error as Error).message).toContain('diting F05-R');
    }
    // 还原后整合派发用 writer 冻结身份
    config.llm.providers![0]!.models![0]!.openAiModel = 'before';
    expect(svc.resolveRoleModel('b', 'integrate')?.model).toBe('feishu-sync-llm/before');
    void spec;
  });

  it('旧 T7 冻结条目（缺参数字段）不误报：身份漂移仍拒绝（additive 兼容）', () => {
    const config = makeDriftConfig();
    const service = makeMemoryService(config);
    const spec = freezeSpec(service, config);
    // 伪造 T7 形状冻结条目：仅五字段（无 maxTokens/thinkingLevels 等）
    const legacyFrozen = (entry: { modelId: string; providerId?: string; baseUrl?: string; protocol?: string; thinking: string; roleSpecVersion: string }) => entry;
    spec.resolvedRoles = {
      writer: legacyFrozen({ modelId: 'before', providerId: 'p', baseUrl: 'https://example.invalid/v1', protocol: 'openai-completions', thinking: 'off', roleSpecVersion: 'v1' }),
      reviewer: legacyFrozen({ modelId: 'before', providerId: 'p', baseUrl: 'https://example.invalid/v1', protocol: 'openai-completions', thinking: 'off', roleSpecVersion: 'v1' }),
    };
    const svc = service as unknown as { frozenRoleMismatches(c: Config, s: BuildSpec): string[] };
    // 未冻结的参数字段（maxTokens/contextWindow/reasoning/thinkingLevels）漂移不误报
    config.llm.providers![0]!.models![0]!.maxTokens = 1234;
    config.llm.providers![0]!.models![0]!.contextWindow = 64000;
    config.llm.providers![0]!.models![0]!.reasoning = false;
    config.llm.providers![0]!.models![0]!.thinkingLevels = ['low'];
    expect(svc.frozenRoleMismatches(config, spec)).toEqual([]);
    // 已冻结字段（thinking 自 T7 起就在冻结面内）漂移仍拒绝
    config.agent.model.thinkingLevel = 'high';
    expect(svc.frozenRoleMismatches(config, spec).join('\n')).toContain('thinking');
    config.agent.model.thinkingLevel = 'off';
    // 已冻结的身份漂移仍拒绝
    config.llm.providers![0]!.models![0]!.openAiModel = 'after';
    const mismatches = svc.frozenRoleMismatches(config, spec);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.join('\n')).toContain('before');
  });
});

// ---------------------------------------------------------------------------
// N01 单元层：流水模式标记与旧门控语义
// ---------------------------------------------------------------------------

/** 伪造 T7 前旧形状快照 spec：剥掉 pipelineMode（构造器重算 specHash 保持自洽）。 */
function legacySnapshotSpec(buildRoles: { writer: { modelPresetId: string }; reviewer: { modelPresetId: string } }, publishMode: 'auto' | 'confirm'): BuildSpec {
  const spec = buildSpecFromConfig({ buildId: 'old', snapshotEntries: [], baseReleaseId: null, standardKb: { buildRoles, publishMode } as never });
  const { specHash: _hash, pipelineMode: _mode, ...legacy } = spec;
  void _hash; void _mode;
  return { ...legacy, specHash: computeBuildSpecHash(legacy) } as BuildSpec;
}

describe('diting N01：旧检查点恢复切旧调度器（单元层）', () => {
  it('新构建按 T7 门写 pipelineMode：任一角色显式或 confirm → orchestrated；全空+auto → legacy；恢复按标记走', () => {
    const orchestrated = buildSpecFromConfig({
      buildId: 'n1', snapshotEntries: [], baseReleaseId: null,
      standardKb: { buildRoles: { writer: { modelPresetId: 'w' }, reviewer: { modelPresetId: '' } }, publishMode: 'auto' } as never,
    });
    expect(orchestrated.pipelineMode).toBe('orchestrated');
    expect(reviewPipelineActive(orchestrated)).toBe(true);
    const confirmOnly = buildSpecFromConfig({
      buildId: 'n2', snapshotEntries: [], baseReleaseId: null,
      standardKb: { buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' } }, publishMode: 'confirm' } as never,
    });
    expect(confirmOnly.pipelineMode).toBe('orchestrated');
    expect(reviewPipelineActive(confirmOnly)).toBe(true);
    const legacy = buildSpecFromConfig({
      buildId: 'n3', snapshotEntries: [], baseReleaseId: null,
      standardKb: { buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' } }, publishMode: 'auto' } as never,
    });
    expect(legacy.pipelineMode).toBe('legacy');
    expect(reviewPipelineActive(legacy)).toBe(false);
  });

  it('旧 writer-only 快照（无标记，含 running 旧任务 t:u1）→ 旧门控语义：新流水关闭，旧任务恢复归一 queued', () => {
    // diting N01 复现脚本反转：原输出 reviewPipelineActive=true
    const spec = legacySnapshotSpec({ writer: { modelPresetId: 'm' }, reviewer: { modelPresetId: '' } }, 'auto');
    const orchestration = new BuildOrchestration(spec);
    orchestration.createTask({ taskId: 't:u1', revision: 0, role: 'write', unitId: 'u1', reviewSubjectDraftHash: null, inputRefs: [], dependencies: [], allowedWritePaths: [], outputRequirements: 'legacy' });
    orchestration.updateExecState('t:u1', 'running');
    const restored = BuildOrchestration.restore(orchestration.serialize());
    expect(reviewPipelineActive(restored.spec)).toBe(false);
    expect(restored.task('t:u1')?.execState).toBe('queued');
    expect(restored.task('t:write:u1:r0')).toBeNull(); // 不新增轮次化任务
  });

  it('旧 reviewer 显式快照（无标记）→ 新流水保持启用（T7 前这类快照本就走新路径）', () => {
    const spec = legacySnapshotSpec({ writer: { modelPresetId: 'm' }, reviewer: { modelPresetId: 'r' } }, 'auto');
    expect(reviewPipelineActive(spec)).toBe(true);
    // 旧全空+auto 快照 → 旧路径
    const empty = legacySnapshotSpec({ writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' } }, 'auto');
    expect(reviewPipelineActive(empty)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 端到端：真实检查点 / resumeBuild / 发布链路（仅模型进程为受控替身）
// ---------------------------------------------------------------------------

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let store: LocalMapStore;
let configManager: ConfigManager;
const documents: DocumentRecord[] = [];

const FAT = '规则的详细说明段落，包含定义、流程、边界与示例，用于把原始源体积撑到足以覆盖产出文档的校验阈值。'.repeat(8);

function docRecord(token: string, rel: string): DocumentRecord {
  return {
    wikiNodeToken: null, objType: 'docx', objToken: token, title: token,
    localRelPath: rel, localMdPath: path.join(kbRoot, rel),
    lastSyncedModifyTime: '', lastSyncedAt: new Date().toISOString(), status: 'synced',
  } as DocumentRecord;
}

function seedTwoUnits(prefix: string): void {
  documents.length = 0;
  for (const [dir, name] of [[`${prefix}A`, 'a.md'], [`${prefix}B`, 'b.md']] as const) {
    const rel = `${dir}/${name}`;
    const full = path.join(kbRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${name} ${FAT}`);
    documents.push(docRecord(`tok${dir}`, rel));
  }
}

function makeConfig(overrides: { publishMode?: 'auto' | 'confirm'; buildRoles?: Config['standardKb']['buildRoles'] } = {}): Config {
  return {
    llm: {
      openAiCompatBaseUrl: '', apiKey: '', model: '', temperature: 0.2, primaryChannel: 'direct', fallbackOnFailure: false,
      providers: [{
        id: 'pf1', name: 'PF', enabled: true, apiKey: 'sk-fixture',
        openAiCompatBaseUrl: 'https://pf.example/v1', protocol: 'openai-completions',
        models: [{ id: 'rev-model', name: 'RM', openAiModel: 'fake-review-model', enabled: true }],
      }],
    },
    agent: {
      runtime: {},
      model: { source: 'pi-agent-dir', piModel: 'fake/model', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
      vision: { enabled: false, concurrency: 1, maxImageBytes: 5 * 1024 * 1024, maxImagesPerBuild: 10, timeoutMs: 10000 },
      maxConcurrentProcesses: 3, idleTimeoutMinutes: 10, workspaces: [],
    },
    standardKb: {
      outputRoot, retainReleases: 3, buildBatchSize: 10, buildBatchWordBudget: 0,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 30,
      buildParallelism: 2, autoBuildAfterSync: false,
      buildRoles: overrides.buildRoles ?? { writer: { modelPresetId: '' }, reviewer: { modelPresetId: 'rev-model' }, plannerEnabled: false },
      reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
      publishMode: overrides.publishMode ?? 'auto',
    },
    pollIntervalMinutes: 30, knowledgeBaseRoot: kbRoot, watchedRoots: [], watchedRootUrls: [], requiredScopes: [],
  } as unknown as Config;
}

interface E2eScript {
  prompts: string[];
  /** 指定单元的单元审查挂起直到 abort（中断场景） */
  hangReviewUnit?: string;
  /** 指定单元的批次 prompt 持续返回接口失败（重试耗尽后构建 failed，旧路径中断场景） */
  failUnit?: string;
}

class E2eFakeRpc extends EventEmitter {
  exited = false;
  private pending: Array<(value: RunOutcome) => void> = [];
  constructor(
    private readonly toolService: AgentToolService,
    private readonly token: string,
    private readonly script: E2eScript,
    private readonly unitDocs: Map<string, string[]>,
  ) { super(); }
  isExited(): boolean { return this.exited; }
  async start(): Promise<void> {}
  async sendCommand(): Promise<{ success: boolean }> { return { success: true }; }
  async abort(): Promise<void> {
    const waiters = this.pending.splice(0);
    for (const resolve of waiters) resolve({ outcome: 'aborted' });
  }
  async terminate(): Promise<void> {
    await this.abort();
    if (!this.exited) { this.exited = true; this.emit('exit'); }
  }
  async prompt(message: string): Promise<RunOutcome> {
    this.script.prompts.push(message);
    return await new Promise((resolve) => {
      void this.act(message).then(resolve, (error) => resolve({ outcome: 'failed', error: { code: 'fake_script_error', message: String(error) } }));
    });
  }
  private async act(message: string): Promise<RunOutcome> {
    const unitId = /【单元 (u\d+)/.exec(message)?.[1] ?? '';
    // 批次 prompt（新流水与旧并行路径同构：请处理以下 + tok 表格）
    if ((message.includes('【单元') || message.includes('【批次')) && message.includes('请处理以下')) {
      if (this.script.failUnit === unitId) {
        return { outcome: 'failed', error: { code: 'pi_process_exited', message: '受控模拟旧路径中断' } };
      }
      const tokens = [...message.matchAll(/^\| (tok\S+) \|/gm)].map((match) => match[1]);
      for (const token of tokens) {
        await this.call('kb_write_doc', { path: `主题/${unitId || 'u'}-${token}.md`, title: '规则主题', markdown: '规则的完整说明：第一段定义，第二段流程与边界（v1）。', sources: [token], summary: '规则主题的概要说明' });
        const existing = this.unitDocs.get(unitId) ?? [];
        this.unitDocs.set(unitId, [...existing, token]);
      }
      if (message.includes('本批是本单元最后一批')) {
        await this.call('kb_unit_done', { summary: `单元 ${unitId} 完成`, skipped: [] });
      }
      return { outcome: 'completed' };
    }
    // 单元审查（新流水专属 prompt 标记）
    if (message.includes('【单元审查')) {
      const reviewUnit = /【单元审查 (u\d+)】/.exec(message)?.[1] ?? '';
      if (this.script.hangReviewUnit === reviewUnit) {
        return await new Promise<RunOutcome>((resolve) => { this.pending.push(resolve); });
      }
      await this.call('kb_submit_review', { unitId: reviewUnit, coverage: { sourceRefs: ['tok-any'] }, checkedDimensions: ['事实与数值'], issues: [], uncheckedScope: [], conclusion: 'pass' });
      return { outcome: 'completed' };
    }
    // 最终复核 / 整合（新流水专属）
    if (message.includes('【最终复核】')) {
      await this.call('kb_submit_review', { coverage: { sourceRefs: ['tok-any'] }, checkedDimensions: ['事实与数值'], issues: [], uncheckedScope: [], conclusion: 'pass' });
      return { outcome: 'completed' };
    }
    if (message.includes('【整体整合】')) {
      await this.call('kb_finish', { summary: '整体完成（fixture）', skipped: [] });
      return { outcome: 'completed' };
    }
    if (message.includes('kb_unit_done')) {
      await this.call('kb_unit_done', { summary: `单元 ${unitId} 完成`, skipped: [] });
      return { outcome: 'completed' };
    }
    if (message.includes('kb_finish')) {
      await this.call('kb_finish', { summary: '整体完成（fixture）', skipped: [] });
      return { outcome: 'completed' };
    }
    return { outcome: 'completed' };
  }
  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return await this.toolService.executeTool(this.token, tool, args);
  }
}

function stubResolver(): PiRuntimeResolver {
  return {
    resolveRuntime: async () => ({ nodePath: '/bin/true', piCliPath: '/bin/true', piPackageRoot: '' }),
    checkReadiness: async () => ({ code: 'ready', message: '', model: { model: 'fake/model', available: [] } }),
  } as unknown as PiRuntimeResolver;
}

function makeHarness(config: Config, script: E2eScript): {
  service: KbBuildService; pool: AgentProcessPool;
  request: (url: string, body?: unknown) => Promise<{ status: number; data: any }>;
  close: () => Promise<void>;
} {
  const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, idleTimeoutMinutes: 10 });
  const toolService = new AgentToolService({ dataRoot, documentsProvider: () => documents, sheetCsvPaths: () => [] });
  const unitDocs = new Map<string, string[]>();
  const service = new KbBuildService({
    dataRoot, pool, toolService, resolver: stubResolver(), configProvider: () => config,
    documentsProvider: () => documents, excludedSourcesProvider: () => [], sheetCsvPaths: () => [],
    internalBaseUrl: () => 'http://127.0.0.1:39999', extensionPath: () => null, promptAssets: () => null,
    processFactory: (options) => {
      const token = String(options.env.FEISHU_SYNC_AGENT_RUN_TOKEN ?? '');
      return new E2eFakeRpc(toolService, token, script, unitDocs) as unknown as PiRpcProcess;
    },
  });
  const app = new Hono();
  app.route('/', kbRoutes({ buildService: service, configManager, localMapStore: store, documentsProvider: () => documents, sheetCsvPaths: () => [] }));
  const request = async (url: string, body?: unknown) => {
    const response = await app.request(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  return { service, pool, request, close: async () => { await pool.closeAll(); } };
}

const NON_TERMINAL = ['queued', 'preflight', 'running', 'validating', 'publishing', 'awaiting_release'];

async function waitForTerminal(buildId: string, timeoutMs = 20000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.getKbBuild(buildId);
    if (row && !NON_TERMINAL.includes(String(row.status))) return row;
    if (Date.now() > deadline) throw new Error(`构建未在 ${timeoutMs}ms 内进入终态: ${row ? String(row.status) : 'missing'}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 把检查点 spec 改写为 T7 前的旧形状：writer 显式、无 pipelineMode、无 resolvedRoles。 */
function rewriteCheckpointToLegacyShape(buildId: string): void {
  const dir = path.join(outputRoot, '.builds', buildId, 'checkpoints');
  const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'CURRENT.json'), 'utf8')) as { generation: string };
  const stateFile = path.join(dir, pointer.generation, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { orchestration: { spec: Record<string, unknown> } };
  const spec = state.orchestration.spec;
  spec.roles = { ...spec.roles as Record<string, unknown>, writer: { modelPresetId: 'w-model' } };
  delete spec.pipelineMode;
  delete spec.resolvedRoles;
  const { specHash: _hash, ...rest } = spec;
  void _hash;
  state.orchestration.spec = { ...rest, specHash: computeBuildSpecHash(rest as never) };
  fs.writeFileSync(stateFile, JSON.stringify(state));
}

beforeAll(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-e2e-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-e2e-kb-'));
  outputRoot = path.join(dataRoot, 'standard-kb');
  fs.mkdirSync(path.join(dataRoot, 'agent'), { recursive: true });
  store = new LocalMapStore(path.join(dataRoot, 'feishu-sync.db'));
  store.initialize();
  configManager = new ConfigManager(path.join(dataRoot, 'config.json'));
  await configManager.load();
});

afterAll(() => {
  store.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
});

describe('diting F05-R / N01：端到端（真实检查点与 resumeBuild 链路）', () => {
  it('F05-R：恢复路径参数变更 → resume 409 待处理（kb_resume_stale，明示差异字段）', async () => {
    seedTwoUnits('冻结');
    const config = makeConfig(); // reviewer 显式预设（auto 发布）→ orchestrated
    const script: E2eScript = { prompts: [], hangReviewUnit: 'u2' };
    const first = makeHarness(config, script);
    const dto = await first.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const hangDeadline = Date.now() + 10000;
    while (!script.prompts.some((message) => message.includes('【单元审查 u2】')) && Date.now() < hangDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await first.service.cancelBuild(store as never, dto.id);
    const row = await waitForTerminal(dto.id);
    expect(['cancelled', 'interrupted']).toContain(String(row.status));
    await first.close();

    // 同一预设 maxTokens 漂移（原模型无显式 maxTokens → 冻结默认展开值 8192）
    config.llm.providers![0]!.models![0]!.maxTokens = 1234;
    const resumed = makeHarness(config, { prompts: [] });
    const response = await resumed.request(`/api/kb/builds/${dto.id}/resume`, { confirm: 'RESUME' });
    expect(response.status, JSON.stringify(response.data)).toBe(409);
    expect(JSON.stringify(response.data)).toContain('kb_resume_stale');
    expect(JSON.stringify(response.data)).toContain('maxTokens');
    await resumed.close();
  });

  it('N01：旧 writer-only 检查点（含 running 旧任务 t:u1 形状）恢复 → 旧路径续跑发布；无 kb_pipeline_invalid、无新审查任务', async () => {
    seedTwoUnits('旧形');
    // 全空+auto → 新代码写 pipelineMode='legacy'，走旧并行路径（旧任务 t:u* 形状）
    const config = makeConfig({ buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, plannerEnabled: false } });
    const script: E2eScript = { prompts: [], failUnit: 'u2' };
    const first = makeHarness(config, script);
    const dto = await first.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const failed = await waitForTerminal(dto.id);
    expect(String(failed.status)).toBe('failed');
    // 中断时检查点里已是旧形状任务：u1 完成、u2 中断时 running（恢复归一 queued）
    const checkpoint = new BuildCheckpointStore(outputRoot).read(dto.id)!;
    const taskIds = checkpoint.orchestration!.tasks.map((task) => task.taskId).sort();
    expect(taskIds).toEqual(['t:u1', 't:u2']);
    expect(checkpoint.orchestration!.tasks.find((task) => task.taskId === 't:u2')?.execState).toBe('running');
    // 伪造 T7 前旧形状检查点：writer 显式（T7 谓词会启用新流水、旧门控不启用）、
    // 无 pipelineMode、无 resolvedRoles —— specHash 重算保持自洽
    rewriteCheckpointToLegacyShape(dto.id);
    await first.close();

    const resumeScript: E2eScript = { prompts: [] };
    const resumed = makeHarness(config, resumeScript);
    const response = await resumed.request(`/api/kb/builds/${dto.id}/resume`, { confirm: 'RESUME' });
    expect(response.status, JSON.stringify(response.data)).toBe(202);
    const final = await waitForTerminal(dto.id);
    expect(String(final.status), `${String(final.error_code)} ${String(final.error_message)}`).toBe('published');
    expect(String(final.error_code ?? '')).not.toContain('kb_pipeline_invalid');
    // 旧路径续跑：无任何新流水审查/整合/最终复核 prompt
    const prompts = resumeScript.prompts.join('\n');
    expect(prompts.includes('【单元审查')).toBe(false);
    expect(prompts.includes('【最终复核】')).toBe(false);
    expect(prompts.includes('【整体整合】')).toBe(false);
    // 任务集合不新增轮次化/审查/整合任务（保持旧形状直到发布）
    const finalCheckpoint = new BuildCheckpointStore(outputRoot).read(dto.id)!;
    const roles = new Set(finalCheckpoint.orchestration!.tasks.map((task) => task.role));
    expect([...roles].sort()).toEqual(['write']);
    for (const task of finalCheckpoint.orchestration!.tasks) {
      expect(task.taskId).toMatch(/^t:u\d+$/); // 旧 ID 形状，未迁移成轮次化 ID
    }
    await resumed.close();
  });
});
