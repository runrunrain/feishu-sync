/**
 * SseParser 单测（F2 SSE 客户端核心解析逻辑）
 *
 * 覆盖：event/data/id 分发、多行 data 合并、CRLF/CR/LF 三种行尾、
 * 注释行、块跨 chunk 截断（含半个多字节…以 UTF-8 解码后喫入为前提）、
 * id 含 NUL 忽略、空 data 事件丢弃、Last-Event-ID 游标。
 */

import { describe, expect, it, vi } from 'vitest';
import { SseParser, SseConnection, type SseMessage } from './sseStream';

it('构建恢复从已加载状态的游标接收新事件，避免旧失败状态重放', async () => {
  let request: Request | undefined;
  const connection = new SseConnection({ endpoint: '/events', initialLastEventId: '110',
    getAuth: async () => ({ baseUrl: 'http://localhost', headers: {} }), onMessage: vi.fn(), maxRetries: 0 });
  vi.stubGlobal('fetch', async (value: Request) => { request = value; connection.stop(); return new Response(null, { status: 500 }); });
  try { await connection.start(); expect(request?.headers.get('Last-Event-ID')).toBe('110'); }
  finally { vi.unstubAllGlobals(); }
});

function drain(): SseMessage[] {
  const out: SseMessage[] = [];
  return out;
}

describe('SseParser', () => {
  it('解析基础 event/data 并分发', () => {
    const got: SseMessage[] = [];
    const p = new SseParser((m) => got.push(m));
    p.feed('event: text_delta\ndata: {"delta":"你"}\n\n');
    expect(got).toEqual([{ event: 'text_delta', data: '{"delta":"你"}', id: undefined }]);
  });

  it('多行 data 以 \\n 连接', () => {
    const got: SseMessage[] = [];
    const p = new SseParser((m) => got.push(m));
    p.feed('data: line1\ndata: line2\n\n');
    expect(got[0]?.data).toBe('line1\nline2');
  });

  it('默认 event 为 message；冒号后允一个空格', () => {
    const got: SseMessage[] = [];
    const p = new SseParser((m) => got.push(m));
    p.feed('data:nospace\ndata: spaced\n\n');
    expect(got[0]).toEqual({ event: 'message', data: 'nospace\nspaced', id: undefined });
  });

  it('CRLF 与孤立 CR 均作行尾', () => {
    const got: SseMessage[] = [];
    const p = new SseParser((m) => got.push(m));
    p.feed('event: a\r\ndata: 1\r\r');
    p.feed('event: b\r\ndata: 2\n\n');
    expect(got.map((m) => m.event)).toEqual(['a', 'b']);
    expect(got.map((m) => m.data)).toEqual(['1', '2']);
  });

  it('事件跨 chunk 截断后仍完整分发', () => {
    const got: SseMessage[] = [];
    const p = new SseParser((m) => got.push(m));
    p.feed('event: tool\nda');
    p.feed('ta: {"n":1}\n');
    p.feed('\n');
    expect(got).toEqual([{ event: 'tool', data: '{"n":1}', id: undefined }]);
  });

  it('注释行与心跳不产生事件', () => {
    const got: SseMessage[] = [];
    const p = new SseParser((m) => got.push(m));
    p.feed(': keep-alive\n\n');
    p.feed(': ping\ndata: real\n\n');
    expect(got.length).toBe(1);
    expect(got[0]?.data).toBe('real');
  });

  it('id 记录游标且含 NUL 被忽略；无 data 的事件不分发', () => {
    const got: SseMessage[] = [];
    const p = new SseParser((m) => got.push(m));
    p.feed('id: 42\ndata: x\n\n');
    p.feed('id: bad\u0000id\nevent: no-data\n\n');
    expect(p.lastEventId).toBe('42');
    expect(got.length).toBe(1);
  });

  it('多个事件依序分发（会话流：run_start → text_delta → message_end）', () => {
    const got: SseMessage[] = [];
    const p = new SseParser((m) => got.push(m));
    p.feed(
      [
        'id: 1',
        'event: run_start',
        'data: {"runId":"r1"}',
        '',
        'id: 2',
        'event: text_delta',
        'data: {"runId":"r1","delta":"设计"}',
        '',
        'id: 3',
        'event: message_end',
        'data: {"runId":"r1","message":{"id":"m1"}}',
        '',
      ].join('\n'),
    );
    expect(got.map((m) => m.event)).toEqual(['run_start', 'text_delta', 'message_end']);
    expect(p.lastEventId).toBe('3');
  });

  it('drain helper import shape（类型/存在性烟测）', () => {
    expect(typeof drain).toBe('function');
    expect(typeof SseParser).toBe('function');
  });
});
