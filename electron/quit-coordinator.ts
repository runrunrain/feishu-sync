/**
 * Quit Coordinator
 *
 * Manages graceful shutdown sequence across Electron components.
 * Coordinates server shutdown, cleanup, and application exit.
 *
 * Adapted from tts-voice-generator/quit-coordinator.ts
 */

import { app, type Event } from 'electron';
import type { DesktopActionResult, QuitReason } from './contracts.js';

type QuitCoordinatorOptions = {
  closeServer: () => Promise<void>;
  onBeforeQuit?: (reason: QuitReason) => void;
  sanitizeError: (error: unknown) => string;
};

/** 优雅关闭的总宽限时长；超时后强制退出，保证应用永远不会关不掉。 */
const FORCE_EXIT_TIMEOUT_MS = 5_000;

export class QuitCoordinator {
  private quitRequested = false;
  private shutdownComplete = false;
  private activeQuit: Promise<DesktopActionResult> | null = null;
  private quitReason: QuitReason | null = null;
  private forceExitTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: QuitCoordinatorOptions) {}

  isQuitRequested() {
    return this.quitRequested;
  }

  isShutdownComplete() {
    return this.shutdownComplete;
  }

  getQuitReason() {
    return this.quitReason;
  }

  async prepareForQuit(reason: QuitReason): Promise<DesktopActionResult> {
    if (this.shutdownComplete) {
      return { ok: true };
    }
    if (this.activeQuit) {
      return this.activeQuit;
    }

    this.quitRequested = true;
    this.quitReason = reason;
    this.options.onBeforeQuit?.(reason);
    this.armForceExit(reason);
    this.activeQuit = this.options.closeServer()
      .then(() => {
        this.markShutdownComplete();
        return { ok: true } as const;
      })
      .catch((error) => {
        // 服务器关闭失败要如实上报，但绝不能让应用停留在
        // “关不掉”的状态：同样标记完成，让退出流程继续走。
        console.error('[Quit] Server shutdown failed; continuing quit anyway:', this.options.sanitizeError(error));
        this.markShutdownComplete();
        return {
          ok: false,
          code: 'server-shutdown-failed',
          error: this.options.sanitizeError(error),
        } as const;
      });

    return this.activeQuit;
  }

  async requestQuit(reason: QuitReason): Promise<DesktopActionResult> {
    const result = await this.prepareForQuit(reason);
    if (!result.ok) {
      console.error('[Quit] Quitting despite shutdown failure:', result.error);
    }
    app.quit();
    return result;
  }

  handleBeforeQuit(event: Event) {
    if (this.shutdownComplete) return;
    event.preventDefault();
    void this.requestQuit('system');
  }

  /**
   * 卡死兜底：无论 closeServer 因何挂起（未知的长连接、同步 IO、
   * 死锁……），最长 FORCE_EXIT_TIMEOUT_MS 后直接 app.exit(0)。
   * 此前没有这层兜底，server.close() 不回调时整个 quit 流程永久
   * 挂起，用户只能 kill -9。
   */
  private armForceExit(reason: QuitReason) {
    if (this.forceExitTimer) return;
    this.forceExitTimer = setTimeout(() => {
      if (this.shutdownComplete) return;
      console.error(`[Quit] Graceful shutdown timed out after ${FORCE_EXIT_TIMEOUT_MS}ms (reason=${reason}); forcing exit`);
      app.exit(0);
    }, FORCE_EXIT_TIMEOUT_MS);
    this.forceExitTimer.unref?.();
  }

  private markShutdownComplete() {
    this.shutdownComplete = true;
    if (this.forceExitTimer) {
      clearTimeout(this.forceExitTimer);
      this.forceExitTimer = null;
    }
  }
}
