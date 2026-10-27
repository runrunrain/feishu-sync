import { describe, expect, it } from 'vitest';
import type { MappingNode } from '../types';
import { insertionSide, reorderSiblings, siblingDropTarget } from './treeReorder';
const node = (token: string, parent: string | null = null, group = 'root'): MappingNode => ({ obj_token: token, wiki_node_token: `wiki-${token}`, parent_node_token: parent, watched_root_url: group, title: token } as MappingNode);
describe('侧栏只做同级插入', () => {
  it('展开子树命中归到同级祖先；自己的子树和其他分组不能成为落点', () => {
    const a = node('a'); const b = node('b'); const child = node('child', 'wiki-b'); const own = node('own', 'wiki-a'); const foreign = node('x', null, 'other');
    const byWiki = new Map([a,b,child,own,foreign].map((n) => [n.wiki_node_token!, n]));
    expect(siblingDropTarget(a, child, byWiki)).toBe(b);
    expect(siblingDropTarget(a, own, byWiki)).toBeNull(); expect(siblingDropTarget(a, foreign, byWiki)).toBeNull();
    expect(siblingDropTarget(child, a, byWiki)).toBeNull();
  });
  it('中线附近抖动不会反复切换；跨出滞回区域后平滑更新前后位置', () => {
    const rect = { top: 100, height: 32 };
    expect(insertionSide(115, rect)).toBe('before'); expect(insertionSide(117, rect, 'before')).toBe('before');
    expect(insertionSide(121, rect, 'before')).toBe('after'); expect(insertionSide(114, rect, 'after')).toBe('after');
    expect(insertionSide(110, rect, 'after')).toBe('before');
  });
  it('只写顺序清单，不改变父级/分组；无变化不请求，过滤时保留隐藏兄弟', () => {
    const all = [node('a'), node('b'), node('c'), node('other', null, 'else')]; const original = structuredClone(all);
    expect(reorderSiblings(all, all[0], all[2], 'after')).toEqual(['b','c','a']);
    expect(reorderSiblings(all, all[0], all[1], 'before')).toBeNull();
    expect(reorderSiblings(all, all[0], all[3], 'after')).toBeNull(); expect(all).toEqual(original);
  });
});
