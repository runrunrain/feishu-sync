/**
 * diting T7 接缝回归（同一数据流闭环）：真实 kb_write_doc（带对象/证据
 * 声明）→ 单元审查通过（回写机器审凭据，F03）→ 检查点（含组织产物，F01）
 * → 中断 → 恢复 → 编译（坐标不差生成标题，F02）→ v2 发布 → 对象查询
 * 读取；随后增量构建验证基线登记参与初始化（F06：身份不重生成、托管文档
 * 旧式重写显式拒绝、纯重申继承审查）。
 *
 * 这是 diting 指出的关键缺口补齐：跨切片接缝测试，不是单切片用例的叠加。
 * F04（启用门/confirm 屏障跨层）、F05（冻结模型恢复校验）的流水级用例
 * 在 build-pipeline.test.ts / build-orchestration.test.ts；本文件另附
 * F04/F05/F07/F08 的轻量反例锚点，保证 seam 文件自含全部 findings。
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
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { KbVersionStore } from '../src/kb/kb-version-store.js';
import { BuildOrchestration, buildSpecFromConfig, reviewPipelineActive } from '../src/kb/build-orchestration.js';
import { compileKnowledgeRelease } from '../src/kb/knowledge-compiler.js';
import { computePayloadHash } from '../src/kb/knowledge-schema.js';
import type { KnowledgeObject } from '../src/kb/knowledge-schema.js';
import { getKbQueryService } from '../src/kb/search/kb-query-service.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { Config, DocumentRecord } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

const FAT = '规则的详细说明段落，包含定义、流程、边界与示例，用于把原始源体积撑到足以覆盖产出文档的校验阈值。'.repeat(8);
const SEAM_A_LINES = [
  '# 攻防修正源',
  '攻防差每点提供 0.5% 修正，上限 30%。',
  `背景与示例。${FAT}`,
];
const SEAM_B_LINES = ['# 换算说明源', `换算规则与边界。${FAT}`];

/** 声明用正文（markdown 参数坐标）：两章节两对象。 */
const SEAM_MARKDOWN = [
  '## Alpha 攻防修正',
  `ALPHA_ONLY 攻防差每点提供 0.5% 修正，上限 30%。${FAT}`,
  '## Beta 换算说明',
  `BETA_ONLY 修正值按百分比档位换算，不做小数累积。${FAT}`,
].join('\n');

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let store: LocalMapStore;
const documents: DocumentRecord[] = [];

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

function seedCorpus(): void {
  documents.length = 0;
  writeRaw('主题/seam-a.md', SEAM_A_LINES.join('\n'));
  writeRaw('主题/seam-b.md', SEAM_B_LINES.join('\n'));
  documents.push(docRecord('tokSeamA', '主题/seam-a.md'), docRecord('tokSeamB', '主题/seam-b.md'));
}

// ---------------------------------------------------------------------------
// 假进程：声明式写入 + 审查 pass + 可挂起的最终复核
// ---------------------------------------------------------------------------

type SeamMode = 'declare' | 'plainB' | 'oldStyleManaged' | 'redeclareA';

interface SeamScript {
  prompts: string[];
  mode: SeamMode;
  /** 最终复核 prompt 到达后挂起（中断场景） */
  hangFinalReview?: boolean;
  /** 捕获的工具错误（旧式重写拒绝等） */
  toolError?: { code: string; message: string };
  /** kb_write_doc 返回的 clientKey→objectId 映射 */
  objectIds?: Record<string, string>;
}

class SeamFakeRpc extends EventEmitter {
  exited = false;
  private pending: Array<(value: unknown) => void> = [];

  constructor(
    private readonly toolService: AgentToolService,
    private readonly token: string,
    private readonly script: SeamScript,
  ) { super(); }

  isExited(): boolean { return this.exited; }
  async start(): Promise<void> {}
  async sendCommand(): Promise<{ success: boolean }> { return { success: true }; }
  async abort(): Promise<void> { for (const r of this.pending.splice(0)) r({ outcome: 'aborted' }); }
  async terminate(): Promise<void> { await this.abort(); if (!this.exited) { this.exited = true; this.emit('exit'); } }

  async prompt(message: string): Promise<unknown> {
    this.script.prompts.push(message);
    try {
      return await this.act(message);
    } catch (error) {
      return { outcome: 'failed', error: { code: 'fake_script_error', message: String(error) } };
    }
  }

