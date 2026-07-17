/**
 * Change Notification Service
 *
 * Polls for document changes and displays tray notifications.
 * Integrates with server-side ChangeDetector via HTTP.
 *
 * Architecture reference: §6.1 ChangeDetector / §6.6 TrayService
 *
 * Multi-root contract: this service POSTs to /api/detect/changes-all,
 * the same multi-root endpoint the frontend 立即检测 button uses. The
 * server iterates enabled config.watchedRoots and runs detectChanges per
 * root, aggregating changedDocuments across ALL roots. This is a
 * deliberate change from the earlier single-root design which POSTed
 * /api/detect/changes { rootUrl } with only the FIRST valid watched
 * root URL — leaving roots [1..N] never auto-detected (diagnosis
 * 2026-07-08 §2.2 root cause B).
 *
 * Historical note (kept to prevent regression): an even earlier
 * revision sent { rootUrls: [] } to the singular endpoint, leaving
 * rootUrl undefined on the server and triggering a lark-cli positional-
 * arg error. The lesson — always match the endpoint's actual contract
 * — still applies; changes-all is config-driven (body ignored), so an
 * empty {} is the correct body here.
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
   * Returns ALL valid watched root URLs from config (empty array when
   * none is configured/valid). Used (a) to skip the detect poll when no
   * roots are configured, and (b) to log root coverage; the actual root
   * iteration happens server-side inside /api/detect/changes-all, so the
   * caller does not need to loop over these URLs itself.
   */
  getWatchedRootUrls: () => string[];
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
   * Check for changes and notify if found.
   *
   * Polls the multi-root /api/detect/changes-all endpoint so every
   * configured watched root is auto-detected each cycle. The server
   * aggregates results across roots; any root reporting changes raises
   * the tray notification (notification semantics are unchanged from
   * the single-root era — only coverage expanded to all roots).
   */
  private async checkChanges(): Promise<void> {
    const serverUrl = this.options.getServerUrl();
    const apiToken = this.options.getApiToken();

    if (!serverUrl || !apiToken) {
      console.warn('[ChangeNotification] Server not ready, skipping check');
      return;
    }

    const rootUrls = this.options.getWatchedRootUrls();
    if (rootUrls.length === 0) {
      // No valid watched root URL configured — nothing to detect.
      // Not an error; log once per poll so the trace is visible.
      console.info('[ChangeNotification] No watched root URLs configured, skipping detect poll');
      return;
    }

    try {
      // Drive the multi-root detect endpoint so EVERY configured root is
      // polled automatically. The server iterates enabled config.watchedRoots
      // internally and aggregates changedDocuments across roots; the body
      // is config-driven (ignored), so {} is correct. Response shape:
      //   { changed, changedDocuments, totalNodes, checkedAt, results[] }
      // — the shared fields match ChangeDetectionResult, so the existing
      // notification logic works unchanged; results[] (per-root status)
      // is simply unused by the poller.
      const response = await fetch(`${serverUrl}/api/detect/changes-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': apiToken,
        },
        body: JSON.stringify({}),
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

      console.info(
        `[ChangeNotification] Checked ${result.totalNodes} nodes across ${rootUrls.length} root(s), ${result.changedDocuments.length} changed`,
      );
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
