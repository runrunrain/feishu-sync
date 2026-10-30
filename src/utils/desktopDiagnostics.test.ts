import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopDiagnostics } from '../../electron/diagnostics';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('本地退出诊断脱敏、保留有效JSON并滚动限制文件大小', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-diagnostic-')); roots.push(root);
  const log = createDesktopDiagnostics(root);
  log('uncaught-exception', { message: 'EPIPE Bearer credential-one api_key=credential-two token=credential-three', apiKey: 'credential-four' });
  const file = path.join(root, 'diagnostics', 'desktop.jsonl');
  const line = fs.readFileSync(file, 'utf8');
  expect(JSON.parse(line)).toMatchObject({ kind: 'uncaught-exception', memory: { rss: expect.any(Number) } });
  for (const credential of ['one', 'two', 'three', 'four']) expect(line).not.toContain(`credential-${credential}`);
  log('large', { fields: Array.from({ length: 100 }, () => '长文本'.repeat(5000)) });
  const last = fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)!;
  expect(last.length).toBeLessThan(16000); expect(JSON.parse(last).details.truncated).toBe(true);
  fs.appendFileSync(file, 'x'.repeat(2 * 1024 * 1024));
  log('startup'); expect(fs.existsSync(`${file}.1`)).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).kind).toBe('startup');
});

it('诊断目录无法写入时不会触发新的宿主异常', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-diagnostic-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'diagnostics'), 'occupied');
  expect(() => createDesktopDiagnostics(root)('uncaught-exception')).not.toThrow();
});
