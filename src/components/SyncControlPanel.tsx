/**
 * SyncControlPanel - 同步操作面板（T6，04 §4.2 / §7.2 #12）
 *
 * 受控组件：仅由父组件提供选中数和同步中状态。
 *
 * 安全闸门：仅同步用户选中的文档。开始操作后还会要求确认，服务端
 * 以 staging + 原子替换写入；不安全的路径仍会被规划器阻止。
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
  contentAdaptationEnabled: boolean;
  organisationChannel: 'claude-cli' | 'direct' | 'opencode';
  onStart: () => void;
}

export function SyncControlPanel({
  selectedCount,
  syncing,
  contentAdaptationEnabled,
  organisationChannel,
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
            <h3 className="text-base font-kai font-medium text-ink">同步到本地</h3>
            <p className="text-xs text-ink-faint mt-1">
              即将同步 <span className="text-seal font-sans-ui">{selectedCount}</span> 项已选文档
            </p>
          </div>
        </div>

        <div
          role="note"
          className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-ink-soft"
        >
          <p className="font-medium text-ink">写入保护仍然开启</p>
          <p className="mt-1 leading-5">
            确认后会以临时文件和原子替换写入本地知识库。未映射的同名文件、未知类型和删除项会被阻止，不会被覆盖或删除。
          </p>
        </div>

        {contentAdaptationEnabled && (
          <div
            role="status"
            className="rounded-md border border-jade/30 bg-jade/5 px-3 py-2.5 text-xs text-ink-soft"
          >
            <p className="font-medium text-ink">文档整理已启用</p>
            <p className="mt-1 leading-5">
              本次会先完成确定性格式重建，再通过
              {' '}{organisationChannel === 'opencode' ? '本机 OpenCode 无头模式' : '当前 LLM 通道'}整理正文。
              整理失败时会自动保留确定性结果，不会中断安全写入。
            </p>
          </div>
        )}

        {/* Action row */}
        <div className="flex items-center justify-end gap-2 pt-3 mt-1 border-t border-line">
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
