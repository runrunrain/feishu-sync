/**
 * SyncControlPanel - 同步操作面板（T6，04 §4.2 / §7.2 #12）
 *
 * 受控组件：仅由父组件提供选中数和同步中状态。
 *
 * P0-06 安全闸门：全量同步、LLM 适配和取消尚无可靠的后端语义，
 * 因而不把它们显示成可操作控件。当前入口只发起已选文档的 dry-run，
 * 正式写入必须等待服务端 apply 闸门和明确确认。
 *
 * 真实数据流：调用 useSync().syncDocuments(selectedDocs)，
 * 同步进度由 useSync 内部状态变化触发 SyncProgress 渲染。
 */

import { Play } from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { Button } from './common/Button';

interface SyncControlPanelProps {
  selectedCount: number;
  syncing: boolean;
  onStart: () => void;
}

export function SyncControlPanel({
  selectedCount,
  syncing,
  onStart,
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
            <h3 className="text-base font-kai font-medium text-ink">同步核验</h3>
            <p className="text-xs text-ink-faint mt-1">
              即将核验 <span className="text-seal font-sans-ui">{selectedCount}</span> 项已选文档
            </p>
          </div>
        </div>

        <div
          role="note"
          className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-ink-soft"
        >
          <p className="font-medium text-ink">保护模式：仅支持已选文档的 dry-run</p>
          <p className="mt-1 leading-5">
            全量同步、LLM 内容适配和取消尚无可靠后端语义，已暂停，不会作为可操作控件显示。
          </p>
          <p className="mt-1 leading-5">
            此操作仅用于核验同步结果；正式写入须经服务端明确的 apply 安全闸门确认。
          </p>
        </div>

        {/* Action row */}
        <div className="flex items-center justify-end gap-2 pt-3 mt-1 border-t border-line">
          <Button
            variant="seal"
            onClick={onStart}
            disabled={startDisabled}
            loading={syncing}
          >
            {!syncing && <Play className="w-4 h-4" />}
            {syncing ? '核验中…' : '开始核验'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
