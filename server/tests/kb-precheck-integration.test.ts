/**
 * S3 切片 C（机械预检接入审查提示词）集成测试：
 * - 开关缺省关闭 → 审查提示词字节级不变（不含预检段）
 * - 显式开启 → 单元审查与最终复核提示词含疑点段；metrics_json 记录
 *   每审查主体的 kind 计数与 truncated
 * - 源文本不可得（快照后源文件被删）→ 跳过注入 + warn 日志，构建不阻断
 * - specHash：缺省/显式 false 不落键（与旧版 hash 一致，旧检查点可恢复）；
 *   显式 true 落键且 hash 改变
 * - config：旧 config.json 无键 → 等价关闭；归一透传布尔；严格校验拒非布尔
 *
 * 沿用 build-pipeline.test.ts 的 FakeRpcProcess 模式（不起真模型，
 * 临时 FEISHU_SYNC_HOME/dataRoot，不起 Electron）。
 *
 * F01 修复回归：预检计算预算超限 → 服务层 emitLog 警告 + 提示词内
 * 如实标注降级（⚠ 不完整），线性比对照常、构建不阻断。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { ConfigManager, validateAgentAndKbConfig } from '../src/modules/config-manager.js';
import { buildSpecFromConfig } from '../src/kb/build-orchestration.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { Config, DocumentRecord } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// 假 pi 进程：批次写草稿（正文数值与源不一致以触发预检）/审查/整合/收尾
// ---------------------------------------------------------------------------

interface Script {
  prompts?: string[];
  /** 首个批次 prompt 处理时回调（快照已冻结，用于注入源文件删除等故障） */
  onFirstBatch?: () => void;
  /** 【整体整合】prompt 到达时回调（全部审查后、validate/publish 前，
   * 用于恢复故障注入时删除的文件） */
  onIntegrate?: () => void;
  /** 覆盖草稿正文（F01 降级用例写入大文档；缺省 DRAFT_NUMERIC） */
  draftMarkdown?: string;
  firstBatchHandled?: boolean;
}

const SOURCE_NUMERIC = '冷却时间 120 秒，超时即判失败。';
const DRAFT_NUMERIC = '规则的完整说明：冷却时间 210 秒，超时即判失败（v1）。';
/** F01 降级用例：1400 条共享样板词的唯一规则句 → 句级对齐候选对超预算 */
const BIG_RULES = Array.from({ length: 1400 }, (_, i) => `规则${i}号必须执行。`).join('');

