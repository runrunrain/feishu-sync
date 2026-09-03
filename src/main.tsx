/**
 * 渲染入口 - 桌面端界面缩放（2026-09 高分屏文本模糊缓解）
 *
 * Win 125%/150% 等非整数 DPI 缩放下，文本光栅化出现半像素发虚。提供
 * VSCode 同款缩放快捷键，让用户微调到整数物理像素倍率显著改善清晰度：
 *   Ctrl+= / Ctrl++   放大（zoomLevel +0.25）
 *   Ctrl+-            缩小（zoomLevel -0.25）
 *   Ctrl+0            重置（zoomLevel 0）
 * 持久化到 localStorage，启动时最先恢复（React 挂载前，避免闪烁）。
 * 浏览器 dev 环境无 window.desktop 时静默跳过（浏览器有自己的缩放）。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

const ZOOM_STORAGE_KEY = 'feishu-sync:zoom-level';

function clampLevel(level: number): number {
  return Math.max(-3, Math.min(3, level));
}

function currentLevel(desktop: NonNullable<Window['desktop']>): number {
  return desktop.getZoomLevel?.() ?? 0;
}

function persistLevel(level: number): void {
  if (level === 0) {
    window.localStorage.removeItem(ZOOM_STORAGE_KEY);
  } else {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(level));
  }
}

/** 缩放 OSD 浮层：短暂显示当前倍率（如「界面缩放 125%」），既是用户
 * 反馈，也是桌面端快捷键链路是否生效的可视确认。纯 DOM，无 React 依赖。 */
let zoomOsdTimer: number | undefined;
function showZoomOsd(level: number): void {
  const factor = Math.round(Math.exp(level) * 100);
  let osd = document.getElementById('zoom-osd');
  if (!osd) {
    osd = document.createElement('div');
    osd.id = 'zoom-osd';
    osd.style.cssText =
      'position:fixed;right:24px;bottom:24px;z-index:9999;padding:6px 14px;'
      + 'border-radius:8px;background:rgba(30,30,30,0.85);color:#fff;'
      + 'font-size:13px;font-family:system-ui,sans-serif;pointer-events:none;'
      + 'transition:opacity 0.3s;opacity:0;';
    document.body.appendChild(osd);
  }
  osd.textContent = level === 0 ? '界面缩放 已重置（100%）' : `界面缩放 ${factor}%`;
  requestAnimationFrame(() => { osd!.style.opacity = '1'; });
  if (zoomOsdTimer != null) window.clearTimeout(zoomOsdTimer);
  zoomOsdTimer = window.setTimeout(() => { osd!.style.opacity = '0'; }, 1600);
}

function restoreZoomLevel(): void {
  const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
  if (!desktop?.setZoomLevel) return;
  const raw = window.localStorage.getItem(ZOOM_STORAGE_KEY);
  const level = raw != null ? Number.parseFloat(raw) : Number.NaN;
  if (Number.isFinite(level) && level !== 0) {
    desktop.setZoomLevel(clampLevel(level));
  }
}

function installZoomShortcuts(): void {
  const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
  if (!desktop?.setZoomLevel) return;
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    // '=' 与 '+' 同键位（Shift+=）；数字键盘 + 也是 '+'。
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      const next = clampLevel(currentLevel(desktop) + 0.25);
      desktop.setZoomLevel(next);
      persistLevel(next);
      showZoomOsd(next);
    } else if (e.key === '-') {
      e.preventDefault();
      const next = clampLevel(currentLevel(desktop) - 0.25);
      desktop.setZoomLevel(next);
      persistLevel(next);
      showZoomOsd(next);
    } else if (e.key === '0') {
      e.preventDefault();
      desktop.setZoomLevel(0);
      persistLevel(0);
      showZoomOsd(0);
    }
  });
}

// 在 React 挂载前恢复缩放，避免首帧闪烁。
restoreZoomLevel();
installZoomShortcuts();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
