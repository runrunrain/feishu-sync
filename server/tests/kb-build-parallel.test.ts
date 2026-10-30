/**
 * 并行构建流水线集成测试（S4 §4.1-4.5 + S3 构建图片链）
 *
 * 用 processFactory 测试接缝注入假 pi 进程（FakeRpcProcess）：不真实调
 * 模型，prompt 按提示词内容脚本化地经真实 AgentToolService 执行工具。
 * 覆盖：
 * - buildParallelism=1 全量构建端到端发布（等价回退）
 * - 双 worker 并行：他单元预认领路径写入被拒（kb_path_owned_by_other_unit）
 * - 单元失败（重试后仍败）→ kb_unit_failed，CURRENT 不动
 * - 可重试错误自动重试 1 次成功 → 发布
 * - 取消：全部假进程 abort/terminate，CURRENT 不动
 * - vision 关闭：raw_read 内联 unavailable 标记 + images_unavailable 警告落库
 * - mediaHash 兼容：旧 manifest 无 mediaHash → 增量不全量 changed
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { computeChangeset } from '../src/kb/kb-build-service.js';
import { AgentToolService, ToolError } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { RawSourceSnapshot } from '../src/kb/raw-source-snapshot.js';
import Database from 'better-sqlite3';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { Config } from '../src/types/index.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';
import { VisionDescriber, visionCurrentCacheFilePath, type ImageDescription } from '../src/agent/vision/vision-describer.js';

// ---------------------------------------------------------------------------
// 假 pi 进程：prompt 按内容脚本化，工具经真实 toolService 执行
// ---------------------------------------------------------------------------

interface FakeScript {
  /** 模拟模型输出正文（用于短图文源的体积校验回归）。 */
  outputMarkdown?: string;
  /** 命中批次 prompt 时注入一次失败（model_timeout 等）后恢复 */
  failBatchOnceWithCode?: string;
  /** 所有批次 prompt 恒定失败（测试单元重试仍败） */
  failBatchAlwaysWithCode?: string;
  failBatchMessage?: string;
  /** 挂起（不 resolve）直到 abort —— 取消测试 */
  hangUntilAbort?: boolean;
  /** 处理指定单元的批次时先尝试写他单元预认领路径；结果记录到 claimRejections */
  foreignClaimAttempt?: { unitId: string; path: string };
  claimRejections?: unknown[];
  /** 批次前 raw_read 并记录内容（vision 内联断言用） */
  rawReadCapture?: Map<string, string>;
  /** 完成模型生成后模拟同步、选集或发布状态变化。 */
  beforeFinish?: () => void;
}

class FakeRpcProcess extends EventEmitter {
  prompts: string[] = [];
  terminated = false;
  abortCount = 0;
  exited = false;
  private pending: Array<(value: unknown) => void> = [];
  private aborted = false;

  constructor(
    private readonly toolService: AgentToolService,
    private readonly token: string,
    private readonly script: FakeScript,
  ) {
    super();
  }

  isExited(): boolean {
    return this.exited;
  }

  async start(): Promise<void> {}

  async sendCommand(): Promise<{ success: boolean }> {
    return { success: true };
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.aborted = true;
    // 与真实进程一致：abort 后给一个短窗口让 run 结算为 aborted
    const waiters = this.pending.splice(0);
    for (const resolve of waiters) resolve({ outcome: 'aborted' });
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    this.exited = true;
    this.emit('exit');
  }

  async prompt(message: string): Promise<unknown> {
    this.prompts.push(message);
    return await new Promise((resolve) => {
      void this.act(message).then(resolve, (error) => {
        // 脚本内工具错误冒泡 = 运行失败（不让 promise 悬挂拖死流水线）
        resolve({ outcome: 'failed', error: { code: 'fake_script_error', message: String(error) } });
      });
    });
  }

  private async act(message: string): Promise<unknown> {
    if (this.script.hangUntilAbort) {
      return await new Promise((resolve) => {
        this.pending.push(resolve as (value: unknown) => void);
      });
    }
    if ((message.includes('【单元') || message.includes('【批次')) && message.includes('请处理以下')) {
      return await this.actBatchPrompt(message);
    }
    if (message.includes('没有新增或变更的源')) {
      return { outcome: 'completed' };
    }
    if (message.includes('kb_unit_done')) {
      const unitId = /单元 (u\d+)/.exec(message)?.[1] ?? '';
      await this.call('kb_unit_done', { summary: `单元 ${unitId} 完成`, skipped: [] });
      return { outcome: 'completed' };
    }
    if (message.includes('kb_finish') || message.includes('整体收尾')) {
      const beforeFinish = this.script.beforeFinish;
      this.script.beforeFinish = undefined;
      beforeFinish?.();
      await this.call('kb_finish', { summary: '整体完成', skipped: [] });
      return { outcome: 'completed' };
    }
    return { outcome: 'completed' };
  }

