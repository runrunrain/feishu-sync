/**
 * DocPreviewPanel - 文档预览面板（v0.2.8 布局重构 核心组件）
 *
 * 总览区中栏（主区域）：点击节点树后在此以 MD / CSV 两种格式预览本地文档。
 *
 * 结构：
 *   - 头部（sticky）：类型图标 + 标题 + [渲染|源码] / [MD|CSV] 切换
 *   - 内容区：MarkdownView（渲染态）/ 等宽源码 / CsvTableView（多子表切换）
 *   - 底部：本地相对路径 + 截断提示
 *
 * 空态分级：
 *   1. 未选中节点 → 引导点击
 *   2. 已选中但本地无文件 → 「尚未同步到本地」
 *   3. 有内容 → 正常渲染；MD 缺失但有 CSV 时自动切到 CSV 页签
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  Table,
  FileType,
  FileSearch,
  CloudOff,
  Code2,
  BookOpen,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import { Card } from './common/Card';
import { MarkdownView, resolveMediaPath } from './preview/MarkdownView';
import { CsvTableView } from './preview/CsvTableView';
import { WorkbookView } from './preview/WorkbookView';
import { SourceEditControls } from './SourceEditControls';
import { SourceCommentsSection } from './SourceCommentsSection';
import { DocReferenceSection } from './DocReferenceSection';
import { getDocumentContent, refreshSheet } from '../api/client';
import { appLogger } from '../utils/appLogger';
import { useToast } from './common/Toast';
import { useConfig } from '../hooks/useConfig';
import { resolveFeishuTenantHost } from '../utils/feishu-url';
import type { DocumentContent, MappingNode } from '../types';

interface DocPreviewPanelProps {
  node: MappingNode | null;
  /** 与 NodeDetailCard 同一约定：点击后在系统文件管理器中打开本地文件。 */
  onOpenFolder?: (localPath: string) => void;
  className?: string;
}

const TYPE_ICON = {
  docx: FileText,
  sheet: Table,
  slides: FileType,
  unknown: FileType,
} as const;

const TYPE_LABEL = {
  docx: '文档',
  sheet: '表格',
  slides: '幻灯片',
  unknown: '未知',
} as const;

type FormatTab = 'md' | 'csv' | 'xlsx';
type MdMode = 'rendered' | 'source';

export function initialDocumentFormat(data: DocumentContent): FormatTab {
  if (data.sheetStatus?.acquisition === 'csv-fallback' && data.csvTables.length > 0) return 'csv';
  if (data.workbook) return 'xlsx';
  if (data.mdContent == null && data.csvTables.length > 0) return 'csv';
  return 'md';
}

/** 加载骨架屏：模拟标题 + 若干段落的呼吸动画。 */
function LoadingSkeleton() {
  return (
    <div className="px-5 py-4 space-y-4 animate-fade-in" aria-busy="true">
      <div className="h-6 w-2/5 rounded bg-paper-2 animate-pulse" />
      <div className="space-y-2">
        <div className="h-3.5 w-full rounded bg-paper-2 animate-pulse" />
        <div className="h-3.5 w-11/12 rounded bg-paper-2 animate-pulse" />
        <div className="h-3.5 w-4/5 rounded bg-paper-2 animate-pulse" />
      </div>
      <div className="h-24 w-full rounded-md bg-paper-2 animate-pulse" />
      <div className="space-y-2">
        <div className="h-3.5 w-full rounded bg-paper-2 animate-pulse" />
        <div className="h-3.5 w-3/5 rounded bg-paper-2 animate-pulse" />
      </div>
    </div>
  );
}

