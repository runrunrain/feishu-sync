/**
 * 移出 UI 纯函数（P2-S7）——确认值派生 / 八分支 blocked 文案 / 状态徽标
 * / 树与详情状态覆盖，供移出弹窗、移出记录列表、NodeTreeView /
 * NodeDetailCard 共用；独立成文件便于 SSR 单测锚定（回滚 labels 同法）。
 */

import type { CloudMoveBlockedReason, CloudMoveRecord } from '../../types';
import { formatTime } from '../source-history/labels';

/** 确认值基段（server 端 CLI 域特权值；UI 直调必须传完整值）。 */
export const MOVE_OUT_CONFIRM_BASE = 'MOVE_OUT';

/** UI 确认值：`MOVE_OUT:<wikiNodeToken>`（preview 返回权威 nodeToken）。 */
export function deriveMoveOutConfirmValue(nodeToken: string): string {
  return `${MOVE_OUT_CONFIRM_BASE}:${nodeToken}`;
}

// ---------------------------------------------------------------------------
// 八分支 blocked 文案（与 server CloudMoveError message 同义，前端锚定
// 呈现；未知分支回落原码，不吞服务端语义）
// ---------------------------------------------------------------------------

export const MOVE_OUT_BLOCKED_TEXT: Record<CloudMoveBlockedReason, string> = {
  not_watched_root:
    '只有结构树（watchedRoot）成员且带 wiki 节点身份的文档才能移出：归档文档 / 无节点身份不支持',
  has_children: '该节点有子节点，只支持移出单篇叶子文档（请先处理子节点）',
  node_not_found: '知识库中已不存在该节点（可能已被移动或删除），无法移出',
  local_edit_pending: '该文档有未写回的本地修改：请先写回或放弃本地修改，再移出到云空间',
  cloud_revert_running: '该文档有进行中的云端回滚，请等待完成（或状态收敛为未知）后再移出',
  cloud_move_running: '该文档有进行中或结果未知的移出（未知需权威核对解除）：请在移出记录完成核对，确认未移出后再操作',
  kb_build_active: '标准库构建进行中，暂不能移出到云空间（构建结束或取消后再试）',
  source_not_found: '文档不在库中（可能已被清理）：请刷新索引后重试',
};

/**
 * unknown 终态引导（P2-S6 语义：移出非幂等绝不自动重试；到飞书核对后
 * 只读刷新收敛展示——下一次检测发现节点不在树内即展示「可能已移出」）。
 */
export const MOVE_OUT_UNKNOWN_GUIDE =
  '移出结果不确定（不会自动重试）：请到飞书知识库核对该节点是否仍在树内；核对后在总览点击「刷新」只读刷新，展示会随检测结果收敛。';

// ---------------------------------------------------------------------------
// 移出记录状态徽标（moves 列表 / 弹窗结果共用）
// ---------------------------------------------------------------------------

export type CloudMoveBadgeStatus = 'success' | 'error' | 'warning' | 'neutral' | 'loading';

/** cloud_moves.state 五态 → 徽标文案与色彩（server 状态机 pending→moving→moved/failed/unknown）。 */
export function cloudMoveStateBadge(state: string): { text: string; status: CloudMoveBadgeStatus } {
  switch (state) {
    case 'moved':
      return { text: '已移出', status: 'success' };
    case 'moving':
      return { text: '移出中', status: 'loading' };
    case 'pending':
      return { text: '已发起', status: 'loading' };
    case 'failed':
      return { text: '失败', status: 'error' };
    case 'unknown':
      return { text: '状态未知', status: 'neutral' };
    default:
      return { text: state, status: 'neutral' };
  }
}

/**
 * 展示层状态覆盖（U48：展示层 join，不改观测字段）：给定该文档最新的
 * cloud_moves 记录，决定树 / 详情的状态徽标与标题文案。
 *   - moved   →「已移出到云空间」（树内紧凑作「已移出」，区分于回收站/删除）
 *   - moving/pending →「移出中」（异步进行中徽标）
 *   - unknown →「移出未知」（引导到飞书核对）
 *   - failed  →「移出失败」（最近一次，可重新发起）
 *   - 无记录 → null（沿用既有状态文案）
 */
export interface CloudMoveFace {
  kind: 'moved' | 'moving' | 'unknown' | 'failed';
  /** 树内紧凑徽标文案。 */
  treeText: string;
  /** 详情/树 title 全量说明。 */
  title: string;
  badgeStatus: CloudMoveBadgeStatus;
}

export function cloudMoveFace(record: CloudMoveRecord | null | undefined): CloudMoveFace | null {
  if (!record) return null;
  switch (record.state) {
    case 'moved':
      return {
        kind: 'moved',
        treeText: '已移出',
        title: `已于 ${formatTime(record.updatedAt)} 移出到云空间（记录 ${record.id}）；本地文件与标准库保留不动`,
        badgeStatus: 'success',
      };
    case 'moving':
    case 'pending':
      return {
        kind: 'moving',
        treeText: '移出中',
        title: `移出请求进行中（记录 ${record.id}），云端异步执行，正在跟踪收敛`,
        badgeStatus: 'loading',
      };
    case 'unknown':
      return {
        kind: 'unknown',
        treeText: '移出未知',
        title: MOVE_OUT_UNKNOWN_GUIDE,
        badgeStatus: 'neutral',
      };
    case 'failed':
      return {
        kind: 'failed',
        treeText: '移出失败',
        title: record.error ? `最近一次移出失败：${record.error}` : `最近一次移出失败（记录 ${record.id}），可重新发起`,
        badgeStatus: 'error',
      };
    default:
      return null;
  }
}

/**
 * 菜单层移出资格本地判断（仅 watchedRoot 成员的叶子文档显示入口；
 * 服务端八分支门控兜底——本地判断只控制入口可见性，不替代门控）。
 * 结构树成员：wiki_node_token 非空（飞书结构视图行）；叶子：云端
 * has_child 为 false 且本地未观测到子节点。
 */
export function isMoveOutEligible(node: {
  wiki_node_token?: string | null;
  has_child?: boolean;
  childrenCount: number;
}): boolean {
  return (
    (node.wiki_node_token ?? null) != null &&
    node.has_child !== true &&
    node.childrenCount === 0
  );
}
