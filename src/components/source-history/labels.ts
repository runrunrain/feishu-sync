/**
 * 回滚/写回展示纯函数（P0-S5）——文案映射与门控判定；独立成文件便于单测
 * 锚定（SSR 同法）。formatTime 供移出记录/节点详情等共用；其余判定函数
 * 与 cloud history / revert 契约（CLI/HTTP 入口）对齐，经 labels.test 锚定。
 */

import type {
  CloudHistoryEntry,
  SourcePushLogRecord,
} from '../../types';

/** 回滚确认值：目标 historyVersionId 必须出现在确认串中（S4 契约）。 */
export function deriveRevertConfirmValue(historyVersionId: string): string {
  return `REVERT_CLOUD:${historyVersionId}`;
}

// ---------------------------------------------------------------------------
// 写回记录行
// ---------------------------------------------------------------------------

/** outcome 四态徽标（任务书）+ started 过渡态。 */
export function pushOutcomeBadge(outcome: string): { text: string; status: 'success' | 'error' | 'neutral' | 'warning' | 'loading' } {
  switch (outcome) {
    case 'pushed':
      return { text: '已写回', status: 'success' };
    case 'conflict':
      return { text: '冲突', status: 'warning' };
    case 'failed':
      return { text: '失败', status: 'error' };
    case 'unknown':
      return { text: '状态未知', status: 'neutral' };
    case 'started':
      return { text: '进行中', status: 'loading' };
    default:
      return { text: outcome, status: 'neutral' };
  }
}

/** 锚点状态：精确 / 近似（U23）/ 无锚（含失败原因）。 */
export function anchorFace(log: SourcePushLogRecord): {
  kind: 'exact' | 'inexact' | 'none';
  text: string;
  title: string;
} {
  if (log.anchorHistoryId == null || log.anchorHistoryId === '') {
    return {
      kind: 'none',
      text: '无锚点',
      title: log.anchorError
        ? `写回时未取得云端历史锚点（${log.anchorError}）`
        : '写回时未取得云端历史锚点',
    };
  }
  if (log.anchorExact === true) {
    return {
      kind: 'exact',
      text: '精确锚点',
      title: `锚点 ${log.anchorHistoryId}（${log.anchorHistoryTime ?? '时间未知'}）恰为写前状态`,
    };
  }
  return {
    kind: 'inexact',
    text: '近似锚点',
    title: `锚点 ${log.anchorHistoryId}（${log.anchorHistoryTime ?? '时间未知'}）早于写前状态，回滚会一并撤销此期间的云端修改`,
  };
}

/** 「回滚到写回前」行门控：无锚 / 非成功写回 / 回滚进行中均禁用并给原因。 */
export function rollbackRowGate(log: SourcePushLogRecord): { enabled: boolean; reason: string } {
  if (log.revertState === 'running') {
    return { enabled: false, reason: '该行发起的云端回滚仍在进行中' };
  }
  if (log.revertState === 'unknown') {
    return { enabled: false, reason: '云端回滚结果未知，请先核对任务状态' };
  }
  if (log.anchorHistoryId == null || log.anchorHistoryId === '') {
    return {
      enabled: false,
      reason: log.anchorError
        ? `无回退锚点（${log.anchorError}），无法回滚到写回前`
        : '无回退锚点，无法回滚到写回前',
    };
  }
  if (log.outcome === 'started') {
    return { enabled: false, reason: '写回尚未结束，暂无回滚点' };
  }
  if (log.outcome !== 'pushed') {
    if (log.outcome === 'unknown') return { enabled: false, reason: '该次云端操作结果未知，请先核对云端内容' };
    return { enabled: false, reason: `该次写回未成功（${log.outcome}），云端没有被本次写回修改` };
  }
  return { enabled: true, reason: '' };
}

// ---------------------------------------------------------------------------
// 云端历史
// ---------------------------------------------------------------------------

/** 历史条目类型：1=建档 / 2=普通编辑 / 3=revert 产生（P0-S1 实测）。 */
export function historyTypeFace(type: number | null): { text: string; status: 'neutral' | 'added' | 'modified' } {
  if (type === 1) return { text: '建档', status: 'neutral' };
  if (type === 3) return { text: '回滚快照', status: 'modified' };
  return { text: '编辑', status: 'added' };
}

export function shortHistoryId(id: string | null): string {
  if (!id) return '—';
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** 条目是否可作为回滚目标：无 id / 全局最新条目（3380002）不可。 */
export function canRevertHistoryEntry(entry: CloudHistoryEntry, isGlobalLatest: boolean): { enabled: boolean; reason: string } {
  if (!entry.historyVersionId) {
    return { enabled: false, reason: '该历史条目缺少版本 id，不能作为回滚目标' };
  }
  if (isGlobalLatest) {
    return { enabled: false, reason: '最新历史条目不可作为回滚目标（飞书 3380002 限制），请选择更早版本' };
  }
  return { enabled: true, reason: '' };
}

// ---------------------------------------------------------------------------
// 回滚门控文案
// ---------------------------------------------------------------------------

/** 时间展示：ISO → 本地可读（失败回落原文）。 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '时间未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
