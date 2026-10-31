/**
 * D5 调度补齐测试（B 案 §3/§6 + A 案 §4.2/§7.2）：
 * - 调度优先级（B 案 §6）：已产生草稿的 review/revise 优先、同优先级类内
 *   按等待时长 aging、aging 不反转审查优先；
 * - 规划轮接线（B 案 §3）：plannerEnabled=true → plan 任务先跑 → 计划冻结
 *   （planRevision）→ 写作任务输入引用绑定 planId；false → 无 plan 任务
 *   （现状回归）；计划失败 → 构建失败可恢复；
 * - 增量影响闭包（A 案 §7.2）：源变化种子沿 restates/depends_on/
 *   exception_to 入边扩展（重述宿主/消费者文档进 requiredRewrites）、
 *   决定变化/迁移种子、preservedDocs 收缩、只读支撑源、身份保留不回归；
 * - 治理冻结接线（A 案 §4.2）：启动快照 → 发布前决定变化 →
 *   kb_governance_changed 失败可恢复 → 重取后发布；governance.json 含真实
 *   决定；approved 由决定驱动写入 knowledge.json；发布门禁消费冻结快照；
 * - kb_search asOf 参数透传（D2 收尾）。
 *
 * 端到端沿用 frozen-pipeline/knowledge-seam 的 FakeRpcProcess 模式（真实
 * 工具/检查点/恢复/发布链路，仅模型进程为受控替身）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KbBuildService, computeImpactClosure } from '../src/kb/kb-build-service.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { BuildOrchestration, schedulingPriorityClass } from '../src/kb/build-orchestration.js';
import { planUnits } from '../src/kb/build-units.js';
import { KbVersionStore } from '../src/kb/kb-version-store.js';
import { KnowledgeGovernanceService } from '../src/kb/knowledge-governance-service.js';
import type { KnowledgeManifest, KnowledgeObject, KnowledgeRelation } from '../src/kb/knowledge-schema.js';
import { getToolSpec } from '../src/agent/tool-specs.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
import type { PiRpcProcess, RunOutcome } from '../src/agent/pi-rpc-process.js';
import type { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { Config, DocumentRecord } from '../src/types/index.js';

// ===========================================================================
// 单元层：调度优先级（B 案 §6）
// ===========================================================================

function orchestrationForPriority(): BuildOrchestration {
  const spec = {
    buildId: 'b-prio', sourceSnapshotId: 'b-prio:snapshot', sourceSnapshotHash: 'snap',
    baseReleaseId: null,
    roles: { writer: { modelPresetId: 'w' }, reviewer: { modelPresetId: 'r' } },
    specVersion: 'v1', concurrency: 2, maxAutoRevisions: 2, maxInterfaceRetries: 2,
    publishMode: 'auto' as const,
  };
  return new BuildOrchestration(spec);
}

describe('D5 调度优先级（B 案 §6：已产生草稿的审查/修订优先 + 等待时长 aging）', () => {
  it('三任务（write 早排队 + review ready + write ready）→ review 先出；aging 不反转 review 优先', () => {
    const orchestration = orchestrationForPriority();
    // 写任务 A：早排队（等待最久）
    orchestration.createTask({
      taskId: 't:write:u1:r0', revision: 0, role: 'write', unitId: 'u1', reviewSubjectDraftHash: null,
      inputRefs: [], dependencies: [], allowedWritePaths: [], outputRequirements: '',
      queuedAt: '2026-01-01T00:00:00Z',
    });
    // 审查任务：晚入队（aging 落后），依赖写任务产物
    orchestration.updateExecState('t:write:u1:r0', 'running');
    orchestration.submitResult({ taskId: 't:write:u1:r0', revision: 0, artifactState: 'available' });
    orchestration.createTask({
      taskId: 't:review:u1:r0', revision: 0, role: 'review', unitId: 'u1', reviewSubjectDraftHash: 'h',
      inputRefs: [], dependencies: [{ taskId: 't:write:u1:r0', requires: 'artifact_available' }],
      allowedWritePaths: [], outputRequirements: '',
      queuedAt: '2026-01-01T05:00:00Z',
    });
    // 写任务 B：晚入队且就绪
    orchestration.createTask({
      taskId: 't:write:u2:r0', revision: 0, role: 'write', unitId: 'u2', reviewSubjectDraftHash: null,
      inputRefs: [], dependencies: [], allowedWritePaths: [], outputRequirements: '',
      queuedAt: '2026-01-01T01:00:00Z',
    });
    const ready = orchestration.readyTasks().map((task) => task.taskId);
    // review 优先（已产生草稿的审查不被新撰写抢占），即使入队更晚；
    // 已完成的写任务不再排队
    expect(ready).toEqual(['t:review:u1:r0', 't:write:u2:r0']);
  });

  it('两个 write 就绪 → 按等待时长（queuedAt 早者优先）；修订轮（revision ≥1）也属高优先类', () => {
    const orchestration = orchestrationForPriority();
    orchestration.createTask({
      taskId: 't:write:u2:r0', revision: 0, role: 'write', unitId: 'u2', reviewSubjectDraftHash: null,
      inputRefs: [], dependencies: [], allowedWritePaths: [], outputRequirements: '',
      queuedAt: '2026-01-01T02:00:00Z',
    });
    orchestration.createTask({
      taskId: 't:write:u1:r0', revision: 0, role: 'write', unitId: 'u1', reviewSubjectDraftHash: null,
      inputRefs: [], dependencies: [], allowedWritePaths: [], outputRequirements: '',
      queuedAt: '2026-01-01T01:00:00Z',
    });
    expect(orchestration.readyTasks().map((task) => task.taskId)).toEqual(['t:write:u1:r0', 't:write:u2:r0']);
    // 优先类：review/final_review 与修订轮为 0；首轮 write/integrate 与 plan 为 1
    expect(schedulingPriorityClass({ role: 'review', revision: 0 })).toBe(0);
    expect(schedulingPriorityClass({ role: 'final_review', revision: 0 })).toBe(0);
    expect(schedulingPriorityClass({ role: 'write', revision: 1 })).toBe(0);
    expect(schedulingPriorityClass({ role: 'integrate', revision: 2 })).toBe(0);
    expect(schedulingPriorityClass({ role: 'write', revision: 0 })).toBe(1);
    expect(schedulingPriorityClass({ role: 'integrate', revision: 0 })).toBe(1);
    expect(schedulingPriorityClass({ role: 'plan', revision: 0 })).toBe(1);
  });

  it('旧快照任务（无 queuedAt）与有 queuedAt 混排不抛错且稳定（创建序兜底）', () => {
    const orchestration = orchestrationForPriority();
    orchestration.createTask({
      taskId: 't:write:u1:r0', revision: 0, role: 'write', unitId: 'u1', reviewSubjectDraftHash: null,
      inputRefs: [], dependencies: [], allowedWritePaths: [], outputRequirements: '',
    });
    // 模拟旧形状快照：直接抹掉内部任务的 queuedAt（additive 字段缺省）
    delete (orchestration as unknown as { taskMap: Map<string, { queuedAt?: string }> })
      .taskMap.get('t:write:u1:r0')!.queuedAt;
    orchestration.createTask({
      taskId: 't:write:u2:r0', revision: 0, role: 'write', unitId: 'u2', reviewSubjectDraftHash: null,
      inputRefs: [], dependencies: [], allowedWritePaths: [], outputRequirements: '',
      queuedAt: '2026-01-01T01:00:00Z',
    });
    // 无 queuedAt（空串排最前）不抛错，稳定返回
    expect(orchestration.readyTasks().map((task) => task.taskId)).toEqual(['t:write:u1:r0', 't:write:u2:r0']);
  });
});

// ===========================================================================
// 单元层：增量影响闭包（A 案 §7.2）
// ===========================================================================

function closureObject(objectId: string, docPath: string, status: KnowledgeObject['businessStatus'] = 'candidate'): KnowledgeObject {
  return {
    objectId, type: 'rule', title: objectId, aliases: [], domainIds: [],
    familyKey: `fam:${objectId}`, variantKey: 'v1', scopeKey: `scope:${objectId}`, scopeText: objectId,
    canonical: { docId: `kd_${objectId}`, path: docPath, bodyRange: { startLine: 2, endLine: 3 } },
    revision: 1, locationRevision: 0, payloadHash: `hash:${objectId}`, reviewSubjectHash: `rsh:${objectId}`,
    businessStatus: status, reviewStatus: 'passed', claims: [],
  } as KnowledgeObject;
}

function closureEdge(from: string, to: string, type: KnowledgeRelation['type']): KnowledgeRelation {
  return { edgeId: `ke_${from}_${to}_${type}`, fromObjectId: from, toObjectId: to, type, scopeKey: 'scope:x', evidenceIds: [] };
}

function closureManifest(objects: KnowledgeObject[], relations: KnowledgeRelation[]): KnowledgeManifest {
  return {
    schemaVersion: 1, documents: [], objects, presentations: [], relations, evidence: [], coverage: [], migrations: [],
  };
}

describe('D5 增量影响闭包（A 案 §7.2：种子 → 语义边固定点）', () => {
  const alpha = closureObject('ko_alpha', '主定义.md');
  const beta = closureObject('ko_beta', '重述.md');
  const gamma = closureObject('ko_gamma', '消费.md');

  it('源变化种子 → restates 重述宿主与 depends_on/exception_to 消费者文档进 requiredRewrites；支撑源只读返回', () => {
    const manifest = closureManifest([alpha, beta, gamma], [
      closureEdge('ko_beta', 'ko_alpha', 'restates'),      // beta 重述 alpha（beta 宿主=重述.md）
      closureEdge('ko_gamma', 'ko_alpha', 'depends_on'),   // gamma 消费 alpha
      closureEdge('ko_alpha', 'ko_beta', 'exception_to'),  // 反向边不因 beta 未种子而触发
    ]);
    const result = computeImpactClosure({
      seedDocPaths: ['主定义.md'],
      baseline: manifest,
      baseDocSources: new Map([['重述.md', ['tokB']], ['消费.md', ['tokC']]]),
    });
    expect(result.seeds.sourceChange).toEqual(['主定义.md']);
    expect(result.closureDocs.sort()).toEqual(['消费.md', '重述.md']);
    expect(result.requiredRewrites.sort()).toEqual(['主定义.md', '消费.md', '重述.md']);
    // 闭包文档支撑源作为只读输入返回（不进工作集、不误计云端新增）
    expect(result.readOnlySources.get('重述.md')).toEqual(['tokB']);
    expect(result.readOnlySources.get('消费.md')).toEqual(['tokC']);
    expect(result.closureSeedOf.get('重述.md')).toBe('主定义.md');
    expect(result.closureSeedOf.get('消费.md')).toBe('主定义.md');
  });

  it('固定点传递（A→B→C 链）且按文档去重不重复；无关关系词不传播', () => {
    const delta = closureObject('ko_delta', '下游.md');
    const manifest = closureManifest([alpha, beta, delta, gamma], [
      closureEdge('ko_beta', 'ko_alpha', 'restates'),     // 主定义 → 重述
      closureEdge('ko_delta', 'ko_beta', 'depends_on'),   // 重述 → 下游（二跳闭包）
      closureEdge('ko_gamma', 'ko_delta', 'supersedes'),  // supersedes 不参与传播
    ]);
    const result = computeImpactClosure({ seedDocPaths: ['主定义.md'], baseline: manifest });
    expect(result.closureDocs.sort()).toEqual(['下游.md', '重述.md']);
    expect(result.requiredRewrites.filter((docPath) => docPath === '主定义.md')).toHaveLength(1);
  });

  it('决定变化种子：有效决定状态/载荷与基线对象不一致 → 对象宿主文档入种子；一致则不触发', () => {
    const manifest = closureManifest([alpha], []);
    const changed = computeImpactClosure({
      seedDocPaths: [], baseline: manifest,
      effectiveDecisions: [{ objectId: 'ko_alpha', payloadHash: 'hash:ko_alpha', businessStatus: 'approved' }],
    });
    expect(changed.seeds.decisionChange).toEqual(['主定义.md']);
    expect(changed.requiredRewrites).toEqual(['主定义.md']);
    const unchanged = computeImpactClosure({
      seedDocPaths: [], baseline: manifest,
      effectiveDecisions: [{ objectId: 'hash-mismatch-ignore', payloadHash: 'x', businessStatus: 'candidate' }],
    });
    // 决定对象不在基线（或状态一致）→ 不产生种子
    expect(unchanged.requiredRewrites).toEqual([]);
  });

  it('迁移种子：迁移对象宿主文档进入重写面；无基线（null）时闭包退化为纯种子', () => {
    const manifest = closureManifest([alpha, beta], []);
    const withMigration = computeImpactClosure({
      seedDocPaths: [], baseline: manifest,
      migrations: [{ objectId: 'ko_alpha', kind: 'merge', successorObjectIds: ['ko_beta'], reason: '合并' }],
    });
    expect(withMigration.seeds.migration).toEqual(['主定义.md']);
    const noBaseline = computeImpactClosure({ seedDocPaths: ['a.md'], baseline: null });
    expect(noBaseline.requiredRewrites).toEqual(['a.md']);
    expect(noBaseline.closureDocs).toEqual([]);
  });
});

// ===========================================================================
// 单元层：闭包文档单元归属（planUnits closureDocLinks，A 案 §7.2）
// ===========================================================================

describe('D5 闭包文档单元归属与只读源（A 案 §7.2）', () => {
  const baseDocs = [
    { path: '主定义.md', sources: ['tokA'] },
    { path: '重述.md', sources: ['tokB'] },
    { path: '无源种子.md', sources: ['tokD'] },
  ];
  const workset = new Map([['tokA', { relPath: '主题/a.md', bytes: 100, words: 10 }]]);

  it('seedPath 并入种子分量：闭包文档与种子文档同单元，支撑源进 readOnlySources', () => {
    const units = planUnits({
      mode: 'incremental', workset, baseDocs, requiredRewrites: ['主定义.md', '重述.md'],
      removedSources: [], batchSize: 10,
      closureDocLinks: [{ path: '重述.md', sources: ['tokB'], seedPath: '主定义.md' }],
    });
    expect(units).toHaveLength(1);
    expect(units[0]!.ownedDocs.sort()).toEqual(['主定义.md', '重述.md']);
    expect(units[0]!.affectedDocs.map((doc) => doc.path).sort()).toEqual(['主定义.md', '重述.md']);
    expect(units[0]!.readOnlySources).toEqual(['tokB']);
    expect(units[0]!.sources).toEqual(['tokA']); // 只读源不进批次源
  });

  it('无 seedPath（决定/迁移种子）且自身源不在工作集 → 孤儿归并到既有单元并带只读源', () => {
    const units = planUnits({
      mode: 'incremental', workset, baseDocs, requiredRewrites: ['主定义.md', '无源种子.md'],
      removedSources: [], batchSize: 10,
      closureDocLinks: [{ path: '无源种子.md', sources: ['tokD'] }],
    });
    expect(units).toHaveLength(1);
    expect(units[0]!.ownedDocs.sort()).toEqual(['主定义.md', '无源种子.md']);
    expect(units[0]!.readOnlySources).toEqual(['tokD']);
  });

  it('全空工作集（纯决定驱动）→ 兜底单元承接全部重写面与只读源', () => {
    const units = planUnits({
      mode: 'incremental', workset: new Map(), baseDocs, requiredRewrites: ['主定义.md'],
      removedSources: [], batchSize: 10,
      closureDocLinks: [{ path: '主定义.md', sources: ['tokA'] }],
    });
    expect(units).toHaveLength(1);
    expect(units[0]!.ownedDocs).toEqual(['主定义.md']);
    expect(units[0]!.readOnlySources).toEqual(['tokA']);
    expect(units[0]!.batches).toEqual([[]]);
  });
});

// ===========================================================================
// 单元层：kb_search asOf 透传（D2 收尾）
// ===========================================================================

describe('D5 kb_search asOf 透传（A 案 §6.1）', () => {
  it('工具 schema 声明 asOf；对象感知模式下透传查询层并回显', async () => {
    expect(getToolSpec('kb_search')?.parameters.properties).toHaveProperty('asOf');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-asof-'));
    try {
      const out = path.join(root, 'published');
      writeSearchRelease(out, 'r1', [
        { path: '战斗/伤害.md', title: '伤害结算', docId: 'damage', body: '# 伤害\n## 暴击\n伤害按暴击倍率结算。\n' },
      ]);
      const tools = new AgentToolService({ dataRoot: root, documentsProvider: () => [] });
      const { token } = tools.createRunContext({ runKind: 'work', outputRoot: out, knowledgeBaseRoot: path.join(root, 'raw') });
      const result = await tools.executeTool(token, 'kb_search', { query: '暴击 伤害', usage: 'browse', asOf: '2026-01-01' });
      const parsed = JSON.parse(result.content[0]!.text) as { asOf?: string; hint?: string[] };
      expect(parsed.asOf).toBe('2026-01-01');
      expect((parsed.hint ?? []).join('\n')).toContain('asOf=2026-01-01');
      // 不传 asOf：行为不变（无回显）
      const plain = JSON.parse((await tools.executeTool(token, 'kb_search', { query: '暴击' })).content[0]!.text) as { asOf?: string };
      expect(plain.asOf).toBeUndefined();
      tools.revokeToken(token);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 端到端（FakeRpc）：规划轮（B 案 §3）/ 影响闭包 seam（A 案 §7.2）/
// 治理冻结（A 案 §4.2）——真实工具/检查点/恢复/发布链路
// ===========================================================================

const FAT = '规则的详细说明段落，包含定义、流程、边界与示例，用于把原始源体积撑到足以覆盖产出文档的校验阈值。'.repeat(8);

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let store: LocalMapStore;
const documents: DocumentRecord[] = [];

function docRecord(token: string, rel: string): DocumentRecord {
  return {
    wikiNodeToken: null, objType: 'docx', objToken: token, title: token,
    localRelPath: rel, localMdPath: path.join(kbRoot, rel),
    lastSyncedModifyTime: '', lastSyncedAt: new Date().toISOString(), status: 'synced',
  } as DocumentRecord;
}

function writeRaw(rel: string, content: string): void {
  const full = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** 双文档语料：tokA→主定义源；tokB→重述源（同一一级目录保证单单元）。 */
