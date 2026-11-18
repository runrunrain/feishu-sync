import { describe, expect, it } from 'vitest';
import { findRenderableRoots, groupRootsByWatchedRoot, NodeTreeView } from './NodeTreeView';
import { recoverDisplayHierarchy } from '../utils/displayHierarchy';
import type { MappingNode, WatchedRoot } from '../types';
import { renderToStaticMarkup } from 'react-dom/server';
import { TreeNode } from './TreeNode';
import { ToastProvider } from './common/Toast';

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

function makeWatchedRoot(overrides: Partial<WatchedRoot>): WatchedRoot {
  return {
    url: 'https://example.feishu.cn/wiki/root',
    nodeToken: 'root',
    title: '根目录',
    displayName: '根目录',
    localDir: '根目录',
    trackMode: 'tracked',
    status: 'synced',
    lastDetectedAt: null,
    childCount: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// dashboard-root-missing 纵深防御（2026-11）：未匹配配置 URL 的非空 bucket
// 不再静默消失；配置根无成员时组头常驻 + 空态提示。
// ---------------------------------------------------------------------------
describe('groupRootsByWatchedRoot（dashboard-root-missing 纵深防御）', () => {
  const configuredUrl = 'https://example.feishu.cn/wiki/root';

  it('未匹配任何配置 URL 的非空 bucket 节点进入「未分类」而不是消失', () => {
    const watchedRoots = [makeWatchedRoot({})];
    const variant = makeNode({
      obj_token: 'variant',
      wiki_node_token: 'variant-node',
      watched_root_url: `${configuredUrl}?from=from_copylink`,
    });
    const hostVariant = makeNode({
      obj_token: 'host-variant',
      wiki_node_token: 'host-variant-node',
      watched_root_url: configuredUrl.replace('example.', 'other-tenant.'),
    });
    const nullUrl = makeNode({ obj_token: 'nourl', wiki_node_token: 'nourl-node', watched_root_url: null });

    const grouped = groupRootsByWatchedRoot([variant, hostVariant, nullUrl], watchedRoots, { childrenByParent: new Map() } as never);

    expect(grouped).not.toBeNull();
    // 未匹配配置 URL 的节点与 NULL URL 一致：并入未分类，不丢数据
    expect(grouped!.unclassified.map((n) => n.obj_token)).toEqual(['variant', 'host-variant', 'nourl']);
    expect(grouped!.groups[0].nodes).toEqual([]);
  });

  it('配置根无成员节点时保留分组（组头常驻，displayNodes 为空）', () => {
    const watchedRoots = [makeWatchedRoot({}), makeWatchedRoot({ url: 'https://example.feishu.cn/wiki/rootB', nodeToken: 'rootB', displayName: '根 B', localDir: '根B', title: '根 B' })];

    const grouped = groupRootsByWatchedRoot([], watchedRoots, { childrenByParent: new Map() } as never);

    expect(grouped!.groups).toHaveLength(2);
    expect(grouped!.groups.every((g) => g.displayNodes.length === 0)).toBe(true);
    expect(grouped!.unclassified).toEqual([]);
  });

  it('匹配配置 URL 的节点仍按根分组，根层级折叠行为不变', () => {
    const watchedRoots = [makeWatchedRoot({})];
    const rootNode = makeNode({
      obj_token: 'root-doc', wiki_node_token: 'root', watched_root_url: configuredUrl, has_child: true,
    });
    const child = makeNode({
      obj_token: 'child', wiki_node_token: 'child-node', parent_node_token: 'root', watched_root_url: configuredUrl,
    });
    const tree = { childrenByParent: new Map([['root', [child]]]) } as never;

    // 真实组件传入的是 findRenderableRoots 结果（子节点不在顶层集合内）
    const grouped = groupRootsByWatchedRoot([rootNode], watchedRoots, tree);

    // 根节点自身有子节点 → 分组内提升子节点为顶层（2026-08 需求保持）
    expect(grouped!.groups[0].nodes.map((n) => n.obj_token)).toEqual(['root-doc']);
    expect(grouped!.groups[0].displayNodes.map((n) => n.obj_token)).toEqual(['child']);
  });

  it('有分组标题时首行缩进一级，无分组时保持顶层缩进', () => {
    const node = makeNode({ obj_token: 'entry', watched_root_url: configuredUrl });
    const render = (watchedRoots?: WatchedRoot[]) => renderToStaticMarkup(
      <ToastProvider>
        <NodeTreeView nodes={[node]} selectedToken={null} onSelect={() => {}} watchedRoots={watchedRoots} />
      </ToastProvider>,
    );

    expect(render([makeWatchedRoot({})])).toMatch(/data-node-token="entry"[^>]*style="padding-left:16px"/);
    expect(render()).toMatch(/data-node-token="entry"[^>]*style="padding-left:8px"/);
  });

  it('空配置根渲染组头与空态提示行，未知 URL 节点落入未分类（静态标记渲染）', () => {
    const watchedRoots = [makeWatchedRoot({ displayName: '策划根目录' })];
    const loose = makeNode({
      obj_token: 'loose', wiki_node_token: 'loose-node', title: '散档顶层节点',
      watched_root_url: 'https://other.feishu.cn/wiki/other-root',
    });

    const html = renderToStaticMarkup(
      <ToastProvider>
        <NodeTreeView nodes={[loose]} selectedToken={null} onSelect={() => {}} watchedRoots={watchedRoots} />
      </ToastProvider>,
    );

    // 空配置根：组头仍在 + 空态提示
    expect(html).toContain('策划根目录');
    expect(html).toContain('尚无文档（未检测或未同步）');
    // 未知 URL 非空 bucket：节点进入未分类，不再消失
    expect(html).toContain('未分类');
    expect(html).toContain('散档顶层节点');
  });
});

// ---------------------------------------------------------------------------
// Review F01 (2026-11)：全空数据集（nodes=[]、无归档）+ 配置根存在时，不得
// 走全局「知识库尚未索引」空态——首次安装已配置根但未检测正是新用户场景，
// 应渲染根组头与空态提示。仅无配置根时保留全局空态。
// ---------------------------------------------------------------------------
describe('NodeTreeView 全空数据集与配置根（review F01）', () => {
  it('nodes=[] + 配置根存在：渲染根组头与「尚无文档」提示，不走全局空态', () => {
    const watchedRoots = [makeWatchedRoot({ displayName: '空根目录' })];

    const html = renderToStaticMarkup(
      <ToastProvider>
        <NodeTreeView nodes={[]} selectedToken={null} onSelect={() => {}} watchedRoots={watchedRoots} />
      </ToastProvider>,
    );

    expect(html).toContain('空根目录');
    expect(html).toContain('data-group-header="https://example.feishu.cn/wiki/root"');
    expect(html).toContain('尚无文档（未检测或未同步）');
    expect(html).not.toContain('知识库尚未索引');
  });

  it('nodes=[] 且无配置根：保留全局「尚未索引」空态（修复不改变无根语义）', () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <NodeTreeView nodes={[]} selectedToken={null} onSelect={() => {}} />
      </ToastProvider>,
    );

    expect(html).toContain('知识库尚未索引');
  });
});
