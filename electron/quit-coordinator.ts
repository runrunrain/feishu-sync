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

export class QuitCoordinator {
  private quitRequested = false;
  private shutdownComplete = false;
  private activeQuit: Promise<DesktopActionResult> | null = null;
  private quitReason: QuitReason | null = null;

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
    this.activeQuit = this.options.closeServer()
      .then(() => {
        this.shutdownComplete = true;
        return { ok: true } as const;
      })
      .catch((error) => ({
        ok: false,
        code: 'server-shutdown-failed',
        error: this.options.sanitizeError(error),
      } as const));

    return this.activeQuit;
  }

  async requestQuit(reason: QuitReason): Promise<DesktopActionResult> {
    const result = await this.prepareForQuit(reason);
    if (result.ok) {
      app.quit();
    }
    return result;
  }

  handleBeforeQuit(event: Event) {
    if (this.shutdownComplete) return;
    event.preventDefault();
    void this.requestQuit('system');
  }
}
