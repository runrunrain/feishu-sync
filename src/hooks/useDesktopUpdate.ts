/**
 * useDesktopUpdateBadge - 全局「有新版本」徽标信号（2026-09 内置更新）
 *
 * 挂在 App 根部：订阅主进程更新状态机（desktop:update:event），仅在
 * phase === 'available' 时暴露 latestVersion，供 TopBar 渲染可点击的
 * 「新版本」徽标。启动时 main.ts 会做一次静默检查，因此用户无需进入
 * 设置页即可感知新版本。
 *
 * 浏览器（dev:all，无 preload）下 window.desktop 不存在：静默无操作，
 * 徽标不渲染。下载/安装等动作仍归设置区「关于与更新」卡片所有。
 */

import { useEffect, useState } from 'react';
import { appLogger } from '../utils/appLogger';
import type { DesktopUpdateState } from '../types';

export interface DesktopUpdateBadge {
  /** phase === 'available' 时为最新版本号，否则 null（不渲染徽标）。 */
  availableVersion: string | null;
}

export function useDesktopUpdateBadge(): DesktopUpdateBadge {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !window.desktop ||
      !window.desktop.update ||
      typeof window.desktop.update.onEvent !== 'function'
    ) {
      return;
    }
    const updateApi = window.desktop.update;

    const apply = (state: DesktopUpdateState) => {
      setAvailableVersion(state.phase === 'available' ? state.latestVersion ?? '' : null);
    };

    updateApi.getState().then(apply).catch((err) => {
      appLogger.warn('update-badge', 'getState failed (non-fatal)', err);
    });
    return updateApi.onEvent((event) => apply(event.state));
  }, []);

  return { availableVersion };
}
