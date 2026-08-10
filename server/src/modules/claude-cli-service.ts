/**
 * Claude Code executable discovery for the packaged desktop application.
 *
 * Finder-launched Electron apps inherit a minimal PATH, so a bare `claude`
 * command that works in Terminal frequently fails with ENOENT in production.
 * This module resolves the same common npm locations used by Claude Code and
 * keeps the Node runtime directory on PATH for script-style npm shims.
 *
 * Detection is read-only. Installing or authenticating Claude Code remains an
 * explicit user action because both can change the user's account/system
 * state. The actual model credential is injected separately by
 * ClaudeCliChannel through ANTHROPIC_* environment variables.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ClaudeCliExecutableSource =
  | 'configured'
  | 'environment'
  | 'path'
  | 'known-location'
  | 'missing';

export interface ClaudeCliInvocation {
  command: string;
  /** Windows npm .cmd shims require cmd.exe; POSIX shims do not. */
  useShell: boolean;
  source: Exclude<ClaudeCliExecutableSource, 'missing'>;
}

export interface ClaudeCliStatus {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  source: ClaudeCliExecutableSource;
  /** True only after `claude --version` successfully completed. */
  executable: boolean;
  error?: string;
}

export interface ClaudeCliServiceOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

const VERSION_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT = 32_000;

function isExplicitPath(value: string): boolean {
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\');
}

/**
 * `path.resolve()` follows the host platform. During cross-platform tests —
 * and in helpers invoked from a non-Windows parent — resolving `C:\\...`
 * through POSIX path rules incorrectly prefixes the current working
 * directory. Preserve a Windows drive/UNC command exactly; Node on Windows
 * can spawn it directly.
 */
function resolveExplicitCommand(value: string): string {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) ? value : path.resolve(value);
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWindowsShim(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? ['claude.cmd', 'claude.exe', 'claude']
    : ['claude'];
}

function findOnPath(names: string[], pathValue: string | undefined): string | null {
  if (!pathValue) return null;
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function knownDirectories(
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform === 'win32') {
    return [
      env.APPDATA ? path.join(env.APPDATA, 'npm') : '',
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'npm') : '',
      path.join(homeDir, 'AppData', 'Roaming', 'npm'),
    ].filter(Boolean);
  }
  return [
    path.join(homeDir, '.local', 'node', 'bin'),
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.npm-global', 'bin'),
    path.join(homeDir, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

function makeInvocation(
  command: string,
  source: Exclude<ClaudeCliExecutableSource, 'missing'>,
  platform: NodeJS.Platform,
): ClaudeCliInvocation {
  return { command, source, useShell: isWindowsShim(command, platform) };
}

/**
 * Synchronously resolve an invocation suitable for document jobs. It never
 * spawns a process, which keeps each sync from paying an extra version check.
 * `ClaudeCliService.getStatus()` performs the explicit executable probe used
 * by the Settings UI.
 */
export function resolveClaudeCliInvocation(
  configuredPath?: string,
  options: ClaudeCliServiceOptions = {},
): ClaudeCliInvocation | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const names = executableNames(platform);
  const preferred = configuredPath?.trim();

  if (preferred) {
    if (isExplicitPath(preferred)) {
      // Preserve an explicit bad path. spawn will return a precise error,
      // rather than silently selecting a different global installation.
      return makeInvocation(resolveExplicitCommand(preferred), 'configured', platform);
    }
    const fromPath = findOnPath([preferred], env.PATH ?? env.Path);
    if (fromPath) return makeInvocation(fromPath, 'configured', platform);
    // A non-path explicit command can be a custom launcher. Let spawn expose
    // its error instead of pretending that no user preference was supplied.
    return makeInvocation(preferred, 'configured', platform);
  }

  const fromEnvironment = env.CLAUDE_CODE_EXECPATH?.trim();
  if (fromEnvironment) {
    return makeInvocation(
      isExplicitPath(fromEnvironment) ? resolveExplicitCommand(fromEnvironment) : fromEnvironment,
      'environment',
      platform,
    );
  }

  const fromPath = findOnPath(names, env.PATH ?? env.Path);
  if (fromPath) return makeInvocation(fromPath, 'path', platform);

  for (const directory of knownDirectories(platform, homeDir, env)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isExecutable(candidate)) return makeInvocation(candidate, 'known-location', platform);
    }
  }

  return null;
}

/**
 * Add the resolved npm-shim directory to PATH. Global npm launchers commonly
 * start with `#!/usr/bin/env node`; resolving `/.../bin/claude` alone is not
 * enough when Electron was started from Finder and cannot find `node`.
 */
export function buildClaudeCliEnvironment(
  invocation: ClaudeCliInvocation,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...environment };
  if (!isExplicitPath(invocation.command)) return env;

  const executableDirectory = path.dirname(path.resolve(invocation.command));
  const pathKey = platform === 'win32' && env.Path ? 'Path' : 'PATH';
  const currentPath = env[pathKey] ?? env.PATH ?? env.Path ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  env[pathKey] = [
    executableDirectory,
    ...entries.filter((entry) => entry !== executableDirectory),
  ].join(path.delimiter);
  return env;
}

function compactMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact ? compact.slice(0, 400) : undefined;
}

function parseVersion(value: string): string | null {
  const match = value.match(/\b(?:v)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

/** Read-only availability probe for the Settings screen. */
export class ClaudeCliService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;

  constructor(options: ClaudeCliServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? os.homedir();
  }

  async getStatus(configuredPath?: string): Promise<ClaudeCliStatus> {
    const invocation = resolveClaudeCliInvocation(configuredPath, {
      env: this.env,
      platform: this.platform,
      homeDir: this.homeDir,
    });
    if (!invocation) {
      return {
        installed: false,
        executablePath: null,
        version: null,
        source: 'missing',
        executable: false,
        error: '未检测到 Claude Code。请安装 Claude Code，或在设置中填写其可执行文件路径。',
      };
    }

    const result = await this.runVersion(invocation);
    const version = parseVersion(result.stdout);
    if (result.code === 0 && !result.error) {
      return {
        installed: true,
        executablePath: invocation.command,
        version,
        source: invocation.source,
        executable: true,
      };
    }
    const failure = compactMessage(result.error || result.stderr);
    return {
      installed: true,
      executablePath: invocation.command,
      version: null,
      source: invocation.source,
      executable: false,
      error: result.timedOut
        ? 'Claude Code 版本检查超时'
        : failure
          ? `Claude Code 无法启动：${failure}`
          : 'Claude Code 无法启动，请检查可执行文件路径和 Node.js 环境。',
    };
  }

  private runVersion(invocation: ClaudeCliInvocation): Promise<CommandResult> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(invocation.command, ['--version'], {
          env: buildClaudeCliEnvironment(invocation, this.env, this.platform),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: invocation.useShell,
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
      const settle = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const append = (current: string, chunk: Buffer | string): string => {
        if (current.length >= OUTPUT_LIMIT) return current;
        const next = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        return `${current}${next}`.slice(0, OUTPUT_LIMIT);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Best effort; close/error will settle the promise.
        }
      }, VERSION_TIMEOUT_MS);

      child.stdout?.on('data', (chunk: Buffer | string) => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr = append(stderr, chunk); });
      child.on('error', (error) => settle({
        code: null,
        stdout,
        stderr,
        timedOut,
        error: error.message,
      }));
      child.on('close', (code) => settle({ code, stdout, stderr, timedOut }));
    });
  }
}
