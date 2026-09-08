/**
 * syncEvents — 跨视图共享「立即检测」运行态测试。
 *
 * 背景（2026-11 修复）：总览 GlobalStatusBar 与同步页 ChangeListPanel 的
 * 「立即检测」是同一任务的两个入口，此前各自维护本地 detecting 状态，
 * 互不可见，可分别点击触发并发云端遍历。共享运行态契约：
 *   1. setDetectRunning 翻转时同步广播给所有订阅者；
 *   2. isDetectRunning 反映模块现值（供点击回调做双保险互斥）；
 *   3. 幂等翻转（同值不广播）+ 订阅隔离（单个订阅者异常不影响其余）；
 *   4. 取消订阅后不再收广播。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  setDetectRunning,
  isDetectRunning,
  onDetectRunning,
} from './syncEvents';

describe('detect-running shared state', () => {
  it('flips the running flag and notifies subscribers synchronously', () => {
    const seen: Array<{ running: boolean; source: string }> = [];
    const unsubscribe = onDetectRunning((running, source) => {
      seen.push({ running, source });
    });

    expect(isDetectRunning()).toBe(false);
    setDetectRunning(true, 'change-list-panel');
    expect(isDetectRunning()).toBe(true);
    // 同步派发：翻转即送达，无丢失窗口（另一入口的按钮立即置灰）。
    expect(seen).toEqual([{ running: true, source: 'change-list-panel' }]);

    setDetectRunning(false, 'change-list-panel');
    expect(isDetectRunning()).toBe(false);
    expect(seen).toEqual([
      { running: true, source: 'change-list-panel' },
      { running: false, source: 'change-list-panel' },
    ]);

    unsubscribe();
    // 恢复基线，避免影响其他用例（模块级共享状态）。
    setDetectRunning(false, 'test-cleanup');
  });

  it('does not broadcast on idempotent flips', () => {
    setDetectRunning(false, 'reset');
    const listener = vi.fn();
    const unsubscribe = onDetectRunning(listener);

    setDetectRunning(false, 'global-status-bar');
    expect(listener).not.toHaveBeenCalled();

    setDetectRunning(true, 'global-status-bar');
    setDetectRunning(true, 'global-status-bar');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setDetectRunning(false, 'test-cleanup');
  });

  it('isolates a throwing subscriber from the others', () => {
    setDetectRunning(false, 'reset');
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('listener boom');
    });
    const unsubscribeBad = onDetectRunning(bad);
    const unsubscribeGood = onDetectRunning(good);

    expect(() => setDetectRunning(true, 'change-list-panel')).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(isDetectRunning()).toBe(true);

    unsubscribeBad();
    unsubscribeGood();
    setDetectRunning(false, 'test-cleanup');
  });

  it('stops delivering after unsubscribe', () => {
    setDetectRunning(false, 'reset');
    const listener = vi.fn();
    const unsubscribe = onDetectRunning(listener);

    setDetectRunning(true, 'a');
    unsubscribe();
    setDetectRunning(false, 'b');

    expect(listener).toHaveBeenCalledTimes(1);
    setDetectRunning(false, 'test-cleanup');
  });
});
