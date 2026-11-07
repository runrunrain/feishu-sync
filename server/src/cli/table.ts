/**
 * 人类模式表格渲染（列表类命令可读性）
 *
 * 命中形态：数据为对象数组（直接数组，或对象第一层唯一一个元素全为对象
 * 的数组字段，如 {builds:[…]}），且元素以标量字段为主。列取出现频率最
 * 高的前 8 个标量键（同频保持首次出现顺序）；单元格按显示宽度对齐（CJK
 * 记 2 列），超 40 列截断补 …；嵌套对象/数组显示 {…}/[n项]；末尾提示
 * --json 查看完整字段。非命中形态由 output.ts 回退到原递归渲染。
 */

const MAX_COLUMNS = 8;
const MAX_CELL_WIDTH = 40;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** 字符显示宽度：CJK/全角记 2，其余记 1（终端双列宽近似，自洽即对齐）。 */
function charWidth(codePoint: number): number {
  const wide = codePoint >= 0x1100 && (
    codePoint <= 0x115f // Hangul Jamo
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf) // CJK 部首..Yi（含全角标点区）
    || (codePoint >= 0xa960 && codePoint <= 0xa97f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3) // Hangul 音节
    || (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK 兼容表意
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60) // 全角 ASCII/标点
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK 扩展
  );
  return wide ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += charWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

/** 按显示宽度截断：截到 maxWidth-1 后补 …，保证结果宽度 ≤ maxWidth。 */
function truncateToWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  let width = 0;
  let out = '';
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (width + w > maxWidth - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

function formatCell(value: unknown): string {
  if (value === undefined) return '—';
  if (isScalar(value)) {
    if (value === null) return 'null';
    return typeof value === 'string' ? value : String(value);
  }
  if (Array.isArray(value)) return `[${value.length}项]`;
  return '{…}';
}

/** 从数据中提取表格行（对象数组）；非命中形态返回 null。 */
function extractRows(data: unknown): { rows: Array<Record<string, unknown>>; extras: Array<[string, unknown]> } | null {
  if (Array.isArray(data)) {
    if (data.length === 0 || !data.every(isPlainObject)) return null;
    return { rows: data as Array<Record<string, unknown>>, extras: [] };
  }
  if (isPlainObject(data)) {
    const arrayKeys = Object.entries(data)
      .filter(([, value]) => Array.isArray(value) && value.length > 0 && (value as unknown[]).every(isPlainObject))
      .map(([key]) => key);
    if (arrayKeys.length !== 1) return null;
    const rows = data[arrayKeys[0]] as Array<Record<string, unknown>>;
    const extras = Object.entries(data)
      .filter(([key, value]) => key !== arrayKeys[0] && isScalar(value));
    return { rows, extras };
  }
  return null;
}

/**
 * 尝试把数据渲染为对齐表格；命中返回行数组（含末尾 --json 提示），
 * 不命中返回 null（调用方回退到原渲染）。
 */
export function tryRenderTable(data: unknown): string[] | null {
  const extracted = extractRows(data);
  if (!extracted) return null;
  const { rows, extras } = extracted;

  // 键统计：出现次数/标量值数/首次出现顺序。多数值为标量的键才可选列
  //（个别行的嵌套值按单元格渲染为 {…}/[n项]，不因此整列剔除）。
  const stats = new Map<string, { count: number; scalarCount: number; firstIndex: number }>();
  let totalValues = 0;
  let scalarValues = 0;
  rows.forEach((row, rowIndex) => {
    for (const [key, value] of Object.entries(row)) {
      totalValues += 1;
      const scalar = isScalar(value);
      if (scalar) scalarValues += 1;
      const entry = stats.get(key) ?? { count: 0, scalarCount: 0, firstIndex: rowIndex };
      entry.count += 1;
      if (scalar) entry.scalarCount += 1;
      if (!stats.has(key)) stats.set(key, entry);
    }
  });
  // 「标量字段为主」门槛：全部值过半为标量，且至少有一列可选。
  const columns = [...stats.entries()]
    .filter(([, entry]) => entry.scalarCount >= 1 && entry.scalarCount * 2 >= entry.count)
    .sort((a, b) => b[1].count - a[1].count || (a[1].firstIndex - b[1].firstIndex))
    .map(([key]) => key)
    .slice(0, MAX_COLUMNS);
  if (columns.length === 0 || scalarValues * 2 < totalValues) return null;

  const rendered = rows.map((row) => columns.map((column) => truncateToWidth(formatCell(row[column]), MAX_CELL_WIDTH)));
  const headers = columns.map((column) => truncateToWidth(column, MAX_CELL_WIDTH));
  const widths = columns.map((_, index) => Math.max(displayWidth(headers[index]), ...rendered.map((cells) => displayWidth(cells[index]))));
  const pad = (cell: string, index: number): string => {
    const padding = ' '.repeat(Math.max(0, widths[index] - displayWidth(cell)));
    return `${cell}${padding}`;
  };

  const lines: string[] = [headers.map(pad).join('  ').replace(/\s+$/, '')];
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const cells of rendered) {
    lines.push(cells.map(pad).join('  ').replace(/\s+$/, ''));
  }
  for (const [key, value] of extras) {
    const text = value === null ? 'null' : typeof value === 'string' ? value : String(value);
    if (text.length === 0) continue;
    lines.push(`${key}：${truncateToWidth(text, 60)}`);
  }
  lines.push('（--json 查看完整字段）');
  return lines;
}
