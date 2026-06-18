/**
 * BusinessTag - 业务标记独立小标签（决策1，04 §3.2）
 *
 * 飞书业务标记（如 T/D/R 回合/舞台/战斗）以"独立小标签"展示，
 * 不嵌入标题文本。T=seal 描边 / D=jade 描边 / R=ink-soft 描边，
 * 以色相区分维度但保持克制（背景统一 paper-2）。
 *
 * 最多显示前 3 个，超出显示 `+N`。无标记时不渲染（由调用方控制）。
 *
 * 同时被 NodeTreeView（T3）和 ChangeItem（T4）复用。
 */

interface BusinessTagProps {
  /** 业务标记字符（如 'T' | 'D' | 'R'），大小写不敏感。 */
  marks: string[];
  /** 最大可见数量，超出折叠为 +N（默认 3）。 */
  maxVisible?: number;
  className?: string;
}

// 04 §3.2: 维度色相映射（描边色，背景统一 paper-2）。
const DIMENSION_COLORS: Record<string, string> = {
  T: 'border-seal/40 text-seal',
  D: 'border-jade/40 text-jade',
  R: 'border-ink-soft/40 text-ink-soft',
};

const DEFAULT_TAG_CLASS = 'border-line text-ink-soft';

export function BusinessTag({ marks, maxVisible = 3, className = '' }: BusinessTagProps) {
  if (!marks || marks.length === 0) return null;

  const normalized = marks
    .map((m) => (typeof m === 'string' ? m.trim().toUpperCase() : ''))
    .filter(Boolean);
  if (normalized.length === 0) return null;

  const visible = normalized.slice(0, maxVisible);
  const overflow = normalized.length - visible.length;

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {visible.map((mark) => {
        const cls = DIMENSION_COLORS[mark] ?? DEFAULT_TAG_CLASS;
        return (
          <span
            key={mark}
            title={`业务标记：${mark}`}
            className={`inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded font-sans-ui text-[11px] leading-none bg-paper-2 border ${cls}`}
          >
            {mark}
          </span>
        );
      })}
      {overflow > 0 && (
        <span
          className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded font-sans-ui text-[11px] leading-none bg-paper-2 border border-line text-ink-faint"
          title={`还有 ${overflow} 个业务标记：${normalized.slice(maxVisible).join('、')}`}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
