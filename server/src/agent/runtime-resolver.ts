import { resolveProviderModel } from '../modules/model-selection.js';
/**
 * PiRuntimeResolver — 外部 Node / pi 运行时发现与就绪诊断（设计 §3）
 *
 * 发现顺序：
 *  1. 显式覆盖：config.agent.runtime.nodePath / piCliPath；其次环境变量
 *     FEISHU_SYNC_PI_NODE / FEISHU_SYNC_PI_CLI。
 *  2. Node 候选：process.env.PATH + getNodeRuntimeCandidateDirectories()
 *     （复用 lark-cli-client 导出）。每个候选 `node --version`（execFile
 *     不经 shell，5s 超时），取首个 ≥22.19.0。
 *  3. pi 包候选（对选中 node）：nodeBinDir 同级 lib/node_modules、PATH 上
 *     pi 可执行 realpath 回溯。Windows 下 npm 全局 prefix（%APPDATA%\npm）
 *     与 node.exe 目录无关，且 pi.cmd 是普通脚本非 symlink，故补：prefix
 *     直推（APPDATA/LOCALAPPDATA）与 shim 同级 node_modules 推导。只读
 *     文件定位，不执行 npm、不读 shim 内容；自定义 prefix 用显式
 *     piCliPath。校验包根 package.json 的 name/version/dist/cli.js。
 *
 * 结果缓存在内存，recheck() 或显式失效时重算。
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  findExecutableOnPath,
  getNodeRuntimeCandidateDirectories,
} from '../modules/lark-cli-client.js';
import {
  NODE_MIN_VERSION,
  PI_SUPPORTED_RANGE,
  type AgentConfig,
  type AgentStatusDto,
  type ReadinessCode,
} from '../types/agent-knowledge.js';
import type { LlmConfig } from '../types/index.js';
import { inspectClaudeCode, resolveClaudeCodePath, resolveClaudeProvider } from './claude-runtime.js';
import { resolveDataRoot } from '../modules/data-root.js';

const execFileAsync = promisify(execFile);

export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

export interface ResolvedRuntime {
  nodePath: string | null;
  nodeVersion: string | null;
  /** pi 包根目录（含 package.json） */
  piPackageRoot: string | null;
  /** pi CLI 入口（<pkg>/dist/cli.js 或 bundle 变体） */
  piCliPath: string | null;
  piVersion: string | null;
  claudeCliPath?: string | null;
}

export interface ReadinessProbeInput {
  agentConfig: AgentConfig;
  llmConfig: LlmConfig;
  /** 运行进程数（用于 status DTO） */
  runningProcesses: number;
}

export interface ReadinessResult extends AgentStatusDto {
  runtime: AgentStatusDto['runtime'] & { piPackageRoot?: string | null };
}

