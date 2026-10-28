/**
 * 移出 UI 纯函数测试（P2-S7）——确认值派生 / 八分支 blocked 文案 /
 * 状态徽标 / 展示层覆盖 / 菜单层资格判断（叶子·非叶子·归档）。
 */

import { describe, expect, it } from 'vitest';
import {
  MOVE_OUT_BLOCKED_TEXT,
  MOVE_OUT_CONFIRM_BASE,
  MOVE_OUT_UNKNOWN_GUIDE,
  cloudMoveFace,
  cloudMoveStateBadge,
  deriveMoveOutConfirmValue,
  isMoveOutEligible,
} from './labels';
import type { CloudMoveBlockedReason, CloudMoveRecord } from '../../types';

function makeMove(overrides: Partial<CloudMoveRecord>): CloudMoveRecord {
  return {
    id: 'mv_20260101000000_abcdef',
    objToken: 'doxcnT1',
    wikiNodeToken: 'wikinf1',
    watchedRootId: 'wr1',
    title: '草稿',
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

describe('deriveMoveOutConfirmValue（确认值含权威 node token）', () => {
  it('派生 `MOVE_OUT:<nodeToken>`（与 S6 服务端同式）', () => {
    expect(deriveMoveOutConfirmValue('wikinfAbc123')).toBe('MOVE_OUT:wikinfAbc123');
    expect(MOVE_OUT_CONFIRM_BASE).toBe('MOVE_OUT');
  });
});

describe('MOVE_OUT_BLOCKED_TEXT 八分支可读文案', () => {
  const REASONS: CloudMoveBlockedReason[] = [
    'not_watched_root',
    'has_children',
    'node_not_found',
    'local_edit_pending',
    'cloud_revert_running',
    'cloud_move_running',
    'kb_build_active',
    'source_not_found',
  ];

  it('八分支全部有非空文案（覆盖服务端门控面）', () => {
    for (const reason of REASONS) {
      expect(MOVE_OUT_BLOCKED_TEXT[reason].length).toBeGreaterThan(6);
    }
    expect(Object.keys(MOVE_OUT_BLOCKED_TEXT)).toHaveLength(8);
  });

  it('关键分支语义锚定（有子节点/编辑中/回滚中/移出中/构建中）', () => {
    expect(MOVE_OUT_BLOCKED_TEXT.has_children).toContain('子节点');
    expect(MOVE_OUT_BLOCKED_TEXT.local_edit_pending).toContain('未写回的本地修改');
    expect(MOVE_OUT_BLOCKED_TEXT.cloud_revert_running).toContain('云端回滚');
    expect(MOVE_OUT_BLOCKED_TEXT.cloud_move_running).toContain('结果未知的移出');
    expect(MOVE_OUT_BLOCKED_TEXT.cloud_move_running).toContain('权威核对');
    expect(MOVE_OUT_BLOCKED_TEXT.kb_build_active).toContain('构建');
    expect(MOVE_OUT_BLOCKED_TEXT.not_watched_root).toContain('归档文档');
  });
});

describe('cloudMoveStateBadge（状态机五态徽标）', () => {
  it('pending/moving → 进行中（loading）；moved → 成功；failed → 失败；unknown → 未知', () => {
    expect(cloudMoveStateBadge('pending')).toMatchObject({ text: '已发起', status: 'loading' });
    expect(cloudMoveStateBadge('moving')).toMatchObject({ text: '移出中', status: 'loading' });
    expect(cloudMoveStateBadge('moved')).toMatchObject({ text: '已移出', status: 'success' });
    expect(cloudMoveStateBadge('failed')).toMatchObject({ text: '失败', status: 'error' });
    expect(cloudMoveStateBadge('unknown')).toMatchObject({ text: '状态未知', status: 'neutral' });
    // 未知状态值回落原码，不吞服务端语义。
    expect(cloudMoveStateBadge('weird')).toMatchObject({ text: 'weird', status: 'neutral' });
  });
});

describe('cloudMoveFace（树/详情展示层覆盖，U48 展示层 join）', () => {
  it('无记录 → null（沿用既有状态文案）', () => {
    expect(cloudMoveFace(null)).toBeNull();
    expect(cloudMoveFace(undefined)).toBeNull();
  });

  it('moved → 「已移出」树文案 + 本地保留说明', () => {
    const face = cloudMoveFace(makeMove({ state: 'moved' }));
    expect(face?.kind).toBe('moved');
    expect(face?.treeText).toBe('已移出');
    expect(face?.badgeStatus).toBe('success');
    expect(face?.title).toContain('本地文件与标准库保留不动');
  });

  it('moving/pending → 「移出中」徽标（异步进行中）', () => {
    expect(cloudMoveFace(makeMove({ state: 'moving' }))?.treeText).toBe('移出中');
    expect(cloudMoveFace(makeMove({ state: 'pending' }))?.kind).toBe('moving');
  });

  it('unknown → 引导到飞书核对（不自动重试语义）', () => {
    const face = cloudMoveFace(makeMove({ state: 'unknown' }));
    expect(face?.kind).toBe('unknown');
    expect(face?.title).toBe(MOVE_OUT_UNKNOWN_GUIDE);
    expect(MOVE_OUT_UNKNOWN_GUIDE).toContain('到飞书知识库核对');
    expect(MOVE_OUT_UNKNOWN_GUIDE).toContain('只读刷新');
  });

  it('failed → 展示服务端失败原因', () => {
    const face = cloudMoveFace(makeMove({ state: 'failed', error: 'upstream 99991400' }));
    expect(face?.kind).toBe('failed');
    expect(face?.title).toContain('upstream 99991400');
  });
});

describe('isMoveOutEligible（菜单层本地资格：watchedRoot 成员叶子）', () => {
  it('结构树叶子（wiki 身份 + 无子）→ 入口显示', () => {
    expect(isMoveOutEligible({ wiki_node_token: 'wikinf1', has_child: false, childrenCount: 0 })).toBe(true);
  });

  it('非叶子（云端 has_child 或本地观测到子行）→ 入口隐藏（服务端 has_children 兜底）', () => {
    expect(isMoveOutEligible({ wiki_node_token: 'wikinf1', has_child: true, childrenCount: 0 })).toBe(false);
    expect(isMoveOutEligible({ wiki_node_token: 'wikinf1', has_child: false, childrenCount: 2 })).toBe(false);
  });

  it('归档文档（无 wiki 身份）→ 入口隐藏（服务端 not_watched_root 兜底）', () => {
    expect(isMoveOutEligible({ wiki_node_token: null, has_child: false, childrenCount: 0 })).toBe(false);
  });
});
