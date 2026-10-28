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
import type { VisionDescriberLike } from '../agent/agent-tool-service.js';
import { isPathInside } from '../agent/path-guard.js';
import { buildPiProcessEnv, PiRpcProcess } from '../agent/pi-rpc-process.js';
import { PiRuntimeResolver, resolveAppLlmModel } from '../agent/runtime-resolver.js';
import { buildAppLlmRunConfig } from '../agent/provider-descriptor.js';
import { RawSourceSnapshot, computeSourceHash } from './raw-source-snapshot.js';
import { isReleaseInUse } from './publication-service.js';
import { StandardKbStore, parseStdHeader, stripStdHeader } from './standard-kb-store.js';
import { KbVersionStore, captureSourceContents, sourceChangePreview, type SourceContents } from './kb-version-store.js';
import { hasEditorialHistory, hasSourceMetadata } from './body-policy.js';
import { planUnits, packBatches, type BuildUnit } from './build-units.js';
import { countText } from './text-stats.js';
import { PathClaims } from './path-claims.js';
import { collectWhiteboardTextsForEntries, enrichEntriesWithMedia, resolveSourceImages, verifyEntryMediaHash, verifyEntryWhiteboardTextHash } from './source-images.js';
import type { ImageDescription } from '../agent/vision/vision-describer.js';
import { VisionDescriber } from '../agent/vision/vision-describer.js';
import { buildDefaultAgentVisionConfig } from '../types/agent-knowledge.js';
import type { KbChangePreview, KbFileChange } from '../types/kb-version.js';
import {
  toolsForRunKind,
  type AgentStatusDto,
  type KbBuildDto,
  type KbBuildImagesProgress,
  type KbBuildProgressDto,
  type KbBuildReportIssue,
  type KbBuildUnitsProgress,
  type KbBuildWorkerProgress,
  type KbCurrentPointer,
  type KbManifest,
  type KbManifestDoc,
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
  /** P1-S8（设计 P1 §4.1 防线 2）：已发布云文档 token 集（快照排除面）。 */
  publishedTokensProvider?: () => string[];
  internalBaseUrl: () => string;
  extensionPath: () => string | null;
  promptAssets: () => { buildRules: string; styleGuide: string } | null;
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
}

interface InMemoryBuild {
  id: string;
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

  // ------------------------------------------------------------------
  // 目录布局
  // ------------------------------------------------------------------

