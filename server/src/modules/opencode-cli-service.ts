/**
 * OpenCode CLI discovery and installation.
 *
 * The packaged Electron application does not inherit a login shell's PATH on
 * every platform. Resolving only `opencode` therefore works in a terminal but
 * often fails in the desktop app. This service follows the same layered
 * strategy as amagi-codebox:
 *
 *   configured absolute path -> process PATH -> login shell PATH ->
 *   npm global prefix/root -> package manifest fallback.
 *
 * Installation is deliberately explicit: callers must invoke install(); a
 * status check never changes the user's system. The install command is the
 * official npm package command: `npm install -g opencode-ai@latest`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type OpenCodeExecutableSource =
  | 'configured'
  | 'path'
  | 'login-shell'
  | 'npm-global-prefix'
  | 'npm-global-root'
  | 'missing';

export interface OpenCodeStatus {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  source: OpenCodeExecutableSource;
  /** The executable was successfully spawned with `--version`. */
  executable: boolean;
  error?: string;
}

export interface OpenCodeInvocation {
  command: string;
  /** Windows npm shims require cmd.exe; all task content remains out of argv. */
  useShell: boolean;
  version: string;
  source: Exclude<OpenCodeExecutableSource, 'missing'>;
}

export interface OpenCodeResolution {
  status: OpenCodeStatus;
  invocation: OpenCodeInvocation | null;
}

export interface OpenCodeInstallResult {
  success: boolean;
  status: OpenCodeStatus;
  message: string;
}

export interface OpenCodeCliServiceOptions {
  /** Test seam; production defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam; production defaults to process.platform. */
  platform?: NodeJS.Platform;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

interface Candidate {
  command: string;
  source: Exclude<OpenCodeExecutableSource, 'missing'>;
}

interface PackageLocation {
  packageDir: string;
  version: string | null;
  executablePath: string | null;
}

const VERSION_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 32_000;

function compactMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 400) : undefined;
}

