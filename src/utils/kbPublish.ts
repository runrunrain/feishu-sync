/**
 * 反向发布纯函数层（P1-S9）——状态/动作/警告/门控的可读文案与派生计算。
 *
 * 服务端只回结构化 code；人读文案统一在此维护，供发布流、状态徽标、
 * 发布历史与设置卡共用。纯函数、无 IO，单测锚定（kbPublish.test.ts）。
 */

import type {
  KbPublishGates,
  KbPublishPlanItemDto,
  KbPublishWarning,
} from '../types/kb-publish';

/** 徽标色调（对齐 StatusBadge 的 status 枚举）。 */
export type PublishBadgeTone = 'success' | 'warning' | 'error' | 'neutral' | 'loading';

export interface PublishStateMeta {
  label: string;
  /** 侧栏树等窄场景的短标签。 */
  short: string;
  tone: PublishBadgeTone;
}

/** 发布状态 → 展示元数据。未知状态（宽松字符串）回退「状态未知」。 */
export const PUBLISH_STATE_META: Record<string, PublishStateMeta> = {
  published: { label: '已发布', short: '已发布', tone: 'success' },
  published_with_warnings: { label: '已发布 · 有警告', short: '警告', tone: 'warning' },
  conflict: { label: '云端冲突', short: '冲突', tone: 'error' },
  unknown: { label: '状态未知', short: '未知', tone: 'warning' },
  creating: { label: '发布中', short: '发布中', tone: 'loading' },
  failed: { label: '发布失败', short: '失败', tone: 'error' },
  kb_removed: { label: '已从标准库移除', short: '已移除', tone: 'neutral' },
  cloud_missing: { label: '云端不可访问', short: '云端丢失', tone: 'error' },
};

export function publishStateMeta(state: string): PublishStateMeta {
  return PUBLISH_STATE_META[state] ?? PUBLISH_STATE_META.unknown;
}

/** 任务书要求的四态徽标集合（树/详情默认只显示这四态，其余去历史看全量）。 */
export const TREE_BADGE_STATES: ReadonlySet<string> = new Set([
  'published',
  'published_with_warnings',
  'conflict',
  'unknown',
]);

export const PUBLISH_ACTION_LABEL: Record<KbPublishPlanItemDto['action'], string> = {
  create: '新建',
  update: '更新',
  skip_unchanged: '无变化',
  blocked: '阻断',
};

export const PUBLISH_BLOCKED_REASON: Record<NonNullable<KbPublishPlanItemDto['blockedReason']>, string> = {
  publish_cloud_edited: '云端文档在发布后有修改：请核对云端，或以覆盖方式重新发布',
  cloud_missing: '云端文档不可访问：不会自动重建，确认后可重新发布为新文档',
  state_unknown: '上次发布结果未知：请先到发布根核对，确认后重新发布为新文档',
  render_failed: '渲染失败：文档无法转换为可发布内容',
};

/** 警告 code → 可读文案（缺 text 时兜底；有 text 时优先服务端文案）。 */
export const PUBLISH_WARNING_TEXT: Record<string, string> = {
  link_target_unpublished: '链接目标尚未发布：链接改为纯文字',
  image_not_published: '本地图片不随发布上传：已替换为「图片未发布」占位',
  publish_verify_mismatch: '回读字符数与本地差异过大：可能存在整段丢失或转换异常',
  publish_verify_unavailable: '回读校验不可用：无法确认云端转换完整性',
  render_failed: '渲染失败',
};

export function describePublishWarning(warning: KbPublishWarning): string {
  const base = warning.text?.trim() || PUBLISH_WARNING_TEXT[warning.code] || warning.code;
  const target = warning.target ? `（${warning.target}）` : '';
  return `${base}${target}`;
}

/** 门控问题清单（preview.gates → 逐条人读问题；空数组=门全开）。 */
export function describePublishGates(gates: KbPublishGates): string[] {
  const problems: string[] = [];
  if (!gates.publishEnabled) {
    problems.push('反向发布未开启（设置 → 飞书认证 → 飞书发布）');
  }
  if (!gates.feishuWriteEnabled) {
    problems.push('飞书写入未开启：反向发布依赖写权限门（设置 → 飞书认证 → 飞书写入）');
  }
  if (!gates.writeScopesGranted) {
    const missing = gates.missingScopes.length > 0 ? gates.missingScopes.join('、') : 'docx:document:write_only';
    problems.push(`缺少写权限（${missing}）：需发起一次「写入权限」授权`);
  }
  if (!gates.targetConfigured) {
    problems.push('发布根未配置：请先在设置中选择并校验发布根');
  }
  return problems;
}

export const PUBLISH_CONFIRM_HINT: Record<'PUBLISH' | 'OVERWRITE_PUBLISHED', string> = {
  PUBLISH: '输入 PUBLISH 确认发布',
  OVERWRITE_PUBLISHED: '将覆盖云端被他人修改过的文档，输入 OVERWRITE_PUBLISHED 确认',
};

/** 发布根 kind → 展示名。 */
export function publishTargetKindLabel(kind: string): string {
  return kind === 'wiki_node' ? '知识库节点' : 'Drive 文件夹';
}

/** 计划内可执行（create/update）行数——0 时执行无意义，UI 禁用执行按钮。 */
export function countExecutableItems(items: Array<Pick<KbPublishPlanItemDto, 'action'>>): number {
  return items.filter((item) => item.action === 'create' || item.action === 'update').length;
}

/** 从标准库树提取文档路径扁平列表（保留目录顺序；发布选择集用）。 */
export function flattenDocPaths(
  nodes: Array<{ path: string; type: string; children?: unknown }>,
): string[] {
  const result: string[] = [];
  const walk = (list: Array<{ path: string; type: string; children?: unknown }>): void => {
    for (const node of list) {
      if (node.type === 'doc') result.push(node.path);
      const children = node.children as Array<{ path: string; type: string; children?: unknown }> | undefined;
      if (children) walk(children);
    }
  };
  walk(nodes);
  return result;
}
