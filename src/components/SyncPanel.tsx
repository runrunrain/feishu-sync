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
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Document Synchronization</h2>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<FileText className="w-8 h-8" />}
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
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Synchronizing Documents</h2>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <RefreshCw className="w-12 h-12 text-accent animate-spin" />
            <div className="text-center">
              <p className="text-lg font-medium">Syncing {selectedDocuments.length} document{selectedDocuments.length !== 1 ? 's' : ''}</p>
              <p className="text-sm text-text-secondary mt-1">
                Please wait while we download and process your documents...
              </p>
            </div>
            {selectedDocuments.length > 0 && (
              <div className="w-64">
                <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
                  <span>Progress</span>
                  <span>Processing...</span>
                </div>
                <div className="h-1.5 bg-bg-surface rounded-full overflow-hidden">
                  <div className="h-full bg-accent animate-pulse w-full" />
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
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Scanning Knowledge Base</h2>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <FolderOpen className="w-12 h-12 text-accent animate-pulse" />
            <div className="text-center">
              <p className="text-lg font-medium">Scanning local knowledge base</p>
              <p className="text-sm text-text-secondary mt-1">
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
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Synchronization Error</h2>
            <Button size="sm" variant="ghost" onClick={handleClear}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<AlertCircle className="w-8 h-8 text-error" />}
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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Synchronization Results</h2>
          {(syncResult || indexResult || error) && (
            <Button size="sm" variant="ghost" onClick={handleClear}>
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-6">
        {/* Control Panel */}
        <div className="flex items-center justify-between p-3 bg-bg-surface rounded-md">
          <div className="flex items-center gap-4">
            <div className="text-sm">
              <span className="text-text-secondary">Selected: </span>
              <span className="font-medium">{selectedDocuments.length} documents</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* LLM Toggle - M3 placeholder */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-elevated rounded-md text-xs text-text-tertiary">
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
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                fullSync
                  ? 'bg-accent text-text-inverse'
                  : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'
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
              variant="primary"
              onClick={handleSync}
              disabled={selectedDocuments.length === 0 || syncing}
            >
              <RefreshCw className="w-4 h-4" />
              Start Sync
            </Button>
          </div>
        </div>

        {/* Sync Result */}
        {syncResult && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="flex items-center justify-between p-4 bg-bg-surface rounded-md">
              <div className="flex items-center gap-3">
                {syncResult.success ? (
                  <CheckCircle className="w-5 h-5 text-success" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-warning" />
                )}
                <div>
                  <p className="font-medium">
                    {syncResult.syncedDocuments.length} succeeded, {syncResult.failedDocuments.length} failed
                  </p>
                  <div className="flex items-center gap-2 text-xs text-text-secondary mt-0.5">
                    <Clock className="w-3 h-3" />
                    <span>Duration: {formatDuration(syncResult.duration)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Synced Documents List */}
            {syncResult.syncedDocuments.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-text-secondary mb-2">Successfully Synced</h3>
                <div className="space-y-2">
                  {syncResult.syncedDocuments.map((doc) => (
                    <div
                      key={doc.objToken}
                      className="p-3 bg-success/5 border border-success/20 rounded-md"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <FileText className="w-4 h-4 text-success flex-shrink-0" />
                            <span className="font-medium truncate">{doc.title}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-1.5 text-xs text-text-secondary">
                            <span className="truncate">{doc.localMdPath}</span>
                            <span>•</span>
                            <span>{formatSize(doc.size)}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-text-tertiary flex-shrink-0">
                          {doc.imagesCount > 0 && (
                            <div className="flex items-center gap-1">
                              <Image className="w-3 h-3" />
                              <span>{doc.imagesCount}</span>
                            </div>
                          )}
                          {doc.attachmentsCount > 0 && (
                            <div className="flex items-center gap-1">
                              <Paperclip className="w-3 h-3" />
                              <span>{doc.attachmentsCount}</span>
                            </div>
                          )}
                          {doc.sheetsCount > 0 && (
                            <div className="flex items-center gap-1">
                              <Table className="w-3 h-3" />
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
                <h3 className="text-sm font-medium text-text-secondary mb-2">Failed to Sync</h3>
                <div className="space-y-2">
                  {syncResult.failedDocuments.map((doc) => (
                    <div
                      key={doc.objToken}
                      className="p-3 bg-error/5 border border-error/20 rounded-md"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
                            <span className="font-medium truncate">{doc.title}</span>
                          </div>
                          <p className="text-xs text-error mt-1">{doc.error}</p>
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
            <div className="flex items-center gap-3 p-4 bg-bg-surface rounded-md">
              <FolderOpen className="w-5 h-5 text-accent" />
              <div>
                <p className="font-medium">Index Scan Complete</p>
                <div className="flex items-center gap-4 text-xs text-text-secondary mt-0.5">
                  <span>Scanned: {indexResult.scanned}</span>
                  <span>Indexed: {indexResult.indexed}</span>
                  <span>Skipped: {indexResult.skipped}</span>
                  {indexResult.failed > 0 && (
                    <span className="text-error">Failed: {indexResult.failed}</span>
                  )}
                </div>
              </div>
            </div>
            {indexResult.errors && indexResult.errors.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-text-secondary mb-2">Errors</h3>
                <div className="space-y-1">
                  {indexResult.errors.map((err, idx) => (
                    <div key={idx} className="text-xs text-error p-2 bg-error/5 rounded">
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
