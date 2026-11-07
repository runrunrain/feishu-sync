/**
 * CLI 拼写建议（C 项）：未知命令/未知旗标给出「你是不是想输入」候选。
 */

import { describe, expect, it } from 'vitest';
import { findOpsCommand } from '../src/ops/command-table.js';
import { buildCommandArgs, parseInvocation, UsageError } from '../src/cli/args.js';
import { levenshtein, suggestClosest } from '../src/cli/suggest.js';

describe('suggestClosest 纯函数', () => {
  it('编辑距离与排序基础', () => {
    expect(levenshtein('kb bulds', 'kb builds')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('前缀命中排最前，最多 3 条', () => {
    const got = suggestClosest('kb b', ['kb build', 'kb builds', 'kb cancel', 'status']);
    expect(got[0]).toBe('kb build');
    expect(got.length).toBeLessThanOrEqual(3);
    expect(got).not.toContain('status');
  });

  it('无相近候选返回空（宁缺毋滥）', () => {
    expect(suggestClosest('frob', ['status', 'config get'])).toEqual([]);
  });
});

describe('未知命令建议（parseInvocation）', () => {
  it('kb bulds → 建议 kb builds', () => {
    try {
      parseInvocation(['kb', 'bulds']);
      expect.unreachable('应抛 UsageError');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain('未知命令 kb bulds');
      expect((error as UsageError).message).toContain('你是不是想输入：kb builds');
    }
  });

  it('完全不相近的词不给建议（保留 --help 提示）', () => {
    expect(() => parseInvocation(['frob', 'nicate'])).toThrowError(/未知命令 frob nicate（--help/);
  });

  it('help <拼错目标> 同样给建议', () => {
    expect(() => parseInvocation(['help', 'kb', 'buld'])).toThrowError(/你是不是想输入：kb build/);
  });

  it('前缀截词建议：kb bui → kb builds（前缀规则）', () => {
    try {
      parseInvocation(['kb', 'bui', 'x']);
      expect.unreachable('应抛 UsageError');
    } catch (error) {
      expect((error as UsageError).message).toContain('kb build');
    }
  });
});

describe('未知旗标建议（buildCommandArgs）', () => {
  it('--limt → 建议 --limit（kb builds）', () => {
    const def = findOpsCommand('kb.builds')!;
    try {
      buildCommandArgs(def, ['--limt', '5']);
      expect.unreachable('应抛 UsageError');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain('--limt');
      expect((error as UsageError).message).toContain('--limit');
    }
  });

  it('别名旗标参与候选：kb build --ful → 建议 --full', () => {
    const def = findOpsCommand('kb.build')!;
    try {
      buildCommandArgs(def, ['--ful']);
      expect.unreachable('应抛 UsageError');
    } catch (error) {
      expect((error as UsageError).message).toContain('--full');
    }
  });

  it('无相近参数时保留原提示（status --bogus）', () => {
    const def = findOpsCommand('status')!;
    expect(() => buildCommandArgs(def, ['--bogus'])).toThrowError(/不认识参数 --bogus（help status 查看参数）/);
  });
});
