/**
 * Log Viewer Component
 * Skeleton - displays placeholder for application logs
 */

import { Card, CardHeader, CardBody } from './common/Card';
import { EmptyState } from './common/EmptyState';
import { FileText } from 'lucide-react';

export function LogViewer() {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-medium">Application Logs</h2>
      </CardHeader>
      <CardBody>
        <EmptyState
          icon={<FileText className="w-8 h-8" />}
          title="Log Viewer"
          description="Application logs will be displayed here once available."
        />
      </CardBody>
    </Card>
  );
}
