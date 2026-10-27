/**
 * Agent 就绪文案 + 会话消息合并 + 写入记录提取 单测
 */

import { describe, expect, it } from 'vitest';
import { describeReadinessCode, formatRelativeTime, formatDateTime } from './agentReadiness';
import { extractWriteRecords, isAgentMessageDto, mergeMessageIntoList } from '../hooks/useAgentSessions';
import type { AgentMessageDto, AgentStatusDto } from '../types/agent';

function statusOf(code: AgentStatusDto['code']): AgentStatusDto {
  return {
    code,
    message: '',
    runtime: {
      nodePath: '/usr/local/bin/node',
      nodeVersion: 'v24.21.0',
      piCliPath: '/x/pi',
      piVersion: '1.4.0',
      supportedRange: '>=1.4.0 <2.0.0',
    },
    model: { source: 'app-llm', model: 'feishu-sync-llm/glm-4.6', available: ['feishu-sync-llm/glm-4.6'] },
    processes: { running: 0, max: 2 },
    checkedAt: '2026-10-27T00:00:00.000Z',
  };
}

describe('describeReadinessCode', () => {
  it('ready 无需跳转与重检', () => {
    const copy = describeReadinessCode('ready');
    expect(copy.jumpSettings).toBe(false);
    expect(copy.recheck).toBe(false);
  });

  it('环境类问题给出原因/动作/跳转（node_missing 等）', () => {
    for (const code of ['node_missing', 'pi_missing', 'pi_version_unsupported', 'model_unconfigured'] as const) {
      const copy = describeReadinessCode(code, statusOf(code));
      expect(copy.reason.length).toBeGreaterThan(0);
      expect(copy.action.length).toBeGreaterThan(0);
      expect(copy.jumpSettings).toBe(true);
      expect(copy.recheck).toBe(true);
    }
  });

  it('node_too_old 带出实测版本号', () => {
    const copy = describeReadinessCode('node_too_old', statusOf('node_too_old'));
    expect(copy.reason).toContain('v24.21.0');
  });

  it('pi_version_unsupported 展示支持范围', () => {
    const copy = describeReadinessCode('pi_version_unsupported', statusOf('pi_version_unsupported'));
    expect(copy.action).toContain('>=1.4.0 <2.0.0');
  });

  it('model_auth_missing 按 source 区分提示', () => {
    const appLlm = describeReadinessCode('model_auth_missing', statusOf('model_auth_missing'));
    const piDir = describeReadinessCode('model_auth_missing', {
      ...statusOf('model_auth_missing'),
      model: { source: 'pi-agent-dir', model: null, available: [] },
    });
    expect(appLlm.action).toContain('API Key');
    expect(piDir.action).toContain('pi');
  });
});

describe('message_end DTO运行时边界', () => {
  it('缺id/role/at的Partial不能污染消息列表', () => {
    expect(isAgentMessageDto({ text: '错误的Partial' })).toBe(false);
    expect(isAgentMessageDto({ id: 'x', role: 'assistant' })).toBe(false);
    expect(isAgentMessageDto({ id: 'x', role: 'assistant', at: '2026-10-26T00:00:00Z', text: '完整消息' })).toBe(true);
  });
});

describe('mergeMessageIntoList（SSE message_end 合并语义）', () => {
  const OPT = 'local-';
  const userMsg = (id: string, text: string): AgentMessageDto => ({
    id,
    role: 'user',
    at: '2026-10-27T00:00:01.000Z',
    text,
  });

  it('权威 user 消息替换同文本乐观行（不重复）', () => {
    const prev: AgentMessageDto[] = [
      userMsg(`${OPT}1`, '帮我分析'),
      { id: 'm0', role: 'assistant', at: '', text: '旧回复' },
    ];
    const next = mergeMessageIntoList(prev, userMsg('srv-1', '帮我分析'), OPT);
    expect(next.map((m) => m.id)).toEqual(['m0', 'srv-1']);
  });

  it('同 id 原位替换（流式收尾重放幂等）', () => {
    const prev: AgentMessageDto[] = [{ id: 'srv-2', role: 'assistant', at: '', text: '部分' }];
    const next = mergeMessageIntoList(
      prev,
      { id: 'srv-2', role: 'assistant', at: '', text: '最终' },
      OPT,
    );
    expect(next).toHaveLength(1);
    expect(next[0]?.text).toBe('最终');
  });

  it('新消息追加且不改旧数组（纯函数）', () => {
    const prev = [userMsg('srv-1', '一')];
    const next = mergeMessageIntoList(
      prev,
      { id: 'srv-2', role: 'assistant', at: '', text: '二' },
      OPT,
    );
    expect(prev).toHaveLength(1);
    expect(next.map((m) => m.id)).toEqual(['srv-1', 'srv-2']);
  });

  it('乐观行不匹配不同文本时保留（双击发送场景）', () => {
    const prev = [userMsg(`${OPT}1`, '问题A')];
    const next = mergeMessageIntoList(prev, userMsg('srv-9', '问题B'), OPT);
    expect(next.map((m) => m.id)).toEqual([`${OPT}1`, 'srv-9']);
  });
});

describe('extractWriteRecords（Work 写入记录）', () => {
  it('只提取 ws_write/ws_edit/ws_mkdir，最近在前，含路径与错误态', () => {
    const messages: AgentMessageDto[] = [
      {
        id: 't1',
        role: 'tool',
        at: '2026-10-27T00:00:01.000Z',
        tool: { callId: 'c1', name: 'ws_write', isError: false, resultSummary: '写入 /ws/设计.md（2.1KB）' },
      },
      {
        id: 't2',
        role: 'tool',
        at: '2026-10-27T00:00:02.000Z',
        tool: { callId: 'c2', name: 'kb_read', isError: false, resultSummary: '读取 kd_x' },
      },
      {
        id: 't3',
        role: 'tool',
        at: '2026-10-27T00:00:03.000Z',
        tool: { callId: 'c3', name: 'ws_edit', isError: true, resultSummary: 'oldText 不唯一：/ws/a.md' },
      },
    ];
    const records = extractWriteRecords(messages);
    expect(records).toHaveLength(2);
    expect(records[0]?.tool).toBe('ws_edit');
    expect(records[0]?.ok).toBe(false);
    expect(records[0]?.path).toBe('/ws/a.md');
    expect(records[1]?.path).toBe('/ws/设计.md');
  });
});

describe('时间格式化', () => {
  it('formatRelativeTime 分级', () => {
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    expect(formatRelativeTime('2026-10-27T11:59:40.000Z', now)).toBe('刚刚');
    expect(formatRelativeTime('2026-10-27T11:30:00.000Z', now)).toBe('30 分钟前');
    expect(formatRelativeTime('2026-10-27T08:00:00.000Z', now)).toBe('4 小时前');
    expect(formatRelativeTime('2026-10-25T12:00:00.000Z', now)).toBe('2 天前');
    expect(formatRelativeTime(null, now)).toBe('');
    expect(formatRelativeTime('garbage', now)).toBe('');
  });

  it('formatDateTime 兜底 —', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDateTime('2026-10-27T04:05:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
