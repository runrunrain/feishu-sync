/**
 * 移出状态树/详情呈现 SSR 测试（P2-S7）——展示层 join 锚定：
 *   - TreeNode：moved 覆盖「已删除」为「已移出」；moving →「移出中」；无记录原样
 *   - CloudMovesSection：列表行时间/状态/失败原因/unknown 引导
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TreeNode } from '../TreeNode';
import { CloudMovesSection } from './CloudMovesSection';
import { cloudMoveFace } from './labels';
import type { CloudMoveRecord, MappingNode } from '../../types';

function makeNode(overrides: Partial<MappingNode>): MappingNode {
  return {
    obj_token: 'doxcnT1',
    wiki_node_token: 'wikinf1',
    space_id: null,
    obj_type: 'docx',
    title: '过时草稿',
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

function makeMove(overrides: Partial<CloudMoveRecord>): CloudMoveRecord {
  return {
    id: 'mv_20260101000000_abcdef',
    objToken: 'doxcnT1',
    wikiNodeToken: 'wikinf1',
    watchedRootId: 'wr1',
    title: '过时草稿',
    targetFolderToken: null,
    state: 'moved',
    taskId: null,
    error: null,
    actor: 'ui',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:05.000Z',
    ...overrides,
  };
}

const noop = () => {};

describe('TreeNode 移出徽标（moved 区分于删除）', () => {
  const render = (node: MappingNode, move: CloudMoveRecord | null) =>
    renderToStaticMarkup(
      <TreeNode
        node={node}
        level={1}
        expanded={false}
        selected={false}
        hasChildren={false}
        cloudMoveFace={cloudMoveFace(move)}
        onToggle={noop}
        onSelect={noop}
        onDragStart={noop}
        onDragOver={noop}
        onDragLeave={noop}
        onDrop={noop}
        onDragEnd={noop}
      />,
    );

  it('cloud_deleted=1 + moved 记录 →「已移出」（替代「已删除」）', () => {
    const html = render(makeNode({ cloud_deleted: 1 }), makeMove({ state: 'moved' }));
    expect(html).toContain('已移出');
    expect(html).not.toContain('已删除');
  });

  it('moving 记录 →「移出中」徽标（文档仍在树内）', () => {
    const html = render(makeNode({}), makeMove({ state: 'moving' }));
    expect(html).toContain('移出中');
  });

  it('无移出记录：cloud_deleted=1 沿用「已删除」（回收站/删除语义不回归）', () => {
    const html = render(makeNode({ cloud_deleted: 1 }), null);
    expect(html).toContain('已删除');
    expect(html).not.toContain('已移出');
  });

  it('无移出记录：changed 沿用「变更」', () => {
    const html = render(makeNode({ status: 'changed' }), null);
    expect(html).toContain('变更');
  });
});

describe('CloudMovesSection 移出记录列表', () => {
  it('空列表不渲染', () => {
    expect(renderToStaticMarkup(<CloudMovesSection moves={[]} />)).toBe('');
  });

  it('行呈现时间/状态/目标与操作者；failed 附失败原因', () => {
    const html = renderToStaticMarkup(
      <CloudMovesSection
        moves={[
          makeMove({ state: 'failed', error: 'upstream 99991400' }),
          makeMove({ id: 'mv_2', state: 'moved', actor: 'cli', createdAt: '2025-12-31T00:00:00.000Z' }),
        ]}
      />,
    );
    expect(html).toContain('移出记录（2）');
    expect(html).toContain('失败');
    expect(html).toContain('失败原因：upstream 99991400');
    expect(html).toContain('已移出');
    expect(html).toContain('命令行');
    expect(html).toContain('界面');
    expect(html).toContain('个人空间根');
    expect((html.match(/data-testid="cloud-move-row"/g) ?? []).length).toBe(2);
  });

  it('unknown 行附「到飞书核对」引导', () => {
    const html = renderToStaticMarkup(<CloudMovesSection moves={[makeMove({ state: 'unknown' })]} />);
    expect(html).toContain('状态未知');
    expect(html).toContain('核对云端任务是否结束');
  });
});
