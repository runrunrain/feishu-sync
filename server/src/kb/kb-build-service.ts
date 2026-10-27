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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentProcessPool, AgentBusyError } from '../agent/agent-process-pool.js';
import { AgentToolService, ToolError, validateStdDocPath } from '../agent/agent-tool-service.js';
import type { BuildRunState } from '../agent/agent-tool-service.js';
import { isPathInside } from '../agent/path-guard.js';
import { buildPiProcessEnv, PiRpcProcess } from '../agent/pi-rpc-process.js';
import { PiRuntimeResolver, resolveAppLlmModel } from '../agent/runtime-resolver.js';
import { buildAppLlmRunConfig } from '../agent/provider-descriptor.js';
import { RawSourceSnapshot, computeSourceHash } from './raw-source-snapshot.js';
import { StandardKbStore, parseStdHeader } from './standard-kb-store.js';
import {
  toolsForRunKind,
  type AgentStatusDto,
  type KbBuildDto,
  type KbBuildReportIssue,
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
  internalBaseUrl: () => string;
  extensionPath: () => string | null;
  promptAssets: () => { buildRules: string; styleGuide: string } | null;
}

interface InMemoryBuild {
  id: string;
  batchIndex: number;
  batchTotal: number;
  buildState: BuildRunState | null;
  cancelRequested: boolean;
  process: PiRpcProcess | null;
  events: Array<{ seq: number; event: string; data: unknown }>;
}

export class KbBuildService extends EventEmitter {
  private readonly deps: KbBuildDeps;
  private readonly active = new Map<string, InMemoryBuild>();
  private running = false;

  constructor(deps: KbBuildDeps) {
    super();
    this.deps = deps;
  }