function seedClosureCorpus(): void {
  documents.length = 0;
  writeRaw('主题/主定义源.md', ['# 主定义源', '攻防差每点提供 0.5% 修正，上限 30%。', `背景。${FAT}`].join('\n'));
  writeRaw('主题/重述源.md', ['# 重述源', '主定义的换算重述：每点 0.5%，上限三成。', `说明。${FAT}`].join('\n'));
  documents.push(docRecord('tokA', '主题/主定义源.md'), docRecord('tokB', '主题/重述源.md'));
}

/** 单文档语料：治理决定用（正文含第二章节使源追加不进对象区间）。 */
function seedGovernanceCorpus(): void {
  documents.length = 0;
  writeRaw('治理/规则源.md', ['# 规则源', '怒气上限 100 点，不在战斗外恢复。', `背景。${FAT}`, '## 备注', `注释区。${FAT}`].join('\n'));
  documents.push(docRecord('tokGov', '治理/规则源.md'));
}

function makeConfig(overrides: { publishMode?: 'auto' | 'confirm'; plannerEnabled?: boolean } = {}): Config {
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
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 30,
      buildParallelism: 1, autoBuildAfterSync: false,
      buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: 'rev-model' }, plannerEnabled: overrides.plannerEnabled ?? false },
      reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 },
      publishMode: overrides.publishMode ?? 'auto',
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

