/**
 * Update Panel Component
 * Displays update status and controls
 */

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { Download, RefreshCw, CheckCircle } from 'lucide-react';
import type { DesktopUpdateState } from '../types';

export function UpdatePanel() {
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.desktop) {
      window.desktop.update.getState().then(setUpdateState);
    }
  }, []);

  const handleCheck = async () => {
    if (!window.desktop) return;
    setLoading(true);
    try {
      const result = await window.desktop.update.check();
      if (result.available) {
        setUpdateState({ state: 'available', version: result.version });
      } else {
        setUpdateState({ state: 'idle' });
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!window.desktop) return;
    setLoading(true);
    try {
      await window.desktop.update.download();
      setUpdateState({ state: 'downloaded' });
    } catch (err) {
      console.error('Failed to download update:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = async () => {
    if (!window.desktop) return;
    try {
      await window.desktop.update.installAndRestart();
    } catch (err) {
      console.error('Failed to install update:', err);
    }
  };

  const getStatusText = () => {
    if (!updateState) return 'Unknown';
    switch (updateState.state) {
      case 'idle': return 'No updates available';
      case 'checking': return 'Checking for updates...';
      case 'available': return `Update available: ${updateState.version}`;
      case 'downloading': return `Downloading... ${updateState.progress || 0}%`;
      case 'downloaded': return 'Update downloaded';
      case 'installing': return 'Installing update...';
      default: return 'Unknown';
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Application Updates</h2>
          <StatusBadge
            status={updateState?.state === 'available' || updateState?.state === 'downloaded' ? 'success' : 'neutral'}
          >
            {getStatusText()}
          </StatusBadge>
        </div>
      </CardHeader>
      <CardBody>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Keep your application up to date with the latest features and bug fixes.
          </p>

          {updateState?.state === 'idle' && (
            <Button variant="secondary" onClick={handleCheck} loading={loading}>
              <RefreshCw className="w-4 h-4" />
              Check for Updates
            </Button>
          )}

          {updateState?.state === 'available' && (
            <div className="space-y-2">
              <Button onClick={handleDownload} loading={loading}>
                <Download className="w-4 h-4" />
                Download Update
              </Button>
            </div>
          )}

          {updateState?.state === 'downloaded' && (
            <div className="space-y-2">
              <Button onClick={handleInstall}>
                <CheckCircle className="w-4 h-4" />
                Install and Restart
              </Button>
            </div>
          )}

          {updateState?.state === 'downloading' && (
            <div className="space-y-2">
              <div className="w-full bg-bg-surface rounded-full h-2">
                <div
                  className="bg-accent h-2 rounded-full transition-all"
                  style={{ width: `${updateState.progress || 0}%` }}
                />
              </div>
              <p className="text-xs text-text-tertiary text-center">{updateState.progress || 0}%</p>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