class FakeRpcProcess extends EventEmitter {
  exited = false;
  constructor(
    private readonly toolService: AgentToolService,
    private readonly token: string,
    private readonly script: Script,
    /** 本 fake 处理过的单元 → 文档（整合轮重写用） */
    private readonly unitDocs: Map<string, Array<{ path: string; sources: string[] }>>,
  ) {
    super();
  }
  isExited(): boolean { return this.exited; }
  async start(): Promise<void> {}
  async sendCommand(): Promise<{ success: boolean }> { return { success: true }; }
  async abort(): Promise<void> {}
  async terminate(): Promise<void> {
    if (!this.exited) { this.exited = true; this.emit('exit'); }
  }
  async prompt(message: string): Promise<unknown> {
    this.script.prompts?.push(message);
    return await this.act(message);
  }
  private draftBody(): string {
    return this.script.draftMarkdown ?? DRAFT_NUMERIC;
  }
  private async act(message: string): Promise<unknown> {
    if (message.includes('【单元审查')) return await this.actReview(message, false);
    if (message.includes('【最终复核】')) return await this.actReview(message, true);
    if (message.includes('【整体整合】')) {
      this.script.onIntegrate?.();
      const firstDocs = [...this.unitDocs.values()][0] ?? [];
      if (firstDocs[0]) {
        await this.call('kb_write_doc', {
          path: firstDocs[0].path, title: '规则主题', markdown: this.draftBody(),
          sources: firstDocs[0].sources, summary: '整合改写概要',
        });
      }
      await this.call('kb_finish', { summary: '整体完成（fixture）', skipped: [] });
      return { outcome: 'completed' };
    }
    if ((message.includes('【单元') || message.includes('【批次')) && message.includes('请处理以下')) {
      const unitId = /【单元 (u\d+)/.exec(message)?.[1] ?? '';
      if (!this.script.firstBatchHandled) {
        this.script.firstBatchHandled = true;
        this.script.onFirstBatch?.();
      }
      const tokens = [...message.matchAll(/^\| (tok\S+) \|/gm)].map((match) => match[1]);
      const docs: Array<{ path: string; sources: string[] }> = [];
      for (const token of tokens) {
        const docPath = `主题/${unitId || 'u'}-${token}.md`;
        await this.call('kb_write_doc', {
          path: docPath, title: '规则主题', markdown: this.draftBody(), sources: [token], summary: '规则主题的概要说明',
        });
        docs.push({ path: docPath, sources: [token] });
      }
      if (unitId && docs.length > 0) {
        const existing = this.unitDocs.get(unitId) ?? [];
        this.unitDocs.set(unitId, [...existing, ...docs]);
      }
      if (message.includes('本批是本单元最后一批')) {
        await this.call('kb_unit_done', { summary: `单元 ${unitId} 完成`, skipped: [] });
      }
      return { outcome: 'completed' };
    }
    if (message.includes('kb_finish')) {
      await this.call('kb_finish', { summary: '整体完成（fixture）', skipped: [] });
      return { outcome: 'completed' };
    }
    return { outcome: 'completed' };
  }
  /** 审查轮：全部 pass（经真实 kb_submit_review）。 */
  private async actReview(message: string, isFinal: boolean): Promise<unknown> {
    const unitId = isFinal ? 'all' : (/【单元审查 (u\d+)】/.exec(message)?.[1] ?? '');
    const sourceRefs = [...message.matchAll(/^- (tok\S+)（/gm)].map((match) => match[1]);
    await this.call('kb_submit_review', {
      ...(isFinal ? {} : { unitId }),
      coverage: { sourceRefs: sourceRefs.slice(0, 5) },
      checkedDimensions: ['事实与数值'],
      issues: [],
      uncheckedScope: [],
      conclusion: 'pass',
    });
    return { outcome: 'completed' };
  }
  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return await this.toolService.executeTool(this.token, tool, args);
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let home: string;
let previousHome: string | undefined;
let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let store: LocalMapStore;
const documents: DocumentRecord[] = [];
const FAT = '规则的详细说明段落，包含定义、流程、边界与示例，用于把原始源体积撑到足以覆盖产出文档的校验阈值。'.repeat(8);

function docRecord(token: string, rel: string): DocumentRecord {
  return {
    wikiNodeToken: null, objType: 'docx', objToken: token, title: token, localRelPath: rel,
    localMdPath: path.join(kbRoot, rel), lastSyncedModifyTime: '', lastSyncedAt: new Date().toISOString(),
    status: 'synced',
  } as DocumentRecord;
}

function writeRaw(rel: string, content: string): void {
  const full = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeConfig(mechanicalPrecheck?: boolean): Config {
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
      buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: 'rev-model' }, plannerEnabled: false },
      reviewPolicy: {
        maxAutoRevisions: 2, maxInterfaceRetries: 2,
        ...(mechanicalPrecheck !== undefined ? { mechanicalPrecheck } : {}),
      },
      publishMode: 'auto',
    },
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: kbRoot,
    watchedRoots: [], watchedRootUrls: [], requiredScopes: [],
  } as unknown as Config;
}

function stubResolver(): PiRuntimeResolver {
  return {
    resolveRuntime: async () => ({ nodePath: '/bin/true', piCliPath: '/bin/true', piPackageRoot: '' }),
    checkReadiness: async () => ({ code: 'ready', message: '', model: { model: 'fake/model', available: [] } }),
  } as unknown as PiRuntimeResolver;
}

interface Harness {
  service: KbBuildService;
  pool: AgentProcessPool;
  script: Script;
  close: () => Promise<void>;
}