  // ------------------------------------------------------------------
  // 目录布局
  // ------------------------------------------------------------------

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
      progress: entry
        ? { batchIndex: entry.batchIndex, batchTotal: entry.batchTotal }
        : { batchIndex: 0, batchTotal: 0 },
      error: row.error_code
        ? { code: String(row.error_code), message: String(row.error_message ?? '') }
        : null,
      createdAt: String(row.created_at),
      startedAt: row.started_at ? String(row.started_at) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null,
    };
  }

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
      // ============ preflight ============
      setStatus('preflight', { startedAt });
      this.emitLog(buildId, 'info', `preflight：运行时就绪，开始生成原始源快照`);
      cleanupOldStaging(outputRoot);

      const documents = this.deps.documentsProvider();
      const snapshotResult = RawSourceSnapshot.scan(
        config.knowledgeBaseRoot,
        documents,
        this.deps.sheetCsvPaths,
      );
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
      let effectiveMode = mode;
      if (mode === 'incremental' && !baseManifest) {
        effectiveMode = 'full';
        this.emitLog(buildId, 'info', '无已发布版本，incremental 自动按 full 执行');
      }

      // 变更集（§6.4：本地字节比较，云端状态变化不参与）
      const changeset = computeChangeset(snapshot.entries, baseManifest);
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

      const batches = chunk(
        [...workset.keys()].sort(),
        Math.max(1, Math.min(50, config.standardKb.buildBatchSize)),
      );
      // F3-R07：仅 removed 的增量（无 added/changed）也必须有一个批次明确
      // 告知模型删除与受影响文档——不能让删除影响只存在于默认删除逻辑里。
      if (batches.length === 0 && affectedDocs.length > 0) {
        batches.push([]);
      }
      entry.batchTotal = batches.length + 1; // + 最后 finish prompt
      this.emitLog(buildId, 'info', `开始模型构建（${effectiveMode}）：${workset.size} 个工作集源分 ${batches.length} 批`);

      // 拉起构建专用 pi 进程
      const rpc = await this.spawnBuildProcess(buildId, buildState);
      entry.process = rpc;
      const overallTimeout = setTimeout(() => {
        this.emitLog(buildId, 'error', `构建整体超时（${config.standardKb.buildTimeoutMinutes} 分钟）`);
        entry.cancelRequested = true;
        void rpc.abort();
      }, config.standardKb.buildTimeoutMinutes * 60_000);
      overallTimeout.unref?.();

      try {
        const assets = this.deps.promptAssets();
        const systemRules = assets
          ? `${assets.buildRules}\n\n${assets.styleGuide}`
          : '';

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          if (entry.cancelRequested) throw new CancelledError();
          entry.batchIndex = batchIndex + 1;
          const batch = batches[batchIndex];
          const batchPrompt = this.buildBatchPrompt({
            batch,
            snapshot,
            workset,
            affectedDocs,
            batchIndex,
            batchTotal: batches.length,
            firstBatch: batchIndex === 0,
          });
          this.emitLog(buildId, 'info', `批次 ${batchIndex + 1}/${batches.length}：${batch.length} 个源`);
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
          this.emitLog(buildId, 'warn', '未检测到 kb_finish 调用，发送强制纠正提示');
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
        await this.deps.pool.terminate(`build:${buildId}`);
        entry.process = null;
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
      verifySnapshotIntact(snapshot, config.knowledgeBaseRoot, this.deps.sheetCsvPaths, this.deps.documentsProvider());
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

  private async spawnBuildProcess(buildId: string, buildState: BuildRunState): Promise<PiRpcProcess> {
    const config = this.deps.configProvider()!;
    const runtime = await this.deps.resolver.resolveRuntime(config.agent);
    if (!runtime.nodePath || !runtime.piCliPath) {
      throw new ToolError('agent_not_ready', 'Agent 运行时未就绪', 503);
    }
    // F3-R05：容量先预留后 spawn；token 与进程同生命周期（exit 即回收）。
    const slot = this.deps.pool.reserveSlot();
    if (!slot) {
      throw new ToolError('agent_busy', 'Agent 并发已达上限，无法启动构建', 409);
    }
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

    let model: string;
    let apiKey: string | undefined;
    let providerJson: string | undefined;
    if (config.agent.model.source === 'app-llm') {
      // F3-R03：与 probe/会话共用 provider descriptor 单一实现
      const runConfig = buildAppLlmRunConfig(config.llm, config.agent);
      if (!runConfig || !runConfig.apiKey) {
        slot.release();
        this.deps.toolService.revokeToken(token);
        throw new ToolError('agent_not_ready', 'app-llm 模型未配置或缺少 API Key', 503);
      }
      model = runConfig.model;
      apiKey = runConfig.apiKey;
      providerJson = runConfig.providerJson;
    } else {
      const piModel = config.agent.model.piModel?.trim();
      if (!piModel) {
        slot.release();
        this.deps.toolService.revokeToken(token);
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
    if (providerJson) {
      env.FEISHU_SYNC_AGENT_PROVIDER_JSON = providerJson;
    }
    const extensionPath = this.deps.extensionPath();
    const rpc = new PiRpcProcess({
      nodePath: runtime.nodePath,
      piCliPath: runtime.piCliPath,
      ...(extensionPath ? { extensionPath } : {}),
      tools: toolsForRunKind('build'),
      noSession: true,
      model,
      thinking: config.agent.model.thinkingLevel,
      cwd: path.join(this.deps.dataRoot, 'agent', 'empty-cwd'),
      env,
      promptTimeoutMs: config.standardKb.promptTimeoutMinutes * 60_000,
    });
    // F3-R05：任何退出路径（正常/取消/超时/崩溃/池回收）都回收令牌。
    rpc.once('exit', () => this.deps.toolService.revokeToken(token));
    try {
      await rpc.start();
      await rpc.sendCommand('set_auto_retry', { enabled: false }).catch(() => undefined);
      this.deps.pool.register(`build:${buildId}`, rpc, 'build', slot);
    } catch (error) {
      slot.release();
      await rpc.terminate().catch(() => undefined);
      this.deps.toolService.revokeToken(token);
      throw error;
    }
    return rpc;
  }

  private buildBatchPrompt(input: {
    batch: string[];
    snapshot: RawSourceSnapshot;
    workset: Map<string, 'added' | 'changed' | 'rebuild'>;
    affectedDocs: Array<{ path: string; title: string }>;
    batchIndex: number;
    batchTotal: number;
    firstBatch: boolean;
  }): string {
    const lines: string[] = [];
    // F3-R07：仅 removed 的增量没有新增/变更源——空批次也要明确告知删除
    // 与受影响文档，模型决定重建或确认默认删除。
    if (input.batch.length === 0) {
      lines.push(`【批次 ${input.batchIndex + 1}/${input.batchTotal}】本次构建没有新增或变更的源，但有源被删除：`);
      lines.push('');
      lines.push('以下引用已删除源的文档已被默认删除（未复制进本次草稿）：');
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
  const skipped = new Set((state.finishInfo?.skipped ?? []).map((item) => item.objToken));
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
): ChangesetResult & { isEmpty(): boolean } {
  const currentByToken = new Map(current.map((entry) => [entry.objToken, entry]));
  const baseByToken = new Map((baseManifest?.sourceSnapshot ?? []).map((entry) => [entry.objToken, entry]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [token, entry] of currentByToken) {
    const base = baseByToken.get(token);
    if (!base) added.push(token);
    else if (base.contentHash !== entry.contentHash) changed.push(token);
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

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
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
