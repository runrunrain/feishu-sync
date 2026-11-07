/**
 * CLI 位置参数（B 项）：显式登记优先、required 自动推导、位置/旗标冲突。
 */

import { describe, expect, it } from 'vitest';
import { findOpsCommand } from '../src/ops/command-table.js';
import { buildCommandArgs, commandFlagNames, positionalPlanFor, UsageError } from '../src/cli/args.js';

describe('显式登记（新增三条）', () => {
  it('kb builds 20 → limit=20（number 转换）', () => {
    expect(buildCommandArgs(findOpsCommand('kb.builds')!, ['20'])).toEqual({ limit: 20 });
  });

  it('cloud moves doxcnABC → objToken；可缺省', () => {
    expect(buildCommandArgs(findOpsCommand('cloud.moves')!, ['doxcnABC'])).toEqual({ objToken: 'doxcnABC' });
    expect(buildCommandArgs(findOpsCommand('cloud.moves')!, ['doxcnABC', '--limit', '10'])).toEqual({ objToken: 'doxcnABC', limit: 10 });
    expect(buildCommandArgs(findOpsCommand('cloud.moves')!, [])).toEqual({});
  });

  it('cloud move_status mv_1 → moveId；缺失走表内必填校验', () => {
    expect(buildCommandArgs(findOpsCommand('cloud.move_status')!, ['mv_1'])).toEqual({ moveId: 'mv_1' });
    expect(() => buildCommandArgs(findOpsCommand('cloud.move_status')!, [])).toThrowError(/moveId/);
  });
});

describe('位置参数与同名旗标冲突', () => {
  it('kb builds 20 --limit 5 → 明确冲突错误，不静默覆盖', () => {
    try {
      buildCommandArgs(findOpsCommand('kb.builds')!, ['20', '--limit', '5']);
      expect.unreachable('应抛冲突错误');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain('limit');
      expect((error as UsageError).message).toContain('--limit');
      expect((error as UsageError).message).toContain('同时');
    }
  });

  it('尾位 array 位置参数与 --旗标 同样冲突（kb sources include）', () => {
    expect(() => buildCommandArgs(findOpsCommand('kb.sources.include')!, ['t1', '--tokens', '["t2"]']))
      .toThrowError(/tokens.*同时|同时.*tokens/);
  });
});

describe('自动推导（未登记命令）', () => {
  it('kb sources cleanup：required sources 自动成为尾位位置参数', () => {
    const def = findOpsCommand('kb.sources.cleanup')!;
    expect(positionalPlanFor(def)).toEqual(['sources']);
    // 沿用既有尾位规则：多个位置 token 全量收集（元素保持原始字符串）
    expect(buildCommandArgs(def, ['a', 'b'])).toEqual({ sources: ['a', 'b'] });
    // 旗标 JSON 形态不受影响
    expect(buildCommandArgs(def, ['--sources', '[{"objToken":"t1","relPath":"a.md"}]']))
      .toEqual({ sources: [{ objToken: 't1', relPath: 'a.md' }] });
  });

  it('显式登记优先于自动推导：source.edit 只登记 objToken（baseHash 保持旗标）', () => {
    const def = findOpsCommand('source.edit')!;
    expect(positionalPlanFor(def)).toEqual(['objToken']);
    expect(buildCommandArgs(def, ['tok', '--base-hash', 'h', '--new-text', 'x']))
      .toEqual({ objToken: 'tok', baseHash: 'h', newText: 'x' });
  });

  it('无 required 的命令不推导位置参数（多余位置 token 仍报错）', () => {
    const def = findOpsCommand('status')!;
    expect(positionalPlanFor(def)).toEqual([]);
    expect(() => buildCommandArgs(def, ['junk'])).toThrowError(/多余的位置参数/);
  });
});

describe('旗标名清单（帮助/补全共用）', () => {
  it('kb.build 含别名 full 与全部 kebab 参数（裸名）', () => {
    expect(commandFlagNames(findOpsCommand('kb.build')!)).toEqual(['full', 'mode', 'rebuild-selected', 'refresh-images']);
  });
});
