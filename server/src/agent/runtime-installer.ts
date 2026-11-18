import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentConfig } from '../types/agent-knowledge.js';
import { checkPiPackageRoot, PI_PACKAGE_NAME, type PiRuntimeResolver, type ResolvedRuntime } from './runtime-resolver.js';
import { resolveInside } from './path-guard.js';
import { ensurePiLauncher } from './windows-pi-launcher.js';
import type { AgentProcessPool } from './agent-process-pool.js';
import { inspectClaudeCode, resolveClaudeCodePath } from './claude-runtime.js';

const run = promisify(execFile);
export type RuntimeBackend = 'pi' | 'claude-code';

/** Application-owned npm installations; never updates the user's global packages. */
export class RuntimeInstaller {
  private pending: Promise<void> | null = null;
  constructor(
    private readonly root: string, private readonly resolver: PiRuntimeResolver,
    private readonly pool: AgentProcessPool, private readonly config: () => AgentConfig,
    private readonly publishPi?: (prefix: string, nodePath: string, cliPath: string) => Promise<void>,
  ) {}

  async ensureMissing(onPiReady?: () => Promise<unknown>): Promise<void> {
    const config = this.config();
    const runtime = await this.resolver.resolveRuntime(config);
    if (!runtime.nodePath) return;
    try {
      if (!runtime.piCliPath && !config.runtime.piCliPath) await this.install('pi');
      else await this.publishManagedPi(runtime);
    } catch (error) {
      console.warn('[agent] Pi 自动准备失败:', error instanceof Error ? error.message : 'unknown error');
    }
    await onPiReady?.();
  }

  async install(backend: RuntimeBackend): Promise<void> {
    if (this.pending) throw new Error('Agent 安装或更新正在进行');
    if (this.pool.loadCount() > 0) throw new Error('请先结束 Agent 会话和构建，再更新运行时');
    const config = this.config();
    if (backend === 'pi' ? config.runtime.piCliPath : config.runtime.claudeCliPath) throw new Error('当前配置了自定义运行时路径，请先清除路径覆盖或手动更新该安装');
    this.pending = this.performInstall(backend);
    try { await this.pending; } finally { this.pending = null; }
  }

  private async publishManagedPi(runtime: ResolvedRuntime): Promise<void> {
    if (!this.publishPi || !runtime.nodePath || !runtime.piCliPath || !runtime.piPackageRoot) return;
    const relativePrefix = 'agent/runtimes/pi';
    const expectedPackage = path.join(this.root, relativePrefix, 'node_modules', PI_PACKAGE_NAME);
    if (path.relative(expectedPackage, runtime.piPackageRoot) !== '') return;
    const prefix = resolveInside(this.root, relativePrefix, 'read');
    const rel = path.relative(path.join(this.root, relativePrefix), runtime.piCliPath);
    await this.publishPi(prefix, runtime.nodePath, path.join(prefix, rel));
  }

  private async performInstall(backend: RuntimeBackend): Promise<void> {
    const runtime = await this.resolver.resolveRuntime(this.config());
    if (!runtime.nodePath) throw new Error('未找到 Node 运行时，无法安装 Agent');
    const npmCli = path.join(path.dirname(runtime.nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmUnix = path.resolve(path.dirname(runtime.nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npm = [npmCli, npmUnix].find((candidate) => fs.existsSync(candidate));
    if (!npm) throw new Error('未找到 npm，请先安装包含 npm 的 Node');
    const parent = path.join(this.root, 'agent', 'runtimes');
    fs.mkdirSync(parent, { recursive: true });
    const prefix = path.join(parent, backend);
    const staging = fs.mkdtempSync(path.join(parent, `${backend}-stage-`));
    const pkg = backend === 'pi' ? `${PI_PACKAGE_NAME}@>=1.4.0 <2` : '@anthropic-ai/claude-code@latest';
    try {
      await run(runtime.nodePath, [npm, 'install', '--prefix', staging, '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', pkg], { timeout: 300_000, windowsHide: true, maxBuffer: 1024 * 1024 });
      if (backend === 'claude-code') {
        const packageRoot = path.join(staging, 'node_modules', '@anthropic-ai', 'claude-code');
        await run(runtime.nodePath, [path.join(packageRoot, 'install.cjs')], { cwd: packageRoot, timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 });
      }
      if (backend === 'pi') {
        const entry = checkPiPackageRoot(path.join(staging, 'node_modules', PI_PACKAGE_NAME));
        if (!entry.nameOk || !entry.cliPath || !entry.version) throw new Error('missing executable');
        if (this.publishPi) ensurePiLauncher(staging, runtime.nodePath, entry.cliPath);
      } else {
        const entry = path.join(staging, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (!(await inspectClaudeCode(entry)).supported) throw new Error('unsupported executable');
      }
      if (this.pool.loadCount() > 0) throw new Error('Agent 正在运行，请结束任务后重试更新');
      const backup = `${staging}-backup`;
      const hadPrevious = fs.existsSync(prefix);
      if (hadPrevious) fs.renameSync(prefix, backup);
      try { fs.renameSync(staging, prefix); } catch (error) { if (hadPrevious) fs.renameSync(backup, prefix); throw error; }
      if (hadPrevious) fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (error instanceof Error && error.message.includes('Agent 正在运行')) throw error;
      throw new Error(`${backend} 安装失败，请检查网络和 npm 后重试`);
    }
    this.resolver.invalidate();
    const after = await this.resolver.resolveRuntime(this.config());
    if (backend === 'pi' ? !after.piCliPath : !resolveClaudeCodePath()) throw new Error(`${backend} 安装完成但未发现可执行文件`);
    if (backend === 'pi') await this.publishManagedPi(after);
  }
}
