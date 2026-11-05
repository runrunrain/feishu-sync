/**
 * build-runtime/adapter.ts — BuildRuntimeAdapter 的 pi-amagi 实现
 *
 * 设计来源：设计v2 §8/§9。职责边界：
 * - probe：静态能力探测（实测项由接入试验另行驱动，报告 not-measured）。
 * - start：安装/复核版本化包 → 写 agentDir 配置 → 构造 Leader 环境 →
 *   以 RPC 模式启动 Leader（显式工具白名单 + 双扩展 -e + 会话目录）。
 * - observe：把 Leader RPC 事件流包装为 RuntimeEvent 信封。
 * - resume：同 agentDir + 原 session id 重启 Leader（原会话续接）；
 *   成果级重建由集成方驱动（adapter 只声明能力，不伪造）。
 * - cancel：先撤销代次凭据（注入钩子）→ stdin 有序关闭 → 可配置宽限 → SIGKILL。
 *
 * 不新增调度器：adapter 不排任务、不建角色队列、不启动子任务进程
 * （子任务由 Leader 内 amagi 派发——设计 §2 责任表）。
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { freezeGuardConfig } from './dispatch-guard.js';
import { buildRuntimeIntegrityRefs } from './runtime-integrity.js';
import { childPolicyContentHash, childPolicyFileName, renderChildPolicySource } from './child-policy.js';
import {
  DEFAULT_LEADER_TERMINATE_GRACE_MS, validateBuildRunSpec,
  type AdapterStartOptions,
  type BuildCheckpoint, type BuildRunSpec, type BuildRuntimeAdapter, type CancelResult,
  type CapabilityReport, type ProbeInput, type RuntimeBinding, type RuntimeEvent,
  type TerminationOutcome,
} from './contracts.js';
import { verifyAmagiPackage } from './amagi-package.js';
import {
  buildForbiddenZones, planBuildDirectories, renderAgentDirConfigFiles, writeAgentDirConfig,
  agentDirConfigMatchesSpec,
  type BuildDirectories,
} from './agent-dir-config.js';
import { buildLeaderEnv, ensureWorkLayout } from './environment.js';
import { assertProbeUsable, runStaticProbes, type StaticProbeInput } from './capability-probe.js';
import { appendProcessLedgerEntry, commandFingerprint, markLedgerExit, patchLedgerBirthToken, readProcessLedger } from './process-ledger.js';
import { findAliveLedgerLeaders, listBuildHomeDirs, reconcileResidualProcesses, type ResidualDeps } from './process-residual.js';
import { readBirthIdentities } from './process-identity.js';
import { recoverOrphanDispatches, type AutomaticRecoveryDeps } from './automatic-recovery.js';
import { PiRpcProcess } from '../pi-rpc-process.js';
import { PiRuntimeResolver } from '../runtime-resolver.js';
import { buildDefaultAgentConfig } from '../../types/agent-knowledge.js';

/** start/resume 需要的宿主事实（由集成方注入；不在此重复实现运行时发现）。 */
export interface PiAmagiRuntimeDeps {
  nodePath: string;
  piCliPath: string;
  dataRoot: string;
  knowledgeBaseRoot: string;
  outputRoot: string;
  /** 应用转发扩展绝对路径（server/dist/agent/pi-extension/feishu-sync-agent.js）。 */
  forwardingExtensionPath: string;
  /** MCP 桥接脚本绝对路径（server/dist 下产物，stdio MCP server）。 */
  bridgeScriptPath: string;
  /** 应用内部 API 回环地址。 */
  agentUrl: string;
  /** 解析 zhipuai 密钥（只进子进程 env；探测阶段不调用）。 */
  resolveZhipuApiKey: () => string | undefined;
  /** 签发 Leader 运行令牌（每次进程启动新签）。 */
  issueLeaderRunToken: () => string;
  /** 签发子任务 MCP 桥接凭据（绑定 buildId+generation）。 */
  issueMcpBridgeCredentials: () => { url: string; token: string };
  /** 取消时撤销代次凭据（应用侧令牌失效；返回是否已撤销）。 */
  revokeGenerationCredentials?: (binding: RuntimeBinding) => boolean;
  /** 构建 Leader 工具白名单（含 amagi 任务面 + 应用构建工具，剔除应用 task 族）。 */
  leaderTools: string[];
  /** 按原生角色冻结的精确 MCP 工具名单；由应用工具服务提供。 */
  roleMcpTools: Record<string, string[]>;
  /** 生产缺省加载相邻编译模块；源码开发态允许 jiti 加载同一 TS 模块。 */
  guardModulePath?: string;
  /** Leader 模型（provider/model）。 */
  getLeaderModel: (spec: BuildRunSpec) => string;
  /** 宿主进程探测（可注入便于测试；resume 前核对旧 Leader 是否存活，避免双 Leader）。 */
  isProcessAlive?: (pid: number | null) => boolean;
  /** 日志出口（可选）。 */
  log?: (line: string) => void;
  /** 残留对账探测依赖（可注入便于测试；缺省真实 ps/libproc）。 */
  residualDeps?: ResidualDeps;
  /** Application-owned orphan recovery; no human exit attestation is required. */
  fenceBuildCredentials?: (buildId: string) => boolean;
}

