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
}

export interface KbSourceTreeNode { id: string; title: string; source?: KbSourceChoice; children: KbSourceTreeNode[] }
export interface KbSourceTreeDto { root: string; nodes: KbSourceTreeNode[]; total: number }
