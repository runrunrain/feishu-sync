/**
 * lineDiff —— 有界行级 diff（P0-S5 冲突对比弹窗消费）
 *
 * 算法与 server/src/kb/line-diff.ts 同源（前后缀修剪 + LCS + 超限退化为
 * 整块替换），但返回结构化行（含行号）供 UI 逐行渲染，而非 unified patch
 * 文本。有界性约束一致：LCS 表超过 1_000_000 格 → 整块 -/+ 替换；渲染
 * 行数上限 maxRows 截断（truncated=true），大文件不会把弹窗撑爆。
 */

export interface DiffRow {
  /** ' ' 上下文 / '+' 新增（右侧独有）/ '-' 删除（左侧独有）。 */
  kind: '+' | '-' | ' ';
  text: string;
  /** 左侧行号（'+' 行无）。 */
  oldLine: number | null;
  /** 右侧行号（'-' 行无）。 */
  newLine: number | null;
}

export interface LineDiffResult {
  rows: DiffRow[];
  additions: number;
  deletions: number;
  /** rows 因 maxRows 截断（差异本身仍完整计算，仅渲染收敛）。 */
  truncated: boolean;
  identical: boolean;
}

/** 差异行上下文窗口：差异行前后各保留 3 行上下文（与 server 版一致）。 */
const CONTEXT_LINES = 3;

export function computeLineDiff(
  before: string,
  after: string,
  opts?: { maxRows?: number },
): LineDiffResult {
  const maxRows = Math.max(1, Math.floor(opts?.maxRows ?? 2000));
  if (before === after) {
    return { rows: [], additions: 0, deletions: 0, truncated: false, identical: true };
  }
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];

  // 前后缀修剪：公共前缀/后缀不进 LCS。
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  ) {
    suffix++;
  }
  const left = a.slice(prefix, a.length - suffix);
  const right = b.slice(prefix, b.length - suffix);

  // 中段编辑序列：LCS（dp 表 ≤1e6 格），超限退化为整块替换。
  // kind ' ' = LCS 公共行（非差异，用于行号推进与上下文窗口）。
  const edits: Array<{ kind: '+' | '-' | ' '; text: string }> = [];
  if ((left.length + 1) * (right.length + 1) <= 1_000_000) {
    const width = right.length + 1;
    const table = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        table[i * width + j] =
          left[i] === right[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        edits.push({ kind: ' ', text: left[i++] });
        j++;
      } else if (
        j < right.length &&
        (i === left.length || table[i * width + j + 1] >= table[(i + 1) * width + j])
      ) {
        edits.push({ kind: '+', text: right[j++] });
      } else {
        edits.push({ kind: '-', text: left[i++] });
      }
    }
  } else {
    for (const text of left) edits.push({ kind: '-', text });
    for (const text of right) edits.push({ kind: '+', text });
  }

  // 可见窗口：差异行 ±CONTEXT_LINES（含前缀尾/后缀首的桥接上下文）。
  const editsWithBridge: Array<{ kind: '+' | '-' | ' '; text: string }> = [
    ...a.slice(Math.max(0, prefix - CONTEXT_LINES), prefix).map((text) => ({ kind: ' ' as const, text })),
    ...edits,
    ...a.slice(a.length - suffix, a.length - suffix + CONTEXT_LINES).map((text) => ({ kind: ' ' as const, text })),
  ];
  const visible = new Set<number>();
  editsWithBridge.forEach((edit, index) => {
    if (edit.kind !== ' ') {
      for (let k = Math.max(0, index - CONTEXT_LINES); k <= Math.min(editsWithBridge.length - 1, index + CONTEXT_LINES); k++) {
        visible.add(k);
      }
    }
  });

  let oldLine = Math.max(0, prefix - CONTEXT_LINES) + 1;
  let newLine = oldLine;
  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  editsWithBridge.forEach((edit, index) => {
    if (visible.has(index)) {
      rows.push({
        kind: edit.kind,
        text: edit.text,
        oldLine: edit.kind === '+' ? null : oldLine,
        newLine: edit.kind === '-' ? null : newLine,
      });
      if (edit.kind === '+') additions++;
      if (edit.kind === '-') deletions++;
    }
    if (edit.kind !== '+') oldLine++;
    if (edit.kind !== '-') newLine++;
  });

  return {
    rows: rows.slice(0, maxRows),
    additions,
    deletions,
    truncated: rows.length > maxRows,
    identical: false,
  };
}
