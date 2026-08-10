import { describe, expect, it } from 'vitest';
import { findRenderableRoots } from './NodeTreeView';
import type { MappingNode } from '../types';

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
