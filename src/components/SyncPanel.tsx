/**
 * Sync Panel Component
 * M2: Full implementation with document sync and index scan
 */

import { useState } from 'react';
import {
  RefreshCw,
  FolderOpen,
  FileText,
  X,
  AlertCircle,
  CheckCircle,
  Clock,
  Image,
  Paperclip,
  Table,
  Settings,
  Activity,
} from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { EmptyState } from './common/EmptyState';
import { useSync } from '../hooks/useSync';
import type { ChangedDocument, FailedDocument } from '../types';

interface SyncPanelProps {
  selectedDocuments?: ChangedDocument[];
  onSelectionChange?: (documents: ChangedDocument[]) => void;
}

export function SyncPanel({
  selectedDocuments = [],
}: SyncPanelProps) {
  const [enableLLM, setEnableLLM] = useState(false);
  const [fullSync, setFullSync] = useState(false);

  const {
    syncing,
    indexing,
    syncResult,
    indexResult,
    error,
    syncDocuments,
    syncIndex,
    clear,
  } = useSync();

  // Handle sync button click
  const handleSync = () => {
    if (selectedDocuments.length === 0) return;
    syncDocuments(selectedDocuments, { enableLLM, fullSync });
  };

  // Handle index button click
  const handleIndex = () => {
    syncIndex();
  };

  // Clear results
  const handleClear = () => {
    clear();
  };

  // Handle retry for failed document
  const handleRetry = (failedDoc: FailedDocument) => {
    const docToRetry = selectedDocuments.find(d => d.objToken === failedDoc.objToken);
    if (docToRetry) {
      syncDocuments([docToRetry], { enableLLM, fullSync });
    }
  };

  // Format duration
  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  // Open local file
  const handleOpenFile = () => {
    if (typeof window !== 'undefined' && window.desktop) {
      window.desktop.openDataDirectory()
        .catch(err => {
          console.error('Failed to open directory:', err);
        });
    }
  };

  // Idle state - no documents selected
  if (selectedDocuments.length === 0 && !syncResult && !indexResult && !error) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-lg font-display font-medium text-text-primary">Document Synchronization</h2>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<FileText className="w-10 h-10 text-text-tertiary" />}
            title="No Documents Selected"
            description="Please select documents from the Changes list to synchronize."
          />
        </CardBody>
      </Card>
    );
  }

  // Syncing state
  if (syncing) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-lg font-display font-medium text-text-primary">Synchronizing Documents</h2>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col items-center justify-center py-16 gap-5">
            <div className="relative">
              <RefreshCw className="w-16 h-16 text-sync animate-spin" />
              <div className="absolute inset-0 w-16 h-16 bg-sync/20 rounded-full animate-pulse-teal" />
            </div>
            <div className="text-center">
              <p className="text-lg font-medium text-text-primary">Syncing {selectedDocuments.length} document{selectedDocuments.length !== 1 ? 's' : ''}</p>
              <p className="text-sm text-text-secondary mt-2">
                Downloading and processing your documents...
              </p>
            </div>
            {selectedDocuments.length > 0 && (
              <div className="w-80">
                <div className="flex items-center justify-between text-xs text-text-secondary mb-2">
                  <span>Progress</span>
                  <span className="text-sync">Processing...</span>
                </div>
                <div className="h-2 bg-bg-surface rounded-full overflow-hidden border border-border-subtle">
                  <div className="h-full bg-sync animate-pulse-teal w-full" />
                </div>
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    );
  }

  // Indexing state
  if (indexing) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-lg font-display font-medium text-text-primary">Scanning Knowledge Base</h2>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col items-center justify-center py-16 gap-5">
            <div className="relative">
              <FolderOpen className="w-16 h-16 text-accent animate-pulse" />
              <div className="absolute inset-0 w-16 h-16 bg-accent/20 rounded-full animate-pulse" />
            </div>
            <div className="text-center">
              <p className="text-lg font-medium text-text-primary">Scanning local knowledge base</p>
              <p className="text-sm text-text-secondary mt-2">
                Building initial index of existing documents...
              </p>
            </div>
          </div>
        </CardBody>
      </Card>
    );
  }

  // Error state
  if (error && !syncResult && !indexResult) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-display font-medium text-text-primary">Synchronization Error</h2>
            <Button size="sm" variant="ghost" onClick={handleClear}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<AlertCircle className="w-10 h-10 text-danger" />}
            title="Sync Failed"
            description={error}
            action={{
              label: 'Retry',
              onClick: handleSync,
            }}
          />
        </CardBody>
      </Card>
    );
  }

  // Success/Result state
  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-display font-medium text-text-primary">Synchronization Results</h2>
          {(syncResult || indexResult || error) && (
            <Button size="sm" variant="ghost" onClick={handleClear}>
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-6">
        {/* Control Panel */}
        <div className="flex items-center justify-between p-4 bg-bg-canvas rounded-lg border border-border-subtle">
          <div className="flex items-center gap-6">
            <div className="text-sm">
              <span className="text-text-secondary">Selected: </span>
              <span className="font-medium text-accent">{selectedDocuments.length} documents</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* LLM Toggle - M3 placeholder */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-surface rounded-md text-xs text-text-tertiary border border-border-subtle">
              <Settings className="w-3.5 h-3.5" />
              <span>LLM (M3)</span>
              <button
                onClick={() => setEnableLLM(!enableLLM)}
                className={`w-8 h-4 rounded-full relative transition-colors ${
                  enableLLM ? 'bg-accent/30' : 'bg-text-tertiary/30'
                }`}
                disabled
              >
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                  enableLLM ? 'left-[18px]' : 'left-0.5'
                }`} />
              </button>
            </div>

            {/* Full Sync Toggle */}
            <button
              onClick={() => setFullSync(!fullSync)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ${
                fullSync
                  ? 'bg-accent text-text-inverse border-accent'
                  : 'bg-bg-surface text-text-secondary border-border-subtle hover:bg-bg-hover'
              }`}
            >
              {fullSync ? 'Full Sync' : 'Incremental'}
            </button>

            <Button
              size="sm"
              variant="secondary"
              onClick={handleIndex}
              disabled={indexing}
            >
              <RefreshCw className="w-4 h-4" />
              Index
            </Button>

            <Button
              size="sm"
              variant="seal"
              onClick={handleSync}
              disabled={selectedDocuments.length === 0 || syncing}
            >
              <Activity className="w-4 h-4" />
              Start Sync
            </Button>
          </div>
        </div>

        {/* Sync Result */}
        {syncResult && (
          <div className="space-y-5">
            {/* Summary */}
            <div className={`flex items-center justify-between p-5 rounded-lg border ${
              syncResult.success
                ? 'bg-success/5 border-success/20'
                : 'bg-warning/5 border-warning/20'
            }`}>
              <div className="flex items-center gap-4">
                {syncResult.success ? (
                  <div className="p-2 rounded-full bg-success/20">
                    <CheckCircle className="w-6 h-6 text-success" />
                  </div>
                ) : (
                  <div className="p-2 rounded-full bg-warning/20">
                    <AlertCircle className="w-6 h-6 text-warning" />
                  </div>
                )}
                <div>
                  <p className="font-medium text-text-primary">
                    {syncResult.syncedDocuments.length} succeeded, {syncResult.failedDocuments.length} failed
                  </p>
                  <div className="flex items-center gap-2 text-xs text-text-secondary mt-1">
                    <Clock className="w-3 h-3" />
                    <span className="font-mono">{formatDuration(syncResult.duration)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Synced Documents List */}
            {syncResult.syncedDocuments.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-text-secondary mb-3 uppercase tracking-wide">Successfully Synced</h3>
                <div className="space-y-3">
                  {syncResult.syncedDocuments.map((doc) => (
                    <div
                      key={doc.objToken}
                      className="p-4 bg-bg-canvas border border-success/20 rounded-lg hover:border-success/30 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="p-1.5 rounded bg-success/20">
                              <FileText className="w-4 h-4 text-success" />
                            </div>
                            <span className="font-medium text-text-primary truncate">{doc.title}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-2 text-xs text-text-secondary">
                            <span className="font-mono truncate">{doc.localMdPath}</span>
                            <span>•</span>
                            <span className="font-mono">{formatSize(doc.size)}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-text-tertiary flex-shrink-0">
                          {doc.imagesCount > 0 && (
                            <div className="flex items-center gap-1.5">
                              <Image className="w-3.5 h-3.5" />
                              <span>{doc.imagesCount}</span>
                            </div>
                          )}
                          {doc.attachmentsCount > 0 && (
                            <div className="flex items-center gap-1.5">
                              <Paperclip className="w-3.5 h-3.5" />
                              <span>{doc.attachmentsCount}</span>
                            </div>
                          )}
                          {doc.sheetsCount > 0 && (
                            <div className="flex items-center gap-1.5">
                              <Table className="w-3.5 h-3.5" />
                              <span>{doc.sheetsCount}</span>
                            </div>
                          )}
                          <button
                            onClick={() => handleOpenFile()}
                            className="hover:text-accent transition-colors"
                          >
                            Open
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Failed Documents List */}
            {syncResult.failedDocuments.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-danger mb-3 uppercase tracking-wide">Failed to Sync</h3>
                <div className="space-y-3">
                  {syncResult.failedDocuments.map((doc) => (
                    <div
                      key={doc.objToken}
                      className="p-4 bg-bg-canvas border border-danger/20 rounded-lg hover:border-danger/30 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="p-1.5 rounded bg-danger/20">
                              <AlertCircle className="w-4 h-4 text-danger" />
                            </div>
                            <span className="font-medium text-text-primary truncate">{doc.title}</span>
                          </div>
                          <p className="text-xs text-danger mt-2">{doc.error}</p>
                        </div>
                        {doc.retryable && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleRetry(doc)}
                          >
                            Retry
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Index Result */}
        {indexResult && (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-5 bg-bg-canvas border border-accent/20 rounded-lg">
              <div className="p-2 rounded-full bg-accent/20">
                <FolderOpen className="w-6 h-6 text-accent" />
              </div>
              <div>
                <p className="font-medium text-text-primary">Index Scan Complete</p>
                <div className="flex items-center gap-4 text-xs text-text-secondary mt-1">
                  <span>Scanned: <span className="font-mono text-accent">{indexResult.scanned}</span></span>
                  <span>Indexed: <span className="font-mono text-success">{indexResult.indexed}</span></span>
                  <span>Skipped: <span className="font-mono text-text-tertiary">{indexResult.skipped}</span></span>
                  {indexResult.failed > 0 && (
                    <span className="text-danger font-mono">Failed: {indexResult.failed}</span>
                  )}
                </div>
              </div>
            </div>
            {indexResult.errors && indexResult.errors.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-danger mb-3 uppercase tracking-wide">Errors</h3>
                <div className="space-y-2">
                  {indexResult.errors.map((err, idx) => (
                    <div key={idx} className="text-xs text-danger p-3 bg-danger/5 border border-danger/20 rounded">
                      {err}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
