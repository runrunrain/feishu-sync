/**
 * CloudDiffModal SSR 测试（P0-S5）——两种呈现态：
 *   - 双侧可读：行级 diff 渲染（+/- 行、统计徽标、行号）
 *   - 云端不可读：诚实的不可读面板 + 本地正文预览（契约缺口态）
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { CloudDiffModal } from './CloudDiffModal';

const LOCAL = [
  '# 需求草案',
  '',
  '## 背景',
  '旧：同步只覆盖结构树成员。',
  '新增：自定义归档也参与检测。',
].join('\n');

const CLOUD = [
  '# 需求草案',
  '',
  '## 背景',
  '同步只覆盖结构树成员。',
  '## 范围',
  'v1 不含自定义归档。',
].join('\n');

describe('CloudDiffModal 双侧可读：行级 diff 渲染', () => {
  it('渲染 +/- 行与统计徽标（data-diff-kind 可锚定）', () => {
    const html = renderToStaticMarkup(
      <CloudDiffModal
        open
        onClose={() => {}}
        title="对比云端与本地 · 测试"
        left={{ label: '云端当前正文', body: CLOUD }}
        right={{ label: '本地当前正文', body: LOCAL }}
      />,
    );
    expect(html).toContain('data-diff-kind="+"');
    expect(html).toContain('data-diff-kind="-"');
    // 徽标内嵌图标 svg，标签与计数分开断言（右=+，左=−）。
    expect(html).toContain('本地当前正文');
    expect(html).toContain('+2');
    expect(html).toContain('云端当前正文');
    expect(html).toContain('−3');
    expect(html).toContain('旧：同步只覆盖结构树成员。');
    expect(html).toContain('v1 不含自定义归档。');
    expect(html).not.toContain('云端正文暂不可读');
  });

  it('两侧一致：呈现「两侧正文一致」态', () => {
    const html = renderToStaticMarkup(
      <CloudDiffModal
        open
        onClose={() => {}}
        title="t"
        left={{ label: '云端', body: LOCAL }}
        right={{ label: '本地', body: LOCAL }}
      />,
    );
    expect(html).toContain('两侧正文一致，没有差异');
  });
});

describe('CloudDiffModal 云端不可读：诚实降级态', () => {
  it('body=null 呈不可读面板与原因，不渲染假 diff', () => {
    const html = renderToStaticMarkup(
      <CloudDiffModal
        open
        onClose={() => {}}
        title="对比云端与本地 · 写回冲突"
        note="时间门拦截说明"
        left={{ label: '云端当前正文', body: null, unavailableReason: '通道尚未接入说明文案' }}
        right={{ label: '本地当前正文', body: LOCAL }}
      />,
    );
    expect(html).toContain('云端正文暂不可读');
    expect(html).toContain('通道尚未接入说明文案');
    expect(html).not.toContain('data-diff-kind="+"');
    // 本地正文预览仍可见。
    expect(html).toContain('# 需求草案');
    expect(html).toContain('本地当前正文（5 行');
  });
});

describe('CloudDiffModal 读取中态（T4b-08：宿主真实拉取云端当前正文）', () => {
  it('loading=true 呈「正在读取」面板，不误报不可读、不渲染假 diff；可读侧预览保留', () => {
    const html = renderToStaticMarkup(
      <CloudDiffModal
        open
        onClose={() => {}}
        title="对比云端与本地 · 写回冲突"
        left={{ label: '云端当前正文', body: null, loading: true }}
        right={{ label: '本地当前正文', body: LOCAL }}
      />,
    );
    expect(html).toContain('正在读取云端当前正文');
    expect(html).not.toContain('云端正文暂不可读');
    expect(html).not.toContain('data-diff-kind="+"');
    expect(html).toContain('本地当前正文（5 行');
  });
});
