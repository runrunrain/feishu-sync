import { describe, expect, it } from 'vitest';
import { LarkCliError } from '../src/modules/lark-cli-client.js';
import { classifySyncFailure, requiresFeishuSideAction } from '../src/modules/sync-engine.js';

describe('sync failure retry classification', () => {
  it('does not offer a retry for a permission-denied node', () => {
    expect(classifySyncFailure(new LarkCliError('无权限访问该节点', 'permission', false)))
      .toMatchObject({
        retryable: false,
        reasonCode: 'permission_denied',
        repairAction: 'grant_access',
        message: expect.stringContaining('无权限'),
      });
  });

  it('does not offer a retry for a cloud-deleted page', () => {
    expect(classifySyncFailure(new LarkCliError('deleted', 'deleted', false, '3380003')))
      .toMatchObject({
        retryable: false,
        reasonCode: 'cloud_deleted',
        repairAction: 'review_deleted',
        message: expect.stringContaining('已删除'),
      });
  });

  it('keeps rate-limit retries available', () => {
    expect(classifySyncFailure(new LarkCliError('QPS 限频，请稍后重试', 'rate_limited', true)))
      .toMatchObject({ retryable: true, reasonCode: 'rate_limited', repairAction: 'retry' });
  });

  it('only queues failures that require an operator action in Feishu', () => {
    expect(requiresFeishuSideAction({ repairAction: 'grant_access' })).toBe(true);
    expect(requiresFeishuSideAction({ repairAction: 'review_deleted' })).toBe(true);
    expect(requiresFeishuSideAction({ repairAction: 'enable_export_adapter' })).toBe(true);
    expect(requiresFeishuSideAction({ repairAction: 'retry' })).toBe(false);
    expect(requiresFeishuSideAction({ repairAction: 'rebuild_parent_chain' })).toBe(false);
  });
});
