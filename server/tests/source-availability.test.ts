import { describe, expect, it } from 'vitest';
import { isPermissionDeniedSourcePlaceholder } from '../src/kb/source-availability.js';

describe('permission denied source placeholder', () => {
  it('recognizes the generated Feishu 40403 placeholder', () => {
    expect(isPermissionDeniedSourcePlaceholder(`# 200-战斗数值框架\n\n> **注意**: 该文档在飞书侧权限受限（当前账号无访问权限，API 返回 40403 no permission），无法获取内容。\n\n> 如需查阅，请在飞书中向文档所有者申请权限后重新获取。`)).toBe(true);
  });

  it('does not flag an ordinary discussion of a permission error', () => {
    expect(isPermissionDeniedSourcePlaceholder('本文讨论 40403 no permission 的处理；请向文档所有者申请权限。')).toBe(false);
  });
});
