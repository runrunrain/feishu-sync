/**
 * KbBuildService — 标准库构建流水线（设计 §6.5）
 *
 * queued → preflight → running → validating → publishing → published
 *                     ↘            ↘             ↘            ↘
 *                      failed / cancelled / interrupted（不移动 CURRENT）
 *
 * 不变量：CURRENT.json 只在校验全部通过后通过 rename 更新；任何失败/取消
 * 不发布半成品。原始库全链路只读。构建事件持久化到
 * <outputRoot>/.builds/<buildId>/events.jsonl，进程内同时广播供 SSE。
 */

import crypto from 'node:crypto';
import type { AppPluginStore, AppPluginSnapshot } from '../agent/app-plugin-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentProcessPool, AgentBusyError, type PoolSlot } from '../agent/agent-process-pool.js';
import { AgentToolService, ToolError, validateStdDocPath, type BuildRunState } from '../agent/agent-tool-service.js';
import type { KnowledgeDraftFile, OrganizationPlanFile } from '../agent/agent-tool-service.js';
import type { VisionDescriberLike } from '../agent/agent-tool-service.js';
import { isPathInside, PathGuardError, resolveInside } from '../agent/path-guard.js';
import { buildPiProcessEnv, PiRpcProcess } from '../agent/pi-rpc-process.js';
import { PiRuntimeResolver, resolveAppLlmModel } from '../agent/runtime-resolver.js';
import { buildAppLlmRunConfig, buildFrozenRoleRunConfig } from '../agent/provider-descriptor.js';
import { createClaudeProcess } from '../agent/claude-process-factory.js';
import { RawSourceSnapshot, collectSourceCandidates, computeSourceHash } from './raw-source-snapshot.js';
import { isReleaseInUse } from './publication-service.js';
import { StandardKbStore, parseStdHeader, stripStdHeader } from './standard-kb-store.js';
import { getKbQueryService } from './search/kb-query-service.js';
import { KbVersionStore, captureSourceContents, sourceChangePreview, sourceContentResourceSpans, type SourceContents } from './kb-version-store.js';
import { hasEditorialHistory, hasSourceMetadata } from './body-policy.js';
import { planUnits, packBatches, type BuildUnit } from './build-units.js';
import { countText } from './text-stats.js';
import { PathClaims } from './path-claims.js';
import { collectWhiteboardTextsForEntries, enrichEntriesWithMedia, hashImageFile, resolveSourceImages, verifyEntryMediaHash, verifyEntryWhiteboardTextHash } from './source-images.js';
import type { ImageDescription } from '../agent/vision/vision-describer.js';
import { VisionDescriber } from '../agent/vision/vision-describer.js';
import { buildDefaultAgentVisionConfig } from '../types/agent-knowledge.js';
import type { KbChangePreview, KbDocMerge, KbFileChange } from '../types/kb-version.js';
import { sourceVersionWarning } from './search/query-metadata.js';
import { selectKnowledgeSources } from './source-selection.js';
import { BuildCheckpointStore, type BuildCheckpoint } from './build-checkpoint.js';
import { BuildOrchestration, buildSpecFromConfig, computeSnapshotHash, nextAttemptTaskId, reviewPipelineActive } from './build-orchestration.js';
import {
  canPublish,
  computeCandidateHash,
  isIssueClosed,
  type BuildRole,
  type BuildRoleModelConfig,
  type BuildSpec,
  type BuildTask,
  type CandidateRelease,
  type CarriedOverEntry,
  type ResolvedRoleModel,
  type ReviewReport,
} from './orchestration-contracts.js';
import { contentResourceHash, verifyEvidence } from './evidence-locator.js';
import type { EvidenceReadReceipt, EvidenceResource } from './evidence-locator.js';
import {
  compileKnowledgeRelease,
  type CompilerDocInput,
  type CompilerEvidenceResource,
  type GovernanceFile,
  type KnowledgeCompileResult,
} from './knowledge-compiler.js';
import { runKnowledgeGates } from './knowledge-validator.js';
import type { ObjectMigration, ValidationIssue } from './knowledge-schema.js';
import type { KnowledgeManifest } from './knowledge-schema.js';
import { buildRoleLlmRunConfig } from '../agent/provider-descriptor.js';
import { resolveProviderModel, providerModelParameters } from '../modules/model-selection.js';
import { readAgentPromptFile } from '../agent/agent-assets.js';
import {
  KB_MANIFEST_SCHEMA_V2,
  resolveBuildConcurrency,
  toolsForRunKind,
  type AgentStatusDto,
  type KbBuildDto,
  type KbBuildImagesProgress,
  type KbBuildProgressDto,
  type KbBuildReportIssue,
  type KbBuildUnitsProgress,
  type KbBuildWorkerProgress,
  type KbBuildOrchestrationDto,
  type KbBuildOrchestrationTaskDto,
  type KbCurrentPointer,
  type KbManifest,
  type KbManifestDoc,
  type KbOrganizationManifestSection,
  type RawSourceSnapshotEntry,
} from '../types/agent-knowledge.js';
import type { Config } from '../types/index.js';

export interface KbBuildDeps {
  dataRoot: string;
  pool: AgentProcessPool;
  toolService: AgentToolService;
  resolver: PiRuntimeResolver;
  configProvider: () => Config | null;
  documentsProvider: () => import('../types/index.js').DocumentRecord[];
  sheetCsvPaths: (objToken: string) => string[];
  excludedSourcesProvider?: () => string[];
  /** 完整重建时未勾选的源；增量更新保留未被明确移除的已发布来源。 */
  unselectedSourcesProvider?: () => string[];
  /** P1-S8（设计 P1 §4.1 防线 2）：已发布云文档 token 集（快照排除面）。 */
  publishedTokensProvider?: () => string[];
  internalBaseUrl: () => string;
  extensionPath: () => string | null;
  promptAssets: () => { buildRules: string; styleGuide: string } | null;
  /** T2b（B 案 §3）：审查规则提示词（standard-kb-review.md）；缺省读内置资产 */
  reviewPrompt?: () => string | null;
  pluginStore?: AppPluginStore;
  /** S3：图片描述器（preflight 预描述）。未注入时按 deps 自建（读 config） */
  visionDescriber?: VisionDescriberLike;
  /** S4：测试接缝——替换 PiRpcProcess 构造（假 pi 双 worker 回归用） */
  processFactory?: (options: ConstructorParameters<typeof PiRpcProcess>[0]) => PiRpcProcess;
}

interface WorkerRuntime {
  workerId: string;
  poolKey: string;
  slot: PoolSlot | null;
  rpc: PiRpcProcess | null;
  token: string | null;
  /** 当前进程的运行上下文（unitId/phase 随拉取单元/收尾轮更新） */
  context: import('../agent/agent-tool-service.js').InternalRunContext | null;
  state: KbBuildWorkerProgress['state'];
  unitId: string | null;
  unitBatchIndex: number;
  unitBatchTotal: number;
  exited: boolean;
  /** T2b：编排任务的运行轮次（write/review/integrate/final_review；
   * 缺省按旧规则派生——final workerId=收尾轮，其余=unit） */
  phase?: 'unit' | 'final' | 'plan' | 'review';
}

interface InMemoryBuild {
  id: string;
  /** 基座在创建构建时固定，设置变更只影响之后的新构建。 */
  backend?: 'pi' | 'claude-code';
  /** 本次所选源文档的图片是否强制重新识别。 */
  refreshImages: boolean;
  /** 沿用当前标准库，并强制重建当前勾选的源。 */
  rebuildSelected: boolean;
  imageRefreshFailures: number;
  batchIndex: number;
  batchTotal: number;
  buildState: BuildRunState | null;
  cancelRequested: boolean;
  /** S4：取消句柄集（abort 全部 worker 进程 + 排队 acquire） */
  cancelController: AbortController | null;
  timedOut: boolean;
  /** S4：全部 worker 进程（含收尾轮复用/新拉）；key=workerId */
  workers: Map<string, WorkerRuntime>;
  stage: KbBuildProgressDto['stage'];
  units: KbBuildUnitsProgress;
  images: KbBuildImagesProgress;
  process: PiRpcProcess | null;
  events: Array<{ seq: number; event: string; data: unknown }>;
  nextSeq: number;
  requestedMode: 'full' | 'incremental';
  baseReleaseId: string | null;
  resume?: BuildCheckpoint;
  /** T2a（B 案 §8）：编排骨架（新构建冻结；旧检查点恢复时无此字段） */
  orchestration?: BuildOrchestration;
  singleBatches: string[][];
  singleCompleted: number;
  unitProgress: Map<string, number>;
  workerCount: number;
  wordBudget: number;
  checkpointReady: boolean;
}

export class KbBuildService extends EventEmitter {
  private readonly deps: KbBuildDeps;
  private readonly active = new Map<string, InMemoryBuild>();
  private running = false;
  /** S3：未注入 visionDescriber 时的懒建默认实例 */
  private defaultDescriber?: VisionDescriberLike;

  constructor(deps: KbBuildDeps) {
    super();
    this.deps = deps;
  }

