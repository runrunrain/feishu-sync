import { describe, expect, it } from 'vitest';
import { buildSourceTree } from '../src/kb/source-tree.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { KbSourceChoice, KbSourceTreeNode } from '../src/types/kb-version.js';
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

function tokensIn(tree: KbSourceTreeNode[]): string[] {
  const result: string[] = [];
  const pending = [...tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.source) result.push(node.source.objToken);
    pending.push(...node.children);
  }
  return result.sort();
}

describe('本地目录与真实文档节点合并', () => {
  it('断开的父链使用同一路径归位，并保留父文档、子文档与选择状态', () => {
    const docs: DocumentRecord[] = [
      { ...record('root'), title: '策划', localRelPath: '策划/策划.md' },
      { ...record('system', 'missing-root'), title: '200-系统', localRelPath: '策划/200-系统/200-系统.md' },
      { ...record('battle', 'wiki-system'), title: '200-04-战斗', localRelPath: '策划/200-系统/200-04-战斗/200-04-战斗.md' },
      { ...record('linked', 'wiki-battle'), title: '云端子文档', localRelPath: '策划/200-系统/200-04-战斗/云端子文档.md' },
      { ...record('orphan'), wikiNodeToken: null, title: '历史本地文档', localRelPath: '策划/200-系统/200-04-战斗/历史本地文档.md' },
      { ...record('narrative'), wikiNodeToken: null, title: '叙事文档', localRelPath: '策划/200-系统/200-06-叙事/叙事文档.md' },
    ];
    const choices = docs.map((doc) => ({ ...choice(doc.objToken, doc.localRelPath!), title: doc.title, included: doc.objToken !== 'orphan' }));
    const tree = buildSourceTree(docs, choices);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ title: '策划', source: { objToken: 'root' } });
    expect(tree[0].children).toHaveLength(1);
    const system = tree[0].children[0];
    expect(system).toMatchObject({ title: '200-系统', source: { objToken: 'system' } });
    expect(system.children.map((node) => node.title)).toEqual(['200-04-战斗', '200-06-叙事']);
    const battle = system.children[0];
    expect(battle.source?.objToken).toBe('battle');
    expect(battle.children.map((node) => node.source?.objToken).sort()).toEqual(['linked', 'orphan']);
    expect(battle.children.find((node) => node.source?.objToken === 'orphan')?.source?.included).toBe(false);
    expect(system.children[1].children[0].source?.objToken).toBe('narrative');
    expect(tokensIn(tree)).toEqual(docs.map((doc) => doc.objToken).sort());
  });

  it('父文档与同名目录并列时也可合并', () => {
    const parent = { ...record('parent'), title: '规则', localRelPath: '策划/规则.md' };
    const child = { ...record('child'), wikiNodeToken: null, title: '本地子文档', localRelPath: '策划/规则/子.md' };
    const tree = buildSourceTree([parent, child], [
      { ...choice('parent', parent.localRelPath!), title: parent.title },
      { ...choice('child', child.localRelPath!), title: child.title },
    ]);
    expect(tree[0].title).toBe('策划');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0]).toMatchObject({ source: { objToken: 'parent' }, children: [{ source: { objToken: 'child' } }] });
  });

  it('多个文档指向同一路径时保留独立节点，不猜测归属', () => {
    const tree = buildSourceTree([], [choice('a', '策划/系统/系统.md'), choice('b', '策划/系统/系统.md'), choice('c', '策划/系统/子.md')]);
    const folder = tree[0].children[0];
    expect(folder.title).toBe('系统');
    expect(folder.source).toBeUndefined();
    expect(tokensIn(tree)).toEqual(['a', 'b', 'c']);
    expect(folder.children).toHaveLength(3);
  });

  it('不同飞书父链下的同路径目录不会跨分支合并', () => {
    const root = { ...record('root'), title: '其他分支', localRelPath: '策划/其他/其他.md' };
    const child = { ...record('system', 'wiki-root'), title: '系统', localRelPath: '策划/系统/系统.md' };
    const local = { ...record('local'), wikiNodeToken: null, title: '本地文档', localRelPath: '策划/系统/本地.md' };
    const tree = buildSourceTree([root, child, local], [root, child, local].map((doc) => ({ ...choice(doc.objToken, doc.localRelPath!), title: doc.title })));
    expect(tree[0].title).toBe('策划');
    const other = tree[0].children.find((node) => node.source?.objToken === 'root')!;
    const folder = tree[0].children.find((node) => node.title === '系统' && !node.source)!;
    expect(other.children[0].source?.objToken).toBe('system');
    expect(folder.children[0].source?.objToken).toBe('local');
    expect(tokensIn(tree)).toEqual(['local', 'root', 'system']);
  });
});