interface BindingState {
  dirs: BuildDirectories;
  process: PiRpcProcess | null;
  spec: BuildRunSpec;
  /** 本次启动身份（F09；账本关联键）。 */
  launchId: string;
  /** 最近一次终止对账（F10；cancel/reconcile 写入，binding 同步携带）。 */
  lastTermination: TerminationOutcome | null;
}

/**
 * F10/ENOTEMPTY 修正轮：按构建根的残留对账（实例方法 reconcileBuildResiduals
 * 的无状态核心；shutdown 持久事实扫描等只读消费方使用，binding 可空、不回写
 * adapter 内部状态）。判定链与实例方法完全一致：degraded fail-closed、账本
 * 存活 Leader 阻断、跨 epoch home 锚点对账。
 */
export async function reconcileBuildRootResiduals(
  input: { buildId: string; buildRoot: string; binding: RuntimeBinding | null },
  options: { reap?: boolean; includeLeaders?: boolean; fenceBuildCredentials?: () => boolean; recoveryDeps?: AutomaticRecoveryDeps } = {},
  residualDeps: Partial<ResidualDeps> = {},
): Promise<TerminationOutcome | null> {
  const ledger = readProcessLedger(input.buildRoot);
  const homeScan = listBuildHomeDirs(input.buildRoot);
  const homeDirs = homeScan.homes;
  // 裁决 #2：账本/旧 epoch 目录读取失败（degraded）不能当没旧事实——
  // fail-closed unconfirmed（阻断新 launch），绝不凭证据不可读放行。
  if (ledger.degraded || homeScan.degraded) {
    const reason = [ledger.degraded ? '进程账本不可读（degraded）' : null, homeScan.degraded ? 'epoch/agentDir 目录不可枚举' : null]
      .filter((item): item is string => item !== null).join('；');
    return {
      state: 'unconfirmed',
      at: new Date().toISOString(),
      leaderExit: null,
      children: [],
      note: `旧运行事实不可读（${reason}）：不能证明无残留，fail-closed 阻断新 Leader`,
    };
  }
  const pendingLaunches = ledger.entries.filter((entry) => entry.kind === 'leader' && entry.pid <= 1 && !entry.endedAt && !entry.exit);
  if (pendingLaunches.length > 0) {
    return {
      state: 'unconfirmed', at: new Date().toISOString(), leaderExit: null,
      children: pendingLaunches.map((entry) => ({ taskId: null, pid: entry.pid, source: 'ledger' as const,
        verdict: 'unconfirmed' as const, proof: 'none' as const,
        detail: `Leader派发意图已登记但PID未确认（launch=${entry.launchId}）：不能排除spawn→PID登记前硬崩，零信号` })),
      note: 'Leader启动意图尚未取得退出证明，阻断新Leader与目录清理',
    };
  }
  if (homeDirs.length === 0 && ledger.entries.length === 0 && !input.binding) return null;
  const leaderPids = new Set<number>();
  if (input.binding && typeof input.binding.leaderPid === 'number' && input.binding.leaderPid > 1) {
    leaderPids.add(input.binding.leaderPid);
  }
  for (const entry of ledger.entries) {
    if (entry.kind === 'leader' && entry.buildId === input.buildId && entry.pid > 1) leaderPids.add(entry.pid);
  }
  // steer 调整 #1：binding 未落盘但账本有事实的窗口，旧 Leader 可能仍存活
  // ——其子任务不是残留，绝不能在其运行中回收/启动新 Leader。守卫模式
  // （includeLeaders=false，即 resume/rebuild/fresh 前置对账）先检测并阻断；
  // cancel（includeLeaders=true）由 terminate+回收链处理，不重复判。
  const aliveLeaders: Array<{ pid: number; launchId: string; evidence: string }> = [];
  if (options.includeLeaders !== true) {
    for (const leader of await findAliveLedgerLeaders(input.buildRoot, residualDeps)) {
      if (leader.evidence === 'unprovable' || leaderPids.has(leader.pid)) {
        aliveLeaders.push({ pid: leader.pid, launchId: leader.launchId, evidence: leader.evidence });
      }
    }
  }
  // 账本/binding 有事实但无 home 目录时仍要跑账本个体对账：用一个不存在的
  // 扫描根（锚点/v2-store 扫描按空处理，账本条目照常对账）。
  const scanDirs = homeDirs.length > 0 ? homeDirs : [path.join(input.buildRoot, 'epochs', '__none__')];
  const outcomes: TerminationOutcome[] = [];
  if (aliveLeaders.length > 0) {
    const detail = aliveLeaders.map((leader) => `pid=${leader.pid}（launch=${leader.launchId}，证据=${leader.evidence}）`).join('；');
    outcomes.push({
      state: 'unconfirmed',
      at: new Date().toISOString(),
      leaderExit: null,
      children: aliveLeaders.map((leader) => ({
        taskId: null,
        pid: leader.pid,
        source: 'ledger' as const,
        verdict: 'unconfirmed' as const,
        proof: 'none' as const,
        detail: `账本未收口 Leader 仍存活（${leader.evidence === 'birth-token' ? '出生令牌匹配，属本构建' : '无令牌可比，不能排除属本构建'}）：其子任务不是残留，不得启动新 Leader 或回收`,
      })),
      note: `账本存在未收口且存活的 Leader（binding 可能未落盘）：${detail}`,
    });
  }
  for (const homeDir of scanDirs) {
    outcomes.push(await reconcileResidualProcesses({
      homeDir,
      buildRoot: input.buildRoot,
      leaderPids,
      includeLeaderEntries: options.includeLeaders === true,
    }, { reap: options.reap === true }, residualDeps));
  }
  const merged: TerminationOutcome = {
    state: outcomes.some((outcome) => outcome.state === 'unconfirmed') ? 'unconfirmed' : 'confirmed',
    at: new Date().toISOString(),
    leaderExit: null, // Leader 退出事实由调用层合并（cancel 侧 rpc.getExitInfo）
    children: outcomes.flatMap((outcome) => outcome.children),
    note: `${homeDirs.length > 1 ? `跨 ${homeDirs.length} 个 epoch/agentDir 对账；` : ''}${outcomes.map((outcome) => outcome.note).join('；')}`,
  };
  return options.fenceBuildCredentials && aliveLeaders.length === 0 && merged.state === 'unconfirmed'
    ? recoverOrphanDispatches({ buildId: input.buildId, buildRoot: input.buildRoot,
      homes: homeDirs, outcome: merged, fence: options.fenceBuildCredentials }, options.recoveryDeps)
    : merged;
}

