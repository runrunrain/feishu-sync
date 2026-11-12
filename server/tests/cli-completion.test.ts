/**
 * CLI 补全脚本生成（E 项）：completion 本地命令与三 shell 脚本。
 *
 * 脚本由命令表静态生成；bash/zsh 必须通过 `bash -n`/`zsh -n` 语法检查
 * （zsh 不存在时跳过），fish 存在时同样检查。completion 不经命令表、
 * 不连服务器、不计入命令数（OPS_COMMANDS 仍为 40）。
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPS_COMMANDS } from '../src/ops/command-table.js';
import { renderCompletionScript, renderCompletionUsage } from '../src/cli/completion.js';
import { runCli } from '../src/cli/cli-app.js';
import { findShell, shellPath } from './helpers/shell.js';

function shellSyntaxOk(shell: 'bash' | 'zsh' | 'fish', script: string): boolean {
  const binPath = findShell(shell);
  if (!binPath) return false; // 目标 shell 不在本机：跳过（测试断言仅 bash 必装）
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-comp-')), `comp.${shell}`);
  fs.writeFileSync(file, script, 'utf-8');
  try {
    execFileSync(binPath, ['-n', shellPath(file)], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/** 捕获 runCli stdout（本地路径，无网络）。 */
async function runCapture(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out.push(s); return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv);
    return { code, out: out.join('') };
  } finally {
    (process.stdout as unknown as { write: (s: string) => boolean }).write = origOut;
    (process.stderr as unknown as { write: (s: string) => boolean }).write = origErr;
  }
}

describe('completion 本地命令', () => {
  it('completion bash → 退出码 0，stdout 输出脚本', async () => {
    const run = await runCapture(['completion', 'bash']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('complete -F _feishu_sync_complete feishu-sync');
  });

  it('缺 shell / 非法 shell → 退出码 2；--help → 用法说明退出码 0', async () => {
    const missing = await runCapture(['completion']);
    expect(missing.code).toBe(2);
    const invalid = await runCapture(['completion', 'powershell']);
    expect(invalid.code).toBe(2);
    const helped = await runCapture(['completion', '--help']);
    expect(helped.code).toBe(0);
    expect(helped.out).toContain('source <(feishu-sync completion bash)');
  });

  it('completion 不进入命令表（OPS_COMMANDS 仍 40 且无 completion.*）', () => {
    expect(OPS_COMMANDS.length).toBe(40);
    expect(OPS_COMMANDS.some((def) => def.name.startsWith('completion'))).toBe(false);
  });
});

describe('脚本内容（命令词分层 + 每命令参数 + 全局旗标）', () => {
  it('bash：顶层词、组词、命令参数旗标、全局旗标与 --timeout', () => {
    const script = renderCompletionScript('bash');
    expect(script).toContain("auth clean cloud config kb lark llm source sources status sync --home --json --yes --help --version --timeout");
    expect(script).toContain("'kb')");
    expect(script).toContain('build builds cancel changes publications publish publish-preview sources status versions');
    expect(script).toContain("'kb build')");
    expect(script).toContain('--rebuild-selected');
    expect(script).toContain("--kb-paths");
  });

  it('zsh：#compdef 头 + compdef 注册 + cands 数组', () => {
    const script = renderCompletionScript('zsh');
    expect(script.startsWith('#compdef feishu-sync')).toBe(true);
    expect(script).toContain('compdef _feishu_sync feishu-sync');
    expect(script).toContain('cands=(build builds');
    expect(script).toContain('compadd -- "${cands[@]}"');
  });

  it('fish：complete 行覆盖命令词与带值参数（-r）', () => {
    const script = renderCompletionScript('fish');
    expect(script).toContain("complete -c feishu-sync -f -a 'auth clean cloud config kb lark llm source sources status sync'");
    expect(script).toContain('-l limit -r');
    expect(script).toContain('-l home -r');
    expect(script).toContain("-n '__fish_seen_subcommand_from builds'");
  });

  it('用法说明含三种 shell 安装示例', () => {
    const usage = renderCompletionUsage();
    expect(usage).toContain('bash');
    expect(usage).toContain('zsh');
    expect(usage).toContain('fish');
  });
});

describe('语法检查（真实 shell -n）', () => {
  it('bash -n 通过', () => {
    expect(shellSyntaxOk('bash', renderCompletionScript('bash'))).toBe(true);
  });

  it('zsh -n 通过（本机无 zsh 时跳过并注明）', () => {
    const hasZsh = !!findShell('zsh');
    if (!hasZsh) {
      expect(shellSyntaxOk('zsh', renderCompletionScript('zsh'))).toBe(false);
      return;
    }
    expect(shellSyntaxOk('zsh', renderCompletionScript('zsh'))).toBe(true);
  });

  it('fish -n 通过（本机无 fish 时跳过并注明）', () => {
    const hasFish = !!findShell('fish');
    if (!hasFish) {
      expect(shellSyntaxOk('fish', renderCompletionScript('fish'))).toBe(false);
      return;
    }
    expect(shellSyntaxOk('fish', renderCompletionScript('fish'))).toBe(true);
  });
});
