/** 有界逐行差异；大文件退为精确的整块替换，避免二次方内存增长。 */
export function lineDiff(before: string, after: string, maxChars = 64_000) {
  if (before === after) return { patch: '', additions: 0, deletions: 0, truncated: false };
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const left = a.slice(prefix, a.length - suffix);
  const right = b.slice(prefix, b.length - suffix);
  const edits: Array<{ kind: ' ' | '+' | '-'; text: string }> = [];
  for (const text of a.slice(Math.max(0, prefix - 3), prefix)) edits.push({ kind: ' ', text });
  if ((left.length + 1) * (right.length + 1) <= 1_000_000) {
    const width = right.length + 1;
    const table = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--)
      for (let j = right.length - 1; j >= 0; j--)
        table[i * width + j] = left[i] === right[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0; let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        edits.push({ kind: ' ', text: left[i++] }); j++;
      } else if (j < right.length && (i === left.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
        edits.push({ kind: '+', text: right[j++] });
      } else edits.push({ kind: '-', text: left[i++] });
    }
  } else {
    for (const text of left) edits.push({ kind: '-', text });
    for (const text of right) edits.push({ kind: '+', text });
  }
  for (const text of a.slice(a.length - suffix, a.length - suffix + 3)) edits.push({ kind: ' ', text });
  const visible = new Set<number>();
  edits.forEach((edit, i) => {
    if (edit.kind !== ' ') for (let k = Math.max(0, i - 3); k <= Math.min(edits.length - 1, i + 3); k++) visible.add(k);
  });
  let oldLine = Math.max(0, prefix - 3) + 1;
  let newLine = oldLine;
  const rows = ['--- 上一版本', '+++ 当前版本'];
  let last = -2;
  edits.forEach((edit, i) => {
    if (visible.has(i)) {
      if (i !== last + 1) rows.push(`@@ -${oldLine} +${newLine} @@`);
      rows.push(edit.kind + edit.text); last = i;
    }
    if (edit.kind !== '+') oldLine++;
    if (edit.kind !== '-') newLine++;
  });
  const patch = rows.join('\n');
  return {
    patch: patch.slice(0, maxChars),
    additions: edits.filter((e) => e.kind === '+').length,
    deletions: edits.filter((e) => e.kind === '-').length,
    truncated: patch.length > maxChars,
  };
}
