/**
 * NodeDetailCard - 节点详情卡（T12，04 §4.1.2 元素清单）
 *
 * 点击节点树节点联动显示该节点详情：标题 / 类型 / 路径 / 修改时间 /
 * 状态 / 同步此节点按钮 / 在文件夹中打开。
 *
 * v0.2.0 cloud-link-coverage: 新增「飞书原文」可点击链接 + 「云匹配」徽章
 * （已对应 / 权限受限 / 未分类），让每个本地文档与飞书云的对应关系明确可见。
 */

import type { JSX } from 'react';
import { FileText, Table, FileType, FolderOpen, RefreshCw, ExternalLink, CloudOff, HelpCircle } from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { BusinessTag } from './common/BusinessTag';
import { useToast } from './common/Toast';
import type { MappingNode } from '../types';

interface NodeDetailCardProps {
  node: MappingNode | null;
  businessMarks?: string[];
  onSyncNode?: (objToken: string) => void;
  onOpenFolder?: (localPath: string) => void;
}

const TYPE_ICON = {
  docx: FileText,
  sheet: Table,
  slides: FileType,
  unknown: FileType,
};

const TYPE_LABEL = {
  docx: '文档',
  sheet: '表格',
  slides: '幻灯片',
  unknown: '未知',
};

function formatTime(t: string | null | undefined): string {
  if (!t) return '--';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function NodeDetailCard({
  node,
  businessMarks,
  onSyncNode,
  onOpenFolder,
}: NodeDetailCardProps) {
  const toast = useToast();

  if (!node) {
    return (
      <Card variant="default">
        <CardBody>
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <FileText className="w-10 h-10 text-ink-faint mb-3" />
            <p className="text-sm text-ink-soft">未选中节点</p>
            <p className="text-xs text-ink-faint mt-1">
              点击左侧节点树查看详情
            </p>
          </div>
        </CardBody>
      </Card>
    );
  }

  // v0.2.0 cloud-link-coverage: render the explicit cloud_match badge so
  // the user always knows whether the feishu link is authoritative
  // (synced), best-effort guess (restricted, permission-denied), or
  // unclassified legacy (unknown — suggests a rebuild is needed).
  const cloudMatchBadge = renderCloudMatchBadge(node);

  const TypeIcon = TYPE_ICON[node.obj_type] ?? FileText;
  const changed = node.status === 'changed' || node.cloud_deleted === 1;

  const handleSync = () => {
    if (!onSyncNode) {
      toast.push({
        type: 'info',
        message: '请前往「同步」主区同步该节点',
      });
      return;
    }
    onSyncNode(node.obj_token);
  };

  const handleOpenFolder = () => {
    if (!node.local_path) {
      toast.push({ type: 'warning', message: '该节点尚未同步到本地' });
      return;
    }
    onOpenFolder?.(node.local_path);
  };

  return (
    <Card variant="default">
      <CardBody className="space-y-4">
        <div className="flex items-start gap-2.5">
          <TypeIcon className="w-4 h-4 text-ink-soft shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-kai font-medium text-ink truncate">
                {node.title}
              </h3>
              {businessMarks && businessMarks.length > 0 && (
                <BusinessTag marks={businessMarks} />
              )}
            </div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <StatusBadge
                status={
                  node.cloud_deleted === 1
                    ? 'deleted'
                    : node.status === 'changed'
                      ? 'modified'
                      : node.status === 'error'
                        ? 'error'
                        : 'success'
                }
                size="sm"
              >
                {node.cloud_deleted === 1
                  ? '已删除'
                  : node.status === 'changed'
                    ? '变更'
                    : node.status === 'error'
                      ? '错误'
                      : '已同步'}
              </StatusBadge>
              <span className="text-[11px] text-ink-faint font-sans-ui">
                {TYPE_LABEL[node.obj_type]}
              </span>
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-xs pt-1">
          <dt className="text-ink-faint font-sans-ui col-span-1">路径</dt>
          <dd className="text-ink-soft font-mono col-span-2 break-all">
            {node.local_path || '（未同步）'}
          </dd>
          <dt className="text-ink-faint font-sans-ui col-span-1">飞书原文</dt>
          <dd className="text-ink-soft font-mono col-span-2 break-all">
            {node.original_link ? (
              <a
                href={node.original_link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-jade hover:text-jade-2 underline underline-offset-2"
              >
                <ExternalLink className="w-3 h-3 shrink-0" />
                <span className="break-all">{node.original_link}</span>
              </a>
            ) : (
              <span className="text-ink-faint">--（无云链接）</span>
            )}
          </dd>
          <dt className="text-ink-faint font-sans-ui col-span-1">云匹配</dt>
          <dd className="col-span-2">
            {cloudMatchBadge}
          </dd>
          <dt className="text-ink-faint font-sans-ui col-span-1">云端修改</dt>
          <dd className="text-ink-soft font-mono col-span-2">
            {node.obj_edit_time
              ? formatTime(new Date(node.obj_edit_time * 1000).toISOString())
              : '--'}
          </dd>
          <dt className="text-ink-faint font-sans-ui col-span-1">本地同步</dt>
          <dd className="text-ink-soft font-mono col-span-2">
            {node.last_synced_at ? formatTime(node.last_synced_at) : '尚未同步'}
          </dd>
        </dl>

        <div className="flex items-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={handleSync}
            disabled={!changed}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-seal hover:bg-seal-2 rounded-md font-sans-ui transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            同步此节点
          </button>
          <button
            type="button"
            onClick={handleOpenFolder}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-ink-soft border border-line rounded-md bg-paper hover:bg-paper-2 font-sans-ui transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            在文件夹中打开
          </button>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// v0.2.0 cloud-link-coverage: explicit feishu cloud-relationship badge.
//
// The cloud_match field is the single piece of metadata that answers the
// user's question "does this local doc have a corresponding feishu page?"
// — rendered here as a small inline badge with three states:
//
//   synced     : "已对应"     — link is authoritative, title verified
//   restricted : "权限受限"  — link is best-effort guess (feishu returned
//                              permission-denied, title is empty)
//   unknown    : "未分类"    — legacy row from before the migration; UI
//                              suggests running rebuild to classify
//
// The badge is kept inline (not a popover) so the information is always
// visible without interaction. We avoid the deprecated StatusBadge colors
// (which encode sync state, not cloud-match state) and use semantic colors:
// jade = good, seal = warning, ink-faint = unknown.
// ---------------------------------------------------------------------------

function renderCloudMatchBadge(node: MappingNode): JSX.Element {
  const cm = node.cloud_match ?? 'unknown';
  if (cm === 'synced') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-jade/10 text-jade text-[11px] font-sans-ui">
        <span className="w-1.5 h-1.5 rounded-full bg-jade" />
        已对应飞书
      </span>
    );
  }
  if (cm === 'restricted') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-seal/10 text-seal text-[11px] font-sans-ui" title="该节点在飞书权限受限（131006），链接为基于 token 的推测，未经飞书确认">
        <CloudOff className="w-3 h-3" />
        飞书权限受限（链接为推测）
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-ink-faint/10 text-ink-faint text-[11px] font-sans-ui" title="该节点未分类。请触发「重建索引」让系统读取 .md 头部并补全云匹配信息">
      <HelpCircle className="w-3 h-3" />
      未分类（建议重建索引）
    </span>
  );
}
