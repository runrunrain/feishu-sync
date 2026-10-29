/**
 * 回滚 UI 纯函数单测（P0-S5）——锚点门控 / 徽标映射 / 最新条目禁用 /
 * 确认值派生。SSR 流（抽屉/弹窗异步态）由真机浏览器验证覆盖。
 */

import { describe, expect, it } from 'vitest';
import type { CloudHistoryEntry, SourcePushLogRecord } from '../../types';
import {
  anchorFace,
  canRevertHistoryEntry,
  deriveRevertConfirmValue,
  historyTypeFace,
  pushOutcomeBadge,
  rollbackRowGate,
  shortHistoryId,
} from './labels';

function log(overrides: Partial<SourcePushLogRecord>): SourcePushLogRecord {
  return {
    id: 'sp_20260101000000_abcdef',
    objToken: 'doxcnTest',
    localRelPath: '演示/文档.md',
    mode: 'overwrite',
    actor: 'ui',
    preObjEditTime: '1735689600',
    anchorHistoryId: 'hv1024',
    anchorHistoryTime: '2026-01-01T00:00:00Z',
    anchorExact: true,
    anchorError: null,
    postRevisionId: '33',
    postObjEditTime: '1735689700',
    outcome: 'pushed',
    revertState: null,
    revertHistoryId: null,
    revertTaskId: null,
    revertError: null,
    revertedAt: null,
    createdAt: '2026-01-01T00:01:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
    ...overrides,
  };
}

describe('deriveRevertConfirmValue（S4 契约：id 必须出现在确认值中）', () => {
  it('拼接 REVERT_CLOUD:<historyVersionId>', () => {
    expect(deriveRevertConfirmValue('hv2048')).toBe('REVERT_CLOUD:hv2048');
  });
});

describe('pushOutcomeBadge 四态徽标', () => {
  it('pushed/failed/unknown/conflict + started 过渡态', () => {
    expect(pushOutcomeBadge('pushed')).toMatchObject({ text: '已写回', status: 'success' });
    expect(pushOutcomeBadge('failed')).toMatchObject({ text: '失败', status: 'error' });
    expect(pushOutcomeBadge('unknown')).toMatchObject({ text: '状态未知', status: 'neutral' });
    expect(pushOutcomeBadge('conflict')).toMatchObject({ text: '冲突', status: 'warning' });
    expect(pushOutcomeBadge('started')).toMatchObject({ text: '进行中', status: 'loading' });
  });
});

describe('anchorFace 锚点三态', () => {
  it('精确 / 近似（U23）/ 无锚（含原因）', () => {
    expect(anchorFace(log({})).kind).toBe('exact');
    expect(anchorFace(log({ anchorExact: false })).kind).toBe('inexact');
    const none = anchorFace(log({ anchorHistoryId: null, anchorError: '99991400' }));
    expect(none.kind).toBe('none');
    expect(none.title).toContain('99991400');
  });
});

describe('rollbackRowGate 行回滚门控', () => {
  it('成功写回 + 有锚 → 可回滚', () => {
    expect(rollbackRowGate(log({})).enabled).toBe(true);
  });

  it('无锚点行禁用并显示原因（含 anchorError 原文）', () => {
    const gate = rollbackRowGate(log({ anchorHistoryId: null, anchorError: 'timeout' }));
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('timeout');
  });

  it('append 无锚（空锚继续）同样禁用', () => {
    const gate = rollbackRowGate(log({ mode: 'append', anchorHistoryId: null, anchorError: 'history_list_empty' }));
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('history_list_empty');
  });

  it('非成功写回禁用，未知状态不假称云端未修改', () => {
    const expected: Record<string, string> = {
      conflict: '未成功',
      failed: '未成功',
      unknown: '结果未知',
      started: '尚未结束',
    };
    for (const outcome of ['conflict', 'failed', 'unknown', 'started'] as const) {
      const gate = rollbackRowGate(log({ outcome }));
      expect(gate.enabled).toBe(false);
      expect(gate.reason).toContain(expected[outcome]);
    }
  });

  it('该行回滚进行中 → 禁用', () => {
    const gate = rollbackRowGate(log({ revertState: 'running', revertTaskId: 't1' }));
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('进行中');
  });

  it('revert 行成功（mode=revert, outcome=pushed）仍可再回滚（HP-2）', () => {
    expect(rollbackRowGate(log({ mode: 'revert' })).enabled).toBe(true);
  });
});

describe('云端历史条目', () => {
  it('类型徽标：1 建档 / 3 回滚快照 / 其余编辑', () => {
    expect(historyTypeFace(1).text).toBe('建档');
    expect(historyTypeFace(3).text).toBe('回滚快照');
    expect(historyTypeFace(2).text).toBe('编辑');
    expect(historyTypeFace(null).text).toBe('编辑');
  });

  it('shortHistoryId 长短 id 形态', () => {
    expect(shortHistoryId(null)).toBe('—');
    expect(shortHistoryId('hv1024')).toBe('hv1024');
    expect(shortHistoryId('0123456789abcdef')).toBe('01234567…cdef');
  });

  it('全局最新条目禁用（3380002）；无 id 条目禁用', () => {
    const latest: CloudHistoryEntry = { historyVersionId: 'hv1', revisionId: 9, editTime: null, editorIds: [], type: 2 };
    expect(canRevertHistoryEntry(latest, true).enabled).toBe(false);
    expect(canRevertHistoryEntry(latest, true).reason).toContain('最新');
    const older: CloudHistoryEntry = { historyVersionId: 'hv2', revisionId: 8, editTime: null, editorIds: [], type: 2 };
    expect(canRevertHistoryEntry(older, false).enabled).toBe(true);
    expect(canRevertHistoryEntry({ ...latest, historyVersionId: null }, false).enabled).toBe(false);
  });
});
