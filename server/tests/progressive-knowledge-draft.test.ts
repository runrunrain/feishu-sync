import { describe, expect, it } from 'vitest';
import { finalDraftEvidenceScopePaths, selectProgressiveKnowledgeDraft } from '../src/kb/progressive-knowledge-draft.js';
import type { KnowledgeDraftFile } from '../src/agent/agent-tool-service.js';
import type { KnowledgeManifest } from '../src/kb/knowledge-schema.js';
import type { KbManifest } from '../src/types/agent-knowledge.js';

const object = (id: string, path: string) => ({ objectId: id, canonical: { path }, tombstone: false });
const evidence = (id: string, objectId: string) => ({ evidenceId: id, objectId });

describe('progressive knowledge draft', () => {
  it('publishes a reviewed new path with immutable carried declarations while another path has a pending rewrite', () => {
    const liveDraft = {
      schemaVersion: 1, buildId: 'b1',
      docs: {
        'base.md': { docId: 'd-base', revision: 2, basis: 'draft' },
        'new.md': { docId: 'd-new', revision: 1, basis: 'draft' },
      },
      clientKeys: { pending: 'ko-pending', fresh: 'ko-new' },
      evidenceKeys: { pending: 'ev-pending', fresh: 'ev-new' },
      objects: [object('ko-pending', 'base.md'), object('ko-new', 'new.md')],
      presentations: [], relations: [],
      evidence: [evidence('ev-pending', 'ko-pending'), evidence('ev-new', 'ko-new')],
      coverage: [], calls: {},
    } as unknown as KnowledgeDraftFile;
    const baselineKnowledge = {
      objects: [object('ko-base', 'base.md')],
      presentations: [], relations: [], evidence: [evidence('ev-base', 'ko-base')], coverage: [],
    } as unknown as KnowledgeManifest;
    const baselineDocs = [{ path: 'base.md', docId: 'd-base', contentHash: 'sha256:published' }] as KbManifest['docs'];
    const selected = selectProgressiveKnowledgeDraft({
      buildId: 'b1', liveDraft, baselineKnowledge, baselineDocs,
      allPaths: new Set(['base.md', 'new.md']), newPaths: new Set(['new.md']), coverage: [],
    });
    expect(selected.docs['base.md']).toMatchObject({ basis: 'published', carriedHash: 'sha256:published' });
    expect(selected.docs['new.md']).toMatchObject({ basis: 'draft', revision: 1 });
    expect(selected.objects.map((item) => item.objectId)).toEqual(['ko-base', 'ko-new']);
    expect(selected.evidence.map((item) => item.evidenceId)).toEqual(['ev-base', 'ev-new']);
    expect(selected.clientKeys).toEqual({ fresh: 'ko-new' });
  });

  it('rejects a new object that migrates out of a carried document', () => {
    const liveDraft = { schemaVersion: 1, buildId: 'b1', docs: { 'new.md': { docId: 'd-new', revision: 1 } },
      clientKeys: {}, evidenceKeys: {}, objects: [object('same', 'new.md')],
      presentations: [], relations: [], evidence: [], coverage: [], calls: {} } as unknown as KnowledgeDraftFile;
    const baselineKnowledge = { objects: [object('same', 'base.md')], presentations: [], relations: [], evidence: [], coverage: [] } as unknown as KnowledgeManifest;
    expect(() => selectProgressiveKnowledgeDraft({ buildId: 'b1', liveDraft, baselineKnowledge,
      baselineDocs: [{ path: 'base.md', docId: 'd-base', contentHash: 'sha256:published' }] as KbManifest['docs'],
      allPaths: new Set(['base.md', 'new.md']), newPaths: new Set(['new.md']), coverage: [],
    })).toThrow('跨未审文档迁移');
  });

  it('final publish checks new evidence only in drafts changed since this build promoted them', () => {
    const liveDraft = {
      docs: {
        'promoted.md': { docId: 'd-promoted', basis: 'draft' },
        'new.md': { docId: 'd-new', basis: 'draft' },
        'carried.md': { docId: 'd-carried', basis: 'published' },
      },
      objects: [{ ...object('ko-promoted', 'promoted.md'), reviewSubjectHash: 'same' }],
    } as unknown as KnowledgeDraftFile;
    const baselineKnowledge = { objects: [{ ...object('ko-promoted', 'promoted.md'), reviewSubjectHash: 'same' }] } as unknown as KnowledgeManifest;
    const baselineManifest = { buildId: 'b1', publicationStage: 'progressive',
      promotionHashes: { 'promoted.md': 'sha256:promoted' } } as KbManifest;
    const candidateDocs = [
      { path: 'promoted.md', contentHash: 'sha256:promoted' },
      { path: 'new.md', contentHash: 'sha256:new' },
      { path: 'carried.md', contentHash: 'sha256:carried' },
    ];
    const scope = () => finalDraftEvidenceScopePaths({ buildId: 'b1', liveDraft, candidateDocs,
      baselineManifest, baselineKnowledge });
    expect(scope()).toEqual(['new.md']);
    candidateDocs[0]!.contentHash = 'sha256:revised';
    expect(scope()).toEqual(['promoted.md', 'new.md']);
    candidateDocs[0]!.contentHash = 'sha256:promoted';
    liveDraft.objects[0]!.reviewSubjectHash = 'revised';
    expect(scope()).toEqual(['promoted.md', 'new.md']);
    expect(finalDraftEvidenceScopePaths({ buildId: 'other', liveDraft, candidateDocs,
      baselineManifest, baselineKnowledge })).toBeUndefined();
  });
});
