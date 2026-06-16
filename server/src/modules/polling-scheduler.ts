/**
 * PollingScheduler - Time-based polling for change detection
 *
 * Implements 架构设计文档 §6.1:
 * - Base interval: 30 minutes
 * - Working hours (9:00-18:00): 15 minutes
 * - Night time (23:00-8:00): 2 hours
 * - Configurable via config.pollIntervalMinutes
 * - Callback onChange(result) for notification
 */

import type { ChangeDetector } from './change-detector.js';
import type { Config, ChangeDetectionResult } from '../types/index.js';

interface PollingSchedulerOptions {
  changeDetector: ChangeDetector;
  config: Config;
  onChange: (result: ChangeDetectionResult) => void;
}

export class PollingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(private options: PollingSchedulerOptions) {}

  /**
   * Start polling with dynamic interval calculation
   */
  start(): void {
    if (this.isRunning) {
      console.warn('[PollingScheduler] Already running');
      return;
    }

    this.isRunning = true;
    this.scheduleNext();
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  /**
   * Calculate next trigger time based on current hour
   * - Working hours (9-18): 15 minutes
   * - Night time (23-8): 2 hours
   * - Default: config.pollIntervalMinutes (30 minutes)
   */
  private getNextInterval(): number {
    const hour = new Date().getHours();
    const defaultInterval = this.options.config.pollIntervalMinutes * 60 * 1000;

    // Night time: 23:00 - 8:00 (2 hours)
    if (hour >= 23 || hour < 8) {
      return 2 * 60 * 60 * 1000; // 2 hours
    }

    // Working hours: 9:00 - 18:00 (15 minutes)
    if (hour >= 9 && hour < 18) {
      return 15 * 60 * 1000; // 15 minutes
    }

    // Default: 30 minutes
    return defaultInterval;
  }

  /**
   * Schedule next detection cycle
   */
  private scheduleNext(): void {
    if (!this.isRunning) {
      return;
    }

    const interval = this.getNextInterval();

    this.timer = setTimeout(async () => {
      await this.executeDetection();
      this.scheduleNext(); // Schedule next after completion
    }, interval);

    console.info(`[PollingScheduler] Next detection scheduled in ${interval / 60000} minutes`);
  }

  /**
   * Execute detection for all watched root URLs
   */
  private async executeDetection(): Promise<void> {
    console.info('[PollingScheduler] Executing change detection...');

    const rootUrls = this.options.config.watchedRootUrls || [];

    for (const rootUrl of rootUrls) {
      try {
        const result = await this.options.changeDetector.detectChanges(rootUrl);
        this.options.onChange(result);
      } catch (error) {
        console.error(`[PollingScheduler] Detection failed for ${rootUrl}:`, error);
      }
    }
  }
}
