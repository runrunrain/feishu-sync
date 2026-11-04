import { describe, expect, it } from 'vitest';
import { isPermissionDeniedSourcePlaceholder, isUnresolvedSyncedReferencePlaceholder } from '../src/kb/source-availability.js';

describe('permission denied source placeholder', () => {
  it('recognizes the generated Feishu 40403 placeholder', () => {
    expect(isPermissionDeniedSourcePlaceholder(`# 200-战斗数值框架\n\n> **注意**: 该文档在飞书侧权限受限（当前账号无访问权限，API 返回 40403 no permission），无法获取内容。\n\n> 如需查阅，请在飞书中向文档所有者申请权限后重新获取。`)).toBe(true);
  });

  it('does not flag an ordinary discussion of a permission error', () => {
    expect(isPermissionDeniedSourcePlaceholder('本文讨论 40403 no permission 的处理；请向文档所有者申请权限。')).toBe(false);
  });
});

describe('unresolved synced reference placeholder', () => {
  const shell = '<!--\nfeishu_sync:\n  obj_type: "docx"\n-->\n# 300-【概述】治理风格系统（T）\n\n引用200的设计\n\n<synced_reference src-block-id="block" src-token="source"></synced_reference>\n';

  it('recognizes a source containing only a reference to another design', () => {
    expect(isUnresolvedSyncedReferencePlaceholder(shell)).toBe(true);
  });

  it('keeps sources with substantive text, images, or expanded references available', () => {
    expect(isUnresolvedSyncedReferencePlaceholder(`${shell}\n治理风格由三类数值组成。`)).toBe(false);
    expect(isUnresolvedSyncedReferencePlaceholder(`${shell}\n![结构图](diagram.png)`)).toBe(false);
    expect(isUnresolvedSyncedReferencePlaceholder(shell.replace('></synced_reference>', '>规则正文</synced_reference>'))).toBe(false);
    expect(isUnresolvedSyncedReferencePlaceholder(shell.replace('引用200的设计', '治理风格的计算规则'))).toBe(false);
  });
});
