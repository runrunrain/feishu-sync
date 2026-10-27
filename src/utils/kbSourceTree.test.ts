import { describe, expect, it } from 'vitest';
import { sourceTreeRows, subtreeTokens } from './kbSourceTree';
import type { KbSourceTreeNode } from '../types/kb-version';
const doc = (id: string, included: boolean, children: KbSourceTreeNode[] = []): KbSourceTreeNode => ({ id, title: id, children, source: { objToken: id, title: id, relPath: `${id}.md`, included, published: false, pending: 'added' } });
const roots = [{ id: 'folder', title: '规则', children: [doc('父文档', true, [doc('子文档', false, [doc('孙文档', true)])]), doc('其他', false)] }];
describe('源文档树批量选择', () => {
  it('全选覆盖收起的下级，父复选框汇总整个子树形成混合状态', () => {
    const view = sourceTreeRows(roots, '', new Set(['父文档']));
    expect(view.rows.map((r) => r.node.id)).toEqual(['folder', '父文档', '其他']);
    expect(view.targets).toEqual(['父文档', '子文档', '孙文档', '其他']);
    expect(view.stats.get('父文档')).toEqual({ total: 3, included: 2 });
    expect(subtreeTokens([roots[0].children[0]])).toHaveLength(3);
  });
  it('搜索父文档包含子树；搜索子文档保留祖先但批量操作不改祖先自身或兄弟', () => {
    const child = sourceTreeRows(roots, '子文档', new Set(['folder']));
    expect(child.rows.map((r) => r.node.id)).toEqual(['folder', '父文档', '子文档', '孙文档']);
    expect(child.targets).toEqual(['子文档', '孙文档']);
    expect(sourceTreeRows(roots, '规则', new Set()).targets).toHaveLength(4);
    expect(sourceTreeRows(roots, '不存在', new Set()).rows).toEqual([]);
  });
  it('大文档量不受旧分页50条限制', () => {
    const nodes = Array.from({ length: 1200 }, (_, i) => doc(`文档${i}`, true));
    expect(sourceTreeRows(nodes, '', new Set()).targets).toHaveLength(1200);
    expect(subtreeTokens(nodes)).toHaveLength(1200);
  });
});