type FakeMode = 'plain' | 'declareClosure' | 'declareGovernance' | 'governanceRewrite';

interface E2eScript {
  prompts: string[];
  mode: FakeMode;
  /** 规划轮：提交 kb_submit_plan（false=永不提交，驱动计划失败） */
  planSubmit: boolean;
  /** 最终复核 prompt 到达后挂起直到 releaseFinalReview() */
  hangFinalReview?: boolean;
  releaseFinalReview?: () => void;
  /** 捕获 kb_write_doc 返回的对象映射（身份断言用） */
  objectIds?: Record<string, string>;
}

class D5FakeRpc extends EventEmitter {
  exited = false;
  private pending: Array<(value: RunOutcome) => void> = [];
  constructor(
    private readonly toolService: AgentToolService,
    private readonly token: string,
    private readonly script: E2eScript,
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
    // 规划轮（B 案 §3）：提交主题分组建议
    if (message.includes('【组织规划】')) {
      if (this.script.planSubmit) {
        await this.call('kb_submit_plan', {
          docs: [{ path: '主题/规划总览.md', title: '规划总览', summary: '按攻防主题分组' }],
          objectCandidates: [],
        });
      }
      return { outcome: 'completed' };
    }
    if (message.includes('kb_submit_plan') && message.includes('直接调用 kb_submit_plan')) {
      if (this.script.planSubmit) {
        await this.call('kb_submit_plan', {
          docs: [{ path: '主题/规划总览.md', title: '规划总览', summary: '按攻防主题分组' }],
        });
      }
      return { outcome: 'completed' };
    }
    // 单元审查 / 最终复核
    if (message.includes('【单元审查')) {
      const unitId = /【单元审查 (u\d+)】/.exec(message)?.[1] ?? 'all';
      await this.call('kb_submit_review', {
        unitId, coverage: { sourceRefs: ['tok-any'] },
        checkedDimensions: ['事实与数值'], issues: [], uncheckedScope: [], conclusion: 'pass',
      });
      return { outcome: 'completed' };
    }
    if (message.includes('【最终复核】')) {
      if (this.script.hangFinalReview) {
        // 挂起直到测试调 releaseFinalReview()（释放后照常提交审查报告）
        return await new Promise<RunOutcome>((resolve) => {
          this.script.releaseFinalReview = () => {
            void this.call('kb_submit_review', {
              coverage: { sourceRefs: ['tok-any'] },
              checkedDimensions: ['事实与数值'], issues: [], uncheckedScope: [], conclusion: 'pass',
            }).then(
              () => resolve({ outcome: 'completed' }),
              (error) => resolve({ outcome: 'failed', error: { code: 'fake_script_error', message: String(error) } }),
            );
          };
        });
      }
      await this.call('kb_submit_review', {
        coverage: { sourceRefs: ['tok-any'] },
        checkedDimensions: ['事实与数值'], issues: [], uncheckedScope: [], conclusion: 'pass',
      });
      return { outcome: 'completed' };
    }
    if ((message.includes('【单元') || message.includes('【批次'))
      && (message.includes('请处理以下') || message.includes('语义影响闭包'))) {
      return await this.actBatch(message);
    }
    if (message.includes('kb_unit_done')) {
      await this.call('kb_unit_done', { summary: '单元完成（fixture）', skipped: [] });
      return { outcome: 'completed' };
    }
    if (message.includes('kb_finish')) {
      await this.call('kb_finish', { summary: '整体完成（fixture）', skipped: [] });
      return { outcome: 'completed' };
    }
    return { outcome: 'completed' };
  }
  /** 批次写入：按场景声明对象（真实工具链；raw_read 回执→kb_write_doc）。 */
  private async actBatch(message: string): Promise<RunOutcome> {
    if (this.script.mode === 'plain') {
      const tokens = [...message.matchAll(/^\| (tok\S+) \|/gm)].map((match) => match[1]);
      for (const [index, token] of tokens.entries()) {
        await this.call('kb_write_doc', {
          path: `主题/规则-${index + 1}.md`, title: '规则主题',
          markdown: `规则主题正文（第 ${index + 1} 篇）。${FAT}`, sources: [token], summary: '规则主题概要',
        });
      }
      await this.call('kb_unit_done', { summary: '单元完成', skipped: [] });
      return { outcome: 'completed' };
    }
    if (this.script.mode === 'declareClosure') {
      // 双文档声明：主定义（alpha）+ 受控重述（beta restates alpha）
      const readA = await this.call('raw_read', { objToken: 'tokA' });
      const receiptA = (readA as { details?: { readReceiptId?: string | null } }).details?.readReceiptId ?? null;
      const result = await this.call('kb_write_doc', {
        path: '主题/主定义.md', title: '主定义', markdown: '## Alpha 攻防修正\nALPHA 主定义：攻防差每点提供 0.5% 修正，上限 30%。', sources: ['tokA'], summary: '主定义概要',
        objects: [{
          clientKey: 'alpha', type: 'rule', title: 'Alpha 攻防修正',
          familyKey: 'fam:closure:alpha', variantKey: 'v1', scopeKey: 'scope:closure', scopeText: '闭包测试全局',
          headingPath: ['Alpha 攻防修正'], claims: [{ claimKey: 'alpha-cap', riskCategory: 'normal' }],
        }],
        evidenceClaims: receiptA ? [{
          clientKey: 'ev-alpha', objectKey: 'alpha', claimKey: 'alpha-cap',
          sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
          selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0, headingPath: [] },
          role: 'supports', nature: 'direct', readReceiptId: receiptA,
        }] : [],
      });
      this.script.objectIds = ((result as { details?: { objectMap?: Record<string, string> } }).details?.objectMap) ?? undefined;
      const readB = await this.call('raw_read', { objToken: 'tokB' });
      const receiptB = (readB as { details?: { readReceiptId?: string | null } }).details?.readReceiptId ?? null;
      await this.call('kb_write_doc', {
        path: '主题/重述.md', title: '重述', markdown: '## Beta 重述\nBETA 重述：每点 0.5%，上限三成。', sources: ['tokB'], summary: '重述概要',
        objects: [{
          clientKey: 'beta', type: 'concept', title: 'Beta 重述',
          familyKey: 'fam:closure:beta', variantKey: 'v1', scopeKey: 'scope:closure', scopeText: '闭包测试全局',
          headingPath: ['Beta 重述'], claims: [{ claimKey: 'beta-note', riskCategory: 'normal' }],
        }],
        relations: [{ fromKey: 'beta', toKey: 'alpha', type: 'restates', scopeKey: 'scope:closure' }],
        evidenceClaims: receiptB ? [{
          clientKey: 'ev-beta', objectKey: 'beta', claimKey: 'beta-note',
          sourceRef: { sourceId: 'tokB', resourceId: 'tokB' },
          selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0, headingPath: [] },
          role: 'supports', nature: 'direct', readReceiptId: receiptB,
        }] : [],
      });
      await this.call('kb_unit_done', { summary: '双文档声明完成', skipped: [] });
      return { outcome: 'completed' };
    }
    // declareGovernance / governanceRewrite：单对象声明（重写时内容逐字不变 → 载荷不变）
    const read = await this.call('raw_read', { objToken: 'tokGov' });
    const receipt = (read as { details?: { readReceiptId?: string | null } }).details?.readReceiptId ?? null;
    const result = await this.call('kb_write_doc', {
      path: '治理/规则.md', title: '怒气规则', markdown: '## Alpha 怒气上限\nALPHA 怒气上限 100 点，不在战斗外恢复。', sources: ['tokGov'], summary: '怒气规则概要',
      objects: [{
        clientKey: 'govAlpha', type: 'rule', title: 'Alpha 怒气上限',
        familyKey: 'fam:gov:alpha', variantKey: 'v1', scopeKey: 'scope:gov', scopeText: '治理测试全局',
        headingPath: ['Alpha 怒气上限'], claims: [{ claimKey: 'gov-cap', riskCategory: 'normal' }],
      }],
      evidenceClaims: receipt ? [{
        clientKey: 'ev-gov', objectKey: 'govAlpha', claimKey: 'gov-cap',
        sourceRef: { sourceId: 'tokGov', resourceId: 'tokGov' },
        selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0, headingPath: [] },
        role: 'supports', nature: 'direct', readReceiptId: receipt,
      }] : [],
    });
    this.script.objectIds = ((result as { details?: { objectMap?: Record<string, string> } }).details?.objectMap) ?? undefined;
    await this.call('kb_unit_done', { summary: '治理声明完成', skipped: [] });
    return { outcome: 'completed' };
  }
  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return await this.toolService.executeTool(this.token, tool, args);
  }
}

