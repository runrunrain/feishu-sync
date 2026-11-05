import { dispatchedTaskState, taskCompletionObservation, restoreTaskCompletionObservations } from './amagi-task-observations.js';
/**
 * build-runtime-host — 构建重构 v2 生产宿主（设计 §2/§3/§4/§5/§8/§9）
 *
 * 职责（应用侧唯一接线点，index.ts 构造、KbBuildService 消费）：
 * - 运行时事实解析（Node/pi 路径与版本，经 PiRuntimeResolver——唯一发现链）。
 * - amagi-pi 版本化包安装/复核（运行层 amagi-package 接口；npm 模式缺包时
 *   明确失败，不静默降级）与静态能力探测（capability-probe；fail-closed，
 *   任何静态 fail 拒绝启用 pi-amagi，绝不回落 legacy）。
 * - 每构建组装运行层 BuildRunSpec（runtime/contracts 唯一规范：模型
 *   descriptors/角色/准入池/自动轮次/agentDirConfigHash 冻结）。
 * - 每构建初始化 BuildActorStore（成果身份权威）与两类工具上下文
 *   （leader/child 双代次令牌，经 AgentToolService.createRunContext），
 *   BuildRunState.v2 挂账本与发布管线。
 * - 启动/续接真实 Pi Leader（PiAmagiBuildRuntime adapter）：初始 prompt
 *   注入（Leader 规则来自 skill 资产，不依赖模型 read）、合并事件泵
 *   （leader-rpc 原始记录 + PiRpcProcess 轮次事件 + actorStore 工具事件）、
 *   把真实原生创建结果转成 BuildActorStore.registerTaskCreation 登记。
 * - 发布回调：Leader 经 build_request_publish 工具触发应用原发布校验
 *   管线（KbBuildService 注入 executor），结果回投监督事件流——不模拟
 *   事件、不令 token 角色伪装 final。
 * - 能力探测/包安装对 UI 暴露（routes/kb.ts 消费；不再永远 503）。
 *
 * 本模块不做：任务调度/角色队列（amagi 职责）、正文校验（工具服务与
 * 发布管线职责）、监督状态机（build-leader-supervisor 职责）。
 */
import fs from 'node:fs';
import {
  AMAGI_TASK_TOOLS,
  BUILD_MODEL_PROVIDER,
  DEFAULT_AUTO_ROUNDS,
  DEFAULT_LEADER_TERMINATE_GRACE_MS,
  DEFAULT_ROLE_AGENTS,
  validateBuildRunSpec,
  type AmagiPackageRef,
  type BuildRunSpec,
  type CapabilityReport,
  type CancelResult,
  type RuntimeBinding,
  type RuntimeEvent,
  type TerminationOutcome,
  type ThinkingLevel,
} from '../agent/build-runtime/contracts.js';
import { assertProbeUsable, runStaticProbes } from '../agent/build-runtime/capability-probe.js';
import {
  AMAGI_PI_GIT_COMMIT, AMAGI_PI_GIT_REPO_URL, AmagiPackageError, amagiGitSourceSpec,
  installAmagiFromGit, installAmagiPackage, readPackageVersion, verifyAmagiPackage,
  amagiInstallDir,
} from '../agent/build-runtime/amagi-package.js';
import { readBundledAmagi, installBundledAmagi, bundledAmagiPackageRoot, type BundledAmagi } from '../agent/bundled-amagi.js';
import {
  compareAmagiVersions, piSdkAvailable, preferredConfiguredAmagi,
  resolveAppPiAgentDir, resolveGlobalPiAgentDir, scanAmagiHome,
  type AmagiCandidate,
} from '../agent/build-runtime/amagi-discovery.js';
import {
  computeAgentDirConfigHash,
  planBuildDirectories,
  renderAgentDirConfigFiles,
} from '../agent/build-runtime/agent-dir-config.js';
import { PiAmagiBuildRuntime } from '../agent/build-runtime/adapter.js';
import type { PiRpcProcess } from '../agent/pi-rpc-process.js';
import { BuildActorStore, resolveV2RoleToolset, V2_CHILD_ALL_TOOLS } from './build-actors.js';
import { V2_LEADER_TOOLS } from '../agent/tool-specs.js';
import type { AgentProcessPool } from '../agent/agent-process-pool.js';
import { ToolError, type AgentToolService, type BuildRunState, type V2PublishHandler } from '../agent/agent-tool-service.js';
import type { PiRuntimeResolver } from '../agent/runtime-resolver.js';
import { resolveProviderModel } from '../modules/model-selection.js';
import { claudeBridgePath, piExtensionPath, piWorkbenchPackageRoot } from '../agent/agent-assets.js';
import type { Config } from '../types/index.js';
import type { LeaderRunCheckpointState, LeaderRunMaterial } from '../types/agent-knowledge.js';
import {
  BuildLeaderSupervisor,
  freshLeaderRunState,
  type LeaderRunOutcome,
} from './build-leader-supervisor.js';

/** 已验证的离线回退版本；新构建可自动采用 Pi home 已声明的较新本地版本。 */
export const AMAGI_PI_PINNED_VERSION = '2.21.31';

/** Leader 工具白名单：amagi 任务面 + 应用构建工具（剔除应用 task 族与正文写工具）。 */
export const LEADER_TOOL_WHITELIST: readonly string[] = [...AMAGI_TASK_TOOLS, ...V2_LEADER_TOOLS];