  private sourceDocuments() {
    const excluded = new Set(this.deps.excludedSourcesProvider?.() ?? []);
    return this.deps.documentsProvider().filter((doc) => !excluded.has(doc.objToken));
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
    const seq = (entry?.events.length ?? 0) + 1;
    const record = { seq, event, data };
    if (entry) {
      entry.events.push(record);
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
    return {
      id: String(row.id),
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
      progress: this.progressOf(entry),
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
    if (!entry) return [];
    if (lastSeq === null) return entry.events;
    return entry.events.filter((record) => record.seq > lastSeq);
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
    input: { mode?: string; confirm?: string },
  ): Promise<KbBuildDto> {
    const config = this.deps.configProvider();
    if (!config) throw new ToolError('invalid_request', '配置不可用');
    if (input.confirm !== 'BUILD') {
      throw new ToolError('confirmation_required', '构建需要 confirm: "BUILD"');
    }
    if (input.mode !== 'incremental' && input.mode !== 'full') {
      throw new ToolError('invalid_request', "mode 必须是 'incremental' 或 'full'");
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
    this.active.set(buildId, {
      id: buildId,
      batchIndex: 0,
      batchTotal: 0,
      buildState: null,
      cancelRequested: false,
      cancelController: null,
      timedOut: false,
      workers: new Map(),
      stage: null,
      units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 },
      images: { total: 0, described: 0, cached: 0, unavailable: 0 },
      process: null,
      events: [],
    });

    // 异步执行
    void this.runPipeline(localMapStore as never, buildId, input.mode).catch((error) => {
      console.error('[KbBuildService] pipeline crashed:', error);
    });

    const row = localMapStore.getActiveKbBuild();
    return this.toDto(row ?? { id: buildId, mode: input.mode, status: 'queued', created_at: new Date().toISOString() }, this.active.get(buildId));
  }

  async cancelBuild(
    localMapStore: { getKbBuild(id: string): Record<string, unknown> | null; updateKbBuild(id: string, patch: Record<string, unknown>): void },
    buildId: string,
  ): Promise<KbBuildDto | null> {
    const row = localMapStore.getKbBuild(buildId);
    if (!row) return null;
    const status = String(row.status);
    if (!['queued', 'preflight', 'running', 'validating', 'publishing'].includes(status)) {
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
    this.running = true;
    const config = this.deps.configProvider()!;
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
      const pluginSnapshot = this.deps.pluginStore?.snapshot('build');
      // ============ preflight ============
      setStatus('preflight', { startedAt });
      entry.stage = 'snapshot';
      this.emitLog(buildId, 'info', `preflight：运行时就绪，开始生成原始源快照`);
      cleanupOldStaging(outputRoot);

      const documents = this.sourceDocuments();
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
      const snapshotResult = RawSourceSnapshot.scan(
        config.knowledgeBaseRoot,
        publishedExcludedCount > 0
          ? documents.filter((doc) => !publishedTokens.has(doc.objToken))
          : documents,
        this.deps.sheetCsvPaths,
      );
      // S3（§3.4）：为全部条目补充 mediaHash/imageCount（contentHash 公式不变）
      enrichEntriesWithMedia(config.knowledgeBaseRoot, snapshotResult.entries);
      const snapshot = RawSourceSnapshot.fromEntries(snapshotResult.entries, {
        knowledgeBaseRoot: config.knowledgeBaseRoot,
        sheetCsvPaths: this.deps.sheetCsvPaths,
      });
      this.emitLog(buildId, 'info', `快照完成：${snapshot.size} 个原始源（${snapshotResult.missingFiles.length} 个候选源文件缺失）`);

      // staging 准备
      stagingRootPath = this.stagingRoot(outputRoot, buildId);
      fs.rmSync(stagingRootPath, { recursive: true, force: true });
      fs.mkdirSync(path.join(stagingRootPath, 'docs'), { recursive: true });
      fs.writeFileSync(
        path.join(stagingRootPath, 'raw-snapshot.json'),
        JSON.stringify(snapshot.entries, null, 2),
      );

      const store = new StandardKbStore(outputRoot);
      const basePointer: KbCurrentPointer | null = store.readCurrent();
      const baseManifest: KbManifest | null = basePointer ? store.readManifest(basePointer.releaseId) : null;
      const versionStore = new KbVersionStore(outputRoot);
      const sourceContents = captureSourceContents(snapshot, config.knowledgeBaseRoot);
      const changePreview = sourceChangePreview(snapshot, sourceContents, baseManifest,
        versionStore.readSourceContents(baseManifest?.releaseId ?? null),
        new Set(this.deps.excludedSourcesProvider?.() ?? []));
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
      const workset = new Map<string, 'added' | 'changed' | 'rebuild'>();
      if (effectiveMode === 'full') {
        for (const source of snapshot.entries) workset.set(source.objToken, 'rebuild');
      } else {
        for (const token of changeset.added) workset.set(token, 'added');
        for (const token of changeset.changed) workset.set(token, 'changed');
      }

      localMapStore.updateKbBuild(buildId, {
        sourceTotal: snapshot.size,
        sourceAdded: changeset.added.length,
        sourceChanged: changeset.changed.length,
        sourceRemoved: changeset.removed.length,
      });

      if (effectiveMode === 'incremental' && changeset.isEmpty()) {
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
      const docMeta = new Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>();
      let docsDeletedByDefault = 0;
      if (effectiveMode === 'incremental' && baseManifest) {
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

      // ============ running ============
      entry.buildState = {
        knowledgeBaseRoot: config.knowledgeBaseRoot,
        snapshot,
        mode: effectiveMode,
        workset,
        stagingRoot: stagingRootPath,
        finishInfo: null,
        writtenPaths: new Set(),
      };
      // 局部引用：TS 收窄 + 后续批次/finish/校验统一用它（避免可空回读）
      const buildState: BuildRunState = entry.buildState;
      // kb_write_doc 写入时同步 docMeta（通过 onEvent 钩子后校验阶段重建也可），
      // 校验阶段以解析 staging 文件头为准，meta 仅作标题/摘要补充源。
      this.patchBuildStateMeta(buildState, docMeta);
      setStatus('running');

      const affectedDocs = effectiveMode === 'incremental' && baseManifest
        ? baseManifest.docs
            .filter((doc) => doc.sources.some((token) => workset.has(token) || changeset.removed.includes(token)))
            .map((doc) => ({ path: doc.path, title: doc.title }))
        : [];

      buildState.requiredRewrites = new Set(affectedDocs.map((doc) => doc.path)
        .filter((docPath) => fs.existsSync(path.join(stagingRootPath, 'docs', docPath))));

      // P0-S7（设计 §5.6 + 任务 4）：白板旁路文字预取——raw_read 可读任意
      // 快照源，全量预取一次（仅非空文字占内存）；describeWorksetImages 用
      // 它跳过已有文字的白板识图（省额度，svg/raw 同规则）。
      buildState.whiteboardTexts = collectWhiteboardTextsForEntries(config.knowledgeBaseRoot, snapshot.entries);

      // ---- S3（§3.4）：preflight 图片预描述（stage=describing_images）----
      // vision 就绪 → describeMany（缓存命中不调远端、不计配额）；未就绪 →
      // 全部标 unavailable(vision_unconfigured)。U5：不阻断构建。
      entry.stage = 'describing_images';
      const cancelController = new AbortController();
      entry.cancelController = cancelController;
      buildState.imageDescriptions = await this.describeWorksetImages({
        buildId,
        entry,
        snapshot,
        workset,
        describer: visionDescriber,
        visionReady,
        signal: cancelController.signal,
      });
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
        buildWarnings.push({
          code: 'images_unavailable',
          count: entry.images.unavailable,
          message: `${entry.images.unavailable}/${entry.images.total} 张图片未理解（${visionReady ? '图片理解通道部分失败' : '图片理解未配置'}）；图片引用处已插入 unavailable 标记`,
        });
        this.emitLog(buildId, 'warn', buildWarnings[0].message);
      }
      localMapStore.updateKbBuild(buildId, {
        warningsJson: JSON.stringify(buildWarnings),
        visionModel: visionReady ? visionStatus.model : null,
      });

      // ---- S4（§4.1/§4.2）：单元划分 + worker 调度 ----
      const batchSize = Math.max(1, Math.min(50, config.standardKb.buildBatchSize));
      // P2-S2：每批有效字数预算（ConfigManager 归一后必有；未经归一的对象
      // 缺字段时按 0 = 旧行为处理，保证旧测试夹具字节级等价）
      const wordBudget = Math.max(0, Math.floor(config.standardKb.buildBatchWordBudget ?? 0));
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
      const units = planUnits({
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
      // S4 等价回退：单 worker（buildParallelism=1 或仅 1 个单元）走既有
      // 单进程流水线（全局批切分 + kb_finish 单轮，不引入单元语义）——
      // 保证 buildParallelism 缺省/为 1 时行为与现状等价（含
      // spawnBuildProcess 测试接缝与既有提示词序列）。
      const parallelismWanted = Math.max(1, Math.min(6, Math.floor(config.standardKb.buildParallelism ?? 1)));
      const backgroundLimit = this.deps.pool.max > 1 ? this.deps.pool.max - 1 : 1;
      const workerCount = Math.max(1, Math.min(parallelismWanted, units.length || 1, backgroundLimit));
      localMapStore.updateKbBuild(buildId, { parallelism: workerCount, unitTotal: units.length });

      if (workerCount <= 1) {
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
      buildState.unitDone = new Map();
      buildState.claims = new PathClaims(
        units.flatMap((unit) => unit.ownedDocs.map((docPath) => ({ path: docPath, unitId: unit.id }))),
      );
      entry.units = { total: units.length, done: 0, running: 0, failed: 0, retried: 0 };
      entry.batchTotal = units.reduce((sum, unit) => sum + unit.batches.length, 0) + 1; // + 收尾轮
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

      // ============ publishing ============
      if (entry.cancelRequested) throw new CancelledError();
      setStatus('publishing');
      const releaseId = `r_${new Date().toISOString().replace(/[-:]/g, '').replace('T', 'T').slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`;
      verifySnapshotIntact(snapshot, config.knowledgeBaseRoot, this.deps.sheetCsvPaths, this.sourceDocuments());
      const manifest = await this.publishRelease({
        buildId,
        releaseId,
        mode: effectiveMode,
        baseReleaseId: baseManifest?.releaseId ?? null,
        model: config.agent.model.source === 'app-llm'
          ? (() => {
            const resolution = resolveAppLlmModel(config.llm, config.agent);
            return resolution ? `feishu-sync-llm/${resolution.openAiModel}` : null;
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
        const code = error instanceof ToolError ? error.code : 'kb_build_failed';
        const message = error instanceof Error ? error.message : String(error);
        failBuild(code, message);
      }
    } finally {
      this.running = false;
      void currentStatus;
    }
  }

  private patchBuildStateMeta(state: BuildRunState, docMeta: Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>): void {
    // 把基线 docMeta 交给 tool service：kb_write_doc 更新它，校验阶段读取。
    (state as BuildRunState & { docMeta?: Map<string, { title: string; summary: string; tags: string[]; sources: string[] }> }).docMeta = docMeta;
  }

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

  /** S3（§3.6）：/api/kb/changes 的只读缓存探测（未命中/未启用都计 uncached）。 */
  visionCacheProbe(): ((imageHash: string) => Promise<string | null>) | null {
    const describer = this.resolveVisionDescriber();
    return (hash) => describer.lookup(hash).catch(() => null);
  }

  /**
   * S3（§3.4）：preflight 预描述。枚举工作集源图片 → vision ready 时
   * describeMany（缓存命中不调远端）；否则全部 unavailable(vision_unconfigured)。
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
    if (!input.visionReady) {
      for (const item of items) {
        put(item.objToken, { src: item.src, imageHash: '', state: 'unavailable', reason: 'vision_unconfigured' });
      }
      input.entry.images.unavailable = items.length;
      return result;
    }
    this.emitLog(input.buildId, 'info', `图片预描述：${items.length} 张（命中缓存不调远端）`);
    const composed = await input.describer.describeMany(
      items.map((item) => ({ file: item.file, src: `${item.objToken}::${item.src}` })),
      { signal: input.signal, onProgress: () => undefined },
    );
    let described = 0;
    let cached = 0;
    let unavailable = 0;
    for (const item of items) {
      const description = composed.get(`${item.objToken}::${item.src}`);
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
    return result;
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
    const config = this.deps.configProvider()!;
    // P2-S2：与并行路径同一 packBatches（wordBudget=0 等价旧 chunkTokens）
    const batches = packBatches(
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

    // T3b-06：单 worker 回退与并行路径同一准入语义——acquire('background')
    // FIFO 排队 + M-1 后台配额 + 可取消（受整体超时约束），不再用 session
    // 类 reserveSlot 立即抢最后一个总槽（否则后台任务可占满 M，交互会话
    // 保留槽消失）。
    const rpc = await this.spawnBuildProcess(input.buildId, buildState, input.pluginSnapshot, {
      signal: input.cancelController.signal,
    });
    entry.process = rpc;
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

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
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
        const outcome = await rpc.prompt(
          systemRules ? `${batchPrompt}\n\n---\n构建规则与文风规范（每批适用）：\n${systemRules}` : batchPrompt,
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
      }

      // finish prompt（模型未调用工具时强制重试一次，不静默失败）
      if (entry.cancelRequested) throw new CancelledError();
      this.throwIfPoisoned(buildState);
      entry.stage = 'finishing';
      entry.batchIndex = entry.batchTotal;
      const finishPrompt = [
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
    const config = this.deps.configProvider()!;
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
  ): NodeJS.ProcessEnv {
    const config = this.deps.configProvider()!;
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
   * 假模型）。T3b-06：槽位经 acquireSingleWorkerSlot（acquire('background')
   * FIFO + M-1 配额 + 可取消）；拿不到（整体超时内）→ agent_busy 409。
   */
  private async spawnBuildProcess(
    buildId: string,
    buildState: BuildRunState,
    pluginSnapshot?: AppPluginSnapshot,
    slotOptions: { signal?: AbortSignal; slotDeadlineMs?: number } = {},
  ): Promise<PiRpcProcess> {
    const config = this.deps.configProvider()!;
    const runtime = await this.deps.resolver.resolveRuntime(config.agent);
    if (!runtime.nodePath || !runtime.piCliPath) {
      throw new ToolError('agent_not_ready', 'Agent 运行时未就绪', 503);
    }
    const slot = await this.acquireSingleWorkerSlot(slotOptions);
    const { token, revoke } = this.createBuildRunContext(buildId, buildState);

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

    const env = this.buildPiEnv(token, apiKey, providerJson, pluginSnapshot, runtime);
    const extensionPath = this.deps.extensionPath();
    const spawnOptions = {
      nodePath: runtime.nodePath,
      piCliPath: runtime.piCliPath,
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
   * T3b-06：单 worker 槽位获取（与并行路径 acquireWorkerSlot 同一准入
   * 语义）：acquire('background') FIFO 排队、后台配额 M-1、取消信号
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
    const acquiring = this.deps.pool.acquire('background', { signal: controller.signal });
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
      lines.push(`| ${token} | ${entry?.title ?? token} | ${entry?.relPath ?? ''} | ${changeType === 'rebuild' ? '重建（全量构建）' : changeType} |`);
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

  /** 拉起（或按 worker 复用）构建 worker 进程：slot 已由调用方持有。 */
  private async spawnWorkerProcess(input: {
    buildId: string;
    entry: InMemoryBuild;
    buildState: BuildRunState;
    worker: WorkerRuntime;
    pluginSnapshot?: AppPluginSnapshot;
    slot?: PoolSlot;
  }): Promise<void> {
    const config = this.deps.configProvider()!;
    const runtime = await this.deps.resolver.resolveRuntime(config.agent);
    if (!runtime.nodePath || !runtime.piCliPath) {
      throw new ToolError('agent_not_ready', 'Agent 运行时未就绪', 503);
    }
    const { worker } = input;
    const { token, context } = this.deps.toolService.createRunContext({
      runKind: 'build',
      buildId: input.buildId,
      outputRoot: config.standardKb.outputRoot,
      knowledgeBaseRoot: config.knowledgeBaseRoot,
      buildState: input.buildState,
      worker: { workerId: worker.workerId, unitId: worker.unitId, phase: worker.workerId === 'final' ? 'final' : 'unit' },
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

    let model: string;
    let apiKey: string | undefined;
    let providerJson: string | undefined;
    const dropToken = () => this.deps.toolService.revokeToken(token);
    if (config.agent.model.source === 'app-llm') {
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
    if (input.pluginSnapshot) {
      env.FEISHU_SYNC_AGENT_PLUGIN_SNAPSHOT = input.pluginSnapshot.path;
      env.FEISHU_SYNC_AGENT_PLUGIN_REVISION = input.pluginSnapshot.revision;
      if (input.pluginSnapshot.externalPlugins) env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS = '1';
    }
    env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot ?? '';
    const extensionPath = this.deps.extensionPath();
    const spawnOptions = {
      nodePath: runtime.nodePath,
      piCliPath: runtime.piCliPath,
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
      this.deps.pool.register(worker.poolKey, rpc, 'build', input.slot);
    } catch (error) {
      input.slot?.release();
      await rpc.terminate().catch(() => undefined);
      dropToken();
      throw error;
    }
    worker.rpc = rpc;
  }

  /** 首个槽位受整体超时约束（§4.5：拿不到 → failed agent_busy）；其后排队只受取消。 */
  private async acquireWorkerSlot(input: {
    entry: InMemoryBuild;
    cancelController: AbortController;
    slotDeadlineMs: number;
    slotObtained: () => boolean;
  }): Promise<PoolSlot> {
    const acquiring = this.deps.pool.acquire('background', { signal: input.cancelController.signal });
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
    const { entry, buildState, units } = input;
    let cursor = 0;
    const unitProgress = new Map<string, number>(); // unitId → 已完成批次数
    for (const unit of units) unitProgress.set(unit.id, 0);
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
            const outcome = await worker.rpc!.prompt(
              input.systemRules ? `${batchPrompt}\n\n---\n构建规则与文风规范（每批适用）：\n${input.systemRules}` : batchPrompt,
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
          const retryable = code === 'model_timeout' || code === 'model_request_failed' || code === 'pi_process_exited';
          if (!retryable || retriedUnits.has(unit.id)) throw error;
          retriedUnits.add(unit.id);
          entry.units.retried += 1;
          this.emitBuild(input.buildId, 'build_log', { level: 'warn', message: `单元 ${unit.id} 失败（${code}），自动重试 1 次（从首个未完成批次续跑，已认领文档不释放）`, at: new Date().toISOString() });
          if (worker.rpc) {
            await this.deps.pool.terminate(worker.poolKey).catch(() => undefined);
            worker.rpc = null;
            worker.token = null;
          }
          await attempt(true);
        }
        entry.units.done += 1;
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
      lines.push(`| ${token} | ${entry?.title ?? token} | ${entry?.relPath ?? ''} | ${changeType === 'rebuild' ? '重建（全量构建）' : changeType} |`);
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
    /** 单测注入；缺省读 config */
    retainReleasesOverride?: number;
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

  private async publishReleaseInner(
    input: Parameters<KbBuildService['publishRelease']>[0],
    docsDir: string,
    releaseDir: string,
  ): Promise<KbManifest> {
    const { outputRoot, releaseId, stagingRoot } = input;

    const docIdMap = this.readDocIdMap(stagingRoot);
    const docs: KbManifestDoc[] = [];
    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const child = path.join(dir, name);
        if (fs.statSync(child).isDirectory()) walk(child, `${prefix}${name}/`);
        else files.push(`${prefix}${name}`);
      }
    };
    walk(docsDir, '');

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(docsDir, file), 'utf-8');
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
        contentHash: computeSourceHash(path.join(docsDir, file), []),
        updatedInBuild: input.buildId,
      });
      void docIdMap;
    }

    // docs/ 目录整体 rename 进 release（同卷原子）
    fs.renameSync(docsDir, path.join(releaseDir, 'docs'));

    const manifest: KbManifest = {
      schemaVersion: 1,
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
        versionStore.readSourceContents(input.baseReleaseId)), input.summary ?? '');

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
    // 失败/取消 staging 保留至下次构建开始（诊断用，最多 3 个）——由
    // cleanupOldStaging 处理；此处只清活跃记录。
    setTimeout(() => {
      const entry = this.active.get(buildId);
      if (entry && entry.events.length > 2000) entry.events.length = 500;
    }, 60_000).unref?.();
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
    // 删除 interrupted 对应 staging
    const outputRoot = this.outputRoot();
    if (outputRoot) {
      for (const buildId of interrupted) {
        const staging = this.stagingRoot(outputRoot, buildId);
        try {
          fs.rmSync(staging, { recursive: true, force: true });
        } catch {
          /* 清理失败保留（下次构建前再清） */
        }
      }
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
// 辅助
// ===========================================================================

/**
 * F3-R08：发布前复核快照完整性（导出供单测）：逐源重算 contentHash
 * （主文档 + CSV 附件，与 scan/readVerified 同一哈希函数），任一不一致
 * 抛 source_changed_during_build——模型最后一次 read 之后源被改，不得
 * 切换 CURRENT。
 */
export function verifySnapshotIntact(
  snapshot: RawSourceSnapshot,
  knowledgeBaseRoot: string,
  sheetCsvPaths: (objToken: string) => string[],
  currentDocuments?: import('../types/index.js').DocumentRecord[],
): void {
  const rootReal = fs.realpathSync.native(knowledgeBaseRoot);
  if (currentDocuments) {
    const current = RawSourceSnapshot.scan(rootReal, currentDocuments, sheetCsvPaths).entries;
    const digest = (entries: RawSourceSnapshotEntry[]) => JSON.stringify(entries.map((item) => [item.objToken, item.contentHash]).sort((a, b) => a[0].localeCompare(b[0])));
    if (digest(current) !== digest(snapshot.entries)) {
      throw new ToolError('source_changed_during_build', '发布前复核发现原始源集合或内容已变化', 409);
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
    totalBytes += stat.size;
    if (stat.size > 1024 * 1024) {
      issues.push({ path: file, code: 'file_too_large', message: `单文件超过 1MB（${stat.size} 字节）` });
      continue;
    }
    const content = fs.readFileSync(full, 'utf-8');
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

  // 总量约束：≤ 原始库总量 × 3
  let rawBytes = 0;
  for (const entry of snapshot.entries) {
    try {
      rawBytes += fs.statSync(path.join(state.knowledgeBaseRoot, entry.relPath)).size;
    } catch {
      /* 缺失按 0 */
    }
  }
  if (rawBytes > 0 && totalBytes > rawBytes * 3) {
    issues.push({ code: 'total_too_large', message: `产出总量 ${totalBytes} 超过原始库总量 ×3（${rawBytes * 3}）` });
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

/** 清理旧 staging（保留最近 3 个）。 */
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
