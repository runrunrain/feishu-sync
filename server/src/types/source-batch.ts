export interface SourceBatchRequest {
  root: string;
  tokens: string[];
  action: 'delete' | 'block';
  includeDescendants: boolean;
  deleteFiles: boolean;
  block: boolean;
}
export interface SourceBatchPreview {
  revision: string;
  action: 'delete' | 'block';
  directCount: number;
  descendantCount: number;
  items: Array<{ objToken: string; title: string; path: string; effect: 'blocked' | 'pending' | 'removed' }>;
  files: Array<{ path: string; size: number }>;
  affectedStandardDocs: Array<{ docId: string; title: string }>;
}
export interface SourceBatchResult {
  processed: number; pending: number; blocked: number; removed: number; movedFiles: number; trashDir?: string;
}
