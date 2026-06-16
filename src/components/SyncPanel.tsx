/**
 * Sync Panel Component
 * Skeleton for M2 - displays placeholder for document synchronization
 */

import { Card, CardHeader, CardBody } from './common/Card';
import { EmptyState } from './common/EmptyState';
import { RefreshCw } from 'lucide-react';

export function SyncPanel() {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-medium">Document Synchronization</h2>
      </CardHeader>
      <CardBody>
        <EmptyState
          icon={<RefreshCw className="w-8 h-8" />}
          title="Synchronization Coming in M2"
          description="Document synchronization will be enabled in Milestone 2. It will download and adapt Feishu documents to your local knowledge base."
        />
      </CardBody>
    </Card>
  );
}
