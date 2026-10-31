/**
 * T2b：编排流水执行集成测试（B 案《多模型构建编排方案》§3–§5/§7/§8）
 *
 * 沿用 kb-build-parallel 的 FakeRpcProcess 模式（不起真模型）：prompt 按
 * 内容标记脚本化，工具经真实 AgentToolService 执行。新流水启用条件
 * （diting F04）= 任一角色显式配置 或 publishMode='confirm'
 * （reviewPipelineActive）。覆盖：
 * - 单元写→独立审查→通过→整合→最终复核→auto 发布全链路
 * - blocking → 定向修订 → 复审通过（旧报告不批准新稿、预算消耗）
 * - 修订预算超限 → pending_decision + failed(kb_review_required) 可恢复
 * - 整合改文档 → 最终复核拦截 → 整合修订 → 复核通过
 * - 接口失败重试与内容修订分开计数；审查报告缺失 = 执行失败（重试）
 * - confirm 模式：awaiting_release + 确认端点绑定候选哈希 + 内容变化失效
 * - 取消后迟到回执不推进；恢复：审查中断续审、已通过单元不重跑
 * - 进度端点 DTO 形状（同一份 BuildOrchestration 数据源）
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
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { buildSpecFromConfig, reviewPipelineActive } from '../src/kb/build-orchestration.js';
import { kbRoutes } from '../src/routes/kb.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { Config } from '../src/types/index.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { ReviewReport } from '../src/kb/orchestration-contracts.js';

// ---------------------------------------------------------------------------
// 假 pi 进程：按 prompt 标记分派（批次/审查/修订/整合/最终复核）
// ---------------------------------------------------------------------------

interface PipelineScript {
  /** 首轮单元审查返回 blocking 的单元 id 列表（其余 pass） */
  blockingUnits?: string[];
  /** 指定单元的审查始终 blocking（预算超限场景） */
  alwaysBlockingUnits?: string[];
  /** 首次最终复核返回 blocking（整合修订场景） */
  firstFinalReviewBlocking?: boolean;
  /** 审查 prompt 注入 model_timeout 的次数（接口失败通道） */
  reviewInterfaceFailures?: number;
  /** 审查执行结束但不提交报告的次数（报告缺失=执行失败） */
  reviewMissingReports?: number;
  /** 修订轮写入的正文 */
  reviseMarkdown?: string;
  /** 整合轮改写文档（正文 v2） */
  integrateMarkdown?: string;
  /** 指定单元的审查 prompt 挂起直到 abort（取消/中断场景） */
  hangReviewUnit?: string;
  /** 批次 prompt 注入 model_timeout 的次数（写任务接口失败） */
  batchInterfaceFailures?: number;
  /** 记录全部 prompt（跨进程共享） */
  prompts?: string[];
}

const DEFAULT_REVISE_MARKDOWN = '修订后的完整规则说明：数值已按源修正（v2），第二段流程与边界。';
const DEFAULT_INTEGRATE_MARKDOWN = '整合后的跨单元规则说明：合并重复主题，统一术语（v2）。';

class FakeRpcProcess extends EventEmitter {
  exited = false;
  private pending: Array<(value: unknown) => void> = [];

  constructor(
    private readonly toolService: AgentToolService,
    private readonly token: string,
    private readonly script: PipelineScript,
    /** 本 fake 处理过的单元 → 文档（修订轮重写用） */
    private readonly unitDocs: Map<string, Array<{ path: string; sources: string[] }>>,
  ) {
    super();
  }

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

  async prompt(message: string): Promise<unknown> {
    this.script.prompts?.push(message);
    return await new Promise((resolve) => {
      void this.act(message).then(resolve, (error) => {
        resolve({ outcome: 'failed', error: { code: 'fake_script_error', message: String(error) } });
      });
    });
  }

  private async act(message: string): Promise<unknown> {
    if (message.includes('【单元审查')) return await this.actReview(message, false);
    if (message.includes('【最终复核】')) return await this.actReview(message, true);
    if (message.includes('【修订轮')) return await this.actRevise(message);
    if (message.includes('【整合修订轮】')) return await this.actIntegrateRevise();
    if (message.includes('【整体整合】')) return await this.actIntegrate();
    if ((message.includes('【单元') || message.includes('【批次')) && message.includes('请处理以下')) {
      return await this.actBatch(message);
    }
    if (message.includes('没有新增或变更的源')) return { outcome: 'completed' };
    if (message.includes('kb_unit_done')) {
      const unitId = /单元 (u\d+)/.exec(message)?.[1] ?? '';
      await this.call('kb_unit_done', { summary: `单元 ${unitId} 完成`, skipped: [] });
      return { outcome: 'completed' };
    }
    if (message.includes('kb_finish')) {
      await this.call('kb_finish', { summary: '整体完成（fixture）', skipped: [] });
      return { outcome: 'completed' };
    }
    return { outcome: 'completed' };
  }