  private async act(message: string): Promise<unknown> {
    if (message.includes('【单元审查') || message.includes('【最终复核】')) {
      if (message.includes('【最终复核】') && this.script.hangFinalReview) {
        return await new Promise((resolve) => { this.pending.push(resolve as (value: unknown) => void); });
      }
      const unitId = message.includes('【最终复核】') ? 'all' : (/【单元审查 (u\d+)】/.exec(message)?.[1] ?? 'all');
      const sourceRefs = [...message.matchAll(/^- (tok\S+)（/gm)].map((match) => match[1]);
      await this.call('kb_submit_review', {
        ...(unitId === 'all' ? {} : { unitId }),
        coverage: { sourceRefs: sourceRefs.length > 0 ? sourceRefs.slice(0, 5) : ['tok-any'] },
        checkedDimensions: ['事实与数值', '对象声明与正文一致'],
        issues: [], uncheckedScope: [], conclusion: 'pass',
      });
      return { outcome: 'completed' };
    }
    if ((message.includes('【单元') || message.includes('【批次')) && message.includes('请处理以下')) {
      return await this.actBatch(message);
    }
    if (message.includes('kb_unit_done')) {
      await this.call('kb_unit_done', { summary: '单元完成（seam fixture）', skipped: [] });
      return { outcome: 'completed' };
    }
    if (message.includes('kb_finish')) {
      const skipped = this.script.mode === 'declare' ? [{ objToken: 'tokSeamB', reason: 'seam 切片只组织 A 源' }] : [];
      await this.call('kb_finish', { summary: '整体完成（seam fixture）', skipped });
      return { outcome: 'completed' };
    }
    return { outcome: 'completed' };
  }

