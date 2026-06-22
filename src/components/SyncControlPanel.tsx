/**
 * SyncControlPanel - 同步操作面板（T6，04 §4.2 / §7.2 #12）
 *
 * 受控组件：选中数 / enableLLM / fullSync 由父组件持有。
 * 同步中状态：禁用「开始同步」，启用「取消」。
 *
 * 真实数据流：调用 useSync().syncDocuments(selectedDocs, {enableLLM, fullSync})，
 * 同步进度由 useSync 内部状态变化触发 SyncProgress 渲染。
 */

import { Sparkles, Layers, Play, X } from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { Button } from './common/Button';

interface SyncControlPanelProps {
  selectedCount: number;
  enableLLM: boolean;
  fullSync: boolean;
  syncing: boolean;
  /** Channel label shown next to enableLLM toggle (e.g. "claude CLI 主通道"). */
  channelLabel?: string;
  onEnableLLMChange: (v: boolean) => void;
  onFullSyncChange: (v: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
}

export function SyncControlPanel({
  selectedCount,
  enableLLM,
  fullSync,
  syncing,
  channelLabel,
  onEnableLLMChange,
  onFullSyncChange,
  onStart,
  onCancel,
}: SyncControlPanelProps) {
  const startDisabled = selectedCount === 0 || syncing;

  return (
    <Card variant="elevated">
      <CardBody className="space-y-5">
        {/*
          同步操作面板内部布局重构（2026-06-19）：
          - space-y-3→space-y-5：标题/toggles/action 三组之间 20px 节奏
          - 内部 toggle 行保持 gap-2.5
          - action 行 pt-1→pt-2 + 加 mt-1，与上方内容拉开
        */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-kai font-medium text-ink">同步操作</h3>
            <p className="text-xs text-ink-faint mt-1">
              即将同步 <span className="text-seal font-sans-ui">{selectedCount}</span> 项文档
            </p>
          </div>
        </div>

        {/* Toggles */}
        <div className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <span
              className={`mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                enableLLM
                  ? 'border-seal bg-seal text-white'
                  : 'border-line bg-card-bg hover:border-seal/60'
              }`}
            >
              {enableLLM && (
                <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M2.5 6.5L5 9L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <input
              type="checkbox"
              className="sr-only"
              checked={enableLLM}
              onChange={(e) => onEnableLLMChange(e.target.checked)}
              disabled={syncing}
            />
            <span className="flex-1">
              <span className="flex items-center gap-1.5 text-sm text-ink">
                <Sparkles className="w-3.5 h-3.5 text-seal" />
                启用 LLM 适配
              </span>
              <span className="block text-[11px] text-ink-faint mt-0.5">
                当前通道：{channelLabel ?? 'claude CLI 主通道'}（可在设置区切换）
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 cursor-pointer select-none">
            <span
              className={`mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                fullSync
                  ? 'border-seal bg-seal text-white'
                  : 'border-line bg-card-bg hover:border-seal/60'
              }`}
            >
              {fullSync && (
                <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M2.5 6.5L5 9L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <input
              type="checkbox"
              className="sr-only"
              checked={fullSync}
              onChange={(e) => onFullSyncChange(e.target.checked)}
              disabled={syncing}
            />
            <span className="flex-1">
              <span className="flex items-center gap-1.5 text-sm text-ink">
                <Layers className="w-3.5 h-3.5 text-ink-soft" />
                全量同步
              </span>
              <span className="block text-[11px] text-ink-faint mt-0.5">
                默认增量；勾选后覆盖已同步文档
              </span>
            </span>
          </label>
        </div>

        {/* Action row */}
        <div className="flex items-center justify-end gap-2 pt-3 mt-1 border-t border-line">
          {syncing ? (
            <Button variant="ghost" onClick={onCancel}>
              <X className="w-4 h-4" />
              取消
            </Button>
          ) : null}
          <Button
            variant="seal"
            onClick={onStart}
            disabled={startDisabled}
            loading={syncing}
          >
            {!syncing && <Play className="w-4 h-4" />}
            {syncing ? '同步中…' : '开始同步'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
