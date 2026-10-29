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
  /** 本地文件按文档身份恢复，未更改云端同步状态。 */
  recovered?: boolean;
  /** P1-S3（设计 §2.3）：被引用计数（obj/wiki 双键并集）；缺省视为 0。 */
  referencedBy?: number;
}

export interface KbSourceTreeNode { id: string; title: string; source?: KbSourceChoice; sourceUnavailable?: boolean; children: KbSourceTreeNode[] }
export interface KbSourceTreeDto { root: string; nodes: KbSourceTreeNode[]; total: number }
