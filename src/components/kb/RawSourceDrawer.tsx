/**
 * RawSourceDrawer —— 原始文档抽屉（来源点击后展开）
 *
 * 复用既有 GET /api/mapping/content/:objToken（唯一内容出口）与
 * MarkdownView 安全渲染器（无 dangerouslySetInnerHTML，HTML 表格走
 * 受控白名单解析），满足「源 Markdown 不执行 HTML/脚本」约束。
 * 空态分级：加载中 / 本地无文件（mdContent null）/ 加载失败。
 */

import { useEffect, useState } from 'react';
import { Loader2, FileWarning, Table2 } from 'lucide-react';
import { Drawer } from '../common/Drawer';
import { MarkdownView } from '../preview/MarkdownView';
import { CsvTableView } from '../preview/CsvTableView';
import { WorkbookView } from '../preview/WorkbookView';
import { SourceEditControls } from '../SourceEditControls';
import { getDocumentContent, APIError } from '../../api/client';
import type { DocumentContent } from '../../types';
import type { KbDocSourceRef } from '../../types/agent';

interface RawSourceDrawerProps {
  source: KbDocSourceRef | null;
  onClose: () => void;
}

export function RawSourceDrawer({ source, onClose }: RawSourceDrawerProps) {
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'md' | 'csv' | 'xlsx'>('md');
  const [csvIndex, setCsvIndex] = useState(0);
  /** 放弃/写回后重载正文（S13）。 */
  const [reloadNonce, setReloadNonce] = useState(0);

  const objToken = source?.objToken ?? null;

  useEffect(() => {
    if (!objToken) {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    setView('md');
    setCsvIndex(0);
    getDocumentContent(objToken)
      .then((data) => {
        if (cancelled) return;
        setContent(data);
        if (data.workbook) setView('xlsx');
        else if (!data.mdContent && data.csvTables.length > 0) setView('csv');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof APIError ? err.message : '原始文档加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [objToken, reloadNonce]);

  return (
    <Drawer
      open={source !== null}
      onClose={onClose}
      title={source ? `原始文档 · ${source.title || '未命名'}` : '原始文档'}
      subtitle={source?.relPath}
      widthClass={view === 'xlsx' ? 'w-[1080px] max-w-[94vw]' : 'w-[620px] max-w-[92vw]'}
    >
      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-faint">
          <Loader2 className="w-6 h-6 animate-spin" />
          <p className="text-xs">正在读取本地原始文档…</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
          <FileWarning className="w-8 h-8 text-seal-2" />
          <p className="text-sm text-ink font-medium">原始文档读取失败</p>
          <p className="text-xs text-ink-soft leading-relaxed max-w-sm">{error}</p>
          <p className="text-[11px] text-ink-faint">该来源可能尚未同步到本地，或本地文件已缺失。</p>
        </div>
      ) : content ? (
        <div className="flex flex-col">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-line/60 bg-paper/50">
            {content.workbook && (
              <button type="button" onClick={() => setView('xlsx')} className={`px-2.5 py-1 rounded text-xs ${view === 'xlsx' ? 'bg-card-bg border border-line text-ink' : 'text-ink-faint hover:text-ink'}`}>Excel 画板</button>
            )}
            {content.mdContent ? (
              <button
                type="button"
                onClick={() => setView('md')}
                className={`px-2.5 py-1 rounded text-xs transition-colors ${
                  view === 'md' ? 'bg-card-bg border border-line text-ink' : 'text-ink-faint hover:text-ink'
                }`}
              >
                Markdown
              </button>
            ) : null}
            {content.csvTables.length > 0 ? (
              <button
                type="button"
                onClick={() => setView('csv')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs transition-colors ${
                  view === 'csv' ? 'bg-card-bg border border-line text-ink' : 'text-ink-faint hover:text-ink'
                }`}
              >
                <Table2 className="w-3 h-3" />
                子表 {content.csvTables.length}
              </button>
            ) : null}
            {view === 'csv' && content.csvTables.length > 1 ? (
              <select
                value={csvIndex}
                onChange={(e) => setCsvIndex(Number(e.target.value))}
                className="ml-auto h-7 rounded border border-line bg-card-bg text-xs text-ink px-1.5"
                aria-label="选择子表"
              >
                {content.csvTables.map((t, i) => (
                  <option key={t.name} value={i}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : null}
            {content.mdTruncated ? (
              <span className="ml-auto text-[11px] text-ink-faint">内容过长已截断</span>
            ) : null}
            {/* 源文档状态/写回入口（与 DocPreviewPanel 共用组件） */}
            {objToken && content.mdContent != null && content.objType === 'docx' ? (
              <span className={content.mdTruncated ? '' : 'ml-auto'}>
                <SourceEditControls
                  objToken={objToken}
                  objType={content.objType}
                  mdContent={content.mdContent}
                  onContentChanged={() => setReloadNonce((n) => n + 1)}
                />
              </span>
            ) : null}
          </div>
          {view === 'xlsx' && content.workbook ? (
            <WorkbookView key={`${content.objToken}-${content.workbook.modifiedTime}`} objToken={content.objToken} fileName={content.workbook.path} mode={content.workbook.mode} />
          ) : view === 'md' ? (
            content.mdContent ? (
              <MarkdownView
                content={content.mdContent}
                baseDir={content.mdPath ? content.mdPath.split('/').slice(0, -1).join('/') : ''}
                remoteImages="confirm"
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-ink-faint">
                <p className="text-xs">该文档本地无 Markdown 内容</p>
              </div>
            )
          ) : (
            <CsvTableView
              content={(content.csvTables[csvIndex] ?? content.csvTables[0])?.content ?? ''}
            />
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