  /** 声明式写入：raw_read 取回执 → kb_write_doc（对象/证据/覆盖声明）。
   * redeclareA 模式下增量单元划分可能产生多个单元：只在预认领了 seam-a
   * 的单元写入（提示词的「受影响的已有标准文档」段），其余单元只上报。 */
  private async actBatch(message: string): Promise<unknown> {
    if (this.script.mode === 'oldStyleManaged') {
      try {
        await this.call('kb_write_doc', {
          path: '主题/seam-a.md', title: '攻防与换算',
          markdown: '旧式重写：不带任何声明参数。', sources: ['tokSeamA'], summary: '旧式概要',
        });
      } catch (error) {
        this.script.toolError = { code: String((error as { code?: string }).code ?? ''), message: String((error as Error).message ?? error) };
        return { outcome: 'failed', error: this.script.toolError };
      }
      return { outcome: 'completed' };
    }
    if (this.script.mode === 'plainB') {
      await this.call('kb_write_doc', {
        path: '主题/seam-b.md', title: '换算说明',
        markdown: `BETA_DOC 换算规则正文（未组织化）。${FAT}`, sources: ['tokSeamB'], summary: '换算概要',
      });
      await this.call('kb_unit_done', { summary: 'B 源文档完成', skipped: [] });
      return { outcome: 'completed' };
    }
    // declare / redeclareA：真实声明工具链（F02 的接缝在 markdown 参数 → 编译坐标）。
    // redeclareA 模式下增量单元按预认领分路：seam-a 单元做声明重申；
    // seam-b 单元写未组织化文档；都不是则只上报。
    if (this.script.mode === 'redeclareA') {
      if (!message.includes('- 主题/seam-a.md')) {
        if (message.includes('- 主题/seam-b.md')) {
          await this.call('kb_write_doc', {
            path: '主题/seam-b.md', title: '换算说明',
            markdown: `BETA_DOC 换算规则正文（未组织化，重写版）。${FAT}`,
            sources: ['tokSeamB'], summary: '换算概要',
          });
          await this.call('kb_unit_done', { summary: 'B 源文档重写完成', skipped: [] });
          return { outcome: 'completed' };
        }
        const tokens = [...message.matchAll(/^\| (tok\S+) \|/gm)].map((match) => match[1]);
        await this.call('kb_unit_done', {
          summary: '本单元无预认领文档',
          skipped: tokens.map((token) => ({ objToken: token, reason: 'seam 切片由认领单元处理' })),
        });
        return { outcome: 'completed' };
      }
    }
    const read = await this.call('raw_read', { objToken: 'tokSeamA' });
    const readReceiptId = (read as { details?: { readReceiptId?: string | null } }).details?.readReceiptId ?? null;
    if (!readReceiptId) return { outcome: 'failed', error: { code: 'fake_no_receipt', message: 'raw_read 未返回回执' } };
    const suffix = this.script.mode === 'redeclareA' ? '-two' : '';
    const result = await this.call('kb_write_doc', {
      path: '主题/seam-a.md',
      title: '攻防与换算',
      markdown: SEAM_MARKDOWN,
      sources: ['tokSeamA'],
      summary: '攻防修正与换算的概要说明',
      objects: [
        {
          clientKey: `alpha${suffix}`, type: 'rule', title: 'Alpha 攻防修正',
          familyKey: 'fam:seam:alpha', variantKey: 'v1', scopeKey: 'scope:seam-global', scopeText: 'seam 全局',
          headingPath: ['Alpha 攻防修正'],
          claims: [{ claimKey: 'alpha-cap', riskCategory: 'high' }],
        },
        {
          clientKey: `beta${suffix}`, type: 'concept', title: 'Beta 换算说明',
          familyKey: 'fam:seam:beta', variantKey: 'v1', scopeKey: 'scope:seam-global', scopeText: 'seam 全局',
          headingPath: ['Beta 换算说明'],
          claims: [{ claimKey: 'beta-note', riskCategory: 'normal' }],
        },
      ],
      evidenceClaims: [{
        clientKey: `ev-alpha${suffix}`, objectKey: `alpha${suffix}`, claimKey: 'alpha-cap',
        sourceRef: { sourceId: 'tokSeamA', resourceId: 'tokSeamA' },
        selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0, headingPath: [] },
        role: 'supports', nature: 'direct', readReceiptId,
      }],
      coverageUpdates: [{
        itemId: 'cov-alpha', sourceId: 'tokSeamA', category: 'formula', importance: 'important',
        disposition: 'mapped', targetKeys: [`alpha${suffix}`],
      }],
    });
    this.script.objectIds = ((result as { details?: { objectMap?: Record<string, string> } }).details?.objectMap) ?? undefined;
    await this.call('kb_unit_done', { summary: 'A 源组织完成', skipped: [] });
    return { outcome: 'completed' };
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return await this.toolService.executeTool(this.token, tool, args);
  }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function makeSeamConfig(publishMode: 'auto' | 'confirm' = 'auto'): Config {
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
      outputRoot, retainReleases: 5, buildBatchSize: 10, buildBatchWordBudget: 0,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 30, buildParallelism: 1, autoBuildAfterSync: false,
      buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: 'rev-model' }, plannerEnabled: false },
      reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
      publishMode,
    },
    pollIntervalMinutes: 30, knowledgeBaseRoot: kbRoot, watchedRoots: [], watchedRootUrls: [], requiredScopes: [],
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
  script: SeamScript;
  close: () => Promise<void>;
}

function makeHarness(script: SeamScript, publishMode: 'auto' | 'confirm' = 'auto'): Harness {
  const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, idleTimeoutMinutes: 10 });
  const toolService = new AgentToolService({ dataRoot, documentsProvider: () => documents, sheetCsvPaths: () => [] });
  const service = new KbBuildService({
    dataRoot, pool, toolService, resolver: stubResolver(),
    configProvider: () => makeSeamConfig(publishMode),
    documentsProvider: () => documents,
    excludedSourcesProvider: () => [], sheetCsvPaths: () => [],
    internalBaseUrl: () => 'http://127.0.0.1:39999', extensionPath: () => null, promptAssets: () => null,
    processFactory: (options) => {
      const token = String(options.env.FEISHU_SYNC_AGENT_RUN_TOKEN ?? '');
      return new SeamFakeRpc(toolService, token, script) as unknown as PiRpcProcess;
    },
  });
  return { service, script, close: async () => { await pool.closeAll(); } };
}

const NON_TERMINAL = ['queued', 'preflight', 'running', 'validating', 'publishing', 'awaiting_release'];