  private newEntry(id: string, backend: 'pi' | 'claude-code', mode: 'full' | 'incremental', rebuildSelected = false, refreshImages = false): InMemoryBuild {
    return { id, backend, requestedMode: mode, rebuildSelected, refreshImages, imageRefreshFailures: 0,
      batchIndex: 0, batchTotal: 0, buildState: null, cancelRequested: false, cancelController: null, timedOut: false,
      workers: new Map(), stage: null, units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 },
      images: { total: 0, described: 0, cached: 0, unavailable: 0 }, process: null, events: [], nextSeq: 1,
      baseReleaseId: null, singleBatches: [], singleCompleted: 0, unitProgress: new Map(), workerCount: 1, wordBudget: 0, checkpointReady: false };
  }

  private persistCheckpoint(buildId: string): void {
    const entry = this.active.get(buildId); const state = entry?.buildState;
    if (!entry?.checkpointReady || !state) return;
    const units = state.units ?? [];
    const unitDone = [...(state.unitDone ?? [])].filter(([id]) => {
      const unit = units.find((candidate) => candidate.id === id);
      return unit && (entry.unitProgress.get(id) ?? 0) >= unit.batches.length;
    });
    const batchesDone = units.length ? unitDone.length === units.length : entry.singleCompleted >= entry.singleBatches.length;
    try {
      new BuildCheckpointStore(this.outputRoot()).save({ schemaVersion: 1, buildId, knowledgeBaseRoot: state.knowledgeBaseRoot,
        baseReleaseId: entry.baseReleaseId, requestedMode: entry.requestedMode, mode: state.mode, backend: entry.backend ?? 'pi', rebuildSelected: entry.rebuildSelected,
        snapshot: state.snapshot.entries, workset: [...state.workset], docMeta: [...(state.docMeta ?? [])], writtenPaths: [...(state.writtenPaths ?? [])],
        preservedDocs: [...(state.preservedDocs ?? [])], requiredRewrites: [...(state.requiredRewrites ?? [])], baseDocPaths: [...(state.baseDocPaths ?? [])],
        finishInfo: batchesDone ? state.finishInfo : null, imageDescriptions: [...(state.imageDescriptions ?? [])].map(([token, values]) => [token, [...values]]),
        units, unitDone, claims: units.flatMap((unit) => (state.claims?.ownedBy(unit.id) ?? []).map((docPath) => ({ path: docPath, unitId: unit.id }))),
        singleBatches: entry.singleBatches, singleCompleted: entry.singleCompleted,
        unitProgress: units.map((unit) => [unit.id, entry.unitProgress.get(unit.id) ?? 0]),
        workerCount: entry.workerCount, wordBudget: entry.wordBudget, progress: this.progressOf(entry), updatedAt: new Date().toISOString(),
        orchestration: entry.orchestration?.serialize(),
      }, state.stagingRoot);
    } catch (error) {
      const message = `无法保存构建检查点：${error instanceof Error ? error.message : String(error)}`;
      state.poisoned = { code: 'kb_checkpoint_failed', message };
      throw new ToolError('kb_checkpoint_failed', message, 500);
    }
  }

  private configForBuild(buildId: string): Config {
    const current = this.deps.configProvider();
    if (!current) throw new ToolError('invalid_request', '配置不可用');
    const backend = this.active.get(buildId)?.backend;
    return backend ? { ...current, agent: { ...current.agent, runtime: { ...current.agent.runtime, backend } } } : current;
  }

  private resumeValidationFeedback(entry: InMemoryBuild): string[] {
    if (!entry.resume) return [];
    const prefix = '这是断点继续。请先用 draft_list/draft_read 检查已恢复草稿，再完成收尾。';
    try {
      const report = JSON.parse(fs.readFileSync(path.join(this.buildsRoot(this.outputRoot()), entry.id, 'report.json'), 'utf8'));
      const issues = Array.isArray(report.issues) ? report.issues.slice(0, 50) : [];
      return [prefix, ...(issues.length ? ['上次校验未通过，请修复以下问题后重新调用 kb_finish：', JSON.stringify(issues).slice(0, 16000)] : [])];
    } catch { return [prefix]; }
  }

  private finishCoverage(state: BuildRunState): string[] {
    const covered = new Set([...(state.docMeta?.values() ?? [])].flatMap((doc) => doc.sources));
    const uncovered = [...state.workset.keys()].filter((token) => !covered.has(token));
    return [
      `完整工作集有 ${state.workset.size} 个源，当前草稿尚未引用其中 ${uncovered.length} 个源。收尾须核对整个工作集，不能仅根据最后一批填写 skipped。`,
      ...(uncovered.length ? ['尚未覆盖的源（有内容则补建，否则在 skipped 明确说明理由）：', ...uncovered.slice(0, 300).map((token) => `- ${token}`)] : []),
    ];
  }

  // ------------------------------------------------------------------
  // 目录布局
  // ------------------------------------------------------------------

  private sourceDocuments(published: Iterable<string> = []) {
    const excluded = this.deps.excludedSourcesProvider?.() ?? [];
    return selectKnowledgeSources(this.deps.documentsProvider(), {
      unselected: this.deps.unselectedSourcesProvider?.() ?? excluded,
      excluded,
      published,
    });
  }

  private outputRoot(): string {
    return this.deps.configProvider()?.standardKb.outputRoot ?? '';
  }

  private stagingRoot(outputRoot: string, buildId: string): string {
    return path.join(outputRoot, '.staging', buildId);
  }

  private buildsRoot(outputRoot: string): string {
    return path.join(outputRoot, '.builds');
  }

  // ------------------------------------------------------------------
  // 事件
  // ------------------------------------------------------------------

  private emitBuild(buildId: string, event: string, data: unknown): void {
    const entry = this.active.get(buildId);
    const seq = entry ? entry.nextSeq++ : 1;
    const record = { seq, event, data };
    if (entry) {
      entry.events.push(record);
      if (entry.events.length > 1000) entry.events.splice(0, entry.events.length - 1000);
    }
    // 持久化事件日志（先建目录——appendFileSync 不会自建父目录）
    try {
      const buildsRoot = this.buildsRoot(this.outputRoot());
      const buildDir = path.join(buildsRoot, buildId);
      fs.mkdirSync(buildDir, { recursive: true });
      fs.appendFileSync(
        path.join(buildDir, 'events.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
      );
    } catch {
      /* 事件日志失败不阻断构建 */
    }
    this.emit('sse', { buildId, event, data });
  }

  private emitLog(buildId: string, level: 'info' | 'warn' | 'error', message: string): void {
    this.emitBuild(buildId, 'build_log', { level, message, at: new Date().toISOString() });
  }

  // ------------------------------------------------------------------
  // DTO
  // ------------------------------------------------------------------

  private static readonly EMPTY_IMAGES: KbBuildImagesProgress = { total: 0, described: 0, cached: 0, unavailable: 0 };

  private progressOf(entry?: InMemoryBuild): KbBuildProgressDto {
    if (!entry) {
      return {
        batchIndex: 0,
        batchTotal: 0,
        stage: null,
        units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 },
        workers: [],
        images: { ...KbBuildService.EMPTY_IMAGES },
      };
    }
    return {
      batchIndex: entry.batchIndex,
      batchTotal: entry.batchTotal,
      stage: entry.stage,
      units: { ...entry.units },
      workers: [...entry.workers.values()].map((worker) => ({
        workerId: worker.workerId,
        state: worker.state,
        unitId: worker.unitId,
        unitBatchIndex: worker.unitBatchIndex,
        unitBatchTotal: worker.unitBatchTotal,
      })),
      images: { ...entry.images },
    };
  }

  private static parseWarnings(value: unknown): KbBuildDto['warnings'] {
    if (typeof value !== 'string' || !value) return [];
    try {
      const parsed = JSON.parse(value) as KbBuildDto['warnings'];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  toDto(row: Record<string, unknown>, entry?: InMemoryBuild): KbBuildDto {
    entry ??= this.active.get(String(row.id));
    const recoverable = ['interrupted', 'failed', 'cancelled'].includes(String(row.status));
    const checkpoint = recoverable ? new BuildCheckpointStore(this.outputRoot()).summary(String(row.id)) : null;
    const config = this.deps.configProvider();
    const stale = checkpoint && ((new StandardKbStore(this.outputRoot()).readCurrent()?.releaseId ?? null) !== checkpoint.baseReleaseId
      || path.resolve(config?.knowledgeBaseRoot ?? '') !== path.resolve(checkpoint.knowledgeBaseRoot));
    return {
      id: String(row.id),
      ...(entry ? { eventSeq: entry.nextSeq - 1 } : {}),
      mode: row.mode as KbBuildDto['mode'],
      status: row.status as KbBuildDto['status'],
      noChanges: row.no_changes === 1,
      baseReleaseId: row.base_release_id ? String(row.base_release_id) : null,
      releaseId: row.release_id ? String(row.release_id) : null,
      model: row.model ? String(row.model) : null,
      counts: {
        sourceTotal: Number(row.source_total ?? 0),
        added: Number(row.source_added ?? 0),
        changed: Number(row.source_changed ?? 0),
        removed: Number(row.source_removed ?? 0),
        docsWritten: Number(row.docs_written ?? 0),
        docsDeleted: Number(row.docs_deleted ?? 0),
      },
      progress: entry ? this.progressOf(entry) : checkpoint?.progress ? { ...checkpoint.progress, workers: [], units: { ...checkpoint.progress.units, running: 0 } } : this.progressOf(),
      ...(recoverable ? { recovery: { canResume: !!checkpoint && !stale,
        reason: !checkpoint ? '本次构建没有可验证的检查点；重新构建可复用已有图片缓存。' : stale ? '原始库目录或标准库基准版本已变化，请在当前版本上重新构建。' : null,
        checkpointAt: checkpoint?.checkpointAt ?? null, draftCount: checkpoint?.draftCount ?? 0,
        completedBatches: checkpoint?.completedBatches ?? 0, totalBatches: checkpoint?.totalBatches ?? 0 } } : {}),
      parallelism: Number(row.parallelism ?? 1),
      warnings: KbBuildService.parseWarnings(row.warnings_json),
      error: row.error_code
        ? { code: String(row.error_code), message: String(row.error_message ?? '') }
        : null,
      createdAt: String(row.created_at),
      startedAt: row.started_at ? String(row.started_at) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null,
    };
  }

  hasActiveRun(): boolean { return this.running; }

  activeBuild(localMapStore: { getActiveKbBuild(): Record<string, unknown> | null }): KbBuildDto | null {
    const row = localMapStore.getActiveKbBuild();
    if (!row) return null;
    return this.toDto(row, this.active.get(String(row.id)));
  }

  eventsSince(buildId: string, lastSeq: number | null): Array<{ seq: number; event: string; data: unknown }> {
    const entry = this.active.get(buildId);
    if (!entry) return this.readStoredEvents(buildId).filter((event) => lastSeq === null || event.seq > lastSeq);
    if (lastSeq === null) return entry.events;
    return entry.events.filter((record) => record.seq > lastSeq);
  }

  private readStoredEvents(buildId: string): Array<{ seq: number; event: string; data: unknown }> {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(buildId)) return [];
    try {
      const file = path.join(this.buildsRoot(this.outputRoot()), buildId, 'events.jsonl');
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size; const start = Math.max(0, size - 2 * 1024 * 1024);
        const bytes = Buffer.alloc(size - start); fs.readSync(fd, bytes, 0, bytes.length, start);
        const lines = bytes.toString('utf8').split('\n'); if (start) lines.shift();
        return lines.flatMap((line) => { try { const value = JSON.parse(line); return Number.isSafeInteger(value.seq) && typeof value.event === 'string' ? [{ seq: value.seq as number, event: value.event as string, data: value.data as unknown }] : []; } catch { return []; } }).slice(-1000);
      } finally { fs.closeSync(fd); }
    } catch { return []; }
  }

  // ------------------------------------------------------------------
  // 创建构建
  // ------------------------------------------------------------------

  async createBuild(
    localMapStore: Parameters<KbBuildService['toDto']>[0] extends never ? never : {
      createKbBuild(input: { id: string; mode: 'incremental' | 'full'; status: string; baseReleaseId: string | null; model: string | null; createdAt: string }): void;
      getActiveKbBuild(): Record<string, unknown> | null;
      updateKbBuild(id: string, patch: Record<string, unknown>): void;
    },
    input: { mode?: string; confirm?: string; refreshImages?: boolean; rebuildSelected?: boolean },
  ): Promise<KbBuildDto> {
    const config = this.deps.configProvider();
    if (!config) throw new ToolError('invalid_request', '配置不可用');
    if (input.confirm !== 'BUILD') {
      throw new ToolError('confirmation_required', '构建需要 confirm: "BUILD"');
    }
    if (input.mode !== 'incremental' && input.mode !== 'full') {
      throw new ToolError('invalid_request', "mode 必须是 'incremental' 或 'full'");
    }
    if (input.refreshImages !== undefined && typeof input.refreshImages !== 'boolean') {
      throw new ToolError('invalid_request', 'refreshImages 必须是布尔值');
    }
    if (input.rebuildSelected !== undefined && typeof input.rebuildSelected !== 'boolean') {
      throw new ToolError('invalid_request', 'rebuildSelected 必须是布尔值');
    }
    if (input.rebuildSelected && input.mode !== 'incremental') {
      throw new ToolError('invalid_request', '构建所选文档须在现有标准库基础上继续构建');
    }
    if (input.refreshImages && input.mode !== 'full' && !input.rebuildSelected) {
      throw new ToolError('invalid_request', '重新生成图片描述仅支持构建所选文档');
    }
    if (this.running || localMapStore.getActiveKbBuild()) {
      throw new ToolError('kb_build_running', '已有构建正在进行', 409);
    }

    // 就绪检查（不消耗额度）
    const status = await this.deps.resolver.checkReadiness({
      agentConfig: config.agent,
      llmConfig: config.llm,
      runningProcesses: this.deps.pool.runningCount(),
    });
    if (status.code !== 'ready') {
      const error = new ToolError('agent_not_ready', `Agent 未就绪：${status.message}`, 503);
      (error as ToolError & { details?: unknown }).details = { code: status.code };
      throw error;
    }
    if (this.running || localMapStore.getActiveKbBuild()) throw new ToolError('kb_build_running', '已有构建正在进行', 409);

    // outputRoot 校验
    const outputRoot = config.standardKb.outputRoot;
    validateOutputRoot(outputRoot, {
      knowledgeBaseRoot: config.knowledgeBaseRoot,
      dataRoot: this.deps.dataRoot,
    });

    const model = status.model.model;
    const basePointer = new StandardKbStore(outputRoot).readCurrent();
    const buildId = `b_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
    localMapStore.createKbBuild({
      id: buildId,
      mode: input.mode,
      status: 'queued',
      baseReleaseId: basePointer?.releaseId ?? null,
      model,
      createdAt: new Date().toISOString(),
    });
    this.active.set(buildId, this.newEntry(buildId, config.agent.runtime.backend === 'claude-code' ? 'claude-code' : 'pi', input.mode, input.rebuildSelected === true, input.refreshImages === true));

    // 异步执行
    void this.runPipeline(localMapStore as never, buildId, input.mode).catch((error) => {
      console.error('[KbBuildService] pipeline crashed:', error);
    });

    const row = localMapStore.getActiveKbBuild();
    return this.toDto(row ?? { id: buildId, mode: input.mode, status: 'queued', created_at: new Date().toISOString() }, this.active.get(buildId));
  }

  async resumeBuild(localMapStore: Parameters<KbBuildService['createBuild']>[0] & { getKbBuild(id: string): Record<string, unknown> | null }, buildId: string, confirm?: string): Promise<KbBuildDto> {
    if (confirm !== 'RESUME') throw new ToolError('confirmation_required', '继续构建需要 confirm: "RESUME"');
    if (this.running || localMapStore.getActiveKbBuild()) throw new ToolError('kb_build_running', '已有构建正在进行', 409);
    const row = localMapStore.getKbBuild(buildId);
    if (!row) throw new ToolError('build_not_found', '构建记录不存在', 404);
    if (!['interrupted', 'failed', 'cancelled'].includes(String(row.status))) throw new ToolError('kb_resume_unavailable', '该构建无需恢复', 409);
    const config = this.deps.configProvider(); if (!config) throw new ToolError('invalid_request', '配置不可用');
    let checkpoint: BuildCheckpoint | null;
    try { checkpoint = new BuildCheckpointStore(config.standardKb.outputRoot).read(buildId); }
    catch (error) { throw new ToolError('kb_resume_unavailable', error instanceof Error ? error.message : '检查点无法读取', 409); }
    if (!checkpoint) throw new ToolError('kb_resume_unavailable', '本次构建没有可验证的检查点；重新构建可复用已有图片缓存。', 409);
    if (row.error_code === 'kb_validation_failed' && checkpoint.finishInfo
      // T2b：编排流水构建保留 finishInfo——恢复时全部任务已终态，直接
      // 重跑确定性校验（草稿可手工修复后重试），不重演整合轮
      && !reviewPipelineActive(checkpoint.orchestration?.spec)) checkpoint = { ...checkpoint, finishInfo: null };
    if (path.resolve(config.knowledgeBaseRoot) !== path.resolve(checkpoint.knowledgeBaseRoot)) throw new ToolError('kb_resume_stale', '原始库目录已切换，请重新构建', 409);
    // diting F05：恢复前同步校验冻结模型与当前配置解析一致（异步流水内另
    // 有一道同型复核）——不一致 → 409 待处理明示，不静默换模型。
    if (checkpoint.orchestration) {
      try {
        const restoredSpec = BuildOrchestration.restore(checkpoint.orchestration).spec;
        const roleMismatches = this.frozenRoleMismatches(config, restoredSpec);
        if (roleMismatches.length > 0) {
          throw new Error(`冻结模型与当前配置不一致：${roleMismatches.join('；')}`);
        }
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError('kb_resume_stale', `检查点编排规格无法恢复：${error instanceof Error ? error.message : String(error)}`, 409);
      }
    }
    if ((new StandardKbStore(config.standardKb.outputRoot).readCurrent()?.releaseId ?? null) !== checkpoint.baseReleaseId) throw new ToolError('kb_resume_stale', '标准库已发布了其他版本，请在当前版本上重新构建', 409);
    const snapshot = RawSourceSnapshot.fromEntries(checkpoint.snapshot, { sheetCsvPaths: this.deps.sheetCsvPaths });
    const excluded = new Set([...(this.deps.excludedSourcesProvider?.() ?? []), ...(this.deps.publishedTokensProvider?.() ?? [])]);
    try {
      verifySnapshotIntact(snapshot, config.knowledgeBaseRoot, this.deps.sheetCsvPaths, this.deps.documentsProvider().filter((doc) => !excluded.has(doc.objToken)));
    } catch (error) {
      throw new ToolError('source_changed_during_build', error instanceof Error ? error.message : '恢复前发现源文档已变化，请重新构建', 409);
    }
    const ready = await this.deps.resolver.checkReadiness({ agentConfig: { ...config.agent, runtime: { ...config.agent.runtime, backend: checkpoint.backend } }, llmConfig: config.llm, runningProcesses: this.deps.pool.runningCount() });
    if (ready.code !== 'ready') throw new ToolError('agent_not_ready', `Agent 未就绪：${ready.message}`, 503);
    if (this.running || localMapStore.getActiveKbBuild()) throw new ToolError('kb_build_running', '已有构建正在进行', 409);
    const entry = this.newEntry(buildId, checkpoint.backend, checkpoint.requestedMode, checkpoint.rebuildSelected);
    entry.resume = checkpoint; entry.singleBatches = checkpoint.singleBatches; entry.singleCompleted = checkpoint.singleCompleted;
    entry.unitProgress = new Map(checkpoint.unitProgress); entry.events = this.readStoredEvents(buildId); entry.nextSeq = (entry.events.at(-1)?.seq ?? 0) + 1;
    this.active.set(buildId, entry);
    localMapStore.updateKbBuild(buildId, { status: 'queued', model: ready.model.model, errorCode: null, errorMessage: null, finishedAt: null });
    void this.runPipeline(localMapStore as never, buildId, checkpoint.requestedMode).catch((error) => console.error('[KbBuildService] resume failed:', error));
    return this.toDto(localMapStore.getKbBuild(buildId)!, entry);
  }

  async cancelBuild(
    localMapStore: { getKbBuild(id: string): Record<string, unknown> | null; updateKbBuild(id: string, patch: Record<string, unknown>): void },
    buildId: string,
  ): Promise<KbBuildDto | null> {
    const row = localMapStore.getKbBuild(buildId);
    if (!row) return null;
    const status = String(row.status);
    // T2b：awaiting_release（待确认发布）可取消——候选作废，CURRENT 不动
    if (!['queued', 'preflight', 'running', 'validating', 'publishing', 'awaiting_release'].includes(status)) {
      return this.toDto(row, this.active.get(buildId));
    }
    const entry = this.active.get(buildId);
    if (entry) {
      entry.cancelRequested = true;
      // S4：取消句柄集——排队中的 acquire 出队拒绝 + 全部 worker 进程 abort
      entry.cancelController?.abort();
      for (const worker of entry.workers.values()) {
        if (worker.rpc && !worker.rpc.isExited()) void worker.rpc.abort();
      }
      if (entry.process) {
        await entry.process.abort();
      }
    }
    // 终态由流水线循环落地；此处若流水线已不在（崩溃恢复场景）直接落 cancelled
    if (!this.running) {
      localMapStore.updateKbBuild(buildId, {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
      });
    }
    const updated = localMapStore.getKbBuild(buildId);
    return updated ? this.toDto(updated, this.active.get(buildId)) : null;
  }

  // ------------------------------------------------------------------
  // 流水线
  // ------------------------------------------------------------------

  private async runPipeline(
    localMapStore: {
      updateKbBuild(id: string, patch: Record<string, unknown>): void;
      getKbBuild(id: string): Record<string, unknown> | null;
    },
    buildId: string,
    mode: 'incremental' | 'full',
  ): Promise<void> {
    const entry = this.active.get(buildId)!;
    const resume = entry.resume;
    this.running = true;
    const config = this.configForBuild(buildId);
    const outputRoot = config.standardKb.outputRoot;
    const startedAt = new Date().toISOString();
    let stagingRootPath = this.stagingRoot(outputRoot, buildId);
    let currentStatus: string = 'preflight';

    const setStatus = (status: string, patch: Record<string, unknown> = {}) => {
      currentStatus = status;
      localMapStore.updateKbBuild(buildId, { status, ...patch });
      const row = localMapStore.getKbBuild(buildId);
      if (row) this.emitBuild(buildId, 'build_status', this.toDto(row, entry));
    };
    const failBuild = (code: string, message: string) => {
      localMapStore.updateKbBuild(buildId, {
        status: 'failed',
        errorCode: code,
        errorMessage: message.slice(0, 2000),
        finishedAt: new Date().toISOString(),
      });
      this.emitLog(buildId, 'error', `构建失败：${code}: ${message}`);
      const row = localMapStore.getKbBuild(buildId);
      if (row) this.emitBuild(buildId, 'build_status', this.toDto(row, entry));
      this.deps.toolService.revokeByBuild(buildId);
      if (entry.process) void entry.process.terminate();
      this.cleanupAfterPipeline(buildId);
    };

    try {
      // 本构建固定一份插件快照，后续修改只影响下次构建。
      const pluginSnapshot = this.deps.pluginStore?.snapshot('build', { includeNative: config.agent.runtime.backend !== 'claude-code' });
      // ============ preflight ============
      setStatus('preflight', { startedAt });
      entry.stage = 'snapshot';
      this.emitLog(buildId, 'info', `preflight：运行时就绪，开始生成原始源快照`);
      cleanupOldStaging(outputRoot);

      const store = new StandardKbStore(outputRoot);
      const basePointer: KbCurrentPointer | null = store.readCurrent();
      const baseManifest: KbManifest | null = basePointer ? store.readManifest(basePointer.releaseId) : null;
      if (resume && (basePointer?.releaseId ?? null) !== resume.baseReleaseId) throw new ToolError('kb_resume_stale', '标准库基准版本已变化，请重新构建', 409);
      entry.baseReleaseId = basePointer?.releaseId ?? null;
      const retainedSources = mode === 'incremental' ? baseManifest?.sourceSnapshot.map((source) => source.objToken) ?? [] : [];
      const excludedForResume = new Set(this.deps.excludedSourcesProvider?.() ?? []);
      const documents = resume ? this.deps.documentsProvider().filter((doc) => !excludedForResume.has(doc.objToken)) : this.sourceDocuments(retainedSources);
      // P1-S8（设计 P1 §4.1 防线 2）：发布产物不进构建快照——用户把已发布
      // 文档移进监听树时，同步会如实镜像，但构建必须排除（防自我喂养），
      // 并给构建警告 published_doc_in_sources。排除只作用于构建，不影响同步。
      const publishedTokens = new Set(this.deps.publishedTokensProvider?.() ?? []);
      let publishedExcludedCount = 0;
      if (publishedTokens.size > 0) {
        publishedExcludedCount = documents.filter((doc) => publishedTokens.has(doc.objToken)).length;
        if (publishedExcludedCount > 0) {
          this.emitLog(buildId, 'warn', `快照排除 ${publishedExcludedCount} 个已发布云文档（published_doc_in_sources：发布产物不得作为构建源）`);
        }
      }
      const snapshotResult = resume ? { entries: resume.snapshot, missingFiles: [] } : RawSourceSnapshot.scan(
        config.knowledgeBaseRoot,
        publishedExcludedCount > 0
          ? documents.filter((doc) => !publishedTokens.has(doc.objToken))
          : documents,
        this.deps.sheetCsvPaths,
      );
      // S3（§3.4）：为全部条目补充 mediaHash/imageCount（contentHash 公式不变）
      if (!resume) enrichEntriesWithMedia(config.knowledgeBaseRoot, snapshotResult.entries);
      const snapshot = RawSourceSnapshot.fromEntries(snapshotResult.entries, {
        knowledgeBaseRoot: config.knowledgeBaseRoot,
        sheetCsvPaths: this.deps.sheetCsvPaths,
      });
      if (resume) verifySnapshotIntact(snapshot, config.knowledgeBaseRoot, this.deps.sheetCsvPaths, documents.filter((doc) => !publishedTokens.has(doc.objToken)));
      // ---- T2a（B 案 §8）：冻结/恢复 BuildSpec ----
      // 新构建：从当前配置冻结（模型/规范版本/并发/预算/发布方式，后续修订
      // 可追溯不悄悄改）；恢复：只信检查点里的冻结规格——恢复时源快照或
      // 基准与规格不一致 → 拒绝恢复（B 案 §8「先核对再恢复」）。旧检查点
      // 无 orchestration 字段 → 按旧规则恢复，不升级成新式任务。
      if (resume?.orchestration) {
        try {
          const restored = BuildOrchestration.restore(resume.orchestration);
          if (restored.spec.sourceSnapshotHash !== computeSnapshotHash(snapshot.entries)
            || restored.spec.baseReleaseId !== entry.baseReleaseId) {
            throw new Error('冻结规格与当前快照/基准不一致');
          }
          // diting F05：冻结的实际模型参数与当前配置解析结果比对——不一致
          // → 拒绝恢复并明示（构建待处理，不静默换模型）。
          const roleMismatches = this.frozenRoleMismatches(config, restored.spec);
          if (roleMismatches.length > 0) {
            throw new Error(`冻结模型与当前配置不一致：${roleMismatches.join('；')}`);
          }
          entry.orchestration = restored;
        } catch (error) {
          throw new ToolError('kb_resume_stale', `检查点编排规格无法恢复：${error instanceof Error ? error.message : String(error)}`, 409);
        }
      } else if (!resume) {
        const promptAssets = this.deps.pluginStore ? null : this.deps.promptAssets();
        let specVersion = 'v1';
        if (promptAssets) {
          specVersion = `v1:${crypto.createHash('sha256').update(`${promptAssets.buildRules}\n${promptAssets.styleGuide}`).digest('hex').slice(0, 16)}`;
        }
        entry.orchestration = new BuildOrchestration(buildSpecFromConfig({
          buildId,
          snapshotEntries: snapshot.entries,
          baseReleaseId: entry.baseReleaseId,
          standardKb: config.standardKb,
          specVersion,
          // diting F05：启动时冻结各角色实际非密钥模型参数（specHash 覆盖；
          // 密钥不入记录，派发时动态取）
          resolveRoleModel: ({ config: roleConfig }) => this.describeRoleModel(config, roleConfig, specVersion),
        }));
        localMapStore.updateKbBuild(buildId, {
          rolesJson: JSON.stringify(entry.orchestration.spec.roles),
          orchestrationJson: JSON.stringify(entry.orchestration.summary()),
        });
      }
      this.emitLog(buildId, 'info', `快照完成：${snapshot.size} 个原始源（${snapshotResult.missingFiles.length} 个候选源文件缺失）`);
      for (const source of snapshot.entries) {
        const warning = sourceVersionWarning(source);
        if (warning) this.emitLog(buildId, 'warn', `${warning.code}：${source.title}；本地路径 ${source.relPath}。${warning.message}`);
      }

      // staging 准备
      stagingRootPath = this.stagingRoot(outputRoot, buildId);
      if (!isPathInside(path.resolve(outputRoot, '.staging'), path.resolve(stagingRootPath))) throw new ToolError('kb_resume_unavailable', '构建暂存目录越界', 409);
      if (!resume) fs.rmSync(stagingRootPath, { recursive: true, force: true });
      fs.mkdirSync(path.join(stagingRootPath, 'docs'), { recursive: true });
      if (resume) new BuildCheckpointStore(outputRoot).restore(buildId, stagingRootPath);
      fs.writeFileSync(
        path.join(stagingRootPath, 'raw-snapshot.json'),
        JSON.stringify(snapshot.entries, null, 2),
      );

      const versionStore = new KbVersionStore(outputRoot);
      const sourceContents = captureSourceContents(snapshot, config.knowledgeBaseRoot);
      const changePreview = sourceChangePreview(snapshot, sourceContents, baseManifest,
        versionStore.readSourceContents(baseManifest?.releaseId ?? null),
        new Set([...(this.deps.excludedSourcesProvider?.() ?? []), ...(mode === 'full' ? this.deps.unselectedSourcesProvider?.() ?? [] : [])]));
      let effectiveMode = mode;
      if (mode === 'incremental' && !baseManifest) {
        effectiveMode = 'full';
        this.emitLog(buildId, 'info', '无已发布版本，incremental 自动按 full 执行');
      }

      // S3：vision 就绪时变更判定含 mediaHash（双方均非空且不等才算变更，U4）
      const visionDescriber = this.resolveVisionDescriber();
      const visionStatus = await visionDescriber.status().catch(() => ({
        state: 'invalid' as const,
        model: null as string | null,
        message: '图片理解状态不可用',
      }));
      const visionReady = visionStatus.state === 'ready';
      // 变更集（§6.4：本地字节比较，云端状态变化不参与）
      const changeset = computeChangeset(snapshot.entries, baseManifest, { visionEnabled: visionReady });
      // F3-R07：full 工作集 = 快照全部源——重复 full / 部分变化 full 都必须
      // 重建全库（重复执行、只 finish 不得借 skip 发布空或局部库）；增量
      // 维持 added+changed。覆盖验证以 workset 为准，full 时即全量强制。
      const workset = new Map<string, 'added' | 'changed' | 'rebuild'>(resume?.workset ?? []);
      if (!resume && effectiveMode === 'full') {
        for (const source of snapshot.entries) workset.set(source.objToken, 'rebuild');
      } else if (!resume) {
        for (const token of changeset.added) workset.set(token, 'added');
        for (const token of changeset.changed) workset.set(token, 'changed');
      }
      if (entry.rebuildSelected && !resume) {
        const unselected = new Set(this.deps.unselectedSourcesProvider?.() ?? this.deps.excludedSourcesProvider?.() ?? []);
        const selected = snapshot.entries.filter((source) => !unselected.has(source.objToken));
        if (!selected.length) throw new ToolError('no_sources_selected', '没有可构建的所选源文档，请刷新源文档列表后重新选择。', 400);
        for (const source of selected) {
          if (!workset.has(source.objToken)) workset.set(source.objToken, 'rebuild');
        }
        this.emitLog(buildId, 'info', `继续构建：${selected.length} 个所选源，保留未受影响的现有标准文档`);
      }

      localMapStore.updateKbBuild(buildId, {
        sourceTotal: snapshot.size,
        sourceAdded: changeset.added.length,
        sourceChanged: changeset.changed.length,
        sourceRemoved: changeset.removed.length,
      });

      if (effectiveMode === 'incremental' && changeset.isEmpty() && workset.size === 0) {
        // 无变更：直接以 no_changes 结束（不新建 release）
        stagingRootPath = '';
        localMapStore.updateKbBuild(buildId, {
          status: 'published',
          noChanges: true,
          finishedAt: new Date().toISOString(),
        });
        this.emitLog(buildId, 'info', '变更集为空，构建以 no_changes 结束');
        const row = localMapStore.getKbBuild(buildId);
        if (row) this.emitBuild(buildId, 'build_status', this.toDto(row, entry));
        this.cleanupAfterPipeline(buildId);
        return;
      }

      // 增量：复制当前 release docs 到 staging，写 docId 继承映射；
      // 仅引用已删除源的文档默认删除（§6.4）。
      const docMeta = new Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>(resume?.docMeta ?? []);
      let docsDeletedByDefault = 0;
      if (!resume && effectiveMode === 'incremental' && baseManifest) {
        const baseReleaseDir = path.join(outputRoot, 'releases', baseManifest.releaseId);
        const removedSet = new Set(changeset.removed);
        const docIdMap: Record<string, string> = {};
        for (const doc of baseManifest.docs) {
          const onlyRemoved = doc.sources.length > 0 && doc.sources.every((token) => removedSet.has(token));
          if (onlyRemoved) {
            docsDeletedByDefault += 1;
            continue; // 默认删除；Agent 可经 kb_write_doc 重建
          }
          // 复制文件（release 内 docs/ 布局）
          const src = path.join(baseReleaseDir, 'docs', doc.path);
          const dest = path.join(stagingRootPath, 'docs', doc.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          docIdMap[doc.path] = doc.docId;
          docMeta.set(doc.path, { title: doc.title, summary: doc.summary, tags: doc.tags, sources: doc.sources });
        }
        fs.writeFileSync(path.join(stagingRootPath, '.docid-map.json'), JSON.stringify(docIdMap, null, 2));
        if (docsDeletedByDefault > 0) {
          this.emitLog(buildId, 'info', `${docsDeletedByDefault} 篇文档仅引用已删除源，默认删除（Agent 可重建）`);
          localMapStore.updateKbBuild(buildId, { docsDeleted: docsDeletedByDefault });
        }
      }
      // diting F06（A 案 §7.2/§10.2）：基线组织登记参与增量与 full 初始化
      // ——从已校验基线 knowledge.json 装载对象/证据/迁移/有效审查登记进
      // 工具注册表：未变对象不重声明（clientKey→objectId 身份经同族三元组
      // 命中保留）；已纳管文档被旧式参数重写由工具拒绝 + 发布前 carriedHash
      // 复核（不允许静默降 v1）。
      if (!resume && baseManifest) {
        const baselineKnowledge = new KbVersionStore(outputRoot).readKnowledgeManifest(baseManifest.releaseId);
        if (baselineKnowledge && baselineKnowledge.objects.length > 0) {
          const seeded = this.seedBaselineKnowledge(buildId, stagingRootPath, baselineKnowledge, snapshot, config.knowledgeBaseRoot);
          if (seeded > 0) {
            this.emitLog(buildId, 'info', `基线组织登记已装载：${seeded} 个对象进入工具注册表（身份与有效审查保留，未变对象不重声明；diting F06/A 案 §7.2）`);
          }
        }
      }

      // ============ running ============
      entry.buildState = {
        knowledgeBaseRoot: config.knowledgeBaseRoot,
        snapshot,
        mode: effectiveMode,
        workset,
        stagingRoot: stagingRootPath,
        finishInfo: resume?.finishInfo ?? null,
        writtenPaths: new Set(resume?.writtenPaths ?? []),
        baseDocPaths: new Set(resume?.baseDocPaths ?? baseManifest?.docs.map((doc) => doc.path) ?? []),
      };
      // 局部引用：TS 收窄 + 后续批次/finish/校验统一用它（避免可空回读）
      const buildState: BuildRunState = entry.buildState;
      // kb_write_doc 写入时同步 docMeta（通过 onEvent 钩子后校验阶段重建也可），
      // 校验阶段以解析 staging 文件头为准，meta 仅作标题/摘要补充源。
      this.patchBuildStateMeta(buildState, docMeta);
      buildState.onCheckpoint = () => this.persistCheckpoint(buildId);
      setStatus('running');

      const affectedDocs = effectiveMode === 'incremental' && baseManifest
        ? baseManifest.docs
            .filter((doc) => doc.sources.some((token) => workset.has(token) || changeset.removed.includes(token)))
            .map((doc) => ({ path: doc.path, title: doc.title }))
        : [];

      buildState.requiredRewrites = new Set(resume?.requiredRewrites ?? affectedDocs.map((doc) => doc.path)
        .filter((docPath) => fs.existsSync(path.join(stagingRootPath, 'docs', docPath))));
      if (resume) {
        buildState.preservedDocs = new Map(resume.preservedDocs);
      } else if (entry.rebuildSelected && baseManifest) {
        const affectedPaths = new Set(affectedDocs.map((doc) => doc.path));
        buildState.preservedDocs = new Map(baseManifest.docs.filter((doc) => !affectedPaths.has(doc.path))
          .map((doc) => [doc.path, doc.sources]));
      }

      // P0-S7（设计 §5.6 + 任务 4）：白板旁路文字预取——raw_read 可读任意
      // 快照源，全量预取一次（仅非空文字占内存）；describeWorksetImages 用
      // 它跳过已有文字的白板识图（省额度，svg/raw 同规则）。
      buildState.whiteboardTexts = collectWhiteboardTextsForEntries(config.knowledgeBaseRoot, snapshot.entries);

      // ---- S3（§3.4）：preflight 图片预描述（stage=describing_images）----
      // 优先复用已有缓存；vision 未就绪时仅未缓存图片标记 unavailable。
      entry.stage = 'describing_images';
      const cancelController = new AbortController();
      entry.cancelController = cancelController;
      buildState.imageDescriptions = resume ? new Map(resume.imageDescriptions.map(([token, values]) => [token, new Map(values)])) : await this.describeWorksetImages({
        buildId,
        entry,
        snapshot,
        workset,
        describer: visionDescriber,
        visionReady,
        signal: cancelController.signal,
      });
      if (resume) { entry.images = resume.progress.images; this.emitLog(buildId, 'info', `已恢复检查点：${resume.writtenPaths.length} 份已写草稿，复用 ${entry.images.described + entry.images.cached} 个图片转化结果；从未完成部分继续。`); }
      if (entry.rebuildSelected && !resume) await this.includeRetainedImageCache(buildState, visionDescriber, cancelController.signal);
      buildState.visionReady = visionReady;
      if (entry.cancelRequested) throw new CancelledError();

      const buildWarnings: KbBuildDto['warnings'] = [];
      if (publishedExcludedCount > 0) {
        buildWarnings.push({
          code: 'published_doc_in_sources',
          count: publishedExcludedCount,
          message: `${publishedExcludedCount} 个已发布云文档出现在监听树内，已从本次构建快照排除（防自我喂养）；请在飞书侧把这些文档移出监听子树`,
        });
      }
      if (entry.images.total > 0 && entry.images.unavailable > 0) {
        const warning = {
          code: 'images_unavailable',
          count: entry.images.unavailable,
          message: `${entry.images.unavailable}/${entry.images.total} 张图片未理解（${visionReady ? '图片理解通道部分失败' : '图片理解未配置'}）；图片引用处已插入 unavailable 标记`,
        };
        buildWarnings.push(warning);
        this.emitLog(buildId, 'warn', warning.message);
      }
      if (entry.imageRefreshFailures > 0) {
        const warning = {
          code: 'images_refresh_incomplete',
          count: entry.imageRefreshFailures,
          message: `${entry.imageRefreshFailures} 张图片未能重新生成或保存，已有缓存已保留；请检查识图服务、图片大小、识图上限或本地存储。`,
        };
        buildWarnings.push(warning);
        this.emitLog(buildId, 'warn', warning.message);
      }
      localMapStore.updateKbBuild(buildId, {
        warningsJson: JSON.stringify(buildWarnings),
        visionModel: visionReady ? visionStatus.model : null,
      });

      // ---- S4（§4.1/§4.2）：单元划分 + worker 调度 ----
      const batchSize = Math.max(1, Math.min(50, config.standardKb.buildBatchSize));
      // P2-S2：每批有效字数预算（ConfigManager 归一后必有；未经归一的对象
      // 缺字段时按 0 = 旧行为处理，保证旧测试夹具字节级等价）
      const wordBudget = resume?.wordBudget ?? Math.max(0, Math.floor(config.standardKb.buildBatchWordBudget ?? 0));
      entry.wordBudget = wordBudget;
      const worksetMeta = new Map<string, { relPath: string; bytes: number; words: number }>();
      for (const [token] of workset) {
        const sourceEntry = snapshot.get(token);
        if (!sourceEntry) continue;
        const file = path.join(config.knowledgeBaseRoot, sourceEntry.relPath);
        let bytes = 0;
        try {
          bytes = fs.statSync(file).size;
        } catch {
          /* 缺失按 0 */
        }
        let words = 0;
        if (wordBudget > 0) {
          // P2-S2（§2.2）：有效字数 = 源正文 + 本次识图描述（unavailable 计 0）。
          // 预算关闭（0）时不读文件——旧行为字节级等价，也省去全量 IO。
          let content: string | null = null;
          try {
            content = fs.readFileSync(file, 'utf-8');
          } catch {
            /* 不可读按 0（与 bytes 同口径） */
          }
          words = effectiveWords({
            content,
            imageDescriptions: [...(buildState.imageDescriptions?.get(token) ?? new Map()).values()],
            whiteboardTexts: [...(buildState.whiteboardTexts?.get(token) ?? new Map()).values()],
          });
        }
        worksetMeta.set(token, { relPath: sourceEntry.relPath, bytes, words });
      }
      const wordsOf = (token: string): number => worksetMeta.get(token)?.words ?? 0;
      const units = resume?.units.length ? resume.units : planUnits({
        mode: effectiveMode,
        workset: worksetMeta,
        baseDocs: effectiveMode === 'incremental' && baseManifest
          ? baseManifest.docs.map((doc) => ({ path: doc.path, sources: doc.sources }))
          : [],
        baseDocTitles: new Map(baseManifest?.docs.map((doc) => [doc.path, doc.title]) ?? []),
        requiredRewrites: [...(buildState.requiredRewrites ?? [])],
        removedSources: changeset.removed,
        batchSize,
        wordBudget,
      });
      // S4 等价回退：单 worker（N=1 或仅 1 个单元）走既有
      // 单进程流水线（全局批切分 + kb_finish 单轮，不引入单元语义）——
      // 保证 N 缺省/为 1 时行为与现状等价（含
      // spawnBuildProcess 测试接缝与既有提示词序列）。
      // T2a（B 案 §6/R3）：构建容量 N = resolveBuildConcurrency
      // （buildConcurrency 优先回落 buildParallelism），同步进进程池 build
      // 通道；workerCount 不再被 maxConcurrentProcesses−M 截断——配置多少
      // 构建上限就是多少路。
      const buildConcurrency = resolveBuildConcurrency(config.standardKb);
      this.deps.pool.configure({ buildConcurrency });
      const workerCount = Math.max(1, Math.min(resume?.workerCount ?? buildConcurrency, units.length || 1));
      entry.workerCount = workerCount;
      localMapStore.updateKbBuild(buildId, { parallelism: workerCount, unitTotal: units.length });

      // ---- T2a（B 案 §7）：为每个执行单元登记 write 任务 ----
      // 单进程路径没有单元语义 → 登记一条代表全批的 single 任务。恢复时
      // 已在检查点里的任务不重建；已完成单元（unitDone）补终态。骨架记录
      // 失败不阻断构建主流程（warn 日志可观察）。
      this.seedOrchestrationTasks(buildId, entry, units, resume?.unitDone ? new Map(resume.unitDone) : undefined, resume?.finishInfo ?? null);

      // T2b（B 案 §3–§5/§7）：审查修订流水——审查者显式配置的构建走
      // 编排调度（单元写→独立审查→定向修订→整体整合→最终复核），不
      // 再走单进程/旧并行路径；旧式构建（无 orchestration/审查者未配置）
      // 路径与行为不变（B 案 §8「正在运行的旧构建保持旧流程」）。
      const orchestrated = reviewPipelineActive(entry.orchestration?.spec) && units.length > 0;
      if (orchestrated) {
        // ---- 编排流水路径（与并行路径同一单元/认领状态初始化）----
        buildState.units = units;
        buildState.unitDone = new Map(resume?.unitDone ?? []);
        buildState.claims = new PathClaims(
          [...units.flatMap((unit) => unit.ownedDocs.map((docPath) => ({ path: docPath, unitId: unit.id }))), ...(resume?.claims ?? [])],
        );
        entry.units = { total: units.length, done: buildState.unitDone.size, running: 0, failed: 0, retried: 0 };
        // 粗粒度进度：单元批次 + 每单元审查 + 整合/最终复核
        entry.batchTotal = units.reduce((sum, unit) => sum + unit.batches.length, 0) + units.length + 2;
        entry.batchIndex = [...entry.unitProgress.values()].reduce((sum, count) => sum + count, 0);
        entry.checkpointReady = true; this.persistCheckpoint(buildId);
        this.emitLog(buildId, 'info', `开始编排构建（${effectiveMode}，并发 ${workerCount}）：${units.length} 个单元 · 写→审→修订→整合→最终复核（B 案 §4）`);
        const overallTimeout = setTimeout(() => {
          entry.timedOut = true;
          entry.cancelRequested = true;
          this.emitLog(buildId, 'error', `构建整体超时（${config.standardKb.buildTimeoutMinutes} 分钟）`);
          cancelController.abort();
          for (const worker of entry.workers.values()) {
            if (worker.rpc && !worker.rpc.isExited()) void worker.rpc.abort();
          }
        }, config.standardKb.buildTimeoutMinutes * 60_000);
        overallTimeout.unref?.();
        try {
          const assets = this.deps.pluginStore ? null : this.deps.promptAssets();
          const systemRules = assets
            ? `${assets.buildRules}\n\n${assets.styleGuide}`
            : '';
          const promptTimeoutMs = config.standardKb.promptTimeoutMinutes * 60_000;
          const slotDeadlineMs = Date.parse(startedAt) + config.standardKb.buildTimeoutMinutes * 60_000;
          await this.runOrchestratedPhase({
            buildId,
            entry,
            buildState,
            units,
            workerCount,
            pluginSnapshot,
            snapshot,
            workset,
            sourceChanges: changePreview.sources,
            systemRules,
            promptTimeoutMs,
            cancelController,
            slotDeadlineMs,
            wordBudget,
            wordsOf,
          });
          this.throwIfPoisoned(buildState);
          if (!buildState.finishInfo) {
            throw new ToolError('kb_validation_failed', '编排流水未产出整体收尾信息（kb_finish）', 400);
          }
        } finally {
          clearTimeout(overallTimeout);
          await this.terminateAllWorkers(buildId, entry);
        }
      } else if (workerCount <= 1 && !resume?.units.length) {
        // ---- 等价回退：单进程流水线（§4.1 “行为与现状等价”）----
        entry.units = { total: 1, done: 0, running: 0, failed: 0, retried: 0 };
        this.emitLog(buildId, 'info', `开始模型构建（${effectiveMode}，单进程）：${workset.size} 个工作集源`);
        await this.runSingleProcessPhase({
          buildId,
          entry,
          buildState,
          pluginSnapshot,
          snapshot,
          workset,
          affectedDocs,
          sourceChanges: changePreview.sources,
          cancelController,
          wordBudget,
          wordsOf,
        });
      } else {
      // ---- 单元化并行路径（W ≥ 2）----
      buildState.units = units;
      buildState.unitDone = new Map(resume?.unitDone ?? []);
      buildState.claims = new PathClaims(
        [...units.flatMap((unit) => unit.ownedDocs.map((docPath) => ({ path: docPath, unitId: unit.id }))), ...(resume?.claims ?? [])],
      );
      entry.units = { total: units.length, done: buildState.unitDone.size, running: 0, failed: 0, retried: 0 };
      entry.batchTotal = units.reduce((sum, unit) => sum + unit.batches.length, 0) + 1; // + 收尾轮
      entry.batchIndex = [...entry.unitProgress.values()].reduce((sum, count) => sum + count, 0);
      entry.checkpointReady = true; this.persistCheckpoint(buildId);
      this.emitLog(buildId, 'info', `开始模型构建（${effectiveMode}，并行 ${workerCount}）：${workset.size} 个工作集源划 ${units.length} 个单元 / ${entry.batchTotal - 1} 批`);

      // S4（§4.5）：整体超时 → 取消句柄集（排队 acquire 出队 + 全部进程 abort）
      const overallTimeout = setTimeout(() => {
        entry.timedOut = true;
        entry.cancelRequested = true;
        this.emitLog(buildId, 'error', `构建整体超时（${config.standardKb.buildTimeoutMinutes} 分钟）`);
        cancelController.abort();
        for (const worker of entry.workers.values()) {
          if (worker.rpc && !worker.rpc.isExited()) void worker.rpc.abort();
        }
      }, config.standardKb.buildTimeoutMinutes * 60_000);
      overallTimeout.unref?.();

      try {
        const assets = this.deps.pluginStore ? null : this.deps.promptAssets();
        const systemRules = assets
          ? `${assets.buildRules}\n\n${assets.styleGuide}`
          : '';
        const promptTimeoutMs = config.standardKb.promptTimeoutMinutes * 60_000;
        const slotDeadlineMs = Date.parse(startedAt) + config.standardKb.buildTimeoutMinutes * 60_000;

        // 单元阶段：W 个 worker 拉取式 LPT 调度，单元内批次串行
        entry.stage = 'units';
        await this.runUnitsPhase({
          buildId,
          entry,
          buildState,
          units,
          workerCount,
          pluginSnapshot,
          snapshot,
          workset,
          sourceChanges: changePreview.sources,
          systemRules,
          promptTimeoutMs,
          cancelController,
          slotDeadlineMs,
          wordBudget,
          wordsOf,
        });

        // 收尾轮（§4.1：复用最后存活 worker，否则新拉 final 进程；kb_finish 单值）
        if (entry.cancelRequested) throw new CancelledError();
        this.throwIfPoisoned(buildState);
        entry.stage = 'finishing';
        await this.runFinalRound({
          buildId,
          entry,
          buildState,
          units,
          pluginSnapshot,
          snapshot,
          systemRules,
          promptTimeoutMs,
          cancelController,
          slotDeadlineMs,
        });
        if (!buildState.finishInfo) {
          throw new ToolError('kb_validation_failed', '模型在两轮提示后仍未调用 kb_finish', 400);
        }
        entry.batchIndex = entry.batchTotal;
      } finally {
        clearTimeout(overallTimeout);
        await this.terminateAllWorkers(buildId, entry);
      }
      }

      // ============ validating ============
      if (entry.cancelRequested) throw new CancelledError();
      setStatus('validating');
      // F3-R08：毒化检查（finish 轮的 raw_read 也可能触发）+ 发布前复核
      // 快照完整性（主文档 + CSV 附件，与 scan/readVerified 同一哈希函数）
      // ——模型最后一次 read 之后源被改，不得切换 CURRENT。
      this.throwIfPoisoned(buildState);
      this.emitLog(buildId, 'info', '开始确定性校验');
      const issues = await this.validateStaging(buildState, snapshot, docMeta, outputRoot);
      if (issues.length > 0) {
        writeReport(outputRoot, buildId, issues);
        throw new ToolError(
          'kb_validation_failed',
          `校验失败（${issues.length} 个问题，详见 report）：${issues.slice(0, 3).map((issue) => issue.code).join(', ')}`,
          400,
        );
      }
      // 同一个 buildId 可恢复后通过校验，不继续展示上次失败的报告。
      const reportPath = resolveInside(outputRoot, `.builds/${buildId}/report.json`, 'write');
      if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);

      // ============ publishing ============
      if (entry.cancelRequested) throw new CancelledError();
      setStatus('publishing');
      const releaseId = `r_${new Date().toISOString().replace(/[-:]/g, '').replace('T', 'T').slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`;
      // 只复核本次快照中的源；构建期间新同步的文档留待下一次构建。
      // 快照创建和发布前必须使用同一条发布产物排除规则，避免把排除项误判为新增源。
      const currentPublishedTokens = new Set(this.deps.publishedTokensProvider?.() ?? []);
      const currentDocuments = this.sourceDocuments(resume ? snapshot.entries.map((source) => source.objToken) : retainedSources)
        .filter((doc) => !currentPublishedTokens.has(doc.objToken));
      const newSources = verifySnapshotIntact(snapshot, config.knowledgeBaseRoot, this.deps.sheetCsvPaths, currentDocuments);
      if (snapshot.size === 0 && newSources > 0) {
        throw new ToolError('source_changed_during_build', '构建开始时没有可用源文档；构建期间有新文档同步完成，请重新选择并构建。', 409);
      }
      if (newSources > 0) {
        const warning = {
          code: 'sources_added_during_build',
          count: newSources,
          message: `构建期间新增 ${newSources} 篇可用源文档，未包含在本次构建中；可在下次构建或待更新差异中选择处理。`,
        };
        buildWarnings.push(warning);
        localMapStore.updateKbBuild(buildId, { warningsJson: JSON.stringify(buildWarnings) });
        this.emitLog(buildId, 'warn', warning.message);
      }

      // ---- T2b（B 案 §7）：发布条件判定 + CandidateRelease ----
      // 组装候选（文档清单+哈希、验收记录、沿用范围、来源去向、变更说明）
      // 并经 canPublish（T1 契约）判定；publishMode=confirm 时停在
      // awaiting_release（候选落盘，确认绑定候选哈希），auto 直接发布。
      if (orchestrated) {
        const candidateFile = this.assembleCandidateRelease({
          buildId,
          entry,
          buildState,
          snapshot,
          stagingRoot: stagingRootPath,
          programChecks: { passed: true, checkIds: ['validate_staging_docs'] },
          summary: buildState.finishInfo?.summary ?? '',
        });
        const publishCheck = canPublish({
          candidate: candidateFile.candidate,
          reports: KbBuildService.collectReviewReports(stagingRootPath),
          // 必审范围 = 最终候选整版（B 案 §4：整合改写与受影响交叉引用均
          // 在内；最终复核报告绑定该哈希，旧报告不能批准新稿）
          requiredReviewDraftHashes: [candidateFile.candidateHash],
          expectedSourceSnapshotHash: computeSnapshotHash(snapshot.entries),
          expectedBaseReleaseId: baseManifest?.releaseId ?? null,
        });
        this.emitLog(buildId, publishCheck.publishable || (publishCheck.reasons.length === 1 && publishCheck.reasons[0] === 'confirm_binding_stale')
          ? 'info'
          : 'error', `发布条件判定（canPublish）：${publishCheck.publishable ? '通过' : publishCheck.reasons.join(', ')}`);
        if (entry.orchestration!.spec.publishMode === 'confirm') {
          if (!publishCheck.publishable && !(publishCheck.reasons.length === 1 && publishCheck.reasons[0] === 'confirm_binding_stale')) {
            throw new ToolError('kb_publish_blocked', `发布条件未满足：${publishCheck.details.join('；')}`, 409);
          }
          // 停在 awaiting_release：候选与验收材料已落盘（candidate.json），
          // 由 release-confirm 端点在用户确认后发布（B 案 §7）
          setStatus('awaiting_release');
          this.emitLog(buildId, 'info', `候选版本就绪（${candidateFile.candidate.documents.length} 篇文档，candidateHash=${candidateFile.candidateHash.slice(0, 12)}…），等待用户确认发布`);
          this.cleanupAfterPipeline(buildId);
          return;
        }
        if (!publishCheck.publishable) {
          throw new ToolError('kb_publish_blocked', `发布条件未满足：${publishCheck.details.join('；')}`, 409);
        }
      }
      const manifest = await this.publishRelease({
        buildId,
        releaseId,
        mode: effectiveMode,
        baseReleaseId: baseManifest?.releaseId ?? null,
        knowledgeBaseRoot: config.knowledgeBaseRoot,
        model: config.agent.model.source === 'app-llm' || config.agent.runtime.backend === 'claude-code'
          ? (() => {
            const resolution = resolveAppLlmModel(config.llm, config.agent);
            return resolution ? `${config.agent.runtime.backend === 'claude-code' ? 'claude-code' : 'feishu-sync-llm'}/${resolution.openAiModel}` : null;
          })()
          : config.agent.model.piModel ?? null,
        snapshot,
        stagingRoot: stagingRootPath,
        outputRoot,
        docMeta,
        sourceContents,
        changePreview,
        summary: buildState.finishInfo?.summary ?? '',
      });
      stagingRootPath = ''; // 已被 rename 消费
      localMapStore.updateKbBuild(buildId, {
        status: 'published',
        releaseId,
        finishedAt: new Date().toISOString(),
      });
      this.emitLog(buildId, 'info', `发布完成：release=${releaseId}，${manifest.docs.length} 篇文档`);
      const row = localMapStore.getKbBuild(buildId);
      if (row) this.emitBuild(buildId, 'build_status', this.toDto(row, entry));
      this.cleanupAfterPipeline(buildId);
    } catch (error) {
      if (error instanceof CancelledError) {
        localMapStore.updateKbBuild(buildId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
        });
        this.emitLog(buildId, 'warn', '构建已取消（未发布任何变更）');
        const row = localMapStore.getKbBuild(buildId);
        if (row) this.emitBuild(buildId, 'build_status', this.toDto(row, entry));
        this.deps.toolService.revokeByBuild(buildId);
        if (entry.process) void entry.process.terminate();
        this.cleanupAfterPipeline(buildId);
      } else if (error instanceof AgentBusyError) {
        failBuild('agent_busy', error.message);
      } else {
        const code = error instanceof ToolError || (error instanceof PathGuardError && error.code === 'source_changed_during_build')
          ? error.code : 'kb_build_failed';
        const message = error instanceof Error ? error.message : String(error);
        failBuild(code, message);
      }
    } finally {
      // T2a（B 案 §8）：构建结束——未终态任务停止（迟到回执不再推进），
      // 摘要列刷新（orchestration_json 只是缓存，真相在 release 与检查点）
      if (entry.orchestration && !entry.orchestration.ended) {
        entry.orchestration.endBuild(currentStatus);
      }
      if (entry.orchestration) {
        try {
          localMapStore.updateKbBuild(buildId, { orchestrationJson: JSON.stringify(entry.orchestration.summary()) });
        } catch {
          /* 摘要列写入失败不影响构建终态（诊断缓存而已） */
        }
      }
      this.running = false;
      void currentStatus;
    }
  }

  private patchBuildStateMeta(state: BuildRunState, docMeta: Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>): void {
    // 把基线 docMeta 交给 tool service：kb_write_doc 更新它，校验阶段读取。
    (state as BuildRunState & { docMeta?: Map<string, { title: string; summary: string; tags: string[]; sources: string[] }> }).docMeta = docMeta;
  }

  /**
   * diting F06（A 案 §7.2/§10.2）：把基线 knowledge.json 的组织登记装载进
   * staging 工具注册表（增量与 full 同样执行——full 正文从空 staging 重建，
   * 但身份注册保留，同族三元组重声明沿用原 objectId）。
   * - 对象/证据/覆盖/非 canonical 呈现/关系：原样登记（未变对象不重声明，
   *   有效审查随对象保留；重声明时按实际载荷失效/继承）。
   * - 复制到 staging 的托管文档：docs[path] 标 basis='published'（编译直
   *   通行发布坐标）并记 carriedHash（发布前复核未被旧式重写）。
   * - text/csv 证据：对新快照重新解引用，通过后以 baseline-carry 回执接续
   *   读取轨迹（回执范围即证据选择范围；源已变化则保持原样，由发布门禁
   *   显式失败）；readReceiptId 更新不影响 payload/reviewSubjectHash。
   * - 迁移：累积映射预置进 organization-plan.json（kb_submit_plan 只替换
   *   同 objectId 项）。
   * 返回装载的对象数。
   */
  private seedBaselineKnowledge(
    buildId: string,
    stagingRoot: string,
    baseline: KnowledgeManifest,
    snapshot: RawSourceSnapshot,
    knowledgeBaseRoot: string,
  ): number {
    const draft: KnowledgeDraftFile = {
      schemaVersion: 1,
      buildId,
      docs: {},
      clientKeys: {},
      evidenceKeys: {},
      objects: [],
      presentations: [],
      relations: [],
      evidence: [],
      coverage: [],
      calls: {},
    };
    const documentsByPath = new Map((baseline.documents ?? []).map((doc) => [doc.path, doc] as const));
    for (const object of baseline.objects ?? []) {
      draft.objects.push(JSON.parse(JSON.stringify(object)));
      if (object.tombstone || !object.canonical) continue;
      const docPath = object.canonical.path;
      if (draft.docs[docPath]) continue;
      let carriedHash: string | undefined;
      try {
        carriedHash = contentResourceHash(fs.readFileSync(path.join(stagingRoot, 'docs', docPath), 'utf-8'));
      } catch {
        carriedHash = undefined; // 文档未被复制（默认删除/未重写）→ 发布门禁 kb_canonical_missing 拦截
      }
      draft.docs[docPath] = {
        docId: documentsByPath.get(docPath)?.docId ?? object.canonical.docId,
        revision: 0,
        basis: 'published',
        bodyLineOffset: 0,
        ...(carriedHash ? { carriedHash } : {}),
      };
    }
    draft.presentations = (baseline.presentations ?? [])
      .filter((presentation) => presentation.kind !== 'canonical') // canonical 导航登记由编译器重建
      .map((presentation) => JSON.parse(JSON.stringify(presentation)));
    draft.relations = (baseline.relations ?? []).map((relation) => JSON.parse(JSON.stringify(relation)));
    draft.coverage = (baseline.coverage ?? []).map((item) => JSON.parse(JSON.stringify(item)));
    draft.evidence = (baseline.evidence ?? []).map((item) => JSON.parse(JSON.stringify(item)));

    // text/csv 证据回执接续（源未变时验证通过 → baseline-carry 回执替换旧 id）
    const receiptLines: string[] = [];
    for (const evidence of draft.evidence) {
      if (evidence.selector.kind !== 'text_span' && evidence.selector.kind !== 'csv_cells') continue;
      const entry = snapshot.get(evidence.sourceRef.sourceId);
      if (!entry) continue;
      let verified: { content: string; attachments: Array<{ path: string; content: string }> };
      try {
        verified = snapshot.readVerified(knowledgeBaseRoot, evidence.sourceRef.sourceId);
      } catch {
        continue; // 源已变化/不可读：保持原登记，发布门禁显式失败
      }
      const csvBase = evidence.sourceRef.resourceId.includes('#csv:')
        ? evidence.sourceRef.resourceId.split('#csv:')[1] ?? '' : '';
      const content = csvBase
        ? verified.attachments.find((attachment) => path.basename(attachment.path) === csvBase)?.content
        : verified.content;
      if (content === undefined) continue;
      const resource: EvidenceResource = {
        resourceId: evidence.sourceRef.resourceId,
        kind: csvBase ? 'csv' : 'text',
        content,
        ...(csvBase ? { path: csvBase } : {}),
        sourceId: evidence.sourceRef.sourceId,
        sourceSnapshotHash: entry.contentHash,
        resourceHash: contentResourceHash(content),
      };
      const receiptRange = evidence.selector.kind === 'text_span'
        ? { lineStart: evidence.selector.lineStart, lineEnd: evidence.selector.lineEnd }
        : { lineStart: 1, lineEnd: content.split('\n').length };
      const candidate = `krr_seed_${crypto.randomBytes(8).toString('hex')}`;
      const receipts: EvidenceReadReceipt[] = [{
        readReceiptId: candidate,
        resourceId: evidence.sourceRef.resourceId,
        lineStart: receiptRange.lineStart,
        lineEnd: receiptRange.lineEnd,
      }];
      const verification = verifyEvidence({
        evidence: {
          evidenceId: evidence.evidenceId,
          sourceRef: evidence.sourceRef,
          selector: evidence.selector,
          quoteHash: evidence.quoteHash,
          readReceiptId: candidate,
        },
        resources: [resource],
        receipts,
      });
      if (verification.ok) {
        evidence.readReceiptId = candidate;
        receiptLines.push(JSON.stringify({
          readReceiptId: candidate,
          buildId,
          unitId: null,
          toolCallId: 'baseline-carry',
          sourceSnapshotHash: entry.contentHash,
          resourceId: evidence.sourceRef.resourceId,
          selector: { kind: 'read_range', lineStart: receiptRange.lineStart, lineEnd: receiptRange.lineEnd },
          returnedHash: resource.resourceHash,
          truncated: false,
        }));
      }
    }

    try {
      fs.writeFileSync(path.join(stagingRoot, 'knowledge-draft.json'), `${JSON.stringify(draft, null, 2)}\n`);
      if (receiptLines.length > 0) {
        fs.appendFileSync(path.join(stagingRoot, 'read-receipts.jsonl'), `${receiptLines.join('\n')}\n`);
      }
      const plan: OrganizationPlanFile = {
        schemaVersion: 1,
        buildId,
        planId: `kplan_${crypto.randomBytes(6).toString('hex')}`,
        planRevision: 0,
        docs: [],
        objects: [],
        dependencies: [],
        migrations: (baseline.migrations ?? []).map((migration) => ({ ...migration })),
        updatedAt: new Date().toISOString(),
      };
      if (!fs.existsSync(path.join(stagingRoot, 'organization-plan.json'))) {
        fs.writeFileSync(path.join(stagingRoot, 'organization-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
      }
    } catch (error) {
      throw new ToolError('kb_build_failed', `基线组织登记装载失败：${error instanceof Error ? error.message : String(error)}`, 500);
    }
    return draft.objects.filter((object) => !object.tombstone).length;
  }

  /**
   * T2a：编排骨架任务登记（B 案 §7/附录 A）。write 任务的输入引用为快照
   * 源 token（raw:<objToken>），允许写入路径 = 单元认领文档；依赖为空
   * （撰写阶段无前置）。已存在（恢复场景）不重建。
   */
  private seedOrchestrationTasks(
    buildId: string,
    entry: InMemoryBuild,
    units: BuildUnit[],
    resumedUnitDone: Map<string, { summary: string; skipped: Array<{ objToken: string; reason: string }> }> | undefined,
    resumedFinishInfo: BuildRunState['finishInfo'],
  ): void {
    const orchestration = entry.orchestration;
    if (!orchestration) return;
    try {
      if (units.length > 0) {
        // T2b：新流水（审查者显式配置）用轮次化 id（t:write:U:r0），
        // 后继轮次由 runOrchestratedPhase 的 sync 派生；旧路径保持 t:U
        const orchestrated = reviewPipelineActive(orchestration.spec);
        for (const unit of units) {
          const taskId = orchestrated ? `t:write:${unit.id}:r0` : `t:${unit.id}`;
          if (orchestration.task(taskId)) continue;
          orchestration.createTask({
            taskId,
            revision: 0,
            role: 'write',
            unitId: unit.id,
            reviewSubjectDraftHash: null,
            inputRefs: unit.sources.map((token) => `raw:${token}`),
            dependencies: [],
            allowedWritePaths: [...unit.ownedDocs],
            outputRequirements: `单元 ${unit.id}：${unit.batches.length} 批草稿写入与 kb_unit_done 上报`,
          });
          // 恢复场景：已上报完成的单元直接补终态（done+available → 跳过）
          if (resumedUnitDone?.has(unit.id)) {
            orchestration.updateExecState(taskId, 'running');
            orchestration.submitResult({ taskId, revision: 0, artifactState: 'available', resultRef: `unit:${unit.id}:done` });
          }
        }
      } else {
        if (!orchestration.task('t:single')) {
          orchestration.createTask({
            taskId: 't:single',
            revision: 0,
            role: 'write',
            unitId: null,
            reviewSubjectDraftHash: null,
            inputRefs: [...entry.buildState?.workset.keys() ?? []].map((token) => `raw:${token}`),
            dependencies: [],
            allowedWritePaths: [],
            outputRequirements: '全批草稿写入与 kb_finish 上报',
          });
          if (resumedFinishInfo && orchestration.task('t:single')?.execState === 'queued') {
            orchestration.updateExecState('t:single', 'running');
            orchestration.submitResult({ taskId: 't:single', revision: 0, artifactState: 'available', resultRef: 'single:done' });
          }
        }
      }
    } catch (error) {
      this.emitLog(buildId, 'warn', `编排骨架任务登记失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** T2a：编排骨架状态推进（防御式——记录层失败不阻断构建主流程，warn 可观察）。 */
  private markOrchestration(buildId: string, mutate: (orchestration: BuildOrchestration) => void): void {
    const orchestration = this.active.get(buildId)?.orchestration;
    if (!orchestration) return;
    try {
      mutate(orchestration);
    } catch (error) {
      this.emitLog(buildId, 'warn', `编排骨架状态推进失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** T2a：单进程路径任务 ID（无单元语义的全批任务）。 */
  private static readonly SINGLE_TASK_ID = 't:single';

  /** S3：图片描述器解析（deps 注入优先；未注入按 dataRoot+config 自建）。 */
  private resolveVisionDescriber(): VisionDescriberLike {
    if (this.deps.visionDescriber) return this.deps.visionDescriber;
    this.defaultDescriber ??= new VisionDescriber({
      dataRoot: this.deps.dataRoot,
      config: () => this.deps.configProvider() ?? ({
        agent: { vision: buildDefaultAgentVisionConfig() },
        llm: { providers: [] },
      } as unknown as Config),
    });
    return this.defaultDescriber;
  }

  /** S3（§3.6）：/api/kb/changes 的只读缓存探测。 */
  visionCacheProbe(): ((imageHash: string) => Promise<string | null>) | null {
    const describer = this.resolveVisionDescriber();
    return (hash) => describer.lookup(hash).catch(() => null);
  }

  /**
   * S3（§3.4）：preflight 预描述。枚举工作集源图片并优先使用已有缓存；
   * vision 未就绪时未缓存的图片标为 unavailable(vision_unconfigured)。
   * describeMany 的结果 Map 以 src 为键，跨源同名 src 会冲突——这里用
   * `<objToken>::<src>` 组合键传入再拆回（缓存写入按图片字节 hash，不受影响）。
   */
  private async describeWorksetImages(input: {
    buildId: string;
    entry: InMemoryBuild;
    snapshot: RawSourceSnapshot;
    workset: Map<string, 'added' | 'changed' | 'rebuild'>;
    describer: VisionDescriberLike;
    visionReady: boolean;
    signal: AbortSignal;
  }): Promise<Map<string, Map<string, ImageDescription>>> {
    const items: Array<{ objToken: string; src: string; file: string }> = [];
    for (const [token] of input.workset) {
      const entry = input.snapshot.get(token);
      if (!entry) continue;
      let content: string;
      try {
        content = input.snapshot.readVerified(input.entry.buildState?.knowledgeBaseRoot ?? '', token).content;
      } catch {
        continue;
      }
      for (const image of resolveSourceImages(input.entry.buildState?.knowledgeBaseRoot ?? '', entry.relPath, content)) {
        // P0-S7（任务 4）：旁路文字存在 → 跳过 vision 描述（省额度）；
        // 文字经 raw_read 内联 <whiteboard_text>（svg/raw 同规则）。
        if (input.entry.buildState?.whiteboardTexts?.get(token)?.has(image.src)) continue;
        items.push({ objToken: token, src: image.src, file: image.file });
      }
    }
    input.entry.images = { total: items.length, described: 0, cached: 0, unavailable: 0 };
    const result = new Map<string, Map<string, ImageDescription>>();
    if (items.length === 0) return result;
    const put = (objToken: string, description: ImageDescription) => {
      let bucket = result.get(objToken);
      if (!bucket) {
        bucket = new Map();
        result.set(objToken, bucket);
      }
      bucket.set(description.src, description);
    };
    this.emitLog(input.buildId, 'info', !input.visionReady
      ? `图片预描述：${items.length} 张（识图服务未就绪，仅复用已有缓存）`
      : input.entry.refreshImages
      ? `图片预描述：${items.length} 张（重新生成本次处理源文档的图片描述）`
      : `图片预描述：${items.length} 张（命中缓存不调远端）`);
    const composed = await input.describer.describeMany(
      items.map((item) => ({ file: item.file, src: `${item.objToken}::${item.src}` })),
      { signal: input.signal, onProgress: () => undefined, refreshCached: input.entry.refreshImages },
    );
    let described = 0;
    let cached = 0;
    let unavailable = 0;
    let refreshFailures = 0;
    for (const item of items) {
      const description = composed.get(`${item.objToken}::${item.src}`);
      if (description?.refreshFailure) refreshFailures += 1;
      if (description && description.state !== 'unavailable') {
        put(item.objToken, { ...description, src: item.src });
        if (description.state === 'cached') cached += 1;
        else described += 1;
      } else {
        put(item.objToken, {
          src: item.src,
          imageHash: description?.imageHash ?? '',
          state: 'unavailable',
          reason: description?.reason ?? 'vision_failed',
          ...(description?.message ? { message: description.message } : {}),
        });
        unavailable += 1;
      }
    }
    input.entry.images = { total: items.length, described, cached, unavailable };
    input.entry.imageRefreshFailures = refreshFailures;
    return result;
  }

  /** 沿用的图文源也须计入有效文本预算；只读本地缓存，不识图、不计入本次识图数量。 */
  private async includeRetainedImageCache(state: BuildRunState, describer: VisionDescriberLike, signal: AbortSignal): Promise<void> {
    const cachedByHash = new Map<string, string | null>();
    for (const entry of state.snapshot.entries) {
      if (signal.aborted) return;
      if (state.workset.has(entry.objToken) || entry.imageCount === 0) continue;
      const content = state.snapshot.readVerified(state.knowledgeBaseRoot, entry.objToken).content;
      for (const image of resolveSourceImages(state.knowledgeBaseRoot, entry.relPath, content)) {
        if (signal.aborted) return;
        if (state.whiteboardTexts?.get(entry.objToken)?.has(image.src)) continue;
        const hash = hashImageFile(image.file);
        if (!hash) continue;
        if (!cachedByHash.has(hash)) cachedByHash.set(hash, await describer.lookup(hash).catch(() => null));
        const text = cachedByHash.get(hash);
        if (text == null) continue;
        const descriptions = state.imageDescriptions!.get(entry.objToken) ?? new Map<string, ImageDescription>();
        descriptions.set(image.src, { src: image.src, imageHash: hash, state: 'cached', text });
        state.imageDescriptions!.set(entry.objToken, descriptions);
      }
    }
  }

  // ------------------------------------------------------------------
  // S4：worker 编排（§4.1/§4.5）
  // ------------------------------------------------------------------

  /**
   * S4 等价回退路径（§4.1 “行为与现状等价”）：单进程全局批切分 +
   * kb_finish 单轮。保留既有 spawnBuildProcess 测试接缝与提示词序列，
   * 既有构建语义回归（buildParallelism 缺省/为 1）不改动全绿。
   */
  private async runSingleProcessPhase(input: {
    buildId: string;
    entry: InMemoryBuild;
    buildState: BuildRunState;
    pluginSnapshot?: AppPluginSnapshot;
    snapshot: RawSourceSnapshot;
    workset: Map<string, 'added' | 'changed' | 'rebuild'>;
    affectedDocs: Array<{ path: string; title: string }>;
    sourceChanges: KbFileChange[];
    cancelController: AbortController;
    /** P2-S2：每批有效字数预算（0 = 旧行为按源数切分） */
    wordBudget: number;
    /** P2-S2：objToken → 有效字数（worksetMeta） */
    wordsOf: (token: string) => number;
  }): Promise<void> {
    const { entry, buildState } = input;
    const config = this.configForBuild(input.buildId);
    // P2-S2：与并行路径同一 packBatches（wordBudget=0 等价旧 chunkTokens）
    const batches = entry.resume ? entry.singleBatches : packBatches(
      [...input.workset.keys()].sort(),
      input.wordsOf,
      { wordBudget: input.wordBudget, maxCount: Math.max(1, Math.min(50, config.standardKb.buildBatchSize)) },
    );
    // F3-R07：仅 removed 的增量（无 added/changed）也必须有一个批次明确
    // 告知模型删除与受影响文档——不能让删除影响只存在于默认删除逻辑里。
    if (batches.length === 0 && input.affectedDocs.length > 0) {
      batches.push([]);
    }
    entry.batchTotal = batches.length + 1; // + 最后 finish prompt
    entry.stage = 'units';
    entry.singleBatches = batches; entry.checkpointReady = true;
    this.persistCheckpoint(input.buildId);
    if (buildState.finishInfo) return;

    // T3b-06→T2a：单 worker 回退与并行路径同一准入语义——acquire('build')
    // FIFO 排队 + M-1 后台配额 + 可取消（受整体超时约束），不再用 session
    // 类 reserveSlot 立即抢最后一个总槽（否则后台任务可占满 M，交互会话
    // 保留槽消失）。
    let rpc = await this.spawnBuildProcess(input.buildId, buildState, input.pluginSnapshot, {
      signal: input.cancelController.signal,
    });
    entry.process = rpc;
    // T2a：单进程路径任务开跑（queued→running）
    this.markOrchestration(input.buildId, (orchestration) => {
      if (orchestration.task(KbBuildService.SINGLE_TASK_ID)?.execState === 'queued') {
        orchestration.updateExecState(KbBuildService.SINGLE_TASK_ID, 'running');
      }
    });
    const overallTimeout = setTimeout(() => {
      entry.timedOut = true;
      this.emitLog(input.buildId, 'error', `构建整体超时（${config.standardKb.buildTimeoutMinutes} 分钟）`);
      entry.cancelRequested = true;
      input.cancelController.abort();
      void rpc.abort();
    }, config.standardKb.buildTimeoutMinutes * 60_000);
    overallTimeout.unref?.();

    try {
      const assets = this.deps.pluginStore ? null : this.deps.promptAssets();
      const systemRules = assets
        ? `${assets.buildRules}\n\n${assets.styleGuide}`
        : '';

      for (let batchIndex = entry.singleCompleted; batchIndex < batches.length; batchIndex += 1) {
        if (entry.cancelRequested) throw new CancelledError();
        entry.batchIndex = batchIndex + 1;
        const batch = batches[batchIndex];
        const batchPrompt = this.buildBatchPrompt({
          batch,
          snapshot: input.snapshot,
          workset: input.workset,
          affectedDocs: input.affectedDocs,
          batchIndex,
          batchTotal: batches.length,
          firstBatch: batchIndex === 0,
          sourceChanges: input.sourceChanges,
        });
        this.emitLog(input.buildId, 'info', `批次 ${batchIndex + 1}/${batches.length}：${batch.length} 个源`);
        // P2-S2（§2.3）：预算开启时每批补一行字数日志（预算调优）；
        // budget=0 保持旧日志字节级不变
        if (input.wordBudget > 0) {
          const batchWords = batch.reduce((sum, token) => sum + input.wordsOf(token), 0);
          this.emitLog(input.buildId, 'info', `batch ${batchIndex + 1}/${batches.length}: sources=${batch.length}, words=${batchWords}`);
        }
        const continuation = '每个批次使用独立模型上下文。先用 draft_list/draft_read 检查已保存草稿，再补齐本批内容。不要覆盖无关内容。\n\n'
          + (entry.resume ? '这是中断后的断点继续，已完成批次不会重复执行；本批已成功写入的完整草稿已恢复，请保留并继续完善。\n\n' : '');
        const outcome = await rpc.prompt(
          continuation + (systemRules ? `${batchPrompt}\n\n---\n构建规则与文风规范（每批适用）：\n${systemRules}` : batchPrompt),
          { timeoutMs: config.standardKb.promptTimeoutMinutes * 60_000 },
        );
        if (entry.cancelRequested && outcome.outcome !== 'completed') throw new CancelledError();
        if (outcome.outcome === 'aborted') throw new CancelledError();
        if (outcome.outcome === 'failed') {
          throw new ToolError(
            outcome.error?.code ?? 'model_request_failed',
            `批次 ${batchIndex + 1} 失败：${outcome.error?.message ?? '未知错误'}`,
            502,
          );
        }
        // F3-R08：源变更毒化不可恢复——每个批次结束立即失败，模型不得绕过
        this.throwIfPoisoned(buildState);
        entry.singleCompleted = batchIndex + 1;
        this.persistCheckpoint(input.buildId);
        // 每批采用独立模型进程，上下文不随几十份文档持续累积。
        if (batchIndex + 1 < batches.length) {
          await this.deps.pool.terminate(`build:${input.buildId}`);
          rpc = await this.spawnBuildProcess(input.buildId, buildState, input.pluginSnapshot, { signal: input.cancelController.signal });
          entry.process = rpc;
        }
      }

      // finish prompt（模型未调用工具时强制重试一次，不静默失败）
      if (entry.cancelRequested) throw new CancelledError();
      this.throwIfPoisoned(buildState);
      entry.stage = 'finishing';
      entry.batchIndex = entry.batchTotal;
      const finishPrompt = [
        ...this.resumeValidationFeedback(entry),
        ...this.finishCoverage(buildState),
        '全部批次已完成。请【立即调用 kb_finish 工具】完成构建：',
        '- summary：本次构建的总结（做了什么、产出哪些主题文档）。',
        '- skipped：工作集中未被任何文档引用的源，逐个列出 objToken 与理由。',
        '注意：必须调用工具本身（tool call），不要只回复文本说明。若你尚未写入任何文档，先用 kb_write_doc 写入，再调用 kb_finish。',
      ].join('\n');
      let finishOutcome = await rpc.prompt(finishPrompt, {
        timeoutMs: config.standardKb.promptTimeoutMinutes * 60_000,
      });
      if (finishOutcome.outcome === 'aborted') throw new CancelledError();
      if (finishOutcome.outcome === 'failed') {
        throw new ToolError(
          finishOutcome.error?.code ?? 'model_request_failed',
          `kb_finish 阶段失败：${finishOutcome.error?.message ?? '未知错误'}`,
          502,
        );
      }
      if (!buildState.finishInfo) {
        // 一次强制纠正：明确告诉模型未检测到工具调用
        this.emitLog(input.buildId, 'warn', '未检测到 kb_finish 调用，发送强制纠正提示');
        finishOutcome = await rpc.prompt(
          '系统检测到你没有调用 kb_finish 工具（工具调用记录为空）。现在请直接调用 kb_finish 工具：summary 填写构建总结；如果此前未写任何文档，skipped 列出全部源并说明理由。不要输出任何文本，直接发起工具调用。',
          { timeoutMs: config.standardKb.promptTimeoutMinutes * 60_000 },
        );
        if (finishOutcome.outcome === 'aborted') throw new CancelledError();
        if (finishOutcome.outcome === 'failed') {
          throw new ToolError(
            finishOutcome.error?.code ?? 'model_request_failed',
            `kb_finish 纠正阶段失败：${finishOutcome.error?.message ?? '未知错误'}`,
            502,
          );
        }
      }
      if (!buildState.finishInfo) {
        throw new ToolError('kb_validation_failed', '模型在两轮提示后仍未调用 kb_finish', 400);
      }
      // T2a：单进程路径任务完成（exec done + 产物可用）
      this.markOrchestration(input.buildId, (orchestration) => {
        const task = orchestration.task(KbBuildService.SINGLE_TASK_ID);
        if (task && task.execState !== 'done') {
          if (task.execState === 'queued') orchestration.updateExecState(KbBuildService.SINGLE_TASK_ID, 'running');
          orchestration.submitResult({ taskId: KbBuildService.SINGLE_TASK_ID, revision: task.revision, artifactState: 'available', resultRef: 'single:done' });
        }
      });
    } finally {
      clearTimeout(overallTimeout);
      await this.deps.pool.terminate(`build:${input.buildId}`);
      entry.process = null;
    }
  }

  private emitWorker(buildId: string, worker: WorkerRuntime): void {
    this.emitBuild(buildId, 'build_worker', {
      workerId: worker.workerId,
      state: worker.state,
      unitId: worker.unitId,
      unitBatchIndex: worker.unitBatchIndex,
      unitBatchTotal: worker.unitBatchTotal,
    });
  }

  private emitUnits(buildId: string): void {
    const entry = this.active.get(buildId);
    if (!entry) return;
    this.emitBuild(buildId, 'build_units', { ...entry.units });
  }

  /** worker 拉取新单元/进入收尾轮时同步运行上下文（工具按 context 判定单元归属）。 */
  private setWorkerAssignment(worker: WorkerRuntime, unitId: string | null, phase?: 'unit' | 'final'): void {
    worker.unitId = unitId;
    if (worker.context) {
      worker.context.options.worker = {
        workerId: worker.workerId,
        unitId,
        phase: phase ?? (worker.workerId === 'final' ? 'final' : 'unit'),
      };
    }
  }

  /** 等价回退路径的运行上下文（无 worker 身份，工具行为与重构前一致）。 */
  private createBuildRunContext(buildId: string, buildState: BuildRunState): { token: string; revoke: () => void } {
    const config = this.configForBuild(buildId);
    const { token } = this.deps.toolService.createRunContext({
      runKind: 'build',
      buildId,
      outputRoot: config.standardKb.outputRoot,
      knowledgeBaseRoot: config.knowledgeBaseRoot,
      buildState,
      onEvent: (event) => {
        this.emitBuild(buildId, 'tool', {
          phase: event.phase,
          toolName: event.toolName,
          summary: event.argsSummary || event.resultSummary || '',
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
        });
      },
    });
    return { token, revoke: () => this.deps.toolService.revokeToken(token) };
  }

  /** 构建 pi 子进程 env（等价回退路径）。 */
  private buildPiEnv(
    token: string,
    apiKey: string | undefined,
    providerJson: string | undefined,
    pluginSnapshot: AppPluginSnapshot | undefined,
    runtime: { piPackageRoot?: string | null },
    config: Config,
  ): NodeJS.ProcessEnv {
    const env = buildPiProcessEnv({
      mode: config.agent.model.source,
      parentEnv: process.env,
      dataRoot: this.deps.dataRoot,
      agentUrl: this.deps.internalBaseUrl(),
      runToken: token,
      apiKey,
    });
    if (providerJson) env.FEISHU_SYNC_AGENT_PROVIDER_JSON = providerJson;
    if (pluginSnapshot) {
      env.FEISHU_SYNC_AGENT_PLUGIN_SNAPSHOT = pluginSnapshot.path;
      env.FEISHU_SYNC_AGENT_PLUGIN_REVISION = pluginSnapshot.revision;
      if (pluginSnapshot.externalPlugins) env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS = '1';
    }
    env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot ?? '';
    return env;
  }

  /**
   * 既有单进程构建 spawn（等价回退路径专用，保留原签名供测试接缝覆盖：
   * kb-version / provider-protocol-live 等以 Object.assign 覆盖本方法注入
   * 假模型）。T3b-06→T2a：槽位经 acquireSingleWorkerSlot（acquire('build')
   * FIFO + M-1 配额 + 可取消）；拿不到（整体超时内）→ agent_busy 409。
   */
  private async spawnBuildProcess(
    buildId: string,
    buildState: BuildRunState,
    pluginSnapshot?: AppPluginSnapshot,
    slotOptions: { signal?: AbortSignal; slotDeadlineMs?: number } = {},
  ): Promise<PiRpcProcess> {
    const config = this.configForBuild(buildId);
    const runtime = await this.deps.resolver.resolveRuntime(config.agent);
    if (!runtime.nodePath || (config.agent.runtime.backend !== 'claude-code' && !runtime.piCliPath)) {
      throw new ToolError('agent_not_ready', 'Agent 运行时未就绪', 503);
    }
    const slot = await this.acquireSingleWorkerSlot(slotOptions);
    const { token, revoke } = this.createBuildRunContext(buildId, buildState);

    if (config.agent.runtime.backend === 'claude-code') {
      let rpc: PiRpcProcess | undefined;
      try {
        rpc = createClaudeProcess({ config, nodePath: runtime.nodePath, token, sessionId: `build:${buildId}`, dataRoot: this.deps.dataRoot,
          internalBaseUrl: this.deps.internalBaseUrl(), toolService: this.deps.toolService, pluginSnapshot, ephemeral: true });
        rpc.once('exit', revoke); await rpc.start(); this.deps.pool.register(`build:${buildId}`, rpc, 'build', slot);
        return rpc;
      } catch (error) { slot.release(); await rpc?.terminate().catch(() => undefined); revoke(); throw error; }
    }

    let model: string;
    let apiKey: string | undefined;
    let providerJson: string | undefined;
    if (config.agent.model.source === 'app-llm') {
      const runConfig = buildAppLlmRunConfig(config.llm, config.agent);
      if (!runConfig || !runConfig.apiKey) {
        slot.release();
        revoke();
        throw new ToolError('agent_not_ready', 'app-llm 模型未配置或缺少 API Key', 503);
      }
      model = runConfig.model;
      apiKey = runConfig.apiKey;
      providerJson = runConfig.providerJson;
    } else {
      const piModel = config.agent.model.piModel?.trim();
      if (!piModel) {
        slot.release();
        revoke();
        throw new ToolError('agent_not_ready', 'pi-agent-dir 模式下未配置模型', 503);
      }
      model = piModel;
    }

    const env = this.buildPiEnv(token, apiKey, providerJson, pluginSnapshot, runtime, config);
    const extensionPath = this.deps.extensionPath();
    const spawnOptions = {
      nodePath: runtime.nodePath,
      piCliPath: runtime.piCliPath!,
      ...(extensionPath ? { extensionPath } : {}),
      ...(pluginSnapshot ? {
        additionalExtensionPaths: pluginSnapshot.extensionPaths ?? [pluginSnapshot.extensionPath],
        allowExternalPluginTools: pluginSnapshot.externalPlugins,
        additionalSkillPaths: pluginSnapshot.skillPaths,
        additionalPromptPaths: pluginSnapshot.promptPaths,
        additionalThemePaths: pluginSnapshot.themePaths,
      } : {}),
      tools: toolsForRunKind('build'),
      noSession: true,
      model,
      thinking: config.agent.model.thinkingLevel,
      cwd: path.join(this.deps.dataRoot, 'agent', 'empty-cwd'),
      env,
      promptTimeoutMs: config.standardKb.promptTimeoutMinutes * 60_000,
    };
    const rpc = this.deps.processFactory ? this.deps.processFactory(spawnOptions) : new PiRpcProcess(spawnOptions);
    // F3-R05：任何退出路径（正常/取消/超时/崩溃/池回收）都回收令牌。
    rpc.once('exit', () => this.deps.toolService.revokeToken(token));
    try {
      await rpc.start();
      await rpc.sendCommand('set_auto_retry', { enabled: false }).catch(() => undefined);
      this.deps.pool.register(`build:${buildId}`, rpc, 'build', slot);
    } catch (error) {
      slot.release();
      await rpc.terminate().catch(() => undefined);
      revoke();
      throw error;
    }
    return rpc;
  }

  /**
   * T3b-06→T2a：单 worker 槽位获取（与并行路径 acquireWorkerSlot 同一准入
   * 语义）：acquire('build') FIFO 排队、构建容量 N、取消信号
   * 贯通；首个槽位受整体超时约束（拿不到 → agent_busy），其后排队只受
   * 取消。与 acquireWorkerSlot 的差别仅在不依赖 entry（回退路径单进程）。
   */
  private async acquireSingleWorkerSlot(
    options: { signal?: AbortSignal; slotDeadlineMs?: number },
  ): Promise<PoolSlot> {
    const config = this.deps.configProvider()!;
    const deadlineMs = options.slotDeadlineMs
      ?? Date.now() + Math.max(1, config.standardKb.buildTimeoutMinutes) * 60_000;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const acquiring = this.deps.pool.acquire('build', { signal: controller.signal });
    const remaining = deadlineMs - Date.now();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      if (remaining <= 0) {
        controller.abort();
        reject(new AgentBusyError('构建整体超时内未能获得进程槽位'));
        return;
      }
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentBusyError('构建整体超时内未能获得进程槽位'));
      }, remaining);
      timer.unref?.();
    });
    try {
      return await Promise.race([acquiring, deadline]);
    } catch (error) {
      // 竞态兑底：deadline 已拒绝后槽位才授出 → 立即释放，不占容量。
      acquiring.then((late) => late.release()).catch(() => undefined);
      if (error instanceof AgentBusyError) throw error;
      // 取消信号（外层 cancelController）→ 按取消语义冒泡（CancelledError）
      if ((error as { name?: string })?.name === 'AbortError') {
        throw new CancelledError();
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** 既有单进程批提示词（等价回退路径，语义与重构前一致）。 */
  private buildBatchPrompt(input: {
    batch: string[];
    snapshot: RawSourceSnapshot;
    workset: Map<string, 'added' | 'changed' | 'rebuild'>;
    affectedDocs: Array<{ path: string; title: string }>;
    batchIndex: number;
    batchTotal: number;
    firstBatch: boolean;
    sourceChanges?: KbFileChange[];
  }): string {
    const lines: string[] = [];
    lines.push('正文必须为当前规则的完整说明。下面的diff只用于判断要更新什么；禁止把修订记录、本次改动、上版/本版对比或版本号写进正文。变更说明只填kb_finish.summary。');
    lines.push('若草稿中已有标准文档，须在其基础上继续构建：保留未受影响的文档与来源；相关内容可合并更新。删除旧路径进行合并时须在kb_finish.docMerges声明目标，不能用本批文档替代整个知识库。');
    for (const change of input.sourceChanges ?? []) {
      if (!input.batch.includes(change.key) && change.kind !== 'removed') continue;
      lines.push(`源差异 ${change.key}（${change.title}）：${change.kind}${change.reason === 'excluded' ? '，用户标记为不参与构建' : ''}`);
      lines.push('<untrusted_source_diff>');
      lines.push(change.beforeAvailable ? (change.patch.slice(0, 8000) || '原文未变，仅路径/标题变化') : '历史版本只保存hash，未保存旧原文；必须读取当前完整源文档，不推测历史差异。');
      if (change.truncated || change.patch.length > 8000) lines.push('差异展示已截断；以raw_read当前全文为准。');
      lines.push('</untrusted_source_diff>');
    }
    // F3-R07：仅 removed 的增量没有新增/变更源——空批次也要明确告知删除
    // 与受影响文档，模型决定重建或确认默认删除。
    if (input.batch.length === 0) {
      lines.push(`【批次 ${input.batchIndex + 1}/${input.batchTotal}】本次构建没有新增或变更的源，但有源被删除：`);
      lines.push('');
      lines.push('以下文档受到源移除/排除影响：仅引用已移除源的文档已默认删除；其余仍在草稿中，必须读取保留的源后重新写出完整正文并修正sources：');
      for (const doc of input.affectedDocs.slice(0, 200)) {
        lines.push(`- ${doc.path}（${doc.title}）`);
      }
      lines.push('');
      lines.push('要求：');
      lines.push('1. 检查删除后是否仍有主题需要保留：若某主题还承载未删除源的内容，用 kb_write_doc 重建或修订对应文档（sources 声明现存的源）。');
      lines.push('2. 若删除后无需任何重建，不写文档，直接结束本批次（后续会提示 kb_finish）。');
      return lines.join('\n');
    }
    lines.push(`【批次 ${input.batchIndex + 1}/${input.batchTotal}】请处理以下 ${input.batch.length} 个源文档：`);
    lines.push('');
    lines.push('| objToken | 标题 | 相对路径 | 变更类型 |');
    lines.push('|---|---|---|---|');
    for (const token of input.batch) {
      const entry = input.snapshot.get(token);
      const changeType = input.workset.get(token) ?? 'changed';
      lines.push(`| ${token} | ${entry?.title ?? token} | ${entry?.relPath ?? ''} | ${changeType === 'rebuild' ? '重新构建' : changeType} |`);
    }
    lines.push('');
    if (input.affectedDocs.length > 0) {
      lines.push(`受影响的已有标准文档（其来源在本批或已删除，需要修订或重写）：`);
      for (const doc of input.affectedDocs.slice(0, 200)) {
        lines.push(`- ${doc.path}（${doc.title}）`);
      }
      lines.push('');
    }
    lines.push('要求：');
    lines.push('1. 立即开始调用工具（先 raw_read 逐个读取），不要只回复文本计划。');
    lines.push('2. 读完本批全部源后，把内容重组为标准文档：合并相关源、消除重复、按主题分篇；已有草稿可用 draft_read 查看后覆盖。');
    lines.push('3. 用 kb_write_doc 写入草稿（每篇都要声明 sources）。');
    lines.push('4. 处理完本批即可，无需调用 kb_finish（最后一批后单独提示）。');
    return lines.join('\n');
  }

  /** 拉起（或按 worker 复用）构建 worker 进程：slot 已由调用方持有。
   * T2b：可选 roleModel——按冻结 BuildSpec 角色解析的模型注入（审查/
   * 整合/最终复核独立模型，B 案 §3）；缺省沿用活跃模型逻辑。 */
  private async spawnWorkerProcess(input: {
    buildId: string;
    entry: InMemoryBuild;
    buildState: BuildRunState;
    worker: WorkerRuntime;
    pluginSnapshot?: AppPluginSnapshot;
    slot?: PoolSlot;
    /** T2b：角色模型覆盖（model/apiKey/providerJson/thinking） */
    roleModel?: { model: string; apiKey?: string; providerJson?: string; thinking?: string } | null;
  }): Promise<void> {
    const config = this.configForBuild(input.buildId);
    const runtime = await this.deps.resolver.resolveRuntime(config.agent);
    if (!runtime.nodePath || (config.agent.runtime.backend !== 'claude-code' && !runtime.piCliPath)) {
      throw new ToolError('agent_not_ready', 'Agent 运行时未就绪', 503);
    }
    const { worker } = input;
    const { token, context } = this.deps.toolService.createRunContext({
      runKind: 'build',
      buildId: input.buildId,
      outputRoot: config.standardKb.outputRoot,
      knowledgeBaseRoot: config.knowledgeBaseRoot,
      buildState: input.buildState,
      worker: { workerId: worker.workerId, unitId: worker.unitId, phase: worker.phase ?? (worker.workerId === 'final' ? 'final' : 'unit') },
      onEvent: (event) => {
        this.emitBuild(input.buildId, 'tool', {
          phase: event.phase,
          toolName: event.toolName,
          summary: event.argsSummary || event.resultSummary || '',
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          workerId: worker.workerId,
          ...(worker.unitId ? { unitId: worker.unitId } : {}),
        });
      },
    });
    worker.token = token;
    worker.context = context as import('../agent/agent-tool-service.js').InternalRunContext;

    if (config.agent.runtime.backend === 'claude-code') {
      let rpc: PiRpcProcess | undefined;
      try {
        rpc = createClaudeProcess({ config, nodePath: runtime.nodePath, token, sessionId: `build:${input.buildId}:${worker.workerId}`,
          dataRoot: this.deps.dataRoot, internalBaseUrl: this.deps.internalBaseUrl(), toolService: this.deps.toolService,
          pluginSnapshot: input.pluginSnapshot, ephemeral: true });
        rpc.once('exit', () => this.deps.toolService.revokeToken(token));
        await rpc.start(); this.deps.pool.register(worker.poolKey, rpc, 'build', input.slot);
        worker.rpc = rpc;
        return;
      } catch (error) { input.slot?.release(); await rpc?.terminate().catch(() => undefined); this.deps.toolService.revokeToken(token); throw error; }
    }

    let model: string;
    let apiKey: string | undefined;
    let providerJson: string | undefined;
    let thinkingLevel: string = config.agent.model.thinkingLevel;
    const dropToken = () => this.deps.toolService.revokeToken(token);
    if (input.roleModel) {
      // T2b（B 案 §3/§8）：角色模型——密钥只进子进程 env，不入日志/构建记录
      model = input.roleModel.model;
      apiKey = input.roleModel.apiKey;
      providerJson = input.roleModel.providerJson;
      if (input.roleModel.thinking) thinkingLevel = input.roleModel.thinking;
    } else if (config.agent.model.source === 'app-llm') {
      // F3-R03：与 probe/会话共用 provider descriptor 单一实现
      const runConfig = buildAppLlmRunConfig(config.llm, config.agent);
      if (!runConfig || !runConfig.apiKey) {
        input.slot?.release();
        dropToken();
        throw new ToolError('agent_not_ready', 'app-llm 模型未配置或缺少 API Key', 503);
      }
      model = runConfig.model;
      apiKey = runConfig.apiKey;
      providerJson = runConfig.providerJson;
    } else {
      const piModel = config.agent.model.piModel?.trim();
      if (!piModel) {
        input.slot?.release();
        dropToken();
        throw new ToolError('agent_not_ready', 'pi-agent-dir 模式下未配置模型', 503);
      }
      model = piModel;
    }

    const env = buildPiProcessEnv({
      mode: config.agent.model.source,
      parentEnv: process.env,
      dataRoot: this.deps.dataRoot,
      agentUrl: this.deps.internalBaseUrl(),
      runToken: token,
      apiKey,
    });
    if (providerJson) env.FEISHU_SYNC_AGENT_PROVIDER_JSON = providerJson;
    // T2b：角色模型在 pi-agent-dir 模式下也必须注入密钥（提供方描述符已解析）
    if (input.roleModel?.apiKey) env.FEISHU_SYNC_AGENT_API_KEY = input.roleModel.apiKey;
    if (input.pluginSnapshot) {
      env.FEISHU_SYNC_AGENT_PLUGIN_SNAPSHOT = input.pluginSnapshot.path;
      env.FEISHU_SYNC_AGENT_PLUGIN_REVISION = input.pluginSnapshot.revision;
      if (input.pluginSnapshot.externalPlugins) env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS = '1';
    }
    env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot ?? '';
    const extensionPath = this.deps.extensionPath();
    const spawnOptions = {
      nodePath: runtime.nodePath,
      piCliPath: runtime.piCliPath!,
      ...(extensionPath ? { extensionPath } : {}),
      ...(input.pluginSnapshot ? {
        additionalExtensionPaths: input.pluginSnapshot.extensionPaths ?? [input.pluginSnapshot.extensionPath],
        allowExternalPluginTools: input.pluginSnapshot.externalPlugins,
        additionalSkillPaths: input.pluginSnapshot.skillPaths,
        additionalPromptPaths: input.pluginSnapshot.promptPaths,
        additionalThemePaths: input.pluginSnapshot.themePaths,
      } : {}),
      tools: toolsForRunKind('build'),
      noSession: true,
      model,
      thinking: thinkingLevel,
      cwd: path.join(this.deps.dataRoot, 'agent', 'empty-cwd'),
      env,
      promptTimeoutMs: config.standardKb.promptTimeoutMinutes * 60_000,
    };
    const rpc = this.deps.processFactory ? this.deps.processFactory(spawnOptions) : new PiRpcProcess(spawnOptions);
    // F3-R05：任何退出路径（正常/取消/超时/崩溃/池回收）都回收令牌。
    rpc.once('exit', () => this.deps.toolService.revokeToken(token));
    try {
      await rpc.start();
      await rpc.sendCommand('set_auto_retry', { enabled: false }).catch(() => undefined);
      this.deps.pool.register(worker.poolKey, rpc, 'build', input.slot);
    } catch (error) {
      input.slot?.release();
      await rpc.terminate().catch(() => undefined);
      dropToken();
      throw error;
    }
    worker.rpc = rpc;
  }

  /** 首个槽位受整体超时约束（§4.5：拿不到 → failed agent_busy）；其后排队只受取消。
   * T2a：走 build 通道（B 案 §6 独立 N 路，不受 maxConcurrentProcesses 截断）。 */
  private async acquireWorkerSlot(input: {
    entry: InMemoryBuild;
    cancelController: AbortController;
    slotDeadlineMs: number;
    slotObtained: () => boolean;
  }): Promise<PoolSlot> {
    const acquiring = this.deps.pool.acquire('build', { signal: input.cancelController.signal });
    if (input.slotObtained()) return await acquiring;
    const remaining = input.slotDeadlineMs - Date.now();
    if (remaining <= 0) {
      input.cancelController.abort();
      acquiring.catch(() => undefined);
      throw new AgentBusyError('构建整体超时内未能获得进程槽位');
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (input.slotObtained()) return;
        input.cancelController.abort();
        reject(new AgentBusyError('构建整体超时内未能获得进程槽位'));
      }, remaining);
      timer.unref?.();
    });
    try {
      return await Promise.race([acquiring, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** worker 主循环：拉取下一单元（LPT 序）→ 单元内批次串行 → 保持进程等待收尾轮复用。 */
  private async runUnitsPhase(input: {
    buildId: string;
    entry: InMemoryBuild;
    buildState: BuildRunState;
    units: BuildUnit[];
    workerCount: number;
    pluginSnapshot?: AppPluginSnapshot;
    snapshot: RawSourceSnapshot;
    workset: Map<string, 'added' | 'changed' | 'rebuild'>;
    sourceChanges: KbFileChange[];
    systemRules: string;
    promptTimeoutMs: number;
    cancelController: AbortController;
    slotDeadlineMs: number;
    /** P2-S2：每批有效字数预算（0 = 旧行为按源数切分） */
    wordBudget: number;
    /** P2-S2：objToken → 有效字数（worksetMeta） */
    wordsOf: (token: string) => number;
  }): Promise<void> {
    const { entry, buildState } = input;
    if (buildState.finishInfo) return;
    const units = input.units.filter((unit) => !buildState.unitDone?.has(unit.id));
    if (!units.length) return;
    let cursor = 0;
    const unitProgress = entry.unitProgress; // 持久化已完成批次，重启后继续。
    for (const unit of units) if (!unitProgress.has(unit.id)) unitProgress.set(unit.id, 0);
    const retriedUnits = new Set<string>();
    let globalFailure: Error | null = null;
    let slotObtained = false;

    const abortEverything = () => {
      input.cancelController.abort();
      for (const worker of entry.workers.values()) {
        if (worker.rpc && !worker.rpc.isExited()) void worker.rpc.abort();
      }
    };
    const failAll = (cause: unknown) => {
      if (!globalFailure) globalFailure = cause instanceof Error ? cause : new Error(String(cause));
      abortEverything();
    };

    const normalizeWorkerError = (error: unknown): Error => {
      if (error instanceof Error && error.name === 'AbortError' && input.cancelController.signal.aborted) {
        return new CancelledError();
      }
      return error instanceof Error ? error : new Error(String(error));
    };

    const runUnitOnWorker = async (worker: WorkerRuntime, unit: BuildUnit): Promise<void> => {
      entry.units.running += 1;
      this.emitUnits(input.buildId);
      this.setWorkerAssignment(worker, unit.id);
      // T2a：编排骨架——单元开跑（queued→running）
      this.markOrchestration(input.buildId, (orchestration) => {
        if (orchestration.task(`t:${unit.id}`)?.execState === 'queued') orchestration.updateExecState(`t:${unit.id}`, 'running');
      });
      try {
        const attempt = async (isRetry: boolean) => {
          // 进程按需拉起 / 重试时回收重建（认领不释放：PathClaims 首写者持有）
          if (!worker.rpc || worker.rpc.isExited()) {
            if (!worker.slot) {
              worker.slot = await this.acquireWorkerSlot({
                entry: input.entry,
                cancelController: input.cancelController,
                slotDeadlineMs: input.slotDeadlineMs,
                slotObtained: () => slotObtained,
              });
            }
            await this.spawnWorkerProcess({ buildId: input.buildId, entry: input.entry, buildState, worker, pluginSnapshot: input.pluginSnapshot, slot: worker.slot });
            worker.slot = null; // 已被 register 消费
          }
          const batches = unit.batches;
          for (let index = unitProgress.get(unit.id) ?? 0; index < batches.length; index += 1) {
            if (entry.cancelRequested || globalFailure) throw new CancelledError();
            worker.state = 'running';
            worker.unitBatchIndex = index;
            worker.unitBatchTotal = batches.length;
            this.emitWorker(input.buildId, worker);
            // P2-S2（§2.3）：预算开启时每批补一行字数日志（含单元归属）
            if (input.wordBudget > 0) {
              const batchWords = batches[index].reduce((sum, token) => sum + input.wordsOf(token), 0);
              this.emitLog(
                input.buildId,
                'info',
                `unit ${unit.id} batch ${index + 1}/${batches.length}: sources=${batches[index].length}, words=${batchWords}`,
              );
            }
            const batchPrompt = this.buildUnitBatchPrompt({
              unit,
              batch: batches[index],
              batchIndex: index,
              batchTotal: batches.length,
              snapshot: input.snapshot,
              workset: input.workset,
              sourceChanges: input.sourceChanges,
              isRetry,
              claimedDocs: buildState.claims?.ownedBy(unit.id) ?? [],
            });
            const continuation = entry.resume ? '这是断点继续：已完成单元/批次不重复执行。请用 draft_list/draft_read 检查本单元已恢复的完整草稿，保留结果并补齐未完成内容。\n\n' : '';
            const outcome = await worker.rpc!.prompt(
              continuation + (input.systemRules ? `${batchPrompt}\n\n---\n构建规则与文风规范（每批适用）：\n${input.systemRules}` : batchPrompt),
              { timeoutMs: input.promptTimeoutMs },
            );
            if (entry.cancelRequested && outcome.outcome !== 'completed') throw new CancelledError();
            if (outcome.outcome === 'aborted') throw new CancelledError();
            if (outcome.outcome === 'failed') {
              throw new ToolError(
                outcome.error?.code ?? 'model_request_failed',
                `单元 ${unit.id} 批次 ${index + 1} 失败：${outcome.error?.message ?? '未知错误'}`,
                502,
              );
            }
            // F3-R08：源变更毒化不可恢复——批次边界立即失败
            this.throwIfPoisoned(buildState);
            unitProgress.set(unit.id, index + 1);
            entry.batchIndex += 1;
            this.persistCheckpoint(input.buildId);
          }
          // 单元末批后必须有 kb_unit_done（一次纠正，仍无即单元失败）
          if (!buildState.unitDone?.has(unit.id)) {
            this.emitBuild(input.buildId, 'build_log', { level: 'warn', message: `单元 ${unit.id} 未调用 kb_unit_done，发送纠正提示`, workerId: worker.workerId, unitId: unit.id, at: new Date().toISOString() });
            const corrected = await worker.rpc!.prompt(
              `本单元（${unit.id}）的全部批次已处理完。系统未检测到 kb_unit_done 调用。现在请直接调用 kb_unit_done 工具：summary 填写本单元总结；本单元未被任何文档引用的源逐个列入 skipped（objToken 须属本单元）。不要输出文本，直接发起工具调用。`,
              { timeoutMs: input.promptTimeoutMs },
            );
            if (corrected.outcome === 'aborted') throw new CancelledError();
            if (corrected.outcome === 'failed') {
              throw new ToolError(corrected.error?.code ?? 'model_request_failed', `单元 ${unit.id} 的 kb_unit_done 纠正轮失败：${corrected.error?.message ?? '未知错误'}`, 502);
            }
            if (!buildState.unitDone?.has(unit.id)) {
              throw new ToolError('kb_unit_failed', `单元 ${unit.id} 在纠正提示后仍未调用 kb_unit_done`, 400);
            }
          }
        };
        try {
          await attempt(false);
        } catch (error) {
          const code = error instanceof ToolError ? error.code : '';
          const retryable = code === 'model_timeout' || code === 'model_request_failed' || code === 'pi_process_exited' || code === 'pi_transport_failed';
          if (!retryable || retriedUnits.has(unit.id)) throw error;
          retriedUnits.add(unit.id);
          entry.units.retried += 1;
          // T2a（B 案 §5）：接口失败与内容不通过分开计数——可重试模型错误
          // 记接口失败，不消耗修订预算
          this.markOrchestration(input.buildId, (orchestration) => {
            orchestration.recordInterfaceFailure(`t:${unit.id}`);
          });
          this.emitBuild(input.buildId, 'build_log', { level: 'warn', message: `单元 ${unit.id} 失败（${code}），自动重试 1 次（从首个未完成批次续跑，已认领文档不释放）`, at: new Date().toISOString() });
          if (worker.rpc) {
            await this.deps.pool.terminate(worker.poolKey).catch(() => undefined);
            worker.rpc = null;
            worker.token = null;
          }
          await attempt(true);
        }
        entry.units.done += 1;
        // T2a：单元完成——exec done + 产物可用（内容验收轴由 T2b 审查流水推进）
        this.markOrchestration(input.buildId, (orchestration) => {
          const taskId = `t:${unit.id}`;
          const task = orchestration.task(taskId);
          if (task && task.execState !== 'done') {
            if (task.execState === 'queued') orchestration.updateExecState(taskId, 'running');
            orchestration.submitResult({ taskId, revision: task.revision, artifactState: 'available', resultRef: `unit:${unit.id}:done` });
          }
        });
        this.persistCheckpoint(input.buildId);
        this.emitUnits(input.buildId);
      } catch (error) {
        entry.units.failed += 1;
        this.emitUnits(input.buildId);
        // S4（§8）：单元失败统一包装 kb_unit_failed（details.unitId + 引发码）；
        // 取消不包装（外层按 cancelled 落地）。
        if (error instanceof CancelledError) throw error;
        if (error instanceof ToolError && error.code === 'kb_unit_failed') throw error;
        const causeCode = error instanceof ToolError ? error.code : 'kb_build_failed';
        const causeMessage = error instanceof Error ? error.message : String(error);
        const wrapped = new ToolError(
          'kb_unit_failed',
          `单元 ${unit.id} 失败（${causeCode}）：${causeMessage}`,
          500,
        );
        (wrapped as ToolError & { details?: unknown }).details = { unitId: unit.id, cause: causeCode };
        throw wrapped;
      } finally {
        entry.units.running -= 1;
        this.setWorkerAssignment(worker, null);
        worker.unitBatchIndex = 0;
        worker.unitBatchTotal = 0;
        this.emitUnits(input.buildId);
      }
    };

    const runWorker = async (workerId: string): Promise<void> => {
      const worker: WorkerRuntime = {
        workerId,
        poolKey: `build:${input.buildId}:${workerId}`,
        slot: null,
        rpc: null,
        token: null,
        context: null,
        state: 'waiting_slot',
        unitId: null,
        unitBatchIndex: 0,
        unitBatchTotal: 0,
        exited: false,
      };
      entry.workers.set(workerId, worker);
      this.emitWorker(input.buildId, worker);
      try {
        worker.slot = await this.acquireWorkerSlot({
          entry: input.entry,
          cancelController: input.cancelController,
          slotDeadlineMs: input.slotDeadlineMs,
          slotObtained: () => slotObtained,
        });
        slotObtained = true;
        while (!globalFailure && !entry.cancelRequested) {
          const unit = cursor < units.length ? units[cursor++] : null;
          if (!unit) break;
          await runUnitOnWorker(worker, unit);
        }
        worker.state = 'running'; // 队列耗尽：保持进程/槽位等待收尾轮复用
        this.emitWorker(input.buildId, worker);
      } catch (error) {
        if (!globalFailure && !(error instanceof CancelledError)) failAll(error);
        throw normalizeWorkerError(error);
      } finally {
        if (globalFailure || entry.cancelRequested) {
          worker.state = 'exited';
          worker.exited = true;
          this.emitWorker(input.buildId, worker);
        }
      }
    };

    const workerIds = Array.from({ length: input.workerCount }, (_, index) => `w${index + 1}`);
    const settled = await Promise.allSettled(workerIds.map(runWorker));
    if (globalFailure) throw globalFailure;
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) {
      const reason = rejected.reason;
      throw reason instanceof Error ? reason : new Error(String(reason));
    }
    // join 校验：全部单元 done
    for (const unit of units) {
      if (!buildState.unitDone?.has(unit.id)) {
        throw new ToolError('kb_unit_failed', `单元 ${unit.id} 未完成（无 kb_unit_done 上报）`, 400);
      }
    }
  }

  /** 收尾轮：复用最后存活 worker 进程，否则 acquire 后新拉 final 进程；kb_finish 单值。 */
  private async runFinalRound(input: {
    buildId: string;
    entry: InMemoryBuild;
    buildState: BuildRunState;
    units: BuildUnit[];
    pluginSnapshot?: AppPluginSnapshot;
    snapshot: RawSourceSnapshot;
    systemRules: string;
    promptTimeoutMs: number;
    cancelController: AbortController;
    slotDeadlineMs: number;
  }): Promise<void> {
    const { entry, buildState } = input;
    if (buildState.finishInfo) return;
    const reuse = [...entry.workers.values()]
      .filter((worker) => worker.rpc && !worker.rpc.isExited())
      .sort((a, b) => b.workerId.localeCompare(a.workerId))[0] ?? null;
    let worker = reuse;
    if (reuse) {
      reuse.state = 'finishing';
      this.emitWorker(input.buildId, reuse);
    } else {
      worker = {
        workerId: 'final',
        poolKey: `build:${input.buildId}:final`,
        slot: null,
        rpc: null,
        token: null,
        context: null,
        state: 'waiting_slot',
        unitId: null,
        unitBatchIndex: 0,
        unitBatchTotal: 0,
        exited: false,
      };
      entry.workers.set(worker.workerId, worker);
      this.emitWorker(input.buildId, worker);
      worker.slot = await this.acquireWorkerSlot({ ...input, slotObtained: () => true });
      await this.spawnWorkerProcess({ ...input, buildState, worker, slot: worker.slot });
      worker.slot = null;
      worker.state = 'finishing';
      this.emitWorker(input.buildId, worker);
    }
    this.setWorkerAssignment(worker, null, 'final');

    const crossUnitDocs: string[] = [];
    for (const unit of input.units) {
      for (const docPath of buildState.claims?.ownedBy(unit.id) ?? []) {
        crossUnitDocs.push(`- ${docPath}${buildState.docMeta?.get(docPath)?.title ? `（${buildState.docMeta.get(docPath)!.title}）` : ''} — 单元 ${unit.id}`);
      }
    }
    const summaries = input.units.map((unit) => {
      const report = buildState.unitDone?.get(unit.id);
      return `- ${unit.id}（源 ${unit.sources.length} 个）：${report?.summary?.slice(0, 500) ?? '（无摘要）'}`;
    });
    const finishPrompt = [
      ...this.resumeValidationFeedback(entry),
      ...this.finishCoverage(buildState),
      '全部构建单元已完成，进入整体收尾轮。各单元摘要：',
      ...summaries,
      '',
      ...(crossUnitDocs.length > 0
        ? ['本构建各单元写入/认领的文档（可读取任意草稿后合并重复主题；本轮写入不受路径限制）：', ...crossUnitDocs.slice(0, 300), '']
        : []),
      '请先完成跨单元合并与去重（如无必要不要重写全部文档），然后【立即调用 kb_finish 工具】完成构建：',
      '- summary：本次构建的整体总结（做了什么、产出哪些主题文档、做了哪些跨单元合并）。',
      '- skipped：工作集中未被任何文档引用的源，逐个列出 objToken 与理由（全构建范围，不限于某一单元）。',
      '注意：必须调用工具本身（tool call），不要只回复文本说明。',
    ].join('\n');
    const rpc = worker.rpc!;
    let outcome = await rpc.prompt(
      input.systemRules ? `${finishPrompt}\n\n---\n构建规则与文风规范（每批适用）：\n${input.systemRules}` : finishPrompt,
      { timeoutMs: input.promptTimeoutMs },
    );
    if (outcome.outcome === 'aborted') throw new CancelledError();
    if (outcome.outcome === 'failed') {
      throw new ToolError(outcome.error?.code ?? 'model_request_failed', `kb_finish 阶段失败：${outcome.error?.message ?? '未知错误'}`, 502);
    }
    if (!buildState.finishInfo) {
      this.emitLog(input.buildId, 'warn', '未检测到 kb_finish 调用，发送强制纠正提示');
      outcome = await rpc.prompt(
        '系统检测到你没有调用 kb_finish 工具（工具调用记录为空）。现在请直接调用 kb_finish 工具：summary 填写构建总结；如果此前未写任何文档，skipped 列出全部源并说明理由。不要输出任何文本，直接发起工具调用。',
        { timeoutMs: input.promptTimeoutMs },
      );
      if (outcome.outcome === 'aborted') throw new CancelledError();
      if (outcome.outcome === 'failed') {
        throw new ToolError(outcome.error?.code ?? 'model_request_failed', `kb_finish 纠正阶段失败：${outcome.error?.message ?? '未知错误'}`, 502);
      }
    }
  }

  /** S4（§4.5）：终止本构建全部进程（含收尾轮），并释放未消费槽位。 */
  private async terminateAllWorkers(buildId: string, entry: InMemoryBuild): Promise<void> {
    for (const worker of entry.workers.values()) {
      if (worker.slot) {
        worker.slot.release();
        worker.slot = null;
      }
      await this.deps.pool.terminate(worker.poolKey).catch(() => undefined);
      if (worker.rpc && !worker.rpc.isExited()) {
        await worker.rpc.terminate().catch(() => undefined);
      }
      worker.rpc = null;
      worker.state = 'exited';
      worker.exited = true;
    }
    this.deps.toolService.revokeByBuild(buildId);
  }

  /** 单元批次提示词（§4.2/§4.4：单元语境 + 本单元源表 + 受影响文档 + 单元收尾提示）。 */
  private buildUnitBatchPrompt(input: {
    unit: BuildUnit;
    batch: string[];
    batchIndex: number;
    batchTotal: number;
    snapshot: RawSourceSnapshot;
    workset: Map<string, 'added' | 'changed' | 'rebuild'>;
    sourceChanges?: KbFileChange[];
    isRetry: boolean;
    claimedDocs: string[];
  }): string {
    const { unit } = input;
    const lines: string[] = [];
    lines.push('正文必须为当前规则的完整说明。下面的diff只用于判断要更新什么；禁止把修订记录、本次改动、上版/本版对比或版本号写进正文。变更说明只填kb_unit_done/kb_finish的summary。');
    lines.push('若草稿中已有标准文档，须保留本单元工作范围之外的文档与来源；相关内容在既有正文基础上更新，不能用本单元文档替代整个知识库。');
    for (const change of input.sourceChanges ?? []) {
      if (!input.batch.includes(change.key) && change.kind !== 'removed') continue;
      lines.push(`源差异 ${change.key}（${change.title}）：${change.kind}${change.reason === 'excluded' ? '，用户标记为不参与构建' : ''}`);
      lines.push('<untrusted_source_diff>');
      lines.push(change.beforeAvailable ? (change.patch.slice(0, 8000) || '原文未变，仅路径/标题变化') : '历史版本只保存hash，未保存旧原文；必须读取当前完整源文档，不推测历史差异。');
      if (change.truncated || change.patch.length > 8000) lines.push('差异展示已截断；以raw_read当前全文为准。');
      lines.push('</untrusted_source_diff>');
    }
    if (input.isRetry) {
      lines.push(`【重试】单元 ${unit.id} 此前失败，从本批继续。本单元已认领的文档（继续改写这些路径，不要换路径）：`);
      for (const docPath of input.claimedDocs.slice(0, 200)) lines.push(`- ${docPath}`);
      lines.push('');
    }
    if (input.batch.length === 0) {
      // F3-R07：仅 removed 的增量——空单元也要明确告知删除与受影响文档
      lines.push(`【单元 ${unit.id} · 批次 ${input.batchIndex + 1}/${input.batchTotal}】本次构建没有新增或变更的源，但有源被删除：`);
      lines.push('');
      lines.push('以下文档受到源移除/排除影响：仅引用已移除源的文档已默认删除；其余仍在草稿中，必须读取保留的源后重新写出完整正文并修正sources：');
      for (const doc of unit.affectedDocs.slice(0, 200)) {
        lines.push(`- ${doc.path}（${doc.title}${doc.deletedByDefault ? '，已默认删除，可重建' : ''}）`);
      }
      lines.push('');
      lines.push('要求：');
      lines.push('1. 检查删除后是否仍有主题需要保留：若某主题还承载未删除源的内容，用 kb_write_doc 重建或修订对应文档（sources 声明现存的源）。');
      lines.push('2. 若删除后无需任何重建，不写文档，直接调用 kb_unit_done 结束本单元。');
      return lines.join('\n');
    }
    lines.push(`【单元 ${unit.id} · 批次 ${input.batchIndex + 1}/${input.batchTotal}】请处理以下 ${input.batch.length} 个源文档（本单元共 ${unit.sources.length} 个源；其余单元由其他进程并行处理，不要试图处理）：`);
    lines.push('');
    lines.push('| objToken | 标题 | 相对路径 | 变更类型 |');
    lines.push('|---|---|---|---|');
    for (const token of input.batch) {
      const entry = input.snapshot.get(token);
      const changeType = input.workset.get(token) ?? 'changed';
      lines.push(`| ${token} | ${entry?.title ?? token} | ${entry?.relPath ?? ''} | ${changeType === 'rebuild' ? '重新构建' : changeType} |`);
    }
    lines.push('');
    if (unit.affectedDocs.length > 0) {
      lines.push('受影响的已有标准文档（其来源在本单元或已删除，需要修订或重写；本单元已预认领这些路径）：');
      for (const doc of unit.affectedDocs.slice(0, 200)) {
        lines.push(`- ${doc.path}（${doc.title}${doc.deletedByDefault ? '，已默认删除，可重建' : ''}）`);
      }
      lines.push('');
    }
    lines.push('要求：');
    lines.push('1. 立即开始调用工具（先 raw_read 逐个读取；raw_list filter=workset 只列本单元源），不要只回复文本计划。');
    lines.push('2. 读完本批全部源后，把内容重组为标准文档：合并相关源、消除重复、按主题分篇；已有草稿可用 draft_read 查看后覆盖（只能写本单元认领的路径）。');
    lines.push('3. 用 kb_write_doc 写入草稿（每篇都要声明 sources）。');
    lines.push(input.batchIndex + 1 >= input.batchTotal
      ? '4. 本批是本单元最后一批：处理完后请调用 kb_unit_done（summary + 本单元未被引用源的 skipped）。'
      : `4. 处理完本批即可（共 ${input.batchTotal} 批），最后一批后系统会提示调用 kb_unit_done。`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------------
  // T2b（B 案 §3–§5/§7/§8）：编排流水执行——单元写→独立审查→定向修订
  // →整体整合→最终复核→发布条件。仅审查者显式配置的构建启用
  // （reviewPipelineActive）；旧式构建路径与行为不变。
  // ------------------------------------------------------------------

  /** 审查规则提示词（B 案 §3 审查规范；deps 可覆盖，缺省读内置资产）。 */
  private reviewRulesText(): string {
    const injected = this.deps.reviewPrompt?.() ?? null;
    if (injected && injected.trim()) return injected;
    const fromAssets = readAgentPromptFile('standard-kb-review.md');
    if (fromAssets) return fromAssets;
    return '你是标准知识库构建的独立审查者。对照冻结源材料检查草稿，经 kb_submit_review 提交审查报告；你没有草稿写入口。问题分 blocking/suggestion，blocking 必须带草稿位置与源位置；未检查范围如实声明。';
  }

  /**
   * 编排调度主循环（B 案 §4）：sync 派生任务 → readyTasks 按 N 路容量
   * 拉起 → 等任一完成 → 重复；无在造任务且非全部通过时按停滞失败。
   */
  private async runOrchestratedPhase(input: OrchestratedPhaseInput): Promise<void> {
    const { entry, buildState } = input;
    const orchestration = entry.orchestration!;
    // B 案 §8：恢复重开已结束的编排（后继任务续跑）；待裁定单元经人工
    // 处理后续作 → 回未审（重新审查，不消耗自动修订预算；预算只在创建
    // 修订任务时消耗，B 案 §5「人工继续处理属于一次明确的续作」）。
    if (entry.resume && orchestration.ended) orchestration.reopen('resume');
    if (entry.resume) {
      for (const task of orchestration.tasks) {
        if ((task.role === 'write' || task.role === 'integrate') && task.acceptanceState === 'pending_decision') {
          orchestration.updateAcceptanceState(task.taskId, 'unreviewed');
          this.emitLog(input.buildId, 'info', `任务 ${task.taskId} 待裁定已人工处理，重新进入审查（B 案 §5）`);
        }
      }
    }
    let slotObtained = false;
    const slotObtainedRef = () => slotObtained;
    const inflight = new Map<string, Promise<{ ok: true } | { ok: false; error: unknown }>>();
    for (;;) {
      if (entry.cancelRequested) throw new CancelledError();
      this.syncOrchestrationTasks(input);
      const ready = orchestration.readyTasks().filter((task) => !inflight.has(task.taskId));
      for (const task of ready) {
        if (inflight.size >= input.workerCount) break;
        const run = (async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
          try {
            await this.executeOrchestratedTask({ ...input, task, slotObtained: slotObtainedRef });
            return { ok: true };
          } catch (error) {
            return { ok: false, error };
          } finally {
            inflight.delete(task.taskId);
          }
        })();
        inflight.set(task.taskId, run);
      }
      if (inflight.size === 0) break;
      const settled = await Promise.race([...inflight.values()]);
      slotObtained = true;
      if (!settled.ok) throw settled.error;
    }
    if (entry.cancelRequested) throw new CancelledError();
    // 收尾校验：全部单元通过 + 整合通过（否则为停滞/未闭环，如实失败）
    const latestWrites = this.latestWriteTasks(orchestration, input.units);
    for (const [unitId, task] of latestWrites) {
      if (!task || task.acceptanceState !== 'passed') {
        throw new ToolError('kb_pipeline_stalled', `单元 ${unitId} 未达到内容验收通过（当前 ${task ? task.acceptanceState : '任务缺失'}），流水无法继续`, 500);
      }
    }
    const integrates = orchestration.tasks.filter((t) => parseOrchestrationTaskId(t.taskId)?.kind === 'integrate');
    const latestIntegrate = integrates[integrates.length - 1];
    if (!latestIntegrate || latestIntegrate.acceptanceState !== 'passed') {
      throw new ToolError('kb_pipeline_stalled', `整体整合未达到内容验收通过（当前 ${latestIntegrate ? latestIntegrate.acceptanceState : '任务缺失'}）`, 500);
    }
    void buildState;
  }

  /** 每单元最新的 write 任务（含修订轮；含 #attempt 后继）。 */
  private latestWriteTasks(orchestration: BuildOrchestration, units: BuildUnit[]): Map<string, BuildTask | null> {
    const result = new Map<string, BuildTask | null>();
    for (const unit of units) {
      const rounds = orchestration.tasks
        .filter((t) => {
          const ref = parseOrchestrationTaskId(t.taskId);
          return ref?.kind === 'write' && ref.unitId === unit.id;
        })
        .sort((a, b) => compareTaskOrder(a.taskId, b.taskId));
      result.set(unit.id, rounds[rounds.length - 1] ?? null);
    }
    return result;
  }

  /**
   * 派生任务同步（B 案 §4/§7 依赖解锁）：写完→审；审过→标 passed；
   * blocking→修订（预算内）；全部通过→整合；整合完成→最终复核；
   * 终态但未闭环的任务（取消/崩溃恢复）补 #attempt 后继。幂等。
   */
  private syncOrchestrationTasks(input: OrchestratedPhaseInput): void {
    const orchestration = input.entry.orchestration!;
    const stagingRoot = input.buildState.stagingRoot;
    for (const unit of input.units) {
      const latest = this.latestWriteTasks(orchestration, [unit]).get(unit.id) ?? null;
      let target = latest;
      if (!target) {
        target = orchestration.createTask({
          taskId: `t:write:${unit.id}:r0`,
          revision: 0,
          role: 'write',
          unitId: unit.id,
          reviewSubjectDraftHash: null,
          inputRefs: unit.sources.map((token) => `raw:${token}`),
          dependencies: [],
          allowedWritePaths: [...unit.ownedDocs],
          outputRequirements: `单元 ${unit.id}：${unit.batches.length} 批草稿写入与 kb_unit_done 上报`,
        });
        continue;
      }
      const ref = parseOrchestrationTaskId(target.taskId)!;
      if (target.execState === 'cancelled' || target.execState === 'failed') {
        // 断点续跑：同轮次后继任务（批次进度由 unitProgress 保留）
        const baseId = `t:write:${unit.id}:r${ref.round}`;
        orchestration.createTask({
          taskId: nextAttemptTaskId(orchestration, baseId),
          revision: ref.round,
          role: 'write',
          unitId: unit.id,
          reviewSubjectDraftHash: null,
          inputRefs: unit.sources.map((token) => `raw:${token}`),
          dependencies: [],
          allowedWritePaths: [...unit.ownedDocs],
          outputRequirements: `单元 ${unit.id} 断点续跑（后继尝试）`,
        });
        continue;
      }
      // 写完（产物可用）且未闭环 → 建审查任务（B 案 §7：撰写完成且产物
      // 可用后解锁审查；报告缺失不能解锁下游）
      const roundReviews = orchestration.tasks.filter((t) => {
        const r = parseOrchestrationTaskId(t.taskId);
        return r?.kind === 'review' && r.unitId === unit.id && r.round === ref.round;
      });
      const activeReview = roundReviews.some((t) => t.execState === 'queued' || t.execState === 'running');
      const acceptance = target.acceptanceState as string;
      const concluded = acceptance === 'passed' || acceptance === 'pending_decision'
        || orchestration.tasks.some((t) => {
          const r = parseOrchestrationTaskId(t.taskId);
          return r?.kind === 'write' && r.unitId === unit.id && r.round === ref.round + 1;
        });
      if (target.artifactState === 'available' && !activeReview && !concluded
        && (acceptance === 'unreviewed' || acceptance === 'needs_revision')) {
        const scopePaths = this.unitScopePaths(input.buildState, unit);
        orchestration.createTask({
          taskId: nextAttemptTaskId(orchestration, `t:review:${unit.id}:r${ref.round}`),
          revision: ref.round,
          role: 'review',
          unitId: unit.id,
          reviewSubjectDraftHash: KbBuildService.reviewSubjectHash(stagingRoot, scopePaths),
          inputRefs: [`drafts:${scopePaths.join(',') || unit.id}`, ...unit.sources.map((token) => `raw:${token}`)],
          dependencies: [{ taskId: target.taskId, requires: 'artifact_available' }],
          allowedWritePaths: [],
          outputRequirements: `单元 ${unit.id} 第 ${ref.round + 1} 轮独立审查（kb_submit_review）`,
        });
      }
    }
    // 全部单元通过 → 整合（B 案 §4：全部通过后整体整合才开始）
    const latestWrites = this.latestWriteTasks(orchestration, input.units);
    const allPassed = input.units.length > 0 && [...latestWrites.values()].every((t) => t?.acceptanceState === 'passed');
    if (allPassed) {
      const integrates = orchestration.tasks
        .filter((t) => parseOrchestrationTaskId(t.taskId)?.kind === 'integrate')
        .sort((a, b) => compareTaskOrder(a.taskId, b.taskId));
      const latestIntegrate = integrates[integrates.length - 1] ?? null;
      if (!latestIntegrate) {
        orchestration.createTask({
          taskId: 't:integrate:r0',
          revision: 0,
          role: 'integrate',
          unitId: null,
          reviewSubjectDraftHash: null,
          inputRefs: [...latestWrites.values()].map((t) => `task:${t!.taskId}`),
          dependencies: [...latestWrites.values()].map((t) => ({ taskId: t!.taskId, requires: 'acceptance_passed' as const })),
          allowedWritePaths: [],
          outputRequirements: '跨单元合并去重 + kb_finish 整体收尾（B 案 §4）',
        });
      } else {
        const intRef = parseOrchestrationTaskId(latestIntegrate.taskId)!;
        if (latestIntegrate.execState === 'cancelled' || latestIntegrate.execState === 'failed') {
          orchestration.createTask({
            taskId: nextAttemptTaskId(orchestration, `t:integrate:r${intRef.round}`),
            revision: intRef.round,
            role: 'integrate',
            unitId: null,
            reviewSubjectDraftHash: null,
            inputRefs: [`task:${latestIntegrate.taskId}`],
            dependencies: [],
            allowedWritePaths: [],
            outputRequirements: '整合断点续跑（后继尝试）',
          });
        } else if (latestIntegrate.artifactState === 'available'
          && (latestIntegrate.acceptanceState === 'unreviewed' || latestIntegrate.acceptanceState === 'needs_revision')) {
          const finals = orchestration.tasks.filter((t) => parseOrchestrationTaskId(t.taskId)?.kind === 'final');
          const activeFinal = finals.some((t) => t.execState === 'queued' || t.execState === 'running');
          const intAcceptance = latestIntegrate.acceptanceState as string;
          const concluded = intAcceptance === 'passed' || intAcceptance === 'pending_decision'
            || orchestration.tasks.some((t) => {
              const r = parseOrchestrationTaskId(t.taskId);
              return r?.kind === 'integrate' && r.round === intRef.round + 1;
            });
          if (!activeFinal && !concluded) {
            orchestration.createTask({
              taskId: nextAttemptTaskId(orchestration, `t:final:r${intRef.round}`),
              revision: intRef.round,
              role: 'final_review',
              unitId: null,
              reviewSubjectDraftHash: KbBuildService.reviewSubjectHash(stagingRoot, null),
              inputRefs: [`task:${latestIntegrate.taskId}`, 'drafts:all'],
              dependencies: [{ taskId: latestIntegrate.taskId, requires: 'artifact_available' }],
              allowedWritePaths: [],
              outputRequirements: '最终复核：跨单元矛盾/重复/合并遗漏/交叉引用（B 案 §4）',
            });
          }
        }
      }
    }
  }

  /**
   * 定向修订（write 轮次 ≥1，B 案 §5）：原撰写模型逐项回应问题清单并
   * 修订草稿；修订稿换版本后重新审查。修订不重置预算（T2a 骨架已冻结）。
   */
  private async runOrchestratedRevise(
    input: OrchestratedPhaseInput & { task: BuildTask },
    worker: WorkerRuntime,
    unit: BuildUnit,
    round: number,
  ): Promise<void> {
    const { entry, buildState, task } = input;
    const orchestration = entry.orchestration!;
    entry.stage = 'units';
    this.setWorkerAssignment(worker, unit.id, 'unit');
    const report = this.readReviewReportFile(buildState.stagingRoot, unit.id);
    if (!report) throw new ToolError('kb_review_report_missing', `修订轮 ${task.taskId} 找不到上一轮审查报告`);
    const prompt = this.buildRevisePrompt(unit.id, round, report);
    const outcome = await worker.rpc!.prompt(
      input.systemRules ? `${prompt}\n\n---\n构建规则与文风规范（适用）：\n${input.systemRules}` : prompt,
      { timeoutMs: input.promptTimeoutMs },
    );
    if (entry.cancelRequested && outcome.outcome !== 'completed') throw new CancelledError();
    if (outcome.outcome === 'aborted') throw new CancelledError();
    if (outcome.outcome === 'failed') {
      throw new ToolError(outcome.error?.code ?? 'model_request_failed', `单元 ${unit.id} 修订轮失败：${outcome.error?.message ?? '未知错误'}`, 502);
    }
    this.throwIfPoisoned(buildState);
    orchestration.submitResult({ taskId: task.taskId, revision: task.revision, artifactState: 'available', resultRef: `unit:${unit.id}:revise${round}` });
    this.persistCheckpoint(input.buildId);
  }

  /**
   * 独立单元审查（B 案 §4/§5）：新 worker/会话 + reviewer 模型 + 审查
   * 提示词；执行结束但无报告 = 执行失败（接口通道，不能解锁下游）。
   */
  private async runOrchestratedReview(
    input: OrchestratedPhaseInput & { task: BuildTask },
    worker: WorkerRuntime,
    unit: BuildUnit,
    round: number,
    attempt: number,
  ): Promise<void> {
    const { entry, buildState, task } = input;
    entry.stage = 'reviewing';
    const scopePaths = this.unitScopePaths(buildState, unit);
    const prompt = this.buildUnitReviewPrompt(unit, scopePaths, buildState, attempt);
    const outcome = await worker.rpc!.prompt(`${this.reviewRulesText()}\n\n---\n${prompt}`, { timeoutMs: input.promptTimeoutMs });
    if (entry.cancelRequested && outcome.outcome !== 'completed') throw new CancelledError();
    if (outcome.outcome === 'aborted') throw new CancelledError();
    if (outcome.outcome === 'failed') {
      throw new ToolError(outcome.error?.code ?? 'model_request_failed', `单元 ${unit.id} 审查轮失败：${outcome.error?.message ?? '未知错误'}`, 502);
    }
    this.throwIfPoisoned(buildState);
    // 报告缺失 = 执行失败（B 案 §7：不能解锁下游）
    const report = this.readReviewReportFile(buildState.stagingRoot, unit.id);
    if (!report) {
      throw new ToolError('kb_review_report_missing', `审查任务 ${task.taskId} 执行结束但未提交审查报告（kb_submit_review）`);
    }
    // 绑定校验：审查对象（单元认领文档集合）自任务创建以来未变
    const currentHash = KbBuildService.reviewSubjectHash(buildState.stagingRoot, scopePaths);
    if (currentHash !== task.reviewSubjectDraftHash) {
      throw new ToolError('kb_review_stale_binding', `审查期间草稿发生了变化（${unit.id}），本轮报告作废并重审`);
    }
    this.submitReviewResult(input, task, report, { scope: 'unit', subjectKey: `unit:${unit.id}`, round, reportUnitId: unit.id });
  }

  /** 整合轮（B 案 §4）：跨单元合并去重 + kb_finish；任何正文/标题/来源变化
   * 形成新审查对象（由最终复核绑定整版候选哈希覆盖）。 */
  private async runOrchestratedIntegrate(input: OrchestratedPhaseInput & { task: BuildTask }, worker: WorkerRuntime): Promise<void> {
    const { entry, buildState, task } = input;
    const orchestration = entry.orchestration!;
    entry.stage = 'finishing';
    entry.batchIndex = entry.batchTotal;
    this.setWorkerAssignment(worker, null, 'final');
    const crossUnitDocs: string[] = [];
    for (const unit of input.units) {
      for (const docPath of buildState.claims?.ownedBy(unit.id) ?? []) {
        crossUnitDocs.push(`- ${docPath}${buildState.docMeta?.get(docPath)?.title ? `（${buildState.docMeta.get(docPath)!.title}）` : ''} — 单元 ${unit.id}`);
      }
    }
    const summaries = input.units.map((unit) => {
      const report = buildState.unitDone?.get(unit.id);
      return `- ${unit.id}（源 ${unit.sources.length} 个）：${report?.summary?.slice(0, 500) ?? '（无摘要）'}`;
    });
    const finishPrompt = [
      ...this.resumeValidationFeedback(entry),
      ...this.finishCoverage(buildState),
      '【整体整合】全部构建单元已完成且通过独立审查，进入整体整合轮（B 案 §4）。各单元摘要：',
      ...summaries,
      '',
      ...(crossUnitDocs.length > 0
        ? ['本构建各单元写入/认领的文档（可读取任意草稿后合并重复主题；本轮写入不受路径限制）：', ...crossUnitDocs.slice(0, 300), '']
        : []),
      '请先完成跨单元合并与去重（如无必要不要重写全部文档），然后【立即调用 kb_finish 工具】完成构建：',
      '- summary：本次构建的整体总结（做了什么、产出哪些主题文档、做了哪些跨单元合并）。',
      '- skipped：工作集中未被任何文档引用的源，逐个列出 objToken 与理由（全构建范围，不限于某一单元）。',
      '注意：必须调用工具本身（tool call），不要只回复文本说明。整合阶段改写过的文档将对照原文重新审查（最终复核）。',
    ].join('\n');
    let outcome = await worker.rpc!.prompt(
      input.systemRules ? `${finishPrompt}\n\n---\n构建规则与文风规范（适用）：\n${input.systemRules}` : finishPrompt,
      { timeoutMs: input.promptTimeoutMs },
    );
    if (outcome.outcome === 'aborted') throw new CancelledError();
    if (outcome.outcome === 'failed') {
      throw new ToolError(outcome.error?.code ?? 'model_request_failed', `整合轮失败：${outcome.error?.message ?? '未知错误'}`, 502);
    }
    if (!buildState.finishInfo) {
      this.emitLog(input.buildId, 'warn', '整合轮未检测到 kb_finish 调用，发送强制纠正提示');
      outcome = await worker.rpc!.prompt(
        '系统检测到你没有调用 kb_finish 工具（工具调用记录为空）。现在请直接调用 kb_finish 工具：summary 填写整体总结；如果此前未写任何文档，skipped 列出全部源并说明理由。不要输出任何文本，直接发起工具调用。',
        { timeoutMs: input.promptTimeoutMs },
      );
      if (outcome.outcome === 'aborted') throw new CancelledError();
      if (outcome.outcome === 'failed') {
        throw new ToolError(outcome.error?.code ?? 'model_request_failed', `整合轮纠正失败：${outcome.error?.message ?? '未知错误'}`, 502);
      }
    }
    if (!buildState.finishInfo) {
      throw new ToolError('kb_validation_failed', '整合轮在两轮提示后仍未调用 kb_finish', 400);
    }
    orchestration.submitResult({ taskId: task.taskId, revision: task.revision, artifactState: 'available', resultRef: 'integrate:done' });
    this.persistCheckpoint(input.buildId);
  }

  /** 整合修订轮（integrate 轮次 ≥1）：最终复核 blocking 后定向修订整合稿。 */
  private async runOrchestratedIntegrateRevise(
    input: OrchestratedPhaseInput & { task: BuildTask },
    worker: WorkerRuntime,
    round: number,
  ): Promise<void> {
    const { entry, buildState, task } = input;
    const orchestration = entry.orchestration!;
    entry.stage = 'finishing';
    this.setWorkerAssignment(worker, null, 'final');
    const report = this.readReviewReportFile(buildState.stagingRoot, 'all');
    if (!report) throw new ToolError('kb_review_report_missing', `整合修订轮 ${task.taskId} 找不到最终复核报告`);
    const prompt = [
      `【整合修订轮】（B 案 §5）最终复核提出以下阻断/待修问题，请逐项修订整合阶段的候选草稿（跨单元合并、命名与交叉引用）：`,
      `<review_report>`,
      JSON.stringify({ issues: report.issues, uncheckedScope: report.uncheckedScope, conclusion: report.conclusion }, null, 2),
      `</review_report>`,
      '要求：',
      '1. 逐项回应：已修复 / 有依据保留（写明依据）/ 需要补充资料（如实说明）。',
      '2. 只修订问题与受影响内容，不要无关重写；写入不受路径限制（整合轮语义）。',
      '3. kb_finish 已提交过、工具会拒绝重复调用——修订完成后直接结束本轮，不要再调用 kb_finish/kb_unit_done。',
    ].join('\n');
    const outcome = await worker.rpc!.prompt(
      input.systemRules ? `${prompt}\n\n---\n构建规则与文风规范（适用）：\n${input.systemRules}` : prompt,
      { timeoutMs: input.promptTimeoutMs },
    );
    if (entry.cancelRequested && outcome.outcome !== 'completed') throw new CancelledError();
    if (outcome.outcome === 'aborted') throw new CancelledError();
    if (outcome.outcome === 'failed') {
      throw new ToolError(outcome.error?.code ?? 'model_request_failed', `整合修订轮失败：${outcome.error?.message ?? '未知错误'}`, 502);
    }
    this.throwIfPoisoned(buildState);
    orchestration.submitResult({ taskId: task.taskId, revision: task.revision, artifactState: 'available', resultRef: `integrate:revise${round}` });
    this.persistCheckpoint(input.buildId);
  }

  /** 最终复核（B 案 §4）：整版候选全量检查跨单元矛盾/重复/合并遗漏/交叉
   * 引用；报告绑定整版哈希（旧报告不能批准新稿）。 */
  private async runOrchestratedFinalReview(
    input: OrchestratedPhaseInput & { task: BuildTask },
    worker: WorkerRuntime,
    attempt: number,
  ): Promise<void> {
    const { entry, buildState, task } = input;
    entry.stage = 'reviewing';
    const prompt = this.buildFinalReviewPrompt(input.units, attempt);
    const outcome = await worker.rpc!.prompt(`${this.reviewRulesText()}\n\n---\n${prompt}`, { timeoutMs: input.promptTimeoutMs });
    if (entry.cancelRequested && outcome.outcome !== 'completed') throw new CancelledError();
    if (outcome.outcome === 'aborted') throw new CancelledError();
    if (outcome.outcome === 'failed') {
      throw new ToolError(outcome.error?.code ?? 'model_request_failed', `最终复核失败：${outcome.error?.message ?? '未知错误'}`, 502);
    }
    this.throwIfPoisoned(buildState);
    const report = this.readReviewReportFile(buildState.stagingRoot, 'all');
    if (!report) {
      throw new ToolError('kb_review_report_missing', `最终复核 ${task.taskId} 执行结束但未提交审查报告（kb_submit_review unitId=all）`);
    }
    // 整版绑定：报告哈希必须等于当前 staging 全量哈希 = 任务创建时哈希
    const currentHash = KbBuildService.reviewSubjectHash(buildState.stagingRoot, null);
    if (report.draftHash !== currentHash || currentHash !== task.reviewSubjectDraftHash) {
      throw new ToolError('kb_review_stale_binding', '最终复核期间候选内容发生变化，报告作废并重审');
    }
    this.submitReviewResult(input, task, report, { scope: 'integration', subjectKey: 'role:integrate', round: parseOrchestrationTaskId(task.taskId)?.round ?? 0, reportUnitId: 'all' });
  }

  /**
   * 审查结论回流（B 案 §5/§7）：pass 且无未关闭 blocking → 被审任务
   * acceptance=passed；blocking → 预算内创建修订任务（换稿重新审查），
   * 预算耗尽 → pending_decision + failed(kb_review_required) 可恢复；
   * suggestion 不阻塞。报告归档保留讨论轨迹。
   */
  private submitReviewResult(
    input: OrchestratedPhaseInput & { task: BuildTask },
    reviewTask: BuildTask,
    report: ReviewReport,
    meta: { scope: 'unit' | 'integration'; subjectKey: string; round: number; reportUnitId: string },
  ): void {
    const { entry, buildState } = input;
    const orchestration = entry.orchestration!;
    const stagingRoot = buildState.stagingRoot;
    // 审查任务本身：执行完成 + 报告产物可用（B 案 §7 三轴分离）
    orchestration.submitResult({ taskId: reviewTask.taskId, revision: reviewTask.revision, artifactState: 'available', resultRef: `review:${report.reportId}` });
    this.archiveReviewReport(stagingRoot, meta.reportUnitId, reviewTask.taskId.replace(/[^A-Za-z0-9_-]/g, '_'));
    const openBlocking = report.issues.filter((issue) => issue.severity === 'blocking' && !isIssueClosed(issue));
    // 被审对象任务（review 任务的首个依赖）：write 或 integrate
    const targetTaskId = reviewTask.dependencies[0]?.taskId;
    const target = targetTaskId ? orchestration.task(targetTaskId) : null;
    if (!target) throw new ToolError('kb_pipeline_invalid', `审查任务 ${reviewTask.taskId} 缺少被审对象依赖`, 500);
    const passed = report.conclusion === 'pass' && openBlocking.length === 0;
    if (passed) {
      orchestration.updateAcceptanceState(target.taskId, 'passed');
      // diting F03（A 案 §4.2/§7.4）：流水审查通过回写对象级机器审查凭据
      // ——审查范围（报告覆盖的文档；最终复核=全库）内对象 reviewStatus=
      // passed（reviewActorKind='machine'，reviewerId 绑定报告 ID）。发布
      // 门禁同步收紧：pending 对象 blocking（knowledge-validator）。
      const unitOfReport = input.units.find((candidate) => candidate.id === meta.reportUnitId) ?? null;
      const scopePaths = meta.scope === 'unit' && unitOfReport ? this.unitScopePaths(buildState, unitOfReport) : null;
      const marked = this.deps.toolService.markObjectsMachineReviewed(buildState, scopePaths, report.reportId);
      if (marked > 0) {
        this.emitLog(input.buildId, 'info', `对象级机器审查凭据：${marked} 个对象 reviewStatus=passed（报告 ${report.reportId} 绑定；A 案 §4.2/§7.4）`);
      }
      this.emitLog(input.buildId, 'info', `${meta.scope === 'unit' ? `单元 ${meta.reportUnitId}` : '最终复核'}审查通过（${report.reportId}；问题 ${report.issues.length} 项，无未关闭阻断）`);
      this.persistCheckpoint(input.buildId);
      return;
    }
    const decision = orchestration.tryStartRevision(meta.subjectKey);
    if (!decision.allowed) {
      // 预算耗尽：待裁定 + failed(kb_review_required) 可恢复（A 案 §7.2：
      // 保存待审报告、停止全部进程、CURRENT 不动；用户处理后显式继续）
      orchestration.updateAcceptanceState(target.taskId, 'pending_decision');
      this.persistCheckpoint(input.buildId);
      throw new ToolError('kb_review_required', `${meta.scope === 'unit' ? `单元 ${meta.reportUnitId}` : '整合候选'}审查存在 ${openBlocking.length} 个未解决阻断问题，且自动修订预算已耗尽（${decision.budget.usedAutoRevisions}/${decision.budget.maxAutoRevisions}）；待审报告已保存（reviews/${meta.reportUnitId}.json），请人工处理后恢复构建`, 400);
    }
    orchestration.updateAcceptanceState(target.taskId, 'needs_revision');
    const ref = parseOrchestrationTaskId(target.taskId)!;
    if (meta.scope === 'unit') {
      orchestration.createTask({
        taskId: `t:write:${meta.reportUnitId}:r${ref.round + 1}`,
        revision: ref.round + 1,
        role: 'write',
        unitId: meta.reportUnitId,
        reviewSubjectDraftHash: null,
        inputRefs: [`drafts:unit:${meta.reportUnitId}`, `review:${report.reportId}`],
        dependencies: [{ taskId: reviewTask.taskId, requires: 'artifact_available' }],
        allowedWritePaths: [...(orchestration.task(target.taskId)?.allowedWritePaths ?? [])],
        outputRequirements: `单元 ${meta.reportUnitId} 第 ${ref.round + 1} 轮定向修订（逐项回应审查问题）`,
      });
    } else {
      orchestration.createTask({
        taskId: `t:integrate:r${ref.round + 1}`,
        revision: ref.round + 1,
        role: 'integrate',
        unitId: null,
        reviewSubjectDraftHash: null,
        inputRefs: [`review:${report.reportId}`],
        dependencies: [{ taskId: reviewTask.taskId, requires: 'artifact_available' }],
        allowedWritePaths: [],
        outputRequirements: `整合候选第 ${ref.round + 1} 轮定向修订（逐项回应最终复核问题）`,
      });
    }
    this.emitLog(input.buildId, 'warn', `${meta.scope === 'unit' ? `单元 ${meta.reportUnitId}` : '整合候选'}审查未通过（blocking ${openBlocking.length} 项），进入修订轮 ${ref.round + 1}（预算 ${decision.budget.usedAutoRevisions}/${decision.budget.maxAutoRevisions}）`);
    this.persistCheckpoint(input.buildId);
  }

  // ------------------------------------------------------------------
  // 审查报告文件与提示词（T2b）
  // ------------------------------------------------------------------

  private static reviewReportPath(stagingRoot: string, unitId: string): string {
    return path.join(stagingRoot, 'reviews', `${unitId}.json`);
  }

  private readReviewReportFile(stagingRoot: string, unitId: string): ReviewReport | null {
    try {
      const raw = JSON.parse(fs.readFileSync(KbBuildService.reviewReportPath(stagingRoot, unitId), 'utf-8')) as ReviewReport;
      return raw && typeof raw === 'object' && typeof raw.reportId === 'string' ? raw : null;
    } catch {
      return null;
    }
  }

  /** 归档本轮报告（B 案 §5 保留讨论轨迹；当前文件保留给修订轮读取）。 */
  private archiveReviewReport(stagingRoot: string, unitId: string, fileTag: string): void {
    try {
      const source = KbBuildService.reviewReportPath(stagingRoot, unitId);
      if (!fs.existsSync(source)) return;
      const dir = path.join(stagingRoot, 'reviews', 'archive');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(source, path.join(dir, `${unitId}.${fileTag}.json`));
    } catch {
      /* 归档失败不阻断流水（当前报告仍在 reviews/<unitId>.json） */
    }
  }

  /** canPublish 报告池：当前报告 + 归档历史（B 案 §7 有效报告集合）。 */
  private static collectReviewReports(stagingRoot: string): ReviewReport[] {
    const reports: ReviewReport[] = [];
    const read = (file: string): void => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReviewReport;
        if (parsed && typeof parsed.reportId === 'string') reports.push(parsed);
      } catch {
        /* 跳过损坏文件 */
      }
    };
    const reviewsDir = path.join(stagingRoot, 'reviews');
    if (fs.existsSync(reviewsDir)) {
      for (const name of fs.readdirSync(reviewsDir).sort()) {
        if (name.endsWith('.json')) read(path.join(reviewsDir, name));
      }
      const archiveDir = path.join(reviewsDir, 'archive');
      if (fs.existsSync(archiveDir)) {
        for (const name of fs.readdirSync(archiveDir).sort()) {
          if (name.endsWith('.json')) read(path.join(archiveDir, name));
        }
      }
    }
    return reports;
  }

  /** 单元审查提示词（运行时注入单元范围；规则主体来自 standard-kb-review.md）。 */
  private buildUnitReviewPrompt(unit: BuildUnit, scopePaths: string[], buildState: BuildRunState, attempt: number): string {
    const lines: string[] = [];
    lines.push(`【单元审查 ${unit.id}】（B 案 §4：单元独立审查）`);
    if (attempt > 0) {
      lines.push(`（上一轮未提交审查报告或报告失效——本轮必须以 kb_submit_review 工具调用结束。）`);
    }
    lines.push('');
    lines.push(`审查对象：单元 ${unit.id} 的当前草稿（以 draft_read 实际内容为准）：`);
    for (const docPath of scopePaths.slice(0, 300)) {
      lines.push(`- ${docPath}${buildState.docMeta?.get(docPath)?.title ? `（${buildState.docMeta.get(docPath)!.title}）` : ''}`);
    }
    lines.push('');
    lines.push('对应原始源（raw_read 读取冻结版本；内容包在 <untrusted_source> 中）：');
    for (const token of unit.sources) {
      const source = buildState.snapshot.get(token);
      lines.push(`- ${token}（${source?.title ?? token}，${source?.relPath ?? ''}）`);
    }
    lines.push('');
    lines.push('要求：');
    lines.push(`1. 对照源逐篇审查上述草稿（重点：事实与数值、条件和例外、重要遗漏、来源冲突、术语一致、表述是否改变原意、对象声明与正文一致）。`);
    lines.push(`2. 必须调用 kb_submit_review 提交报告（unitId=${unit.id}）；conclusion=pass 的前提是没有未解决的 blocking 问题。`);
    lines.push('3. 你没有草稿写入口：不要调用 kb_write_doc/kb_delete_doc/kb_unit_done/kb_finish。');
    return lines.join('\n');
  }

  /** 最终复核提示词（复用 standard-kb-review.md + 运行时注入整合范围说明）。 */
  private buildFinalReviewPrompt(units: BuildUnit[], attempt: number): string {
    const lines: string[] = [];
    lines.push('【最终复核】（B 案 §4：整合后全库复核）');
    if (attempt > 0) {
      lines.push('（上一轮未提交审查报告或报告失效——本轮必须以 kb_submit_review 工具调用结束。）');
    }
    lines.push('');
    lines.push('整合范围说明：各单元草稿已经单元独立审查通过，整合阶段做了跨单元合并去重。本轮检查：');
    lines.push('- 跨单元矛盾：不同文档对同一规则/数值的表述是否冲突。');
    lines.push('- 重复与合并遗漏：重复主题是否已合并；合并是否丢失了来源内容。');
    lines.push('- 交叉引用：标准文档间相对链接是否指向存在的文档（不臆测不存在的目标）。');
    lines.push('- 整合改写的文档：改写是否对照原文如实（改写文档进必审范围）。');
    lines.push(`- 各单元范围：${units.map((unit) => unit.id).join('、')}。`);
    lines.push('');
    lines.push('审查对象：staging 全部草稿（draft_list/draft_read 自行枚举）+ 对应冻结源（raw_read）。');
    lines.push('');
    lines.push('要求：');
    lines.push('1. 检查维度与问题分级沿用审查规则；未检查范围如实声明。');
    lines.push('2. 必须调用 kb_submit_review 提交报告（unitId=all）；conclusion=pass 的前提是没有未解决的 blocking 问题。');
    lines.push('3. 你没有任何草稿写入口。');
    return lines.join('\n');
  }

  /** 修订轮提示词（standard-kb-build.md 修订段 + 问题清单运行时注入）。 */
  private buildRevisePrompt(unitId: string, round: number, report: ReviewReport): string {
    return [
      `【修订轮 ${unitId}】（B 案 §5：定向修订，第 ${round} 轮）上一轮独立审查报告如下：`,
      `<review_report>`,
      JSON.stringify({ issues: report.issues, uncheckedScope: report.uncheckedScope, conclusion: report.conclusion }, null, 2),
      `</review_report>`,
      '要求：',
      '1. 先用 draft_read 读回本单元草稿与问题位置，再逐项回应：已修复 / 有依据保留原文（写明依据）/ 需要补充资料（如实说明，不臆测）。',
      '2. 只修订问题与受影响内容，不要无关重写；只能写本单元认领的路径。',
      `3. 修订完成后调用 kb_unit_done（summary 写逐项回应摘要）。修订稿会换版本重新审查，旧报告不会批准新稿。`,
    ].join('\n');
  }


  /** 单元的审查范围路径：认领表（含动态首写认领）∪ 计划预认领。 */
  private unitScopePaths(buildState: BuildRunState, unit: BuildUnit): string[] {
    const claimed = buildState.claims?.ownedBy(unit.id) ?? [];
    return [...new Set([...claimed, ...unit.ownedDocs])];
  }

  /** 接口失败重试分类（B 案 §5：执行失败与内容不通过分开计数）。 */
  private static isInterfaceRetryable(error: unknown): boolean {
    const code = error instanceof ToolError ? error.code : '';
    return code === 'model_timeout' || code === 'model_request_failed' || code === 'pi_process_exited'
      || code === 'pi_transport_failed' || code === 'kb_review_report_missing' || code === 'kb_review_stale_binding';
  }

  /**
   * 执行单个编排任务：接口失败（可重试码）按 maxInterfaceRetries 重试
   *（与内容修订分开计数，B 案 §5）；内容决策（blocking/预算）不可重试。
   */
  private async executeOrchestratedTask(input: OrchestratedPhaseInput & { task: BuildTask; slotObtained: () => boolean }): Promise<void> {
    const { task } = input;
    const orchestration = input.entry.orchestration!;
    if (orchestration.task(task.taskId)?.execState === 'queued') orchestration.updateExecState(task.taskId, 'running');
    let worker: WorkerRuntime | null = null;
    try {
      for (;;) {
        try {
          worker = await this.spawnOrchestratedWorker(input);
          await this.runOrchestratedTaskOnWorker(input, worker);
          return;
        } catch (error) {
          if (error instanceof CancelledError || !KbBuildService.isInterfaceRetryable(error)) throw error;
          let verdict: { canRetry: boolean; used: number; max: number };
          try {
            verdict = orchestration.recordInterfaceFailure(task.taskId);
          } catch {
            throw error;
          }
          const code = error instanceof ToolError ? error.code : 'model_error';
          this.emitLog(input.buildId, 'warn', `任务 ${task.taskId} 接口失败（${code}），已重试 ${verdict.used}/${verdict.max}（与内容修订分开计数，B 案 §5）`);
          if (!verdict.canRetry) {
            throw new ToolError('kb_interface_failed', `任务 ${task.taskId} 接口失败重试耗尽（${code}）：${error instanceof Error ? error.message : String(error)}`, 502);
          }
          await this.disposeOrchestratedWorker(input.buildId, worker);
          worker = null;
        }
      }
    } finally {
      await this.disposeOrchestratedWorker(input.buildId, worker);
    }
  }

  /** 拉起编排任务专用 worker：独立进程/上下文（B 案 §3 审查必须独立任务
   * 上下文）；模型按冻结 BuildSpec 角色解析。 */
  private async spawnOrchestratedWorker(input: OrchestratedPhaseInput & { task: BuildTask; slotObtained: () => boolean }): Promise<WorkerRuntime> {
    const { task, entry } = input;
    const phase = task.role === 'review' || task.role === 'final_review'
      ? 'review' as const
      : task.role === 'integrate' ? 'final' as const : 'unit' as const;
    const workerId = `o-${task.taskId}`;
    const worker: WorkerRuntime = {
      workerId,
      poolKey: `build:${input.buildId}:${workerId}`,
      slot: null,
      rpc: null,
      token: null,
      context: null,
      state: 'waiting_slot',
      unitId: task.role === 'final_review' ? 'all' : task.unitId,
      unitBatchIndex: 0,
      unitBatchTotal: 0,
      exited: false,
      phase,
    };
    entry.workers.set(workerId, worker);
    this.emitWorker(input.buildId, worker);
    worker.slot = await this.acquireWorkerSlot({
      entry,
      cancelController: input.cancelController,
      slotDeadlineMs: input.slotDeadlineMs,
      slotObtained: input.slotObtained,
    });
    const roleModel = this.resolveRoleModel(input.buildId, task.role);
    await this.spawnWorkerProcess({
      buildId: input.buildId,
      entry,
      buildState: input.buildState,
      worker,
      pluginSnapshot: input.pluginSnapshot,
      slot: worker.slot,
      ...(roleModel ? { roleModel } : {}),
    });
    worker.slot = null; // 已被 register 消费
    worker.state = 'running';
    this.emitWorker(input.buildId, worker);
    return worker;
  }

  /** 回收编排任务 worker（进程终止 + 槽位释放；幂等）。 */
  private async disposeOrchestratedWorker(buildId: string, worker: WorkerRuntime | null): Promise<void> {
    if (!worker) return;
    this.active.get(buildId)?.workers.delete(worker.workerId);
    if (worker.slot) {
      worker.slot.release();
      worker.slot = null;
    }
    await this.deps.pool.terminate(worker.poolKey).catch(() => undefined);
    if (worker.rpc && !worker.rpc.isExited()) await worker.rpc.terminate().catch(() => undefined);
    worker.rpc = null;
  }

  /** diting F05（B 案 §8）→ F05-R 升级：解析角色的完整非密钥有效模型参
   * 数（冻结/校验共用）。claude-code 基座不冻结（桥接层自管模型）；
   * pi-agent-dir 活跃模型冻结 piModel；app-llm 按预设/活跃解析
   * provider+modelId+baseUrl+protocol，并经 providerModelParameters 默认
   * 值展开冻结 maxTokens/contextWindow/reasoning、thinkingLevels 档位表
   * 与 authHeader 组合——即派发实际使用的全部非密钥参数。 */
  private describeRoleModel(config: Config, role: BuildRoleModelConfig, roleSpecVersion: string): ResolvedRoleModel | null {
    if (config.agent.runtime.backend === 'claude-code') return null;
    const thinking = role.thinking && role.thinking !== '' ? role.thinking : config.agent.model.thinkingLevel;
    const explicit = role.modelPresetId.trim() !== '' || (role.providerId ?? '').trim() !== '';
    if (explicit || config.agent.model.source === 'app-llm') {
      const resolution = explicit
        ? resolveProviderModel(config.llm, { providerId: role.providerId, modelId: role.modelPresetId || undefined })
        : resolveAppLlmModel(config.llm, config.agent);
      if (!resolution) return null;
      return {
        modelId: resolution.openAiModel,
        providerId: resolution.providerId,
        baseUrl: resolution.baseUrl,
        protocol: resolution.protocol,
        thinking,
        roleSpecVersion,
        origin: 'explicit',
        // diting F05-R：经默认值展开后的完整有效参数（派发 providerJson 来源）
        ...providerModelParameters(resolution),
        ...(resolution.thinkingLevels ? { thinkingLevels: [...resolution.thinkingLevels] } : {}),
        ...(resolution.protocol === 'anthropic-messages' && resolution.anthropicAuthType === 'auth-token' ? { authHeader: true } : {}),
      };
    }
    const piModel = config.agent.model.piModel?.trim() ?? '';
    return piModel ? { modelId: piModel, thinking, roleSpecVersion, origin: 'explicit' } : null;
  }

  /** diting F05 → F05-R：恢复/派发时校验冻结角色与当前配置解析结果**完整**
   * 一致（modelId/providerId/baseUrl/protocol/thinking + 有效参数
   * maxTokens/contextWindow/reasoning/thinkingLevels/authHeader）；不一致 →
   * 构建待处理并明示差异字段（不静默换模型/换参数）。返回逐角色不一致
   * 说明（空 = 一致）。旧 T7 冻结条目缺省的 additive 字段跳过比对。 */
  private frozenRoleMismatches(config: Config, spec: BuildSpec): string[] {
    const mismatches: string[] = [];
    const frozenRoles = spec.resolvedRoles;
    if (!frozenRoles) return mismatches;
    const check = (roleKey: 'writer' | 'reviewer' | 'integrator', roleCfg: BuildRoleModelConfig): void => {
      const frozen = frozenRoles[roleKey];
      if (!frozen) return;
      const current = this.describeRoleModel(config, roleCfg, frozen.roleSpecVersion);
      const label = `${roleKey}=${roleCfg.modelPresetId || roleCfg.providerId || '跟随活跃'}（冻结 ${frozen.providerId ?? ''}/${frozen.modelId}${frozen.baseUrl ? ` @${frozen.baseUrl}` : ''}）`;
      if (!current) {
        mismatches.push(`${label} 当前已不可解析（预设被删除/停用）`);
        return;
      }
      // diting F05-R：完整冻结面比对；差异字段逐项列明（差异非空 → 拒绝）
      const diff: string[] = [];
      const field = (name: string, changed: boolean, detail: string): void => {
        if (changed) diff.push(`${name}${detail ? `：${detail}` : ''}`);
      };
      field('modelId', current.modelId !== frozen.modelId, `${frozen.modelId} → ${current.modelId}`);
      field('providerId', (current.providerId ?? '') !== (frozen.providerId ?? ''), `${frozen.providerId ?? ''} → ${current.providerId ?? ''}`);
      field('baseUrl', (current.baseUrl ?? '') !== (frozen.baseUrl ?? ''), `${frozen.baseUrl ?? ''} → ${current.baseUrl ?? ''}`);
      field('protocol', (current.protocol ?? '') !== (frozen.protocol ?? ''), `${frozen.protocol ?? ''} → ${current.protocol ?? ''}`);
      field('thinking', current.thinking !== frozen.thinking, `${frozen.thinking} → ${current.thinking}`);
      // additive 参数：旧 T7 冻结条目未冻结的字段跳过，不误报
      if (frozen.maxTokens !== undefined) field('maxTokens', current.maxTokens !== frozen.maxTokens, `${String(frozen.maxTokens)} → ${String(current.maxTokens)}`);
      if (frozen.contextWindow !== undefined) field('contextWindow', current.contextWindow !== frozen.contextWindow, `${String(frozen.contextWindow)} → ${String(current.contextWindow)}`);
      if (frozen.reasoning !== undefined) field('reasoning', current.reasoning !== frozen.reasoning, `${String(frozen.reasoning)} → ${String(current.reasoning)}`);
      if (frozen.thinkingLevels !== undefined) field('thinkingLevels', (current.thinkingLevels ?? []).join(',') !== frozen.thinkingLevels.join(','), `${frozen.thinkingLevels.join(',')} → ${(current.thinkingLevels ?? []).join(',')}`);
      if (frozen.authHeader !== undefined) field('authHeader', (current.authHeader ?? false) !== frozen.authHeader, `${String(frozen.authHeader)} → ${String(current.authHeader ?? false)}`);
      if (diff.length > 0) {
        mismatches.push(`${label} 当前解析为 ${current.providerId ?? ''}/${current.modelId}${current.baseUrl ? ` @${current.baseUrl}` : ''}（差异：${diff.join('；')}）`);
      }
    };
    check('writer', spec.roles.writer);
    check('reviewer', spec.roles.reviewer);
    // diting F05-R：integrator 未显式配置时的 follows_writer 冻结副本同样
    // 比对（用 writer 角色配置重解析）——撰写漂移同时阻断整合派发。
    if (spec.roles.integrator) check('integrator', spec.roles.integrator);
    else if (frozenRoles.integrator) check('integrator', spec.roles.writer);
    return mismatches;
  }

  /** T2b（B 案 §3/8 + diting F04/F05）：按冻结 BuildSpec 角色派发模型；
   * 空值角色=跟随活跃预设（启用新流水时同样生效，冻结身份校验防静默换模
   * 型）；预设已删除/停用或身份漂移 → agent_not_ready（原模型不可用，进入
   * 待处理——B 案 §8，恢复可换配置后续跑）。claude-code 基座下显式角色
   * 预设在启用新流水时显式拒绝（diting F05：不得静默忽略角色选择）。 */
  private resolveRoleModel(buildId: string, role: BuildRole): { model: string; apiKey?: string; providerJson?: string; thinking?: string } | null {
    const spec = this.active.get(buildId)?.orchestration?.spec;
    if (!spec) return null;
    const roleKey: 'writer' | 'reviewer' | 'integrator' = role === 'review' || role === 'final_review'
      ? 'reviewer'
      : role === 'integrate' ? 'integrator' : 'writer';
    const roleConfig = roleKey === 'integrator' ? (spec.roles.integrator ?? spec.roles.writer) : spec.roles[roleKey];
    const explicit = roleConfig.modelPresetId.trim() !== '' || (roleConfig.providerId ?? '').trim() !== '';
    const config = this.configForBuild(buildId);
    if (config.agent.runtime.backend === 'claude-code') {
      // Claude Code 桥按自身 provider 解析；启用的新流水内不得静默忽略显式
      // 角色预设（diting F05）——显式拒绝并说明。
      if (explicit && reviewPipelineActive(spec)) {
        throw new ToolError('agent_not_ready',
          `构建角色 ${role} 显式配置了模型预设（${roleConfig.modelPresetId || roleConfig.providerId}），但 claude-code 基座按自身 provider 解析模型，不支持角色预设注入；已显式拒绝而非静默沿用活跃模型——请改回「跟随活跃预设」或切回 pi 基座（diting F05）`, 503);
      }
      return null;
    }
    // diting F05：冻结身份校验——启动后同预设被改参数/换模型、或跟随的活
    // 跃模型被切换，派发时明示失败，不静默换模型。
    // diting F05-R：升级为完整冻结面校验（含 thinking 与有效参数）；通过
    // 后直接用冻结 descriptor 构造运行配置——不再从实时 config 重建
    // providerJson（凭据仍动态取）。integrator 的 follows_writer 副本同
    // 面比对，撰写漂移同样阻断整合派发。
    const frozen = spec.resolvedRoles?.[roleKey] ?? null;
    if (frozen) {
      const mismatches = this.frozenRoleMismatches(config, spec);
      const mine = mismatches.find((message) => message.startsWith(`${roleKey}=`));
      if (mine) {
        throw new ToolError('agent_not_ready',
          `构建角色 ${role} 的模型参数自构建启动后已变化，不静默换模型/换参数，构建保持待处理（diting F05-R）：${mine}；请恢复原模型预设/活跃模型与参数后继续，或重新构建`, 503);
      }
      if (frozen.baseUrl && frozen.protocol) {
        // 凭据动态取：身份已过完整冻结校验，实时解析必与冻结一致，此处
        // 仅取当前密钥
        const resolution = explicit
          ? resolveProviderModel(config.llm, { providerId: roleConfig.providerId, modelId: roleConfig.modelPresetId || undefined })
          : resolveAppLlmModel(config.llm, config.agent);
        const apiKey = resolution?.apiKey.trim() || undefined;
        if (!apiKey) {
          throw new ToolError('agent_not_ready', `构建角色 ${role} 的模型预设（${roleConfig.modelPresetId || roleConfig.providerId || '跟随活跃'}）当前缺少 API Key；请恢复后继续构建`, 503);
        }
        return { ...buildFrozenRoleRunConfig(frozen, apiKey), thinking: frozen.thinking };
      }
      // pi-agent-dir 活跃模型：无 provider 参数，spawn 按冻结身份注入；
      // thinking 用冻结展开值（全局档位漂移不影响已冻结构建）
      return { model: frozen.modelId, thinking: frozen.thinking };
    }
    if (explicit) {
      const run = buildRoleLlmRunConfig(config.llm, config.agent, roleConfig);
      if (!run || !run.apiKey) {
        throw new ToolError('agent_not_ready', `构建角色 ${role} 的模型预设不可用（${roleConfig.modelPresetId || roleConfig.providerId || '未配置'}）：预设已删除/停用或缺少 API Key；请恢复模型预设后继续构建`, 503);
      }
      return { model: run.model, apiKey: run.apiKey, ...(run.providerJson ? { providerJson: run.providerJson } : {}), ...(roleConfig.thinking ? { thinking: roleConfig.thinking } : {}) };
    }
    // 空值角色=跟随活跃预设（diting F04：启用的新流水内同样生效）
    if (config.agent.model.source === 'app-llm') {
      const run = buildAppLlmRunConfig(config.llm, config.agent);
      if (!run) throw new ToolError('agent_not_ready', 'app-llm 活跃模型未配置，无法解析跟随活跃预设的角色', 503);
      return { model: run.model, ...(run.apiKey ? { apiKey: run.apiKey } : {}), ...(run.providerJson ? { providerJson: run.providerJson } : {}) };
    }
    return null; // pi-agent-dir 活跃模型由 spawnWorkerProcess 按 config 注入（身份已过冻结校验）
  }

  /** 按角色分发执行（写/审/整合/最终复核；修订轮含在 write/integrate 内）。 */
  private async runOrchestratedTaskOnWorker(
    input: OrchestratedPhaseInput & { task: BuildTask },
    worker: WorkerRuntime,
  ): Promise<void> {
    const { task } = input;
    const ref = parseOrchestrationTaskId(task.taskId);
    if (!ref) throw new ToolError('kb_pipeline_invalid', `编排任务 id 无法解析：${task.taskId}`, 500);
    if (task.role === 'write') {
      const unit = input.units.find((candidate) => candidate.id === task.unitId);
      if (!unit) throw new ToolError('kb_pipeline_invalid', `编排任务引用未知单元：${task.taskId}`, 500);
      if (ref.round === 0) {
        await this.runOrchestratedUnitWrite(input, worker, unit);
      } else {
        await this.runOrchestratedRevise(input, worker, unit, ref.round);
      }
      return;
    }
    if (task.role === 'review') {
      const unit = input.units.find((candidate) => candidate.id === task.unitId);
      if (!unit) throw new ToolError('kb_pipeline_invalid', `审查任务引用未知单元：${task.taskId}`, 500);
      await this.runOrchestratedReview(input, worker, unit, ref.round, ref.attempt);
      return;
    }
    if (task.role === 'integrate') {
      if (ref.round === 0) await this.runOrchestratedIntegrate(input, worker);
      else await this.runOrchestratedIntegrateRevise(input, worker, ref.round);
      return;
    }
    await this.runOrchestratedFinalReview(input, worker, ref.attempt);
  }

  /** 单元写入（轮次 0）：批次推进与既有单元阶段一致（unitProgress 断点续跑）。 */
  private async runOrchestratedUnitWrite(
    input: OrchestratedPhaseInput & { task: BuildTask },
    worker: WorkerRuntime,
    unit: BuildUnit,
  ): Promise<void> {
    const { entry, buildState, task } = input;
    const orchestration = entry.orchestration!;
    entry.stage = 'units';
    entry.units.running += 1;
    this.emitUnits(input.buildId);
    this.setWorkerAssignment(worker, unit.id, 'unit');
    try {
      const unitProgress = entry.unitProgress;
      if (!unitProgress.has(unit.id)) unitProgress.set(unit.id, 0);
      const batches = unit.batches;
      for (let index = unitProgress.get(unit.id) ?? 0; index < batches.length; index += 1) {
        if (entry.cancelRequested) throw new CancelledError();
        worker.unitBatchIndex = index;
        worker.unitBatchTotal = batches.length;
        this.emitWorker(input.buildId, worker);
        if (input.wordBudget > 0) {
          const batchWords = batches[index].reduce((sum, token) => sum + input.wordsOf(token), 0);
          this.emitLog(input.buildId, 'info', `unit ${unit.id} batch ${index + 1}/${batches.length}: sources=${batches[index].length}, words=${batchWords}`);
        }
        const batchPrompt = this.buildUnitBatchPrompt({
          unit,
          batch: batches[index],
          batchIndex: index,
          batchTotal: batches.length,
          snapshot: input.snapshot,
          workset: input.workset,
          sourceChanges: input.sourceChanges,
          isRetry: false,
          claimedDocs: buildState.claims?.ownedBy(unit.id) ?? [],
        });
        const continuation = entry.resume ? '这是断点继续：已完成单元/批次不重复执行。请用 draft_list/draft_read 检查本单元已恢复的完整草稿，保留结果并补齐未完成内容。\n\n' : '';
        const outcome = await worker.rpc!.prompt(
          continuation + (input.systemRules ? `${batchPrompt}\n\n---\n构建规则与文风规范（每批适用）：\n${input.systemRules}` : batchPrompt),
          { timeoutMs: input.promptTimeoutMs },
        );
        if (entry.cancelRequested && outcome.outcome !== 'completed') throw new CancelledError();
        if (outcome.outcome === 'aborted') throw new CancelledError();
        if (outcome.outcome === 'failed') {
          throw new ToolError(outcome.error?.code ?? 'model_request_failed', `单元 ${unit.id} 批次 ${index + 1} 失败：${outcome.error?.message ?? '未知错误'}`, 502);
        }
        this.throwIfPoisoned(buildState);
        unitProgress.set(unit.id, index + 1);
        entry.batchIndex += 1;
        this.persistCheckpoint(input.buildId);
      }
      if (!buildState.unitDone?.has(unit.id)) {
        this.emitLog(input.buildId, 'warn', `单元 ${unit.id} 未调用 kb_unit_done，发送纠正提示`);
        const corrected = await worker.rpc!.prompt(
          `本单元（${unit.id}）的全部批次已处理完。系统未检测到 kb_unit_done 调用。现在请直接调用 kb_unit_done 工具：summary 填写本单元总结；本单元未被任何文档引用的源逐个列入 skipped（objToken 须属本单元）。不要输出文本，直接发起工具调用。`,
          { timeoutMs: input.promptTimeoutMs },
        );
        if (corrected.outcome === 'aborted') throw new CancelledError();
        if (corrected.outcome === 'failed') {
          throw new ToolError(corrected.error?.code ?? 'model_request_failed', `单元 ${unit.id} 的 kb_unit_done 纠正轮失败：${corrected.error?.message ?? '未知错误'}`, 502);
        }
        if (!buildState.unitDone?.has(unit.id)) {
          throw new ToolError('kb_unit_failed', `单元 ${unit.id} 在纠正提示后仍未调用 kb_unit_done`, 400);
        }
      }
      entry.units.done += 1;
      this.emitUnits(input.buildId);
      orchestration.submitResult({ taskId: task.taskId, revision: task.revision, artifactState: 'available', resultRef: `unit:${unit.id}` });
      this.persistCheckpoint(input.buildId);
    } catch (error) {
      entry.units.failed += 1;
      this.emitUnits(input.buildId);
      throw error;
    } finally {
      entry.units.running -= 1;
      this.setWorkerAssignment(worker, null);
      worker.unitBatchIndex = 0;
      worker.unitBatchTotal = 0;
      this.emitUnits(input.buildId);
    }
  }


  /** staging 草稿清单（path + 内容哈希，与 T3 报告绑定同一哈希函数）。 */
  private static stagingDocsEntriesOf(stagingRoot: string): Array<{ path: string; contentHash: string }> {
    const docsDir = path.join(stagingRoot, 'docs');
    const entries: Array<{ path: string; contentHash: string }> = [];
    const walk = (dir: string, prefix: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir).sort()) {
        const child = path.join(dir, name);
        if (fs.lstatSync(child).isDirectory()) walk(child, `${prefix}${name}/`);
        else if (name.endsWith('.md')) entries.push({ path: `${prefix}${name}`, contentHash: contentResourceHash(fs.readFileSync(child, 'utf-8')) });
      }
    };
    walk(docsDir, '');
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** 逻辑审查对象哈希（B 案 §5）：单元=其认领文档集合；整合=staging 全量。 */
  private static reviewSubjectHash(stagingRoot: string, scopePaths: string[] | null): string {
    const entries = KbBuildService.stagingDocsEntriesOf(stagingRoot);
    const scoped = scopePaths ? entries.filter((entry) => scopePaths.includes(entry.path)) : entries;
    return computeCandidateHash({ documents: scoped });
  }

  /**
   * 组装发布候选（B 案 §7 附录 A CandidateRelease）并落盘
   * staging/candidate.json：文档清单+哈希、验收记录、沿用范围、来源
   * 去向、变更说明。沿用披露（§4）：本轮写过的文档 priorReview=reviewed，
   * 从基准复制未改写的=never_reviewed，不补造通过状态。
   */
  private assembleCandidateRelease(input: {
    buildId: string;
    entry: InMemoryBuild;
    buildState: BuildRunState;
    snapshot: RawSourceSnapshot;
    stagingRoot: string;
    programChecks: { passed: boolean; checkIds: string[]; failed?: string[] };
    summary: string;
  }): { candidate: CandidateRelease; candidateHash: string } {
    const { entry, buildState, snapshot, stagingRoot } = input;
    const orchestration = entry.orchestration!;
    const documents = KbBuildService.stagingDocsEntriesOf(stagingRoot);
    const candidateHash = computeCandidateHash({ documents });
    const writtenPaths = buildState.writtenPaths ?? new Set<string>();
    const carriedOver: CarriedOverEntry[] = documents.map((doc) => ({
      path: doc.path,
      priorReview: writtenPaths.has(doc.path) ? 'reviewed' : 'never_reviewed',
    }));
    // 材料去向（B 案 §7）：本轮处理范围内每个源要么被引用要么显式 skipped
    const referenced = new Set<string>();
    for (const doc of documents) {
      for (const token of buildState.docMeta?.get(doc.path)?.sources ?? []) referenced.add(token);
    }
    const skippedReason = new Map<string, string>();
    for (const report of buildState.unitDone?.values() ?? []) {
      for (const item of report.skipped) skippedReason.set(item.objToken, item.reason);
    }
    for (const item of buildState.finishInfo?.skipped ?? []) skippedReason.set(item.objToken, item.reason);
    const sourceDisposition = snapshot.entries.map((source) => ({
      sourceId: source.objToken,
      disposition: referenced.has(source.objToken)
        ? 'referenced'
        : skippedReason.has(source.objToken)
          ? `skipped: ${skippedReason.get(source.objToken) ?? ''}`
          : '',
    }));
    // 验收记录：每单元最终轮报告 + 最终复核报告（有效报告集合，B 案 §7）
    const validReportIds: string[] = [];
    for (const unit of buildState.units ?? []) {
      const report = this.readReviewReportFile(stagingRoot, unit.id);
      if (report) validReportIds.push(report.reportId);
    }
    const finalReport = this.readReviewReportFile(stagingRoot, 'all');
    if (finalReport) validReportIds.push(finalReport.reportId);
    const candidate: CandidateRelease = {
      buildId: input.buildId,
      documents,
      acceptance: {
        acceptanceId: `ka_${crypto.randomBytes(6).toString('hex')}`,
        acceptedArtifactHash: candidateHash,
        validReportIds,
        programChecks: input.programChecks,
        decisionMode: orchestration.spec.publishMode,
        ...(orchestration.spec.publishMode === 'auto' ? { decidedBy: 'auto-rules', decidedAt: new Date().toISOString() } : {}),
      },
      carriedOver,
      sourceDisposition,
      changeSummary: input.summary,
      sourceSnapshotHash: orchestration.spec.sourceSnapshotHash,
      baseReleaseId: orchestration.spec.baseReleaseId,
      publishMode: orchestration.spec.publishMode,
    };
    // 落盘 candidate.json（awaiting_release 的确认对象与重启后恢复源）
    fs.writeFileSync(
      path.join(stagingRoot, 'candidate.json'),
      `${JSON.stringify({ schemaVersion: 1, buildId: input.buildId, candidateHash, assembledAt: new Date().toISOString(), candidate }, null, 2)}\n`,
    );
    return { candidate, candidateHash };
  }

  /**
   * T2b（B 案 §7）：待确认发布——用户确认后发布。绑定候选哈希：确认时
   * 重新计算 staging 清单哈希，内容变化则确认失效拒绝；确认不绕过源
   * 版本、路径与产物完整性检查（重新 verifySnapshotIntact + 确定性校验
   * + canPublish）。可跨重启执行（从检查点重建状态）。
   */
  async releaseConfirm(
    localMapStore: Parameters<KbBuildService['createBuild']>[0] & { getKbBuild(id: string): Record<string, unknown> | null },
    buildId: string,
    confirmInput: { candidateHash?: string; actor?: string } = {},
  ): Promise<KbBuildDto> {
    const row = localMapStore.getKbBuild(buildId);
    if (!row) throw new ToolError('build_not_found', '构建记录不存在', 404);
    if (String(row.status) !== 'awaiting_release') {
      throw new ToolError('kb_release_unavailable', `构建当前状态为 ${row.status}，不在待确认发布状态`, 409);
    }
    const config = this.deps.configProvider();
    if (!config) throw new ToolError('invalid_request', '配置不可用');
    const outputRoot = config.standardKb.outputRoot;
    const checkpoint = new BuildCheckpointStore(outputRoot).read(buildId);
    if (!checkpoint?.finishInfo) throw new ToolError('kb_release_unavailable', '检查点缺失，无法复核发布材料', 409);
    const stagingRoot = this.stagingRoot(outputRoot, buildId);
    let candidateFile: { schemaVersion: number; buildId: string; candidateHash: string; candidate: CandidateRelease };
    try {
      candidateFile = JSON.parse(fs.readFileSync(path.join(stagingRoot, 'candidate.json'), 'utf-8')) as typeof candidateFile;
    } catch (error) {
      throw new ToolError('kb_release_unavailable', `候选文件不可读：${error instanceof Error ? error.message : String(error)}`, 409);
    }
    if (!candidateFile?.candidate || typeof candidateFile.candidateHash !== 'string') {
      throw new ToolError('kb_release_unavailable', '候选文件损坏', 409);
    }
    // 占位 publishing：串行化并发确认（第二次确认 409），失败回落待确认
    localMapStore.updateKbBuild(buildId, { status: 'publishing' });
    try {
      await this.releaseConfirmInner(localMapStore, buildId, confirmInput, {
        checkpoint, candidateFile, stagingRoot, config, outputRoot,
      });
    } catch (error) {
      if (String(localMapStore.getKbBuild(buildId)?.status ?? '') === 'publishing') {
        localMapStore.updateKbBuild(buildId, { status: 'awaiting_release' });
      }
      throw error;
    }
    return this.toDto(localMapStore.getKbBuild(buildId)!, this.active.get(buildId));
  }

  /** releaseConfirm 主体（状态已占位 publishing；抛错由外层回落待确认）。 */
  private async releaseConfirmInner(
    localMapStore: Parameters<KbBuildService['createBuild']>[0] & { getKbBuild(id: string): Record<string, unknown> | null },
    buildId: string,
    confirmInput: { candidateHash?: string; actor?: string },
    context: {
      checkpoint: BuildCheckpoint;
      candidateFile: { schemaVersion: number; buildId: string; candidateHash: string; candidate: CandidateRelease };
      stagingRoot: string;
      config: Config;
      outputRoot: string;
    },
  ): Promise<void> {
    const { checkpoint, candidateFile, stagingRoot, config, outputRoot } = context;
    const row = localMapStore.getKbBuild(buildId)!;
    if (!checkpoint.finishInfo) throw new ToolError('kb_release_unavailable', '检查点缺少整体收尾信息，无法复核发布材料', 409);
    const entries = KbBuildService.stagingDocsEntriesOf(stagingRoot);
    const currentHash = computeCandidateHash({ documents: entries });
    if (currentHash !== candidateFile.candidateHash
      || (confirmInput.candidateHash !== undefined && confirmInput.candidateHash !== currentHash)) {
      throw new ToolError('kb_confirm_stale', '候选内容已变化，确认失效：请重新构建或在草稿上排查改动', 409);
    }
    // 基准复核（B 案 §7：标准库基准版本未改变）
    const store = new StandardKbStore(outputRoot);
    if ((store.readCurrent()?.releaseId ?? null) !== checkpoint.baseReleaseId) {
      throw new ToolError('base_release_changed', '标准库已发布其他版本，候选基准失效，请重新构建', 409);
    }
    // 源快照 + 产物完整性重验收（确认不能绕过）
    const state = this.rebuildBuildStateFromCheckpoint(checkpoint, stagingRoot, config.knowledgeBaseRoot);
    const excludedNow = new Set([...(this.deps.excludedSourcesProvider?.() ?? []), ...(this.deps.publishedTokensProvider?.() ?? [])]);
    const currentDocuments = this.deps.documentsProvider().filter((doc) => !excludedNow.has(doc.objToken));
    verifySnapshotIntact(state.snapshot, config.knowledgeBaseRoot, this.deps.sheetCsvPaths, currentDocuments);
    const issues = this.validateStaging(state, state.snapshot, state.docMeta ?? new Map(), outputRoot);
    if (issues.length > 0) {
      writeReport(outputRoot, buildId, issues);
      throw new ToolError('kb_publish_blocked', `确认前确定性校验未通过（${issues.length} 个问题，详见 report）`, 409);
    }
    const confirmedAt = new Date().toISOString();
    const candidate: CandidateRelease = {
      ...candidateFile.candidate,
      documents: entries,
      acceptance: {
        ...candidateFile.candidate.acceptance,
        decisionMode: 'confirm',
        decidedBy: confirmInput.actor ?? 'user',
        decidedAt: confirmedAt,
      },
      confirmBinding: { candidateHash: currentHash, confirmedAt, actor: confirmInput.actor ?? 'user' },
    };
    const publishCheck = canPublish({
      candidate,
      reports: KbBuildService.collectReviewReports(stagingRoot),
      requiredReviewDraftHashes: [currentHash],
      expectedSourceSnapshotHash: computeSnapshotHash(state.snapshot.entries),
      expectedBaseReleaseId: checkpoint.baseReleaseId,
    });
    if (!publishCheck.publishable) {
      throw new ToolError('kb_publish_blocked', `发布条件未满足：${publishCheck.details.join('；')}`, 409);
    }
    // 发布（沿用既有原子发布：manifest + CURRENT rename + 保留策略）
    const releaseId = `r_${new Date().toISOString().replace(/[-:]/g, '').replace('T', 'T').slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`;
    const baseManifest = checkpoint.baseReleaseId ? store.readManifest(checkpoint.baseReleaseId) : null;
    const versionStore = new KbVersionStore(outputRoot);
    const sourceContents = captureSourceContents(state.snapshot, config.knowledgeBaseRoot);
    const changePreview = sourceChangePreview(state.snapshot, sourceContents, baseManifest,
      versionStore.readSourceContents(baseManifest?.releaseId ?? null),
      new Set([...(this.deps.excludedSourcesProvider?.() ?? []), ...(checkpoint.requestedMode === 'full' ? this.deps.unselectedSourcesProvider?.() ?? [] : [])]));
    const manifest = await this.publishRelease({
      buildId,
      releaseId,
      mode: checkpoint.mode,
      baseReleaseId: checkpoint.baseReleaseId,
      knowledgeBaseRoot: config.knowledgeBaseRoot,
      model: row.model ? String(row.model) : null,
      snapshot: state.snapshot,
      stagingRoot,
      outputRoot,
      docMeta: state.docMeta ?? new Map(),
      skippedSources: checkpoint.finishInfo.skipped,
      sourceContents,
      changePreview,
      summary: checkpoint.finishInfo.summary,
    });
    localMapStore.updateKbBuild(buildId, { status: 'published', releaseId, finishedAt: new Date().toISOString() });
    this.emitLog(buildId, 'info', `确认发布完成：release=${releaseId}，${manifest.docs.length} 篇文档`);
    void row;
  }

  /** 从检查点重建 BuildRunState（releaseConfirm 跨重启复核用）。 */
  private rebuildBuildStateFromCheckpoint(checkpoint: BuildCheckpoint, stagingRoot: string, knowledgeBaseRoot: string): BuildRunState {
    const snapshot = RawSourceSnapshot.fromEntries(checkpoint.snapshot, { knowledgeBaseRoot, sheetCsvPaths: this.deps.sheetCsvPaths });
    return {
      knowledgeBaseRoot,
      snapshot,
      mode: checkpoint.mode,
      workset: new Map(checkpoint.workset),
      stagingRoot,
      docMeta: new Map(checkpoint.docMeta),
      finishInfo: checkpoint.finishInfo,
      writtenPaths: new Set(checkpoint.writtenPaths),
      requiredRewrites: new Set(checkpoint.requiredRewrites),
      preservedDocs: new Map(checkpoint.preservedDocs),
      baseDocPaths: new Set(checkpoint.baseDocPaths),
      units: checkpoint.units,
      unitDone: new Map(checkpoint.unitDone),
      claims: new PathClaims(checkpoint.claims ?? []),
      imageDescriptions: new Map((checkpoint.imageDescriptions ?? []).map(([token, values]) => [token, new Map(values)])),
      whiteboardTexts: collectWhiteboardTextsForEntries(knowledgeBaseRoot, snapshot.entries),
    };
  }

  /**
   * T2b：编排进度（B 案附录 B 末段——同一份 BuildOrchestration 数据源，
   * 不生成第二份统计）。活跃构建用内存对象；已结束构建从检查点恢复。
   */
  orchestrationProgress(localMapStore: { getKbBuild(id: string): Record<string, unknown> | null }, buildId: string): KbBuildOrchestrationDto | null {
    const row = localMapStore.getKbBuild(buildId);
    if (!row) return null;
    let orchestration = this.active.get(buildId)?.orchestration ?? null;
    if (!orchestration) {
      const checkpoint = new BuildCheckpointStore(this.outputRoot()).read(buildId);
      if (checkpoint?.orchestration) {
        try {
          orchestration = BuildOrchestration.restore(checkpoint.orchestration);
        } catch {
          return null;
        }
      }
    }
    if (!orchestration) return null;
    const stagingRoot = this.stagingRoot(this.outputRoot(), buildId);
    const latestBlocking = new Map<string, number>();
    for (const unitId of ['all', ...(orchestration.tasks.map((task) => task.unitId).filter((id): id is string => Boolean(id)))]) {
      if (latestBlocking.has(unitId)) continue;
      const report = this.readReviewReportFile(stagingRoot, unitId);
      latestBlocking.set(unitId, report ? report.issues.filter((issue) => issue.severity === 'blocking' && !isIssueClosed(issue)).length : 0);
    }
    const roleModelOf = (role: string): KbBuildOrchestrationTaskDto['model'] => {
      const roles = orchestration!.spec.roles;
      const selected = role === 'review' || role === 'final_review'
        ? roles.reviewer
        : role === 'integrate'
          ? roles.integrator ?? roles.writer
          : roles.writer;
      return { modelPresetId: selected.modelPresetId, ...(selected.providerId ? { providerId: selected.providerId } : {}), ...(selected.thinking ? { thinking: selected.thinking } : {}) };
    };
    const tasks: KbBuildOrchestrationTaskDto[] = orchestration.tasks.map((task) => {
      const ref = parseOrchestrationTaskId(task.taskId);
      const waitingOn: string[] = [];
      for (const dep of task.dependencies) {
        const target = orchestration!.task(dep.taskId);
        if (!target) continue;
        const unlocked = dep.requires === 'artifact_available' ? target.artifactState === 'available' : target.acceptanceState === 'passed';
        if (!unlocked) {
          waitingOn.push(`${dep.taskId}（等待${dep.requires === 'artifact_available' ? '产物可用' : '内容验收通过'}，当前 artifact=${target.artifactState} acceptance=${target.acceptanceState}）`);
        }
      }
      const blockingUnitId = task.role === 'final_review' || task.role === 'integrate' ? 'all' : task.unitId;
      return {
        taskId: task.taskId,
        role: task.role,
        unitId: task.unitId,
        revision: task.revision,
        round: ref?.round ?? 0,
        attempt: ref?.attempt ?? 0,
        execState: task.execState,
        artifactState: task.artifactState,
        acceptanceState: task.acceptanceState,
        waitingOn,
        model: roleModelOf(task.role),
        revisionBudget: task.revisionBudget ? { ...task.revisionBudget } : null,
        blockingIssues: blockingUnitId ? (latestBlocking.get(blockingUnitId) ?? 0) : 0,
      };
    });
    const unitIds = [...new Set(orchestration.tasks.filter((task) => task.unitId).map((task) => task.unitId as string))];
    const latestWrites = [...this.latestWriteTasks(orchestration, unitIds.map((id) => ({ id }) as BuildUnit)).entries()];
    const unitsWritten = latestWrites.filter(([, task]) => task?.artifactState === 'available').length;
    const unitsReviewed = latestWrites.filter(([, task]) => task?.acceptanceState === 'passed').length;
    const unitsPendingRevision = latestWrites.filter(([, task]) => task?.acceptanceState === 'needs_revision' || task?.acceptanceState === 'pending_decision').length;
    const integrates = orchestration.tasks.filter((task) => parseOrchestrationTaskId(task.taskId)?.kind === 'integrate');
    const finals = orchestration.tasks.filter((task) => parseOrchestrationTaskId(task.taskId)?.kind === 'final');
    let carriedOverDocs = 0;
    try {
      const docs = KbBuildService.stagingDocsEntriesOf(stagingRoot);
      const written = new Set(new BuildCheckpointStore(this.outputRoot()).read(buildId)?.writtenPaths ?? []);
      carriedOverDocs = docs.filter((doc) => !written.has(doc.path)).length;
    } catch {
      /* staging 已消费/清理时不计入 */
    }
    const summary = orchestration.summary();
    return {
      buildId,
      spec: {
        specHash: orchestration.spec.specHash ?? null,
        publishMode: orchestration.spec.publishMode,
        concurrency: orchestration.spec.concurrency,
        maxAutoRevisions: orchestration.spec.maxAutoRevisions,
        maxInterfaceRetries: orchestration.spec.maxInterfaceRetries,
      },
      ended: orchestration.ended,
      endReason: orchestration.endReason,
      tasks,
      reviewSummary: {
        unitsWritten,
        unitsReviewed,
        unitsPendingRevision,
        integration: {
          integratePassed: integrates.some((task) => task.acceptanceState === 'passed'),
          finalReviewDone: finals.some((task) => task.execState === 'done' && task.artifactState === 'available'),
          carriedOverDocs,
        },
      },
      lateReceiptCount: summary.lateReceiptCount,
      interfaceRetryTotal: summary.interfaceRetryTotal,
      autoRevisionUsage: summary.autoRevisionUsage,
    };
  }

  // ------------------------------------------------------------------
  // 校验与发布
  // ------------------------------------------------------------------

  private validateStaging(
    state: BuildRunState,
    snapshot: RawSourceSnapshot,
    docMeta: Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>,
    outputRoot: string,
  ): KbBuildReportIssue[] {
    return validateStagingDocs(state, snapshot, { docMeta, outputRoot });
  }

  /**
   * F3-R08：毒化即抛（409）。独立方法避免 TS 控制流把 poisoned 属性跨
   * await 收窄为 never——置位发生在 rpc.prompt 期间的工具执行，静态
   * 分析不可见。
   */
  private throwIfPoisoned(buildState: BuildRunState): void {
    const poisoned = buildState.poisoned;
    if (poisoned) {
      throw new ToolError(poisoned.code, poisoned.message, 409);
    }
  }

  /** 发布 release（public 供单测：manifest 生成 + 原子 CURRENT + 保留策略）。 */
  async publishRelease(input: {
    buildId: string;
    releaseId: string;
    mode: 'incremental' | 'full';
    baseReleaseId: string | null;
    model: string | null;
    snapshot: RawSourceSnapshot;
    stagingRoot: string;
    outputRoot: string;
    docMeta: Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>;
    skippedSources?: Array<{ objToken: string; reason: string }>;
    sourceContents?: SourceContents;
    changePreview?: KbChangePreview;
    summary?: string;
    docMerges?: KbDocMerge[];
    /** 单测注入；缺省读 config */
    retainReleasesOverride?: number;
    /** T4a（A案 §6.2/§7.4）：知识化发布（v2）必需——证据重解引用与资源
     * 区段计算用；无知识声明的 v1 发布不需要。 */
    knowledgeBaseRoot?: string;
  }): Promise<KbManifest> {
    const { outputRoot, releaseId, stagingRoot } = input;
    const docsDir = path.join(stagingRoot, 'docs');
    const releaseDir = path.join(outputRoot, 'releases', releaseId);
    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.mkdirSync(releaseDir, { recursive: true });

    try {
      const manifest = await this.publishReleaseInner(input, docsDir, releaseDir);
      // F3-R10：指针提交点（publishReleaseInner 末尾的 CURRENT rename）
      // 之后的清理是尽力而为：任何异常不得冒泡到外层 catch（那会删除
      // 刚发布的 current release，把发布真相毁掉）；失败只记日志，多余
      // release 保留待下次清理。
      try {
        this.cleanupOldReleases(outputRoot, input.retainReleasesOverride);
      } catch (error) {
        this.emit('log', `旧 release 清理失败（保留现状，不影响本次发布）：${error instanceof Error ? error.message : String(error)}`);
      }
      return manifest;
    } catch (error) {
      // 指针 rename 之前失败：删除未被引用的 release 目录，CURRENT 不动
      fs.rmSync(releaseDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** 门禁 issue → report.json 语义（A案 §7.4：统一进入现有 report，
   * 不新增吞错降级通道）。 */
  private static knowledgeIssueToReport(issue: ValidationIssue): KbBuildReportIssue {
    return {
      code: issue.code,
      message: `${issue.field ? `[${issue.field}] ` : ''}${issue.message}`,
      ...(issue.objectId ? { objToken: issue.objectId } : {}),
    };
  }

  /**
   * T4a（A案 §6.2/§7.4）：知识化发布准备——exact 片段编译、锚点注入、
   * 声明→knowledge.json 投影、sidecar 哈希与发布门禁。
   * - 无知识声明（无 knowledge-draft.json 或零对象）→ null：不产
   *   knowledge.json，manifest 保持 v1（与现状一致，A案 §10.2 双写期）。
   * - 门禁 blocking → 写 report 并抛 kb_publish_blocked：发布失败保留
   *   staging、CURRENT 不动（A案 §7.4 发布前复核）；编译/门禁均在写盘
   *   前完成，半成品 release 目录由 publishRelease 外层 catch 清理。
   */
  private prepareKnowledgePublish(input: {
    buildId: string;
    releaseId: string;
    stagingRoot: string;
    outputRoot: string;
    snapshot: RawSourceSnapshot;
    knowledgeBaseRoot?: string;
    baseReleaseId: string | null;
  }): {
    compiled: KnowledgeCompileResult;
    knowledgeBytes: string;
    evidenceBytes: string;
    governanceBytes: string;
    organization: KbOrganizationManifestSection;
    evidenceSection: { resourcesPath: string; hash: string };
    governanceSection: { path: string; hash: string };
  } | null {
    const draftFile = path.join(input.stagingRoot, 'knowledge-draft.json');
    if (!fs.existsSync(draftFile)) return null;
    let draft: Parameters<typeof compileKnowledgeRelease>[0]['knowledgeDraft'];
    try {
      draft = JSON.parse(fs.readFileSync(draftFile, 'utf8')) as typeof draft;
    } catch (error) {
      throw new ToolError('kb_publish_blocked',
        `knowledge-draft.json 损坏，无法发布：${error instanceof Error ? error.message : String(error)}`, 409);
    }
    if (!draft || draft.schemaVersion !== 1 || !Array.isArray(draft.objects) || draft.objects.length === 0) {
      return null; // 旧式构建：零声明 → v1 布局不变（A案 §10.2）
    }
    // diting F06：托管文档（基线复制，published 基准）不得被旧式重写——
    // 复制时记录 carriedHash，发布前复核 staging 内容仍一致；被改写/删除
    // → 显式拒绝（不允许静默降 v1；工具层已拒旧式 kb_write_doc，此处为
    // 直接落盘改动的防线）。
    const staleManaged: ValidationIssue[] = [];
    for (const [docPath, entry] of Object.entries(draft.docs)) {
      if (entry?.basis !== 'published' || !entry.carriedHash) continue;
      let currentHash: string | null = null;
      try {
        currentHash = contentResourceHash(fs.readFileSync(path.join(input.stagingRoot, 'docs', docPath), 'utf-8'));
      } catch {
        currentHash = null;
      }
      if (currentHash !== entry.carriedHash) {
        staleManaged.push({
          code: 'kb_object_registry_stale', field: 'docs',
          message: `已纳管文档 ${docPath} 在未重申对象声明的情况下被改写/删除（carriedHash 不一致）；发布元数据不会静默降级 v1——请携带 objects 声明重写，或声明对象迁移（diting F06/A 案 §7.2）`,
          severity: 'blocking',
        });
      }
    }
    if (staleManaged.length > 0) {
      writeReport(input.outputRoot, input.buildId, staleManaged.map(KbBuildService.knowledgeIssueToReport));
      throw new ToolError('kb_publish_blocked',
        `知识发布门禁未通过（${staleManaged.length} 个托管文档被旧式改写，详见 report）：${staleManaged.slice(0, 3).map((issue) => issue.message).join('；')}`, 409);
    }
    if (!input.knowledgeBaseRoot) {
      throw new ToolError('invalid_request', '知识化发布需要 knowledgeBaseRoot（证据重解引用与资源区段计算用）', 400);
    }

    // staging 文档（与发布清单同口径：.md + 可解析 feishu_sync_kb 头）
    const docs: CompilerDocInput[] = [];
    const files: string[] = [];
    const stagingDocsDir = path.join(input.stagingRoot, 'docs');
    const walk = (dir: string, prefix: string) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const child = path.join(dir, name);
        if (fs.statSync(child).isDirectory()) walk(child, `${prefix}${name}/`);
        else files.push(`${prefix}${name}`);
      }
    };
    walk(stagingDocsDir, '');
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(stagingDocsDir, file), 'utf8');
      if (!parseStdHeader(content)) continue; // 与 v1 发布点同口径
      docs.push({ path: file, content });
    }

    // 组织计划迁移映射（A案 §2.4；非法项丢弃——语义校验由结构门禁兜底）
    const migrations: ObjectMigration[] = [];
    const planFile = path.join(input.stagingRoot, 'organization-plan.json');
    if (fs.existsSync(planFile)) {
      try {
        const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as { migrations?: ObjectMigration[] };
        for (const raw of plan.migrations ?? []) {
          if (raw && typeof raw.objectId === 'string' && typeof raw.reason === 'string'
            && (raw.kind === 'merge' || raw.kind === 'split' || raw.kind === 'remove')
            && Array.isArray(raw.successorObjectIds) && raw.successorObjectIds.every((id) => typeof id === 'string')) {
            migrations.push(raw);
          }
        }
      } catch {
        /* 计划文件损坏：按无迁移处理，结构校验兜底 */
      }
    }

    // 上一 v2 release 对象集合（A案 §2.4「未解释丢失」检查；v1 基线跳过）
    const previousKnowledge = new KbVersionStore(input.outputRoot).readKnowledgeManifest(input.baseReleaseId);
    const previousObjectIds = previousKnowledge && previousKnowledge.objects.length > 0
      ? previousKnowledge.objects.map((object) => object.objectId)
      : undefined;

    // 证据资源表 + source-contents 区段（A案 §5.4）；readVerified 遇源中途
    // 变化抛 source_changed_during_build，原样传播终止发布
    let inputBytes = 0;
    const evidenceResources: CompilerEvidenceResource[] = [];
    for (const entry of input.snapshot.entries) {
      const verified = input.snapshot.readVerified(input.knowledgeBaseRoot, entry.objToken);
      const spans = sourceContentResourceSpans(verified.content, verified.attachments);
      inputBytes += Buffer.byteLength(verified.content, 'utf8');
      evidenceResources.push({
        resource: {
          resourceId: entry.objToken, kind: 'text', content: verified.content,
          sourceId: entry.objToken, sourceSnapshotHash: entry.contentHash,
          resourceHash: contentResourceHash(verified.content),
        },
        span: { byteOffset: spans[0]!.byteOffset, byteLength: spans[0]!.byteLength },
      });
      verified.attachments.forEach((attachment, index) => {
        const span = spans[index + 1]!;
        inputBytes += Buffer.byteLength(attachment.content, 'utf8');
        evidenceResources.push({
          resource: {
            resourceId: `${entry.objToken}#csv:${span.path}`, kind: 'csv', content: attachment.content,
            path: span.path, sourceId: entry.objToken, sourceSnapshotHash: entry.contentHash,
            resourceHash: contentResourceHash(attachment.content),
          },
          span: { byteOffset: span.byteOffset, byteLength: span.byteLength },
        });
      });
    }
    const maxTotalBytes = Math.max(inputBytes * 3, input.snapshot.size * 4 * 1024);

    const compiled = compileKnowledgeRelease({
      docs,
      knowledgeDraft: draft,
      evidenceResources,
      migrations,
      ...(previousObjectIds ? { previousObjectIds } : {}),
      maxTotalBytes,
      releaseId: input.releaseId,
    });

    // sidecar 投影与哈希（A案 §6.2 发布布局；manifest 绑定三者 hash）
    const sha = (bytes: string): string => `sha256:${crypto.createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
    const knowledgeBytes = `${JSON.stringify(compiled.knowledge, null, 2)}\n`;
    const evidenceBytes = `${JSON.stringify(compiled.evidenceResources, null, 2)}\n`;
    let candidateWrapper: { candidateHash?: string; candidate?: CandidateRelease } | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(input.stagingRoot, 'candidate.json'), 'utf8')) as {
        candidateHash?: string;
        candidate?: CandidateRelease;
      };
      candidateWrapper = parsed;
    } catch {
      candidateWrapper = null;
    }
    const governance: GovernanceFile = {
      schemaVersion: 1,
      releaseId: input.releaseId,
      reviewCredentials: {
        ...(candidateWrapper?.candidate?.acceptance?.acceptanceId
          ? { acceptanceId: candidateWrapper.candidate.acceptance.acceptanceId }
          : {}),
        validReportIds: candidateWrapper?.candidate?.acceptance?.validReportIds ?? [],
        ...(candidateWrapper?.candidateHash ? { candidateHash: candidateWrapper.candidateHash } : {}),
      },
      decisions: [], // 人工业务决定服务属后续迭代（A案 §4.2；本阶段骨架不阻塞）
    };
    const governanceBytes = `${JSON.stringify(governance, null, 2)}\n`;
    const managedPaths = new Set(
      compiled.knowledge.objects.filter((object) => !object.tombstone && object.canonical).map((object) => object.canonical!.path));
    const coverageMode = docs.every((doc) => managedPaths.has(doc.path)) ? 'managed' as const : 'mixed' as const;
    const organization: KbOrganizationManifestSection =
      { schemaVersion: 1, path: 'knowledge.json', hash: sha(knowledgeBytes), coverageMode };
    const evidenceSection = { resourcesPath: 'evidence-resources.json', hash: sha(evidenceBytes) };
    const governanceSection = { path: 'governance.json', hash: sha(governanceBytes) };

    // 读取回执（read-receipts.jsonl；文本/CSV 证据复核，A案 §5.3）
    const receipts: EvidenceReadReceipt[] = [];
    const receiptFile = path.join(input.stagingRoot, 'read-receipts.jsonl');
    if (fs.existsSync(receiptFile)) {
      for (const line of fs.readFileSync(receiptFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { readReceiptId: string; resourceId: string; selector: { lineStart: number; lineEnd: number } };
          receipts.push({ readReceiptId: record.readReceiptId, resourceId: record.resourceId, lineStart: record.selector.lineStart, lineEnd: record.selector.lineEnd });
        } catch {
          /* 损坏行跳过（回执完整性由门禁逐条复核） */
        }
      }
    }

    // 发布门禁（A案 §7.4：canPublish 之后、CURRENT 原子切换之前）
    const gates = runKnowledgeGates({
      compiled,
      candidate: candidateWrapper?.candidate ?? null,
      reviews: KbBuildService.collectReviewReports(input.stagingRoot),
      snapshot: input.snapshot,
      knowledgeBaseRoot: input.knowledgeBaseRoot,
      receipts,
      sidecars: {
        organization: { path: organization.path, hash: organization.hash, bytes: knowledgeBytes },
        evidence: { resourcesPath: evidenceSection.resourcesPath, hash: evidenceSection.hash, bytes: evidenceBytes },
        governance: { path: governanceSection.path, hash: governanceSection.hash, bytes: governanceBytes },
      },
    });
    if (gates.blocking.length > 0) {
      writeReport(input.outputRoot, input.buildId, [
        ...gates.blocking.map(KbBuildService.knowledgeIssueToReport),
        ...gates.warnings.map(KbBuildService.knowledgeIssueToReport),
      ]);
      throw new ToolError('kb_publish_blocked',
        `知识发布门禁未通过（${gates.blocking.length} 个阻断问题，详见 report）：${gates.blocking.slice(0, 3).map((issue) => `${issue.code} ${issue.message}`).join('；')}`, 409);
    }
    for (const warning of gates.warnings) {
      this.emitLog(input.buildId, 'warn', `知识门禁警告 ${warning.code}：${warning.message}`);
    }
    return { compiled, knowledgeBytes, evidenceBytes, governanceBytes, organization, evidenceSection, governanceSection };
  }

  private async publishReleaseInner(
    input: Parameters<KbBuildService['publishRelease']>[0],
    docsDir: string,
    releaseDir: string,
  ): Promise<KbManifest> {
    const { outputRoot, releaseId, stagingRoot } = input;

    const docIdMap = this.readDocIdMap(stagingRoot);

    // T4a（A案 §6.2/§7.4）：staging 存在知识声明 → 编译 + 门禁 + v2 布局
    //（发布正文为编译产物；staging 草稿保留供恢复）；无声明 → v1 不变。
    const knowledgePlan = this.prepareKnowledgePublish({
      buildId: input.buildId,
      releaseId,
      stagingRoot,
      outputRoot,
      snapshot: input.snapshot,
      knowledgeBaseRoot: input.knowledgeBaseRoot,
      baseReleaseId: input.baseReleaseId,
    });

    const docs: KbManifestDoc[] = [];
    const docFiles: Array<{ file: string; full: string }> = [];
    if (knowledgePlan) {
      // v2：编译产物逐文件写入 release/docs（CURRENT rename 仍是唯一提交点）
      const docsRoot = path.join(releaseDir, 'docs');
      for (const compiledDoc of knowledgePlan.compiled.compiledDocs) {
        const target = path.join(docsRoot, compiledDoc.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, compiledDoc.content);
        docFiles.push({ file: compiledDoc.path, full: target });
      }
      fs.writeFileSync(path.join(releaseDir, knowledgePlan.organization.path), knowledgePlan.knowledgeBytes);
      fs.writeFileSync(path.join(releaseDir, knowledgePlan.evidenceSection.resourcesPath), knowledgePlan.evidenceBytes);
      fs.writeFileSync(path.join(releaseDir, knowledgePlan.governanceSection.path), knowledgePlan.governanceBytes);
    } else {
      const files: string[] = [];
      const walk = (dir: string, prefix: string) => {
        for (const name of fs.readdirSync(dir).sort()) {
          const child = path.join(dir, name);
          if (fs.statSync(child).isDirectory()) walk(child, `${prefix}${name}/`);
          else files.push(`${prefix}${name}`);
        }
      };
      walk(docsDir, '');
      for (const file of files) docFiles.push({ file, full: path.join(docsDir, file) });
    }

    for (const { file, full } of docFiles) {
      if (!file.endsWith('.md')) continue;
      const content = fs.readFileSync(full, 'utf-8');
      const header = parseStdHeader(content);
      if (!header) continue; // 校验阶段已拦截
      const body = content.replace(/^<!--\s*\nfeishu_sync_kb:[\s\S]*?\n-->\s*\n?/, '');
      const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim()).slice(0, 30);
      const titleMatch = /^#\s+(.+)$/m.exec(body);
      const meta = input.docMeta.get(file);
      docs.push({
        docId: header.docId,
        path: file,
        title: meta?.title ?? (titleMatch ? titleMatch[1].trim() : file),
        summary: (meta?.summary ?? body.replace(/[#*`\-\n>]/g, ' ').trim().slice(0, 200)).slice(0, 200),
        headings,
        tags: meta?.tags ?? [],
        sources: header.sources,
        contentHash: computeSourceHash(full, []),
        updatedInBuild: input.buildId,
      });
      void docIdMap;
    }

    if (!knowledgePlan) {
      // v1：docs/ 目录整体 rename 进 release（同卷原子；读取后移入，行为不变）
      fs.renameSync(docsDir, path.join(releaseDir, 'docs'));
    }

    const manifest = {
      ...(knowledgePlan
        ? {
          // v2（A案 §10.2）：v1 超集——docs 内容语义不变，旧读者读 v2 正文
          // 仍可用；组织/证据/治理 sidecar 由 manifest hash 绑定（A案 §6.2）
          schemaVersion: KB_MANIFEST_SCHEMA_V2,
          organization: knowledgePlan.organization,
          evidence: knowledgePlan.evidenceSection,
          governance: knowledgePlan.governanceSection,
        }
        : { schemaVersion: 1 }),
      releaseId,
      buildId: input.buildId,
      mode: input.mode,
      baseReleaseId: input.baseReleaseId,
      publishedAt: new Date().toISOString(),
      model: input.model,
      sourceSnapshot: input.snapshot.entries,
      docs,
      skippedSources: input.skippedSources ?? this.active.get(input.buildId)?.buildState?.finishInfo?.skipped ?? [],
    };
    fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const versionStore = new KbVersionStore(outputRoot);
    const baseManifest = input.baseReleaseId ? new StandardKbStore(outputRoot).readManifest(input.baseReleaseId) : null;
    const sourceContents = input.sourceContents ?? {};
    versionStore.writeVersion(manifest, baseManifest, sourceContents,
      input.changePreview ?? sourceChangePreview(input.snapshot, sourceContents, baseManifest,
        versionStore.readSourceContents(input.baseReleaseId)), input.summary ?? '',
      input.docMerges ?? this.active.get(input.buildId)?.buildState?.finishInfo?.docMerges ?? []);

    // CURRENT.json 原子发布：tmp → rename
    // 【F3-R10 指针提交点】rename 成功即发布完成；此后任何失败（清理、
    // 日志、统计）都不得回滚——旧 release 与 CURRENT 的清理/维护均在
    // publishRelease 外层尽力而为进行。
    const pointerPath = path.join(outputRoot, 'CURRENT.json');
    const tmpPath = `${pointerPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({
      schemaVersion: 1,
      releaseId,
      publishedAt: manifest.publishedAt,
    }, null, 2));
    fs.renameSync(tmpPath, pointerPath);
    // CURRENT is committed. Prewarm is best-effort and must never delay/fail publication.
    setImmediate(() => { void getKbQueryService(outputRoot).prewarmCurrent().catch((error) => {
      this.emit('log', `检索索引预热失败（发布已成功）：${String(error)}`);
    }); });
    return manifest;
  }

  private readDocIdMap(stagingRoot: string): Record<string, string> {
    try {
      const mapPath = path.join(stagingRoot, '.docid-map.json');
      if (fs.existsSync(mapPath)) {
        return JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as Record<string, string>;
      }
    } catch {
      /* 无继承 */
    }
    return {};
  }

  private cleanupOldReleases(outputRoot: string, retainOverride?: number): void {
    const config = this.deps.configProvider();
    const retain = Math.max(1, Math.min(20, retainOverride ?? config?.standardKb.retainReleases ?? 3));
    const releasesDir = path.join(outputRoot, 'releases');
    if (!fs.existsSync(releasesDir)) return;
    const store = new StandardKbStore(outputRoot);
    const current = store.readCurrent();
    // F3-R10：目录扫描本身可能失败（权限/并发删除）——清理是尽力而为，
    // 不能因维护性动作破坏发布链路。
    let entries: Array<{ name: string; full: string; mtimeMs: number }>;
    try {
      entries = fs.readdirSync(releasesDir)
        .map((name) => {
          const full = path.join(releasesDir, name);
          const stat = fs.statSync(full, { throwIfNoEntry: false });
          return { name, full, mtimeMs: stat?.mtimeMs ?? 0 };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch (error) {
      this.emit('log', `旧 release 目录扫描失败（跳过清理）：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const entry of entries.slice(retain)) {
      if (current?.releaseId === entry.name) continue;
      // P1-S8（设计 P1 §4.6）：发布任务使用中的 release 跳过清理（发布
      // 固定 releaseId，release 不可变；执行期间被清理会读到半删目录）。
      if (isReleaseInUse(entry.name)) {
        this.emit('log', `release ${entry.name} 发布任务使用中，跳过清理`);
        continue;
      }
      try {
        fs.rmSync(entry.full, { recursive: true, force: true });
        this.emit('log', `已清理旧 release: ${entry.name}`);
      } catch {
        /* 清理失败不阻断 */
      }
    }
  }

  private cleanupAfterPipeline(buildId: string): void {
    // 有检查点的失败/取消草稿保留供恢复；此处释放进程内快照与图片描述。
    const entry = this.active.get(buildId);
    if (entry) entry.checkpointReady = false;
    setTimeout(() => { if (this.active.get(buildId) === entry) this.active.delete(buildId); }, 60_000).unref?.();
  }

  // ------------------------------------------------------------------
  // 启动对账（§5.3）
  // ------------------------------------------------------------------

  reconcileOnStartup(
    localMapStore: Parameters<KbBuildService['createBuild']>[0],
  ): { interruptedBuildIds: string[] } {
    const store = localMapStore as unknown as { markInterruptedKbBuilds(): string[] };
    const interrupted = typeof store.markInterruptedKbBuilds === 'function'
      ? store.markInterruptedKbBuilds()
      : [];
    // 中断草稿与检查点保留，只有验证通过的恢复操作可以替换工作目录。
    const outputRoot = this.outputRoot();
    if (outputRoot) {
      cleanupOldStaging(outputRoot);
      // 指针对账：CURRENT 指向的 release 与 DB 最后 published 不一致 → 以指针为准
      const store = new StandardKbStore(outputRoot);
      const pointer = store.readCurrent();
      if (pointer) {
        const manifest = store.readManifest(pointer.releaseId);
        if (manifest) {
          const builds = (localMapStore as unknown as { listKbBuilds(limit?: number): Array<Record<string, unknown>> }).listKbBuilds?.(50) ?? [];
          const hasPublished = builds.some(
            (row) => row.release_id === pointer.releaseId && row.status === 'published',
          );
          if (!hasPublished) {
            // F3-R09：同 buildId 可能存在 publishing/failed/interrupted 行
            // （崩溃发生在发布后、状态回写前）——UPDATE 修复而非 INSERT 撞
            // PK 吞错（否则行永远停在非终态）。只有缺行才创建。
            const backfill = localMapStore as unknown as {
              getKbBuild(id: string): Record<string, unknown> | null;
              createKbBuild(input: Record<string, unknown>): void;
              updateKbBuild(id: string, patch: Record<string, unknown>): void;
            };
            const recoveredId = manifest.buildId || `b_recovered_${crypto.randomBytes(3).toString('hex')}`;
            try {
              const existingRow = backfill.getKbBuild?.(recoveredId) ?? null;
              if (existingRow) {
                backfill.updateKbBuild(recoveredId, {
                  status: 'published',
                  releaseId: pointer.releaseId,
                  errorCode: null,
                  errorMessage: null,
                  finishedAt: manifest.publishedAt,
                });
              } else {
                backfill.createKbBuild({
                  id: recoveredId,
                  mode: manifest.mode,
                  status: 'published',
                  baseReleaseId: manifest.baseReleaseId,
                  model: manifest.model,
                  createdAt: manifest.publishedAt,
                });
                backfill.updateKbBuild(
                  recoveredId,
                  { status: 'published', releaseId: pointer.releaseId, startedAt: manifest.publishedAt, finishedAt: manifest.publishedAt },
                );
              }
            } catch {
              /* 对账写库失败：指针仍是发布真相，UI 正常 */
            }
          }
        }
      }
    }
    return { interruptedBuildIds: interrupted };
  }
}

