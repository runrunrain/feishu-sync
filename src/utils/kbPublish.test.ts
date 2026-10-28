/**
 * kbPublish 纯函数层测试（P1-S9）——状态/动作/警告/门控文案与派生计算。
 */

import { describe, expect, it } from 'vitest';
import {
  countExecutableItems,
  describePublishGates,
  describePublishWarning,
  flattenDocPaths,
  publishStateMeta,
  publishTargetKindLabel,
  PUBLISH_ACTION_LABEL,
  TREE_BADGE_STATES,
} from './kbPublish';
import type { KbPublishGates } from '../types/kb-publish';

describe('publishStateMeta', () => {
  it('任务书四态均有可读标签与视觉色调', () => {
    expect(publishStateMeta('published')).toMatchObject({ label: '已发布', tone: 'success' });
    expect(publishStateMeta('published_with_warnings').tone).toBe('warning');
    expect(publishStateMeta('conflict').tone).toBe('error');
    expect(publishStateMeta('unknown').tone).toBe('warning');
    for (const state of TREE_BADGE_STATES) {
      expect(publishStateMeta(state).label.length).toBeGreaterThan(0);
      expect(publishStateMeta(state).short.length).toBeGreaterThan(0);
    }
  });

  it('全状态机覆盖（8 态）+ 未知字符串回退「状态未知」', () => {
    for (const state of [
      'creating', 'published', 'published_with_warnings', 'conflict',
      'failed', 'unknown', 'kb_removed', 'cloud_missing',
    ]) {
      expect(publishStateMeta(state).label.length).toBeGreaterThan(0);
    }
    expect(publishStateMeta('garbage').label).toBe('状态未知');
    expect(publishStateMeta('garbage').tone).toBe('warning');
  });
});

describe('describePublishGates', () => {
  const base: KbPublishGates = {
    feishuWriteEnabled: true,
    writeScopesGranted: true,
    missingScopes: [],
    publishEnabled: true,
    targetConfigured: true,
  };

  it('门全开 → 无问题', () => {
    expect(describePublishGates(base)).toEqual([]);
  });

  it('每个关闭的门对应一条可读问题（含去向）', () => {
    const problems = describePublishGates({
      ...base,
      publishEnabled: false,
      feishuWriteEnabled: false,
      writeScopesGranted: false,
      missingScopes: ['docx:document:write_only'],
      targetConfigured: false,
    });
    expect(problems).toHaveLength(4);
    expect(problems.some((p) => p.includes('反向发布未开启'))).toBe(true);
    expect(problems.some((p) => p.includes('飞书写入未开启'))).toBe(true);
    expect(problems.some((p) => p.includes('docx:document:write_only'))).toBe(true);
    expect(problems.some((p) => p.includes('发布根未配置'))).toBe(true);
  });
});

describe('describePublishWarning', () => {
  it('服务端 text 优先；缺失时按 code 兜底；带 target 归因', () => {
    expect(describePublishWarning({ code: 'image_not_published', kbPath: 'a.md', text: '自定义文案' })).toBe('自定义文案');
    expect(describePublishWarning({ code: 'image_not_published', kbPath: 'a.md' })).toContain('图片');
    const withTarget = describePublishWarning({ code: 'link_target_unpublished', kbPath: 'a.md', target: 'b.md' });
    expect(withTarget).toContain('b.md');
  });
});

describe('计划派生计算', () => {
  it('countExecutableItems 只计 create/update', () => {
    expect(countExecutableItems([
      { action: 'create' }, { action: 'update' }, { action: 'skip_unchanged' }, { action: 'blocked' },
    ])).toBe(2);
  });

  it('flattenDocPaths 深度优先展开文档路径（目录不入列）', () => {
    const nodes = [
      { path: 'a', type: 'dir', children: [{ path: 'a/x.md', type: 'doc' }, { path: 'a/b', type: 'dir', children: [{ path: 'a/b/y.md', type: 'doc' }] }] },
      { path: 'z.md', type: 'doc' },
    ];
    expect(flattenDocPaths(nodes)).toEqual(['a/x.md', 'a/b/y.md', 'z.md']);
  });

  it('动作与阻断原因文案完备', () => {
    expect(Object.keys(PUBLISH_ACTION_LABEL)).toEqual(['create', 'update', 'skip_unchanged', 'blocked']);
  });
});

describe('publishTargetKindLabel', () => {
  it('两种发布根形态', () => {
    expect(publishTargetKindLabel('drive_folder')).toBe('Drive 文件夹');
    expect(publishTargetKindLabel('wiki_node')).toBe('知识库节点');
  });
});
