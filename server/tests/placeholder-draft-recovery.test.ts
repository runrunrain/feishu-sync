import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairPlaceholderDraftSources } from '../src/kb/placeholder-draft-recovery.js';
import type { RawSourceSnapshot } from '../src/kb/raw-source-snapshot.js';

const denied = '该文档在飞书侧权限受限。API 返回 40403 no permission，请向文档所有者申请权限。';

function fixture(evidenceSource = 'real') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'placeholder-recovery-'));
  const doc = path.join(root, 'docs', 'knowledge.md');
  fs.mkdirSync(path.dirname(doc));
  const original = '<!--\nfeishu_sync_kb:\n  doc_id: kd_1\n  sources:\n    - real\n    - blank\n  build_id: b_1\n-->\n# Knowledge\n\nUseful content.\n';
  fs.writeFileSync(doc, original);
  const draftFile = path.join(root, 'knowledge-draft.json');
  fs.writeFileSync(draftFile, JSON.stringify({
    docs: { 'knowledge.md': { revision: 2 } },
    objects: [{ objectId: 'o1', canonical: { path: 'knowledge.md' }, reviewStatus: 'passed', reviewActorKind: 'machine', reviewerId: 'r1', reviewedAt: 'now' }],
    evidence: [{ objectId: 'o1', sourceRef: { sourceId: evidenceSource } }],
    coverage: [{ sourceRef: { sourceId: 'blank' }, targetObjectIds: [], disposition: 'excluded_template' }],
  }));
  const snapshot = {
    has: (token: string) => token === 'real' || token === 'blank',
    readVerified: (_root: string, token: string) => ({ entry: { objType: 'docx' }, content: token === 'blank' ? denied : '# Real source' }),
  } as unknown as RawSourceSnapshot;
  return { root, doc, draftFile, original, snapshot };
}

describe('placeholder draft recovery', () => {
  it('removes a verified placeholder citation without altering body or genuine evidence', () => {
    const f = fixture();
    try {
      const result = repairPlaceholderDraftSources({ stagingRoot: f.root, snapshot: f.snapshot, knowledgeBaseRoot: f.root,
        workset: new Map([['blank', 'rebuild']]) });
      expect(result).toEqual([{ path: 'knowledge.md', removedSources: ['blank'] }]);
      expect(fs.readFileSync(f.doc, 'utf8')).toBe(f.original.replace('    - blank\n', ''));
      const draft = JSON.parse(fs.readFileSync(f.draftFile, 'utf8'));
      expect(draft.objects[0].reviewStatus).toBe('pending');
      expect(draft.objects[0].reviewerId).toBeUndefined();
      expect(draft.evidence[0].sourceRef.sourceId).toBe('real');
      expect(repairPlaceholderDraftSources({ stagingRoot: f.root, snapshot: f.snapshot, knowledgeBaseRoot: f.root,
        workset: new Map([['blank', 'rebuild']]) })).toEqual([]);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('leaves a draft for manual review when an evidence claim cites the placeholder', () => {
    const f = fixture('blank');
    try {
      expect(repairPlaceholderDraftSources({ stagingRoot: f.root, snapshot: f.snapshot, knowledgeBaseRoot: f.root,
        workset: new Map([['blank', 'rebuild']]) })).toEqual([]);
      expect(fs.readFileSync(f.doc, 'utf8')).toBe(f.original);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});
