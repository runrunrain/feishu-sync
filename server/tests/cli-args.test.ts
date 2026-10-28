/**
 * CLI 参数解析单元（S9，server/src/cli/args.ts）
 *
 * 纯函数层：命令词匹配（点号名 ↔ 空格分层）、全局旗标任意位置、
 * 位置参数绑定、类型转换、表内 required 校验。端到端行为见
 * tests/cli-client.test.ts（真实 server + 子进程）。
 */

import { describe, expect, it } from 'vitest';
import { OPS_COMMANDS, findOpsCommand } from '../src/ops/command-table.js';
import {
  buildCommandArgs,
  findCommandByWords,
  parseInvocation,
  spacedName,
  UsageError,
} from '../src/cli/args.js';
import { runCli } from '../src/cli/cli-app.js';

describe('命令词匹配', () => {
  it('空格分层 ↔ 表内点号名（最长前缀优先）', () => {
    expect(findCommandByWords(['kb', 'build'])?.name).toBe('kb.build');
    expect(findCommandByWords(['auth', 'login', 'start'])?.name).toBe('auth.login.start');
    expect(findCommandByWords(['clean', 'trash', 'purge'])?.name).toBe('clean.trash.purge');
    expect(findCommandByWords(['lark', 'config-init', 'complete'])?.name).toBe('lark.config-init.complete');
    // 多余词不劫持：words 只是前缀候选
    expect(findCommandByWords(['config', 'set', 'foo', 'bar'])?.name).toBe('config.set');
    expect(findCommandByWords(['no', 'such'])).toBeNull();
  });

  it('命令表 30 条全部可由空格形式命中（S13 登记 source.* 后）', () => {
    for (const def of OPS_COMMANDS) {
      expect(findCommandByWords(spacedName(def.name).split(' '))?.name).toBe(def.name);
    }
    expect(OPS_COMMANDS.length).toBe(30);
  });

  it('source.* 位置参数：<objToken> 绑定与必填校验', () => {
    // buildCommandArgs 走 POSITIONALS 映射（S13 追加）：首位置参数绑 objToken。
    const def = findOpsCommand('source.edit')!;
    const args = buildCommandArgs(def, ['doxcnABC', '--base-hash', 'h1', '--new-text', '# 新正文']);
    expect(args).toEqual({ objToken: 'doxcnABC', baseHash: 'h1', newText: '# 新正文' });
    // 缺必填 baseHash → usage 错
    expect(() => buildCommandArgs(def, ['doxcnABC', '--new-text', 'x'])).toThrowError(UsageError);
    // 多余位置参数 → usage 错
    expect(() => buildCommandArgs(def, ['doxcnABC', 'extra', '--new-text', 'x', '--base-hash', 'h'])).toThrowError(UsageError);
    // push 旗标型 boolean
    const pushDef = findOpsCommand('source.push')!;
    expect(buildCommandArgs(pushDef, ['doxcnABC', '--allow-overwrite'])).toEqual({ objToken: 'doxcnABC', allowOverwrite: true });
  });
});

describe('parseInvocation：全局旗标与命令切分', () => {
  it('全局旗标可出现在命令词之后', () => {
    const parsed = parseInvocation(['kb', 'build', '--yes', '--json', '--home', '/tmp/x']);
    expect(parsed.flags.yes).toBe(true);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.home).toBe('/tmp/x');
    expect(parsed.command?.name).toBe('kb.build');
    expect(parsed.restTokens).toEqual([]);
  });

  it('`--` 之后全部按位置参数处理（字符串型参数可携带 -- 前缀值）', () => {
    const parsed = parseInvocation(['auth', 'login', 'complete', '--', '--weird-code']);
    expect(parsed.command?.name).toBe('auth.login.complete');
    expect(parsed.restTokens).toEqual(['--', '--weird-code']);
    expect(buildCommandArgs(parsed.command!, parsed.restTokens)).toEqual({
      deviceCode: '--weird-code',
    });
    // JSON 型参数仍走解析（config set 值必须是合法 JSON，-- 不豁免）
    const cfg = parseInvocation(['config', 'set', 'aKey', '--', '"--weird"']);
    expect(buildCommandArgs(cfg.command!, cfg.restTokens)).toEqual({ path: 'aKey', value: '--weird' });
    expect(() => {
      const bad = parseInvocation(['config', 'set', 'aKey', '--', '--weird']);
      buildCommandArgs(bad.command!, bad.restTokens);
    }).toThrowError(/合法 JSON/);
  });

  it('help <command> 定向；未知命令抛 UsageError', () => {
    const helped = parseInvocation(['help', 'kb', 'build']);
    expect(helped.flags.help).toBe(true);
    expect(helped.helpTarget?.name).toBe('kb.build');
    expect(() => parseInvocation(['help', 'nope'])).toThrowError(UsageError);
    expect(() => parseInvocation(['frob', 'nicate'])).toThrowError(/未知命令/);
  });

  it('无命令词 → command null（顶层帮助路径）', () => {
    expect(parseInvocation(['--json']).command).toBeNull();
    expect(parseInvocation([]).command).toBeNull();
  });
});

