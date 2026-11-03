import { describe, expect, it } from 'vitest';
import { buildSourceTree } from '../src/kb/source-tree.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { KbSourceChoice, KbSourceTreeNode } from '../src/types/kb-version.js';

function doc(objToken: string, title: string, wikiNodeToken: string, parentNodeToken: string | null, localRelPath: string): DocumentRecord {
  return { objToken, title, wikiNodeToken, parentNodeToken, localRelPath, objType: 'docx',
    localMdPath: localRelPath, lastSyncedModifyTime: '', lastSyncedAt: '', status: 'synced' };
}

function choice(record: DocumentRecord): KbSourceChoice {
  return { objToken: record.objToken, title: record.title, relPath: record.localRelPath!,
    included: false, published: false, pending: 'added' };
}

function find(nodes: KbSourceTreeNode[], token: string): KbSourceTreeNode | undefined {
  const queue = [...nodes];
  while (queue.length) {
    const node = queue.shift()!;
    if (node.source?.objToken === token) return node;
    queue.push(...node.children);
  }
  return undefined;
}

describe('source tree parent path reconciliation', () => {
  it('ignores a stale wiki parent that would pull a sibling 200-03 source under 200-04 troop', () => {
    const root = doc('root', '200', 'wiki-root', null, '策划/200/200.md');
    const troop = doc('troop', 'Troop', 'wiki-troop', 'wiki-root', '策划/200/04/Troop/Troop.md');
    const life = doc('life', '03', 'wiki-life', 'wiki-troop', '策划/200/03/03.md');
    const tree = buildSourceTree([root, troop, life], [root, troop, life].map(choice));
    expect(find(tree, 'root')).toBeTruthy();
    expect(find(tree, 'troop')).toBeTruthy();
    expect(find(tree, 'life')).toBeTruthy();
    expect(find(tree, 'troop')!.children.some((node) => node.source?.objToken === 'life')).toBe(false);
    expect(find(tree, 'root')!.children.some((node) => node.source?.objToken === 'life')).toBe(true);
  });
});
