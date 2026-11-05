import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { contentResourceHash, computeQuoteHash } from '../src/kb/evidence-locator.js';
import type { KnowledgeManifest } from '../src/kb/knowledge-schema.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('incremental baseline resource inheritance', () => {
  it('carries identical resources across a workbook version without rereading per claim, and keeps changed evidence stale', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-resource-carry-')); roots.push(root);
    const raw = path.join(root, 'source.md'); const csv = path.join(root, 'changed.csv');
    const text = 'stable rule\n';
    fs.writeFileSync(raw, text); fs.writeFileSync(csv, 'a,new\n');
    const entry = { objToken: 'tok', objType: 'sheet', title: 'Source', relPath: 'source.md', objEditTime: null,
      contentHash: computeSourceHash(raw, [csv], root) };
    const snapshot = RawSourceSnapshot.fromEntries([entry], { sheetCsvPaths: () => [csv] });
    const read = vi.spyOn(snapshot, 'readVerified');
    const stableRef = { sourceId: 'tok', resourceId: 'tok', sourceSnapshotHash: 'old-workbook', resourceHash: contentResourceHash(text) };
    const changedRef = { sourceId: 'tok', resourceId: 'tok#csv:changed.csv', sourceSnapshotHash: 'old-workbook', resourceHash: contentResourceHash('a,old\n') };
    const baseline = { schemaVersion: 1, documents: [], objects: [], presentations: [], relations: [], migrations: [],
      evidence: [1, 2].map((id) => ({ evidenceId: `ev${id}`, objectId: 'obj', claimKey: `c${id}`, sourceRef: stableRef,
        selector: { kind: 'text_span', lineStart: 1, lineEnd: 1, colStart: 1, colEnd: 0, headingPath: [] },
        quoteHash: computeQuoteHash('stable rule'), role: 'supports', nature: 'verbatim', readReceiptId: 'previous-build' })),
      coverage: [{ itemId: 'cov-stable', sourceRef: stableRef, category: 'rule', disposition: 'mapped', targetObjectIds: ['obj'] },
        { itemId: 'cov-changed', sourceRef: changedRef, category: 'rule', disposition: 'mapped', targetObjectIds: ['obj'] }],
    } as unknown as KnowledgeManifest;
    baseline.evidence.push({ ...baseline.evidence[0]!, evidenceId: 'ev-changed', sourceRef: changedRef,
      selector: { kind: 'csv_cells', resourcePath: 'changed.csv', parserVersion: 'rfc4180-v1', recordStart: 1, recordEnd: 1, columns: ['@1', '@2'] },
      quoteHash: 'changed-quote' });
    const service = Object.create(KbBuildService.prototype) as {
      seedBaselineKnowledge: (buildId: string, staging: string, baseline: KnowledgeManifest,
        snapshot: RawSourceSnapshot, root: string, release: string, hash: string | null) => number;
    };
    service.seedBaselineKnowledge('build', root, baseline, snapshot, root, root, null);
    const draft = JSON.parse(fs.readFileSync(path.join(root, 'knowledge-draft.json'), 'utf8'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(draft.evidence.slice(0, 2).map((item: { sourceRef: { sourceSnapshotHash: string } }) => item.sourceRef.sourceSnapshotHash))
      .toEqual([entry.contentHash, entry.contentHash]);
    expect(draft.evidence[0].readReceiptId).toMatch(/^krr_seed_/);
    expect(draft.evidence[2].sourceRef).toEqual(changedRef);
    expect(draft.evidence[2].readReceiptId).toBe('previous-build');
    expect(draft.coverage[0].sourceRef.sourceSnapshotHash).toBe(entry.contentHash);
    expect(draft.coverage[1].sourceRef).toEqual(changedRef);
    expect(fs.readFileSync(path.join(root, 'read-receipts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(baseline.evidence[0]!.sourceRef.sourceSnapshotHash).toBe('old-workbook');
  });
});
