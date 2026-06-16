/**
 * Change List Component
 * M1: Full implementation with change detection, multi-select, and list display
 */

import { useState, useEffect } from 'react';
import {
  FileText,
  Table,
  FileType,
  Clock,
  Folder,
  CheckSquare,
  Square,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { EmptyState } from './common/EmptyState';
import { useChanges } from '../hooks/useChanges';
import type { ChangedDocument } from '../types';

interface ChangeListProps {
  selectedTokens?: string[];
  onSelectionChange?: (tokens: string[]) => void;
}

export function ChangeList({
  selectedTokens = [],
  onSelectionChange,
}: ChangeListProps) {
  // Default root URL - will be replaced with config in M2
  const [rootUrl] = useState<string>(
    'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb'
  );
  const [selectAll, setSelectAll] = useState(false);

  const {
    changes,
    loading,
    error,
    hasChanges,
    lastCheckedAt,
    totalNodes,
    detect,
  } = useChanges();

  // Handle selection change
  const handleToggleSelect = (objToken: string) => {
    const newSelection = selectedTokens.includes(objToken)
      ? selectedTokens.filter((t) => t !== objToken)
      : [...selectedTokens, objToken];
    onSelectionChange?.(newSelection);
  };

  // Handle select all toggle
  const handleToggleSelectAll = () => {
    if (selectAll) {
      onSelectionChange?.([]);
    } else {
      onSelectionChange?.(changes.map((c) => c.objToken));
    }
    setSelectAll(!selectAll);
  };

  // Update selectAll state when selection changes externally
  useEffect(() => {
    if (changes.length > 0) {
      setSelectAll(selectedTokens.length === changes.length);
    }
  }, [selectedTokens, changes.length]);

  // Handle detect button click
  const handleDetect = () => {
    detect(rootUrl);
  };

  // Format Unix timestamp to readable date
  const formatDate = (unixTimestamp: string): string => {
    const timestamp = parseInt(unixTimestamp, 10);
    if (isNaN(timestamp)) return 'Unknown';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Get document type icon
  const getDocTypeIcon = (objType: ChangedDocument['objType']) => {
    switch (objType) {
      case 'docx':
        return <FileText className="w-4 h-4" />;
      case 'sheet':
        return <Table className="w-4 h-4" />;
      case 'slides':
        return <FileType className="w-4 h-4" />;
      default:
        return <FileType className="w-4 h-4" />;
    }
  };

  // Get change type badge props
  const getChangeTypeBadge = (changeType: ChangedDocument['changeType']) => {
    switch (changeType) {
      case 'added':
        return { status: 'success' as const, label: 'New' };
      case 'modified':
        return { status: 'warning' as const, label: 'Modified' };
      case 'deleted':
        return { status: 'error' as const, label: 'Deleted' };
      default:
        return { status: 'neutral' as const, label: 'Unknown' };
    }
  };

  // Loading state
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Changed Documents</h2>
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Detecting changes...
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="flex items-center justify-center py-12">
            <div className="flex flex-col items-center gap-3">
              <RefreshCw className="w-8 h-8 text-accent animate-spin" />
              <p className="text-sm text-text-secondary">Scanning documents...</p>
            </div>
          </div>
        </CardBody>
      </Card>
    );
  }

  // Error state
  if (error) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Changed Documents</h2>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<AlertCircle className="w-8 h-8 text-error" />}
            title="Detection Failed"
            description={error}
            action={{
              label: 'Retry',
              onClick: handleDetect,
            }}
          />
        </CardBody>
      </Card>
    );
  }

  // Empty state (no changes)
  if (!hasChanges && !loading && !error) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Changed Documents</h2>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={handleDetect}
              >
                <RefreshCw className="w-4 h-4" />
                Detect Changes
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<CheckSquare className="w-8 h-8" />}
            title="All Documents Up to Date"
            description="No changes detected. All your documents are already in sync."
            action={{
              label: 'Refresh',
              onClick: handleDetect,
            }}
          />
        </CardBody>
      </Card>
    );
  }

  // Success state with changes
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Changed Documents</h2>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={handleDetect}
            >
              <RefreshCw className="w-4 h-4" />
              Detect Changes
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardBody>
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4 p-3 bg-bg-surface rounded-md">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Folder className="w-4 h-4 text-text-tertiary" />
              <span className="text-sm text-text-secondary">
                Total: {totalNodes} nodes
              </span>
            </div>
            <div className="text-sm text-text-secondary">
              Changed: {changes.length}
            </div>
            {lastCheckedAt && (
              <div className="text-sm text-text-tertiary">
                Checked: {formatDate(lastCheckedAt)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedTokens.length > 0 && (
              <span className="text-sm text-accent">
                {selectedTokens.length} selected
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={handleToggleSelectAll}
            >
              {selectAll ? (
                <>
                  <CheckSquare className="w-4 h-4" />
                  Deselect All
                </>
              ) : (
                <>
                  <Square className="w-4 h-4" />
                  Select All
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Change List */}
        <div className="space-y-2">
          {changes.map((change) => {
            const badge = getChangeTypeBadge(change.changeType);
            const isSelected = selectedTokens.includes(change.objToken);

            return (
              <div
                key={change.objToken}
                className={`flex items-center gap-3 p-3 rounded-md border transition-all duration-fast ${
                  isSelected
                    ? 'bg-accent/10 border-accent/30'
                    : 'bg-bg-surface border-border-subtle hover:bg-bg-hover'
                }`}
              >
                {/* Checkbox */}
                <button
                  onClick={() => handleToggleSelect(change.objToken)}
                  className="flex-shrink-0"
                >
                  {isSelected ? (
                    <CheckSquare className="w-5 h-5 text-accent" />
                  ) : (
                    <Square className="w-5 h-5 text-text-secondary" />
                  )}
                </button>

                {/* Document Type Icon */}
                <div className="flex-shrink-0 text-text-secondary">
                  {getDocTypeIcon(change.objType)}
                </div>

                {/* Title */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-text-primary truncate">
                    {change.title}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-text-tertiary">
                    <span className="uppercase">{change.objType}</span>
                    <span>•</span>
                    {change.localMdPath ? (
                      <span className="truncate">{change.localMdPath}</span>
                    ) : (
                      <span>Not synced</span>
                    )}
                  </div>
                </div>

                {/* Change Type Badge */}
                <StatusBadge status={badge.status}>
                  {badge.label}
                </StatusBadge>

                {/* Cloud Modified Time */}
                <div className="flex-shrink-0 flex items-center gap-1 text-sm text-text-secondary">
                  <Clock className="w-3.5 h-3.5" />
                  {formatDate(change.cloudModifiedTime)}
                </div>
              </div>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}
