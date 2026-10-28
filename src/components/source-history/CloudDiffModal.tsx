/**
 * CloudDiffModal —— 冲突对比弹窗（P0-S5，设计 §4.5；T4b-08 修订）
 *
 * 行级 diff 展示「本地 vs 云端」两侧正文差异，结果只在内存渲染、不落盘。
 * 云端侧由宿主（SourceEditControls）经只读正文 API 真实拉取：拉取中呈现
 * 诚实的「读取中」态；只有真实失败（网络/服务端不可读）才进入不可读
 * 降级态 + 可读侧预览。可用真实数据面另含 push 追加预览
 * （plan.appendMarkdown）等宿主本地已有内容。
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, FileDiff, Loader2, Minus, Plus } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { StatusBadge } from '../common/StatusBadge';
import { computeLineDiff } from '../../utils/lineDiff';

export interface CloudDiffSide {
  label: string;
  /** null = 该侧正文不可读（真实失败后的降级态）。 */
  body: string | null;
  /** body=null 时的不可读原因（如实展示，不编造）。 */
  unavailableReason?: string;
  /** T4b-08：true = 宿主正在拉取该侧正文（读取中态，非失败）。 */
  loading?: boolean;
}

interface CloudDiffModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** 左侧（基准）：通常为云端当前 / 推送前。 */
  left: CloudDiffSide;
  /** 右侧（对比）：通常为本地当前 / 推送后。 */
  right: CloudDiffSide;
  /** 附加说明（如「回滚会丢弃的修改」上下文）。 */
  note?: string;
}

/** 单侧正文预览（云端不可读 / 两侧一致时降级展示）。 */
function SidePreview({ label, body }: { label: string; body: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = body.split('\n');
  const capped = !expanded && lines.length > 40;
  const shown = capped ? lines.slice(0, 40) : lines;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-ink-faint">
        {label}（{lines.length} 行{capped ? '，已截断' : ''}）
      </p>
      <pre className="max-h-64 overflow-auto scrollbar-thin rounded-md border border-line bg-paper px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-soft whitespace-pre-wrap break-words">
        {shown.join('\n')}
      </pre>
      {capped && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-[11px] text-seal hover:underline"
        >
          展开全部 {lines.length} 行
        </button>
      )}
    </div>
  );
}

export function CloudDiffModal({ open, onClose, title, left, right, note }: CloudDiffModalProps) {
  const bothReadable = left.body != null && right.body != null;
  const pending = left.loading === true || right.loading === true;
  const diff = useMemo(
    () => (bothReadable ? computeLineDiff(left.body!, right.body!) : null),
    [bothReadable, left.body, right.body],
  );

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      contentClassName="max-w-3xl"
      zIndexClass="z-[400]"
    >
      <div className="space-y-3">
        {note && (
          <p className="text-xs text-ink-soft leading-relaxed">{note}</p>
        )}

        {pending ? (
          <div className="space-y-3">
            <div className="rounded-md border border-line bg-paper-2/60 p-3 space-y-1.5">
              <p className="flex items-start gap-1.5 text-sm text-ink">
                <Loader2 className="w-4 h-4 shrink-0 mt-0.5 animate-spin" />
                正在读取云端当前正文…
              </p>
              <p className="text-xs text-ink-faint leading-relaxed">读取完成后自动生成两侧行级差异。</p>
            </div>
            {left.body != null && <SidePreview label={left.label} body={left.body} />}
            {right.body != null && <SidePreview label={right.label} body={right.body} />}
          </div>
        ) : !bothReadable ? (
          <div className="space-y-3">
            <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-1.5">
              <p className="flex items-start gap-1.5 text-sm text-seal-2 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                云端正文暂不可读，无法生成两侧差异
              </p>
              <p className="text-xs text-ink-soft leading-relaxed">
                {left.body == null
                  ? left.unavailableReason ?? '左侧正文不可读。'
                  : right.body == null
                    ? right.unavailableReason ?? '右侧正文不可读。'
                    : ''}
              </p>
            </div>
            {left.body != null && <SidePreview label={left.label} body={left.body} />}
            {right.body != null && <SidePreview label={right.label} body={right.body} />}
          </div>
        ) : diff && diff.identical ? (
          <div className="rounded-md border border-line bg-paper-2/60 p-4 text-center space-y-1">
            <p className="text-sm text-ink">两侧正文一致，没有差异</p>
            <p className="text-xs text-ink-faint">差异比较基于行级对齐；空行差异也会计入。</p>
          </div>
        ) : diff ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <StatusBadge status="added" size="sm" hideDot>
                <Plus className="w-3 h-3" />
                {right.label} +{diff.additions}
              </StatusBadge>
              <StatusBadge status="deleted" size="sm" hideDot>
                <Minus className="w-3 h-3" />
                {left.label} −{diff.deletions}
              </StatusBadge>
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-faint">
                <FileDiff className="w-3 h-3" />
                行级差异（差异行 ±3 行上下文）
              </span>
            </div>
            <div className="max-h-[52vh] overflow-auto scrollbar-thin rounded-md border border-line bg-paper font-mono text-[11px] leading-[1.7]">
              {diff.rows.map((row, index) => (
                <div
                  key={index}
                  data-diff-kind={row.kind}
                  className={`flex items-start gap-2 px-2 whitespace-pre-wrap break-words ${
                    row.kind === '+'
                      ? 'bg-jade/10 text-jade'
                      : row.kind === '-'
                        ? 'bg-seal-2/10 text-seal-2'
                        : 'text-ink-faint'
                  }`}
                >
                  <span className="w-10 shrink-0 select-none text-right text-ink-faint/70">{row.oldLine ?? ''}</span>
                  <span className="w-10 shrink-0 select-none text-right text-ink-faint/70">{row.newLine ?? ''}</span>
                  <span className="w-4 shrink-0 select-none text-center">{row.kind === ' ' ? '' : row.kind}</span>
                  <span className="min-w-0 flex-1 pr-2">{row.text || ' '}</span>
                </div>
              ))}
            </div>
            {diff.truncated && (
              <p className="text-[11px] text-ink-faint">差异行数超出展示上限，已截断（差异统计仍完整）。</p>
            )}
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}
