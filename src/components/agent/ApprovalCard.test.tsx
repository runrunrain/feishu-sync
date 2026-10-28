/**
 * ApprovalCard 组件测试（S10）—— renderToStaticMarkup 锚定：
 * 命令名 / 风险级 / 参数摘要 / 倒计时 / 批准与拒绝按钮 / 超时禁用。
 * 交互行为（点击回调）由静态禁用态 + 回调签名锚定，浏览器实测见验收。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard, formatCountdown } from './ApprovalCard';
import type { AgentApprovalDto } from '../../types/agent';

function makeApproval(overrides: Partial<AgentApprovalDto> = {}): AgentApprovalDto {
  return {
    id: 'apr_1',
    sessionId: 's_1',
    command: 'kb.build',
    risk: 'mutate',
    argsSummary: '{"mode":"full"}',
    expiresAt: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('formatCountdown', () => {
  it('剩余时间格式 mm:ss', () => {
    const now = Date.now();
    const expires = now + (5 * 60 + 7) * 1000;
    expect(formatCountdown(new Date(expires).toISOString(), now)).toBe('5:07');
  });

  it('过期/非法 → null', () => {
    expect(formatCountdown(new Date(Date.now() - 1000).toISOString(), Date.now())).toBeNull();
    expect(formatCountdown('not-a-date', Date.now())).toBeNull();
  });
});

describe('ApprovalCard', () => {
  const onDecide = vi.fn();

  it('呈现命令名、风险级、参数摘要、倒计时与批准/拒绝按钮', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={makeApproval()} onDecide={onDecide} />,
    );
    expect(html).toContain('kb.build');
    expect(html).toContain('写入');
    expect(html).toContain('{&quot;mode&quot;:&quot;full&quot;}');
    expect(html).toContain('后超时');
    expect(html).toMatch(/data-testid="approval-approve"/);
    expect(html).toMatch(/data-testid="approval-reject"/);
    expect(html).not.toContain('disabled=""');
  });

  it('destructive 级呈现破坏性标签与警示图标', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={makeApproval({ risk: 'destructive', command: 'clean.trash.purge' })} onDecide={onDecide} />,
    );
    expect(html).toContain('破坏性');
    expect(html).toContain('data-risk="destructive"');
  });

  it('超时后按钮禁用（过期卡片不可再裁决）', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={makeApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() })} onDecide={onDecide} />,
    );
    expect(html).toContain('已超时');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="approval-approve"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="approval-reject"/);
  });

  it('裁决中（busy）按钮禁用防双击', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={makeApproval()} onDecide={onDecide} busy />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="approval-approve"/);
    expect(html).toContain('正在提交裁决');
  });

  it('空参数摘要显示占位', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={makeApproval({ argsSummary: '' })} onDecide={onDecide} />,
    );
    expect(html).toContain('（无参数）');
  });
});
