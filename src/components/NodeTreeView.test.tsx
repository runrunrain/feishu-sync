import { describe, expect, it } from 'vitest';
import { findRenderableRoots } from './NodeTreeView';
import { recoverDisplayHierarchy } from '../utils/displayHierarchy';
import type { MappingNode } from '../types';
import { renderToStaticMarkup } from 'react-dom/server';
import { TreeNode } from './TreeNode';

function makeNode(overrides: Partial<MappingNode>): MappingNode {
  return {
    obj_token: 'node',
    wiki_node_token: 'wiki-node',
    space_id: null,
    obj_type: 'docx',
    title: '节点',
    local_path: '',
    parent_node_token: null,
    has_child: false,
    obj_edit_time: null,
    last_synced_modify_time: '',
    last_synced_at: '',
    last_seen_at: null,
    status: 'synced',
    cloud_deleted: 0,
    sortOrder: null,
    original_link: null,
    cloud_match: 'synced',
    ...overrides,
  };
}

describe('findRenderableRoots', () => {
  it('keeps a watched-root body visible when its parent sits outside the returned subtree', () => {
    const externalRoot = makeNode({
      obj_token: 'external-root',
      wiki_node_token: 'root-wiki',
      parent_node_token: 'parent-outside-this-watched-root',
      title: '独立 watched root',
      has_child: true,
    });
    const child = makeNode({
      obj_token: 'child',
      wiki_node_token: 'child-wiki',
      parent_node_token: 'root-wiki',
      title: '子节点',
    });
    const regularRoot = makeNode({
      obj_token: 'regular-root',
      wiki_node_token: 'regular-wiki',
      parent_node_token: null,
      title: '普通根节点',
    });

    expect(findRenderableRoots([externalRoot, child, regularRoot]).map((node) => node.obj_token))
      .toEqual(['external-root', 'regular-root']);
  });
});

it('uses a local folder only for display when the cloud parent is unavailable', () => {
  const rootUrl = 'https://example.feishu.cn/wiki/root';
  const parent = makeNode({ obj_token: 'parent', wiki_node_token: 'parent-wiki', title: '部队',
    local_path: '/kb/部队.md', watched_root_url: rootUrl });
  const child = makeNode({ obj_token: 'child', wiki_node_token: 'child-wiki', title: '数据',
    local_path: '/kb/部队/数据.md', watched_root_url: rootUrl });
  const alreadyKnown = makeNode({ obj_token: 'known', wiki_node_token: 'known-wiki', title: '原云端父级',
    local_path: '/kb/部队/已知.md', parent_node_token: 'different-cloud-parent', watched_root_url: rootUrl });
  const projection = recoverDisplayHierarchy([parent, child, alreadyKnown]);
  expect(projection.nodes[1].parent_node_token).toBe('parent-wiki');
  expect(projection.inferred.has('child')).toBe(true);
  expect(projection.nodes[2].parent_node_token).toBe('different-cloud-parent');
  expect(child.parent_node_token).toBeNull();
});

it('can place a permission-lost local document without a wiki token', () => {
  const rootUrl = 'https://example.feishu.cn/wiki/root';
  const parent = makeNode({ obj_token: 'parent', wiki_node_token: 'parent-wiki',
    local_path: '/kb/框架.md', watched_root_url: rootUrl });
  const child = makeNode({ obj_token: 'lost', wiki_node_token: null, sync_state: 'restricted',
    local_path: '/kb/框架/旧文档.md', watched_root_url: rootUrl });
  const display = recoverDisplayHierarchy([parent, child]);
  expect(display.nodes[1].parent_node_token).toBe('parent-wiki');
  expect(findRenderableRoots(display.nodes).map((node) => node.obj_token)).toEqual(['parent']);
});

it('在节点树中标记本地保留但暂无云文档访问权限的文档', () => {
  const html = renderToStaticMarkup(<TreeNode node={makeNode({ title: '保留文档', sync_state: 'restricted', local_path: '/kb/local.md' })}
    level={0} expanded={false} selected={false} hasChildren={false} onToggle={() => {}} onSelect={() => {}}
    onDragStart={() => {}} onDragOver={() => {}} onDragLeave={() => {}} onDrop={() => {}} onDragEnd={() => {}} />);
  expect(html).toContain('保留文档');
  expect(html).toContain('暂无云文档访问权限');
});