describe('buildCommandArgs：类型转换与校验', () => {
  const def = (name: string) => findCommandByWords(name.split(' '))!;

  it('config set 位置参数：value 走 JSON 解析', () => {
    expect(buildCommandArgs(def('config set'), ['enableNotifications', 'true'])).toEqual({
      path: 'enableNotifications',
      value: true,
    });
    expect(buildCommandArgs(def('config set'), ['pollIntervalMinutes', '30'])).toEqual({
      path: 'pollIntervalMinutes',
      value: 30,
    });
    expect(() => buildCommandArgs(def('config set'), ['k', 'not-json'])).toThrowError(/合法 JSON/);
  });

  it('kebab 旗标 → camel 参数；number/boolean/object 转换', () => {
    expect(buildCommandArgs(def('kb builds'), ['--limit', '5'])).toEqual({ limit: 5 });
    expect(buildCommandArgs(def('kb builds'), ['--limit=7'])).toEqual({ limit: 7 });
    expect(() => buildCommandArgs(def('kb builds'), ['--limit', 'abc'])).toThrowError(/数字/);
    expect(buildCommandArgs(def('clean orphans'), ['--apply'])).toEqual({ apply: true });
    expect(buildCommandArgs(def('kb sources cleanup'), ['--sources', '[{"objToken":"t1","relPath":"a.md"}]']))
      .toEqual({ sources: [{ objToken: 't1', relPath: 'a.md' }] });
  });

  it('别名：kb build --full → mode full；auth login start --switch-account', () => {
    expect(buildCommandArgs(def('kb build'), ['--full'])).toEqual({ mode: 'full' });
    expect(buildCommandArgs(def('auth login start'), ['--switch-account'])).toEqual({ mode: 'switch_account' });
  });

  it('数组位置参数聚合（kb sources include tok…）', () => {
    expect(buildCommandArgs(def('kb sources include'), ['t1', 't2', 't3'])).toEqual({
      tokens: ['t1', 't2', 't3'],
    });
  });

  it('未知旗标 / 缺必填 / 多余位置参数 → UsageError', () => {
    expect(() => buildCommandArgs(def('status'), ['--bogus'])).toThrowError(/不认识参数/);
    expect(() => buildCommandArgs(def('auth login complete'), [])).toThrowError(/deviceCode/);
    expect(() => buildCommandArgs(def('config set'), ['a', '1', 'extra'])).toThrowError(/多余的位置参数/);
  });
});

describe('runCli 本地路径（无网络）', () => {
  it('未知命令 → 2，且 --json 输出走 stdout 包络', async () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { writes.push(s); return true; };
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { writes.push(s); return true; };
    try {
      expect(await runCli(['--json', 'frob'])).toBe(2);
      expect(await runCli(['--help'])).toBe(0);
    } finally {
      (process.stdout as unknown as { write: (s: string) => boolean }).write = origWrite;
      (process.stderr as unknown as { write: (s: string) => boolean }).write = origErr;
    }
    const jsonLine = writes.find((line) => line.includes('"ok"'));
    expect(jsonLine).toBeDefined();
    expect(JSON.parse(jsonLine!).error.code).toBe('usage_error');
  });
});
