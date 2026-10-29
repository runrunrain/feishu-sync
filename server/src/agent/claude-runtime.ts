/** Claude Code discovery and application-provider configuration. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findExecutableOnPath, getNodeRuntimeCandidateDirectories } from '../modules/lark-cli-client.js';
import { resolveProviderModel } from '../modules/model-selection.js';
import type { AgentConfig } from '../types/agent-knowledge.js';
import type { LlmConfig } from '../types/index.js';

const exec = promisify(execFile);

/** Resolve native executable without invoking shell shims or parsing their contents. */
export function resolveClaudeCodePath(configured?: string, env = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const directories = getNodeRuntimeCandidateDirectories(home, env, platform);
  const preferred = configured?.trim();
  const fromShim = (shim: string): string | null => {
    if (!/\.cmd$/i.test(shim)) return shim;
    const candidate = path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    return fs.existsSync(candidate) ? candidate : null;
  };
  if (preferred) {
    const candidate = fromShim(path.resolve(preferred));
    return candidate && fs.existsSync(candidate) ? candidate : null;
  }
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const candidates = [
    platform === 'win32' ? path.join(home, '.local', 'bin', 'claude.exe') : path.join(home, '.local', 'bin', 'claude'),
    ...directories.flatMap((dir) => names.map((name) => path.join(dir, name))),
    findExecutableOnPath(names, env.PATH ?? env.Path) ?? '',
  ];
  for (const entry of candidates) {
    if (!entry || !fs.existsSync(entry)) continue;
    const candidate = fromShim(entry);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function inspectClaudeCode(file: string): Promise<{ version: string; supported: boolean }> {
  const [version, help] = await Promise.all([
    exec(file, ['--version'], { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }),
    exec(file, ['--help'], { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }),
  ]);
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(version.stdout);
  if (!match) throw new Error('无法识别 Claude Code 版本');
  const supported = ['--bare', '--strict-mcp-config', '--tools', '--permission-mode', '--output-format', '--mcp-config', '--system-prompt-snapshot'].every((flag) => help.stdout.includes(flag))
    && (help.stdout.includes('--append-system-prompt-file') || help.stdout.includes('--append-system-prompt[-file]'));
  return { version: match[1], supported };
}

export function resolveClaudeProvider(llm: LlmConfig, agent: AgentConfig) {
  return resolveProviderModel(llm, agent.model, 'anthropic-messages') ?? resolveProviderModel(llm, agent.model);
}