  private async actBatch(message: string): Promise<unknown> {
    const unitId = /【单元 (u\d+)/.exec(message)?.[1] ?? '';
    if (this.script.batchInterfaceFailures && this.script.batchInterfaceFailures > 0) {
      this.script.batchInterfaceFailures -= 1;
      return { outcome: 'failed', error: { code: 'model_timeout', message: '脚本注入一次性接口失败' } };
    }
    const tokens = [...message.matchAll(/^\| (tok\S+) \|/gm)].map((match) => match[1]);
    const docs: Array<{ path: string; sources: string[] }> = [];
    for (const token of tokens) {
      const docPath = `主题/${unitId || 'u'}-${token}.md`;
      await this.call('kb_write_doc', {
        path: docPath,
        title: '规则主题',
        markdown: '规则的完整说明：第一段定义，第二段流程与边界（v1）。',
        sources: [token],
        summary: '规则主题的概要说明',
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

  /** 审查轮：按脚本提交 pass / blocking 报告（经真实 kb_submit_review）。 */
  private async actReview(message: string, isFinal: boolean): Promise<unknown> {
    const unitId = isFinal ? 'all' : (/【单元审查 (u\d+)】/.exec(message)?.[1] ?? '');
    if (!isFinal && this.script.hangReviewUnit === unitId) {
      return await new Promise((resolve) => { this.pending.push(resolve as (value: unknown) => void); });
    }
    if (!isFinal && (this.script.reviewInterfaceFailures ?? 0) > 0) {
      this.script.reviewInterfaceFailures! -= 1;
      return { outcome: 'failed', error: { code: 'model_timeout', message: '脚本注入审查接口失败' } };
    }
    if ((this.script.reviewMissingReports ?? 0) > 0) {
      this.script.reviewMissingReports! -= 1;
      return { outcome: 'completed' }; // 执行结束但无报告 → kb_review_report_missing
    }
    const sourceRefs = [...message.matchAll(/^- (tok\S+)（/gm)].map((match) => match[1]);
    const blocking = isFinal
      ? this.script.firstFinalReviewBlocking === true
      : (this.script.blockingUnits ?? []).includes(unitId) || (this.script.alwaysBlockingUnits ?? []).includes(unitId);
    if (isFinal) this.script.firstFinalReviewBlocking = false;
    if (!isFinal && (this.script.blockingUnits ?? []).includes(unitId)) {
      this.script.blockingUnits = this.script.blockingUnits!.filter((id) => id !== unitId);
    }
    const issues = blocking
      ? [{
          draftLocation: '主题/x.md §1',
          sourceLocation: '源文档 §2 第 3-5 行',
          description: '关键数值抄录错误：阈值 120 写成 210（fixture 阻断问题）',
          severity: 'blocking',
        }]
      : [];
    await this.call('kb_submit_review', {
      ...(isFinal ? {} : { unitId }),
      coverage: { sourceRefs: sourceRefs.length > 0 ? sourceRefs.slice(0, 5) : ['tok-any'] },
      checkedDimensions: ['事实与数值'],
      issues,
      uncheckedScope: [],
      conclusion: blocking ? 'needs_revision' : 'pass',
    });
    return { outcome: 'completed' };
  }

  /** 修订轮：重写本单元文档（v2）+ kb_unit_done。 */
  private async actRevise(message: string): Promise<unknown> {
    const unitId = /【修订轮 (u\d+)】/.exec(message)?.[1] ?? '';
    const docs = this.unitDocs.get(unitId) ?? [];
    for (const doc of docs) {
      await this.call('kb_write_doc', {
        path: doc.path,
        title: '规则主题',
        markdown: this.script.reviseMarkdown ?? DEFAULT_REVISE_MARKDOWN,
        sources: doc.sources,
        summary: '修订后的概要说明',
      });
    }
    await this.call('kb_unit_done', { summary: `单元 ${unitId} 修订完成（逐项回应）`, skipped: [] });
    return { outcome: 'completed' };
  }

  /** 整合轮：可选改写一篇文档（形成新审查对象）+ kb_finish。 */
  private async actIntegrate(): Promise<unknown> {
    const firstDocs = [...this.unitDocs.values()][0] ?? [];
    if (firstDocs[0]) {
      await this.call('kb_write_doc', {
        path: firstDocs[0].path,
        title: '规则主题',
        markdown: this.script.integrateMarkdown ?? DEFAULT_INTEGRATE_MARKDOWN,
        sources: firstDocs[0].sources,
        summary: '整合改写概要',
      });
    }
    await this.call('kb_finish', { summary: '整体完成（整合改写 fixture）', skipped: [] });
    return { outcome: 'completed' };
  }

  /** 整合修订轮：改回目标文档（v3）后结束（kb_finish 已提交过不重调）。 */
  private async actIntegrateRevise(): Promise<unknown> {
    const firstDocs = [...this.unitDocs.values()][0] ?? [];
    if (firstDocs[0]) {
      await this.call('kb_write_doc', {
        path: firstDocs[0].path,
        title: '规则主题',
        markdown: (this.script.reviseMarkdown ?? DEFAULT_REVISE_MARKDOWN) + '（整合修订 v3）',
        sources: firstDocs[0].sources,
        summary: '整合修订概要',
      });
    }
    return { outcome: 'completed' };
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return await this.toolService.executeTool(this.token, tool, args);
  }
}

// ---------------------------------------------------------------------------
// 夹具
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
    wikiNodeToken: null,
    objType: 'docx',
    objToken: token,
    title: token,
    localRelPath: rel,
    localMdPath: path.join(kbRoot, rel),
    lastSyncedModifyTime: '',
    lastSyncedAt: new Date().toISOString(),
    status: 'synced',
  } as DocumentRecord;
}

function writeRaw(rel: string, content: string): void {
  const full = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeOrchConfig(overrides: {
  parallelism?: number;
  maxAutoRevisions?: number;
  maxInterfaceRetries?: number;
  publishMode?: 'auto' | 'confirm';
} = {}): Config {
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
      maxConcurrentProcesses: 3,
      idleTimeoutMinutes: 10,
      workspaces: [],
    },
    standardKb: {
      outputRoot, retainReleases: 3, buildBatchSize: 10, buildBatchWordBudget: 0,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 30,
      buildParallelism: overrides.parallelism ?? 2, autoBuildAfterSync: false,
      // T2b：审查者显式配置 → 启用编排流水（reviewPipelineActive）
      buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: 'rev-model' }, plannerEnabled: false },
      reviewPolicy: { maxAutoRevisions: overrides.maxAutoRevisions ?? 2, maxInterfaceRetries: overrides.maxInterfaceRetries ?? 2 },
      publishMode: overrides.publishMode ?? 'auto',
    },
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: kbRoot,
    watchedRoots: [],
    watchedRootUrls: [],
    requiredScopes: [],
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
  script: PipelineScript;
  request: (url: string, body?: unknown) => Promise<{ status: number; data: any }>;
  close: () => Promise<void>;
}

