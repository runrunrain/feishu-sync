/**
 * NodeDetailCard - 节点详情卡（T12，04 §4.1.2 元素清单）
 *
 * 点击节点树节点联动显示该节点详情：标题 / 类型 / 路径 / 修改时间 /
 * 状态 / 同步此节点按钮 / 在文件夹中打开。
 *
 * v0.2.0 cloud-link-coverage: 新增「飞书原文」可点击链接 + 「云匹配」徽章
 * （已对应 / 权限受限 / 未分类），让每个本地文档与飞书云的对应关系明确可见。
 *
 * v0.2.0 structure-align Phase D (D3): 增强「归属根 / 父节点 / 子节点」三行。
 *   - 归属根：watched_root_url 反查 watchedRoots，显示 displayName
 *   - 父节点：parent_node_token 反查 nodes 找父节点（可点击跳转）
 *   - 子节点：filter nodes by parent_node_token === current.wiki_node_token
 *
 * 双视图通用（飞书视图 / 本地视图选中文件节点都显示同样的字段）。
 */

import type { JSX } from 'react';
import {
  FileText,
  Table,
  FileType,
  FolderOpen,
  RefreshCw,
  ExternalLink,
  CloudOff,
  HelpCircle,
  ArrowUpRight,
  CornerDownRight,
} from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { BusinessTag } from './common/BusinessTag';
import { useToast } from './common/Toast';
import type { MappingNode, WatchedRoot } from '../types';

interface NodeDetailCardProps {
  node: MappingNode | null;
  businessMarks?: string[];
  onSyncNode?: (objToken: string) => void;
  onOpenFolder?: (localPath: string) => void;
  /**
   * v0.2.0 structure-align Phase D (D3): full node list so we can resolve
   * parent_node_token → parent node and find children. When absent the
   * 父节点/子节点 rows are hidden (graceful degradation for callers that
   * haven't migrated yet).
   */
  allNodes?: MappingNode[];
  /**
   * v0.2.0 structure-align Phase D (D3): watchedRoots list so we can
   * resolve watched_root_url → displayName for the 归属根 row.
   */
  watchedRoots?: WatchedRoot[];
  /**
   * Fired when the user clicks the parent node link or a child node link.
   * Caller updates its selectedToken; this card re-renders with the new node.
   */
  onSelectNode?: (objToken: string) => void;
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
  allNodes,
  watchedRoots,
  onSelectNode,
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

  // v0.2.0 structure-align Phase D (D3): resolve parent / children / watchedRoot.
  const nodeAny = node as MappingNode & { watched_root_url?: string | null };
  const watchedRootUrl = nodeAny.watched_root_url ?? null;
  const watchedRoot = watchedRoots && watchedRootUrl
    ? watchedRoots.find((wr) => wr.url === watchedRootUrl) ?? null
    : null;
  const parentToken = node.parent_node_token ?? null;
  const parentNode = parentToken && allNodes
    ? allNodes.find((n) => n.wiki_node_token === parentToken) ?? null
    : null;
  const childNodes = allNodes && node.wiki_node_token
    ? allNodes.filter((n) => n.parent_node_token === node.wiki_node_token)
    : [];
  // Cap the inline children list to keep the card scannable; "查看全部" not
  // needed because clicking any child selects it and the card re-renders.
  const MAX_INLINE_CHILDREN = 5;

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
          {/* v0.2.0 structure-align Phase D (D3): 归属根 row */}
          {watchedRoot && (
            <>
              <dt className="text-ink-faint font-sans-ui col-span-1">归属根</dt>
              <dd className="col-span-2">
                <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft font-sans-ui">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-seal" />
                  {watchedRoot.displayName || watchedRoot.title || watchedRoot.localDir}
                  <a
                    href={watchedRoot.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-jade hover:text-jade-2"
                    title={`飞书 wiki token: ${watchedRoot.nodeToken}`}
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </span>
              </dd>
            </>
          )}
          {/* v0.2.0 structure-align Phase D (D3): 父节点 row (only when resolvable) */}
          {allNodes && parentToken && (
            <>
              <dt className="text-ink-faint font-sans-ui col-span-1">父节点</dt>
              <dd className="col-span-2">
                {parentNode ? (
                  <button
                    type="button"
                    onClick={() => onSelectNode?.(parentNode.obj_token)}
                    className="inline-flex items-center gap-1 text-xs text-jade hover:text-jade-2 font-sans-ui text-left"
                    title={parentNode.local_path || parentNode.obj_token}
                  >
                    <ArrowUpRight className="w-3 h-3 shrink-0" />
                    <span className="truncate max-w-[260px]">{parentNode.title}</span>
                  </button>
                ) : (
                  <span className="text-xs text-ink-faint font-sans-ui">
                    {parentToken.slice(0, 12)}…（未在节点表中）
                  </span>
                )}
              </dd>
            </>
          )}
          {/* v0.2.0 structure-align Phase D (D3): 子节点 list (only when allNodes provided) */}
          {allNodes && (
            <>
              <dt className="text-ink-faint font-sans-ui col-span-1">
                子节点{childNodes.length > 0 ? ` (${childNodes.length})` : ''}
              </dt>
              <dd className="col-span-2">
                {childNodes.length === 0 ? (
                  <span className="text-xs text-ink-faint font-sans-ui">无</span>
                ) : (
                  <ul className="space-y-1">
                    {childNodes.slice(0, MAX_INLINE_CHILDREN).map((c) => (
                      <li key={c.obj_token}>
                        <button
                          type="button"
                          onClick={() => onSelectNode?.(c.obj_token)}
                          className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-seal font-sans-ui text-left"
                          title={c.local_path || c.obj_token}
                        >
                          <CornerDownRight className="w-3 h-3 shrink-0 text-ink-faint" />
                          <span className="truncate max-w-[260px]">{c.title}</span>
                          {c.status === 'changed' && (
                            <span className="ml-1 inline-block px-1 rounded-sm text-[10px] bg-seal/10 text-seal">
                              变更
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                    {childNodes.length > MAX_INLINE_CHILDREN && (
                      <li className="text-[11px] text-ink-faint font-sans-ui pl-4">
                        还有 {childNodes.length - MAX_INLINE_CHILDREN} 项，请通过节点树展开查看
                      </li>
                    )}
                  </ul>
                )}
              </dd>
            </>
          )}
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
