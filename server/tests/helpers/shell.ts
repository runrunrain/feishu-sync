import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Prefer native Git Bash on Windows; System32/bash.exe may be an unconfigured WSL launcher. */
export function findShell(shell: 'bash' | 'zsh' | 'fish'): string | undefined {
  const candidates: string[] = [];
  if (process.platform === 'win32' && shell === 'bash') {
    const gitPaths = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    for (const git of gitPaths.trim().split(/\r?\n/).filter(Boolean)) {
      candidates.push(path.resolve(path.dirname(git), '../bin/bash.exe'));
    }
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'Git/bin/bash.exe'));
    }
  }
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [shell], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  candidates.push(...found.trim().split(/\r?\n/).filter(Boolean));
  return candidates.find(candidate => fs.existsSync(candidate)
    && spawnSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0);
}

export function requireBash(): string {
  const bash = findShell('bash');
  if (!bash) throw new Error('These tests require Bash (Git for Windows provides it).');
  return bash;
}

export function shellPath(file: string): string {
  return file.split(path.sep).join('/');
}