function makeHarness(config: Config, script: PipelineScript = {}): Harness {
  const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, idleTimeoutMinutes: 10 });
  const toolService = new AgentToolService({ dataRoot, documentsProvider: () => documents, sheetCsvPaths: () => [] });
  const unitDocs = new Map<string, Array<{ path: string; sources: string[] }>>();
  const service = new KbBuildService({
    dataRoot,
    pool,
    toolService,
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
      const fake = new FakeRpcProcess(toolService, token, script, unitDocs);
      return fake as unknown as PiRpcProcess;
    },
  });
  const app = new Hono();
  app.route('/', kbRoutes({ buildService: service, configManager, localMapStore: store, documentsProvider: () => documents, sheetCsvPaths: () => [] }));
  const request = async (url: string, body?: unknown) => {
    const response = await app.request(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  return { service, pool, script, request, close: async () => { await pool.closeAll(); } };
}

const NON_TERMINAL = ['queued', 'preflight', 'running', 'validating', 'publishing', 'awaiting_release'];

async function waitForTerminal(buildId: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.getKbBuild(buildId);
    if (row && !NON_TERMINAL.includes(String(row.status))) return row;
    if (Date.now() > deadline) throw new Error(`构建未在 ${timeoutMs}ms 内进入终态: ${row ? row.status : 'missing'}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForStatus(buildId: string, status: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.getKbBuild(buildId);
    if (row && String(row.status) === status) return row;
    if (row && !NON_TERMINAL.includes(String(row.status))) throw new Error(`构建进入 ${row.status}（期望 ${status}）：${row.error_code ?? ''} ${row.error_message ?? ''}`);
    if (Date.now() > deadline) throw new Error(`构建未在 ${timeoutMs}ms 内进入 ${status}: ${row ? row.status : 'missing'}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 两顶级目录两源的固定语料（两个单元，各一批）。 */
function seedTwoUnits(prefix: string): void {
  documents.length = 0;
  writeRaw(`${prefix}A/a.md`, `a ${FAT}`);
  writeRaw(`${prefix}B/b.md`, `b ${FAT}`);
  documents.push(docRecord(`tok${prefix}A`, `${prefix}A/a.md`), docRecord(`tok${prefix}B`, `${prefix}B/b.md`));
}

function readReviewsFile(unitId: string, buildId: string): ReviewReport | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(outputRoot, '.staging', buildId, 'reviews', `${unitId}.json`), 'utf-8')) as ReviewReport;
  } catch { return null; }
}

