import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionHistoryCache, parseSessionJsonl } from '../src/agent/session-history.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-cache-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const line = (id: string, parentId: string | null, text: string) => JSON.stringify({ type: 'message', id, parentId,
  timestamp: '2026-11-04T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';

it('retains complete branch semantics, incremental UTF-8 writes, compaction and file replacement', async () => {
  const file = path.join(root, 'branch.jsonl'); const cache = new SessionHistoryCache();
  fs.writeFileSync(file, line('a', null, '一') + line('b', 'a', '二'));
  const initial = await cache.read(file); expect(initial).toEqual(parseSessionJsonl(fs.readFileSync(file, 'utf8')));
  expect(await cache.read(file)).toBe(initial);
  const bytes = Buffer.from(line('c', 'a', '新分支 中文'));
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  fs.appendFileSync(file, bytes.subarray(0, split));
  expect((await cache.read(file)).map((message) => message.id)).toEqual(['a', 'b']);
  fs.appendFileSync(file, bytes.subarray(split));
  const branch = await cache.read(file); expect(branch.map((message) => message.text)).toEqual(['一', '新分支 中文']);
  expect(branch[0]).toBe(initial[0]);
  fs.appendFileSync(file, JSON.stringify({ type: 'compaction', id: 'compact', parentId: 'c' }) + '\n');
  expect((await cache.read(file)).map((message) => message.id)).toEqual(['a', 'c']);
  fs.writeFileSync(file + '.new', line('fresh', null, '替换')); fs.renameSync(file + '.new', file);
  expect((await cache.read(file)).map((message) => message.id)).toEqual(['fresh']);
});

it('reads only appended bytes after a multi-megabyte tool history and discards huge raw tool bodies', async () => {
  const file = path.join(root, 'large.jsonl'); const cache = new SessionHistoryCache();
  const content = Array.from({ length: 400 }, (_, i) => JSON.stringify({ type: 'message', id: `t${i}`, parentId: i ? `t${i - 1}` : null,
    message: { role: 'toolResult', toolName: 'read', toolCallId: `call${i}`, content: [{ type: 'text', text: 'x'.repeat(40_000) }] } })).join('\n') + '\n';
  fs.writeFileSync(file, content); const first = await cache.read(file); expect(first).toHaveLength(400);
  expect(JSON.stringify(first).length).toBeLessThan(200_000);
  const appended = line('last', 't399', 'done'); fs.appendFileSync(file, appended);
  const realOpen = fs.promises.open.bind(fs.promises); let readBytes = 0;
  const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args); const read = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation((async (...input: Parameters<typeof read>) => {
      const result = await read(...input); readBytes += result.bytesRead; return result;
    }) as typeof handle.read);
    return handle;
  });
  try { const next = await cache.read(file); expect(next).toHaveLength(401); expect(next[0]).toBe(first[0]); expect(readBytes).toBe(Buffer.byteLength(appended)); }
  finally { open.mockRestore(); }
});

it('a concurrent history request sees entries appended while the first snapshot is being read', async () => {
  const file = path.join(root, 'concurrent.jsonl'); const cache = new SessionHistoryCache();
  fs.writeFileSync(file, line('old', null, 'old'));
  const original = fs.promises.open.bind(fs.promises); let appended = false;
  const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (!appended) { appended = true; fs.appendFileSync(file, line('new', 'old', 'new')); }
    return handle;
  });
  try {
    const first = cache.read(file); const second = cache.read(file);
    expect((await first).map((message) => message.id)).toEqual(['old']);
    expect((await second).map((message) => message.id)).toEqual(['old', 'new']);
  } finally { open.mockRestore(); }
});

it('restores native thinking blocks from both fresh and incremental history reads', async () => {
  const file = path.join(root, 'thinking.jsonl'); const cache = new SessionHistoryCache();
  const thought = JSON.stringify({ type: 'message', id: 'thought', parentId: 'a', timestamp: '2026-11-04T00:00:01Z', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '先核对目录。' }, { type: 'thinking', thinking: '再修改。' }, { type: 'text', text: '开始处理。' },
  ] } }) + '\n';
  fs.writeFileSync(file, line('a', null, 'previous')); await cache.read(file); fs.appendFileSync(file, thought);
  const messages = await cache.read(file);
  expect(messages[1]).toMatchObject({ thinking: '先核对目录。再修改。', text: '开始处理。' });
  expect(messages).toEqual(parseSessionJsonl(fs.readFileSync(file, 'utf8')));
});