  private async actBatchPrompt(message: string): Promise<unknown> {
    const unitId = /【单元 (u\d+)/.exec(message)?.[1] ?? '';
    if (this.script.failBatchAlwaysWithCode) {
      return { outcome: 'failed', error: { code: this.script.failBatchAlwaysWithCode, message: this.script.failBatchMessage ?? '脚本注入失败' } };
    }
    if (this.script.failBatchOnceWithCode) {
      const code = this.script.failBatchOnceWithCode;
      this.script.failBatchOnceWithCode = undefined;
      return { outcome: 'failed', error: { code, message: '脚本注入一次性失败' } };
    }
    // 从 prompt 表格解析本批 token（| token | title | relPath | type |）
    const tokens = [...message.matchAll(/^\| (tok\S+) \|/gm)].map((match) => match[1]);
    // 他单元认领路径写入尝试（kb_path_owned_by_other_unit 验证）
    if (this.script.foreignClaimAttempt && unitId === this.script.foreignClaimAttempt.unitId) {
      try {
        await this.call('kb_write_doc', {
          path: this.script.foreignClaimAttempt.path,
          title: '越权文档',
          markdown: '不应成功的写入',
          sources: tokens.slice(0, 1),
          summary: '越权尝试',
        });
      } catch (error) {
        (this.script.claimRejections ??= []).push(error);
      }
      this.script.foreignClaimAttempt = undefined;
    }
    let docIndex = 1;
    for (const token of tokens) {
      if (this.script.rawReadCapture) {
        try {
          const result = await this.call('raw_read', { objToken: token });
          const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
          this.script.rawReadCapture.set(token, text);
        } catch {
          /* 读取失败忽略 */
        }
      }
      // 正文/标题/摘要不含 objToken/路径等来源标识（body_contains_source_metadata 拦截）
      await this.call('kb_write_doc', {
        // P2-S2：预算开启后同一工作集会拆多批，路径须按 token 唯一
        // （docIndex 每批重置，批间会同路径覆盖 → source_not_covered）
        path: `主题/${unitId || 'u'}-${token}.md`,
        title: `规则主题${docIndex}`,
        markdown: this.script.outputMarkdown ?? '规则的完整说明：第一段定义，第二段流程与边界。',
        sources: [token],
        summary: '规则主题的概要说明',
      });
      docIndex += 1;
    }
    // 受影响已有文档（prompt 列出）重写：sources 声明本单元现存源
    const affectedMatch = /受影响的已有标准文档[\s\S]*?(?=\n要求：|\n$)/.exec(message);
    if (affectedMatch) {
      const docPaths = [...affectedMatch[0].matchAll(/^- (\S+\.md)（/gm)].map((match) => match[1]);
      for (const docPath of docPaths) {
        if (tokens.length === 0) continue;
        await this.call('kb_write_doc', {
          path: docPath,
          title: '受影响主题重写',
          markdown: '重写后的完整正文，自然语言规则说明。',
          sources: tokens,
          summary: '重写概要',
        }).catch((error) => (this.script.claimRejections ??= []).push(error));
      }
    }
    // 本单元最后一批：直接上报单元完成（不触发纠正轮）
    if (message.includes('本批是本单元最后一批')) {
      await this.call('kb_unit_done', { summary: `单元 ${unitId} 完成`, skipped: [] });
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
const documents: DocumentRecord[] = [];

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

const FAT = '规则的详细说明段落，包含定义、流程、边界与示例，用于把原始源体积撑到足以覆盖产出文档的校验阈值。'.repeat(8);

function writeRaw(rel: string, content: string): void {
  const full = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeConfig(overrides: { buildParallelism?: number; buildBatchWordBudget?: number } = {}): Config {
  return {
    llm: { openAiCompatBaseUrl: '', apiKey: '', model: '', temperature: 0.2, primaryChannel: 'direct', fallbackOnFailure: false },
    agent: {
      runtime: {},
      model: { source: 'pi-agent-dir', piModel: 'fake/model', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
      vision: { enabled: false, concurrency: 1, maxImageBytes: 5 * 1024 * 1024, maxImagesPerBuild: 10, timeoutMs: 10000 },
      maxConcurrentProcesses: 3,
      idleTimeoutMinutes: 10,
      workspaces: [],
    },
    standardKb: {
      outputRoot, retainReleases: 3, buildBatchSize: 10,
      // P2-S2：缺省 0 = 旧行为（既有用例零回归）；新用例显式传预算
      buildBatchWordBudget: overrides.buildBatchWordBudget ?? 0,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 180,
      buildParallelism: overrides.buildParallelism ?? 1, autoBuildAfterSync: false,
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
  toolService: AgentToolService;
  pool: AgentProcessPool;
  fakes: FakeRpcProcess[];
  script: FakeScript;
  visionDescriber?: {
    status: () => Promise<{ state: 'disabled' | 'ready' | 'invalid'; model: string | null; message: string }>;
    lookup: (hash: string) => Promise<string | null>;
    describeOne: () => Promise<ImageDescription>;
    describeMany: (items: Array<{ file: string; src: string }>, opts: { signal: AbortSignal; onProgress: (p: { done: number; total: number }) => void; refreshCached?: boolean }) => Promise<Map<string, ImageDescription>>;
  };
}

function makeHarness(config: Config, script: FakeScript = { claimRejections: [] }, vision?: Harness['visionDescriber'], excluded: string[] = [], published: string[] = [], unselected: string[] = []): Harness {
  const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, idleTimeoutMinutes: 10 });
  const toolService = new AgentToolService({ dataRoot, documentsProvider: () => documents });
  const fakes: FakeRpcProcess[] = [];
  const harness: Harness = { service: null as never, toolService, pool, fakes, script, visionDescriber: vision };
  const service = new KbBuildService({
    dataRoot,
    pool,
    toolService,
    resolver: stubResolver(),
    configProvider: () => config,
    documentsProvider: () => documents,
    excludedSourcesProvider: () => excluded,
    unselectedSourcesProvider: () => unselected,
    publishedTokensProvider: () => published,
    sheetCsvPaths: () => [],
    internalBaseUrl: () => 'http://127.0.0.1:39999',
    extensionPath: () => null,
    promptAssets: () => null,
    ...(vision ? { visionDescriber: vision } : {}),
    processFactory: (options) => {
      const token = String(options.env.FEISHU_SYNC_AGENT_RUN_TOKEN ?? '');
      const fake = new FakeRpcProcess(toolService, token, script);
      fakes.push(fake);
      return fake as unknown as PiRpcProcess;
    },
  });
  harness.service = service;
  return harness;
}

async function waitForTerminal(buildId: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.getKbBuild(buildId);
    if (row && !['queued', 'preflight', 'running', 'validating', 'publishing'].includes(String(row.status))) return row;
    if (Date.now() > deadline) throw new Error(`构建未在 ${timeoutMs}ms 内进入终态: ${row ? row.status : 'missing'}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createAndRun(harness: Harness, mode: 'full' | 'incremental'): Promise<Record<string, unknown>> {
  const dto = await harness.service.createBuild(store as never, { mode, confirm: 'BUILD' });
  return await waitForTerminal(dto.id);
}

/** 直接发布一个基线 release（增量构建的地基）。 */
async function publishBase(harness: Harness, docs: Array<{ path: string; docId: string; sources: string[]; body?: string }>, entries: RawSourceSnapshotEntry[]): Promise<string> {
  const stagingRoot = path.join(outputRoot, '.staging', 'b_base');
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  for (const doc of docs) {
    const full = path.join(stagingRoot, 'docs', doc.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `<!--\nfeishu_sync_kb:\n  doc_id: ${doc.docId}\n  sources:\n${doc.sources.map((s) => `    - ${s}`).join('\n')}\n  build_id: b_base\n-->\n# ${doc.path}\n${doc.body ?? '基线正文'}\n`);
  }
  const releaseId = `r_base_${crypto.randomBytes(3).toString('hex')}`;
  const manifest = await harness.service.publishRelease({
    buildId: 'b_base', releaseId, mode: 'full', baseReleaseId: null, model: null,
    snapshot: RawSourceSnapshot.fromEntries(entries, { knowledgeBaseRoot: kbRoot }),
    stagingRoot, outputRoot, docMeta: new Map(docs.map((doc) => [doc.path, { title: doc.path, summary: '基线', tags: [], sources: doc.sources }])),
    retainReleasesOverride: 5,
  });
  return manifest.releaseId;
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbpar-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbpar-kb-'));
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

const TINY_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png-fixture'),
]);

describe('发布前复核所选源快照', () => {
  it('构建期间其他文档同步完成：发布初始选集并提示下次处理新增源', async () => {
    writeRaw('同步竞态/已选.md', `# 已选源\n${FAT}`);
    documents.length = 0;
    const selected = docRecord('tokStableBuild', '同步竞态/已选.md');
    const pending = { ...docRecord('tokLaterSync', '同步竞态/稍后同步.md'), status: 'placeholder', lastSyncedAt: '' } as DocumentRecord;
    documents.push(selected, pending);
    const harness = makeHarness(makeConfig(), { beforeFinish: () => {
      writeRaw('同步竞态/稍后同步.md', `# 新同步源\n${FAT}`);
      Object.assign(pending, { status: 'synced', lastSyncedAt: new Date().toISOString() });
    } });
    const row = await createAndRun(harness, 'full');
    expect(row.status).toBe('published');
    const kbStore = new StandardKbStore(outputRoot);
    const manifest = kbStore.readManifest(String(row.release_id))!;
    expect(manifest.sourceSnapshot.map((source) => source.objToken)).toEqual(['tokStableBuild']);
    expect(manifest.docs.every((doc) => doc.sources.every((source) => source === 'tokStableBuild'))).toBe(true);
    expect(JSON.parse(String(row.warnings_json))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sources_added_during_build', count: 1, message: expect.stringContaining('下次构建') }),
    ]));
    const later = RawSourceSnapshot.scan(kbRoot, documents).entries;
    expect(computeChangeset(later, manifest).added).toContain('tokLaterSync');
  });

  it('初始选集没有可用源且构建中同步完成：保留上一版本并要求重新构建', async () => {
    documents.length = 0;
    const pending = { ...docRecord('tokEmptyLaterSync', '同步竞态/空选集后同步.md'), status: 'placeholder', lastSyncedAt: '' } as DocumentRecord;
    documents.push(pending);
    const previous = new StandardKbStore(outputRoot).readCurrent()?.releaseId;
    const harness = makeHarness(makeConfig(), { beforeFinish: () => {
      writeRaw('同步竞态/空选集后同步.md', `# 新同步源\n${FAT}`);
      Object.assign(pending, { status: 'synced', lastSyncedAt: new Date().toISOString() });
    } });
    const row = await createAndRun(harness, 'full');
    expect(row).toMatchObject({ status: 'failed', error_code: 'source_changed_during_build' });
    expect(String(row.error_message)).toContain('重新选择并构建');
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId).toBe(previous);
  });

  it('已发布到飞书的文档在快照和发布前复核均排除', async () => {
    writeRaw('发布产物/来源.md', `# 正常来源\n${FAT}`);
    writeRaw('发布产物/标准产物.md', `# 不应作为来源\n${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokRealSource', '发布产物/来源.md'), docRecord('tokPublishedOutput', '发布产物/标准产物.md'));
    const harness = makeHarness(makeConfig(), {}, undefined, [], ['tokPublishedOutput']);
    const row = await createAndRun(harness, 'full');
    expect(row.status).toBe('published');
    const manifest = new StandardKbStore(outputRoot).readManifest(String(row.release_id))!;
    expect(manifest.sourceSnapshot.map((source) => source.objToken)).toEqual(['tokRealSource']);
    expect(JSON.parse(String(row.warnings_json))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'published_doc_in_sources', count: 1 }),
    ]));
    expect(JSON.parse(String(row.warnings_json))).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sources_added_during_build' }),
    ]));
  });

  it.each(['excluded', 'published'] as const)('所选源构建期间变为 %s：阻断发布并保留上一版本', async (change) => {
    writeRaw('同步竞态/被移除.md', `# 原始源\n${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokRemovedBuild', '同步竞态/被移除.md'));
    const excluded: string[] = [];
    const published: string[] = [];
    const previous = new StandardKbStore(outputRoot).readCurrent()?.releaseId;
    const harness = makeHarness(makeConfig(), { beforeFinish: () => {
      (change === 'excluded' ? excluded : published).push('tokRemovedBuild');
    } }, undefined, excluded, published);
    const row = await createAndRun(harness, 'full');
    expect(row).toMatchObject({ status: 'failed', error_code: 'source_changed_during_build' });
    expect(String(row.error_message)).toContain('所选源已移除');
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId).toBe(previous);
  });

  it('构建期间所选源内容被修改：阻断发布并保留上一版本', async () => {
    writeRaw('同步竞态/被修改.md', `# 原始源\n${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokChangedBuild', '同步竞态/被修改.md'));
    const previous = new StandardKbStore(outputRoot).readCurrent()?.releaseId;
    const harness = makeHarness(makeConfig(), { beforeFinish: () => writeRaw('同步竞态/被修改.md', `# 同步后新内容\n${FAT}`) });
    const row = await createAndRun(harness, 'full');
    expect(row).toMatchObject({ status: 'failed', error_code: 'source_changed_during_build' });
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId).toBe(previous);
  });

  it('构建期间所选源的图片被替换：阻断发布并保留上一版本', async () => {
    writeRaw('同步竞态/图文.md', `# 图文\n![](images/guard.png)\n${FAT}`);
    const imagePath = path.join(kbRoot, '同步竞态/images/guard.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, TINY_PNG);
    documents.length = 0;
    documents.push(docRecord('tokChangedImage', '同步竞态/图文.md'));
    const previous = new StandardKbStore(outputRoot).readCurrent()?.releaseId;
    const harness = makeHarness(makeConfig(), { beforeFinish: () => fs.writeFileSync(imagePath, Buffer.concat([TINY_PNG, Buffer.from('changed')])) });
    const row = await createAndRun(harness, 'full');
    expect(row).toMatchObject({ status: 'failed', error_code: 'source_changed_during_build' });
    expect(String(row.error_message)).toContain('源图片已变更');
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId).toBe(previous);
  });
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('S4：buildParallelism=1 等价回退（全量端到端发布）', () => {
  it('单 worker 全量构建：发布成功、CURRENT 切换、parallelism=1 落库', async () => {
    writeRaw('战报/a.md', `a ${FAT}`);
    writeRaw('战报/b.md', `b ${FAT}`);
    documents.push(docRecord('tokA', '战报/a.md'), docRecord('tokB', '战报/b.md'));
    const harness = makeHarness(makeConfig({ buildParallelism: 1 }));
    const row = await createAndRun(harness, 'full');
    expect(String(row.status)).toBe('published');
    expect(Number(row.parallelism)).toBe(1);
    const kbStore = new StandardKbStore(outputRoot);
    const pointer = kbStore.readCurrent();
    expect(pointer).toBeTruthy();
    const manifest = kbStore.readManifest(pointer!.releaseId)!;
    expect(manifest.docs.length).toBeGreaterThanOrEqual(2);
    // 假模型对每个源写了主题文档；收尾轮复用 worker（未新拉进程）
    const fake = harness.fakes[0];
    expect(harness.fakes).toHaveLength(1);
    expect(fake.prompts.some((p) => p.includes('kb_finish'))).toBe(true);
  });

  it('T3b-06：M=3 + 两后台占满 M-1 → 单 worker 构建排队而非立即抢槽；交互保留槽可用；释放后继续', async () => {
    const harness = makeHarness(makeConfig({ buildParallelism: 1 }));
    // 两个后台任务占满 M-1 配额（M=3），总槽尚余 1
    const bg1 = await harness.pool.acquire('background');
    const bg2 = await harness.pool.acquire('background');
    expect(bg1 && bg2).toBeTruthy();

    // 交互会话保留槽仍可用（未被单 worker 回退抢占）
    const sessionSlot = harness.pool.reserveSlot('session');
    expect(sessionSlot).not.toBeNull();
    sessionSlot!.release();

    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // 排队而非立即抢最后一个总槽：未 spawn、队列深度 1、非终态
    expect(harness.fakes).toHaveLength(0);
    expect(harness.pool.queueDepth()).toBe(1);
    const mid = store.getKbBuild(dto.id);
    expect(['queued', 'preflight', 'running']).toContain(String(mid?.status));

    // 释放一个后台槽 → 排队构建获得槽位并完成发布
    bg1.release();
    const row = await waitForTerminal(dto.id);
    expect(String(row.status)).toBe('published');
    expect(harness.fakes.length).toBeGreaterThanOrEqual(1);
    bg2.release();
  });

  it('T3b-06：排队中取消 → 出队失败（cancelled），不 spawn，无残留', async () => {
    const harness = makeHarness(makeConfig({ buildParallelism: 1 }));
    const bg1 = await harness.pool.acquire('background');
    const bg2 = await harness.pool.acquire('background');
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    // 等待进入排队（preflight 同步完成后 acquire 入队）
    const deadline = Date.now() + 5000;
    while (harness.pool.queueDepth() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(harness.pool.queueDepth()).toBe(1);
    expect(harness.fakes).toHaveLength(0);

    await harness.service.cancelBuild(store as never, dto.id);
    const row = await waitForTerminal(dto.id);
    expect(String(row.status)).toBe('cancelled');
    expect(harness.fakes).toHaveLength(0);
    expect(harness.pool.queueDepth()).toBe(0);
    bg1.release();
    bg2.release();
  });
});

describe('S4：双 worker 并行 + 路径认领', () => {
  it('并行构建所选新来源时继承旧库，未勾选的旧文档与身份保持', async () => {
    const original = docRecord('tokKeep', 'keep/source.md');
    const first = docRecord('tokNewA', 'branchA/source.md');
    const second = docRecord('tokNewB', 'branchB/source.md');
    for (const doc of [original, first, second]) writeRaw(doc.localRelPath!, FAT);
    documents.length = 0; documents.push(original, first, second);
    const harness = makeHarness(makeConfig({ buildParallelism: 2 }), {}, undefined, [], [], ['tokKeep']);
    const releaseId = await publishBase(harness, [{ path: '已有/保留.md', docId: 'kd_keep', sources: ['tokKeep'], body: '保留的独立规则。' }], RawSourceSnapshot.scan(kbRoot, [original]).entries);
    const bytes = fs.readFileSync(path.join(outputRoot, 'releases', releaseId, 'docs', '已有/保留.md'));
    const dto = await harness.service.createBuild(store as never, { mode: 'incremental', confirm: 'BUILD', rebuildSelected: true });
    const row = await waitForTerminal(dto.id);
    expect(row.status, String(row.error_message)).toBe('published'); expect(row.parallelism).toBe(2);
    const manifest = new StandardKbStore(outputRoot).readManifest()!;
    expect(manifest.docs.find((doc) => doc.path === '已有/保留.md')).toMatchObject({ docId: 'kd_keep', sources: ['tokKeep'] });
    expect(manifest.docs.some((doc) => doc.sources.includes('tokNewA'))).toBe(true);
    expect(manifest.docs.some((doc) => doc.sources.includes('tokNewB'))).toBe(true);
    expect(fs.readFileSync(path.join(outputRoot, 'releases', manifest.releaseId, 'docs', '已有/保留.md'))).toEqual(bytes);
    expect(manifest.sourceSnapshot.map((source) => source.objToken).sort()).toEqual(['tokKeep', 'tokNewA', 'tokNewB']);
  });

  it('他单元预认领路径写入被拒（kb_path_owned_by_other_unit），构建仍发布', async () => {
    // 基线：已有/共享.md ← tokA（增量时 tokA changed）
    writeRaw('dir1/a.md', `a v1 ${FAT}`);
    writeRaw('dir2/b.md', `b v1 ${FAT}`);
    const recA = docRecord('tokA', 'dir1/a.md');
    const recB = docRecord('tokB', 'dir2/b.md');
    documents.length = 0;
    documents.push(recA, recB);
    let harness = makeHarness(makeConfig({ buildParallelism: 1 }));
    const baseEntries = RawSourceSnapshot.scan(kbRoot, documents).entries;
    await publishBase(harness, [
      { path: '已有/共享.md', docId: 'kd_shared', sources: ['tokA'] },
    ], baseEntries);
    // 改 tokA → 增量 changed；tokB 相对基线 absent → 增量 added
    writeRaw('dir1/a.md', `a v2 ${FAT}`);
    writeRaw('dir2/b.md', `b v2 ${FAT}`);

    const claimRejected: unknown[] = [];
    const script: FakeScript = {
      claimRejections: claimRejected,
      foreignClaimAttempt: { unitId: 'u2', path: '已有/共享.md' },
    };
    harness = makeHarness(makeConfig({ buildParallelism: 2 }), script);
    const dto = await harness.service.createBuild(store as never, { mode: 'incremental', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    const claimError = claimRejected.find((error): error is ToolError => error instanceof ToolError && error.code === 'kb_path_owned_by_other_unit');
    expect(claimError).toBeTruthy();
    expect(claimError!.message).toContain('已有/共享.md');
    expect(claimError!.message).toContain('u1');
    expect(String(row.status)).toBe('published');
    expect(Number(row.parallelism)).toBe(2);
    // 两单元：u1(tokA+共享.md 预认领) 与 u2(tokB)
    const kbStore = new StandardKbStore(outputRoot);
    const manifest = kbStore.readManifest(kbStore.readCurrent()!.releaseId)!;
    expect(manifest.docs.some((doc) => doc.path === '已有/共享.md' || doc.path === '主题/tokA.md')).toBe(true);
    expect(manifest.docs.some((doc) => doc.sources.includes('tokB'))).toBe(true);
  });
});

describe('S4：单元失败 → CURRENT 不动 / 重试成功', () => {
  it.each([1, 2])('额度不足：%i 个 worker 保留具体原因，不重试、不更改已发布版本', async (parallelism) => {
    const before = new StandardKbStore(outputRoot).readCurrent()?.releaseId;
    const rawA = `示例源 A ${FAT}`;
    writeRaw('额度域一/a.md', rawA);
    writeRaw('额度域二/b.md', `示例源 B ${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokQuotaA', '额度域一/a.md'), docRecord('tokQuotaB', '额度域二/b.md'));
    const harness = makeHarness(makeConfig({ buildParallelism: parallelism }), {
      failBatchAlwaysWithCode: 'model_quota_exceeded', failBatchMessage: '429: 1113 余额不足或无可用资源包',
    });
    const row = await createAndRun(harness, 'full');
    expect(row.status).toBe('failed');
    expect(String(row.error_message)).toContain('余额不足');
    expect(String(row.error_message)).toContain('1113');
    expect(String(row.error_code)).toBe(parallelism === 1 ? 'model_quota_exceeded' : 'kb_unit_failed');
    expect(harness.fakes.length).toBeLessThanOrEqual(parallelism);
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId).toBe(before);
    expect(fs.readFileSync(path.join(kbRoot, '额度域一/a.md'), 'utf8')).toBe(rawA);
  });

  it('重试后仍败 → kb_unit_failed，CURRENT 不动', async () => {
    const before = new StandardKbStore(outputRoot).readCurrent()?.releaseId;
    writeRaw('失败域/x.md', `x ${FAT}`);
    writeRaw('失败域二/y.md', `y ${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokFail', '失败域/x.md'), docRecord('tokFail2', '失败域二/y.md'));
    const harness = makeHarness(makeConfig({ buildParallelism: 2 }), { failBatchAlwaysWithCode: 'model_timeout', claimRejections: [] });
    const row = await createAndRun(harness, 'full');
    expect(String(row.status)).toBe('failed');
    expect(String(row.error_code)).toBe('kb_unit_failed');
    expect(String(row.error_message)).toContain('model_timeout');
    // 每个单元重试一次：至少 4 次进程拉起（2 单元 × 初次+重试）
    expect(harness.fakes.length).toBeGreaterThanOrEqual(4);
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId).toBe(before);
  });

  it('model_timeout 一次性失败 → 自动重试 1 次后发布', async () => {
    writeRaw('重试域/y.md', `y ${FAT}`);
    writeRaw('重试域二/z.md', `z ${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokRetry', '重试域/y.md'), docRecord('tokRetry2', '重试域二/z.md'));
    const harness = makeHarness(makeConfig({ buildParallelism: 2 }), { failBatchOnceWithCode: 'model_timeout', claimRejections: [] });
    const row = await createAndRun(harness, 'full');
    expect(String(row.status)).toBe('published');
    expect(harness.fakes.length).toBeGreaterThanOrEqual(3); // 2 worker + 至少 1 次重试新进程
  });
});

describe('S4：取消终止全部进程', () => {
  it('hang prompt → cancelBuild → 全部假进程 abort、终态 cancelled、CURRENT 不动', async () => {
    const before = new StandardKbStore(outputRoot).readCurrent()?.releaseId;
    writeRaw('取消域/z.md', `z ${FAT}`);
    writeRaw('取消域/w.md', `w ${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokC1', '取消域/z.md'), docRecord('tokC2', '取消域/w.md'));
    const harness = makeHarness(makeConfig({ buildParallelism: 2 }), { hangUntilAbort: true });
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    // 等待至少一个 fake 进入 prompt 挂起
    const deadline = Date.now() + 5000;
    while (harness.fakes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(harness.fakes.length).toBeGreaterThan(0);
    await harness.service.cancelBuild(store as never, dto.id);
    const row = await waitForTerminal(dto.id);
    expect(String(row.status)).toBe('cancelled');
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId).toBe(before);
    // 全部进程都被 abort（或已 terminate）
    for (const fake of harness.fakes) {
      expect(fake.abortCount + (fake.terminated ? 1 : 0)).toBeGreaterThan(0);
    }
  });
});

describe('所选源文档的图片重新生成', () => {
  it('仅处理选中源，传递刷新选项，失败时复用旧描述并显示警告', async () => {
    writeRaw('刷新域/selected.md', `# 选中\n![](images/a.png)\n${FAT}`);
    writeRaw('刷新域/excluded.md', `# 未选中\n![](images/b.png)\n${FAT}`);
    fs.mkdirSync(path.join(kbRoot, '刷新域/images'), { recursive: true });
    fs.writeFileSync(path.join(kbRoot, '刷新域/images/a.png'), TINY_PNG);
    fs.writeFileSync(path.join(kbRoot, '刷新域/images/b.png'), TINY_PNG);
    documents.length = 0;
    documents.push(docRecord('tokRefreshSelected', '刷新域/selected.md'), docRecord('tokRefreshExcluded', '刷新域/excluded.md'));
    const calls: Array<{ sources: string[]; refresh: boolean }> = [];
    const vision: NonNullable<Harness['visionDescriber']> = {
      status: async () => ({ state: 'ready', model: 'fixture/vision', message: '' }),
      lookup: async () => '已有描述',
      describeOne: async () => ({ src: 'a', imageHash: 'fixture', state: 'cached', text: '已有描述' }),
      describeMany: async (items, opts) => {
        calls.push({ sources: items.map((item) => item.src), refresh: opts.refreshCached === true });
        opts.onProgress({ done: items.length, total: items.length });
        return new Map(items.map((item) => [item.src, { src: item.src, imageHash: 'fixture', state: 'cached' as const, text: '已有描述',
          ...(opts.refreshCached ? { refreshFailure: 'vision_failed' as const } : {}) }]));
      },
    };
    const rawReadCapture = new Map<string, string>();
    const harness = makeHarness(makeConfig(), { rawReadCapture }, vision, ['tokRefreshExcluded']);
    const first = await createAndRun(harness, 'full');
    expect(first.status).toBe('published');
    const accepted = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD', refreshImages: true });
    const refreshed = await waitForTerminal(accepted.id);
    expect(refreshed.status).toBe('published');
    expect(calls).toEqual([
      { sources: ['tokRefreshSelected::images/a.png'], refresh: false },
      { sources: ['tokRefreshSelected::images/a.png'], refresh: true },
    ]);
    expect(rawReadCapture.get('tokRefreshSelected')).toContain('已有描述');
    expect(rawReadCapture.has('tokRefreshExcluded')).toBe(false);
    expect(JSON.parse(String(refreshed.warnings_json))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'images_refresh_incomplete', count: 1 }),
    ]));
  });

  it('拒绝非布尔值和增量构建中的重新生成选项', async () => {
    const harness = makeHarness(makeConfig());
    await expect(harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD', refreshImages: 'true' as never }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(harness.service.createBuild(store as never, { mode: 'incremental', confirm: 'BUILD', refreshImages: true }))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('S3：vision 关闭 → unavailable 内联 + images_unavailable 警告', () => {
  it('服务未就绪时，构建仍内联已有缓存；强制重试会保留缓存并报告未完成', async () => {
    const cachedImage = Buffer.concat([TINY_PNG, Buffer.from('cached-while-disabled')]);
    const freshImage = Buffer.concat([TINY_PNG, Buffer.from('fresh-while-disabled')]);
    writeRaw('图域/缓存文档.md', `# 带图\n![](images/cached-disabled.png)\n![](images/fresh-disabled.png)\n正文 ${FAT}`);
    writeRaw('图域/images/cached-disabled.png', cachedImage);
    writeRaw('图域/images/fresh-disabled.png', freshImage);
    documents.length = 0;
    documents.push(docRecord('tokCachedDisabled', '图域/缓存文档.md'));
    const imageHash = crypto.createHash('sha256').update(cachedImage).digest('hex');
    const cacheFile = visionCurrentCacheFilePath(dataRoot, imageHash);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      schemaVersion: 1, imageHash, modelKey: '123456789abc', model: 'old-model',
      promptVersion: 'old', text: '先前识别的图片', createdAt: '2026-01-01T00:00:00.000Z',
    }));
    try {
      const rawReadCapture = new Map<string, string>();
      const describer = new VisionDescriber({ dataRoot, config: () => makeConfig() });
      const harness = makeHarness(makeConfig({ buildParallelism: 1 }), { rawReadCapture }, describer);
      const row = await createAndRun(harness, 'full');
      expect(String(row.status)).toBe('published');
      expect(rawReadCapture.get('tokCachedDisabled')).toContain('先前识别的图片');
      expect(rawReadCapture.get('tokCachedDisabled')).toContain('reason="vision_unconfigured"');
      const warnings = JSON.parse(String(row.warnings_json ?? '[]')) as Array<{ code: string; count: number }>;
      expect(warnings).toContainEqual(expect.objectContaining({ code: 'images_unavailable', count: 1 }));
      const refresh = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD', refreshImages: true });
      const refreshed = await waitForTerminal(refresh.id);
      expect(rawReadCapture.get('tokCachedDisabled')).toContain('先前识别的图片');
      expect(JSON.parse(String(refreshed.warnings_json ?? '[]'))).toContainEqual(
        expect.objectContaining({ code: 'images_refresh_incomplete', count: 1 }),
      );
      expect(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')).text).toBe('先前识别的图片');
    } finally {
      fs.rmSync(cacheFile, { force: true });
    }
  });

  it('raw_read 图片处插入 vision_unconfigured 标记；警告落库', async () => {
    writeRaw('图域/img-doc.md', `# 带图\n![](images/i1.png)\n正文 ${FAT}`);
    writeRaw('图域/images/i1.png', TINY_PNG);
    documents.length = 0;
    documents.push(docRecord('tokImg', '图域/img-doc.md'));
    const rawReadCapture = new Map<string, string>();
    const harness = makeHarness(makeConfig({ buildParallelism: 1 }), { rawReadCapture });
    const row = await createAndRun(harness, 'full');
    expect(String(row.status)).toBe('published');
    const captured = rawReadCapture.get('tokImg') ?? '';
    expect(captured).toContain('<image_description');
    expect(captured).toContain('reason="vision_unconfigured"');
    // 警告与图片计数落库
    const warnings = JSON.parse(String(row.warnings_json ?? '[]')) as Array<{ code: string; count: number }>;
    expect(warnings.some((warning) => warning.code === 'images_unavailable' && warning.count >= 1)).toBe(true);
    expect(String(row.vision_model ?? '')).toBe('');
    // 发布的 manifest 快照条目带 mediaHash/imageCount（U4：contentHash 公式不变）
    const kbStore = new StandardKbStore(outputRoot);
    const manifest = kbStore.readManifest(kbStore.readCurrent()!.releaseId)!;
    const entry = manifest.sourceSnapshot.find((item) => item.objToken === 'tokImg')!;
    expect(entry.imageCount).toBe(1);
    expect(entry.mediaHash).toMatch(/^sha256:/);
  });
});

describe('小批次图文源：按识图文本校验体积并保持发布保护', () => {
  it.each([1, 2])('Pi 单 worker 构建 %i 篇短图文源可以发布，真正膨胀时保留上一版本', async (count) => {
    documents.length = 0;
    for (let i = 0; i < count; i++) {
      writeRaw(`短图文/图示${i}.md`, '# 图示\n![](images/diagram.png)\n');
      documents.push(docRecord(`tokSize${i}`, `短图文/图示${i}.md`));
    }
    writeRaw('短图文/images/diagram.png', TINY_PNG);
    const vision: NonNullable<Harness['visionDescriber']> = {
      status: async () => ({ state: 'ready', model: 'fixture/vision', message: '' }),
      lookup: async () => null,
      describeOne: async () => ({ src: 'images/diagram.png', imageHash: 'fixture', state: 'described', text: '图中的结构信息。'.repeat(100) }),
      describeMany: async (items, options) => {
        options.onProgress({ done: items.length, total: items.length });
        return new Map(items.map((item) => [item.src, { src: item.src, imageHash: 'fixture', state: 'described' as const, text: '图中的结构信息。'.repeat(100) }]));
      },
    };
    const script: FakeScript = { outputMarkdown: '图示规则的完整说明。'.repeat(180) };
    const harness = makeHarness(makeConfig({ buildParallelism: 1 }), script, vision);
    const published = await createAndRun(harness, 'full');
    expect(published.status).toBe('published');
    expect(harness.fakes).toHaveLength(1);
    const pointer = new StandardKbStore(outputRoot).readCurrent()!;
    expect(new StandardKbStore(outputRoot).readManifest(pointer.releaseId)?.docs).toHaveLength(count);
    script.outputMarkdown = '超量的规则说明。'.repeat(2000);
    const rejected = await createAndRun(harness, 'full');
    expect(rejected.status).toBe('failed');
    expect(rejected.error_code).toBe('kb_validation_failed');
    expect(rejected.error_message).toContain('total_too_large');
    expect(new StandardKbStore(outputRoot).readCurrent()?.releaseId).toBe(pointer.releaseId);
    expect(fs.readFileSync(path.join(kbRoot, '短图文/图示0.md'), 'utf8')).toBe('# 图示\n![](images/diagram.png)\n');
  });
});

describe('S4：kb_builds 新列 additive 迁移（旧库升级）', () => {
  it('旧 schema（无新列）→ initialize 后补列且默认值可用', () => {
    const legacyDb = path.join(dataRoot, `legacy-kb-builds-${Date.now()}.db`);
    const raw = new Database(legacyDb);
    raw.exec(`
      CREATE TABLE kb_builds (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        base_release_id TEXT,
        release_id TEXT,
        model TEXT,
        source_total INTEGER NOT NULL DEFAULT 0,
        source_added INTEGER NOT NULL DEFAULT 0,
        source_changed INTEGER NOT NULL DEFAULT 0,
        source_removed INTEGER NOT NULL DEFAULT 0,
        docs_written INTEGER NOT NULL DEFAULT 0,
        docs_deleted INTEGER NOT NULL DEFAULT 0,
        no_changes INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
    `);
    raw.prepare("INSERT INTO kb_builds (id, mode, status, created_at) VALUES ('b_old', 'full', 'failed', '2026-01-01')").run();
    raw.close();
    const legacyStore = new LocalMapStore(legacyDb);
    legacyStore.initialize();
    const row = legacyStore.getKbBuild('b_old')!;
    expect(Number(row.parallelism)).toBe(1);
    expect(Number(row.unit_total)).toBe(0);
    expect(row.vision_model ?? null).toBeNull();
    expect(row.warnings_json ?? null).toBeNull();
    legacyStore.updateKbBuild('b_old', { parallelism: 3, unitTotal: 7, warningsJson: '[{"code":"images_unavailable","count":2,"message":"x"}]' });
    const updated = legacyStore.getKbBuild('b_old')!;
    expect(Number(updated.parallelism)).toBe(3);
    expect(Number(updated.unit_total)).toBe(7);
    expect(String(updated.warnings_json)).toContain('images_unavailable');
    legacyStore.close();
  });
});

describe('S3：会话侧 raw_read 内联 + raw_read_image（mock describer）', () => {
  function mockDescriber(state: 'ready' | 'disabled') {
    return {
      status: async () => ({ state, model: state === 'ready' ? 'vision/m' : null, message: '' }),
      lookup: async () => (state === 'ready' ? '缓存中的图片描述文本' : null),
      describeOne: async (_file: string, src: string) => ({
        src, imageHash: 'hash-x', state: 'described' as const, text: '按需描述的图片内容',
      }),
      describeMany: async () => new Map(),
    };
  }

  it('ready：raw_read 内联已缓存描述；raw_read_image 返回描述；非本源 src 拒绝；build 不下发', async () => {
    writeRaw('会话域/会话.md', '# 会话源\n![](images/s1.png)\n正文');
    writeRaw('会话域/images/s1.png', TINY_PNG);
    documents.length = 0;
    documents.push(docRecord('tokSession', '会话域/会话.md'));
    const toolService = new AgentToolService({
      dataRoot, documentsProvider: () => documents, visionDescriber: mockDescriber('ready'),
    });
    const { token } = toolService.createRunContext({
      runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot,
    });
    const read = await toolService.executeTool(token, 'raw_read', { objToken: 'tokSession' });
    const text = read.content[0]!.text;
    expect(text).toContain('<image_description src="images/s1.png" state="cached">');
    expect(text).toContain('缓存中的图片描述文本');
    const image = await toolService.executeTool(token, 'raw_read_image', { objToken: 'tokSession', src: 'images/s1.png' });
    expect(image.content[0]!.text).toContain('按需描述的图片内容');
    await expect(toolService.executeTool(token, 'raw_read_image', { objToken: 'tokSession', src: 'images/不存在.png' }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    // build 白名单不含 raw_read_image（预描述在 preflight 完成）
    const buildCtx = toolService.createRunContext({
      runKind: 'build', buildId: 'b_x', outputRoot, knowledgeBaseRoot: kbRoot,
    });
    await expect(toolService.executeTool(buildCtx.token, 'raw_read_image', { objToken: 'tokSession', src: 'images/s1.png' }))
      .rejects.toMatchObject({ code: 'tool_not_allowed' });
  });

  it('disabled：raw_read 不内联；raw_read_image 报 vision_unconfigured', async () => {
    const toolService = new AgentToolService({
      dataRoot, documentsProvider: () => documents, visionDescriber: mockDescriber('disabled'),
    });
    const { token } = toolService.createRunContext({
      runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot,
    });
    const read = await toolService.executeTool(token, 'raw_read', { objToken: 'tokSession' });
    expect(read.content[0]!.text).not.toContain('<image_description');
    await expect(toolService.executeTool(token, 'raw_read_image', { objToken: 'tokSession', src: 'images/s1.png' }))
      .rejects.toMatchObject({ code: 'vision_unconfigured' });
  });
});

describe('S3：mediaHash 兼容（U4）', () => {
  it('旧 manifest 无 mediaHash → 增量不触发全量 changed；图片替换且双方都有 → changed（vision 启用）', () => {
    const base = [{ objToken: 't', objType: 'docx', title: 't', relPath: 't.md', contentHash: 'h1', objEditTime: null }];
    const upgraded = [{ ...base[0], mediaHash: 'sha256:new', imageCount: 1 }];
    // 旧 manifest（无 mediaHash）vs 升级后条目：即使 vision 启用也不算 changed
    expect(computeChangeset(upgraded as never, { sourceSnapshot: base } as never, { visionEnabled: true }).changed).toEqual([]);
    expect(computeChangeset(upgraded as never, { sourceSnapshot: base } as never, { visionEnabled: true }).isEmpty()).toBe(true);
    // 双方都有 mediaHash 且不等 → changed（仅 vision 启用）
    const baseWithMedia = [{ ...base[0], mediaHash: 'sha256:old', imageCount: 1 }];
    expect(computeChangeset(upgraded as never, { sourceSnapshot: baseWithMedia } as never, { visionEnabled: true }).changed).toEqual(['t']);
    expect(computeChangeset(upgraded as never, { sourceSnapshot: baseWithMedia } as never, { visionEnabled: false }).changed).toEqual([]);
  });
});

describe('S4：DTO 契约', () => {
  it('toDto 输出并行进度结构（units/workers/images/stage/parallelism/warnings）', async () => {
    writeRaw('契约域/c.md', `c ${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokDto', '契约域/c.md'));
    const harness = makeHarness(makeConfig({ buildParallelism: 1 }));
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    expect(dto.parallelism).toBe(1);
    expect(dto.progress).toMatchObject({
      units: { total: expect.any(Number) },
      workers: expect.any(Array),
      images: { total: expect.any(Number) },
    });
    expect(dto.progress.stage).toBeDefined();
    await waitForTerminal(dto.id);
    const rows = store.listKbBuilds(5);
    const dtoAgain = harness.service.toDto(rows[0]);
    expect(Array.isArray(dtoAgain.warnings)).toBe(true);
    expect(typeof dtoAgain.parallelism).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// P2-S2：字数预算接线（worksetMeta words → packBatches → 批次/单元边界与日志）
// ---------------------------------------------------------------------------

describe('P2-S2：buildBatchWordBudget 字数预算接线', () => {
  it('单 worker：预算 = 单源字数 → 每源独批；每批出现 batch k/n 字数日志', async () => {
    writeRaw('预算域/a.md', `a ${FAT}`);
    writeRaw('预算域/b.md', `b ${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokBA', '预算域/a.md'), docRecord('tokBB', '预算域/b.md'));
    // 单源字数（正文 'a ' + FAT 的 countText words）；预算取该值 → 两源必分两批
    const { countText } = await import('../src/kb/text-stats.js');
    const perSource = countText(`a ${FAT}`).words;
    const harness = makeHarness(makeConfig({ buildParallelism: 1, buildBatchWordBudget: perSource }));
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status)).toBe('published');
    // 批次 prompt：两个批（各 1 源）+ finish
    const batchPrompts = harness.fakes.flatMap((process) => process.prompts).filter((p) => p.includes('请处理以下'));
    expect(harness.fakes).toHaveLength(2); // 每批释放上下文，下一批通过已保存草稿继续。
    expect(batchPrompts).toHaveLength(2);
    expect(batchPrompts[0]).toContain('1 个源文档');
    expect(batchPrompts[1]).toContain('1 个源文档');
    // §2.3 批次字数日志（budget>0 时每批一行）
    const logs = harness.service
      .eventsSince(dto.id, null)
      .filter((e) => e.event === 'build_log')
      .map((e) => (e.data as { message?: string }).message ?? '');
    expect(logs.some((m) => new RegExp(`^batch 1/2: sources=1, words=${perSource}$`).test(m))).toBe(true);
    expect(logs.some((m) => new RegExp(`^batch 2/2: sources=1, words=${perSource}$`).test(m))).toBe(true);
  });

  it('单 worker：budget=0（缺省）→ 批次与日志保持旧行为（无 batch 字数行）', async () => {
    writeRaw('预算零域/a.md', `a ${FAT}`);
    writeRaw('预算零域/b.md', `b ${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokZA', '预算零域/a.md'), docRecord('tokZB', '预算零域/b.md'));
    const harness = makeHarness(makeConfig({ buildParallelism: 1 }));
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status)).toBe('published');
    expect(harness.fakes[0].prompts.filter((p) => p.includes('请处理以下'))).toHaveLength(1); // 10 源上限一批
    const logs = harness.service
      .eventsSince(dto.id, null)
      .filter((e) => e.event === 'build_log')
      .map((e) => (e.data as { message?: string }).message ?? '');
    expect(logs.some((m) => m.startsWith('batch '))).toBe(false);
  });

  it('并行 W=2：单元预算×3 把同目录两源切成两单元；每批出现 unit 批字数日志', async () => {
    writeRaw('预算并/a.md', `a ${FAT}`);
    writeRaw('预算并/b.md', `b ${FAT}`);
    documents.length = 0;
    documents.push(docRecord('tokPA', '预算并/a.md'), docRecord('tokPB', '预算并/b.md'));
    // 单元预算 = 3×budget < 两源合计（2×345）→ 目录簇切成 2 个单元 → workerCount=2
    const { countText } = await import('../src/kb/text-stats.js');
    const perSource = countText(`a ${FAT}`).words; // 345
    const harness = makeHarness(makeConfig({ buildParallelism: 2, buildBatchWordBudget: 200 }));
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(dto.id);
    expect(String(row.status)).toBe('published');
    expect(Number(row.unit_total)).toBe(2);
    expect(Number(row.parallelism)).toBe(2);
    // §2.3 并行路径批次字数日志（含单元归属）
    const logs = harness.service
      .eventsSince(dto.id, null)
      .filter((e) => e.event === 'build_log')
      .map((e) => (e.data as { message?: string }).message ?? '');
    expect(logs.some((m) => new RegExp(`^unit u\\d+ batch 1/1: sources=1, words=${perSource}$`).test(m))).toBe(true);
    expect(logs.filter((m) => m.startsWith('unit ')).length).toBeGreaterThanOrEqual(2);
  });
});
