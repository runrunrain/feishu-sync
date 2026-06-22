/**
 * Change Notification Service
 *
 * Polls for document changes and displays tray notifications.
 * Integrates with server-side ChangeDetector via IPC.
 *
 * Architecture reference: §6.1 ChangeDetector / §6.6 TrayService
 *
 * Contract: POST /api/detect/changes expects body { rootUrl: string }
 * (singular). An earlier revision sent { rootUrls: [] } which left
 * rootUrl undefined on the server side; detect.ts destructured
 * { rootUrl } and passed undefined to changeDetector → getNode →
 * lark-cli `--node-token undefined --format json`, which (via
 * Node execFile shell:true concatenation) made lark-cli 1.0.53
 * interpret "json" as a positional argument and reject with
 * `positional arguments are not supported (got ["json"])`.
 * The fix is two-sided:
 *   1. Caller (this file) sends the correct field name with the
 *      first valid watched root URL pulled from config.
 *   2. detect.ts validates rootUrl and 400s on missing/invalid so
 *      future contract drift fails fast instead of leaking to lark-cli.
 */

import type { BrowserWindow } from 'electron';
import type { DesktopTrayService } from './tray-service.js';

type ChangeNotificationServiceOptions = {
  getWindow: () => BrowserWindow | null;
  getServerUrl: () => string | null;
  getApiToken: () => string | null;
  sanitizeError: (error: unknown) => string;
  trayService: () => DesktopTrayService | null;
  /**
   * Returns the first usable watched root URL from config, or null
   * when none is configured/valid. Used to populate the detect
   * endpoint's required rootUrl field.
   */
  getWatchedRootUrl: () => string | null;
};

interface ChangeDetectionResult {
  changed: boolean;
  changedDocuments: Array<{
    objToken: string;
    title: string;
    changeType: 'modified' | 'added' | 'deleted';
  }>;
  checkedAt: string;
  totalNodes: number;
}

export class ChangeNotificationService {
  private pollTimer: NodeJS.Timeout | null = null;
  private lastNotificationTime: number = 0;
  private lastChangedCount: number = 0;

  constructor(private readonly options: ChangeNotificationServiceOptions) {}

  /**
   * Start polling for changes
   */
  start(pollIntervalMinutes: number = 30) {
    this.stop(); // Clear any existing timer

    const intervalMs = pollIntervalMinutes * 60 * 1000;
    console.info(`[ChangeNotification] Starting polling with ${pollIntervalMinutes}min interval (${intervalMs}ms)`);

    // Initial check
    this.checkChanges().catch((error) => {
      console.error('[ChangeNotification] Initial check failed:', error);
    });

    // Set up recurring polling
    this.pollTimer = setInterval(() => {
      this.checkChanges().catch((error) => {
        console.error('[ChangeNotification] Polling check failed:', error);
      });
    }, intervalMs);
  }

  /**
   * Stop polling
   */
  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.info('[ChangeNotification] Polling stopped');
    }
  }

  /**
   * Check for changes and notify if found
   */
  private async checkChanges(): Promise<void> {
    const serverUrl = this.options.getServerUrl();
    const apiToken = this.options.getApiToken();

    if (!serverUrl || !apiToken) {
      console.warn('[ChangeNotification] Server not ready, skipping check');
      return;
    }

    const rootUrl = this.options.getWatchedRootUrl();
    if (!rootUrl) {
      // No valid watched root URL configured — nothing to detect.
      // Not an error; log once per poll so the trace is visible.
      console.info('[ChangeNotification] No watched root URL configured, skipping detect poll');
      return;
    }

    try {
      // Call server-side change detection API.
      // Body field name MUST be `rootUrl` (singular) per server detect.ts
      // contract. Sending `rootUrls` (plural) or omitting the field leaves
      // rootUrl undefined and triggers the lark-cli positional-arg error
      // (see file header).
      const response = await fetch(`${serverUrl}/api/detect/changes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': apiToken,
        },
        body: JSON.stringify({ rootUrl }),
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}: ${response.statusText}`);
      }

      const result: ChangeDetectionResult = await response.json();

      if (result.changed && result.changedDocuments.length > 0) {
        // Check if this is a new change (different from last notification)
        const currentChangedCount = result.changedDocuments.length;
        const isNewChange = currentChangedCount !== this.lastChangedCount;

        if (isNewChange) {
          this.notifyChanges(result.changedDocuments);
          this.lastChangedCount = currentChangedCount;
          this.lastNotificationTime = Date.now();
        }
      }

      console.info(`[ChangeNotification] Checked ${result.totalNodes} nodes, ${result.changedDocuments.length} changed`);
    } catch (error) {
      console.error('[ChangeNotification] Change detection failed:', this.options.sanitizeError(error));
    }
  }

  /**
   * Show tray notification for changes
   */
  private notifyChanges(changedDocuments: ChangeDetectionResult['changedDocuments']) {
    const count = changedDocuments.length;
    const titles = changedDocuments.slice(0, 3).map((doc) => doc.title).join(', ');
    const moreText = count > 3 ? `等 ${count} 篇` : '';

    // Integrate with TrayService.showNotification
    const tray = this.options.trayService();
    if (tray) {
      tray.showNotification({
        title: '检测到知识库变更',
        body: `${titles} ${moreText} 有更新`,
      });
    } else {
      console.info(`[ChangeNotification] Found ${count} changes: ${titles} ${moreText}`);
    }
  }

  /**
   * Manual trigger for change detection
   */
  async manualCheck(): Promise<ChangeDetectionResult | null> {
    try {
      await this.checkChanges();
      // Return a summary - in real implementation would return actual result
      return {
        changed: this.lastChangedCount > 0,
        changedDocuments: [],
        checkedAt: new Date().toISOString(),
        totalNodes: 0,
      };
    } catch (error) {
      console.error('[ChangeNotification] Manual check failed:', error);
      return null;
    }
  }

  /**
   * Update polling interval
   */
  updateInterval(pollIntervalMinutes: number) {
    console.info(`[ChangeNotification] Updating interval to ${pollIntervalMinutes}min`);
    this.start(pollIntervalMinutes);
  }
}
