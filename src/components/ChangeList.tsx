/**
 * Change List Component
 * Skeleton for M1 - displays placeholder for change detection
 */

import { Card, CardHeader, CardBody } from './common/Card';
import { EmptyState } from './common/EmptyState';
import { FileSearch } from 'lucide-react';

export function ChangeList() {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-medium">Changed Documents</h2>
      </CardHeader>
      <CardBody>
        <EmptyState
          icon={<FileSearch className="w-8 h-8" />}
          title="Change Detection Coming in M1"
          description="The change detection feature will be enabled in Milestone 1. It will scan your watched Feishu wikis for modified documents."
        />
      </CardBody>
    </Card>
  );
}