function makeHarness(config: Config, script: Script = {}): Harness {
  script.prompts ??= []; // 共享记录对象：所有 fake 进程的 prompt 都进同一数组
  const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, idleTimeoutMinutes: 10 });
  const toolService = new AgentToolService({ dataRoot, documentsProvider: () => documents, sheetCsvPaths: () => [] });
  const unitDocs = new Map<string, Array<{ path: string; sources: string[] }>>();
  const service = new KbBuildService({
    dataRoot, pool, toolService,
    resolver: stubResolver(),
    configProvider: () => config,
    documentsProvider: () => documents,
    excludedSourcesProvider: () => [],
    sheetCsvPaths: () => [],
    internalBaseUrl: () => 'http://127.0.0.1:39999',
    extensionPath: () => null,
    promptAssets: () => null,
    processFactory: (options) => {
      const token = String(options.env.FEISHU_SYNC_AGENT_RUN_TOKEN ?? '');
      return new FakeRpcProcess(toolService, token, script, unitDocs) as unknown as PiRpcProcess;
    },
  });
  return { service, pool, script, close: async () => { await pool.closeAll(); } };
}

const NON_TERMINAL = ['queued', 'preflight', 'running', 'validating', 'publishing', 'awaiting_release'];

async function waitForTerminal(buildId: string, timeoutMs = 20000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.getKbBuild(buildId);
    if (row && !NON_TERMINAL.includes(String(row.status))) return row;
    if (Date.now() > deadline) throw new Error(`构建未在 ${timeoutMs}ms 内进入终态: ${row ? row.status : 'missing'}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 两个顶级目录两个源（两个单元各一批）；源含 120 秒，草稿写 210 秒。 */
function seedTwoUnits(prefix: string): void {
  documents.length = 0;
  writeRaw(`${prefix}A/a.md`, `a ${FAT} ${SOURCE_NUMERIC}`);
  writeRaw(`${prefix}B/b.md`, `b ${FAT} ${SOURCE_NUMERIC}`);
  documents.push(docRecord(`tok${prefix}A`, `${prefix}A/a.md`), docRecord(`tok${prefix}B`, `${prefix}B/b.md`));
}

/** F01 降级用例：源与草稿各携带 1400 条共享样板词的唯一规则句（数值两侧
 * 一致），使句级对齐候选对超出预算而线性比对照常。 */
function seedBigRules(prefix: string): void {
  documents.length = 0;
  writeRaw(`${prefix}A/a.md`, `a ${FAT} ${SOURCE_NUMERIC}${BIG_RULES}`);
  writeRaw(`${prefix}B/b.md`, `b ${FAT} ${SOURCE_NUMERIC}${BIG_RULES}`);
  documents.push(docRecord(`tok${prefix}A`, `${prefix}A/a.md`), docRecord(`tok${prefix}B`, `${prefix}B/b.md`));
}

function reviewPrompts(script: Script): string[] {
  return (script.prompts ?? []).filter((p) => p.includes('【单元审查') || p.includes('【最终复核】'));
}

function buildEvents(buildId: string): string {
  return fs.readFileSync(path.join(outputRoot, '.builds', buildId, 'events.jsonl'), 'utf-8');
}

beforeAll(() => {
  // Minor-1：自设临时 FEISHU_SYNC_HOME（beforeAll 设置、afterAll 还原）——
  // 不依赖外部调用方的环境隔离（diting 复审指出 C 切片缺此项）
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbprechk-home-'));
  previousHome = process.env.FEISHU_SYNC_HOME;
  process.env.FEISHU_SYNC_HOME = home;
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbprechk-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbprechk-kb-'));
  outputRoot = path.join(dataRoot, 'standard-kb');
  fs.mkdirSync(path.join(dataRoot, 'agent'), { recursive: true });
  store = new LocalMapStore(path.join(dataRoot, 'feishu-sync.db'));
  store.initialize();
});

afterAll(() => {
  store.close();
  if (previousHome === undefined) delete process.env.FEISHU_SYNC_HOME;
  else process.env.FEISHU_SYNC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// e2e：提示词注入与失败隔离
// ---------------------------------------------------------------------------

describe('S3 切片 C：机械预检接入审查提示词', () => {
  it('开关缺省关闭：审查提示词不含预检段（字节级不变路径）', async () => {
    seedTwoUnits('关A');
    const harness = makeHarness(makeConfig());
    try {
      const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
      const row = await waitForTerminal(dto.id);
      expect(String(row.status), String(row.error_message)).toBe('published');
      const prompts = reviewPrompts(harness.script);
      expect(prompts.length).toBeGreaterThanOrEqual(3); // 2 单元审查 + 1 最终复核
      for (const prompt of prompts) {
        expect(prompt).not.toContain('机械预检');
      }
      // 开关关闭不产生预检度量
      const metrics = row.metrics_json ? JSON.parse(String(row.metrics_json)) : null;
      expect(metrics?.precheck).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('开启：单元审查与最终复核提示词含疑点段；metrics 记录 kind 计数', async () => {
    seedTwoUnits('开A');
    const harness = makeHarness(makeConfig(true));
    try {
      const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
      const row = await waitForTerminal(dto.id);
      expect(String(row.status), String(row.error_message)).toBe('published');

      const prompts = reviewPrompts(harness.script);
      expect(prompts.length).toBeGreaterThanOrEqual(3);
      for (const prompt of prompts) {
        expect(prompt).toContain('机械预检疑点（仅供参考，逐条判定，不构成结论）');
        // 源 120 秒未出现在草稿（草稿写 210 秒）→ 数值缺失疑点
        expect(prompt).toContain('数值缺失');
        expect(prompt).toContain('120');
      }
      expect(prompts.some((p) => p.includes('【单元审查'))).toBe(true);
      expect(prompts.some((p) => p.includes('【最终复核】'))).toBe(true);

      // 度量：每审查主体一条（2 单元 + 1 整合范围），数值缺失计数 ≥1
      const metrics = row.metrics_json ? JSON.parse(String(row.metrics_json)) : null;
      expect(metrics?.precheck).toBeTruthy();
      const precheck: Array<{ unitId: string | null; scope: string; findingsByKind: Record<string, number>; truncated: number }> = metrics.precheck;
      expect(precheck.length).toBe(3);
      expect(precheck.filter((item) => item.scope === 'unit').length).toBe(2);
      expect(precheck.filter((item) => item.scope === 'integration').length).toBe(1);
      for (const item of precheck) {
        expect(item.findingsByKind.number_missing).toBeGreaterThanOrEqual(1);
        expect(item.findingsByKind.number_added).toBeGreaterThanOrEqual(1);
        expect(item.truncated).toBe(0);
      }
    } finally {
      await harness.close();
    }
  });

  it('源文本不可得：跳过注入 + warn 日志，不阻断审查与发布', async () => {
    seedTwoUnits('缺A');
    // 故障窗口 = 首批次（快照已冻结）→整合轮：审查期预检读不到源 →
    // warn+跳过注入；整合轮恢复源文件，validate/publish 照常通过。
    const harness = makeHarness(makeConfig(true), {
      onFirstBatch: () => {
        fs.rmSync(path.join(kbRoot, '缺AA/a.md'), { force: true });
        fs.rmSync(path.join(kbRoot, '缺AB/b.md'), { force: true });
      },
      onIntegrate: () => {
        writeRaw('缺AA/a.md', `a ${FAT} ${SOURCE_NUMERIC}`);
        writeRaw('缺AB/b.md', `b ${FAT} ${SOURCE_NUMERIC}`);
      },
    });
    try {
      const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
      const row = await waitForTerminal(dto.id);
      expect(String(row.status), String(row.error_message)).toBe('published');
      // 删源窗口内（写轮→整合轮）的单元审查：预检源不可得 → warn+跳过注入，
      // 审查照常完成（未阻断）；整合轮恢复源后最终复核正常预检（恢复后注入）
      const unitPrompts = (harness.script.prompts ?? []).filter((p) => p.includes('【单元审查'));
      const finalPrompts = (harness.script.prompts ?? []).filter((p) => p.includes('【最终复核】'));
      expect(unitPrompts.length).toBe(2);
      expect(finalPrompts.length).toBe(1);
      for (const prompt of unitPrompts) expect(prompt).not.toContain('机械预检疑点');
      expect(finalPrompts[0]).toContain('机械预检疑点');
      // 事件流有跳过警告
      expect(buildEvents(dto.id)).toContain('机械预检');
    } finally {
      await harness.close();
    }
  });

  it('F01：预检计算预算超限 → emitLog 警告 + 提示词内如实标注降级，不阻断审查与发布', async () => {
    seedBigRules('降A');
    // 源与草稿各携带 1400 条共享样板词的唯一规则句：句级对齐候选对超出
    // ALIGN_WORK_BUDGET → 预检降级；数值比对（120 缺失/210 新增）照常。
    const harness = makeHarness(makeConfig(true), {
      draftMarkdown: `规则的完整说明：冷却时间 210 秒，超时即判失败（v1）。${BIG_RULES}`,
    });
    try {
      const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
      const row = await waitForTerminal(dto.id, 60000);
      expect(String(row.status), String(row.error_message)).toBe('published');
      const prompts = reviewPrompts(harness.script);
      expect(prompts.length).toBeGreaterThanOrEqual(3);
      for (const prompt of prompts) {
        expect(prompt).toContain('机械预检疑点（仅供参考，逐条判定，不构成结论）');
        expect(prompt).toContain('⚠');            // 降级在提示词内如实标注
        expect(prompt).toContain('不完整');
        expect(prompt).toContain('数值缺失');      // 线性比对未受降级影响
        expect(prompt).toContain('120');
      }
      // 服务层 emitLog 警告（事件流可见预算超限原因）
      expect(buildEvents(dto.id)).toContain('超出预算');
      // metrics 形状不变：预检计数照常记录（2 unit + 1 integration）
      const metrics = row.metrics_json ? JSON.parse(String(row.metrics_json)) : null;
      expect(metrics?.precheck).toHaveLength(3);
      for (const item of metrics.precheck) {
        expect(item.findingsByKind.number_missing).toBeGreaterThanOrEqual(1);
        expect(item.findingsByKind.number_added).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 纯函数：specHash 冻结口径
// ---------------------------------------------------------------------------

describe('S3 切片 C：mechanicalPrecheck 的 specHash 口径', () => {
  const baseInput = {
    buildId: 'b_hash',
    snapshotEntries: [] as never[],
    baseReleaseId: null,
    specVersion: 'v1',
  };
  const standardKb = {
    buildRoles: { writer: { modelPresetId: 'w1' }, reviewer: { modelPresetId: 'r1' } },
    publishMode: 'auto' as const,
  };

  it('缺省/显式 false 不落键：hash 与旧版一致（旧检查点可恢复）', () => {
    const legacy = buildSpecFromConfig({
      ...baseInput,
      standardKb: { ...standardKb, reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 } },
    });
    expect('mechanicalPrecheck' in legacy).toBe(false);
    // 显式 false 同样不落键
    const off = buildSpecFromConfig({
      ...baseInput,
      standardKb: { ...standardKb, reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2, mechanicalPrecheck: false } },
    });
    expect('mechanicalPrecheck' in off).toBe(false);
    expect(off.specHash).toBe(legacy.specHash);
  });

  it('显式 true 落键且 hash 改变；值随 spec 冻结', () => {
    const legacy = buildSpecFromConfig({
      ...baseInput,
      standardKb: { ...standardKb, reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 } },
    });
    const on = buildSpecFromConfig({
      ...baseInput,
      standardKb: { ...standardKb, reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2, mechanicalPrecheck: true } },
    });
    expect(on.mechanicalPrecheck).toBe(true);
    expect(on.specHash).not.toBe(legacy.specHash);
  });
});

// ---------------------------------------------------------------------------
// config：旧文件兼容与校验
// ---------------------------------------------------------------------------

describe('S3 切片 C：config 归一与校验', () => {
  it('旧 config.json 无键 → 等价关闭（归一结果不带键）', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbprechk-cfg-'));
    try {
      const manager = new ConfigManager(path.join(home, 'config.json'));
      const config = await manager.load();
      expect(config.standardKb.reviewPolicy?.maxAutoRevisions).toBe(2);
      expect(config.standardKb.reviewPolicy?.mechanicalPrecheck).toBeUndefined();
      // 显式写入 true → 归一透传；写回 false → false
      const next = JSON.parse(JSON.stringify(config)) as Config;
      next.standardKb.reviewPolicy = { maxAutoRevisions: 2, maxInterfaceRetries: 2, mechanicalPrecheck: true };
      await manager.save(next);
      const reloaded = await manager.load();
      expect(reloaded.standardKb.reviewPolicy?.mechanicalPrecheck).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('严格校验：非布尔值报 invalid_type；布尔/缺省合法', () => {
    expect(() => validateAgentAndKbConfig({
      standardKb: { reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2, mechanicalPrecheck: 'yes' } },
    })).toThrow(/mechanicalPrecheck/);
    expect(() => validateAgentAndKbConfig({
      standardKb: { reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2, mechanicalPrecheck: true } },
    })).not.toThrow();
    expect(() => validateAgentAndKbConfig({
      standardKb: { reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 } },
    })).not.toThrow();
  });
});
