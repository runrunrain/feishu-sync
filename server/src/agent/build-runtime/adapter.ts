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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freezeGuardConfig } from './dispatch-guard.js';
import {
  DEFAULT_LEADER_TERMINATE_GRACE_MS, validateBuildRunSpec,
  type BuildCheckpoint, type BuildRunSpec, type BuildRuntimeAdapter, type CancelResult,
  type CapabilityReport, type ProbeInput, type RuntimeBinding, type RuntimeEvent,
} from './contracts.js';
import { verifyAmagiPackage } from './amagi-package.js';
import {
  buildForbiddenZones, planBuildDirectories, writeAgentDirConfig,
  agentDirConfigMatchesSpec,
  type BuildDirectories,
} from './agent-dir-config.js';
import { buildLeaderEnv, ensureWorkLayout } from './environment.js';
import { assertProbeUsable, runStaticProbes } from './capability-probe.js';
import { PiRpcProcess } from '../pi-rpc-process.js';

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
}

interface BindingState {
  dirs: BuildDirectories;
  process: PiRpcProcess | null;
  spec: BuildRunSpec;
}

export class PiAmagiBuildRuntime implements BuildRuntimeAdapter {
  private readonly bindings = new Map<string, BindingState>();
  private eventSeq = 0;

  constructor(private readonly deps: PiAmagiRuntimeDeps) {}

  async probe(input: ProbeInput): Promise<CapabilityReport> {
    return runStaticProbes({ ...input, piVersion: await this.resolvePiVersion() });
  }

  /** 简化 probe 入口：复用 PiRuntimeResolver 已探测的 pi 版本并 fail-closed 断言。 */
  async probeWith(input: ProbeInput & { piVersion: string }): Promise<CapabilityReport> {
    const report = runStaticProbes({ ...input, piVersion: input.piVersion });
    assertProbeUsable(report);
    return report;
  }

  private piVersionCache: { value: string; at: number } | null = null;
  private async resolvePiVersion(): Promise<string> {
    // 最小实现：读 pi 包 package.json（经 piCliPath 定位包根）；探测失败返回空串。
    if (this.piVersionCache && Date.now() - this.piVersionCache.at < 60_000) return this.piVersionCache.value;
    let version = '';
    try {
      const fs = await import('node:fs');
      const pkgRoot = path.resolve(path.dirname(this.deps.piCliPath), '..');
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
      version = typeof pkg.version === 'string' ? pkg.version : '';
    } catch {
      version = '';
    }
    this.piVersionCache = { value: version, at: Date.now() };
    return version;
  }

