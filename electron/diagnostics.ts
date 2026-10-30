/** 本地退出诊断；不上传，不改变未捕获异常的退出语义。 */
import fs from 'node:fs';
import path from 'node:path';

export function createDesktopDiagnostics(dataRoot: string) {
  const directory = path.join(dataRoot, 'diagnostics');
  const file = path.join(directory, 'desktop.jsonl');
  const redact = (text: string) => text.replace(/\bBearer\s+[^\s"',}\]]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1[redacted]');
  return (kind: string, details: Record<string, unknown> = {}) => {
    try {
      fs.mkdirSync(directory, { recursive: true });
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() || (stat && stat.nlink !== 1)) return;
      if (stat && stat.size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
      const envelope = { at: new Date().toISOString(), kind, pid: process.pid, memory: process.memoryUsage() };
      const replacer = (key: string, value: unknown) => /^(api[_-]?key|.*token|authorization|password|secret)$/i.test(key) ? '[redacted]'
        : typeof value === 'string' ? redact(value).slice(0, 8000) : value;
      let data = JSON.stringify({ ...envelope, details }, replacer);
      if (data.length > 16000) data = JSON.stringify({ ...envelope, details: { truncated: true, summary: data.slice(0, 8000) } });
      fs.appendFileSync(file, data + '\n', { mode: 0o600 });
    } catch { /* 诊断磁盘不可写时不能再触发一次宿主异常。 */ }
  };
}
