/**
 * LogDrawer - 日志抽屉（T9/T2，04 §7.2 #17）
 *
 * 从右侧滑出，按级别（全部/信息/警告/错误）筛选展示 appLogger
 * 内存缓冲。LogViewer（旧顶级 Tab）降级为本抽屉的来源，本 Task
 * 仅建抽屉骨架；后端 GET /api/logs 持久化日志读取由 P5 接入。
 */

import { useEffect, useMemo, useState } from 'react';
import { ScrollText, Trash2 } from 'lucide-react';
import { Drawer } from './common/Drawer';
import { appLogger, LogEntry } from '../utils/appLogger';

interface LogDrawerProps {
  open: boolean;
  onClose: () => void;
}

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

const LEVEL_LABEL: Record<LevelFilter, string> = {
  all: '全部',
  info: '信息',
  warn: '警告',
  error: '错误',
};

const LEVEL_TEXT: Record<LogEntry['level'], string> = {
  info: 'text-ink-soft',
  warn: 'text-seal',
  error: 'text-seal-2',
};

export function LogDrawer({ open, onClose }: LogDrawerProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LevelFilter>('all');

  useEffect(() => {
    const unsub = appLogger.subscribe(setEntries);
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    const list = filter === 'all' ? entries : entries.filter((e) => e.level === filter);
    return [...list].reverse(); // 最新在上
  }, [entries, filter]);

  const handleClear = () => appLogger.clear();

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="应用日志"
      subtitle={`${filtered.length} 条 · 仅本次会话`}
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-faint font-sans-ui">
            完整错误堆栈写入本视图；Toast 不展开堆栈
          </span>
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-ink-soft hover:text-seal border border-line rounded-md bg-card-bg font-sans-ui transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            清空
          </button>
        </div>
      }
    >
      {/* Level filter */}
      <div className="sticky top-0 bg-card-bg border-b border-line px-5 py-2.5 flex items-center gap-2 z-10">
        {(Object.keys(LEVEL_LABEL) as LevelFilter[]).map((lv) => (
          <button
            key={lv}
            type="button"
            onClick={() => setFilter(lv)}
            className={`px-2.5 py-1 rounded text-xs font-sans-ui border transition-colors ${
              filter === lv
                ? 'bg-seal/10 text-seal border-seal/30'
                : 'bg-paper text-ink-soft border-line hover:bg-paper-2'
            }`}
          >
            {LEVEL_LABEL[lv]}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center px-4">
          <ScrollText className="w-10 h-10 text-ink-faint mb-3" />
          <p className="text-sm text-ink-soft">暂无日志</p>
          <p className="text-xs text-ink-faint mt-1">同步、检测、Toast 反馈会在此记录。</p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {filtered.map((e, idx) => (
            <li key={`${e.ts}-${idx}`} className="px-5 py-2.5">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] text-ink-faint font-mono">{e.ts}</span>
                <span className={`text-[10px] uppercase font-sans-ui ${LEVEL_TEXT[e.level]}`}>
                  {e.level}
                </span>
                <span className="text-[10px] text-ink-faint font-mono">[{e.scope}]</span>
              </div>
              <p className="text-sm text-ink break-words">{e.message}</p>
              {e.detail !== undefined && e.detail !== null && (
                <pre className="mt-1 text-[11px] text-ink-faint font-mono whitespace-pre-wrap break-all bg-paper-2/60 rounded p-2 max-h-48 overflow-auto">
                  {typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