async function waitForTerminal(buildId: string, timeoutMs = 20000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.getKbBuild(buildId);
    if (row && !NON_TERMINAL.includes(String(row.status))) return row;
    if (Date.now() > deadline) throw new Error(`构建未在 ${timeoutMs}ms 内进入终态: ${row ? `${row.status} ${row.error_code ?? ''} ${row.error_message ?? ''}` : 'missing'}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitPrompt(script: SeamScript, marker: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!script.prompts.some((message) => message.includes(marker)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!script.prompts.some((message) => message.includes(marker))) throw new Error(`未等到 prompt: ${marker}`);
}

function readStaging<T>(buildId: string, relative: string): T {
  return JSON.parse(fs.readFileSync(path.join(outputRoot, '.staging', buildId, relative), 'utf-8')) as T;
}

interface DraftShape {
  objects: KnowledgeObject[];
  docs: Record<string, { docId: string; revision: number; bodyLineOffset?: number; basis?: string; carriedHash?: string }>;
}

function releaseDocLines(releaseId: string, docPath: string): string[] {
  const content = fs.readFileSync(path.join(outputRoot, 'releases', releaseId, 'docs', docPath), 'utf-8');
  return content.replace(/^<!--\s*\nfeishu_sync_kb:[\s\S]*?\n-->\s*\n?/, '').split('\n');
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-kb-'));
  outputRoot = path.join(dataRoot, 'standard-kb');
  fs.mkdirSync(path.join(dataRoot, 'agent'), { recursive: true });
  store = new LocalMapStore(path.join(dataRoot, 'feishu-sync.db'));
  store.initialize();
});

afterAll(() => {
  store.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
});

// ===========================================================================
// 主闭环：声明 → 审查 → 检查点 → 中断恢复 → v2 发布 → 对象查询（F01/F02/F03）
// ===========================================================================

describe('seam 主闭环（F01/F02/F03）', () => {
  it('带对象+证据、已审节点后中断恢复：全链路数据不丢、坐标不错位、审查凭据接通', async () => {
    seedCorpus();
    // ---- 第一代：声明写入 → 单元审查通过 → 整合完成 → 最终复核挂起中断 ----
    const gen1 = makeHarness({ mode: 'declare', prompts: [], hangFinalReview: true });
    const dto = await gen1.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    await waitPrompt(gen1.script, '【最终复核】');
    // 中断前 staging 真相：对象已过机器审（单元报告绑定，F03a）
    const midDraft = readStaging<DraftShape>(dto.id, 'knowledge-draft.json');
    expect(midDraft.objects).toHaveLength(2);
    for (const object of midDraft.objects) {
      expect(object.reviewStatus).toBe('passed');
      expect(object.reviewActorKind).toBe('machine');
      expect(object.reviewerId).toMatch(/^kr_/);
    }
    const unitReportId = midDraft.objects[0]!.reviewerId;
    const alphaId = gen1.script.objectIds!['alpha']!;
    const betaId = gen1.script.objectIds!['beta']!;
    expect(alphaId).toMatch(/^ko_/);

    await gen1.service.cancelBuild(store as never, dto.id);
    await waitForTerminal(dto.id);
    await gen1.close();

    // ---- F01：检查点纳入组织产物与哈希清单（不丢声明/回执/报告） ----
    const checkpoint = new BuildCheckpointStore(outputRoot).read(dto.id)!;
    expect(checkpoint.files).toMatchObject({
      'knowledge-draft.json': expect.any(String),
      'read-receipts.jsonl': expect.any(String),
      'reviews/u1.json': expect.any(String),
    });
    // F05（seam 锚点）：冻结的实际模型参数随检查点留存，恢复可校验
    const spec = checkpoint.orchestration!.spec;
    expect(spec.resolvedRoles?.reviewer).toMatchObject({ modelId: 'fake-review-model', providerId: 'pf1' });
    expect(() => BuildOrchestration.restore(checkpoint.orchestration!)).not.toThrow();

    // ---- 第二代：恢复 → 最终复核通过 → v2 发布 ----
    const gen2 = makeHarness({ mode: 'declare', prompts: [] });
    await gen2.service.resumeBuild(store as never, dto.id, 'RESUME');
    const final = await waitForTerminal(dto.id);
    expect(String(final.status), String(final.error_message)).toBe('published');
    await gen2.close();

    const releaseId = String(final.release_id);
    const kbStore = new StandardKbStore(outputRoot);
    const manifest = kbStore.readManifest(releaseId)!;
    expect(manifest.schemaVersion).toBe(2); // v2 sidecar（A 案 §6.2/§10.2）
    const knowledge = new KbVersionStore(outputRoot).readKnowledgeManifest(releaseId)!;
    expect(knowledge).not.toBeNull();

    // F01/F06：恢复后身份不重生成、证据不丢
    const byId = new Map(knowledge.objects.map((object) => [object.objectId, object]));
    const alpha = byId.get(alphaId)!;
    const beta = byId.get(betaId)!;
    expect(alpha.title).toBe('Alpha 攻防修正');
    expect(knowledge.evidence).toHaveLength(1);
    expect(knowledge.evidence[0]!.objectId).toBe(alphaId);
    expect(knowledge.evidence[0]!.claimKey).toBe('alpha-cap');
    // F03：审查凭据（最终复核全库范围重绑报告 ID）
    const finalReport = readStaging<{ reportId: string }>(dto.id, 'reviews/all.json');
    expect(alpha.reviewStatus).toBe('passed');
    expect(alpha.reviewActorKind).toBe('machine');
    expect(alpha.reviewerId).toBe(finalReport.reportId);
    expect(unitReportId).toMatch(/^kr_/);

    // F02：发布坐标不差一个生成标题——章节切片各归其位
    const lines = releaseDocLines(releaseId, '主题/seam-a.md');
    const sliceOf = (object: KnowledgeObject): string[] =>
      lines.slice(object.canonical!.bodyRange.startLine - 1, object.canonical!.bodyRange.endLine);
    const alphaSlice = sliceOf(alpha).join('\n');
    const betaSlice = sliceOf(beta).join('\n');
    expect(alphaSlice).toContain('## Alpha 攻防修正');
    expect(alphaSlice).toContain('ALPHA_ONLY');
    expect(alphaSlice).not.toContain('## Beta');
    expect(betaSlice).toContain('## Beta 换算说明');
    expect(betaSlice).toContain('BETA_ONLY');
    expect(betaSlice).not.toContain('ALPHA_ONLY');
    expect(lines[alpha.canonical!.bodyRange.startLine - 1]).toBe(`<a id="${alphaId}"></a>`);
    // claim 同步重映射：落在自身对象范围内（锚点行后第一行正文）
    expect(alpha.claims[0]!.bodyRange.startLine).toBeGreaterThan(alpha.canonical!.bodyRange.startLine);
    expect(alpha.claims[0]!.bodyRange.endLine).toBeLessThanOrEqual(alpha.canonical!.bodyRange.endLine);

    // ---- 对象查询读取（T4b 消费端；snippet 按 bodyRange 切正文） ----
    const query = getKbQueryService(outputRoot, { prewarm: false });
    const direct = await query.objects({ objectId: alphaId });
    expect(direct.total).toBe(1);
    expect(direct.objects[0]!.reviewStatus).toBe('passed');
    expect(direct.objects[0]!.businessStatus).toBe('unknown'); // 工具不接受自报 candidate；诚实状态
    expect(direct.objects[0]!.caution).toContain('禁止直接作为现行规则执行');
    expect(direct.objects[0]!.snippet).toContain('## Alpha 攻防修正');
    expect(direct.objects[0]!.snippet).toContain('ALPHA_ONLY');
    expect(direct.objects[0]!.snippet).not.toContain('BETA_ONLY');
    const betaRow = await query.objects({ objectId: betaId });
    expect(betaRow.objects[0]!.snippet).toContain('## Beta 换算说明');
    // browse 可见全部；operational 排除未 approved（诚实状态，F03 缩范围）
    const browse = await query.objects({ usage: 'browse' });
    expect(browse.total).toBe(2);
    const operational = await query.objects({ usage: 'operational' });
    expect(operational.total).toBe(0);
  });
});

// ===========================================================================
// F06：基线登记参与增量初始化（身份保留 / 旧式重写拒绝 / 纯重申继承审查）
// ===========================================================================

describe('seam 增量（F06）', () => {
  it('未重写的托管文档身份/审查延续；托管文档旧式重写显式拒绝；纯重申身份不重生成', async () => {
    seedCorpus();
    const first = makeHarness({ mode: 'declare', prompts: [] });
    const dto1 = await first.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row1 = await waitForTerminal(dto1.id);
    expect(String(row1.status), String(row1.error_message)).toBe('published');
    await first.close();
    const release1 = String(row1.release_id);
    const knowledge1 = new KbVersionStore(outputRoot).readKnowledgeManifest(release1)!;
    const ids1 = knowledge1.objects.map((object) => object.objectId).sort();
    const range1 = new Map(knowledge1.objects.map((object) => [object.objectId, object.canonical!.bodyRange]));
    const subjectHash1 = new Map(knowledge1.objects.map((object) => [object.objectId, object.reviewSubjectHash]));
    const payloadHash1 = new Map(knowledge1.objects.map((object) => [object.objectId, object.payloadHash]));
    expect(ids1).toHaveLength(2);

    // ---- 增量一：改 B 源，写未组织化文档；托管文档 seam-a 未重写 ----
    writeRaw('主题/seam-b.md', `${SEAM_B_LINES.join('\n')}\n追加一行：档位说明补充。`);
    const second = makeHarness({ mode: 'plainB', prompts: [] });
    const dto2 = await second.service.createBuild(store as never, { mode: 'incremental', confirm: 'BUILD' });
    const row2 = await waitForTerminal(dto2.id);
    expect(String(row2.status), String(row2.error_message)).toBe('published');
    await second.close();
    const release2 = String(row2.release_id);
    expect(release2).not.toBe(release1);
    const knowledge2 = new KbVersionStore(outputRoot).readKnowledgeManifest(release2)!;
    // 身份不重生成：clientKey→objectId 经基线登记保留（A 案 §7.2/§10.2）
    expect(knowledge2.objects.map((object) => object.objectId).sort()).toEqual(ids1);
    const alpha2 = knowledge2.objects.find((object) => object.objectId === ids1[0])!;
    expect(alpha2.reviewStatus).toBe('passed'); // 有效审查延续（本轮未改写）
    // 基线登记原样装载：审查主体/载荷哈希与上一 release 逐字节一致（未重导、未失效）
    expect(alpha2.reviewSubjectHash).toBe(subjectHash1.get(ids1[0]));
    expect(alpha2.payloadHash).toBe(payloadHash1.get(ids1[0]));
    expect(alpha2.canonical!.bodyRange).toEqual(range1.get(ids1[0])); // published 直通：坐标不变
    // 复制的托管文档按 published 基准直通（发布正文含锚点原样保留）
    const lines2 = releaseDocLines(release2, '主题/seam-a.md');
    expect(lines2[alpha2.canonical!.bodyRange.startLine - 1]).toBe(`<a id="${alpha2.objectId}"></a>`);

    // ---- 增量二（反例）：旧式参数重写托管文档 → 工具显式拒绝，构建失败 ----
    writeRaw('主题/seam-b.md', `${SEAM_B_LINES.join('\n')}\n再追加一行：触发增量。`);
    const beforeCurrent = new StandardKbStore(outputRoot).readCurrent()!.releaseId;
    const third = makeHarness({ mode: 'oldStyleManaged', prompts: [] });
    const dto3 = await third.service.createBuild(store as never, { mode: 'incremental', confirm: 'BUILD' });
    const row3 = await waitForTerminal(dto3.id);
    expect(String(row3.status)).toBe('failed');
    expect(String(row3.error_code)).toBe('kb_object_registry_stale');
    expect(third.script.toolError?.code).toBe('kb_object_registry_stale');
    expect(String(row3.error_message)).toContain('不允许静默降 v1');
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe(beforeCurrent); // CURRENT 不动
    await third.close();

    // ---- 增量三：源变化后带声明纯重申（同族三元组、载荷不变）→ 身份保留、修订不推进 ----
    writeRaw('主题/seam-a.md', `${SEAM_A_LINES.join('\n')}\n末尾追加一行：背景补充。`);
    const fourth = makeHarness({ mode: 'redeclareA', prompts: [] });
    const dto4 = await fourth.service.createBuild(store as never, { mode: 'incremental', confirm: 'BUILD' });
    const row4 = await waitForTerminal(dto4.id);
    expect(String(row4.status), String(row4.error_message)).toBe('published');
    await fourth.close();
    const knowledge4 = new KbVersionStore(outputRoot).readKnowledgeManifest(String(row4.release_id))!;
    expect(knowledge4.objects.map((object) => object.objectId).sort()).toEqual(ids1);
    const alpha4 = knowledge4.objects.find((object) => object.objectId === ids1[0])!;
    expect(alpha4.revision).toBe(1); // 载荷未变：修订不递增（纯重申）
    expect(alpha4.reviewStatus).toBe('passed');
  });
});

// ===========================================================================
// seam 自含锚点：F04 跨层 / F07 围栏反例 / F08 纯搬家哈希反例
// ===========================================================================

describe('seam 锚点：F04/F07/F08', () => {
  it('F04：设置 → buildSpecFromConfig → reviewPipelineActive（confirm/任一角色显式均启用）', () => {
    const standardKb = {
      buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, plannerEnabled: false },
      reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
      publishMode: 'confirm' as const,
    };
    const spec = buildSpecFromConfig({ buildId: 'b_anchor', snapshotEntries: [], baseReleaseId: null, standardKb });
    expect(reviewPipelineActive(spec)).toBe(true); // 显式 confirm 必须 await 释放屏障
    const writerOnly = buildSpecFromConfig({
      buildId: 'b_anchor', snapshotEntries: [], baseReleaseId: null,
      standardKb: { ...standardKb, publishMode: 'auto' as const, buildRoles: { writer: { modelPresetId: 'glm-4.7' }, reviewer: { modelPresetId: '' }, plannerEnabled: false } },
    });
    expect(reviewPipelineActive(writerOnly)).toBe(true); // reviewer 空值在启用的新流水内=跟随活跃预设
    const allEmpty = buildSpecFromConfig({
      buildId: 'b_anchor', snapshotEntries: [], baseReleaseId: null,
      standardKb: { ...standardKb, publishMode: 'auto' as const },
    });
    expect(reviewPipelineActive(allEmpty)).toBe(false); // 全空+auto → 旧路径
  });

  it('F07 反例：四反引号围栏内的三反引号不关栏——include 示例不触发 issue', () => {
    const fenced = ['####``` 示例', '````', '```', '{{kb-include:ko_missing:f}}', '```', '````'].join('\n');
    const doc = { path: 'fence.md', content: `<!--\nfeishu_sync_kb:\n  doc_id: kd_fence\n  sources:\n    - tokX\n  build_id: b_f\n-->\n${fenced}\n` };
    const result = compileKnowledgeRelease({
      docs: [doc],
      knowledgeDraft: { schemaVersion: 1, buildId: 'b_f', docs: {}, objects: [], presentations: [], relations: [], evidence: [], coverage: [] },
    });
    expect(result.issues).toEqual([]); // 旧状态机会把内部 ``` 当闭栏 → include 示例触发 kb_include_invalid
    expect(result.compiledDocs[0]!.content).toContain('{{kb-include:ko_missing:f}}');
  });

  it('F08 反例：对象纯搬家（locationRevision 变）payloadHash 不变；断言内容变化仍失效', () => {
    const body = '## 攻防修正\n攻防差每点提供 0.5% 修正，上限 30%。';
    const base: KnowledgeObject = {
      objectId: 'ko_move', type: 'rule', title: 't', aliases: [], domainIds: [],
      familyKey: 'fam', variantKey: 'v', scopeKey: 's', scopeText: 'S',
      canonical: { docId: 'd1', path: 'a.md', anchor: 'ko_move', bodyRange: { startLine: 1, endLine: 2 } },
      revision: 1, locationRevision: 0, payloadHash: '', reviewSubjectHash: '',
      businessStatus: 'candidate', reviewStatus: 'pending',
      claims: [{ claimKey: 'cap', bodyRange: { startLine: 2, endLine: 2 }, riskCategory: 'high', evidenceIds: [] }],
    };
    const baseHash = computePayloadHash(base, body);
    const moved: KnowledgeObject = {
      ...base,
      locationRevision: 1,
      canonical: { docId: 'd2', path: 'b.md', anchor: 'ko_move', bodyRange: { startLine: 11, endLine: 12 } },
      claims: [{ claimKey: 'cap', bodyRange: { startLine: 12, endLine: 12 }, riskCategory: 'high', evidenceIds: [] }],
    };
    expect(computePayloadHash(moved, body)).toBe(baseHash); // 纯搬家：绝对行号不入哈希
    expect(computePayloadHash(base, body.replace('0.5%', '1%'))).not.toBe(baseHash); // 断言内容变化仍失效
  });
});