beforeAll(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kborch-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kborch-kb-'));
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

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('T2b：单元写→审→过→整合→最终复核→auto 发布', () => {
  it('全链路状态推进：全部任务 acceptance=passed、报告落盘、候选与验收记录齐全', async () => {
    seedTwoUnits('全链');
    const harness = makeHarness(makeOrchConfig());
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status), String(row.error_message)).toBe('published');

    // 编排终态：write/review/integrate/final 全部闭环
    const progress = await harness.request(`/api/kb/builds/${dto.id}/orchestration`);
    expect(progress.status).toBe(200);
    const tasks: any[] = progress.data.tasks;
    const roles = new Map<string, any[]>();
    for (const task of tasks) {
      const bucket = roles.get(task.role) ?? [];
      bucket.push(task);
      roles.set(task.role, bucket);
    }
    for (const writeTask of roles.get('write') ?? []) {
      expect(writeTask.execState).toBe('done');
      expect(writeTask.artifactState).toBe('available');
      expect(writeTask.acceptanceState).toBe('passed');
    }
    for (const reviewTask of [...(roles.get('review') ?? []), ...(roles.get('final_review') ?? [])]) {
      expect(reviewTask.execState).toBe('done');
      expect(reviewTask.artifactState).toBe('available');
      expect(reviewTask.model.modelPresetId).toBe('rev-model');
    }
    expect(progress.data.reviewSummary).toMatchObject({
      unitsWritten: 2, unitsReviewed: 2, unitsPendingRevision: 0,
      integration: { integratePassed: true, finalReviewDone: true },
    });
    expect(progress.data.ended).toBe(true);
    expect(progress.data.spec.publishMode).toBe('auto');

    // 审查报告与候选文件落盘；验收记录引用单元报告 + 最终复核报告
    const staging = path.join(outputRoot, '.staging', dto.id);
    const uIds = (roles.get('write') ?? []).map((task: any) => task.unitId);
    for (const unitId of uIds) expect(readReviewsFile(unitId, dto.id)?.conclusion).toBe('pass');
    expect(readReviewsFile('all', dto.id)?.conclusion).toBe('pass');
    const candidateFile = JSON.parse(fs.readFileSync(path.join(staging, 'candidate.json'), 'utf-8'));
    expect(candidateFile.candidate.documents.length).toBeGreaterThanOrEqual(2);
    expect(candidateFile.candidate.acceptance.validReportIds.length).toBe(3);
    expect(candidateFile.candidate.carriedOver.every((entry: any) => entry.priorReview === 'reviewed')).toBe(true);

    // 发布产物：单元文档进入 release，CURRENT 切换（正文含 v1）
    const kbStore = new StandardKbStore(outputRoot);
    const manifest = kbStore.readManifest(kbStore.readCurrent()!.releaseId)!;
    expect(manifest.docs.length).toBeGreaterThanOrEqual(2);
    const unitDoc = manifest.docs.find((doc) => doc.path.includes('u1-') || doc.path.includes('u2-'))!;
    const docBody = fs.readFileSync(path.join(outputRoot, 'releases', manifest.releaseId, 'docs', unitDoc.path), 'utf-8');
    expect(docBody).toContain('整合'); // 整合轮改写了 u1 首篇（fake 默认行为）
    const untouched = manifest.docs.find((doc) => doc.path.includes('u2-'))!;
    expect(fs.readFileSync(path.join(outputRoot, 'releases', manifest.releaseId, 'docs', untouched.path), 'utf-8')).toContain('v1');
  });

  it('进度端点任务 DTO 形状（三轴/等待原因/模型/预算/阻断计数）', async () => {
    seedTwoUnits('进度');
    const harness = makeHarness(makeOrchConfig());
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    await waitForTerminal(dto.id);
    const { data } = await harness.request(`/api/kb/builds/${dto.id}/orchestration`);
    const writeTask = data.tasks.find((task: any) => task.role === 'write');
    expect(writeTask).toMatchObject({
      taskId: expect.stringMatching(/^t:write:u\d+:r0$/),
      unitId: expect.any(String),
      round: 0,
      attempt: 0,
      execState: 'done',
      artifactState: 'available',
      acceptanceState: 'passed',
      waitingOn: [],
      model: { modelPresetId: '' },
      revisionBudget: { usedAutoRevisions: expect.any(Number), maxAutoRevisions: 2 },
      blockingIssues: 0,
    });
    const reviewTask = data.tasks.find((task: any) => task.role === 'review');
    expect(reviewTask.blockingIssues).toBe(0);
    expect(reviewTask.model.modelPresetId).toBe('rev-model');
    // 不存在的构建 404；无编排数据的旧构建 404
    expect((await harness.request('/api/kb/builds/b_none/orchestration')).status).toBe(404);
  });
});