export function DocPreviewPanel({ node, onOpenFolder, className = '' }: DocPreviewPanelProps) {
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingSheet, setRefreshingSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formatTab, setFormatTab] = useState<FormatTab>('md');
  const [mdMode, setMdMode] = useState<MdMode>('rendered');
  const [csvIndex, setCsvIndex] = useState(0);
  const toast = useToast();
  const { config } = useConfig();

  const feishuHost = useMemo(() => {
    return resolveFeishuTenantHost(config?.watchedRootUrls, config?.watchedRoots);
  }, [config?.watchedRootUrls, config?.watchedRoots]);

  const objToken = node?.obj_token ?? null;
  const currentToken = useRef(objToken);
  currentToken.current = objToken;

  const handleOpenFolder = () => {
    if (!node?.local_path) {
      toast.push({ type: 'warning', message: '该节点尚未同步到本地' });
      return;
    }
    onOpenFolder?.(node.local_path);
  };

  // 内容加载（objToken/同步时间变化与编辑/放弃/写回后重载共用同一入口）。
  const loadContent = useCallback((token: string) => {
    setLoading(true);
    setError(null);
    setContent(null);
    setFormatTab('md');
    setMdMode('rendered');
    setCsvIndex(0);
    let cancelled = false;
    getDocumentContent(token)
      .then((data) => {
        if (cancelled) return;
        setContent(data);
        setFormatTab(initialDocumentFormat(data));
      })
      .catch((err) => {
        if (cancelled) return;
        appLogger.error('doc-preview', 'getDocumentContent failed', err);
        setError(err instanceof Error ? err.message : '内容加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!objToken) {
      setContent(null);
      setError(null);
      return;
    }
    return loadContent(objToken);
  }, [objToken, node?.last_synced_at, loadContent]);

  const TypeIcon = node ? (TYPE_ICON[node.obj_type] ?? FileType) : FileText;
  const hasMd = content?.mdContent != null;
  const csvTables = useMemo(() => content?.csvTables ?? [], [content]);
  const status = content?.sheetStatus;
  const sheetLabel = status ? ({ native: 'Excel 原件', 'read-reconstruction': 'Excel 重建', 'unknown-excel': 'Excel（来源未知）', 'csv-fallback': 'CSV 后备', 'legacy-csv': '历史 CSV', unavailable: '尚无本地表格' } as const)[status.acquisition] : '';
  const handleRefreshSheet = async () => {
    if (!objToken || refreshingSheet) return;
    setRefreshingSheet(true);
    try {
      const result = await refreshSheet(objToken);
      if (!result.success || result.failedDocuments.length) throw new Error(result.failedDocuments[0]?.error ?? '重新获取未完成');
      toast.push({ type: 'success', message: '表格获取完成，请查看版本状态。' });
      if (currentToken.current === objToken) loadContent(objToken);
    } catch (error) {
      toast.push({ type: 'error', message: error instanceof Error ? error.message : '重新获取失败，已有文件已保留' });
    } finally { setRefreshingSheet(false); }
  };
  const activeCsv = csvTables[Math.min(csvIndex, csvTables.length - 1)] ?? null;
  const fileMissing =
    content != null && content.mdContent == null && csvTables.length === 0 && !content.workbook;
  // md 文件所在目录（kbRoot 相对），MarkdownView 用它解析相对图片路径。
  const mdBaseDir = useMemo(() => {
    const p = content?.mdPath ?? '';
    if (!p) return '';
    // Win 防御（2026-09-04）：mdPath 理论上始终是 POSIX 相对路径
    // （server toPortableRelative 归一），但防御性兼容反斜杠分隔，
    // 否则 lastIndexOf('/') 找不到分隔符时 baseDir 为空/错切。
    const normalized = p.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    return idx >= 0 ? normalized.slice(0, idx) : '';
  }, [content?.mdPath]);

  // 点击相对 .csv 链接拦截：匹配当前文档关联的 csvTables，命中则切至对应 CSV 表格
  const handleNavigateCsv = (href: string): boolean => {
    if (!csvTables || csvTables.length === 0) return false;

    const rawPath = href.split(/[?#]/)[0];
    let decodedHref: string;
    try {
      decodedHref = decodeURIComponent(rawPath);
    } catch {
      decodedHref = rawPath;
    }

    const cleanedHref = decodedHref.replace(/^\.\//, '');
    const targetFileName = cleanedHref.split('/').pop() ?? '';
    const targetNameWithoutExt = targetFileName.replace(/\.csv$/i, '');

    const resolvedPath = mdBaseDir ? resolveMediaPath(cleanedHref, mdBaseDir) : cleanedHref;

    const matchIndex = csvTables.findIndex((table) => {
      // 1. 完整 POSIX 路径精确匹配
      if (table.path === resolvedPath || table.path === cleanedHref) return true;
      // 2. 相对路径后缀匹配
      if (table.path.endsWith(cleanedHref)) return true;
      // 3. 文件名（带 .csv）匹配
      const tableFileName = table.path.split('/').pop() ?? '';
      const tableNameWithoutExt = tableFileName.replace(/\.csv$/i, '');
      if (targetFileName && targetFileName.toLowerCase() === tableFileName.toLowerCase()) return true;
      // 4. 子表名称（不带 .csv）匹配
      if (targetNameWithoutExt && targetNameWithoutExt.toLowerCase() === table.name.toLowerCase()) return true;
      if (targetNameWithoutExt && targetNameWithoutExt.toLowerCase() === tableNameWithoutExt.toLowerCase()) return true;
      return false;
    });

    if (matchIndex >= 0) {
      setFormatTab('csv');
      setCsvIndex(matchIndex);
      return true;
    }

    return false;
  };

  // ---- 空态 1：未选中 ----
  if (!node) {
    return (
      <Card
        variant="default"
        className={`flex h-full min-h-[360px] flex-col ${className}`}
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <div className="w-14 h-14 rounded-md bg-paper-2 border border-line/60 flex items-center justify-center">
            <FileSearch className="w-6 h-6 text-ink-faint" />
          </div>
          <p className="text-sm font-kai text-ink-soft">点击左侧节点预览文档</p>
          <p className="text-xs text-ink-faint leading-relaxed max-w-[280px]">
            选中已同步文档后查看本地内容；表格优先展示 Excel 画板
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card
      variant="default"
      className={`flex h-full min-h-[360px] flex-col overflow-hidden ${className}`}
    >
      {/* 头部：标题 + 页签 */}
      <div className="shrink-0 border-b border-line/70 bg-card-bg px-4 pt-3 pb-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-7 h-7 rounded-sm bg-paper-2 border border-line/60 flex items-center justify-center shrink-0">
            <TypeIcon className="w-3.5 h-3.5 text-ink-soft" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-kai font-medium text-ink leading-tight">
              {node.title || content?.title || '（无标题）'}
            </h3>
            <p className="text-[10px] text-ink-faint font-sans-ui">
              {TYPE_LABEL[node.obj_type] ?? '未知'}
              {content?.mdTruncated || activeCsv?.truncated ? ' · 已截断预览' : ''}
            </p>
          </div>

          {/* MD 渲染/源码切换（仅 MD 页签可见） */}
          {formatTab === 'md' && hasMd && (
            <div className="flex shrink-0 items-center rounded-md border border-line bg-paper p-0.5">
              {(
                [
                  { id: 'rendered', label: '渲染', icon: BookOpen },
                  { id: 'source', label: '源码', icon: Code2 },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMdMode(m.id)}
                  className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-sans-ui transition-colors ${
                    mdMode === m.id
                      ? 'bg-card-bg text-seal shadow-sm'
                      : 'text-ink-faint hover:text-ink-soft'
                  }`}
                >
                  <m.icon className="w-3 h-3" />
                  {m.label}
                </button>
              ))}
            </div>
          )}

          {/* 在系统文件管理器中打开本地文件 */}
          {node.obj_type === 'sheet' && content && !content.workbook && ['legacy-csv', 'csv-fallback'].includes(content.sheetStatus?.acquisition ?? '') && <button type="button" onClick={() => void handleRefreshSheet()} disabled={refreshingSheet || !node.local_path} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-paper px-2 py-1.5 text-[11px] text-ink-soft hover:bg-paper-2 disabled:opacity-40"><RefreshCw className={`w-3 h-3 ${refreshingSheet ? 'animate-spin' : ''}`} />{refreshingSheet ? '获取中…' : '重新获取 Excel'}</button>}
          <button
            type="button"
            onClick={handleOpenFolder}
            disabled={!node.local_path}
            title={node.local_path ? '在文件夹中打开' : '该节点尚未同步到本地'}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-paper px-2 py-1.5 text-[11px] text-ink-soft font-sans-ui transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FolderOpen className="w-3 h-3" />
            <span className="hidden xl:inline">打开</span>
          </button>

          {/* S13 源编辑/写回入口：仅 docx 且有本地 md 时渲染（sheet/slides
              为导出投影不支持受控编辑；未同步无正文可编辑） */}
          {objToken && node.obj_type === 'docx' && content?.mdContent != null && !loading && !error && (
            <SourceEditControls
              objToken={objToken}
              objType={node.obj_type}
              mdContent={content.mdContent}
              mdTruncated={content.mdTruncated}
              onContentChanged={() => objToken && loadContent(objToken)}
            />
          )}
        </div>

        {status && <div className="mt-2 text-[11px] text-ink-soft" role="status">
          <span>{sheetLabel}</span>{status.syncedAt && <span> · 同步时间 {new Date(status.syncedAt).toLocaleString()}</span>}
          {status.cloudEditTime != null && status.cloudEditTime > 0 && <span> · 云端修改时间 {new Date(status.cloudEditTime < 100000000000 ? status.cloudEditTime * 1000 : status.cloudEditTime).toLocaleString()}</span>}
          {status.workbookMayBeOlder && <span> · 已保留此前的 Excel，可能较旧；当前默认显示本次获取的 CSV</span>}
          {status.workbookMayBeOlder && content?.workbook?.modifiedTime && <span> · Excel 本地修改时间 {new Date(content.workbook.modifiedTime).toLocaleString()}</span>}
          {status.acquisition === 'read-reconstruction' && status.approximations.includes('mention') && <span> · 提及已转为文本</span>}
          {status.acquisition === 'read-reconstruction' && status.approximations.includes('chart-approximate-pie') && <span> · 饼图近似重建，需下载查看</span>}
          {status.acquisition === 'read-reconstruction' && status.approximations.includes('chart-metadata-only') && <span> · 部分图表仅保存配置</span>}
        </div>}
        {/* 格式页签：MD / CSV（下划线常驻渲染 + scaleX 过渡，与 TopBar 一致） */}
        <div className="mt-2.5 flex items-center gap-4">
          {content?.workbook && (
            <button type="button" onClick={() => setFormatTab('xlsx')} className={`relative pb-2 text-xs font-sans-ui ${formatTab === 'xlsx' ? 'text-seal font-medium' : 'text-ink-faint hover:text-ink-soft'}`}>
              Excel 画板
              <span aria-hidden className={`absolute bottom-0 left-0 right-0 h-[2px] bg-seal rounded-full ${formatTab === 'xlsx' ? 'scale-x-100' : 'scale-x-0'}`} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setFormatTab('md')}
            disabled={!hasMd && !loading}
            className={`relative pb-2 text-xs font-sans-ui transition-colors duration-150 ${
              formatTab === 'md'
                ? 'text-seal font-medium'
                : 'text-ink-faint hover:text-ink-soft disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            Markdown
            <span
              aria-hidden
              className={`absolute bottom-0 left-0 right-0 h-[2px] bg-seal rounded-full transition-transform duration-200 ${
                formatTab === 'md' ? 'scale-x-100' : 'scale-x-0'
              }`}
            />
          </button>
          <button
            type="button"
            onClick={() => setFormatTab('csv')}
            disabled={csvTables.length === 0}
            className={`relative pb-2 text-xs font-sans-ui transition-colors duration-150 ${
              formatTab === 'csv'
                ? 'text-seal font-medium'
                : 'text-ink-faint hover:text-ink-soft disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            CSV{csvTables.length > 0 ? ` (${csvTables.length})` : ''}
            <span
              aria-hidden
              className={`absolute bottom-0 left-0 right-0 h-[2px] bg-seal rounded-full transition-transform duration-200 ${
                formatTab === 'csv' ? 'scale-x-100' : 'scale-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin overscroll-contain">
        {loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <CloudOff className="w-8 h-8 text-seal/60" />
            <p className="text-sm text-seal">内容加载失败</p>
            <p className="text-xs text-ink-faint">{error}</p>
          </div>
        ) : fileMissing ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="w-14 h-14 rounded-md bg-paper-2 border border-line/60 flex items-center justify-center">
              <CloudOff className="w-6 h-6 text-ink-faint" />
            </div>
            <p className="text-sm font-kai text-ink-soft">{node.cloud_match === 'restricted' ? '暂无可预览的本地版本' : '尚未同步到本地'}</p>
            <p className="text-xs text-ink-faint leading-relaxed max-w-[280px]">
              {node.cloud_match === 'restricted' ? '云端访问受限，未能唯一匹配本地文件。请检查本地文件和飞书访问权限。' : '该文档在云端存在但本地还没有文件，前往「贰 同步」主区同步后即可预览'}
            </p>
          </div>
        ) : formatTab === 'xlsx' && content?.workbook ? (
          <WorkbookView key={`${objToken}-${content.workbook.modifiedTime}`} objToken={objToken!} fileName={content.workbook.path} mode={content.workbook.mode} />
        ) : formatTab === 'md' ? (
          hasMd && mdMode === 'rendered' ? (
            <div key={`${objToken}-md-r`} className="animate-fade-in">
              <MarkdownView
                content={content!.mdContent!}
                baseDir={mdBaseDir}
                onNavigateCsv={handleNavigateCsv}
                feishuHost={feishuHost}
                remoteImages="confirm"
              />
            </div>
          ) : hasMd ? (
            <pre
              key={`${objToken}-md-s`}
              className="animate-fade-in px-5 py-4 text-xs leading-relaxed text-ink-soft font-mono whitespace-pre-wrap break-words"
            >
              {content!.mdContent}
            </pre>
          ) : (
            <div className="px-6 py-16 text-center text-sm text-ink-faint">
              无 Markdown 内容
            </div>
          )
        ) : activeCsv ? (
          <div key={`${objToken}-csv-${csvIndex}`} className="animate-fade-in flex h-full min-h-0 flex-col">
            {/* 多子表切换 */}
            {csvTables.length > 1 && (
              <div className="shrink-0 flex flex-wrap gap-1.5 border-b border-line/50 bg-paper/50 px-3 py-2">
                {csvTables.map((t, ti) => (
                  <button
                    key={t.path}
                    type="button"
                    onClick={() => setCsvIndex(ti)}
                    className={`rounded-sm px-2.5 py-1 text-[11px] font-sans-ui border transition-colors ${
                      ti === csvIndex
                        ? 'border-seal/40 bg-seal/10 text-seal'
                        : 'border-line bg-card-bg text-ink-soft hover:bg-paper-2'
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1">
              <CsvTableView content={activeCsv.content} />
            </div>
          </div>
        ) : (
          <div className="px-6 py-16 text-center text-sm text-ink-faint">
            无 CSV 表格
          </div>
        )}
      </div>

      {/* P1-S4：文档详情「引用 / 被引用」折叠区（两侧皆空不渲染） */}
      {!loading && !error && content ? <DocReferenceSection content={content} /> : null}

      {/* P2-S4：评论区（只读；从未采集不渲染，与「没有评论」区分） */}
      {!loading && !error && objToken ? <SourceCommentsSection objToken={objToken} /> : null}

      {/* 底部：路径 */}
      {content?.objType === 'sheet' && !content.workbook && !loading && (
        <p className="shrink-0 border-t border-line bg-paper px-4 py-2 text-[11px] text-ink-soft">此表格为历史文本版本，重新同步后可查看带布局的 Excel 画板。</p>
      )}
      {(content?.mdPath || activeCsv || content?.workbook) && (
        <div className="shrink-0 border-t border-line/60 bg-paper/60 px-4 py-2">
          <p
            className="truncate text-[11px] text-ink-faint font-mono"
            title={formatTab === 'xlsx' ? content?.workbook?.path : formatTab === 'csv' && activeCsv ? activeCsv.path : (content?.mdPath ?? '')}
          >
            {formatTab === 'xlsx' ? content?.workbook?.path : formatTab === 'csv' && activeCsv ? activeCsv.path : content?.mdPath}
          </p>
        </div>
      )}
    </Card>
  );
}