function makeHarness(config: Config, script: E2eScript): {
  service: KbBuildService; pool: AgentProcessPool; close: () => Promise<void>;
} {
  const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, idleTimeoutMinutes: 10 });
  const toolService = new AgentToolService({ dataRoot, documentsProvider: () => documents, sheetCsvPaths: () => [] });
  const service = new KbBuildService({
    dataRoot, pool, toolService, resolver: stubResolver(), configProvider: () => config,
    documentsProvider: () => documents, excludedSourcesProvider: () => [], sheetCsvPaths: () => [],
    unselectedSourcesProvider: () => unselectedTokens, internalBaseUrl: () => 'http://127.0.0.1:39999',
    extensionPath: () => null, promptAssets: () => null,
    processFactory: (options) => {
      const token = String(options.env.FEISHU_SYNC_AGENT_RUN_TOKEN ?? '');
      return new D5FakeRpc(toolService, token, script) as unknown as PiRpcProcess;
    },
  });
  return { service, pool, close: async () => { await pool.closeAll(); } };
}

/** rebuildSelected 场景的未选源面（可变；默认空） */
let unselectedTokens: string[] = [];

const NON_TERMINAL = ['queued', 'preflight', 'running', 'validating', 'publishing', 'awaiting_release'];

async function waitForTerminal(service: KbBuildService, buildId: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.getKbBuild(buildId);
    if (row && !NON_TERMINAL.includes(String(row.status))) return row;
    if (Date.now() > deadline) throw new Error(`构建未在 ${timeoutMs}ms 内进入终态: ${row ? `${row.status} ${row.error_code ?? ''} ${row.error_message ?? ''}` : 'missing'}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitPrompt(script: E2eScript, marker: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!script.prompts.some((message) => message.includes(marker)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!script.prompts.some((message) => message.includes(marker))) throw new Error(`未等到 prompt: ${marker}`);
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-sched-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-sched-kb-'));
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

describe('D5 端到端：规划轮接线（B 案 §3）', () => {
  it('plannerEnabled=true → plan 任务先跑 → 计划冻结 → 写作任务输入引用绑定 planId', async () => {
    seedClosureCorpus();
    const config = makeConfig({ plannerEnabled: true });
    const script: E2eScript = { mode: 'plain', planSubmit: true, prompts: [] };
    const harness = makeHarness(config, script);
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(harness.service, dto.id);
    expect(String(row.status), String(row.error_message)).toBe('published');
    await harness.close();
    // 规划先于单元写作执行
    const planIndex = script.prompts.findIndex((message) => message.includes('【组织规划】'));
    const unitIndex = script.prompts.findIndex((message) => message.includes('【单元') && message.includes('请处理以下'));
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeLessThan(unitIndex);
    // 计划冻结：planRevision ≥ 1；写作任务输入引用绑定 planId
    const checkpoint = new BuildCheckpointStore(outputRoot).read(dto.id)!;
    const tasks = checkpoint.orchestration!.tasks;
    const planTask = tasks.find((task) => task.role === 'plan');
    expect(planTask).toBeDefined();
    expect(planTask!.artifactState).toBe('available');
    const planFile = JSON.parse(fs.readFileSync(path.join(outputRoot, '.staging', dto.id, 'organization-plan.json'), 'utf8')) as { planRevision: number };
    expect(planFile.planRevision).toBeGreaterThanOrEqual(1);
    const writeTask = tasks.find((task) => task.role === 'write');
    expect(writeTask!.inputRefs.some((ref) => /^plan:kplan_.+@\d+$/.test(ref))).toBe(true);
    // 进度端点摘要：plannerEnabled 与决定快照哈希可见
    const progress = harness.service.orchestrationProgress(store as never, dto.id);
    expect(progress!.spec.plannerEnabled).toBe(true);
    expect(typeof progress!.spec.governanceSnapshotHash).toBe('string');
  });

  it('plannerEnabled=false（默认）→ 无 plan 任务与规划 prompt（现状回归）', async () => {
    seedClosureCorpus();
    const config = makeConfig({ plannerEnabled: false });
    const script: E2eScript = { mode: 'plain', planSubmit: true, prompts: [] };
    const harness = makeHarness(config, script);
    const dto = await harness.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row = await waitForTerminal(harness.service, dto.id);
    expect(String(row.status), String(row.error_message)).toBe('published');
    await harness.close();
    const checkpoint = new BuildCheckpointStore(outputRoot).read(dto.id)!;
    expect(checkpoint.orchestration!.tasks.some((task) => task.role === 'plan')).toBe(false);
    expect(script.prompts.some((message) => message.includes('【组织规划】'))).toBe(false);
    const progress = harness.service.orchestrationProgress(store as never, dto.id);
    expect(progress!.spec.plannerEnabled).toBe(false);
  });

  it('计划失败（重试耗尽）→ 构建失败可恢复；恢复后计划提交并发布', async () => {
    seedClosureCorpus();
    const config = makeConfig({ plannerEnabled: true });
    const failScript: E2eScript = { mode: 'plain', planSubmit: false, prompts: [] };
    const first = makeHarness(config, failScript);
    const dto = await first.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const failed = await waitForTerminal(first.service, dto.id);
    expect(String(failed.status)).toBe('failed');
    expect(String(failed.error_code)).toBe('kb_interface_failed');
    const beforeCurrent = fs.readFileSync(path.join(outputRoot, 'CURRENT.json'), 'utf8');
    await first.close();

    // 恢复：规划任务后继续跑（fake 修复为提交计划）
    const resumeScript: E2eScript = { mode: 'plain', planSubmit: true, prompts: [] };
    const resumed = makeHarness(config, resumeScript);
    const resumeDto = await resumed.service.resumeBuild(store as never, dto.id, 'RESUME');
    expect(['queued', 'preflight', 'running']).toContain(resumeDto.status);
    const row = await waitForTerminal(resumed.service, dto.id);
    expect(String(row.status), `${String(row.error_code)} ${String(row.error_message)}`).toBe('published');
    await resumed.close();
    expect(fs.readFileSync(path.join(outputRoot, 'CURRENT.json'), 'utf8')).not.toBe(beforeCurrent);
    // 规划在恢复轮重新执行（首次运行失败时未及持久化 plan 任务，恢复重建）
    expect(resumeScript.prompts.some((message) => message.includes('【组织规划】'))).toBe(true);
    expect(failScript.prompts.filter((message) => message.includes('【组织规划】')).length).toBeGreaterThanOrEqual(1);
    const checkpoint = new BuildCheckpointStore(outputRoot).read(dto.id)!;
    const planTaskIds = checkpoint.orchestration!.tasks.filter((task) => task.role === 'plan').map((task) => task.taskId);
    expect(planTaskIds.length).toBeGreaterThanOrEqual(1);
    const planTask = checkpoint.orchestration!.tasks.find((task) => task.role === 'plan');
    expect(planTask!.artifactState).toBe('available');
  });
});

describe('D5 端到端：增量影响闭包 seam（A 案 §7.2）', () => {
  it('改一个源 → restates 宿主文档进 requiredRewrites；preservedDocs 收缩；只读支撑源进单元；身份保留不回归', async () => {
    // ---- build1（full）：双文档声明，beta restates alpha ----
    seedClosureCorpus();
    unselectedTokens = [];
    const config = makeConfig();
    const script1: E2eScript = { mode: 'declareClosure', planSubmit: true, prompts: [] };
    const first = makeHarness(config, script1);
    const dto1 = await first.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row1 = await waitForTerminal(first.service, dto1.id);
    expect(String(row1.status), String(row1.error_message)).toBe('published');
    await first.close();
    const release1 = String(row1.release_id);
    const knowledge1 = new KbVersionStore(outputRoot).readKnowledgeManifest(release1)!;
    expect(knowledge1.relations.some((edge) => edge.type === 'restates')).toBe(true);
    const ids1 = knowledge1.objects.map((object) => object.objectId).sort();

    // ---- build2（incremental + rebuildSelected，仅选 tokA）----
    // 未选 tokB：工作集只含主定义源；重述文档必须由闭包拉入
    writeRaw('主题/主定义源.md', `${['# 主定义源', '攻防差每点提供 0.5% 修正，上限 30%。', `背景。${FAT}`].join('\n')}\n追加一行：背景补充（对象区间外）。`);
    unselectedTokens = ['tokB'];
    const script2: E2eScript = { mode: 'declareClosure', planSubmit: true, prompts: [] };
    const second = makeHarness(config, script2);
    const dto2 = await second.service.createBuild(store as never, { mode: 'incremental', confirm: 'BUILD', rebuildSelected: true });
    const row2 = await waitForTerminal(second.service, dto2.id);
    expect(String(row2.status), String(row2.error_message)).toBe('published');
    await second.close();
    unselectedTokens = [];

    // 闭包生效：重述文档进入 requiredRewrites（否则只有主定义文档）
    const checkpoint = new BuildCheckpointStore(outputRoot).read(dto2.id)!;
    expect(checkpoint.requiredRewrites.sort()).toEqual(['主题/主定义.md', '主题/重述.md']);
    // preservedDocs 收缩：闭包内文档不再 preserved（A 案 §7.2）
    expect(new Map(checkpoint.preservedDocs).has('主题/重述.md')).toBe(false);
    expect(new Map(checkpoint.preservedDocs).has('主题/主定义.md')).toBe(false);
    // 单元提示词：重述文档列入受影响面 + tokB 以只读支撑源出现（不进批次）
    const unitPrompt = script2.prompts.find((message) => message.includes('【单元') && message.includes('主定义源'));
    expect(unitPrompt).toBeDefined();
    expect(unitPrompt!).toContain('主题/重述.md');
    expect(unitPrompt!).toContain('tokB');
    expect(unitPrompt!).toContain('只读输入');
    expect(unitPrompt!).not.toContain('| tokB |');
    // 身份保留不回归（T8/F06 同族三元组）：对象 ID 与 release1 一致
    const knowledge2 = new KbVersionStore(outputRoot).readKnowledgeManifest(String(row2.release_id))!;
    expect(knowledge2.objects.map((object) => object.objectId).sort()).toEqual(ids1);
  });
});

describe('D5 端到端：治理冻结接线（A 案 §4.2）', () => {
  it('启动快照 → 决定驱动发布：governance.json 含真实决定；approved 写入 knowledge.json；进度可见快照哈希', async () => {
    // 独立标准库根：避免继承闭包用例的基线对象（full 重建不同语料会触发
    // 「未解释丢失」门禁，与治理接线无关）
    outputRoot = path.join(dataRoot, 'standard-gov');
    try {
    seedGovernanceCorpus();
    unselectedTokens = [];
    const config = makeConfig();
    const script1: E2eScript = { mode: 'declareGovernance', planSubmit: true, prompts: [] };
    const first = makeHarness(config, script1);
    const dto1 = await first.service.createBuild(store as never, { mode: 'full', confirm: 'BUILD' });
    const row1 = await waitForTerminal(first.service, dto1.id);
    expect(String(row1.status), String(row1.error_message)).toBe('published');
    await first.close();
    const release1 = String(row1.release_id);
    // 构建启动即冻结（空决定集也有快照文件与哈希）
    const freeze1 = JSON.parse(fs.readFileSync(path.join(outputRoot, '.staging', dto1.id, 'governance-freeze.json'), 'utf8')) as { snapshotHash: string };
    expect(typeof freeze1.snapshotHash).toBe('string');

    // 人工决定：批准对象（desktop 人工通道语义；测试直接调服务）
    const knowledge1 = new KbVersionStore(outputRoot).readKnowledgeManifest(release1)!;
    const alpha = knowledge1.objects[0]!;
    const governance = new KnowledgeGovernanceService({ outputRoot });
    const { decision } = governance.recordDecision({
      objectId: alpha.objectId, payloadHash: alpha.payloadHash, scopeKey: alpha.scopeKey,
      businessStatus: 'approved', rationale: '主上批准该规则投入 operational 使用', expectedRevision: 0,
    });

    // 决定驱动的增量（源无变化）：不得 no_changes 溜走，必须发布才生效
    const script2: E2eScript = { mode: 'declareGovernance', planSubmit: true, prompts: [] };
    const second = makeHarness(config, script2);
    const dto2 = await second.service.createBuild(store as never, { mode: 'incremental', confirm: 'BUILD' });
    const row2 = await waitForTerminal(second.service, dto2.id);
    expect(String(row2.status), String(row2.error_message)).toBe('published');
    expect(String(row2.release_id)).not.toBe(release1);
    // 进度端点可见决定快照哈希
    const progress = second.service.orchestrationProgress(store as never, dto2.id);
    expect(typeof progress!.spec.governanceSnapshotHash).toBe('string');
    await second.close();

    const release2 = String(row2.release_id);
    const knowledge2 = new KbVersionStore(outputRoot).readKnowledgeManifest(release2)!;
    // 决定生效点=本次成功发布：approved 由决定驱动写入 knowledge.json（重声明默认 unknown）
    expect(knowledge2.objects.find((object) => object.objectId === alpha.objectId)!.businessStatus).toBe('approved');
    // governance.json 含真实决定条目（绑定发布对象 payloadHash）
    const governanceFile = JSON.parse(fs.readFileSync(path.join(outputRoot, 'releases', release2, 'governance.json'), 'utf8')) as {
      decisions: Array<{ decisionId: string; objectId: string; businessStatus: string }>;
    };
    expect(governanceFile.decisions).toHaveLength(1);
    expect(governanceFile.decisions[0]).toMatchObject({ decisionId: decision.decisionId, objectId: alpha.objectId, businessStatus: 'approved' });

    // ---- 构建期间决定变化 → kb_governance_changed 失败可恢复 → 重取后发布 ----
    writeRaw('治理/规则源.md', `${fs.readFileSync(path.join(kbRoot, '治理/规则源.md'), 'utf8')}\n追加一行：备注补充（对象区间外）。`);
    const script3: E2eScript = { mode: 'declareGovernance', planSubmit: true, prompts: [], hangFinalReview: true };
    const third = makeHarness(config, script3);
    const dto3 = await third.service.createBuild(store as never, { mode: 'incremental', confirm: 'BUILD' });
    await waitPrompt(script3, '【最终复核】');
    // 构建期间登记人工复核 → 决定集哈希变化（快照任何追加都改变 snapshotHash）
    governance.recordHumanReview({ objectId: alpha.objectId, reviewSubjectHash: alpha.reviewSubjectHash, reviewerId: '主上', passed: true });
    script3.releaseFinalReview?.();
    const failed = await waitForTerminal(third.service, dto3.id);
    expect(String(failed.status)).toBe('failed');
    expect(String(failed.error_code)).toBe('kb_governance_changed');
    expect(String(failed.error_message)).toContain('重取');
    // CURRENT 不动（仍指向 release2）
    expect(JSON.parse(fs.readFileSync(path.join(outputRoot, 'CURRENT.json'), 'utf8')).releaseId).toBe(release2);
    await third.close();

    // 恢复：重取快照后继续发布（A 案 §4.2「期间改变则失败重取」）
    const script4: E2eScript = { mode: 'declareGovernance', planSubmit: true, prompts: [] };
    const resumed = makeHarness(config, script4);
    const resumeDto = await resumed.service.resumeBuild(store as never, dto3.id, 'RESUME');
    expect(['queued', 'preflight', 'running']).toContain(resumeDto.status);
    const row4 = await waitForTerminal(resumed.service, dto3.id);
    expect(String(row4.status), `${String(row4.error_code)} ${String(row4.error_message)}`).toBe('published');
    await resumed.close();
    // 重取后的冻结快照与当前决定集一致
    const freezeAfter = JSON.parse(fs.readFileSync(path.join(outputRoot, '.staging', dto3.id, 'governance-freeze.json'), 'utf8')) as { snapshotHash: string };
    expect(freezeAfter.snapshotHash).toBe(new KnowledgeGovernanceService({ outputRoot }).snapshotForBuild().snapshotHash);
    const release4 = String(row4.release_id);
    const governanceFile4 = JSON.parse(fs.readFileSync(path.join(outputRoot, 'releases', release4, 'governance.json'), 'utf8')) as {
      decisions: Array<{ decisionId: string }>;
    };
    expect(governanceFile4.decisions.map((entry) => entry.decisionId)).toEqual([decision.decisionId]);
    } finally {
      outputRoot = path.join(dataRoot, 'standard-kb');
    }
  });
});