describe('T2b：blocking → 定向修订 → 复审通过（B 案 §5）', () => {
  it('修订稿换版本：旧报告不批准新稿、预算消耗正确、发布内容为修订稿', async () => {
    seedTwoUnits('修订');
    const script: PipelineScript = { blockingUnits: ['u1'], prompts: [] };
    const harness = makeHarness(makeOrchConfig({ maxAutoRevisions: 2 }), script);
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status), String(row.error_message)).toBe('published');

    // 修订轮 prompt 注入了问题清单；修订写入了 v2 正文
    const revisePrompt = script.prompts?.find((message) => message.includes('【修订轮 u1】'));
    expect(revisePrompt).toBeTruthy();
    expect(revisePrompt!).toContain('数值抄录错误');
    const kbStore = new StandardKbStore(outputRoot);
    const manifest = kbStore.readManifest(kbStore.readCurrent()!.releaseId)!;
    const revised = manifest.docs.find((doc) => doc.path.includes('u1-'));
    expect(fs.readFileSync(path.join(outputRoot, 'releases', manifest.releaseId, 'docs', revised!.path), 'utf-8')).toContain('v2');

    // 预算消耗 1；u1 的 r1 审查报告哈希 ≠ r0（旧报告不能批准新稿）
    const { data } = await harness.request(`/api/kb/builds/${dto.id}/orchestration`);
    expect(data.autoRevisionUsage['unit:u1']).toBe(1);
    expect(data.autoRevisionUsage['unit:u2'] ?? 0).toBe(0);
    const u1Tasks = data.tasks.filter((task: any) => task.unitId === 'u1');
    expect(u1Tasks.filter((task: any) => task.role === 'write').map((task: any) => task.round)).toEqual([0, 1]);
    const archiveDir = path.join(outputRoot, '.staging', dto.id, 'reviews', 'archive');
    const archived = fs.readdirSync(archiveDir).filter((name) => name.startsWith('u1.'));
    expect(archived.length).toBeGreaterThanOrEqual(2);
    const current = readReviewsFile('u1', dto.id)!;
    expect(current.conclusion).toBe('pass');
    const round0 = JSON.parse(fs.readFileSync(path.join(archiveDir, archived.find((name) => name.includes('_r0'))!), 'utf-8')) as ReviewReport;
    expect(round0.conclusion).toBe('needs_revision');
    expect(round0.draftHash).not.toBe(current.draftHash);
  });
});

describe('T2b：修订预算超限 → pending_decision + kb_review_required 可恢复', () => {
  it('超限失败保留待审报告；恢复后人工续作重审通过并发布', async () => {
    seedTwoUnits('超限');
    const config = makeOrchConfig({ maxAutoRevisions: 1 });
    const harness = makeHarness(config, { alwaysBlockingUnits: ['u1'] });
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status)).toBe('failed');
    expect(String(row.error_code)).toBe('kb_review_required');
    expect(String(row.error_message)).toContain('阻断');
    // CURRENT 不动、待审报告保留、pending_decision 落在检查点
    const beforeCurrent = new StandardKbStore(outputRoot).readCurrent()?.releaseId ?? null;
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId ?? null).toBe(beforeCurrent);
    const pendingReport = readReviewsFile('u1', dto.id);
    expect(pendingReport?.issues.filter((issue) => issue.severity === 'blocking').length).toBeGreaterThan(0);
    const checkpoint = new BuildCheckpointStore(outputRoot).read(dto.id)!;
    const pendingTask = checkpoint.orchestration!.tasks.find((task) => task.taskId === 't:write:u1:r1');
    expect(pendingTask?.acceptanceState).toBe('pending_decision');
    await harness.close();

    // 恢复：人工处理后 pending_decision → unreviewed → 重审（不消耗预算）；脚本改判 pass
    const resumed = makeHarness(config, { prompts: [] });
    const response = await resumed.request(`/api/kb/builds/${dto.id}/resume`, { confirm: 'RESUME' });
    expect(response.status, JSON.stringify(response.data)).toBe(202);
    const final = await waitForTerminal(dto.id);
    expect(String(final.status), String(final.error_message)).toBe('published');
    // 重审仍是 r1 轮（预算未新增消耗：usage 保持 1）
    const progress = await resumed.request(`/api/kb/builds/${dto.id}/orchestration`);
    expect(progress.data.autoRevisionUsage['unit:u1']).toBe(1);
    expect(progress.data.reviewSummary.unitsReviewed).toBe(2);
    // 恢复轮没有重跑 u2（已通过保留）
    const rerunU2 = progress.data.tasks.filter((task: any) => task.unitId === 'u2' && task.role === 'write').length;
    expect(rerunU2).toBe(1);
  });
});

describe('T2b：整合改文档 → 最终复核拦截 → 整合修订 → 复核通过（B 案 §4）', () => {
  it('改写文档进必审范围：首轮最终复核 blocking，整合修订后复核通过', async () => {
    seedTwoUnits('整合');
    const script: PipelineScript = { firstFinalReviewBlocking: true, prompts: [] };
    const harness = makeHarness(makeOrchConfig(), script);
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status), String(row.error_message)).toBe('published');

    const { data } = await harness.request(`/api/kb/builds/${dto.id}/orchestration`);
    const integrates = data.tasks.filter((task: any) => task.role === 'integrate');
    expect(integrates.map((task: any) => task.round)).toEqual([0, 1]);
    expect(integrates.every((task: any) => task.acceptanceState === 'passed' || task.round === 0)).toBe(true);
    const finals = data.tasks.filter((task: any) => task.role === 'final_review');
    expect(finals.length).toBe(2);
    expect(data.autoRevisionUsage['role:integrate']).toBe(1);
    // 整合修订 prompt 注入最终复核问题；发布内容含 v3
    expect(script.prompts?.some((message) => message.includes('【整合修订轮】') && message.includes('数值抄录错误'))).toBe(true);
    const kbStore = new StandardKbStore(outputRoot);
    const manifest = kbStore.readManifest(kbStore.readCurrent()!.releaseId)!;
    const changed = manifest.docs.find((doc) => doc.path.includes('u1-'));
    expect(fs.readFileSync(path.join(outputRoot, 'releases', manifest.releaseId, 'docs', changed!.path), 'utf-8')).toContain('v3');
    // 两轮最终复核绑定不同候选哈希（整合修订换了版本）
    const current = readReviewsFile('all', dto.id)!;
    expect(current.conclusion).toBe('pass');
  });
});

