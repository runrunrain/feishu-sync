export interface KbFileChange {
  key: string;
  title: string;
  path: string;
  kind: 'added' | 'changed' | 'removed';
  reason?: 'excluded' | 'missing' | 'content';
  beforeAvailable: boolean;
  patch: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}

export interface KbChangePreview {
  baseReleaseId: string | null;
  sources: KbFileChange[];
  affectedDocs: Array<{ docId: string; path: string; title: string }>;
  /** S3 §3.6：待处理源引用图片计数（total）与当前模型未缓存数（uncached；
   * vision 未启用时 uncached=total）。旧服务端无此字段，按可选防御。 */
  images?: { total: number; uncached: number };
}

export interface KbVersionDto {
  releaseId: string;
  baseReleaseId: string | null;
  buildId: string;
  publishedAt: string;
  mode: 'full' | 'incremental';
  summary: string;
  sourceChanges: KbFileChange[];
  docChanges: KbFileChange[];
}

export interface KbSourceChoice {
  objToken: string;
  title: string;
  relPath: string;
  included: boolean;
  published: boolean;
  pending: 'added' | 'changed' | 'removed' | 'unchanged' | 'excluded';
  recovered?: boolean;
}

export interface KbSourceTreeNode { id: string; title: string; source?: KbSourceChoice; sourceUnavailable?: boolean; children: KbSourceTreeNode[] }
export interface KbSourceTreeDto { root: string; nodes: KbSourceTreeNode[]; total: number }
