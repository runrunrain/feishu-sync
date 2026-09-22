/**
 * KnowledgeRootGuideModal - 知识库根目录未设置引导弹窗（2026-10 首次配置引导）
 *
 * 触发场景：knowledgeBaseRoot 为空时用户直接发起同步（勾选同步 / 重试 /
 * 结构修复 / 认领旧文件）——此前会一路穿透到写盘层，报出 ENOENT / 路径
 * 校验等难以理解的错误且无下一步指引。
 *
 * 三个动作：
 *  - 前往设置：跳转设置页（App.handleJumpToSettings，聚焦知识库卡片）
 *  - 使用默认路径并继续：调后端 adopt 端点（Windows 有 D 盘 → D:\飞书知识库，
 *    否则 ~/Documents/飞书知识库；自动创建目录 + 保存配置），成功后回调
 *    onAdopted 继续被拦截的原动作
 *  - 取消：关闭弹窗，不继续
 *
 * 默认路径展示走 GET suggestion（只算不建）；「采用」才真正建目录落盘。
 */

import { useEffect, useState } from 'react';
import { FolderOpen, Globe, X as XIcon } from 'lucide-react';
import { Modal } from './common/Modal';
import { Button } from './common/Button';
import {
  adoptKnowledgeRootSuggestion,
  getKnowledgeRootSuggestion,
} from '../api/client';

interface KnowledgeRootGuideModalProps {
  open: boolean;
  /** 「使用默认路径并继续」成功后回调（已建目录+保存配置），调用方继续原动作。 */
  onAdopted: (root: string) => void;
  onClose: () => void;
  /** 前往设置（App 区跳转通道）。 */
  onJumpToSettings: () => void;
}

export function KnowledgeRootGuideModal({
  open,
  onAdopted,
  onClose,
  onJumpToSettings,
}: KnowledgeRootGuideModalProps) {
  const [suggestedRoot, setSuggestedRoot] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAdoptError(null);
    // 打开时预取建议路径（只算不建）；失败仅退化提示，不阻断弹窗。
    setSuggestedRoot(null);
    setSuggestionError(null);
    getKnowledgeRootSuggestion()
      .then(setSuggestedRoot)
      .catch(() => setSuggestionError('默认路径获取失败，可前往设置手动填写'));
  }, [open]);

  const handleAdopt = async () => {
    setAdopting(true);
    setAdoptError(null);
    try {
      const root = await adoptKnowledgeRootSuggestion();
      onAdopted(root);
    } catch (err) {
      setAdoptError(err instanceof Error ? err.message : '采用默认路径失败');
    } finally {
      setAdopting(false);
    }
  };

  return (
    <Modal open={open} title="知识库根目录未设置" onClose={adopting ? undefined : onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink leading-relaxed">
          同步需要先把飞书文档落到本地知识库根目录，当前还未设置。
          可以前往设置页自定义路径，或直接采用默认路径继续本次同步。
        </p>
        {suggestedRoot && (
          <div className="p-3 rounded-md border border-line bg-paper-2/60">
            <p className="text-xs text-ink-faint mb-1">默认路径（自动创建）</p>
            <p className="text-sm font-mono text-ink break-all">{suggestedRoot}</p>
          </div>
        )}
        {suggestionError && (
          <p className="text-xs text-seal">{suggestionError}</p>
        )}
        {adoptError && (
          <p className="text-xs text-seal-2 break-all">{adoptError}</p>
        )}
        <div className="flex items-center gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={adopting}>
            <XIcon className="w-3.5 h-3.5" />
            取消
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onJumpToSettings}
            disabled={adopting}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            前往设置
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleAdopt()}
            loading={adopting}
          >
            <Globe className="w-3.5 h-3.5" />
            使用默认路径并继续
          </Button>
        </div>
      </div>
    </Modal>
  );
}
