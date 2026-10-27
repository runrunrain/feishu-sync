import { describe, expect, it } from 'vitest';
import { selectPublishedDoc } from './KnowledgeView';
import type { KbTreeNode } from '../types/agent';

const tree: KbTreeNode[] = [{ name: '系统', path: '系统', type: 'dir', children: [
  { name: '新文档.md', path: '系统/新文档.md', type: 'doc', docId: 'new-id' },
  { name: '保留.md', path: '系统/保留.md', type: 'doc', docId: 'retained-id' },
] }];

describe('发布后阅读选择不能混用旧release', () => {
  it('旧docId被移除时选择新树首篇，不保留旧正文的锚点', () => {
    expect(selectPublishedDoc(tree, 'removed-id')).toBe('new-id');
  });
  it('保留仍存在的选择；正文加载另以releaseId为依赖重新读取', () => {
    expect(selectPublishedDoc(tree, 'retained-id')).toBe('retained-id');
  });
  it('首次发布与空树都有确定选择', () => {
    expect(selectPublishedDoc(tree, null)).toBe('new-id');
    expect(selectPublishedDoc([], 'old-id')).toBeNull();
  });
});
