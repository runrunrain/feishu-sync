/**
 * KbPendingImagesHint 组件测试（S3/S5）—— /api/kb/changes 的 images 维度
 * （total/uncached）在「待更新差异」页的呈现锚定：未缓存计数与设置引导、
 * 全缓存态、零图片不渲染。完整 KbChangesPanel 交互由真机浏览器验证。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KbPendingImagesHint } from './KbChangesPanel';

describe('KbPendingImagesHint', () => {
  it('有未缓存图片：计数 + 「未理解」标记与设置引导', () => {
    const html = renderToStaticMarkup(<KbPendingImagesHint images={{ total: 12, uncached: 12 }} />);
    expect(html).toContain('data-testid="kb-pending-images"');
    expect(html).toContain('待处理源引用图片约 12 张');
    expect(html).toContain('12 张尚未缓存');
    expect(html).toContain('「未理解」标记');
    expect(html).toContain('设置 → Agent');
  });

  it('部分缓存：分别展示 total 与 uncached', () => {
    const html = renderToStaticMarkup(<KbPendingImagesHint images={{ total: 12, uncached: 5 }} />);
    expect(html).toContain('待处理源引用图片约 12 张');
    expect(html).toContain('5 张尚未缓存');
  });

  it('全部已缓存：不出现未理解警告', () => {
    const html = renderToStaticMarkup(<KbPendingImagesHint images={{ total: 8, uncached: 0 }} />);
    expect(html).toContain('均已有缓存描述');
    expect(html).not.toContain('未理解');
  });

  it('零图片：不渲染', () => {
    expect(renderToStaticMarkup(<KbPendingImagesHint images={{ total: 0, uncached: 0 }} />)).toBe('');
  });
});
