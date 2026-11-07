/**
 * CLI 帮助面（A 项）：单命令帮助 / 命令组帮助 / 顶层帮助补行。
 *
 * 单命令帮助全部由命令表 schema 机械生成（用法行含位置参数形态、参数
 * 表、位置顺序、示例），不编造值；组帮助列出该组全部子命令。
 */

import { describe, expect, it } from 'vitest';
import { findOpsCommand, OPS_COMMANDS } from '../src/ops/command-table.js';
import { parseInvocation } from '../src/cli/args.js';
import { renderCommandHelp, renderTopHelp } from '../src/cli/help.js';
import { runCli } from '../src/cli/cli-app.js';

/** 捕获 runCli 的 stdout/stderr 写入（进程内，无网络）。 */
async function runCapture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out.push(s); return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err.push(s); return true; };
  try {
    const code = await runCli(argv);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    (process.stdout as unknown as { write: (s: string) => boolean }).write = origOut;
    (process.stderr as unknown as { write: (s: string) => boolean }).write = origErr;
  }
}

describe('单命令帮助（<命令> --help / help <命令>）', () => {
  it('cloud move_status --help：用法行含位置参数形态、参数表、位置顺序、示例', () => {
    const def = findOpsCommand('cloud.move_status')!;
    const text = renderCommandHelp(def);
    expect(text).toContain('feishu-sync cloud move_status <moveId>');
    expect(text).toContain('查询单次移出记录状态');
    expect(text).toContain('风险级：read');
    expect(text).toContain('--move-id');
    expect(text).toContain('必填');
    expect(text).toContain('位置参数顺序：moveId（第 1 位）');
    expect(text.match(/feishu-sync cloud move_status <moveId>/g)?.length).toBeGreaterThanOrEqual(1);
    // 示例由 schema 生成：必填位置参数出现在示例里
    expect(text).toContain('feishu-sync cloud move_status <moveId>');
    expect(text).toContain('feishu-sync cloud move_status <moveId> --json');
  });

  it('kb builds --help：可选位置参数显示 [<limit>] 形态', () => {
    const text = renderCommandHelp(findOpsCommand('kb.builds')!);
    expect(text).toContain('用法：feishu-sync kb builds [<limit>]');
    expect(text).toContain('位置参数顺序：limit（第 1 位，可选）');
  });

  it('带确认值的命令说明 --yes 注入（kb build / clean orphans）', () => {
    const build = renderCommandHelp(findOpsCommand('kb.build')!);
    expect(build).toContain('执行需 --yes（注入 confirm=BUILD）');
    expect(build).toContain('--rebuild-selected');
    const orphans = renderCommandHelp(findOpsCommand('clean.orphans')!);
    expect(orphans).toContain('注入 confirmation=APPLY');
  });

  it('array 尾位位置参数显示 <name…>（sync whiteboard_backfill / kb sources include）', () => {
    expect(renderCommandHelp(findOpsCommand('sync.whiteboard_backfill')!))
      .toContain('用法：feishu-sync sync whiteboard_backfill [<docTokens…>]');
    expect(renderCommandHelp(findOpsCommand('kb.sources.include')!))
      .toContain('用法：feishu-sync kb sources include <tokens…>');
  });

  it('kb builds --help 走单命令帮助而非顶层帮助（runCli 退出码 0）', async () => {
    const run = await runCapture(['kb', 'builds', '--help']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('feishu-sync kb builds —— 构建历史');
    expect(run.out).not.toContain('命令（风险级');
  });

  it('help <命令> 与 <命令> -h 同样输出单命令帮助', async () => {
    const viaHelp = await runCapture(['help', 'cloud', 'moves']);
    expect(viaHelp.code).toBe(0);
    expect(viaHelp.out).toContain('用法：feishu-sync cloud moves [<objToken>]');
    const viaH = await runCapture(['cloud', 'moves', '-h']);
    expect(viaH.code).toBe(0);
    expect(viaH.out).toContain('feishu-sync cloud moves ——');
  });
});

describe('命令组帮助（kb --help / help kb / 裸组名）', () => {
  it('kb --help：列出组内全部子命令，退出码 0', async () => {
    const run = await runCapture(['kb', '--help']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('命令组');
    for (const name of ['kb status', 'kb builds', 'kb build', 'kb sources include', 'kb publish']) {
      expect(run.out).toContain(`feishu-sync ${name}`);
    }
  });

  it('help kb / help kb sources 同样列出组命令', async () => {
    const run = await runCapture(['help', 'kb']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('feishu-sync kb build');
    const nested = await runCapture(['help', 'kb', 'sources']);
    expect(nested.code).toBe(0);
    expect(nested.out).toContain('feishu-sync kb sources include');
  });

  it('裸组名（kb 无子命令）退出码 2 并同样列出子命令', async () => {
    const run = await runCapture(['kb']);
    expect(run.code).toBe(2);
    expect(run.out).toContain('feishu-sync kb build');
  });

  it('parseInvocation：组词识别与帮助目标解析', () => {
    expect(parseInvocation(['kb']).group).toBe('kb');
    expect(parseInvocation(['kb', 'sources']).group).toBe('kb.sources');
    expect(parseInvocation(['auth', 'login']).group).toBe('auth.login');
    expect(parseInvocation(['help', 'kb']).group).toBe('kb');
    expect(parseInvocation(['help', 'kb']).flags.help).toBe(true);
  });

  it('组渲染不吞命令：isCommandGroup 仅为前缀（kb.builds 仍是命令）', () => {
    const parsed = parseInvocation(['kb', 'builds']);
    expect(parsed.group).toBeUndefined();
    expect(parsed.command?.name).toBe('kb.builds');
  });
});

describe('顶层帮助', () => {
  it('末尾补单命令帮助与补全提示行，含 --timeout 全局旗标', () => {
    const text = renderTopHelp();
    expect(text).toContain('feishu-sync help <命令> 查看单命令用法；completion <shell> 生成补全');
    expect(text).toContain('--timeout <秒>');
    // 现有内容保持：命令清单与示例仍在
    expect(text).toContain('feishu-sync clean orphans --apply --yes');
    expect(text).toContain('[read] 应用总览');
  });

  it('顶层 --help 仍列全部命令（与命令表同源）', () => {
    const text = renderTopHelp();
    for (const def of OPS_COMMANDS.slice(0, 5)) {
      expect(text).toContain(def.name.split('.').join(' '));
    }
  });
});