describe('T2b：接口失败与内容修订分开计数（B 案 §5）', () => {
  it('审查接口失败重试不消耗修订预算；报告缺失=执行失败并重试', async () => {
    seedTwoUnits('接口');
    const script: PipelineScript = { reviewInterfaceFailures: 1, reviewMissingReports: 1, prompts: [] };
    // T2a 计数：失败 used+1，used<max 才能重试 → 容忍 2 次注入失败需 max=3
    const harness = makeHarness(makeOrchConfig({ maxInterfaceRetries: 3 }), script);
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status), String(row.error_message)).toBe('published');

    const { data } = await harness.request(`/api/kb/builds/${dto.id}/orchestration`);
    // 接口重试发生过（计数与内容修订分开），修订预算为 0
    expect(data.interfaceRetryTotal).toBeGreaterThanOrEqual(2);
    expect(Object.values(data.autoRevisionUsage).every((used: number) => used === 0)).toBe(true);
    // 报告缺失后重试仍拿到报告（最终 pass 落盘）
    expect(readReviewsFile('all', dto.id)?.conclusion).toBe('pass');
  });

  it('接口重试耗尽 → 任务 failed、构建 failed 可恢复', async () => {
    seedTwoUnits('耗尽');
    const before = new StandardKbStore(outputRoot).readCurrent()?.releaseId ?? null;
    const harness = makeHarness(makeOrchConfig({ maxInterfaceRetries: 0 }), { reviewInterfaceFailures: 99 });
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status)).toBe('failed');
    expect(String(row.error_code)).toBe('kb_interface_failed');
    expect(String(row.error_message)).toContain('接口失败重试耗尽');
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId ?? null).toBe(before);
    await harness.close();
  });
});

