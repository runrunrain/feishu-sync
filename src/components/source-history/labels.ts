/**
 * 回滚 UI 纯函数（P0-S5）——文案映射与门控判定，供写回记录抽屉 /
 * 云端历史抽屉 / 回滚弹窗共用；独立成文件便于单测锚定（SSR 同法）。
 */

import type {
  CloudHistoryEntry,
  HistoryRevertBlockedReason,
  HistoryRevertWarning,
  SourcePushLogRecord,
} from '../../types';

/** 回滚确认值：目标 historyVersionId 必须出现在确认串中（S4 契约）。 */
export function deriveRevertConfirmValue(historyVersionId: string): string {
  return `REVERT_CLOUD:${historyVersionId}`;
}

// ---------------------------------------------------------------------------
// 写回记录行
// ---------------------------------------------------------------------------

export const PUSH_MODE_LABEL: Record<string, string> = {
  append: '追加',
  overwrite: '覆盖',
  revert: '回滚',
};

export const PUSH_ACTOR_LABEL: Record<string, string> = {
  ui: '界面',
  cli: '命令行',
  agent: 'Agent',
};

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
// 回滚弹窗文案
// ---------------------------------------------------------------------------

export const REVERT_WARNING_TEXT: Record<HistoryRevertWarning, string> = {
  anchor_inexact: '回滚点早于写前状态：回滚会一并撤销锚点之后、写回之前的云端修改',
  cloud_changed_since_push: '云端在本次写回之后有新的修改：回滚将丢弃这些修改',
  cloud_time_unreadable: '云端修改时间不可读：无法判断写回后云端是否又被修改，请先到飞书核对',
};

export const REVERT_BLOCKED_TEXT: Record<HistoryRevertBlockedReason, string> = {
  write_disabled: '写回飞书未开启：前往「设置 → 飞书认证 → 飞书写入」开启后再回滚',
  scope_missing: '缺少写回权限：前往「设置 → 飞书写入 → 授权写入权限」后重试',
  local_edit_pending: '该文档有未写回的本地修改：请先写回或放弃本地修改，再回滚云端历史',
  kb_build_active: '标准库构建进行中，暂不能回滚（构建结束或取消后再试）',
  cloud_revert_running: '该文档有进行中的云端回滚，请等待完成后再操作',
  anchor_missing: '该写回记录没有可用的回退锚点（写回时未取得云端历史锚点），无法回滚',
  history_not_found: '目标历史版本不在云端历史前 3 页（60 条）内：版本过旧或已被清理',
  invalid_target: '最新历史条目不可作回滚目标：请选择更早的历史版本',
};

/** 时间展示：ISO → 本地可读（失败回落原文）。 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '时间未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
