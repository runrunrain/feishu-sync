/**
 * 任务编排纯函数测试（S7）—— useAgentSessions 的 task_update SSE 合并语义
 * （isAgentTaskDto / mergeTaskIntoList / describeTaskNotice）与
 * useAgentOrchestration 的开关提取（extractOrchestrationEnabled）。
 * SSE 实时链路 = 同一合并函数，浏览器实测见 S7 报告。
 */

import { describe, expect, it } from 'vitest';
import {
  describeTaskNotice,
  isAgentTaskDto,
  mergeTaskIntoList,
} from './useAgentSessions';
import { extractOrchestrationEnabled } from './useAgentOrchestration';
import type { AgentTaskDto } from '../types/agent';

function makeTask(overrides: Partial<AgentTaskDto> = {}): AgentTaskDto {
  return {
    id: 'task_1',
    sessionId: 's_1',
    role: 'kb-analyst',
    title: '梳理源库结构',
    status: 'queued',
    queuePosition: 1,
    rounds: 0,
    outputDir: null,
    questions: null,
    result: null,
    resultTruncated: false,
    error: null,
    createdAt: '2026-10-27T10:00:00Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('isAgentTaskDto（task_update 负载判别）', () => {
  it('合法 DTO 通过', () => {
    expect(isAgentTaskDto(makeTask())).toBe(true);
    expect(isAgentTaskDto(makeTask({ status: 'interrupted' }))).toBe(true);
  });

  it('缺 id / 非法状态 / 非对象拒绝', () => {
    expect(isAgentTaskDto(null)).toBe(false);
    expect(isAgentTaskDto('task')).toBe(false);
    expect(isAgentTaskDto({ sessionId: 's', title: 't', status: 'running' })).toBe(false);
    expect(isAgentTaskDto(makeTask({ status: 'exploded' as AgentTaskDto['status'] }))).toBe(false);
  });
});

describe('mergeTaskIntoList（SSE task_update 刷新语义）', () => {
  it('新任务追加在尾，不重排既有项', () => {
    const a = makeTask({ id: 'a' });
    const b = makeTask({ id: 'b', status: 'running' });
    const merged = mergeTaskIntoList([a], b);
    expect(merged.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('同 id 原位替换（状态/轮次刷新）；不修改入参', () => {
    const a = makeTask({ id: 'a', status: 'running' });
    const b = makeTask({ id: 'b' });
    const list = [a, b];
    const merged = mergeTaskIntoList(list, makeTask({ id: 'a', status: 'done', rounds: 3 }));
    expect(merged.map((t) => t.status)).toEqual(['done', 'queued']);
    expect(merged[0].rounds).toBe(3);
    expect(list[0].status).toBe('running'); // 入参不变
    expect(merged).not.toBe(list);
  });
});

describe('describeTaskNotice（任务态变化 → 消息流提示行）', () => {
  it('queued/running 中间态不提示', () => {
    expect(describeTaskNotice(makeTask({ status: 'queued' }), undefined)).toBeNull();
    expect(
      describeTaskNotice(makeTask({ status: 'running' }), makeTask({ status: 'queued' })),
    ).toBeNull();
  });

  it('同状态轮次刷新不提示', () => {
    expect(
      describeTaskNotice(makeTask({ status: 'running', rounds: 2 }), makeTask({ status: 'running', rounds: 1 })),
    ).toBeNull();
  });

  it('进入 blocked/done/failed/cancelled/interrupted 各有提示', () => {
    expect(
      describeTaskNotice(makeTask({ status: 'blocked', questions: '范围？' }), makeTask({ status: 'running' })),
    ).toBe('任务「梳理源库结构」等待作答');
    expect(
      describeTaskNotice(makeTask({ status: 'done' }), makeTask({ status: 'running' })),
    ).toContain('已完成');
    expect(
      describeTaskNotice(
        makeTask({ status: 'failed', error: { code: 'model_timeout', message: '超时' } }),
        makeTask({ status: 'running' }),
      ),
    ).toContain('model_timeout');
    expect(
      describeTaskNotice(makeTask({ status: 'cancelled' }), makeTask({ status: 'queued' })),
    ).toContain('已取消');
    expect(
      describeTaskNotice(makeTask({ status: 'interrupted' }), undefined),
    ).toContain('已中断');
  });

  it('blocked 经作答再入 blocked（新一轮）仍提示', () => {
    const again = describeTaskNotice(
      makeTask({ status: 'blocked', rounds: 2 }),
      makeTask({ status: 'queued', rounds: 1 }),
    );
    expect(again).toContain('等待作答');
  });
});

describe('extractOrchestrationEnabled（编排开关提取）', () => {
  it('按 id 读取 enabled', () => {
    expect(extractOrchestrationEnabled([{ id: 'orchestration', enabled: true }])).toBe(true);
    expect(extractOrchestrationEnabled([{ id: 'orchestration', enabled: false }])).toBe(false);
  });

  it('条目缺失视为停用（旧数据降级）', () => {
    expect(extractOrchestrationEnabled([{ id: 'kb-style', enabled: true }])).toBe(false);
    expect(extractOrchestrationEnabled([])).toBe(false);
  });
});