class CancelledError extends Error {
  constructor() {
    super('构建已取消');
  }
}

// ===========================================================================
// T2b（B 案 §4）：编排流水模块级辅助
// ===========================================================================

/** 编排流水共享输入（与并行路径同源的调度上下文）。 */
interface OrchestratedPhaseInput {
  buildId: string;
  entry: InMemoryBuild;
  buildState: BuildRunState;
  units: BuildUnit[];
  workerCount: number;
  pluginSnapshot?: AppPluginSnapshot;
  snapshot: RawSourceSnapshot;
  workset: Map<string, 'added' | 'changed' | 'rebuild'>;
  sourceChanges: KbFileChange[];
  systemRules: string;
  promptTimeoutMs: number;
  cancelController: AbortController;
  slotDeadlineMs: number;
  wordBudget: number;
  wordsOf: (token: string) => number;
}

interface OrchestratedTaskRef {
  kind: 'write' | 'review' | 'integrate' | 'final';
  unitId: string | null;
  round: number;
  attempt: number;
}

/**
 * 解析编排任务 id：t:write:<unit>:r<n>[#<a>] / t:review:<unit>:r<n>[#<a>] /
 * t:integrate:r<n>[#<a>] / t:final:r<n>[#<a>]。旧式 t:<unitId>/t:single
 * 返回 null（不走新流水）。
 */
