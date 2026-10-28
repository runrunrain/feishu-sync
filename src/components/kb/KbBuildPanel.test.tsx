/**
 * KbBuildPanel 组件测试（S5）—— renderToStaticMarkup 锚定：
 * 多 worker / 单元 / 图片细粒度进度（S4 §4.6 progress DTO）、
 * images_unavailable 警告徽标与「去设置」引导、零值进度（W=1 等价回退 /
 * 终态）不渲染并行条、失败/重试计数。SSR 不执行 effect，面板内 progress
 * 轮询不触发（真机浏览器验证见 S5-report）；数据形状与 server
 * progressOf() 零值结构对齐。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KbBuildPanel, type BuildLogLine } from './KbBuildPanel';
import type { KbBuildDto, KbBuildProgressDto } from '../../types/agent';

function makeProgress(over: Partial<KbBuildProgressDto> = {}): KbBuildProgressDto {
  return {
    batchIndex: 2,
    batchTotal: 6,
    stage: 'units',
    units: { total: 3, done: 1, running: 2, failed: 0, retried: 0 },
    workers: [
      { workerId: 'w1', state: 'running', unitId: 'u2', unitBatchIndex: 1, unitBatchTotal: 4 },
      { workerId: 'w2', state: 'running', unitId: 'u3', unitBatchIndex: 3, unitBatchTotal: 5 },
      { workerId: 'w3', state: 'waiting_slot', unitId: null, unitBatchIndex: 0, unitBatchTotal: 0 },
    ],
    images: { total: 6, described: 2, cached: 1, unavailable: 3 },
    ...over,
  };
}

function makeBuild(over: Partial<KbBuildDto> = {}): KbBuildDto {
  return {
    id: 'kb-b1',
    mode: 'incremental',
    status: 'running',
    noChanges: false,
    baseReleaseId: null,
    releaseId: null,
    model: 'glm-4.7',
    counts: { sourceTotal: 30, added: 2, changed: 1, removed: 0, docsWritten: 0, docsDeleted: 0 },
    progress: makeProgress(),
    parallelism: 3,
    warnings: [],
    error: null,
    createdAt: '2026-10-27T10:00:00Z',
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

const LOGS: BuildLogLine[] = [];

function render(build: KbBuildDto, layout: 'bottom' | 'sidebar' = 'bottom'): string {
  return renderToStaticMarkup(
    <KbBuildPanel
      open
      build={build}
      issues={[]}
      logs={LOGS}
      onCollapse={() => undefined}
      onCancel={() => undefined}
      cancelling={false}
      layout={layout}
    />,
  );
}

describe('KbBuildPanel 并行进度（S4/S5）', () => {
  it('多 worker 运行态：并行度、细粒度阶段、单元计数与 worker 徽标', () => {
    const html = render(makeBuild());
    expect(html).toContain('data-build-status="running"');
    expect(html).toContain('并行 3');
    expect(html).toContain('data-testid="kb-build-stage"');
    expect(html).toContain('单元生成');
    expect(html).toContain('单元 1/3');
    expect(html).toContain('进行 2');
    // worker 徽标：w1 在 u2、批 2/4（unitBatchIndex 0 基）；w3 等待进程槽位。
    expect(html).toMatch(/<span[^>]*data-worker-id="w1"[^>]*>/);
    expect(html).toContain('u2');
    expect(html).toContain('批 2/4');
    expect(html).toContain('批 4/5');
    expect(html).toContain('等待进程');
    expect(html).toMatch(/data-worker-state="waiting_slot"/);
  });

  it('worker 收尾与退出态徽标', () => {
    const html = render(
      makeBuild({
        progress: makeProgress({
          stage: 'finishing',
          workers: [
            { workerId: 'w1', state: 'finishing', unitId: 'u2', unitBatchIndex: 4, unitBatchTotal: 4 },
            { workerId: 'w2', state: 'exited', unitId: null, unitBatchIndex: 0, unitBatchTotal: 0 },
          ],
        }),
      }),
    );
    expect(html).toContain('收尾合并');
    expect(html).toMatch(/data-worker-state="finishing"/);
    expect(html).toContain('收尾中');
    expect(html).toMatch(/data-worker-state="exited"/);
    expect(html).toContain('已退出');
  });

  it('单元失败/重试计数可见', () => {
    const html = render(
      makeBuild({
        progress: makeProgress({
          units: { total: 3, done: 0, running: 1, failed: 1, retried: 1 },
          workers: [{ workerId: 'w1', state: 'running', unitId: 'u1', unitBatchIndex: 0, unitBatchTotal: 2 }],
        }),
      }),
    );
    expect(html).toContain('重试 1');
    expect(html).toContain('失败 1');
  });

  it('图片维度：已理解（含缓存）/ 未理解计数', () => {
    const html = render(makeBuild());
    expect(html).toContain('data-testid="kb-build-images"');
    expect(html).toContain('图片 已理解 3/6（缓存 1');
    expect(html).toContain('3 张未理解');
  });

  it('describing_images 阶段标签', () => {
    const html = render(
      makeBuild({
        progress: makeProgress({ stage: 'describing_images', workers: [], units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 } }),
      }),
    );
    expect(html).toContain('图片理解');
  });
});

describe('KbBuildPanel 构建警告（S3/S5）', () => {
  it('images_unavailable：警告文案 + 设置引导', () => {
    const html = render(
      makeBuild({
        warnings: [
          {
            code: 'images_unavailable',
            count: 3,
            message: '3/8 张图片未理解（图片理解未配置）；图片引用处已插入 unavailable 标记',
          },
        ],
      }),
    );
    expect(html).toContain('data-testid="kb-build-warnings"');
    expect(html).toMatch(/data-warning-code="images_unavailable"/);
    expect(html).toContain('图片未理解');
    expect(html).toContain('3/8 张图片未理解');
    expect(html).toContain('设置 → Agent 运行时与模型 → 图片理解');
  });

  it('发布成功仍携带警告（非失败态展示）', () => {
    const html = render(
      makeBuild({
        status: 'published',
        warnings: [{ code: 'images_unavailable', count: 2, message: '2/5 张图片未理解（图片理解通道部分失败）' }],
        progress: makeProgress({ stage: null }),
      }),
    );
    expect(html).toContain('已发布');
    expect(html).toContain('data-testid="kb-build-warnings"');
  });
});

describe('KbBuildPanel 零值与终态', () => {
  const ZERO_PROGRESS: KbBuildProgressDto = {
    batchIndex: 0,
    batchTotal: 0,
    stage: null,
    units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 },
    workers: [],
    images: { total: 0, described: 0, cached: 0, unavailable: 0 },
  };

  it('零值进度（W=1 等价回退）不渲染并行条，也无并行度徽标', () => {
    const html = render(makeBuild({ parallelism: 1, progress: ZERO_PROGRESS }));
    expect(html).not.toContain('data-testid="kb-build-parallel"');
    expect(html).not.toContain('并行 1');
    expect(html).not.toContain('data-testid="kb-build-warnings"');
  });

  it('仅图片维度有数据时只渲染图片行（无 worker/单元）', () => {
    const html = render(
      makeBuild({
        progress: makeProgress({
          stage: 'describing_images',
          units: { total: 0, done: 0, running: 0, failed: 0, retried: 0 },
          workers: [],
          images: { total: 4, described: 0, cached: 4, unavailable: 0 },
        }),
      }),
    );
    expect(html).toContain('data-testid="kb-build-parallel"');
    expect(html).not.toContain('data-testid="kb-build-workers"');
    expect(html).toContain('图片 已理解 4/4（缓存 4）');
    expect(html).not.toContain('张未理解');
  });

  it('sidebar 布局同样渲染并行条', () => {
    const html = render(makeBuild(), 'sidebar');
    expect(html).toContain('data-testid="kb-build-parallel"');
    expect(html).toMatch(/data-worker-id="w1"/);
  });
});