export class PiAmagiBuildRuntime implements BuildRuntimeAdapter {
  private readonly bindings = new Map<string, BindingState>();
  private eventSeq = 0;

  constructor(private readonly deps: PiAmagiRuntimeDeps) {}

  async probe(input: ProbeInput): Promise<CapabilityReport> {
    return runStaticProbes({ ...input, piVersion: await this.resolvePiVersion() });
  }

  /** 简化 probe 入口：复用 PiRuntimeResolver 已探测的 pi 版本并 fail-closed 断言。 */
  async probeWith(input: StaticProbeInput): Promise<CapabilityReport> {
    const report = runStaticProbes({ ...input, piVersion: input.piVersion });
    assertProbeUsable(report);
    return report;
  }

  private piVersionCache: { value: string; at: number } | null = null;
  private async resolvePiVersion(): Promise<string> {
    // 复用正式解析器（同时支持 dist/cli.js、dist/bundle/cli.js 与可执行链接），
    // 不按固定父目录猜包根，否则合法的 bundle CLI 会被误判为版本缺失。
    if (this.piVersionCache && Date.now() - this.piVersionCache.at < 60_000) return this.piVersionCache.value;
    const config = buildDefaultAgentConfig(this.deps.dataRoot);
    config.runtime = { ...config.runtime, nodePath: this.deps.nodePath, piCliPath: this.deps.piCliPath };
    const resolved = await new PiRuntimeResolver().resolveRuntime(config);
    const version = resolved.piVersion ?? '';
    this.piVersionCache = { value: version, at: Date.now() };
    return version;
  }