/** 语义化版本比较：返回 -1/0/1。支持 x.y.z（忽略预发布后缀）。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((segment) => Number.parseInt(segment, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((segment) => Number.parseInt(segment, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

export function satisfiesPiRange(version: string): boolean {
  return compareVersions(version, '1.4.0') >= 0 && compareVersions(version, '2.0.0') < 0;
}

async function nodeVersionOf(nodePath: string, timeoutMs = 5000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(nodePath, ['--version'], { timeout: timeoutMs });
    const match = /v?(\d+\.\d+\.\d+)/.exec(stdout.trim());
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

interface PiCandidateCheck {
  packageRoot: string | null;
  cliPath: string | null;
  version: string | null;
  nameOk: boolean;
}

function checkPiPackageRoot(packageRoot: string): PiCandidateCheck {
  try {
    const pkgJsonPath = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      return { packageRoot, cliPath: null, version: null, nameOk: false };
    }
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
      name?: string;
      version?: string;
    };
    const nameOk = pkg.name === PI_PACKAGE_NAME;
    const cliCandidates = [
      path.join(packageRoot, 'dist', 'cli.js'),
      path.join(packageRoot, 'dist', 'bundle', 'cli.js'),
    ];
    const cliPath = cliCandidates.find((candidate) => fs.existsSync(candidate)) ?? null;
    return {
      packageRoot,
      cliPath,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      nameOk,
    };
  } catch {
    return { packageRoot, cliPath: null, version: null, nameOk: false };
  }
}

/** 从 pi 可执行入口（bin shim 或直接 cli.js）回溯包根。 */
function packageRootFromCliEntry(entryPath: string): string | null {
  let current = path.dirname(path.resolve(entryPath));
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { name?: string };
        if (pkg.name === PI_PACKAGE_NAME) return current;
      } catch {
        /* continue upward */
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export interface ResolverOverrides {
  /** 测试注入：候选目录与 PATH */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  execNodeVersion?: (nodePath: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
}

export class PiRuntimeResolver {
  private cached: ReadinessResult | null = null;
  private readiness = new Map<string, { value: ReadinessResult; expires: number }>();
  private probes = new Map<string, Promise<ReadinessResult>>();
  private generation = 0;
  private readonly resolvedRuntimes = new Map<string, ResolvedRuntime>();
  private readonly overrides: ResolverOverrides;

  constructor(overrides: ResolverOverrides = {}) {
    this.overrides = overrides;
  }

  invalidate(): void {
    this.cached = null;
    this.generation++; this.readiness.clear(); this.probes.clear();
  }

  private nodeVersion(nodePath: string): Promise<string | null> {
    return this.overrides.execNodeVersion
      ? this.overrides.execNodeVersion(nodePath)
      : nodeVersionOf(nodePath);
  }

  /**
   * 配置切换不会终止旧进程，旧安装仍属于运行资源。整个服务生命周期
   * 保留已发现的安装根；invalidate只失效就绪信息，不撤销安全保护。
   */
  getResolvedRuntimes(): ResolvedRuntime[] {
    return [...this.resolvedRuntimes.values()];
  }

  /** 发现 Node ≥22.19 与 pi 包（不做模型探测）。 */
  async resolveRuntime(agentConfig: AgentConfig): Promise<ResolvedRuntime> {
    const runtime = await this.discoverRuntime(agentConfig);
    if (agentConfig.runtime.backend === 'claude-code' || agentConfig.runtime.claudeCliPath) {
      runtime.claudeCliPath = resolveClaudeCodePath(agentConfig.runtime.claudeCliPath, this.overrides.env ?? process.env, this.overrides.platform ?? process.platform);
    }
    const key = JSON.stringify([runtime.nodePath, runtime.piPackageRoot, runtime.claudeCliPath]);
    this.resolvedRuntimes.set(key, runtime);
    return runtime;
  }

  private async discoverRuntime(agentConfig: AgentConfig): Promise<ResolvedRuntime> {
    const env = this.overrides.env ?? process.env;
    const homeDir = this.overrides.homeDir ?? os.homedir();
    const platform = this.overrides.platform ?? process.platform;
    const explicitNode = agentConfig.runtime.nodePath?.trim() || env.FEISHU_SYNC_PI_NODE?.trim() || '';
    const managedPi = path.join(resolveDataRoot(), 'agent', 'runtimes', 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent');
    const explicitPi = agentConfig.runtime.piCliPath?.trim() || env.FEISHU_SYNC_PI_CLI?.trim() || (fs.existsSync(path.join(managedPi, 'package.json')) ? managedPi : '');

    // ---- Node 发现（显式覆盖排他：坏路径产生精确错误而不是静默换一个安装） ----
    let nodePath: string | null = null;
    let nodeVersion: string | null = null;
    const self = this as { lastSeenOldNode?: { path: string; version: string } };

    if (explicitNode) {
      const version = fs.existsSync(explicitNode) ? await this.nodeVersion(explicitNode) : null;
      if (version && compareVersions(version, NODE_MIN_VERSION) >= 0) {
        nodePath = explicitNode;
        nodeVersion = version;
      } else if (version) {
        self.lastSeenOldNode = { path: explicitNode, version };
      } else {
        self.lastSeenOldNode = { path: explicitNode, version: '(无法执行或不存在)' };
      }
    }

    if (!nodePath && !explicitNode) {
      const nodeCandidates: string[] = [];
      const pathValue = env.PATH ?? env.Path;
      for (const dir of (pathValue ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, platform === 'win32' ? 'node.exe' : 'node');
        if (fs.existsSync(candidate)) nodeCandidates.push(candidate);
      }
      for (const dir of getNodeRuntimeCandidateDirectories(homeDir, env, platform)) {
        const candidate = path.join(dir, platform === 'win32' ? 'node.exe' : 'node');
        if (fs.existsSync(candidate) && !nodeCandidates.includes(candidate)) {
          nodeCandidates.push(candidate);
        }
      }
      let firstSeenVersion: string | null = null;
      for (const candidate of nodeCandidates) {
        const version = await this.nodeVersion(candidate);
        if (version && !firstSeenVersion) firstSeenVersion = version;
        if (version && compareVersions(version, NODE_MIN_VERSION) >= 0) {
          nodePath = candidate;
          nodeVersion = version;
          break;
        }
      }
      // 记录找到但过老的版本供诊断（候选第一个能出版本的）
      if (!nodePath && firstSeenVersion) {
        self.lastSeenOldNode = { path: nodeCandidates[0], version: firstSeenVersion };
      }
    }

    if (!nodePath) {
      return { nodePath: null, nodeVersion, piPackageRoot: null, piCliPath: null, piVersion: null };
    }
    // ---- pi 包发现 ----
    const candidates: PiCandidateCheck[] = [];
    const seen = new Set<string>();
    const pushCandidate = (packageRoot: string | null) => {
      if (!packageRoot || seen.has(packageRoot)) return;
      seen.add(packageRoot);
      candidates.push(checkPiPackageRoot(packageRoot));
    };

    if (explicitPi) {
      if (fs.existsSync(explicitPi)) {
        if (explicitPi.endsWith('.js')) {
          pushCandidate(packageRootFromCliEntry(explicitPi));
        } else {
          pushCandidate(explicitPi);
        }
      }
    }

    const nodeBinDir = path.dirname(path.resolve(nodePath));
    // 候选 1：node 同级 lib/node_modules（npm 全局布局，POSIX）
    pushCandidate(
      path.resolve(nodeBinDir, '..', 'lib', 'node_modules', ...PI_PACKAGE_NAME.split('/')),
    );
    // fnm/nvm 的 installation 布局：lib 在 bin 同级父目录（上面已覆盖）；
    // Homebrew Intel: /usr/local/bin → ../lib/node_modules（同上）。
    // Windows：node.exe 同目录 node_modules（fnm-windows 等版本目录布局）。
    // 注意 Windows npm 全局默认 prefix（%APPDATA%\npm）与 node.exe 安装
    // 目录无关（P0 实测：Program Files 布局下此候选不命中），补 prefix
    // 直推候选作为 PATH 未含 npm 目录时的兜底。
    if (platform === 'win32') {
      pushCandidate(path.join(nodeBinDir, 'node_modules', ...PI_PACKAGE_NAME.split('/')));
      if (env.APPDATA) {
        pushCandidate(path.join(env.APPDATA, 'npm', 'node_modules', ...PI_PACKAGE_NAME.split('/')));
      }
      if (env.LOCALAPPDATA) {
        pushCandidate(path.join(env.LOCALAPPDATA, 'npm', 'node_modules', ...PI_PACKAGE_NAME.split('/')));
      }
    }

    // 候选 2：PATH 上 pi 可执行的 realpath 回溯
    const pathValue = env.PATH ?? env.Path;
    const piOnPath = findExecutableOnPath(
      platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'],
      pathValue,
    );
    if (piOnPath) {
      // Windows npm shim（pi.cmd/pi.ps1）是普通脚本而非 symlink：realpath
      // 原样返回 shim 路径，向上回溯找不到包根（%APPDATA%\npm 之上没有
      // pi 的 package.json）。Windows npm 布局中 shim 与 node_modules 同在
      // prefix 根，直接推导；POSIX symlink 布局此推导不存在该目录、无害，
      // nvm-windows（shim/包同在版本目录）同样被覆盖。仍不读 shim 内容、
      // 不执行任何解释器——发现只做存在性与 package.json 名称校验。
      pushCandidate(
        path.join(path.dirname(piOnPath), 'node_modules', ...PI_PACKAGE_NAME.split('/')),
      );
      const real = fs.realpathSync.native(piOnPath);
      pushCandidate(packageRootFromCliEntry(real));
    }

    // 不执行 npm root -g 或任何包管理器 shim：发现本身不能加载可被
    // Workspace 改写的 npm JS/依赖/配置。非标准 prefix 通过 piCliPath 配置。

    const valid = candidates.find(
      (candidate) => candidate.nameOk && candidate.cliPath && candidate.version,
    );
    if (valid?.cliPath && valid.version) {
      return {
        nodePath,
        nodeVersion,
        piPackageRoot: valid.packageRoot,
        piCliPath: valid.cliPath,
        piVersion: valid.version,
      };
    }
    // 名称不匹配但有 cli 的候选也返回 version 供诊断
    const anyWithVersion = candidates.find((candidate) => candidate.version);
    return {
      nodePath,
      nodeVersion,
      piPackageRoot: null,
      piCliPath: null,
      piVersion: anyWithVersion?.version ?? null,
    };
  }

  /**
   * 完整就绪探测（含模型列表）。modelProbe 由 PiRpcProcess 层注入：
   * 启动短命 RPC 进程（--no-session --no-tools），发 get_state +
   * get_available_models。此处只做结果归类。
   */
  /** 相同配置/凭据签名共享探测；进程数始终取当前请求，不缓存成旧值。 */
  async checkReadiness(input: ReadinessProbeInput,
    modelProbe?: (runtime: ResolvedRuntime) => Promise<{ ok: boolean; stderr?: string; available: string[] } | null>,
    options: { force?: boolean } = {}): Promise<ReadinessResult> {
    const env = this.overrides.env ?? process.env;
    const home = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
    const usesAppModel = input.agentConfig.runtime.backend === 'claude-code' || input.agentConfig.model.source === 'app-llm';
    const credentials = !usesAppModel ? ['models.json', 'auth.json'].map((name) => {
      try { const stat = fs.statSync(path.join(home, name)); return [name, stat.mtimeMs, stat.size]; } catch { return [name, null]; }
    }) : [];
    const key = crypto.createHash('sha256').update(JSON.stringify({ runtime: input.agentConfig.runtime, model: { ...input.agentConfig.model, thinkingLevel: undefined },
      llm: usesAppModel ? input.llmConfig : null, home, credentials, probing: Boolean(modelProbe) })).digest('hex');
    const withCounts = (value: ReadinessResult): ReadinessResult => ({ ...value, processes: { running: input.runningProcesses, max: input.agentConfig.maxConcurrentProcesses } });
    const pending = this.probes.get(key);
    if (pending) return withCounts(await pending);
    const cached = this.readiness.get(key);
    if (!options.force && cached && cached.expires > Date.now()) return withCounts(cached.value);
    const generation = this.generation;
    const promise = this.computeReadiness(input, modelProbe);
    this.probes.set(key, promise);
    try {
      const result = await promise;
      if (generation === this.generation) {
        if (this.readiness.size >= 8) this.readiness.delete(this.readiness.keys().next().value!);
        this.readiness.set(key, { value: result, expires: Date.now() + (result.code === 'ready' || result.code === 'model_unconfigured' ? 300_000 : 30_000) });
        this.cached = result;
      }
      return withCounts(result);
    } finally { if (this.probes.get(key) === promise) this.probes.delete(key); }
  }

  private async computeReadiness(
    input: ReadinessProbeInput,
    modelProbe?: (runtime: ResolvedRuntime) => Promise<{ ok: boolean; stderr?: string; available: string[] } | null>,
  ): Promise<ReadinessResult> {
    const { agentConfig, llmConfig, runningProcesses } = input;
    const runtime = await this.resolveRuntime(agentConfig);
    const base = {
      runtime: {
        nodePath: runtime.nodePath,
        nodeVersion: runtime.nodeVersion,
        piCliPath: runtime.piCliPath,
        piVersion: runtime.piVersion,
        supportedRange: PI_SUPPORTED_RANGE,
        piPackageRoot: runtime.piPackageRoot,
      },
      processes: { running: runningProcesses, max: agentConfig.maxConcurrentProcesses },
      checkedAt: new Date().toISOString(),
    };

    if (agentConfig.runtime.backend === 'claude-code') {
      const executable = resolveClaudeCodePath(agentConfig.runtime.claudeCliPath, this.overrides.env ?? process.env, this.overrides.platform ?? process.platform);
      const claudeBase = { ...base, runtime: { ...base.runtime, backend: 'claude-code' as const, claudeCliPath: executable, claudeVersion: null as string | null } };
      const model = resolveClaudeProvider(llmConfig, agentConfig);
      const info = { source: 'app-llm' as const, model: model?.openAiModel ?? null, available: [] as string[] };
      if (!runtime.nodePath) return { ...claudeBase, code: 'node_missing', message: 'Claude Code 工具桥需要 Node ≥22.19', model: info };
      if (!executable) return { ...claudeBase, code: 'claude_missing', message: '未找到 Claude Code，请安装或在设置中填写可执行文件路径', model: info };
      try {
        const found = await inspectClaudeCode(executable);
        claudeBase.runtime.claudeVersion = found.version;
        if (!found.supported) return { ...claudeBase, code: 'claude_spawn_failed', message: 'Claude Code 缺少安全运行所需参数，请更新 Claude Code', model: info };
      } catch { return { ...claudeBase, code: 'claude_spawn_failed', message: 'Claude Code 无法运行，请检查可执行文件路径', model: info }; }
      if (!model) return { ...claudeBase, code: 'model_unconfigured', message: 'Claude Code 请使用应用内服务提供商和模型预设', model: info };
      if (model.protocol !== 'anthropic-messages') return { ...claudeBase, code: 'claude_protocol_unsupported', message: 'Claude Code 需要 Anthropic Messages 兼容的服务提供商', model: info };
      if (!model.apiKey) return { ...claudeBase, code: 'model_auth_missing', message: `提供商 ${model.providerName} 未配置 API Key`, model: info };
      return { ...claudeBase, code: 'ready', message: 'Claude Code 和应用内模型已配置（尚未验证服务商连接）', model: info };
    }

    const oldNode = (this as { lastSeenOldNode?: { path: string; version: string } }).lastSeenOldNode;

    if (!runtime.nodePath) {
      const oldNode2 = (this as { lastSeenOldNode?: { path: string; version: string } }).lastSeenOldNode;
      if (oldNode2) {
        return this.cache({
          ...base,
          code: 'node_too_old',
          message: `Node 版本过低或不可执行（${oldNode2.path} → ${oldNode2.version}，需要 ≥${NODE_MIN_VERSION}）`,
          model: { source: agentConfig.model.source, model: null, available: [] },
        });
      }
      return this.cache({
        ...base,
        code: 'node_missing',
        message: '未找到可用的 Node 运行时，请安装 Node ≥22.19 或在设置中填写路径',
        model: { source: agentConfig.model.source, model: null, available: [] },
      });
    }
    if (compareVersions(runtime.nodeVersion ?? '0.0.0', NODE_MIN_VERSION) < 0) {
      const seen = oldNode?.version ?? runtime.nodeVersion ?? '未知';
      return this.cache({
        ...base,
        code: 'node_too_old',
        message: `Node 版本过低（找到 ${seen}，需要 ≥${NODE_MIN_VERSION}）`,
        model: { source: agentConfig.model.source, model: null, available: [] },
      });
    }
    if (!runtime.piCliPath) {
      return this.cache({
        ...base,
        code: runtime.piVersion ? 'pi_version_unsupported' : 'pi_missing',
        message: runtime.piVersion
          ? `pi 版本 ${runtime.piVersion} 不在支持范围 ${PI_SUPPORTED_RANGE}`
          : `未找到 pi 包，请安装：npm i -g ${PI_PACKAGE_NAME}`,
        model: { source: agentConfig.model.source, model: null, available: [] },
      });
    }
    if (runtime.piVersion && !satisfiesPiRange(runtime.piVersion)) {
      return this.cache({
        ...base,
        code: 'pi_version_unsupported',
        message: `pi 版本 ${runtime.piVersion} 不在支持范围 ${PI_SUPPORTED_RANGE}`,
        model: { source: agentConfig.model.source, model: null, available: [] },
      });
    }

    // 模型探测
    if (agentConfig.model.source === 'app-llm') {
      const target = resolveAppLlmModel(llmConfig, agentConfig);
      if (!target) {
        return this.cache({
          ...base,
          code: 'model_unconfigured',
          message: 'app-llm 模式下没有启用的模型提供商/预设，请先在设置中配置模型',
          model: { source: 'app-llm', model: null, available: [] },
        });
      }
      if (!target.apiKey) {
        return this.cache({
          ...base,
          code: 'model_auth_missing',
          message: `提供商 ${target.providerName} 未配置 API Key`,
          model: { source: 'app-llm', model: `feishu-sync-llm/${target.openAiModel}`, available: [] },
        });
      }
      if (modelProbe) {
        const probed = await modelProbe(runtime);
        if (probed === null) {
          // 探测回调显式跳过（如内部端口未知）：按配置推断，不误报 spawn 失败
          return this.cache({
            ...base,
            code: 'ready',
            message: '运行时就绪（模型未探测）',
            model: { source: 'app-llm', model: `feishu-sync-llm/${target.openAiModel}`, available: [] },
          });
        }
        if (!probed.ok) {
          return this.cache({
            ...base,
            code: 'pi_spawn_failed',
            message: `pi 探测进程启动失败：${(probed.stderr ? probed.stderr.slice(0, 500) : '未知错误')}`,
            model: { source: 'app-llm', model: `feishu-sync-llm/${target.openAiModel}`, available: [] },
          });
        }
        const wanted = `feishu-sync-llm/${target.openAiModel}`;
        if (!probed.available.includes(wanted)) {
          return this.cache({
            ...base,
            code: 'model_auth_missing',
            message: `探测进程未看到模型 ${wanted}（API Key 缺失或未注入）`,
            model: { source: 'app-llm', model: wanted, available: probed.available },
          });
        }
        return this.cache({
          ...base,
          code: 'ready',
          message: '运行时与模型均就绪',
          model: { source: 'app-llm', model: wanted, available: probed.available },
        });
      }
      // 无探测通道（如测试环境）时按配置推断
      return this.cache({
        ...base,
        code: 'ready',
        message: '运行时就绪（模型未探测）',
        model: { source: 'app-llm', model: `feishu-sync-llm/${target.openAiModel}`, available: [] },
      });
    }

    // pi-agent-dir：显式 opt-in 复用本机 pi 凭据
    const piModel = agentConfig.model.piModel?.trim() || '';
    if (modelProbe) {
      const probed = await modelProbe(runtime);
      if (probed === null) {
        // 探测回调显式跳过：按配置推断
        return this.cache({
          ...base,
          code: piModel ? 'ready' : 'model_unconfigured',
          message: piModel ? '运行时就绪（模型未探测）' : '请从本机 pi 可用模型列表中选择模型',
          model: { source: 'pi-agent-dir', model: piModel || null, available: [] },
        });
      }
      if (!probed.ok) {
        return this.cache({
          ...base,
          code: 'pi_spawn_failed',
          message: `pi 探测进程启动失败：${(probed.stderr ? probed.stderr.slice(0, 500) : '未知错误')}`,
          model: { source: 'pi-agent-dir', model: piModel || null, available: [] },
        });
      }
      if (probed.available.length === 0) {
        return this.cache({
          ...base,
          code: 'model_auth_missing',
          message: '本机 pi 凭据下无可用模型（auth.json 缺失或过期）',
          model: { source: 'pi-agent-dir', model: piModel || null, available: [] },
        });
      }
      if (!piModel || !probed.available.includes(piModel)) {
        return this.cache({
          ...base,
          code: 'model_unconfigured',
          message: piModel ? `模型 ${piModel} 不在本机 pi 可用模型列表中` : '请从本机 pi 可用模型列表中选择模型',
          model: { source: 'pi-agent-dir', model: piModel || null, available: probed.available },
        });
      }
      return this.cache({
        ...base,
        code: 'ready',
        message: '运行时与模型均就绪',
        model: { source: 'pi-agent-dir', model: piModel, available: probed.available },
      });
    }
    return this.cache({
      ...base,
      code: piModel ? 'ready' : 'model_unconfigured',
      message: piModel ? '运行时就绪（模型未探测）' : '请从本机 pi 可用模型列表中选择模型',
      model: { source: 'pi-agent-dir', model: piModel || null, available: [] },
    });
  }

  private cache(result: ReadinessResult): ReadinessResult {
    return result;
  }

  getCached(): ReadinessResult | null {
    return this.cached;
  }
}

export type AppLlmModelResolution = import('../modules/model-selection.js').ResolvedProviderModel;

/**
 * 解析 app-llm 目标模型：显式 providerId/modelId 优先，缺省回落
 * llm.activeProviderId/activeModelId。
 */
export function resolveAppLlmModel(
  llm: LlmConfig,
  agent: AgentConfig,
): AppLlmModelResolution | null {
  return resolveProviderModel(llm, agent.model);
}

export function readinessCodeOf(status: ReadinessResult): ReadinessCode {
  return status.code;
}