  async start(spec: BuildRunSpec): Promise<RuntimeBinding> {
    const issues = validateBuildRunSpec(spec);
    if (issues.length > 0) {
      throw new Error(`BuildRunSpec 校验失败：${issues.join('；')}`);
    }
    // 1. 版本化包复核（哈希漂移/缺失直接失败，不静默降级）
    this.verifyFrozenPackage(spec);
    const dirs = planBuildDirectories(this.deps.dataRoot, spec.buildId);
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
    const leaderSessionId = resumeSessionId ?? `build-${spec.buildId}`;
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
      cwd: dirs.workDir,
      env,
    });
    await rpc.start();
    const binding: RuntimeBinding = {
      buildId: spec.buildId,
      generation: spec.generation,
      agentDir: dirs.homeDir,
      workDir: dirs.workDir,
      leaderSessionId,
      leaderPid: rpc.getPid(),
      resumeCapability: { session: true, artifact: true },
    };
    this.bindings.set(bindingKey(binding), { dirs, process: rpc, spec });
    this.deps.log?.(`[build-runtime] Leader 启动 build=${spec.buildId} gen=${spec.generation} session=${leaderSessionId}`);
    return binding;
  }

  observe(binding: RuntimeBinding, after?: string): AsyncIterable<RuntimeEvent> {
    const state = this.requireState(binding);
    const rpc = state.process;
    if (!rpc) throw new Error('运行已结束（observe 需在进程存活期间订阅）');
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
    // 路径自描述校验（无论内存态是否存在都先核对，防伪造 binding）。
    const dirs = planBuildDirectories(this.deps.dataRoot, binding.buildId);
    if (dirs.homeDir !== binding.agentDir || dirs.workDir !== binding.workDir) {
      throw new Error(`binding 路径与 dataRoot 推导不一致（${binding.agentDir}），拒绝恢复`);
    }
    // 应用重启后内存 Map 无状态：按 binding 自描述字段重建。
    let state = this.bindings.get(bindingKey(binding));
    if (!state) {
      state = { dirs, process: null, spec: checkpoint.spec };
      this.bindings.set(bindingKey(binding), state);
    }
    // 旧 Leader 存活核对：binding.leaderPid 可查且仍存活 → 拒绝（防双 Leader）。
    // pid 不可得时如实说明，不伪称已核对。
    if (binding.leaderPid === null) throw new Error('旧 Leader 缺少进程身份，无法安全会话恢复；请核对残留后显式成果级重建');
    if ((this.deps.isProcessAlive ?? isProcessAlive)(binding.leaderPid)) {
      throw new Error(`旧 Leader（pid=${binding.leaderPid}）仍存活，先 cancel/终止后再 resume，避免双 Leader`);
    }
    if (state.process && !state.process.isExited()) {
      throw new Error('原 Leader 进程仍在运行，先 cancel 再 resume');
    }
    // 核对冻结面：包哈希未漂移 + agentDir 配置容忍式比对
    // （settings.json 允许 amagi 韧性链追加字段，packages/amagi/models/mcp 必须一致）
    this.verifyFrozenPackage(checkpoint.spec);
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
    if (!state || !state.process) {
      return { leaderExit: null, credentialsRevoked, residualNote: '无运行中 Leader 进程（凭据已按代次处理）' };
    }
    const rpc = state.process;
    const grace = state.spec.limits.leaderTerminateGraceMs ?? DEFAULT_LEADER_TERMINATE_GRACE_MS;
    await rpc.terminate(grace).catch(() => undefined);
    const exitInfo = rpc.getExitInfo();
    const pid = rpc.getPid();
    state.process = null;
    // 残留如实核对：有探测钩子时对 pid 复核；无钩子/无 pid 不伪称已清理。
    let residualNote = 'Leader 已按宽限终止；amagi 子进程由其 TERM→2s→KILL 链收口，残留以启动锚点/orphan 核对（实测项 cancel）';
    if (exitInfo === null) {
      residualNote = 'Leader 退出信息不可得（进程句柄已失效）；残留状态未确认，凭据已失效不影响候选区';
    }
    if (this.deps.isProcessAlive && pid !== null) {
      const alive = this.deps.isProcessAlive(pid);
      if (alive) residualNote = `Leader pid=${pid} 终止后仍存活（残留未清理，需人工处置；凭据已失效）`;
      else residualNote += `；pid=${pid} 已确认退出`;
    }
    return { leaderExit: exitInfo, credentialsRevoked, residualNote };
  }

  /** 集成方访问底层 RPC 句柄（发送 prompt/steer、等待 round_settled 等）。 */
  getRpcProcess(binding: RuntimeBinding): PiRpcProcess | null {
    return this.requireState(binding).process;
  }

  /** 构建 Leader 的派发守卫冻结配置（集成方注入转发扩展环境用）。 */
  buildGuardConfigInput(spec: BuildRunSpec, dirs: BuildDirectories, roleMcpTools: Record<string, string[]>): {
    buildId: string; generation: number; workDir: string; forbiddenZones: string[];
    roles: Record<string, { key: string; models: string[]; mcpTools: string[] }>;
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
    };
  }

  private verifyFrozenPackage(spec: BuildRunSpec): void {
    const actual = verifyAmagiPackage({ dataRoot: this.deps.dataRoot, version: spec.amagiPackage.version });
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