/** 应用侧解析后的角色模型（LeaderBuildInput.models 成员；显式形状，不 any）。 */
export interface LeaderBuildModel {
  /** 发给 API 的模型 id（不含 provider 前缀）。 */
  modelId: string;
  /** OpenAI 兼容端点 baseUrl（全角色必须一致——models.json 单 provider 声明）。 */
  baseUrl: string;
  /** 冻结思考档位（pi 档位名；须在 thinkingLevels 内）。 */
  thinking?: ThinkingLevel;
  /** 可用档位（app llm 注册表解析；identity 映射进 models.json）。 */
  thinkingLevels?: string[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** 一次 Leader 监督构建的应用侧输入（KbBuildService 组装；宿主转运行层 spec）。 */
export interface LeaderBuildInput {
  buildId: string;
  mode: 'full' | 'incremental';
  /** 起始代次（fresh=1；恢复时为检查点代次，监督器递增后生效）。 */
  generation: number;
  models: { leader: LeaderBuildModel; writer: LeaderBuildModel; reviewer: LeaderBuildModel };
  /** amagi 准入合计上限（1..6；分池在宿主按模型分派）。 */
  maxConcurrentAgents: number;
  publicationPolicy: 'auto' | 'confirm';
  workflowRevision: string;
  workflowSkillPath: string;
  /** 全角色共享 provider 的 API key（只进子进程 env，不落盘不进日志）。 */
  apiKey: string;
  /** fresh 初始 prompt（Leader 规则 + 本次构建交代）。 */
  leaderBriefing: string;
  /** session/rebuild 续接 prompt（剩余工作交代）。 */
  resumeBriefing: string;
  /** 成果级重建携带的已接受草稿与未解决问题（仅 rebuild；不伪造会话记忆）。 */
  rebuildResume: { acceptedDrafts: string[]; openIssues: string[] } | null;
  stagingRoot: string;
  buildState: BuildRunState;
  /** 材料冻结面（恢复比对；源快照哈希+基准版本）。 */
  material: LeaderRunMaterial;
  priorState: LeaderRunCheckpointState | null;
  /** 恢复策略（undefined=fresh；session 前置守卫在监督器）。 */
  resumeStrategy: 'session' | 'rebuild' | undefined;
  /** 发布校验管线执行器（KbBuildService 原 assemble/canPublish/publish 链）。 */
  publishExecutor: V2PublishHandler;
  /** 检查点落盘钩子（监督状态经构建 entry 原子保存）。 */
  onCheckpoint: () => void;
  /** 状态就绪即回传（fresh 创建/恢复载入后立刻调用）——服务侧 entry.leaderRun
   * 必须在监督运行前挂上同一引用，否则全程检查点落盘均无 leaderRun。 */
  onReady?: (state: LeaderRunCheckpointState) => void;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  signal: AbortSignal;
}

/** 运行时状态 DTO（GET /api/kb/build-runtime；UI 消费）。
 * installed 只描述目标版本的私有冻结副本；candidates 描述 Pi home 中的来源。 */
export interface BuildRuntimeStatusDto {
  orchestrationMode: 'legacy' | 'pi-amagi' | 'claude-native';
  runtime: { nodePath: string | null; nodeVersion: string | null; piCliPath: string | null; piVersion: string | null } | null;
  amagi: {
    pinnedVersion: string;
    /** 新构建自动优选的已配置安装实体；null 使用内置 Git 回退版本。 */
    selectedSource: string | null;
    distribution?: 'bundled' | 'configured' | 'git';
    installed: boolean;
    version: string | null;
    installDir: string | null;
    contentHash: string | null;
    layout: string | null;
    /** 私有安装事实：installed=已装且记录可校；missing=未装；broken=目录/记录损坏（带 detail）。 */
    installState: 'installed' | 'missing' | 'broken';
    installDetail: string | null;
    /** 无较新已配置候选时使用的官方 Git 回退来源。 */
    gitSource: string;
    commit: string;
    repoUrl: string;
    /** 只读发现（全局 Pi home + 应用 pi-home）的 amagi-pi 候选。 */
    candidates: AmagiCandidate[];
    /** 发现异常状态（unavailable/error 不代表未安装，单独表达）。 */
    discoveryIssues: Array<{ origin: 'global-pi-home' | 'app-pi-home'; status: 'unavailable' | 'error'; detail: string | null; settingsErrors: Array<{ scope: string; path: string | null; message: string }> }>;
  } | null;
  probe: { staticOk: boolean; fullyVerified: boolean; checks: Array<{ id: string; title: string; kind: string; state: string; detail: string }> } | null;
  error: string | null;
}

export interface BuildRuntimeHostDeps {
  dataRoot: string;
  bundledAmagi?: () => BundledAmagi | null;
  resolver: PiRuntimeResolver;
  toolService: AgentToolService;
  pool: AgentProcessPool;
  configProvider: () => Config | null;
  /** 回环内部 API 基址（端口回填后非空）。 */
  internalBaseUrl: () => string;
  knowledgeBaseRoot: () => string;
  outputRoot: () => string;
}

interface HostSession {
  buildId: string;
  generation: number;
  spec: BuildRunSpec;
  actorStore: BuildActorStore;
  adapter: PiAmagiBuildRuntime;
  binding: RuntimeBinding | null;
  /** 构建态（与流水线同一对象；v2 账本挂载点）。 */
  buildState: BuildRunState;
  /** 本代次签发的令牌（撤销与换代失效用）。 */
  tokens: Set<string>;
  /** 子任务写令牌（发布窗口结算时单独撤销，Leader 令牌保留至收尾）。 */
  childTokens: Set<string>;
  /** 发布窗口结算记录（被接受候选；结算后不再接受新发布申请）。 */
  publishSettled: { candidateHash: string; generation: number; at: string } | null;
  queue: MergedEventQueue;
  pollTimer: NodeJS.Timeout | null;
  recordsTask: Promise<void> | null;
  stopRecords: (() => void) | null;
  supervisor: BuildLeaderSupervisor | null;
  completed: boolean;
}

/** 合并事件队列（宿主泵入；监督器消费）。 */
class MergedEventQueue {
  private readonly items: RuntimeEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  push(event: RuntimeEvent): void {
    if (this.closed) return;
    this.items.push(event);
    for (const wake of this.waiters.splice(0)) wake();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return {
      next: async (): Promise<IteratorResult<RuntimeEvent>> => {
        while (this.items.length === 0 && !this.closed) {
          await new Promise<void>((resolve) => { this.waiters.push(resolve); });
        }
        return this.items.length > 0
          ? { value: this.items.shift()!, done: false }
          : { value: undefined as never, done: true };
      },
      return: async (): Promise<IteratorResult<RuntimeEvent>> => {
        this.closed = true;
        return { value: undefined as never, done: true };
      },
    };
  }
}

/** 迭代器→可迭代适配（监督器回调要求 AsyncIterable）。 */
function asAsyncIterable(iterator: AsyncIterator<RuntimeEvent>): AsyncIterable<RuntimeEvent> {
  return { [Symbol.asyncIterator]: () => iterator };
}

export class BuildRuntimeHost {
  private readonly sessions = new Map<string, HostSession>();
  private eventSeq = 0;
  /** amagi 安装/校验串行门（同版本并发防护）。 */
  private installInFlight = false;

  constructor(private readonly deps: BuildRuntimeHostDeps) {}

  // ------------------------------------------------------------------
  // 运行时事实 / 探测 / 包安装（构建入口与 UI 状态端点共用）
  // ------------------------------------------------------------------

  private config(): Config {
    const config = this.deps.configProvider();
    if (!config) throw new ToolError('build_runtime_unavailable', '应用配置未加载', 503);
    return config;
  }

  /** Node/pi 事实解析（PiRuntimeResolver 唯一发现链；失败显式 503）。 */
  async runtimeFacts(): Promise<{ nodePath: string; piCliPath: string; piVersion: string; piPackageRoot: string | null }> {
    const config = this.config();
    let resolved: Awaited<ReturnType<PiRuntimeResolver['resolveRuntime']>> = null as never;
    try {
      resolved = await this.deps.resolver.resolveRuntime(config.agent);
    } catch (error) {
      throw new ToolError('build_runtime_unavailable', `Pi 运行时解析失败：${error instanceof Error ? error.message : String(error)}`, 503);
    }
    if (!resolved.nodePath || !resolved.piCliPath || !resolved.piVersion) {
      throw new ToolError('build_runtime_unavailable', `Pi 运行时未就绪（node=${resolved.nodePath ?? '未发现'}，pi=${resolved.piCliPath ?? '未发现'}，版本=${resolved.piVersion ?? '未知'}）；请先在设置中安装/配置 Pi 运行时`, 503);
    }
    return { nodePath: resolved.nodePath, piCliPath: resolved.piCliPath, piVersion: resolved.piVersion, piPackageRoot: resolved.piPackageRoot };
  }

  private async preferredAmagi(facts: { nodePath: string; piPackageRoot: string | null }): Promise<{
    version: string; sourceDir: string | null;
    contentHash?: string; bundle: BundledAmagi | null;
    discovery: Awaited<ReturnType<BuildRuntimeHost['discoverAmagi']>>;
  }> {
    const discovery = await this.discoverAmagi(facts);
    const candidate = preferredConfiguredAmagi(discovery.candidates, AMAGI_PI_PINNED_VERSION);
    const bundle = this.bundle();
    if (bundle && (!candidate || compareAmagiVersions(bundle.version, candidate.version!) >= 0)) {
      return { version: bundle.version, sourceDir: bundledAmagiPackageRoot(this.deps.dataRoot, bundle),
        contentHash: bundle.contentHash, bundle, discovery };
    }
    return {
      version: candidate?.version ?? AMAGI_PI_PINNED_VERSION,
      sourceDir: candidate?.packagePath ?? null,
      bundle: null,
      discovery,
    };
  }

  private bundle(): BundledAmagi | null { return (this.deps.bundledAmagi ?? readBundledAmagi)(); }

  private staticReport(facts: { piVersion: string }, version: string, apiKeyOverride?: string, contentHash?: string, installDir?: string): CapabilityReport {
    const config = this.config();
    return runStaticProbes({
      dataRoot: this.deps.dataRoot,
      amagiVersion: version,
      amagiContentHash: contentHash,
      amagiInstallDir: installDir,
      knowledgeBaseRoot: this.deps.knowledgeBaseRoot(),
      outputRoot: this.deps.outputRoot(),
      hasZhipuApiKey: apiKeyOverride !== undefined ? apiKeyOverride.trim() !== '' : this.hasActiveApiKey(config),
      piVersion: facts.piVersion,
    });
  }

  /** 静态能力探测（不断言；构建路径用 probeOrFail，状态端点用本方法）。 */
  async probeReport(apiKeyOverride?: string): Promise<{
    report: CapabilityReport;
    facts: { nodePath: string; piCliPath: string; piVersion: string; piPackageRoot: string | null };
    selected: Awaited<ReturnType<BuildRuntimeHost['preferredAmagi']>>;
  }> {
    const facts = await this.runtimeFacts();
    const selected = await this.preferredAmagi(facts);
    return { report: this.staticReport(facts, selected.version, apiKeyOverride, selected.contentHash), facts, selected };
  }

  /** 探测并 fail-closed 断言（构建路径；静态 fail → 明确 503，不降级）。 */
  private async probeOrFail(apiKeyOverride?: string, frozenPackage?: Pick<AmagiPackageRef, 'version' | 'contentHash'> & { installDir?: string }): Promise<{ report: CapabilityReport; amagiPackage: AmagiPackageRef; piVersion: string }> {
    const probed = frozenPackage
      ? { facts: await this.runtimeFacts(), selected: { version: frozenPackage.version, contentHash: frozenPackage.contentHash, sourceDir: null, installDir: frozenPackage.installDir } }
      : await this.probeReport(apiKeyOverride);
    const { facts, selected } = probed;
    const initial = 'report' in probed ? probed.report : this.staticReport(facts, selected.version, apiKeyOverride, selected.contentHash, 'installDir' in selected ? selected.installDir : undefined);
    if (selected.sourceDir && !initial.amagiPackage) {
      // Upgrade only at a new build boundary. The running build retains its
      // immutable package path and content hash in BuildRunSpec.
      const installed = await this.installAmagi({ sourceDir: selected.sourceDir });
      if (installed.version !== selected.version) {
        throw new ToolError('amagi_source_changed',
          `已配置 amagi-pi 在发现与安装间从 ${selected.version} 变成 ${installed.version}；请重试构建`, 409);
      }
    }
    const report = selected.sourceDir && !initial.amagiPackage
      ? this.staticReport(facts, selected.version, apiKeyOverride, selected.contentHash) : initial;
    try {
      assertProbeUsable(report);
    } catch (error) {
      const failures = report.checks.filter((check) => check.state === 'fail').map((check) => `${check.id}=${check.detail}`);
      throw new ToolError('build_runtime_unavailable', `构建运行时探测未通过，pi-amagi 模式拒绝启动（不降级 legacy）：${failures.join('；') || (error instanceof Error ? error.message : String(error))}`, 503);
    }
    if (!report.amagiPackage) {
      throw new ToolError('build_runtime_unavailable', `amagi-pi@${selected.version} 版本化安装缺失；请先经 POST /api/kb/build-runtime/install 安装`, 503);
    }
    return { report, amagiPackage: report.amagiPackage, piVersion: facts.piVersion };
  }

  /** 应用配置是否具备可用模型密钥（布尔核对；活跃 provider 解析，不取值）。 */
  private hasActiveApiKey(config: Config): boolean {
    const resolution = resolveProviderModel(config.llm, {});
    return Boolean(resolution && resolution.apiKey && resolution.apiKey.trim() !== '');
  }

  /** 私有固定版本安装事实（快速核对；不依赖 Pi 运行时，探测失败也不掩埋）。 */
  private installedFact(version = AMAGI_PI_PINNED_VERSION, contentHash?: string): { state: 'installed' | 'missing' | 'broken'; detail: string | null; ref: (AmagiPackageRef & { record: unknown }) | null } {
    if (contentHash && !fs.existsSync(amagiInstallDir(this.deps.dataRoot, version, contentHash))) return { state: 'missing', detail: null, ref: null };
    try {
      const ref = verifyAmagiPackage({ dataRoot: this.deps.dataRoot, version, contentHash, verifyHash: false });
      return { state: 'installed', detail: null, ref };
    } catch (error) {
      const code = error instanceof AmagiPackageError ? error.code : 'amagi_package_invalid';
      if (code === 'amagi_record_missing') {
        return { state: 'missing', detail: null, ref: null };
      }
      return { state: 'broken', detail: `${code}: ${error instanceof Error ? error.message : String(error)}`, ref: null };
    }
  }

  /** 只读发现（全局 + 应用 Pi home；SDK 不可用如实 unavailable，不抛）。 */
  private async discoverAmagi(facts: { nodePath: string; piPackageRoot: string | null } | null): Promise<{
    candidates: AmagiCandidate[];
    issues: NonNullable<BuildRuntimeStatusDto['amagi']>['discoveryIssues'];
  }> {
    const homes: Array<{ origin: 'global-pi-home' | 'app-pi-home'; agentDir: string }> = [
      { origin: 'global-pi-home', agentDir: resolveGlobalPiAgentDir() },
      { origin: 'app-pi-home', agentDir: resolveAppPiAgentDir(this.deps.dataRoot) },
    ];
    let helperPackageRoot: string | null = null;
    try {
      helperPackageRoot = piWorkbenchPackageRoot();
    } catch {
      helperPackageRoot = null;
    }
    const sdkReady = Boolean(facts && helperPackageRoot && piSdkAvailable(facts.piPackageRoot, facts.nodePath));
    const issues: Array<{ origin: 'global-pi-home' | 'app-pi-home'; status: 'unavailable' | 'error'; detail: string | null; settingsErrors: Array<{ scope: string; path: string | null; message: string }> }> = [];
    const candidates: AmagiCandidate[] = [];
    for (const home of homes) {
      if (!sdkReady) {
        issues.push({ origin: home.origin, status: 'unavailable', detail: 'Pi 运行时或包管理 SDK 不可用（仅无法发现该处候选，不代表未安装）', settingsErrors: [] });
        continue;
      }
      const scan = await scanAmagiHome({
        nodePath: facts!.nodePath,
        helperPackageRoot: helperPackageRoot!,
        piPackageRoot: facts!.piPackageRoot!,
        agentDir: home.agentDir,
        origin: home.origin,
        pinnedVersion: AMAGI_PI_PINNED_VERSION,
      });
      if (scan.status !== 'ok') {
        issues.push({ origin: scan.origin, status: scan.status, detail: scan.detail, settingsErrors: scan.settingsErrors });
      } else if (scan.settingsErrors.length > 0) {
        issues.push({ origin: scan.origin, status: 'error', detail: `Pi settings 载入异常（声明不吞作未装）`, settingsErrors: scan.settingsErrors });
      }
      candidates.push(...scan.candidates);
    }
    return { candidates, issues };
  }

  /** 状态 DTO（UI：能力探测/包安装/运行状态；探测失败如实带回错误，但已装事实
   * 与发现结果不因探测失败被抹成「未安装」——plugin-install-fix 核心修正）。 */
  async statusDto(): Promise<BuildRuntimeStatusDto> {
    const mode = this.config().standardKb.orchestrationMode ?? 'pi-amagi';
    const bundle = this.bundle();
    let fact = this.installedFact(bundle?.version, bundle?.contentHash);
    const gitSource = amagiGitSourceSpec();
    try {
      const { report, facts, selected } = await this.probeReport();
      const discovery = selected.discovery;
      fact = this.installedFact(selected.version, selected.contentHash);
      const amagiRef = report.amagiPackage;
      return {
        orchestrationMode: mode,
        runtime: { nodePath: facts.nodePath, nodeVersion: null, piCliPath: facts.piCliPath, piVersion: facts.piVersion },
        amagi: {
          pinnedVersion: selected.version,
          selectedSource: selected.sourceDir,
          distribution: selected.bundle ? 'bundled' : selected.sourceDir ? 'configured' : 'git',
          installed: amagiRef !== null,
          version: amagiRef?.version ?? null,
          installDir: amagiRef?.installDir ?? null,
          contentHash: amagiRef?.contentHash ?? null,
          layout: fact.state === 'installed' ? String((fact.ref?.record as { layout?: string } | null)?.layout ?? 'source') : null,
          installState: amagiRef !== null ? 'installed' : fact.state,
          installDetail: amagiRef !== null ? null : fact.detail,
          gitSource,
          commit: AMAGI_PI_GIT_COMMIT,
          repoUrl: AMAGI_PI_GIT_REPO_URL,
          candidates: discovery.candidates,
          discoveryIssues: discovery.issues,
        },
        probe: {
          staticOk: report.staticOk,
          fullyVerified: report.fullyVerified,
          checks: report.checks.map((check) => ({ id: check.id, title: check.title, kind: check.kind, state: check.state, detail: check.detail })),
        },
        error: null,
      };
    } catch (error) {
      // 探测失败：runtime/probe 无法给出，但安装事实与发现状态仍如实带回。
      const discovery = await this.discoverAmagi(null);
      return {
        orchestrationMode: mode,
        runtime: null,
        amagi: {
          pinnedVersion: bundle?.version ?? AMAGI_PI_PINNED_VERSION,
          selectedSource: bundle ? bundledAmagiPackageRoot(this.deps.dataRoot, bundle) : null,
          distribution: bundle ? 'bundled' : 'git',
          installed: fact.state === 'installed',
          version: fact.ref?.version ?? null,
          installDir: fact.ref?.installDir ?? null,
          contentHash: fact.ref?.contentHash ?? null,
          layout: fact.state === 'installed' ? String((fact.ref?.record as { layout?: string } | null)?.layout ?? 'source') : null,
          installState: fact.state,
          installDetail: fact.detail,
          gitSource,
          commit: AMAGI_PI_GIT_COMMIT,
          repoUrl: AMAGI_PI_GIT_REPO_URL,
          candidates: discovery.candidates,
          discoveryIssues: discovery.issues,
        },
        probe: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 安装版本化 amagi-pi。
   * - 显式 sourceDir → 读取真实 manifest 版本并独立冻结；
   * - 默认优先已在 Pi home 安装的较新版本（本地/Git/npm），否则用已验证的 Git 回退版本；
   * - 已有安装记录 → 完整哈希校验复用（「校验」而非虚假重装）；
   * - 安装/校验串行化（busy 409），防双写 staging/aside 冲突。 */
  async installAmagi(input: { sourceDir?: string; log?: (line: string) => void } = {}): Promise<AmagiPackageRef & { record: unknown; fresh: boolean }> {
    if (this.installInFlight) {
      throw new ToolError('amagi_install_busy', '已有 amagi-pi 安装/校验进行中，请稍后重试（同版本安装串行执行）', 409);
    }
    this.installInFlight = true;
    try {
      const facts = await this.runtimeFacts();
      try {
        const selected = input.sourceDir ? null : await this.preferredAmagi(facts);
        const sourceDir = input.sourceDir ?? selected?.sourceDir ?? undefined;
        const bundle = selected?.bundle ?? this.bundle();
        if (bundle && sourceDir === bundledAmagiPackageRoot(this.deps.dataRoot, bundle)) {
          return await installBundledAmagi({ ...facts, dataRoot: this.deps.dataRoot, bundle, log: input.log });
        }
        if (sourceDir) {
          const version = readPackageVersion(sourceDir);
          if (!/^\d+\.\d+\.\d+$/.test(version)
            || compareAmagiVersions(version, AMAGI_PI_PINNED_VERSION) < 0) {
            throw new AmagiPackageError('amagi_version_unsupported',
              `amagi-pi@${version} 低于已验证基线 ${AMAGI_PI_PINNED_VERSION} 或不是稳定版本`);
          }
          return await installAmagiPackage({
            nodePath: facts.nodePath,
            piCliPath: facts.piCliPath,
            dataRoot: this.deps.dataRoot,
            version,
            sourceDir,
            includeDependencies: true,
            log: input.log,
          });
        }
        return await installAmagiFromGit({
          nodePath: facts.nodePath,
          piCliPath: facts.piCliPath,
          helperPackageRoot: piWorkbenchPackageRoot(),
          piPackageRoot: facts.piPackageRoot,
          dataRoot: this.deps.dataRoot,
          version: AMAGI_PI_PINNED_VERSION,
          log: input.log,
        });
      } catch (error) {
        if (error instanceof AmagiPackageError) {
          throw new ToolError('amagi_install_failed', `${error.code}: ${error.message}`, 400);
        }
        throw error;
      }
    } finally {
      this.installInFlight = false;
    }
  }

  /** 已安装包复核（构建路径与状态端点共用；verifyHash 缺省全量）。 */
  verifyInstalled(): (AmagiPackageRef & { record: unknown }) | null {
    try {
      const bundle = this.bundle();
      return verifyAmagiPackage({ dataRoot: this.deps.dataRoot, version: bundle?.version ?? AMAGI_PI_PINNED_VERSION, contentHash: bundle?.contentHash, verifyHash: false });
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // 运行层 spec 组装（runtime/contracts 唯一规范；显式转换，无 any）
  // ------------------------------------------------------------------

  /** 应用侧模型 → 运行层模型 spec（provider/model[:thinking]）。 */
  private static modelSpec(model: LeaderBuildModel): string {
    return `${BUILD_MODEL_PROVIDER}/${model.modelId}${model.thinking ? `:${model.thinking}` : ''}`;
  }

  /** 组装 BuildRunSpec（校验内建；agentDirConfigHash 以同 deps 渲染计算后回填）。 */
  private assembleSpec(input: LeaderBuildInput, amagiPackage: AmagiPackageRef, piVersion: string, bridge: { bridgeCommand: string; bridgeArgs: string[] }): BuildRunSpec {
    const dirs = planBuildDirectories(this.deps.dataRoot, input.buildId);
    const descriptorOf = (model: LeaderBuildModel): BuildRunSpec['modelDescriptors'][number] => ({
      id: model.modelId,
      baseUrl: model.baseUrl,
      api: 'openai-completions',
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.thinkingLevels && model.thinkingLevels.length > 0
        ? { thinkingLevelMap: Object.fromEntries(model.thinkingLevels.map((level) => [level, level])) }
        : {}),
      ...(model.thinking ? { thinking: model.thinking } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    });
    // 去重 descriptor（同 modelId 只声明一次；首见形状为准）
    const seen = new Map<string, BuildRunSpec['modelDescriptors'][number]>();
    for (const model of [input.models.leader, input.models.writer, input.models.reviewer]) {
      if (!seen.has(model.modelId)) seen.set(model.modelId, descriptorOf(model));
    }
    const max = input.maxConcurrentAgents;
    const writerPoolKey = BuildRuntimeHost.modelSpec(input.models.writer).split(':')[0];
    const reviewerPoolKey = BuildRuntimeHost.modelSpec(input.models.reviewer).split(':')[0];
    // 同池（同模型）多角色容量必须一致：同模型时均分，不同模型按写作优先
    //（设计 §3.6：写作 4、审查 2；research 复用写作池不重复占容量）。
    const samePool = writerPoolKey === reviewerPoolKey;
    const reviewerPool = samePool ? Math.max(1, Math.floor(max / 2)) : Math.min(2, Math.max(1, max - 1));
    const writerPool = samePool ? reviewerPool : Math.max(1, max - reviewerPool);
    const spec: BuildRunSpec = {
      buildId: input.buildId,
      generation: input.generation,
      orchestrationMode: 'pi-amagi',
      mode: input.mode,
      sourceManifestHash: 'raw-snapshot.json',
      workflowRevision: input.workflowRevision,
      workflowSkillPath: input.workflowSkillPath,
      amagiPackage,
      piVersion,
      agentDirConfigHash: '',
      models: {
        leader: BuildRuntimeHost.modelSpec(input.models.leader),
        writer: BuildRuntimeHost.modelSpec(input.models.writer),
        reviewer: BuildRuntimeHost.modelSpec(input.models.reviewer),
        research: BuildRuntimeHost.modelSpec(input.models.writer),
      },
      modelDescriptors: [...seen.values()],
      roles: { ...DEFAULT_ROLE_AGENTS },
      limits: {
        maxConcurrentAgents: max,
        admissionPools: { writer: writerPool, reviewer: reviewerPool },
        leaderTerminateGraceMs: DEFAULT_LEADER_TERMINATE_GRACE_MS,
      },
      autoRounds: { ...DEFAULT_AUTO_ROUNDS },
      publicationPolicy: input.publicationPolicy === 'confirm' ? 'manual' : 'auto',
    };
    const issues = validateBuildRunSpec(spec);
    if (issues.length > 0) {
      throw new ToolError('build_runtime_unavailable', `BuildRunSpec 校验失败：${issues.join('；')}`, 503);
    }
    const files = renderAgentDirConfigFiles(spec, dirs, bridge);
    spec.agentDirConfigHash = computeAgentDirConfigHash(files);
    return spec;
  }

  // ------------------------------------------------------------------
  // 事件转换（真实原生创建结果 → BuildActorStore 登记；无任何自造授权）
  // ------------------------------------------------------------------

  private nextEventId(): string {
    this.eventSeq += 1;
    return `h${this.eventSeq}`;
  }

  private makeEvent(session: HostSession, type: string, payload: Record<string, unknown>, base?: RuntimeEvent): RuntimeEvent {
    return {
      eventId: base?.eventId ? `${base.eventId}:${type}` : this.nextEventId(),
      source: base?.source ?? 'leader-rpc',
      nativeEventId: base?.nativeEventId ?? null,
      generation: session.generation,
      taskId: typeof payload.nativeTaskId === 'string' ? payload.nativeTaskId : base?.taskId ?? null,
      type,
      occurredAt: base?.occurredAt ?? new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      payload,
    };
  }

  /** amagi 任务工具结果文本里的全量句柄（`句柄: <uuid>`）。 */
  private static parseFullHandle(result: unknown): string | null {
    const text = BuildRuntimeHost.resultText(result);
    const match = text.match(/句柄:\s*([0-9a-fA-F-]{20,})/);
    return match ? match[1] : null;
  }

  /** amagi 任务工具结果 details.taskId（结构化优先）；兜底文本句柄。 */
  private static parseTaskId(result: unknown): string | null {
    const details = (result as { details?: { taskId?: unknown } } | undefined)?.details;
    if (details && typeof details.taskId === 'string' && details.taskId) return details.taskId;
    return BuildRuntimeHost.parseFullHandle(result);
  }

  private static resultText(result: unknown): string {
    const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
    if (!Array.isArray(content)) return '';
    return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
  }

  /** task_resume 结果的父任务全量 id（`父会话 <uuid>`；短 id 回解注册表）。 */
  private static parseParentHandle(result: unknown, args: Record<string, unknown> | undefined, actorStore: BuildActorStore): string | null {
    const text = BuildRuntimeHost.resultText(result);
    const full = text.match(/父会话\s+([0-9a-fA-F-]{20,})/);
    if (full) return full[1];
    const handle = typeof args?.handle === 'string' ? args.handle : '';
    if (!handle) return null;
    const exact = actorStore.lookupActor(handle);
    if (exact) return exact.nativeTaskId;
    const prefixed = actorStore.listActors().find((actor) => actor.nativeTaskId.startsWith(handle));
    return prefixed?.nativeTaskId ?? null;
  }

  /** task_resume 结果短头里的角色名（`[task_resume <8hex> <agent> · …]`）。 */
  private static parseResumeAgent(result: unknown): string | null {
    const text = BuildRuntimeHost.resultText(result);
    const match = text.match(/\[task_resume\s+[0-9a-fA-F-]+\s+([a-z-]+)\s/);
    return match ? match[1] : null;
  }

  /** leader-rpc 原始记录 → 监督事件 + 账本登记（在位转换，不伪造原生结果）。 */
  private convertLeaderRecord(session: HostSession, event: RuntimeEvent): void {
    const payload = event.payload as Record<string, unknown>;
    const recordType = event.type;
    if (recordType === 'tool_execution_start') {
      const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : null;
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
      if (toolCallId && (toolName === 'task_submit' || toolName === 'task_resume')) {
        this.stashedDispatchArgs.set(toolCallId, {
          tool: toolName,
          args: (payload.args && typeof payload.args === 'object' ? payload.args : {}) as Record<string, unknown>,
        });
      }
      return;
    }
    if (recordType === 'tool_execution_end') {
      const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : null;
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
      const isError = payload.isError === true;
      const stash = toolCallId ? this.stashedDispatchArgs.get(toolCallId) : undefined;
      if (toolName === 'task_submit' && stash && !isError) {
        const nativeTaskId = BuildRuntimeHost.parseTaskId(payload.result);
        const requestedRole = typeof stash.args.agent === 'string' ? stash.args.agent : '';
        if (nativeTaskId && requestedRole) {
          try {
            const actor = session.actorStore.registerTaskCreation({
              nativeTaskId,
              requestedRole,
              agent: requestedRole,
              occurredAt: event.occurredAt,
              nativeEventId: event.nativeEventId,
            });
            session.queue.push(this.makeEvent(session, 'task_created', {
              nativeTaskId,
              role: actor.role,
              requestedRole,
              execState: dispatchedTaskState(payload.result),
              parentTaskId: actor.parentTaskId,
            }, event));
          } catch (error) {
            // 账本拒绝（角色表外/父未知等）→ 如实记录，不伪造登记
            session.queue.push(this.makeEvent(session, 'task_registration_rejected', {
              nativeTaskId,
              requestedRole,
              reason: error instanceof Error ? error.message : String(error),
            }, event));
          }
        } else {
          session.queue.push(this.makeEvent(session, 'task_registration_unparsed', {
            tool: 'task_submit',
            requestedRole,
            hasTaskId: Boolean(nativeTaskId),
          }, event));
        }
        return;
      }
      if (toolName === 'task_resume' && !isError) {
        const nativeTaskId = BuildRuntimeHost.parseTaskId(payload.result);
        const parent = BuildRuntimeHost.parseParentHandle(payload.result, stash?.args, session.actorStore);
        const agent = BuildRuntimeHost.parseResumeAgent(payload.result)
          ?? (parent ? session.actorStore.lookupActor(parent)?.role : null)
          ?? (typeof stash?.args.handle === 'string' ? session.actorStore.lookupActor(stash.args.handle)?.role : null)
          ?? 'luban';
        if (nativeTaskId && parent) {
          try {
            const actor = session.actorStore.registerTaskCreation({
              nativeTaskId,
              parentTaskId: parent,
              requestedRole: agent,
              agent,
              occurredAt: event.occurredAt,
              nativeEventId: event.nativeEventId,
            });
            session.queue.push(this.makeEvent(session, 'task_resumed', {
              nativeTaskId,
              role: actor.role,
              parentTaskId: parent,
              execState: dispatchedTaskState(payload.result),
            }, event));
          } catch (error) {
            session.queue.push(this.makeEvent(session, 'task_registration_rejected', {
              nativeTaskId,
              requestedRole: agent,
              reason: error instanceof Error ? error.message : String(error),
            }, event));
          }
        } else {
          session.queue.push(this.makeEvent(session, 'task_registration_unparsed', {
            tool: 'task_resume',
            hasTaskId: Boolean(nativeTaskId),
            hasParent: Boolean(parent),
          }, event));
        }
        return;
      }
      return;
    }
    if (recordType === 'message_end') {
      const message = payload.message as { role?: string; usage?: { input?: number; output?: number } } | undefined;
      if (!message || typeof message.role !== 'string') return;
      if (message.role === 'assistant') {
        const usage = message.usage;
        if (usage && (typeof usage.input === 'number' || typeof usage.output === 'number')) {
          session.queue.push(this.makeEvent(session, 'leader_usage', {
            input: usage.input ?? 0,
            output: usage.output ?? 0,
          }, event));
        }
        return;
      }
      const observation = taskCompletionObservation(message, session.actorStore.listActors());
      if (observation) session.queue.push(this.makeEvent(session, 'task_state', { nativeTaskId: observation.nativeTaskId, status: observation.status }, event));
      return;
    }
  }

  private readonly stashedDispatchArgs = new Map<string, { tool: string; args: Record<string, unknown> }>();

  /** actorStore 工具事件 → 监督事件（发布窗口/身份/活动标记）。 */
  private convertToolServiceEvent(session: HostSession, record: { eventId: string; type: string; taskId: string | null; payload: Record<string, unknown> }): RuntimeEvent | null {
    if (record.type === 'publish_requested') {
      return this.makeEvent(session, 'publish_window_opened', {
        requestId: typeof record.payload.requestId === 'string' ? record.payload.requestId : null,
        candidateRevision: typeof record.payload.candidateHash === 'string' ? record.payload.candidateHash : '',
      });
    }
    if (record.type === 'actor_pending' || record.type === 'artifact_write_doc' || record.type === 'artifact_edit_doc'
      || record.type === 'artifact_delete_doc' || record.type === 'review_submitted' || record.type === 'handoff_submitted') {
      return record.taskId ? this.makeEvent(session, 'task_activity', { nativeTaskId: record.taskId }) : null;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 会话生命周期（KbBuildService 唯一入口；单构建串的不变量由服务层保证）
  // ------------------------------------------------------------------

  /** 活动会话访问（KbBuildService 取消/进度/检查点导出用）。 */
  activeSession(buildId: string): HostSessionView | null {
    const session = this.sessions.get(buildId);
    return session?.supervisor
      ? {
        requestCancel: () => session.supervisor!.requestCancel(),
        progress: () => session.supervisor!.progress(),
        state: () => session.supervisor!.state,
      }
      : null;
  }

  /** 事件泵：rpc 轮次事件 + adapter.observe 原始记录 + actorStore 轮询 → 合并队列。 */
  private startEventPump(session: HostSession, rpc: PiRpcProcess): void {
    let roundSeq = 0;
    rpc.on('round_started', () => {
      roundSeq += 1;
      session.queue.push(this.makeEvent(session, 'round_started', { round: roundSeq }));
    });
    rpc.on('round_settled', (detail: { aborted?: boolean }) => {
      session.queue.push(this.makeEvent(session, 'round_ended', { aborted: detail?.aborted === true }));
    });
    rpc.on('exit', (detail: { code?: number | null }) => {
      if (!session.completed) {
        session.queue.push(this.makeEvent(session, 'process_exit', { code: detail?.code ?? null }));
      }
      session.queue.close();
    });
    rpc.on('transport_error', () => {
      if (!session.completed) {
        session.queue.push(this.makeEvent(session, 'process_exit', { code: null }));
      }
      session.queue.close();
    });
    // 原始记录流（adapter.observe；转换后喂入；进程退出由 rpc exit/transport_error 事件上报）
    session.recordsTask = (async () => {
      try {
        for await (const event of session.adapter.observe(session.binding!)) {
          if (session.completed) break;
          this.convertLeaderRecord(session, event);
        }
      } catch { /* 流异常：exit/transport_error 已另行上报 */ }
    })();
    session.stopRecords = () => { /* 迭代器随进程退出收尾 */ };
    // actorStore 工具事件轮询（同进程内存账本；300ms 节拍）
    let toolCursor: string | null = null;
    session.pollTimer = setInterval(() => {
      if (session.completed) return;
      try {
        for (const record of session.actorStore.eventsSince(toolCursor)) {
          toolCursor = record.eventId;
          const converted = this.convertToolServiceEvent(session, record);
          if (converted) session.queue.push(converted);
        }
      } catch { /* 账本读异常不中断监督 */ }
    }, 300);
    session.pollTimer.unref?.();
  }

  /** 发布回调包装：执行原发布管线，结果回投监督事件流（不模拟事件）。 */
  private wrapPublishExecutor(session: HostSession, executor: V2PublishHandler): V2PublishHandler {
    return async (request) => {
      const outcome = await executor(request);
      session.queue.push(this.makeEvent(session, 'publish_completed', {
        requestId: request.candidateHash.slice(0, 12),
        accepted: outcome.accepted,
        candidateRevision: request.candidateHash,
        summary: request.summary ?? '',
        status: outcome.accepted ? 'accepted' : 'rejected',
        ...(outcome.result && typeof outcome.result === 'object' ? { publication: outcome.result } : {}),
      }));
      return outcome;
    };
  }

  /** Leader 阶段主入口（探测→spec→账本/上下文→启动/续接→监督→收尾）。 */
  async runLeaderPhase(input: LeaderBuildInput): Promise<LeaderRunOutcome> {
    if (this.sessions.has(input.buildId)) {
      throw new ToolError('build_runtime_busy', `构建 ${input.buildId} 已有进行中的 Leader 会话`, 409);
    }
    // 1. 探测（fail-closed；密钥以本次构建解析为准）。
    const frozenPackage = input.resumeStrategy === 'session'
      ? input.priorState?.spec.amagiPackage : undefined;
    const { amagiPackage, piVersion } = await this.probeOrFail(input.apiKey, frozenPackage);
    // 2. 资产定位（转发扩展/桥接脚本/skill；缺失明确失败）。
    const forwardingExtensionPath = piExtensionPath();
    if (!forwardingExtensionPath) {
      throw new ToolError('build_runtime_unavailable', '应用转发扩展缺失（server dist 或源码目录无 pi-extension/feishu-sync-agent.js）', 503);
    }
    const bridgeScript = claudeBridgePath();
    if (!bridgeScript) {
      throw new ToolError('build_runtime_unavailable', 'MCP 桥接脚本缺失（claude-bridge.cjs）', 503);
    }
    if (!fs.existsSync(input.workflowSkillPath)) {
      throw new ToolError('build_runtime_unavailable', `构建 skill 缺失: ${input.workflowSkillPath}`, 503);
    }
    const facts = await this.runtimeFacts();
    const bridge = { bridgeCommand: facts.nodePath, bridgeArgs: [bridgeScript] } as const;
    // 3. spec（含 agentDirConfigHash 冻结）。
    const spec = this.assembleSpec(input, amagiPackage, piVersion, { bridgeCommand: bridge.bridgeCommand, bridgeArgs: [...bridge.bridgeArgs] });
    // 4. 成果账本（身份权威）：新建或从 staging 文件/检查点载荷恢复。
    //    代次与本次运行对齐（steer 修：凭据/账本/监督三者同代次，
    //    否则工具侧 credential_generation_revoked 全拒）。
    const actorStore = new BuildActorStore({ buildId: input.buildId, stagingRoot: input.stagingRoot, generation: input.generation });
    actorStore.load();
    if (actorStore.activeGeneration !== input.generation) {
      actorStore.rotateGeneration(input.generation, `run-start-align（磁盘/检查点旧代次对齐到本次运行代次）`);
    }
    if (input.priorState?.actorPayload && actorStore.listActors().length === 0) {
      try {
        actorStore.restoreCheckpointPayload(input.priorState.actorPayload);
      } catch (error) {
        input.log('warn', `成果账本检查点载荷恢复失败（以 staging 文件为准）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 5. 会话与适配层（发布管线包装在会话建立后注入，结果回投事件流）。
    const queue = new MergedEventQueue();
    const session: HostSession = {
      buildId: input.buildId,
      generation: input.generation,
      spec,
      actorStore,
      adapter: null as never,
      binding: null,
      buildState: input.buildState,
      tokens: new Set<string>(),
      childTokens: new Set<string>(),
      publishSettled: null,
      queue,
      pollTimer: null,
      recordsTask: null,
      stopRecords: null,
      supervisor: null,
      completed: false,
    };
    const publishHandler = this.wrapPublishExecutor(session, input.publishExecutor);
    this.sessions.set(input.buildId, session);
    const adapterDeps = {
      nodePath: facts.nodePath,
      piCliPath: facts.piCliPath,
      dataRoot: this.deps.dataRoot,
      knowledgeBaseRoot: this.deps.knowledgeBaseRoot(),
      outputRoot: this.deps.outputRoot(),
      forwardingExtensionPath,
      bridgeScriptPath: bridgeScript,
      agentUrl: this.deps.internalBaseUrl(),
      resolveZhipuApiKey: (): string => {
        if (!input.apiKey) throw new ToolError('build_runtime_unavailable', '构建模型密钥不可用', 503);
        return input.apiKey;
      },
      issueLeaderRunToken: (): string => {
        const token = this.issueLeaderContext(session);
        session.tokens.add(token);
        return token;
      },
      issueMcpBridgeCredentials: (): { url: string; token: string } => {
        const token = this.issueChildContext(session);
        session.tokens.add(token);
        session.childTokens.add(token);
        return { url: this.deps.internalBaseUrl(), token };
      },
      revokeGenerationCredentials: (): boolean => {
        this.revokeSessionTokens(session);
        return true;
      },
      fenceBuildCredentials: (buildId: string): boolean => {
        this.deps.toolService.revokeByBuild(buildId);
        session.tokens.clear(); session.childTokens.clear();
        return true;
      },
      leaderTools: [...LEADER_TOOL_WHITELIST],
      roleMcpTools: BuildRuntimeHost.roleMcpTools(),
      getLeaderModel: (specRef: BuildRunSpec): string => specRef.models.leader,
      isProcessAlive: (pid: number | null): boolean => {
        try {
          if (pid === null || !Number.isSafeInteger(pid) || pid < 1) return true;
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      },
      log: (line: string) => input.log('info', line),
    };
    session.adapter = new PiAmagiBuildRuntime(adapterDeps);
    // 7. 监督器（状态来自检查点或全新）。
    const state = input.priorState ?? freshLeaderRunState(spec, input.material);
    // 服务侧 entry.leaderRun 立即挂上同一引用（运行全程检查点/进度可见；
    // 修复：此前在 runLeaderPhase 返回后才赋值，中途落盘全无 leaderRun）。
    input.onReady?.(state);
    if (input.priorState && input.resumeStrategy !== 'session') {
      // 成果级重建：采用当前冻结面（新 spec + 当前材料；代次保留旧值，监督器递增）。
      state.spec = { ...spec, generation: state.spec.generation };
      state.material = input.material;
    }
    // 会话级恢复：保留检查点冻结 spec——它是 prepareResume 冻结比对的
    // 对象，也是 adapter.resume 核对 agentDir 的依据（不悄悄换配置）。
    const freeze = () => ({
      piVersion,
      amagiContentHash: amagiPackage.contentHash,
      agentDirConfigHash: spec.agentDirConfigHash,
      workflowRevision: spec.workflowRevision,
    });
    const supervisor = new BuildLeaderSupervisor({
      pool: this.deps.pool,
      log: input.log,
      persistCheckpoint: input.onCheckpoint,
      // 换代同步：账本与宿主代次跟随监督器递增（凭据/账本/监督三者同代次；
      // 未接线则工具侧 credential_generation_revoked 全拒）
      rotateGeneration: (generation: number, reason: string) => {
        session.actorStore.rotateGeneration(generation, reason);
        session.generation = generation;
      },
      revokeCredentials: (reason: string) => {
        this.revokeSessionTokens(session);
        session.actorStore.appendEvent({
          source: 'tool-service',
          type: 'generation_revoked',
          generation: session.generation,
          payload: { reason },
        });
      },
      startLeader: async ({ spec: runSpec, resumeMode }) => {
        session.generation = runSpec.generation;
        session.spec = runSpec;
        // 恢复换代：账本旋转（旧代次身份/分配全部失效）。
        if (resumeMode !== 'fresh' && runSpec.generation > session.actorStore.activeGeneration) {
          session.actorStore.rotateGeneration(runSpec.generation, `leader_${resumeMode}_resume`);
        }
        // BuildRunState.v2 挂账本（工具侧 v2 前置门按此执法）。
        input.buildState.v2 = {
          actorStore: session.actorStore,
          generation: session.generation,
          publishHandler,
        };
        const binding = resumeMode === 'session' && state.binding
          ? await session.adapter.resume(state.binding, {
            buildId: session.buildId,
            generation: session.generation,
            spec: runSpec,
            binding: state.binding,
            artifactReceiptRefs: [],
            eventCursor: null,
          })
          // F09：fresh/rebuild 都走 start；epoch 由监督器状态分配（rebuild 已
          // 递增）——新 epoch = 全新 agentDir/会话/amagi 内部库，不打开旧会话。
          : await session.adapter.start(runSpec, { runtimeEpoch: state.runtimeEpoch ?? 1 });
        session.binding = binding;
        const rpc = session.adapter.getRpcProcess(binding);
        if (!rpc) {
          throw new ToolError('build_runtime_unavailable', 'Leader RPC 句柄不可得（启动异常）', 500);
        }
        this.startEventPump(session, rpc);
        // 初始 prompt（fresh=Leader 规则+交代；resume=剩余工作交代）。
        const briefing = resumeMode === 'fresh' ? input.leaderBriefing : input.resumeBriefing;
        void rpc.prompt(briefing).then(
          (outcome) => {
            if (outcome.outcome === 'failed' && !session.completed) {
              session.queue.push(this.makeEvent(session, 'leader_prompt_failed', {
                message: outcome.error ? `${outcome.error.code}: ${outcome.error.message}` : '模型运行失败',
              }));
            }
          },
          (error: unknown) => {
            if (!session.completed) {
              session.queue.push(this.makeEvent(session, 'leader_prompt_failed', {
                message: error instanceof Error ? error.message : String(error),
              }));
            }
          },
        );
        return binding;
      },
      cancelLeader: async (binding: RuntimeBinding | null): Promise<CancelResult | null> => {
        this.revokeSessionTokens(session);
        if (!binding && !session.binding) return null;
        return session.adapter.cancel(binding ?? session.binding!);
      },
      events: (): AsyncIterable<RuntimeEvent> => asAsyncIterable(queue[Symbol.asyncIterator]()),
      nudge: async (binding: RuntimeBinding | null, message: string): Promise<void> => {
        const rpc = binding ? session.adapter.getRpcProcess(binding) : null;
        if (!rpc || rpc.isExited()) {
          throw new ToolError('build_runtime_unavailable', 'Leader 进程不可达，无法注入收口提示', 503);
        }
        await rpc.sendCommand('follow_up', { message }, 15_000);
      },
      currentRuntimeFreeze: freeze,
      // F10-R3：残留对账回调（prepareResume 一切模式的新鲜对账用）——构建级跨
      // epoch 对账：binding 可空（应用硬崩未落 binding 但账本/旧 epoch 目录
      // 已有事实时也要对账，不能凭"无 binding"绕过）；含账本未收口 Leader
      // 存活检测（其子任务不是残留）。无任何旧运行事实时适配层返回 null。
      // 落盘由监督器按模式统一处理（恢复一律落盘覆盖旧记录；fresh 仅实质
      // 内容落盘），此处不重复写。
      reconcileResiduals: async (binding: RuntimeBinding | null): Promise<TerminationOutcome | null> => {
        return session.adapter.reconcileBuildResiduals(
          { buildId: session.buildId, binding: binding ?? state.binding },
          { reap: true, includeLeaders: false },
        );
      },
      restoreTaskObservations: restoreTaskCompletionObservations,
      actorSnapshot: () => BuildRuntimeHost.actorSnapshotOf(session.actorStore),
      exportActorPayload: () => session.actorStore.exportCheckpointPayload(),
    }, state, {});
    session.supervisor = supervisor;
    try {
      return await supervisor.run({
        spec: state.spec,
        signal: input.signal,
        ...(input.resumeStrategy ? { resumeMode: input.resumeStrategy } : {}),
      });
    } finally {
      session.completed = true;
      session.stopRecords?.();
      if (session.pollTimer) clearInterval(session.pollTimer);
      session.queue.close();
      this.revokeSessionTokens(session);
      await session.recordsTask?.catch(() => undefined);
      this.sessions.delete(input.buildId);
    }
  }

  /** 角色精确 MCP 工具名单（工具侧权威工具面投影；agent → 工具名清单）。 */
  private static roleMcpTools(): Record<string, string[]> {
    const table: Record<string, string[]> = {};
    for (const agent of ['luban', 'diting', 'baize']) {
      const toolset = resolveV2RoleToolset(agent);
      table[agent] = toolset ? [...toolset.tools] : [];
    }
    return table;
  }

  /** 成果账本快照计数（进度 DTO 汇总；真相在账本）。 */
  private static actorSnapshotOf(store: BuildActorStore): { acceptedDocumentCount: number; openBlockingCount: number; activeAssignments: number } {
    const accepted = new Set<string>();
    for (const receipt of store.listReceipts()) {
      if (receipt.kind === 'write_doc' || receipt.kind === 'edit_doc') {
        for (const docPath of Array.isArray(receipt.result?.paths) ? receipt.result.paths : []) {
          if (typeof docPath === 'string') accepted.add(docPath);
        }
      }
    }
    return {
      acceptedDocumentCount: accepted.size,
      openBlockingCount: store.openBlockingIssues(),
      activeAssignments: store.listAssignments().filter((item) => item.status === 'active').length,
    };
  }

  /** 签发 Leader 上下文（应用构建工具面；v2 leader 凭据）。 */
  private issueLeaderContext(session: HostSession): string {
    const { token } = this.deps.toolService.createRunContext({
      runKind: 'build',
      buildId: session.buildId,
      outputRoot: this.deps.outputRoot(),
      knowledgeBaseRoot: this.deps.knowledgeBaseRoot(),
      allowedToolsOverride: [...V2_LEADER_TOOLS],
      buildState: session.buildState,
      orchestration: {
        mode: 'pi-amagi',
        buildId: session.buildId,
        generation: session.generation,
        credential: 'leader',
        actorStore: session.actorStore,
      },
    });
    return token;
  }

  /** 签发子任务桥接上下文（同代次共享；身份由 X-Amagi-* 头逐次区分）。 */
  private issueChildContext(session: HostSession): string {
    const { token } = this.deps.toolService.createRunContext({
      runKind: 'build',
      buildId: session.buildId,
      outputRoot: this.deps.outputRoot(),
      knowledgeBaseRoot: this.deps.knowledgeBaseRoot(),
      allowedToolsOverride: [...V2_CHILD_ALL_TOOLS],
      buildState: session.buildState,
      orchestration: {
        mode: 'pi-amagi',
        buildId: session.buildId,
        generation: session.generation,
        credential: 'child',
        actorStore: session.actorStore,
      },
    });
    return token;
  }

  /** 撤销会话全部令牌（代次失效/取消/收尾）。 */
  private revokeSessionTokens(session: HostSession): void {
    for (const token of session.tokens) {
      this.deps.toolService.revokeToken(token);
    }
    session.tokens.clear();
    session.childTokens.clear();
  }

  /** 发布窗口结算（steer #6）：撤销该构建全部子任务写令牌（Leader 令牌保留至
   * 收尾），记录被接受候选；后续发布申请由服务侧 publishLock 拒绝。
   * 结算后再签发的子任务令牌仍会登记——若写入导致候选变化，服务侧候选复核
   * 与 publishLock 会拒绝新发布，被接受 revision 不被替换。 */
  settlePublishWindow(buildId: string, generation: number, candidateHash: string): void {
    const session = this.sessions.get(buildId);
    if (!session) return;
    for (const token of session.childTokens) {
      this.deps.toolService.revokeToken(token);
    }
    session.childTokens.clear();
    session.publishSettled = { candidateHash, generation, at: new Date().toISOString() };
  }
}

/** 会话对外视图（KbBuildService 取消/进度/检查点引用）。 */
export interface HostSessionView {
  requestCancel: () => Promise<unknown>;
  progress: () => ReturnType<BuildLeaderSupervisor['progress']>;
  /** 监督状态（与构建 entry.leaderRun 同一对象引用；检查点随 entry 原子落盘）。 */
  state: () => LeaderRunCheckpointState;
}
