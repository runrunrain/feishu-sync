import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KnowledgeDraftFile } from '../src/agent/agent-tool-service.js';
import type { BuildActorStore, ReviewReceipt } from '../src/kb/build-actors.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { collectAuthorityValidatedReports, scopedKnowledgeDeclarationHash,
  REVIEW_DEP_DECLARATION_SCOPE, DOCUMENT_DECLARATION_SCOPE } from '../src/kb/review-authority.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function declarations(): KnowledgeDraftFile {
  return { schemaVersion: 1, buildId: 'b_scope', docs: { 'a.md': {}, 'b.md': {} },
    clientKeys: { a: 'a', b: 'b' }, evidenceKeys: {},
    objects: [{ objectId: 'a', title: 'A', canonical: { path: 'a.md' } },
      { objectId: 'b', title: 'B', canonical: { path: 'b.md' } }],
    presentations: [], relations: [], evidence: [], calls: {}, coverage: [{ itemId: 'unassigned',
      sourceRef: { sourceId: 'shared' }, category: 'rule', importance: 'normal',
      disposition: 'unresolved', targetObjectIds: [], reason: 'Awaiting ownership' }],
  } as unknown as KnowledgeDraftFile;
}
const scoped = (draft: KnowledgeDraftFile, doc = 'a.md', legacy = false) =>
  scopedKnowledgeDeclarationHash(draft, [doc], ['shared'], legacy);

function fixture(legacy: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-scope-')); roots.push(root);
  const stagingRoot = path.join(root, '.staging/b_scope');
  fs.mkdirSync(path.join(stagingRoot, 'reviews'), { recursive: true });
  const before = declarations();
  const receipt = { reviewId: 'krev_old', buildId: 'b_scope', reportId: 'kr_old', reportUnitId: 'actor_old',
    draftHash: 'body-candidate', scopePaths: ['a.md'], status: 'valid', verdict: 'pass',
    dependencyHashes: { 'doc:a.md': 'body-a', 'knowledge-declaration': scoped(before, 'a.md', legacy),
      'source-snapshot': 'source-hash', 'workflow-rules': 'rule-hash',
      ...(!legacy ? { [REVIEW_DEP_DECLARATION_SCOPE]: DOCUMENT_DECLARATION_SCOPE } : {}) },
  } as unknown as ReviewReceipt;
  fs.writeFileSync(path.join(stagingRoot, 'reviews/actor_old.json'), JSON.stringify({ reportId: 'kr_old',
    draftHash: 'body-candidate', conclusion: 'pass', coverage: { sourceRefs: ['shared'] } }));
  const next = structuredClone(before);
  next.coverage[0]!.disposition = 'mapped'; next.coverage[0]!.targetObjectIds = ['b'];
  const write = (draft: KnowledgeDraftFile) => fs.writeFileSync(path.join(stagingRoot, 'knowledge-draft.json'), JSON.stringify(draft));
  write(next);
  const current = { declarationHash: 'not-used-for-scoped-receipt', sourceSnapshotHash: 'source-hash', workflowRulesHash: 'rule-hash' };
  const collect = () => collectAuthorityValidatedReports({ stagingRoot,
    store: { listReviews: () => [receipt] } as unknown as BuildActorStore,
    current, documentHashes: new Map([['a.md', 'body-a']]) });
  return { root, stagingRoot, before, next, receipt, current, write, collect };
}

describe('document declaration ownership', () => {
  it('assigning an unowned source item to B leaves A reviewed and changes B only', () => {
    const before = declarations(), next = structuredClone(before);
    next.coverage[0]!.disposition = 'mapped'; next.coverage[0]!.targetObjectIds = ['b'];
    expect(scoped(next)).toBe(scoped(before));
    expect(scoped(next, 'b.md')).not.toBe(scoped(before, 'b.md'));
    expect(scoped(next, 'a.md', true)).not.toBe(scoped(before, 'a.md', true));
  });

  it('a mapping shared by A and B remains a dependency of each document', () => {
    const before = declarations(); before.coverage[0]!.targetObjectIds = ['a', 'b'];
    before.coverage[0]!.disposition = 'mapped';
    const next = structuredClone(before); next.coverage[0]!.category = 'definition';
    expect(scoped(next)).not.toBe(scoped(before));
    expect(scoped(next, 'b.md')).not.toBe(scoped(before, 'b.md'));
  });

  it('new receipts survive unrelated ownership changes but reject local declaration changes', () => {
    const f = fixture(false);
    expect(f.collect().validReportIds).toEqual(['kr_old']);
    f.next.objects[0]!.title = 'Changed A'; f.write(f.next);
    expect(f.collect().validReportIds).toEqual([]);
  });

  it('legacy reuse needs the exact old checkpoint digest and unchanged local declarations', () => {
    const f = fixture(true);
    expect(f.collect().validReportIds).toEqual([]);
    const checkpoint = path.join(f.root, '.builds/b_scope/checkpoints/cp_prior');
    fs.mkdirSync(checkpoint, { recursive: true });
    fs.writeFileSync(path.join(checkpoint, 'knowledge-draft.json'), JSON.stringify(f.before));
    expect(f.collect().validReportIds).toEqual(['kr_old']);
    expect(fs.existsSync(path.join(f.stagingRoot, 'reviews/declaration-binding-krev_old.json'))).toBe(true);
    const reports = (KbBuildService as unknown as { collectReviewReports: (root: string) => Array<{ reportId: string }> })
      .collectReviewReports(f.stagingRoot);
    expect(reports.map(report => report.reportId)).toEqual(['kr_old']);
    fs.rmSync(checkpoint, { recursive: true });
    expect(f.collect().validReportIds).toEqual(['kr_old']);
    f.next.objects[0]!.title = 'Changed A'; f.write(f.next);
    expect(f.collect().validReportIds).toEqual([]);
  });

  it('an old checkpoint cannot authorize local changes, another build, or an unknown hash scheme', () => {
    const f = fixture(true);
    const checkpoint = path.join(f.root, '.builds/b_scope/checkpoints/cp_prior');
    fs.mkdirSync(checkpoint, { recursive: true });
    fs.writeFileSync(path.join(checkpoint, 'knowledge-draft.json'), JSON.stringify({ ...f.before, buildId: 'another-build' }));
    expect(f.collect().validReportIds).toEqual([]);
    fs.writeFileSync(path.join(checkpoint, 'knowledge-draft.json'), JSON.stringify(f.before));
    f.next.objects[0]!.title = 'Changed A'; f.write(f.next);
    expect(f.collect().validReportIds).toEqual([]);
    f.receipt.dependencyHashes[REVIEW_DEP_DECLARATION_SCOPE] = 'unknown-future-format';
    expect(f.collect().validReportIds).toEqual([]);
  });

  it('a compatibility binding still rejects source, rule, and body changes', () => {
    const f = fixture(true); f.write(f.before);
    expect(f.collect().validReportIds).toEqual(['kr_old']);
    f.write(f.next); expect(f.collect().validReportIds).toEqual(['kr_old']);
    f.current.sourceSnapshotHash = 'changed'; expect(f.collect().validReportIds).toEqual([]);
    f.current.sourceSnapshotHash = 'source-hash'; f.current.workflowRulesHash = 'changed';
    expect(f.collect().validReportIds).toEqual([]);
    f.current.workflowRulesHash = 'rule-hash'; f.receipt.dependencyHashes['doc:a.md'] = 'changed';
    expect(f.collect().validReportIds).toEqual([]);
  });
});