  async start(spec: BuildRunSpec, options: AdapterStartOptions = {}): Promise<RuntimeBinding> {
    const issues = validateBuildRunSpec(spec);
    if (issues.length > 0) {
      throw new Error(`BuildRunSpec 校验失败：${issues.join('；')}`);
    }
    // 1. 版本化包复核（哈希漂移/缺失直接失败，不静默降级）
    this.verifyFrozenPackage(spec);
    this.verifyWorkflow(spec);
    const dirs = planBuildDirectories(this.deps.dataRoot, spec.buildId, options.runtimeEpoch ?? 1);
    // 2. agentDir 配置写入（校验内置；哈希须与 spec 冻结值一致）
    const { configHash } = writeAgentDirConfig(spec, dirs, {
      bridgeCommand: this.deps.nodePath,
      bridgeArgs: [this.deps.bridgeScriptPath],
    });
    if (configHash !== spec.agentDirConfigHash) {
      throw new Error(
        `agentDir 配置哈希与 spec 冻结值不一致（spec=${spec.agentDirConfigHash.slice(0, 12)} 生成=${configHash.slice(0, 12)}）——` +
        '集成方须先以相同 deps（nodePath/bridgeScriptPath）调 renderAgentDirConfigFiles + computeAgentDirConfigHash 冻结哈希',
      );
    }
    ensureWorkLayout(dirs);
    const binding = await this.launch(spec, dirs, null);
    return binding;
  }

  private async launch(spec: BuildRunSpec, dirs: BuildDirectories, resumeSessionId: string | null): Promise<RuntimeBinding> {
    const zhipuKey = this.deps.resolveZhipuApiKey();
    if (!zhipuKey) throw new Error('zhipuai 密钥不可用（构建 Leader 启动前置条件）');
    const bridge = this.deps.issueMcpBridgeCredentials();
    const epoch = dirs.runtimeEpoch ?? 1;
    // F09：会话 id epoch 唯一——成果级 rebuild 换 epoch 即新会话 id，Pi
    // `--session-id` 语义是「存在即打开」；固定 build-<id> 会把 rebuild 带回
    // 旧会话。仅原会话续接（resume 传入 resumeSessionId）复用原 id。
    const leaderSessionId = resumeSessionId ?? `build-${spec.buildId}-e${epoch}`;
    for (const agent of Object.values(spec.roles)) {
      if (!Array.isArray(this.deps.roleMcpTools[agent])) throw new Error(`角色 ${agent} 缺少冻结 MCP 工具名单`);
    }
    const guardConfig = freezeGuardConfig(this.buildGuardConfigInput(spec, dirs, this.deps.roleMcpTools));
    const guardJs = fileURLToPath(new URL('./dispatch-guard.js', import.meta.url));
    const guardModulePath = this.deps.guardModulePath ?? (existsSync(guardJs)
      ? guardJs : fileURLToPath(new URL('./dispatch-guard.ts', import.meta.url)));
    const env = buildLeaderEnv({
      parentEnv: process.env,
      spec,
      dirs,
      zhipuApiKey: zhipuKey,
      agentUrl: this.deps.agentUrl,
      leaderRunToken: this.deps.issueLeaderRunToken(),
      mcpBridgeUrl: bridge.url,
      mcpBridgeToken: bridge.token,
      guardConfig,
      leaderTools: this.deps.leaderTools,
      guardModulePath,
    });
    // F09：每次启动唯一 launchId（同 epoch 多次启动各异；进程账本关联键）。
    const launchId = `l_${randomBytes(5).toString('hex')}`;
    const rpc = new PiRpcProcess({
      nodePath: this.deps.nodePath,
      piCliPath: this.deps.piCliPath,
      additionalExtensionPaths: [spec.amagiPackage.packageRoot, this.deps.forwardingExtensionPath],
      tools: this.deps.leaderTools,
      buildMode: true,
      selfTriggeredRounds: true,
      terminateGraceMs: spec.limits.leaderTerminateGraceMs ?? DEFAULT_LEADER_TERMINATE_GRACE_MS,
      sessionDir: dirs.sessionDir,
      sessionId: leaderSessionId,
      model: this.deps.getLeaderModel(spec),
      appendSystemPrompt: spec.workflowSkillPath,
      cwd: dirs.workDir,
      env,
    });
    // 必须在跨入spawn前持久化意图；否则硬崩于start→PID登记之间时，
    // 重启只看到空home/账本，会错误确认无旧Leader并启动第二个。
    const ledgerFingerprint = commandFingerprint([this.deps.nodePath, this.deps.piCliPath, '--mode', 'rpc', '--session-id', leaderSessionId]);
    appendProcessLedgerEntry(dirs.buildRoot, {
      launchId, buildId: spec.buildId, runtimeEpoch: dirs.runtimeEpoch, generation: spec.generation,
      kind: 'leader', taskId: null, pid: 0, launchState: 'intent', startedAt: new Date().toISOString(),
      cwd: dirs.workDir, commandFingerprint: ledgerFingerprint,
    });
    await rpc.start();
    // F10：进程账本登记（不含 env/密钥；argv 指纹供对账）。出生令牌非阻塞
    // 尽力补写（探测不可用 → 无令牌，日后对账按保守口径；不拖慢启动/订阅时序）。
    const startedAt = new Date().toISOString();
    appendProcessLedgerEntry(dirs.buildRoot, {
      launchId,
      buildId: spec.buildId,
      runtimeEpoch: dirs.runtimeEpoch,
      generation: spec.generation,
      kind: 'leader',
      taskId: null,
      pid: rpc.getPid() ?? 0,
      launchState: 'started',
      startedAt,
      cwd: dirs.workDir,
      commandFingerprint: ledgerFingerprint,
    });
    const leaderPidForProbe = rpc.getPid();
    void readBirthIdentities(leaderPidForProbe !== null ? [leaderPidForProbe] : []).then((tokens) => {
      const token = leaderPidForProbe !== null ? tokens.get(leaderPidForProbe) : undefined;
      if (token) patchLedgerBirthToken(dirs.buildRoot, launchId, token);
    }).catch(() => undefined);
    rpc.on('exit', (detail: { code?: number | null; signal?: string | null }) => {
      markLedgerExit(dirs.buildRoot, launchId, 'leader', {
        code: detail?.code ?? null,
        signal: detail?.signal ?? null,
      });
    });
    const binding: RuntimeBinding = {
      buildId: spec.buildId,
      generation: spec.generation,
      ...(dirs.runtimeEpoch !== null ? { runtimeEpoch: dirs.runtimeEpoch } : {}),
      launchId,
      agentDir: dirs.homeDir,
      workDir: dirs.workDir,
      sessionDir: dirs.sessionDir,
      leaderSessionId,
      leaderPid: rpc.getPid(),
      leaderStartedAt: startedAt,
      termination: null,
      resumeCapability: { session: true, artifact: true },
    };
    this.bindings.set(bindingKey(binding), { dirs, process: rpc, spec, launchId, lastTermination: null });
    this.deps.log?.(`[build-runtime] Leader 启动 build=${spec.buildId} gen=${spec.generation} epoch=${epoch} launch=${launchId} session=${leaderSessionId}`);
    return binding;
  }

