/**
 * CLI 输出层（设计 kb-agent-upgrade §6.4）
 *
 * 两种模式：
 *  - `--json`（或 FEISHU_SYNC_CLI_JSON=1）：stdout 单个
 *    `{ "ok": true, "data": … }` / `{ "ok": false, "error": { code,
 *    message, httpStatus?, details? } }` 包络，供 agent/脚本消费。
 *    服务端 `/api/cli/:command` 响应体本身就是该包络（S8 契约），
 *    成功路径直接透传；CLI 本地产生的错误也按同构包络输出。
 *  - 人类模式（默认）：中文可读输出；错误走 stderr，数据走 stdout。
 *
 * v1 无流式命令（S8 未登记 SSE 命令），NDJSON 输出留待后续切片。
 */

export interface CliErrorFace {
  code: string;
  message: string;
  httpStatus?: number;
  details?: unknown;
}

/** 命令结果的本地附加说明（如 config get --path 裁剪提示）。 */
export interface PrintOptions {
  json: boolean;
  command?: string;
  note?: string;
}

export function printOk(data: unknown, options: PrintOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  const lines = renderHuman(data, 0);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  if (options.note) {
    process.stdout.write(`\n${options.note}\n`);
  }
}

export function printError(error: CliErrorFace, options: { json: boolean; hint?: string }): void {
  if (options.json) {
    const face: CliErrorFace = { ...error };
    if (face.httpStatus === undefined) delete face.httpStatus;
    if (face.details === undefined) delete face.details;
    process.stdout.write(`${JSON.stringify({ ok: false, error: face })}\n`);
    return;
  }
  process.stderr.write(`错误：${error.message}\n`);
  process.stderr.write(`（错误码 ${error.code}${error.httpStatus ? `，HTTP ${error.httpStatus}` : ''}）\n`);
  if (options.hint) {
    process.stderr.write(`${options.hint}\n`);
  }
}

// ---------------------------------------------------------------------------
// 人类可读渲染（通用递归；不追求完美表格，v1 以结构清晰为先）
// ---------------------------------------------------------------------------

function formatScalar(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderHuman(value: unknown, indent: number): string[] {
  const pad = '  '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}（空）`];
    const lines: string[] = [];
    for (const item of value) {
      if (isPlainObject(item)) {
        const rendered = renderHuman(item, indent + 1);
        lines.push(`${pad}· ${rendered[0].trim()}`);
        lines.push(...rendered.slice(1));
      } else {
        lines.push(`${pad}· ${formatScalar(item)}`);
      }
    }
    return lines;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${pad}（空）`];
    const lines: string[] = [];
    const widest = Math.max(...entries.map(([key]) => key.length));
    for (const [key, child] of entries) {
      if (isPlainObject(child)) {
        lines.push(`${pad}${key}:`);
        lines.push(...renderHuman(child, indent + 1));
      } else if (Array.isArray(child) && child.length > 0 && child.some(isPlainObject)) {
        lines.push(`${pad}${key}:`);
        lines.push(...renderHuman(child, indent + 1));
      } else if (Array.isArray(child)) {
        lines.push(`${pad}${key}: ${formatScalar(child)}`);
      } else {
        lines.push(`${pad}${key.padEnd(widest)}  ${formatScalar(child)}`);
      }
    }
    return lines;
  }

  return [`${pad}${formatScalar(value)}`];
}