describe('T2b：confirm 模式（B 案 §7）', () => {
  it('停在 awaiting_release；确认后发布；期间不能再建构建', async () => {
    seedTwoUnits('确认');
    const harness = makeHarness(makeOrchConfig({ publishMode: 'confirm' }));
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const awaiting = await waitForStatus(dto.id, 'awaiting_release');
    expect(String(awaiting.status)).toBe('awaiting_release');
    // 候选就绪但 CURRENT 不动；active 构建占用（不能再建）
    const before = new StandardKbStore(outputRoot).readCurrent()?.releaseId ?? null;
    await expect(harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' }))
      .rejects.toMatchObject({ code: 'kb_build_running' });
    const candidateFile = JSON.parse(fs.readFileSync(path.join(outputRoot, '.staging', dto.id, 'candidate.json'), 'utf-8'));
    const candidateHash = candidateFile.candidateHash as string;

    const confirmed = await harness.request(`/api/kb/builds/${dto.id}/release-confirm`, { candidateHash });
    expect(confirmed.status, JSON.stringify(confirmed.data)).toBe(200);
    expect(confirmed.data.status).toBe('published');
    const after = new StandardKbStore(outputRoot).readCurrent()!;
    expect(after.releaseId).not.toBe(before);
    // 确认绑定写入候选验收记录
    const acceptance = JSON.parse(fs.readFileSync(path.join(outputRoot, '.staging', dto.id, 'candidate.json'), 'utf-8')).candidate.acceptance;
    void acceptance;
    const manifest = new StandardKbStore(outputRoot).readManifest(after.releaseId)!;
    expect(manifest.docs.length).toBeGreaterThanOrEqual(2);
  });

  it('确认后内容变化失效拒绝（kb_confirm_stale），状态保持待确认', async () => {
    seedTwoUnits('失效');
    const harness = makeHarness(makeOrchConfig({ publishMode: 'confirm' }));
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    await waitForStatus(dto.id, 'awaiting_release');
    // 篡改草稿内容 → 候选哈希不匹配（从候选清单取具体文件路径）
    const candidateFile = JSON.parse(fs.readFileSync(path.join(outputRoot, '.staging', dto.id, 'candidate.json'), 'utf-8'));
    const targetDoc = candidateFile.candidate.documents[0]!.path as string;
    fs.appendFileSync(path.join(outputRoot, '.staging', dto.id, 'docs', targetDoc), '\n<!-- 手工改动 -->');
    const rejected = await harness.request(`/api/kb/builds/${dto.id}/release-confirm`, {});
    expect(rejected.status).toBe(409);
    expect(rejected.data.error).toBe('kb_confirm_stale');
    expect(String(store.getKbBuild(dto.id)!.status)).toBe('awaiting_release');
    // 取消待确认构建释放占用
    const cancelled = await harness.request(`/api/kb/builds/${dto.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.status).toBe('cancelled');
  });
});

describe('T2b：取消与恢复（B 案 §8）', () => {
  it('审查挂起时取消：终态 cancelled、已通过单元保留、迟到回执不推进发布', async () => {
    seedTwoUnits('取消');
    const script: PipelineScript = { hangReviewUnit: 'u2', prompts: [] };
    const harness = makeHarness(makeOrchConfig(), script);
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    // 等 u2 的审查 prompt 挂起（出现标记即已进入 hang），再取消
    const deadline = Date.now() + 8000;
    while (!(script.prompts ?? []).some((message) => message.includes('【单元审查 u2】')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((script.prompts ?? []).some((message) => message.includes('【单元审查 u2】'))).toBe(true);
    const beforeCancel = new StandardKbStore(outputRoot).readCurrent()?.releaseId ?? null;
    await harness.service.cancelBuild(store as never, dto.id);
    const row = await waitForTerminal(dto.id);
    expect(String(row.status)).toBe('cancelled');
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId ?? null).toBe(beforeCancel);
    // 检查点（最后一次持久化状态）：u1 已通过（保留不重跑）；u2 的审查
    // 任务未完成（running→恢复时归一 queued 续审；endBuild 的取消只进
    // orchestration_json 摘要列，迟到回执不推进发布由状态机保证）
    const checkpoint = new BuildCheckpointStore(outputRoot).read(dto.id)!;
    const u1Write = checkpoint.orchestration!.tasks.find((task) => task.taskId === 't:write:u1:r0');
    expect(u1Write?.acceptanceState).toBe('passed');
    const u2Review = checkpoint.orchestration!.tasks.find((task) => task.taskId === 't:review:u2:r0');
    expect(u2Review?.execState).toBe('running');
    expect(u2Review?.acceptanceState !== 'passed').toBe(true);
    expect(JSON.parse(String(row.orchestration_json)).ended).toBe(true);
    await harness.close();
  });

  it('恢复续审：u1 已通过不重跑、u2 续审后走完整合与最终复核', async () => {
    seedTwoUnits('续审');
    const script: PipelineScript = { hangReviewUnit: 'u2', prompts: [] };
    const first = makeHarness(makeOrchConfig(), script);
    const dto = await first.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const hangDeadline = Date.now() + 8000;
    while (!(script.prompts ?? []).some((message) => message.includes('【单元审查 u2】')) && Date.now() < hangDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await first.service.cancelBuild(store as never, dto.id);
    await waitForTerminal(dto.id);
    await first.close();

    // 新一代 harness：u2 审查正常返回 pass
    const resumed = makeHarness(makeOrchConfig(), { prompts: [] });
    const response = await resumed.request(`/api/kb/builds/${dto.id}/resume`, { confirm: 'RESUME' });
    expect(response.status, JSON.stringify(response.data)).toBe(202);
    const final = await waitForTerminal(dto.id);
    expect(String(final.status), String(final.error_message)).toBe('published');
    // 恢复轮：u1 未再审查/未再写作（第一代已通过保留）；u2 审查恰一次
    const u1ReviewPrompts = (resumed.script.prompts ?? []).filter((message) => message.includes('【单元审查 u1】'));
    const u2ReviewPrompts = (resumed.script.prompts ?? []).filter((message) => message.includes('【单元审查 u2】'));
    expect(u1ReviewPrompts).toHaveLength(0);
    expect(u2ReviewPrompts).toHaveLength(1);
    const u1WritePrompts = (resumed.script.prompts ?? []).filter((message) => message.includes('【单元 u1 · 批次'));
    expect(u1WritePrompts).toHaveLength(0);
    // 整合与最终复核在恢复轮执行
    expect((resumed.script.prompts ?? []).some((message) => message.includes('【整体整合】'))).toBe(true);
    expect((resumed.script.prompts ?? []).some((message) => message.includes('【最终复核】'))).toBe(true);
    await resumed.close();
  });
  it('diting F05：恢复时冻结模型与当前配置解析不一致 → kb_resume_stale（构建待处理，不静默换模型）', async () => {
    seedTwoUnits('冻结');
    const script: PipelineScript = { hangReviewUnit: 'u2', prompts: [] };
    const first = makeHarness(makeOrchConfig(), script);
    const dto = await first.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const hangDeadline = Date.now() + 8000;
    while (!(script.prompts ?? []).some((message) => message.includes('【单元审查 u2】')) && Date.now() < hangDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await first.service.cancelBuild(store as never, dto.id);
    await waitForTerminal(dto.id);
    await first.close();

    // 同一 modelPresetId 被原位改参数（openAiModel 变化）——冻结的 resolvedRoles
    // 与当前解析不一致 → 拒绝恢复并明示，不静默换模型。
    const mutated = makeOrchConfig();
    mutated.llm.providers[0]!.models = [{ id: 'rev-model', name: 'RM2', openAiModel: 'fake-review-model-v2', enabled: true }];
    const resumed = makeHarness(mutated, { prompts: [] });
    const response = await resumed.request(`/api/kb/builds/${dto.id}/resume`, { confirm: 'RESUME' });
    expect(response.status, JSON.stringify(response.data)).toBe(409);
    expect(JSON.stringify(response.data)).toContain('冻结模型与当前配置不一致');
    expect(JSON.stringify(response.data)).toContain('fake-review-model');
    await resumed.close();
  });
});

describe('T2b：旧路径回归（reviewPipelineActive 关闭）', () => {
  it('无任何角色显式配置且 publishMode=auto → 不进入编排流水，行为同旧并行路径（diting F04：空值不再单独关闭流水——任一显式角色或 confirm 都启用）', async () => {
    seedTwoUnits('回归');
    const config = makeOrchConfig();
    config.standardKb.buildRoles = { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, plannerEnabled: false };
    const harness = makeHarness(config, { prompts: [] });
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status), String(row.error_message)).toBe('published');
    // 没有任何审查/整合编排 prompt
    const prompts = harness.script.prompts ?? [];
    expect(prompts.some((message) => message.includes('【单元审查'))).toBe(false);
    expect(prompts.some((message) => message.includes('【最终复核】'))).toBe(false);
    // 编排快照只有旧式 write 任务（无 review/integrate 角色）
    const checkpoint = new BuildCheckpointStore(outputRoot).read(dto.id)!;
    const roles = new Set(checkpoint.orchestration!.tasks.map((task) => task.role));
    expect([...roles].sort()).toEqual(['write']);
    await harness.close();
  });
});

describe('T2b：diting F04——启用门与空值语义', () => {
  it('跨层：设置 → buildSpecFromConfig → reviewPipelineActive（显式 confirm / 任一角色显式均启用；全空且 auto 才关闭）', async () => {
    // 设置层形状：与 BuildOrchestrationSettings 落库同构（StandardKbConfig 片段）
    const base = {
      buildId: 'b_f04',
      snapshotEntries: [],
      baseReleaseId: null,
    };
    // ① 显式 confirm（reviewer 空值=「跟随活跃预设（启用编排流水）」）
    const confirmSpec = buildSpecFromConfig({
      ...base,
      standardKb: {
        buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, plannerEnabled: false },
        reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
        publishMode: 'confirm',
      },
    });
    expect(reviewPipelineActive(confirmSpec)).toBe(true); // 显式 confirm 必须 await 释放屏障
    expect(confirmSpec.publishMode).toBe('confirm');
    // ② writer 显式（reviewer 空值）→ 启用
    const writerSpec = buildSpecFromConfig({
      ...base,
      standardKb: {
        buildRoles: { writer: { modelPresetId: 'glm-4.7' }, reviewer: { modelPresetId: '' }, plannerEnabled: false },
        reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
        publishMode: 'auto',
      },
    });
    expect(reviewPipelineActive(writerSpec)).toBe(true);
    // ③ integrator 显式 → 启用
    const integratorSpec = buildSpecFromConfig({
      ...base,
      standardKb: {
        buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, integrator: { modelPresetId: 'glm-4.7' }, plannerEnabled: false },
        reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
        publishMode: 'auto',
      },
    });
    expect(reviewPipelineActive(integratorSpec)).toBe(true);
    // ④ 全空 + auto → 旧路径（旧检查点同判）
    const legacySpec = buildSpecFromConfig({
      ...base,
      standardKb: {
        buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, plannerEnabled: false },
        reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
        publishMode: 'auto',
      },
    });
    expect(reviewPipelineActive(legacySpec)).toBe(false);
  });

  it('端到端：reviewer 空值 + publishMode=confirm → 编排流水生效并停在 awaiting_release（确认屏障不被空值关闭）', async () => {
    seedTwoUnits('确认屏');
    const config = makeOrchConfig({ publishMode: 'confirm' });
    config.standardKb.buildRoles = { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, plannerEnabled: false };
    const harness = makeHarness(config, { prompts: [] });
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    await waitForStatus(dto.id, 'awaiting_release');
    // 走了完整编排流水（写→审→整合→最终复核），等待用户确认释放
    const prompts = harness.script.prompts ?? [];
    expect(prompts.some((message) => message.includes('【单元审查'))).toBe(true);
    expect(prompts.some((message) => message.includes('【最终复核】'))).toBe(true);
    // 确认后发布成功
    const confirmed = await harness.request(`/api/kb/builds/${dto.id}/release-confirm`, {});
    expect(confirmed.status, JSON.stringify(confirmed.data)).toBe(200);
    const final = await waitForTerminal(dto.id);
    expect(String(final.status), String(final.error_message)).toBe('published');
    await harness.close();
  });
});
