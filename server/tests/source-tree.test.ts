import { describe, expect, it } from 'vitest';
import { buildSourceTree } from '../src/kb/source-tree.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { KbSourceChoice } from '../src/types/kb-version.js';
const record = (token: string, parent?: string): DocumentRecord => ({ objToken: token, wikiNodeToken: `wiki-${token}`, parentNodeToken: parent, objType: 'docx', title: token, localRelPath: `${token}.md`, lastSyncedAt: '', lastSyncedModifyTime: '', status: 'synced' });
const choice = (token: string, relPath = `${token}.md`): KbSourceChoice => ({ objToken: token, title: token, relPath, included: true, published: false, pending: 'added' });
describe('源树优先真实wiki层级', () => {
  it('平铺存储的父/子/孙仍按wiki父链关联，并保留未同步的上级', () => {
    const tree = buildSourceTree([record('root'), record('a', 'wiki-root'), record('b', 'wiki-a')], [choice('a'), choice('b')]);
    expect(tree).toHaveLength(1); expect(tree[0].source).toBeUndefined();
    expect(tree[0].children[0].source?.objToken).toBe('a');
    expect(tree[0].children[0].children[0].source?.objToken).toBe('b');
  });
  it('缺少父链时按本地目录分组；历史缺失源仍可管理', () => {
    const tree = buildSourceTree([], [choice('a', '战斗/行动/a.md'), choice('b', '战斗/b.md')]);
    expect(tree).toHaveLength(1); expect(tree[0].title).toBe('战斗');
    expect(tree[0].children).toHaveLength(2);
  });
  it('错误循环父链不会形成循环树或丢失源', () => {
    const tree = buildSourceTree([record('a', 'wiki-b'), record('b', 'wiki-a')], [choice('a'), choice('b')]);
    expect(JSON.parse(JSON.stringify(tree))).toHaveLength(2);
    expect(tree.map((node) => node.source?.objToken)).toEqual(['a', 'b']);
  });
});
