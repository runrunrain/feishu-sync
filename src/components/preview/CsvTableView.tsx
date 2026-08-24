/**
 * CsvTableView - CSV 表格预览（v0.2.8 预览面板）
 *
 * 自研 CSV 解析（RFC 4180 子集：引号字段、逗号/换行内嵌、"" 转义），
 * 零依赖。首行视作表头；超过 200 行截断并提示总数。
 */

import { useMemo } from 'react';

const MAX_ROWS = 200;

/** RFC 4180 风格的 CSV 解析：支持带引号字段、内嵌逗号/换行、双引号转义。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    // 跳过尾部完全空白的行
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushField();
      pushRow();
    } else if (ch === '\r') {
      // 忽略，\n 统一成行尾
    } else {
      field += ch;
    }
  }
  pushField();
  pushRow();
  return rows;
}

export function CsvTableView({ content }: { content: string }) {
  const rows = useMemo(() => parseCsv(content), [content]);
  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-ink-faint">
        空表格
      </div>
    );
  }

  const header = rows[0];
  const body = rows.slice(1);
  const visible = body.slice(0, MAX_ROWS);
  const colCount = Math.max(header.length, ...body.map((r) => r.length), 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10">
            <tr className="bg-paper-2 shadow-[0_1px_0_0_var(--line)]">
              <th className="w-10 px-2 py-2 text-right font-mono font-normal text-ink-faint border-b border-line bg-paper-2">
                #
              </th>
              {Array.from({ length: colCount }, (_, ci) => (
                <th
                  key={ci}
                  className="px-3 py-2 text-left font-medium text-ink border-b border-line whitespace-nowrap bg-paper-2"
                >
                  {header[ci] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, ri) => (
              <tr
                key={ri}
                className={`transition-colors hover:bg-jade/5 ${
                  ri % 2 === 1 ? 'bg-paper/60' : 'bg-card-bg'
                }`}
              >
                <td className="px-2 py-1.5 text-right font-mono text-[10px] text-ink-faint border-b border-line/40 select-none">
                  {ri + 1}
                </td>
                {Array.from({ length: colCount }, (_, ci) => (
                  <td
                    key={ci}
                    className="px-3 py-1.5 text-ink-soft border-b border-line/40 align-top max-w-[320px] truncate"
                    title={row[ci] ?? ''}
                  >
                    {row[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {body.length > MAX_ROWS && (
        <div className="shrink-0 px-4 py-2 border-t border-line/60 bg-paper-2/60 text-[11px] text-ink-faint font-sans-ui">
          仅预览前 {MAX_ROWS} 行，共 {body.length} 行 — 完整数据请在文件夹中打开 CSV 查看
        </div>
      )}
    </div>
  );
}
