/**
 * P2-S8（设计 §4.3/U50）：cloudObjType 提示文案单元测试。
 * 契约：mindnote/file 用设计 §4.2 文案；其他真实类型显示通用文案；
 * 空/undefined（已支持类型、真实类型不可得）返回 null 不渲染。
 */
import { describe, expect, it } from 'vitest';
import {
  unsupportedCloudTypeHint,
  unsupportedCloudTypeText,
} from './cloudObjType';

describe('unsupportedCloudTypeHint', () => {
  it('mindnote → 设计文案（思维笔记暂不支持同步）', () => {
    expect(unsupportedCloudTypeHint('mindnote'))
      .toBe('思维笔记暂不支持同步，可在飞书中导出为文档后纳入');
  });

  it('file → 设计文案（云空间文件暂不支持）', () => {
    expect(unsupportedCloudTypeHint('file')).toBe('云空间文件暂不支持同步');
  });

  it('其他真实类型与空值 → null（无专属文案，不额外渲染）', () => {
    expect(unsupportedCloudTypeHint('wiki')).toBeNull();
    expect(unsupportedCloudTypeHint('')).toBeNull();
    expect(unsupportedCloudTypeHint(null)).toBeNull();
    expect(unsupportedCloudTypeHint(undefined)).toBeNull();
  });
});

describe('unsupportedCloudTypeText', () => {
  it('带专属提示的类型拼完整句：不支持同步的类型：<type>（提示）', () => {
    expect(unsupportedCloudTypeText('mindnote'))
      .toBe('不支持同步的类型：mindnote（思维笔记暂不支持同步，可在飞书中导出为文档后纳入）');
    expect(unsupportedCloudTypeText('file'))
      .toBe('不支持同步的类型：file（云空间文件暂不支持同步）');
  });

  it('无专属提示的类型回退通用文案', () => {
    expect(unsupportedCloudTypeText('some_new_type'))
      .toBe('不支持同步的类型：some_new_type');
  });

  it('空值返回 null——已支持类型不带该字段，渲染行为不变', () => {
    expect(unsupportedCloudTypeText(undefined)).toBeNull();
    expect(unsupportedCloudTypeText('  ')).toBeNull();
  });
});