function parseOrchestrationTaskId(taskId: string): OrchestratedTaskRef | null {
  const match = /^t:(write|review):([A-Za-z0-9_-]+):r(\d+)(?:#(\d+))?$/.exec(taskId)
    ?? /^t:(integrate|final):r(\d+)(?:#(\d+))?$/.exec(taskId);
  if (!match) return null;
  if (match.length === 5) {
    return { kind: match[1] as 'write' | 'review', unitId: match[2], round: Number(match[3]), attempt: Number(match[4] ?? 0) };
  }
  return { kind: match[1] as 'integrate' | 'final', unitId: null, round: Number(match[2]), attempt: Number(match[3] ?? 0) };
}

/** 任务排序：轮次优先，同轮按 attempt（后继在后）。 */
function compareTaskOrder(a: string, b: string): number {
  const refA = parseOrchestrationTaskId(a);
  const refB = parseOrchestrationTaskId(b);
  if (!refA || !refB) return a.localeCompare(b);
  if (refA.round !== refB.round) return refA.round - refB.round;
  return refA.attempt - refB.attempt;
}

// ===========================================================================
// 辅助
// ===========================================================================

/**
 * F3-R08：发布前复核快照完整性（导出供单测）：逐源重算 contentHash
 * （主文档 + CSV 附件，与 scan/readVerified 同一哈希函数），任一不一致
 * 抛 source_changed_during_build——模型最后一次 read 之后源被改，不得
 * 切换 CURRENT。新出现的源不改变本次快照，返回其数量供提示下次构建。
 */
export function verifySnapshotIntact(
  snapshot: RawSourceSnapshot,
  knowledgeBaseRoot: string,
  sheetCsvPaths: (objToken: string) => string[],
  currentDocuments?: import('../types/index.js').DocumentRecord[],
): number {
  const rootReal = fs.realpathSync.native(knowledgeBaseRoot);
  let newSources = 0;
  if (currentDocuments) {
    const candidates = collectSourceCandidates(currentDocuments);
    const byToken = new Map(candidates.map((record) => [record.objToken, record]));
    for (const source of snapshot.entries) {
      const record = byToken.get(source.objToken);
      if (!record) {
        throw new ToolError('source_changed_during_build', `发布前复核发现所选源已移除或不再参与构建：${source.relPath}`, 409);
      }
      let current: RawSourceSnapshotEntry | undefined;
      try {
        current = RawSourceSnapshot.scan(rootReal, [record], sheetCsvPaths).entries[0];
      } catch {
        throw new ToolError('source_changed_during_build', `发布前复核无法读取所选源或其附件：${source.relPath}`, 409);
      }
      if (!current || current.contentHash !== source.contentHash) {
        throw new ToolError('source_changed_during_build', `发布前复核发现所选源已变更或不可读取：${source.relPath}`, 409);
      }
      const snapshotPath = path.resolve(rootReal, source.relPath);
      const currentPath = path.resolve(rootReal, current.relPath);
      if ((process.platform === 'win32' ? snapshotPath.toLowerCase() : snapshotPath)
        !== (process.platform === 'win32' ? currentPath.toLowerCase() : currentPath)) {
        throw new ToolError('source_changed_during_build', `发布前复核发现所选源的本地路径已变更：${source.relPath}`, 409);
      }
    }
    for (const record of candidates) {
      if (snapshot.has(record.objToken)) continue;
      try {
        const real = fs.realpathSync.native(path.join(rootReal, record.localRelPath!));
        if (isPathInside(rootReal, real) && fs.statSync(real).isFile()) newSources += 1;
      } catch {
        // 尚未完成同步或无法读取的新增源不计入提示。
      }
    }
  }
  for (const source of snapshot.entries) {
    const realPath = fs.realpathSync.native(path.join(rootReal, source.relPath));
    if (!isPathInside(rootReal, realPath) || !fs.statSync(realPath).isFile()) {
      throw new ToolError('source_changed_during_build', '发布前复核发现原始源越界或不再是普通文件', 409);
    }
    const currentHash = computeSourceHash(
      realPath,
      sheetCsvPaths(source.objToken),
      rootReal,
    );
    if (currentHash !== source.contentHash) {
      throw new ToolError(
        'source_changed_during_build',
        `发布前复核发现源已变更: ${source.relPath}（期望 ${source.contentHash.slice(0, 16)}… 实际 ${currentHash.slice(0, 16)}…）`,
        409,
      );
    }
    // S3（§3.4）：有 mediaHash 的源同步复核图片字节——构建中图片被替换
    // 同样不得切换 CURRENT（主文档字节可能未变）。
    if (!verifyEntryMediaHash(rootReal, source)) {
      throw new ToolError(
        'source_changed_during_build',
        `发布前复核发现源图片已变更: ${source.relPath}`,
        409,
      );
    }
    // P0-S7：有 whiteboardTextHash 的源同步复核旁路文字——构建中白板旁路
    // 被改/删时模型内联文字与快照不一致，同样不得切换 CURRENT。
    if (!verifyEntryWhiteboardTextHash(rootReal, source)) {
      throw new ToolError(
        'source_changed_during_build',
        `发布前复核发现源白板旁路文字已变更: ${source.relPath}`,
        409,
      );
    }
  }
  return newSources;
}

export interface ValidateStagingOptions {
  docMeta?: Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>;
  outputRoot?: string;
}

/** staging 确定性校验（独立函数供单测）：失败项列在 issues。 */
export function validateStagingDocs(
  state: BuildRunState,
  snapshot: RawSourceSnapshot,
  options: ValidateStagingOptions = {},
): KbBuildReportIssue[] {
  const issues: KbBuildReportIssue[] = [];
  const docsDir = path.join(state.stagingRoot, 'docs');
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      const lstat = fs.lstatSync(child);
      if (lstat.isSymbolicLink()) {
        issues.push({ path: `${prefix}${name}`, code: 'symlink_forbidden', message: 'staging 内不允许符号链接' });
        continue;
      }
      if (lstat.isDirectory()) {
        walk(child, `${prefix}${name}/`);
      } else {
        files.push(`${prefix}${name}`);
      }
    }
  };
  walk(docsDir, '');

  if (!state.finishInfo) {
    issues.push({ code: 'kb_finish_missing', message: 'kb_finish 未被调用' });
  }

  let totalBytes = 0;
  const referencedSources = new Set<string>();
  const sourcesByPath = new Map<string, string[]>();
  for (const file of files) {
    try {
      validateStdDocPath(file);
    } catch (error) {
      issues.push({ path: file, code: 'path_invalid', message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!file.endsWith('.md')) {
      issues.push({ path: file, code: 'not_markdown', message: '只允许 .md 文件' });
      continue;
    }
    const full = path.join(docsDir, file);
    const stat = fs.statSync(full);
    if (stat.size > 1024 * 1024) {
      totalBytes += stat.size;
      issues.push({ path: file, code: 'file_too_large', message: `单文件超过 1MB（${stat.size} 字节）` });
      continue;
    }
    const content = fs.readFileSync(full, 'utf-8');
    // 系统生成的来源头不属于模型产出的知识正文，不能占用短文档预算。
    totalBytes += Buffer.byteLength(stripStdHeader(content), 'utf-8');
    if (hasEditorialHistory(stripStdHeader(content)) || hasEditorialHistory(options.docMeta?.get(file)?.summary ?? '')) {
      issues.push({ path: file, code: 'body_contains_change_history', message: '正文含修订记录/版本对比，请改为当前规则的一次成型表述；变更说明单独记录。' });
    }
    const sourceIdentifiers = snapshot.entries.flatMap((entry) => [entry.objToken, entry.relPath]);
    if (hasSourceMetadata(stripStdHeader(content), sourceIdentifiers)
      || hasSourceMetadata(options.docMeta?.get(file)?.summary ?? '', sourceIdentifiers)) {
      issues.push({ path: file, code: 'body_contains_source_metadata', message: '正文不得含来源说明、来源标识、原始路径或构建信息；请自然重写知识内容，来源仅通过sources字段交给侧栏展示。' });
    }
    if (state.requiredRewrites?.has(file) && !state.writtenPaths?.has(file)) {
      issues.push({ path: file, code: 'affected_doc_not_updated', message: '该文档来源已变化，必须重新生成完整正文，不能原样沿用旧草稿。' });
    }
    const header = parseStdHeader(content);
    if (!header) {
      issues.push({ path: file, code: 'header_missing', message: '无法解析 feishu_sync_kb 文件头' });
      continue;
    }
    sourcesByPath.set(file, header.sources);
    if (header.sources.length === 0) {
      issues.push({ path: file, code: 'sources_empty', message: 'sources 为空' });
    }
    for (const token of header.sources) {
      if (!snapshot.has(token)) {
        issues.push({ path: file, objToken: token, code: 'source_not_in_snapshot', message: `来源不在快照内: ${token}` });
      } else {
        referencedSources.add(token);
      }
    }
  }

  // 继续构建不得借重写/清空 staging 丢掉无关文档。允许模型把相关主题
  // 合并到其他路径，但必须显式声明合并，且目标仍继承旧文档的来源。
  const merges = new Map((state.finishInfo?.docMerges ?? []).map((merge) => [merge.path, merge.mergedInto]));
  for (const [docPath, sources] of state.preservedDocs ?? []) {
    const targets = sourcesByPath.has(docPath) ? [docPath] : merges.get(docPath);
    if (!targets?.length) {
      issues.push({ path: docPath, code: 'existing_doc_removed', message: '未受影响的已有标准文档被移除；请保留正文，或声明合并到保留其来源的文档。' });
      continue;
    }
    const retained = new Set(targets.flatMap((target) => sourcesByPath.get(target) ?? []));
    for (const source of sources) {
      if (!retained.has(source)) issues.push({ path: docPath, objToken: source, code: 'existing_source_removed', message: '未受影响的已有来源被丢弃；继续构建须保留其内容与来源关系。' });
    }
  }

  // 扩写上限按模型实际可读的文本计量。图文源的 Markdown 往往只有
  // 图片链接；漏掉识图/白板/CSV 会把正常重建误判为膨胀。
  // 每个源至少允许 4 KiB 正文，容纳短源的标题、表格和结构化说明；
  // 保底按源数而非产出篇数增长，不能通过拆分大量文档放大预算。
  let inputBytes = 0;
  for (const entry of snapshot.entries) {
    const source = snapshot.readVerified(state.knowledgeBaseRoot, entry.objToken);
    inputBytes += Buffer.byteLength(source.content, 'utf-8');
    for (const attachment of source.attachments) inputBytes += Buffer.byteLength(attachment.content, 'utf-8');
    const whiteboards = state.whiteboardTexts?.get(entry.objToken);
    for (const [src, description] of state.imageDescriptions?.get(entry.objToken) ?? []) {
      // raw_read 对有白板文字的图片优先内联白板文字，不能重复计入识图。
      if (!whiteboards?.has(src) && description.state !== 'unavailable' && description.text) {
        inputBytes += Buffer.byteLength(description.text, 'utf-8');
      }
    }
    for (const whiteboard of whiteboards?.values() ?? []) inputBytes += Buffer.byteLength(whiteboard.text, 'utf-8');
  }
  const maxBytes = Math.max(inputBytes * 3, snapshot.size * 4 * 1024);
  if (snapshot.size > 0 && totalBytes > maxBytes) {
    issues.push({ code: 'total_too_large', message: `产出正文 ${totalBytes} 字节超过上限 ${maxBytes} 字节（有效源文本 ${inputBytes} 字节 ×3，每源至少 4 KiB；含 CSV、图片描述和白板文字）` });
  }

  // 覆盖检查：工作集内每个源要么被引用，要么在 skipped
  // S4（U8）：skipped 集 = ∪unitDone.skipped ∪ finishInfo.skipped
  const skipped = new Set<string>();
  for (const report of state.unitDone?.values() ?? []) {
    for (const item of report.skipped) skipped.add(item.objToken);
  }
  for (const item of state.finishInfo?.skipped ?? []) skipped.add(item.objToken);
  for (const [token] of state.workset) {
    if (!referencedSources.has(token) && !skipped.has(token)) {
      issues.push({ objToken: token, code: 'source_not_covered', message: '源既未被文档引用也未列入 skipped' });
    }
  }

  // F3-R07：full 不得发布空库——即使全部源都带理由 skip，full 的语义是
  // 重建全库，0 产出必然异常（模型只 finish / 重复 full 未写文档），发布
  // 会把现库替换成空库。skip 的窄门只适用于增量工作集。
  if (state.mode === 'full' && files.length === 0 && snapshot.size > 0) {
    issues.push({ code: 'full_empty_output', message: 'full 构建未产出任何文档，拒绝发布空库' });
  }

  void options;
  return issues;
}

export interface ChangesetResult {
  added: string[];
  changed: string[];
  removed: string[];
  isEmpty(): boolean;
}

/** 变更集 = 当前快照 vs CURRENT release 的 sourceSnapshot（按 objToken 比较 hash）。 */
export function computeChangeset(
  current: RawSourceSnapshotEntry[],
  baseManifest: KbManifest | null,
  opts?: { visionEnabled?: boolean },
): ChangesetResult & { isEmpty(): boolean } {
  const currentByToken = new Map(current.map((entry) => [entry.objToken, entry]));
  const baseByToken = new Map((baseManifest?.sourceSnapshot ?? []).map((entry) => [entry.objToken, entry]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [token, entry] of currentByToken) {
    const base = baseByToken.get(token);
    if (!base) added.push(token);
    else if (base.contentHash !== entry.contentHash || base.relPath !== entry.relPath || base.title !== entry.title) changed.push(token);
    // S3（U4）：vision 启用时变更判定含 mediaHash——双方均非空且不等才算变更；
    // 旧 manifest 无 mediaHash 视为未变（升级后首次增量不触发全量 changed）
    else if (opts?.visionEnabled && base.mediaHash && entry.mediaHash && base.mediaHash !== entry.mediaHash) changed.push(token);
    // P0-S7（设计 §5.5 四象限）：白板旁路文字 hash 变化 → changed，与
    // vision 无关（旁路文字零成本）。象限：旧缺失(??'')×新空 → 不变；
    // 旧空×新非空 → changed（首获文字只重建一次）；旧非空×新非空相等 →
    // 不变 / 不等 → changed；旧非空×新空 → changed（文字消失，内容变化
    // 语义）。contentHash 公式不变——旁路文件不进主哈希。
    else if ((base.whiteboardTextHash ?? '') !== (entry.whiteboardTextHash ?? '')) changed.push(token);
  }
  for (const token of baseByToken.keys()) {
    if (!currentByToken.has(token)) removed.push(token);
  }
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    isEmpty: () => added.length === 0 && changed.length === 0 && removed.length === 0,
  };
}

/** outputRoot 校验（§5.1）：保存配置与每次构建前执行。 */
export function validateOutputRoot(
  outputRoot: string,
  guards: { knowledgeBaseRoot: string; dataRoot: string },
): void {
  if (!outputRoot || typeof outputRoot !== 'string') {
    throw new ToolError('kb_output_root_invalid', '标准库目录不能为空');
  }
  const realParent = fs.realpathSync.native(path.dirname(outputRoot));
  const normalized = (() => {
    // outputRoot 自身存在时用其实 realpath（末段可能是 symlink）；
  // 不存在时退回 父 realpath + basename。
    try {
      return fs.realpathSync.native(outputRoot);
    } catch {
      return path.join(realParent, path.basename(outputRoot));
    }
  })();
  // guard 路径可能以非 realpath 形式传入（macOS /var vs /private/var）：
  // realpath 后再比，否则重叠关系会漏判。
  const norm = (value: string): string => {
    const resolved = path.resolve(value);
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };

  if (guards.knowledgeBaseRoot) {
    const kb = norm(guards.knowledgeBaseRoot);
    const out = norm(normalized);
    if (
      out === kb || out.startsWith(kb + path.sep) || kb.startsWith(out + path.sep)
    ) {
      throw new ToolError('kb_output_root_invalid', '标准库目录不得等于、包含或位于知识库根目录之内');
    }
  }
  const agentDir = path.join(norm(guards.dataRoot), 'agent');
  const out = norm(normalized);
  if (out === agentDir || out.startsWith(agentDir + path.sep) || agentDir.startsWith(out + path.sep)) {
    throw new ToolError('kb_output_root_invalid', '标准库目录不得包含应用 agent 数据目录');
  }
  if (out === path.parse(out).root || out === os.homedir()) {
    throw new ToolError('kb_output_root_invalid', '标准库目录不能是文件系统根或用户主目录');
  }

  const stat = fs.statSync(normalized, { throwIfNoEntry: false });
  if (!stat) {
    fs.mkdirSync(normalized, { recursive: true });
    return;
  }
  if (!stat.isDirectory()) {
    throw new ToolError('kb_output_root_invalid', `路径不是目录: ${outputRoot}`);
  }
  const hasCurrent = fs.existsSync(path.join(normalized, 'CURRENT.json'));
  const hasReleases = fs.existsSync(path.join(normalized, 'releases'));
  const entries = fs.readdirSync(normalized).filter((name) => !name.startsWith('.'));
  if (!hasCurrent && !hasReleases && entries.length > 0) {
    throw new ToolError(
      'kb_output_root_not_empty',
      `目录非空且无 CURRENT.json/releases/（存在 ${entries.slice(0, 5).join(', ')} 等），拒绝接管`,
    );
  }
}

/** 保留可恢复构建；其余暂存目录最多保留最近 3 个。 */
export function cleanupOldStaging(outputRoot: string): void {
  const stagingDir = path.join(outputRoot, '.staging');
  if (!fs.existsSync(stagingDir)) return;
  const entries = fs.readdirSync(stagingDir)
    .map((name) => {
      const full = path.join(stagingDir, name);
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      return { full, mtimeMs: stat?.mtimeMs ?? 0 };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(3)) {
    try {
      const buildId = path.basename(entry.full);
      if (new BuildCheckpointStore(outputRoot).summary(buildId)) continue;
      fs.rmSync(entry.full, { recursive: true, force: true });
    } catch {
      /* 清理失败不阻断 */
    }
  }
}

/**
 * P2-S2（§2.2）：有效字数 = countText(源文件正文).words
 *   + Σ countText(本次识图描述文本).words（unavailable 计 0）
 *   + Σ countText(白板旁路抽取文字).words（P0-S7 上线）
 *
 * 纯函数（调度估计，不进 manifest、不参与任何哈希）；正文读取的是快照
 * 对应的本地文件，与构建输入同源；描述文本取自本次构建识图阶段的结果，
 * 白板文字取自 preflight 旁路预取，保证「计入预算的内容」与「worker 经
 * raw_read 看到的」是同一份。
 */
export function effectiveWords(input: {
  content: string | null;
  imageDescriptions?: Array<{ state: string; text?: string }>;
  whiteboardTexts?: Array<{ text: string }>;
}): number {
  let words = input.content === null ? 0 : countText(input.content).words;
  for (const description of input.imageDescriptions ?? []) {
    if (description.state !== 'unavailable' && description.text) {
      words += countText(description.text).words;
    }
  }
  for (const whiteboard of input.whiteboardTexts ?? []) {
    words += countText(whiteboard.text).words;
  }
  return words;
}

function writeReport(outputRoot: string, buildId: string, issues: KbBuildReportIssue[]): void {
  try {
    const dir = path.join(outputRoot, '.builds', buildId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ issues, generatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* 报告写入失败不改变失败结论 */
  }
}

export type { AgentStatusDto };