  observe(binding: RuntimeBinding, after?: string): AsyncIterable<RuntimeEvent> {
    const state = this.requireState(binding);
    const rpc = state.process;
    if (!rpc) throw new Error('运行已结束（observe 需在进程存活期间订阅）');
    if (rpc.isExited()) {
      // F10：cancel 后句柄保留（退出事实仍可查），对已退出进程的订阅立即
      // 结束而不是悬挂（exit 事件已发过，不会再触发）。
      return (async function* () { /* 已退出：无事件可观察 */ })();
    }
    const generation = binding.generation;
    const afterSeq = after ? Number.parseInt(after.replace(/^e/, ''), 10) || 0 : 0;
    const queue: RuntimeEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    const onRecord = (record: Record<string, unknown>): void => {
      this.eventSeq += 1;
      const nativeId = typeof record.id === 'string' ? record.id : null;
      if (this.eventSeq <= afterSeq) return; // after 游标（e<N> 形式）
      queue.push({
        eventId: `e${this.eventSeq}`,
        source: 'leader-rpc',
        nativeEventId: nativeId,
        generation,
        taskId: typeof record.taskId === 'string' ? record.taskId : null,
        type: typeof record.type === 'string' ? record.type : 'unknown',
        occurredAt: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        payload: record,
      });
      notify?.();
    };
    rpc.on('record', onRecord);
    rpc.on('exit', onFinish);
    rpc.on('transport_error', onFinish);
    function onFinish(): void { finished = true; notify?.(); }
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            while (queue.length > 0) {
              yield queue.shift()!;
            }
            if (finished) return;
            await new Promise<void>((resolve) => { notify = resolve; });
            notify = null;
          }
        } finally {
          rpc.removeListener('record', onRecord);
          rpc.removeListener('exit', onFinish);
          rpc.removeListener('transport_error', onFinish);
        }
      },
    };
  }

  async resume(binding: RuntimeBinding, checkpoint: BuildCheckpoint): Promise<RuntimeBinding> {
    // 路径自描述校验（无论内存态是否存在都先核对，防伪造 binding）。binding
    // 携带 epoch（F09）；缺省为 legacy 布局（旧检查点兼容）。
    const dirs = planBuildDirectories(this.deps.dataRoot, binding.buildId, binding.runtimeEpoch);
    if (dirs.homeDir !== binding.agentDir || dirs.workDir !== binding.workDir) {
      throw new Error(`binding 路径与 dataRoot 推导不一致（${binding.agentDir}），拒绝恢复`);
    }
    if (binding.sessionDir !== null && dirs.sessionDir !== binding.sessionDir) {
      throw new Error(`binding 会话目录与 epoch 推导不一致（${binding.sessionDir}），拒绝恢复`);
    }
    // 应用重启后内存 Map 无状态：按 binding 自描述字段重建。
    let state = this.bindings.get(bindingKey(binding));
    if (!state) {
      state = { dirs, process: null, spec: checkpoint.spec, launchId: binding.launchId ?? 'legacy', lastTermination: binding.termination ?? null };
      this.bindings.set(bindingKey(binding), state);
    }
    // 旧 Leader 存活核对（F09：防双 Leader）——必须先于任何回收动作：
    // 旧 Leader 还活着时它的子任务不是残留，绝不能动。
    // pid 不可得时如实说明，不伪称已核对。
    if (binding.leaderPid === null) throw new Error('旧 Leader 缺少进程身份，无法安全会话恢复；请核对残留后显式成果级重建');
    if ((this.deps.isProcessAlive ?? isProcessAlive)(binding.leaderPid)) {
      throw new Error(`旧 Leader（pid=${binding.leaderPid}）仍存活，先 cancel/终止后再 resume，避免双 Leader`);
    }
    if (state.process && !state.process.isExited()) {
      throw new Error('原 Leader 进程仍在运行，先 cancel 再 resume');
    }
    // F10：旧 Leader 已死才做残留对账——其子任务/桥此时是真孤儿（可证明
    // 残留就地回收；无法证明 → 拒绝，不能带残留启动第二个 Leader）。
    // F10-R3：构建级跨 epoch 对账（旧 epoch 的锚点/v2-store 不因换目录被绕过）。
    const guard = await this.reconcileBuildResiduals({ buildId: binding.buildId, binding }, { reap: true, includeLeaders: false });
    if (guard && guard.state === 'unconfirmed') {
      throw new Error(`残留对账未确认，拒绝原会话续接（先人工确认残留或重试对账）：${guard.note}`);
    }
    // 核对冻结面：包哈希未漂移 + agentDir 配置容忍式比对
    // （settings.json 允许 amagi 韧性链追加字段，packages/amagi/models/mcp 必须一致）
    this.verifyFrozenPackage(checkpoint.spec);
    this.verifyWorkflow(checkpoint.spec);
    const drift = agentDirConfigMatchesSpec(binding.agentDir, checkpoint.spec, {
      bridgeCommand: this.deps.nodePath,
      bridgeArgs: [this.deps.bridgeScriptPath],
    });
    if (!drift.ok) {
      throw new Error(`agentDir 配置漂移，不支持原会话续接：${drift.issues.join('；')}（走成果级恢复或显式迁移）`);
    }
    const next = await this.launch(checkpoint.spec, state.dirs, binding.leaderSessionId);
    next.resumeCapability = binding.leaderSessionId
      ? { session: true, artifact: true }
      : { session: false, artifact: true };
    return next;
  }

  async cancel(binding: RuntimeBinding): Promise<CancelResult> {
    const state = this.bindings.get(bindingKey(binding));
    const credentialsRevoked = this.deps.revokeGenerationCredentials?.(binding) ?? false;
    // F10：Leader 终止——不吞 terminate 异常（错误进终止记录）；不清进程句柄
    // （后续退出事实/残留核对仍需读 getExitInfo；句柄随下次 launch 替换）。
    let leaderExit: { code: number | null; signal: string | null } | null = null;
    let terminateError: string | null = null;
    const rpc = state?.process ?? null;
    if (rpc && !rpc.isExited()) {
      const grace = state!.spec.limits.leaderTerminateGraceMs ?? DEFAULT_LEADER_TERMINATE_GRACE_MS;
      try {
        await rpc.terminate(grace);
      } catch (error) {
        // pi_termination_unconfirmed 等：保留原始错误进入终止记录，不伪装成功
        terminateError = error instanceof Error ? error.message : String(error);
      }
    }
    if (rpc) leaderExit = rpc.getExitInfo();
    // F10：子任务/桥残留对账（受信锚点 + OS 身份；可证明者回收，无法证明者
    // unconfirmed 并阻断后续 Leader）。含未收口 Leader 条目（句柄丢失时凭
    // 账本出生令牌回收；句柄在位时 terminate 已处理、账本已记退出）。旧
    // Leader pid 纳入账本归属集。F10-R3：构建级跨 epoch 对账——旧 epoch
    // 的残留不因当前 binding 指向新 epoch 而被绕过。
    const termination = await this.reconcileBuildResiduals(
      { buildId: binding.buildId, binding },
      { reap: true, includeLeaders: true },
    ) ?? {
      state: 'confirmed' as const,
      at: new Date().toISOString(),
      leaderExit: null,
      children: [],
      note: '无旧运行事实可对账',
    };
    termination.leaderExit = leaderExit;
    if (terminateError) {
      termination.note = `${termination.note}；Leader 终止异常：${terminateError}`;
      termination.state = 'unconfirmed';
    }
    if (state) {
      state.lastTermination = termination;
    }
    binding.termination = termination;
    const pid = rpc?.getPid() ?? binding.leaderPid;
    const unconfirmedCount = termination.children.filter((child) => child.verdict === 'unconfirmed').length;
    const residualNote = terminateError
      ? `Leader 终止异常（${terminateError}）；${termination.note}`
      : unconfirmedCount > 0
        ? `${termination.note}；凭据已撤销，应用将继续自动核验和清理后恢复`
        : `Leader 已终止；${termination.note}`;
    this.deps.log?.(`[build-runtime] Leader 终止对账 build=${binding.buildId} state=${termination.state} children=${termination.children.length} pid=${pid ?? '未知'}`);
    return { leaderExit, credentialsRevoked, residualNote, termination };
  }

  async reconcileResiduals(binding: RuntimeBinding, options: { reap?: boolean; includeLeaders?: boolean } = {}): Promise<TerminationOutcome> {
    const dirs = planBuildDirectories(this.deps.dataRoot, binding.buildId, binding.runtimeEpoch);
    // 归属集：本构建历次 Leader pid（账本）+ 当前 binding pid——跨启动收敛。
    const leaderPids = new Set<number>([binding.leaderPid].filter((pid): pid is number => typeof pid === 'number' && pid > 1));
    for (const entry of readProcessLedger(dirs.buildRoot).entries) {
      if (entry.kind === 'leader' && entry.buildId === binding.buildId && entry.pid > 1) leaderPids.add(entry.pid);
    }
    const outcome = await reconcileResidualProcesses({
      homeDir: dirs.homeDir,
      buildRoot: dirs.buildRoot,
      leaderPids,
      includeLeaderEntries: options.includeLeaders === true,
    }, { reap: options.reap === true }, this.deps.residualDeps ?? {});
    if (options.reap) {
      const state = this.bindings.get(bindingKey(binding));
      if (state) state.lastTermination = outcome;
      binding.termination = outcome;
    }
    return outcome;
  }

  /**
   * F10-R3：构建级跨 epoch 残留对账——一切带旧运行事实的恢复（session/
   * rebuild/应用重启后新 launch）在推进 epoch 或启动新 Leader 前必须取得
   * 新鲜收敛证明：termination 缺失/null 不是 confirmed（崩溃未落记录的窗口：
   * binding 未写但账本/旧 epoch 目录已有事实）；已 confirmed 也可能陈旧。
   * 对账覆盖全部 epoch home + legacy home（rebuild 换目录不能绕过旧 epoch
   * 残留）；归属集 = 账本全部 leader 条目 + 当前 binding pid。
   * 返回 null 仅当无任何旧运行事实（无 home 目录、无账本条目、无 binding）
   * ——fresh 构建无据可对，不是 confirmed 的冒充。
   */
  async reconcileBuildResiduals(
    input: { buildId: string; binding: RuntimeBinding | null },
    options: { reap?: boolean; includeLeaders?: boolean } = {},
  ): Promise<TerminationOutcome | null> {
    const merged = await reconcileBuildRootResiduals(
      { ...input, buildRoot: planBuildDirectories(this.deps.dataRoot, input.buildId, 1).buildRoot },
      { ...options, ...(this.deps.fenceBuildCredentials
        ? { fenceBuildCredentials: () => this.deps.fenceBuildCredentials!(input.buildId) } : {}) },
      this.deps.residualDeps ?? {},
    );
    if (options.reap && input.binding && merged) {
      const state = this.bindings.get(bindingKey(input.binding));
      if (state) state.lastTermination = merged;
      input.binding.termination = merged;
    }
    return merged;
  }

  /** 集成方访问底层 RPC 句柄（发送 prompt/steer、等待 round_settled 等）。 */
  getRpcProcess(binding: RuntimeBinding): PiRpcProcess | null {
    return this.requireState(binding).process;
  }

  /**
   * 构建 Leader 的派发守卫冻结配置（集成方注入转发扩展环境用）。
   * F12：integrity 为派发前重核验冻结引用（四配置渲染期望 + policy 内容寻址引用 +
   * 包全量哈希）——逐次 task_submit/task_resume 前由扩展 verifyRuntimeIntegrity 重核，
   * 缺失/篡改/资源注入阻断 child 模型请求。
   */
  buildGuardConfigInput(spec: BuildRunSpec, dirs: BuildDirectories, roleMcpTools: Record<string, string[]>): {
    buildId: string; generation: number; workDir: string; forbiddenZones: string[];
    roles: Record<string, { key: string; models: string[]; mcpTools: string[] }>;
    integrity: import('./runtime-integrity.js').RuntimeIntegrityRefs;
  } {
    const roles: Record<string, { key: string; models: string[]; mcpTools: string[] }> = {};
    for (const roleKey of Object.keys(spec.roles) as Array<keyof typeof spec.roles>) {
      const agent = spec.roles[roleKey];
      roles[agent] = {
        key: roleKey,
        models: spec.models[roleKey] ? [spec.models[roleKey]] : [],
        mcpTools: roleMcpTools[agent] ?? [],
      };
    }
    // F12 完整性引用：与 writeAgentDirConfig 同源渲染（同一 bridge 输入 → 与磁盘一致）
    const policySource = renderChildPolicySource();
    const integrity = buildRuntimeIntegrityRefs({
      homeDir: dirs.homeDir,
      expectedFiles: renderAgentDirConfigFiles(spec, dirs, {
        bridgeCommand: this.deps.nodePath,
        bridgeArgs: [this.deps.bridgeScriptPath],
      }),
      childPolicy: { fileName: childPolicyFileName(policySource), sha256: childPolicyContentHash(policySource) },
      amagiPackage: { packageRoot: spec.amagiPackage.packageRoot, contentHash: spec.amagiPackage.contentHash },
      workflowSkill: { path: spec.workflowSkillPath, sha256: spec.workflowRevision },
    });
    return {
      buildId: spec.buildId,
      generation: spec.generation,
      workDir: dirs.workDir,
      forbiddenZones: buildForbiddenZones({
        workDir: dirs.workDir,
        dataRoot: this.deps.dataRoot,
        knowledgeBaseRoot: this.deps.knowledgeBaseRoot,
        outputRoot: this.deps.outputRoot,
      }),
      roles,
      integrity,
    };
  }

  private verifyWorkflow(spec: BuildRunSpec): void {
    const hash = createHash('sha256').update(readFileSync(spec.workflowSkillPath)).digest('hex');
    if (hash !== spec.workflowRevision) throw new Error('构建工作流规则与冻结哈希不一致，拒绝注入系统提示或恢复');
  }

  private verifyFrozenPackage(spec: BuildRunSpec): void {
    const actual = verifyAmagiPackage({ dataRoot: this.deps.dataRoot, version: spec.amagiPackage.version, contentHash: spec.amagiPackage.contentHash, installDir: spec.amagiPackage.installDir });
    if (actual.contentHash !== spec.amagiPackage.contentHash
      || path.resolve(actual.packageRoot) !== path.resolve(spec.amagiPackage.packageRoot)
      || path.resolve(actual.installDir) !== path.resolve(spec.amagiPackage.installDir)) {
      throw new Error('运行包与冻结版本/路径/内容哈希不一致，拒绝加载未核验的扩展');
    }
  }

  private requireState(binding: RuntimeBinding): BindingState {
    const state = this.bindings.get(bindingKey(binding));
    if (!state) throw new Error(`未登记的运行绑定 build=${binding.buildId} gen=${binding.generation}`);
    return state;
  }
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null || !Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function bindingKey(binding: RuntimeBinding): string {
  return `${binding.buildId}:${binding.generation}`;
}