function parseVersion(value: string): string | null {
  const match = value.match(/\b(?:v)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function isWindowsShim(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
}

/**
 * Resolve, verify and explicitly install the local OpenCode executable.
 * Instances are cheap, but `install()` is serialized per instance to avoid
 * two UI clicks running global npm installs concurrently.
 */
export class OpenCodeCliService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private installInFlight: Promise<OpenCodeInstallResult> | null = null;

  constructor(options: OpenCodeCliServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
  }

  async getStatus(preferredExecutablePath?: string): Promise<OpenCodeStatus> {
    return (await this.resolve(preferredExecutablePath)).status;
  }

  /**
   * Return an executable suitable for spawning. A caller that intends to run
   * a document job should use this rather than trusting a status-only result.
   */
  async resolve(preferredExecutablePath?: string): Promise<OpenCodeResolution> {
    const preferred = preferredExecutablePath?.trim();
    if (preferred) {
      if (!path.isAbsolute(preferred)) {
        return {
          invocation: null,
          status: {
            installed: false,
            executablePath: preferred,
            version: null,
            source: 'configured',
            executable: false,
            error: 'OpenCode 可执行文件路径必须是绝对路径',
          },
        };
      }
      return this.resolveCandidates([{ command: preferred, source: 'configured' }], true);
    }

    const pathCandidate = this.findExecutableOnPath('opencode');
    // Fast path for the common terminal/dev environment. Do not start a
    // login shell or query npm when a normal PATH executable already proves
    // usable; this keeps Settings checks quick and side-effect free.
    if (pathCandidate) {
      const resolved = await this.resolveCandidates([{ command: pathCandidate, source: 'path' }], false);
      if (resolved.invocation) return resolved;
    }

    const candidates: Candidate[] = [];

    const loginShellCandidate = await this.findExecutableFromLoginShell('opencode');
    if (loginShellCandidate) {
      candidates.push({ command: loginShellCandidate, source: 'login-shell' });
    }

    const npm = await this.findNpmExecutable();
    if (npm) {
      const prefix = await this.runCommand(npm, ['prefix', '-g'], VERSION_TIMEOUT_MS);
      const prefixDir = prefix.code === 0 ? prefix.stdout.trim() : '';
      const prefixCandidate = prefixDir ? this.findOpenCodeInPrefix(prefixDir) : null;
      if (prefixCandidate && !candidates.some((candidate) => candidate.command === prefixCandidate)) {
        candidates.push({ command: prefixCandidate, source: 'npm-global-prefix' });
      }

      const root = await this.runCommand(npm, ['root', '-g'], VERSION_TIMEOUT_MS);
      const rootDir = root.code === 0 ? root.stdout.trim() : '';
      const packageLocation = rootDir ? this.findOpenCodePackage(rootDir) : null;
      if (packageLocation?.executablePath
        && !candidates.some((candidate) => candidate.command === packageLocation.executablePath)) {
        candidates.push({ command: packageLocation.executablePath, source: 'npm-global-root' });
      }

      const resolved = await this.resolveCandidates(candidates, false, packageLocation);
      if (resolved.invocation || packageLocation) return resolved;
    }

    const resolved = await this.resolveCandidates(candidates, false);
    if (resolved.invocation) return resolved;
    return {
      invocation: null,
      status: {
        installed: false,
        executablePath: null,
        version: null,
        source: 'missing',
        executable: false,
        error: '未检测到 OpenCode。可在设置中执行安装，或配置其绝对路径。',
      },
    };
  }

  /**
   * Explicit global npm installation. No status route or sync job calls this
   * method automatically, so a packaged app never mutates a user's system
   * merely because it was launched.
   */
  install(): Promise<OpenCodeInstallResult> {
    if (!this.installInFlight) {
      this.installInFlight = this.installInternal().finally(() => {
        this.installInFlight = null;
      });
    }
    return this.installInFlight;
  }

  private async installInternal(): Promise<OpenCodeInstallResult> {
    const npm = await this.findNpmExecutable();
    if (!npm) {
      const status = await this.getStatus();
      return {
        success: false,
        status,
        message: '未找到 npm，无法安装 OpenCode。请先安装 Node.js/npm 后重试。',
      };
    }

    const result = await this.runCommand(
      npm,
      ['install', '--global', 'opencode-ai@latest'],
      INSTALL_TIMEOUT_MS,
    );
    const status = await this.getStatus();
    if (result.timedOut) {
      return {
        success: false,
        status,
        message: `OpenCode 安装超时（${Math.round(INSTALL_TIMEOUT_MS / 1000)} 秒）`,
      };
    }
    if (result.error || result.code !== 0) {
      return {
        success: false,
        status,
        message: compactMessage(result.error || result.stderr)
          ? `OpenCode 安装失败：${compactMessage(result.error || result.stderr)}`
          : 'OpenCode 安装失败，请查看应用日志。',
      };
    }
    if (!status.executable) {
      return {
        success: false,
        status,
        message: status.error || 'npm 已完成，但 OpenCode 无法启动；请检查全局 npm 路径。',
      };
    }
    return {
      success: true,
      status,
      message: `OpenCode ${status.version ?? ''} 已安装并验证`.trim(),
    };
  }

  private async resolveCandidates(
    candidates: Candidate[],
    configuredOnly: boolean,
    packageLocation?: PackageLocation | null,
  ): Promise<OpenCodeResolution> {
    let lastError: string | undefined;
    for (const candidate of candidates) {
      const result = await this.runCommand(candidate.command, ['--version'], VERSION_TIMEOUT_MS);
      if (result.code === 0 && !result.timedOut) {
        const version = parseVersion(result.stdout) ?? 'unknown';
        const invocation: OpenCodeInvocation = {
          command: candidate.command,
          useShell: isWindowsShim(candidate.command, this.platform),
          version,
          source: candidate.source,
        };
        return {
          invocation,
          status: {
            installed: true,
            executablePath: candidate.command,
            version,
            source: candidate.source,
            executable: true,
          },
        };
      }
      lastError = result.timedOut
        ? `OpenCode --version 超时（${VERSION_TIMEOUT_MS / 1000} 秒）`
        : compactMessage(result.error || result.stderr)
          || `OpenCode --version 退出码 ${result.code ?? 'unknown'}`;
    }

    // A malformed native wrapper can make `opencode --version` fail even
    // while the npm package is present. Report that distinction instead of
    // falsely telling the user it is not installed; the UI can guide them to
    // reinstall or configure a known-good binary.
    if (packageLocation) {
      return {
        invocation: null,
        status: {
          installed: true,
          executablePath: packageLocation.executablePath,
          version: packageLocation.version,
          source: 'npm-global-root',
          executable: false,
          error: lastError || '检测到 opencode-ai，但其可执行文件无法启动。',
        },
      };
    }

    return {
      invocation: null,
      status: {
        installed: false,
        executablePath: configuredOnly && candidates[0] ? candidates[0].command : null,
        version: null,
        source: configuredOnly ? 'configured' : 'missing',
        executable: false,
        error: lastError || (configuredOnly
          ? '配置的 OpenCode 可执行文件不存在或无法启动。'
          : undefined),
      },
    };
  }

  private findExecutableOnPath(name: string): string | null {
    const pathValue = this.env.PATH || this.env.Path || '';
    const extensions = this.platform === 'win32'
      ? ['.exe', '.cmd', '.bat', '']
      : [''];
    for (const directory of pathValue.split(path.delimiter)) {
      if (!directory) continue;
      for (const extension of extensions) {
        const candidate = path.join(directory, `${name}${extension}`);
        if (this.isFile(candidate)) return candidate;
      }
    }
    return null;
  }

  private async findExecutableFromLoginShell(name: string): Promise<string | null> {
    if (this.platform === 'win32') return null;
    const shell = this.env.SHELL && path.isAbsolute(this.env.SHELL)
      ? this.env.SHELL
      : '/bin/zsh';
    if (!this.isFile(shell)) return null;
    // Command text is constant; user-supplied document/config values never
    // enter the shell. This is only a PATH recovery mechanism for Electron.
    const result = await this.runCommand(shell, ['-ilc', `command -v ${name}`], 5_000);
    if (result.code !== 0) return null;
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (path.isAbsolute(candidate) && this.isFile(candidate)) return candidate;
    }
    return null;
  }

  private async findNpmExecutable(): Promise<string | null> {
    const fromPath = this.findExecutableOnPath('npm');
    if (fromPath) return fromPath;
    return this.findExecutableFromLoginShell('npm');
  }

  private findOpenCodeInPrefix(prefix: string): string | null {
    const candidates = this.platform === 'win32'
      ? [
          path.join(prefix, 'opencode.cmd'),
          path.join(prefix, 'opencode.exe'),
          path.join(prefix, 'opencode'),
        ]
      : [
          path.join(prefix, 'bin', 'opencode'),
          path.join(prefix, 'opencode'),
        ];
    return candidates.find((candidate) => this.isFile(candidate)) ?? null;
  }

  private findOpenCodePackage(npmRoot: string): PackageLocation | null {
    const packageDir = path.join(npmRoot, 'opencode-ai');
    const manifestPath = path.join(packageDir, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        name?: unknown;
        version?: unknown;
        bin?: unknown;
      };
      if (manifest.name !== 'opencode-ai') return null;
      const bin = typeof manifest.bin === 'string'
        ? manifest.bin
        : manifest.bin && typeof manifest.bin === 'object'
          ? (manifest.bin as Record<string, unknown>).opencode
          : undefined;
      const candidate = typeof bin === 'string' ? path.resolve(packageDir, bin) : null;
      return {
        packageDir,
        version: typeof manifest.version === 'string' ? manifest.version : null,
        executablePath: candidate && this.isFile(candidate) ? candidate : null,
      };
    } catch {
      return null;
    }
  }

  private isFile(candidate: string): boolean {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }

  private runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, {
          shell: isWindowsShim(command, this.platform),
          windowsHide: true,
          env: this.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const append = (current: string, chunk: Buffer | string): string => {
        if (current.length >= OUTPUT_LIMIT) return current;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        return `${current}${text}`.slice(0, OUTPUT_LIMIT);
      };
      const settle = (value: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Best effort; close/error event settles the result.
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Best effort.
          }
        }, 5_000).unref();
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = append(stderr, chunk);
      });
      child.on('error', (error: Error) => {
        settle({ code: null, stdout, stderr, timedOut, error: error.message });
      });
      child.on('close', (code: number | null) => {
        settle({ code, stdout, stderr, timedOut });
      });
    });
  }
}
