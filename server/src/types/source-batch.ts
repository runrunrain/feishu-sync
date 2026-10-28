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
  /**
   * P1-S4（设计 §2.4）：删除确认风险提示——待删除文档被选集外文档引用时
   * 列出（删除后这些引用将悬空）。仅 action='delete' 计算；被引用计数按
   * 引用方文档去重（同源多边只计一篇）。sources 上限 50 条。
   */
  referenceLossRisk?: SourceBatchReferenceLoss[];
}

/** P1-S4：单篇待删文档的引用悬空风险（选集外引用方清单）。 */
export interface SourceBatchReferenceLoss {
  objToken: string;
  title: string;
  referencedByCount: number;
  sources: Array<{ objToken: string; title: string | null; localRelPath: string | null }>;
}
export interface SourceBatchResult {
  processed: number; pending: number; blocked: number; removed: number; movedFiles: number; trashDir?: string;
}
