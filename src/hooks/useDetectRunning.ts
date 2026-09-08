/**
 * 订阅跨视图共享的「立即检测」运行态（utils/syncEvents 的 detect-running 广播）。
 *
 * 总览 GlobalStatusBar 与同步页 ChangeListPanel 的「立即检测」按钮是同一
 * 检测任务的两个入口；三个主视图常驻挂载、切换仅 hidden，两个按钮同时
 * 存活。两个入口共用本 hook 的返回值驱动禁用/「检测中」状态：任一入口
 * 发起检测后，两个按钮同步置灰，防止并发重复云端遍历。
 *
 * 挂载时先取模块现值再订阅——本视图未挂载/检测中途发起的场景下，重挂载
 * 也能立即恢复正确状态（listener 同步派发，无丢失窗口）。
 */

import { useEffect, useState } from 'react';
import { isDetectRunning, onDetectRunning } from '../utils/syncEvents';

export function useDetectRunning(): boolean {
  const [running, setRunning] = useState(isDetectRunning());
  useEffect(() => onDetectRunning(setRunning), []);
  return running;
}
