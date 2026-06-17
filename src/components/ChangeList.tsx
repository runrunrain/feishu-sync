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
      <Card variant="elevated">
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-display font-medium text-text-primary">Changed Documents</h2>
            <div className="flex items-center gap-2 text-sm text-sync">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span className="text-sm">Detecting changes...</span>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-4">
              <div className="relative">
                <RefreshCw className="w-12 h-12 text-sync animate-spin" />
                <div className="absolute inset-0 w-12 h-12 bg-sync/20 rounded-full animate-pulse" />
              </div>
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
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-lg font-display font-medium text-text-primary">Changed Documents</h2>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<AlertCircle className="w-10 h-10 text-danger" />}
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
      <Card variant="elevated">
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-display font-medium text-text-primary">Changed Documents</h2>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleDetect}
            >
              <RefreshCw className="w-4 h-4" />
              Detect Changes
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<CheckSquare className="w-10 h-10 text-success" />}
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
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-display font-medium text-text-primary">Changed Documents</h2>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleDetect}
          >
            <RefreshCw className="w-4 h-4" />
            Detect Changes
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-5 p-4 bg-bg-canvas rounded-lg border border-border-subtle">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Folder className="w-4 h-4 text-text-tertiary" />
              <span className="text-sm text-text-secondary">
                {totalNodes} nodes
              </span>
            </div>
            <div className="h-4 w-px bg-border-subtle" />
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-secondary">Changed:</span>
              <span className="text-sm font-medium text-accent">{changes.length}</span>
            </div>
            {lastCheckedAt && (
              <>
                <div className="h-4 w-px bg-border-subtle" />
                <div className="text-xs text-text-tertiary">
                  {formatDate(lastCheckedAt)}
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            {selectedTokens.length > 0 && (
              <span className="text-sm px-2 py-1 bg-accent/10 text-accent rounded-md font-medium">
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
        <div className="space-y-3">
          {changes.map((change) => {
            const badge = getChangeTypeBadge(change.changeType);
            const isSelected = selectedTokens.includes(change.objToken);

            return (
              <div
                key={change.objToken}
                className={`group flex items-center gap-4 p-4 rounded-lg border transition-all duration-fast cursor-pointer ${
                  isSelected
                    ? 'bg-accent/10 border-accent/30 shadow-sm'
                    : 'bg-bg-canvas border-border-subtle hover:border-border hover:bg-bg-hover'
                }`}
                onClick={() => handleToggleSelect(change.objToken)}
              >
                {/* Checkbox */}
                <div className="flex-shrink-0">
                  {isSelected ? (
                    <div className="w-5 h-5 rounded bg-accent flex items-center justify-center">
                      <CheckSquare className="w-3.5 h-3.5 text-text-inverse" />
                    </div>
                  ) : (
                    <div className="w-5 h-5 rounded border-2 border-border-subtle group-hover:border-accent/50 transition-colors" />
                  )}
                </div>

                {/* Document Type Icon */}
                <div className={`flex-shrink-0 p-2 rounded-md ${
                  change.objType === 'docx' ? 'bg-blue-500/10 text-blue-400' :
                  change.objType === 'sheet' ? 'bg-green-500/10 text-green-400' :
                  change.objType === 'slides' ? 'bg-purple-500/10 text-purple-400' :
                  'bg-bg-surface text-text-secondary'
                }`}>
                  {getDocTypeIcon(change.objType)}
                </div>

                {/* Title */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-text-primary truncate">
                    {change.title}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-text-tertiary mt-0.5">
                    <span className="uppercase font-mono">{change.objType}</span>
                    <span>•</span>
                    {change.localMdPath ? (
                      <span className="truncate font-mono">{change.localMdPath}</span>
                    ) : (
                      <span className="text-warning">Not synced</span>
                    )}
                  </div>
                </div>

                {/* Change Type Badge */}
                <StatusBadge status={badge.status as 'success' | 'warning' | 'error'} size="sm">
                  {badge.label}
                </StatusBadge>

                {/* Cloud Modified Time */}
                <div className="flex-shrink-0 flex items-center gap-1.5 text-sm text-text-secondary font-mono text-xs">
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
