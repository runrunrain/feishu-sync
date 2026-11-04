import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KbManifest, RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';
import { contentResourceHash, computeQuoteHash } from '../src/kb/evidence-locator.js';
import { captureSourceContents } from '../src/kb/kb-version-store.js';
import { progressiveSourceSnapshot, rebindBaselineImageEvidence, seedProgressiveCarriedReceipts } from '../src/kb/progressive-source-snapshot.js';
import { computeSourceHash, RawSourceSnapshot } from '../src/kb/raw-source-snapshot.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-progressive-source-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'raw');
  const releaseRoot = path.join(root, 'release');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(releaseRoot);
  const oldFile = path.join(sourceRoot, 'old.md');
  const csvFile = path.join(sourceRoot, 'old.csv');
  const newFile = path.join(sourceRoot, 'new.md');
  const oldText = 'Frozen original rules\n';
  const oldCsv = 'key,value\na,1\n';
  fs.writeFileSync(oldFile, oldText);
  fs.writeFileSync(csvFile, oldCsv);
  const baseOld: RawSourceSnapshotEntry = { objToken: 'old', objType: 'sheet', title: 'Old', relPath: 'old.md',
    contentHash: computeSourceHash(oldFile, [csvFile], sourceRoot), objEditTime: null };
  fs.writeFileSync(oldFile, 'Newer rules\n');
  fs.writeFileSync(csvFile, 'key,value\na,2\n');
  fs.writeFileSync(newFile, 'Reviewed new rules\n');
  const liveOld = { ...baseOld, contentHash: computeSourceHash(oldFile, [csvFile], sourceRoot) };
  const liveNew: RawSourceSnapshotEntry = { objToken: 'new', objType: 'docx', title: 'New', relPath: 'new.md',
    contentHash: computeSourceHash(newFile, [], sourceRoot), objEditTime: null };
  const combined = `${oldText}\n\n--- CSV 1 ---\n${oldCsv}`;
  const textBytes = Buffer.byteLength(oldText, 'utf8');
  const csvOffset = textBytes + Buffer.byteLength('\n\n--- CSV 1 ---\n', 'utf8');
  const index = {
    schemaVersion: 1, normalization: 'utf8-bytes-in-source-contents', evidenceFiles: [],
    resources: [
      { resourceId: 'old', sourceId: 'old', sourceSnapshotHash: baseOld.contentHash, kind: 'text',
        resourceHash: contentResourceHash(oldText), byteOffset: 0, byteLength: textBytes },
      { resourceId: 'old#csv:old.csv', sourceId: 'old', sourceSnapshotHash: baseOld.contentHash, kind: 'csv', path: 'old.csv',
        resourceHash: contentResourceHash(oldCsv), byteOffset: csvOffset, byteLength: Buffer.byteLength(oldCsv, 'utf8') },
    ],
  };
  const indexBytes = JSON.stringify(index);
  fs.writeFileSync(path.join(releaseRoot, 'evidence-resources.json'), indexBytes);
  fs.writeFileSync(path.join(releaseRoot, 'knowledge.json'), JSON.stringify({ evidence: [] }));
  const manifest = { sourceSnapshot: [baseOld], evidence: {
    resourcesPath: 'evidence-resources.json', hash: `sha256:${crypto.createHash('sha256').update(indexBytes).digest('hex')}`,
  } } as KbManifest;
  const live = RawSourceSnapshot.fromEntries([liveOld, liveNew], { sheetCsvPaths: (token) => token === 'old' ? [csvFile] : [] });
  return { root, sourceRoot, releaseRoot, manifest, live, combined, liveNew };
}

describe('progressive source snapshot', () => {
  it('carries a legacy text-only release without inventing a missing evidence index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-progressive-legacy-'));
    roots.push(root);
    const oldPath = path.join(root, 'old.md');
    fs.writeFileSync(oldPath, 'updated live text\n');
    const base = { objToken: 'old', objType: 'docx', title: '旧规则', relPath: 'old.md',
      contentHash: 'frozen-old-hash', objEditTime: null } as RawSourceSnapshotEntry;
    const live = RawSourceSnapshot.fromEntries([{ ...base, contentHash: computeSourceHash(oldPath, [], root) }]);
    const manifest = { sourceSnapshot: [base] } as KbManifest;
    const input = { entries: [base], live, manifest, releaseRoot: root,
      sourceContents: { old: 'original published text\n' }, promotedSources: new Set<string>() };
    const frozen = progressiveSourceSnapshot(input);
    expect(captureSourceContents(frozen, root)).toEqual({ old: 'original published text\n' });
    expect(() => progressiveSourceSnapshot({ ...input, sourceContents: {
      old: 'original published text\n\n--- CSV 1 ---\nkey,value\n',
    } })).toThrow('缺少基准来源证据区段');
  });

  it('uses frozen baseline text and CSV while verifying the newly promoted source live', () => {
    const { sourceRoot, releaseRoot, manifest, live, combined, liveNew } = fixture();
    const snapshot = progressiveSourceSnapshot({ entries: [...manifest.sourceSnapshot, liveNew], live, manifest,
      releaseRoot, sourceContents: { old: combined }, promotedSources: new Set(['new']) });
    expect(captureSourceContents(snapshot, sourceRoot)).toEqual({ old: combined, new: 'Reviewed new rules\n' });
    expect(snapshot.get('old')?.contentHash).toBe(manifest.sourceSnapshot[0]!.contentHash);
    expect(snapshot.get('new')?.contentHash).toBe(liveNew.contentHash);
  });

  it('refuses altered immutable evidence bytes before publication', () => {
    const { releaseRoot, manifest, live, combined, liveNew } = fixture();
    fs.appendFileSync(path.join(releaseRoot, 'evidence-resources.json'), ' ');
    expect(() => progressiveSourceSnapshot({ entries: [...manifest.sourceSnapshot, liveNew], live, manifest,
      releaseRoot, sourceContents: { old: combined }, promotedSources: new Set(['new']) }))
      .toThrow('证据索引与基准版本不一致');
  });

  it('rechecks carried citations and replaces stale cross-build read receipts', () => {
    const { sourceRoot, releaseRoot, manifest, live, combined, liveNew } = fixture();
    const snapshot = progressiveSourceSnapshot({ entries: [...manifest.sourceSnapshot, liveNew], live, manifest,
      releaseRoot, sourceContents: { old: combined }, promotedSources: new Set(['new']) });
    const draft = { objects: [{ objectId: 'object-old', canonical: { path: 'carry.md' } }], evidence: [{
      evidenceId: 'evidence-old', objectId: 'object-old',
      sourceRef: { sourceId: 'old', sourceSnapshotHash: manifest.sourceSnapshot[0]!.contentHash,
        resourceId: 'old', resourceHash: contentResourceHash('Frozen original rules\n') },
      selector: { kind: 'text_span', lineStart: 1, lineEnd: 1, colStart: 1, colEnd: 0, headingPath: [] },
      quoteHash: computeQuoteHash('Frozen original rules'), readReceiptId: 'old-build-receipt',
    }] } as Parameters<typeof seedProgressiveCarriedReceipts>[0]['draft'];
    const count = seedProgressiveCarriedReceipts({ stagingRoot: releaseRoot, buildId: 'build-new',
      knowledgeBaseRoot: sourceRoot, snapshot, draft, carriedPaths: new Set(['carry.md']),
      baselineReleaseRoot: releaseRoot, baselineEvidenceHash: manifest.evidence!.hash });
    expect(count).toBe(1);
    expect(draft.evidence[0]!.readReceiptId).toMatch(/^krr_stage_/);
    const receipt = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'read-receipts.jsonl'), 'utf8'));
    expect(receipt.readReceiptId).toBe(draft.evidence[0]!.readReceiptId);
    expect(receipt.toolCallId).toBe('progressive-baseline-carry');
  });

  it('carries a published image citation only when its immutable image bytes and caption still verify', () => {
    const { sourceRoot, releaseRoot, manifest } = fixture();
    const imageBytes = Buffer.from('immutable image bytes');
    const imageHash = `sha256:${crypto.createHash('sha256').update(imageBytes).digest('hex')}`;
    const resourceId = 'old#image:illustration.png';
    const imagePath = `evidence/image-${imageHash.slice(7, 23)}.bin`;
    fs.mkdirSync(path.join(releaseRoot, 'evidence'));
    fs.writeFileSync(path.join(releaseRoot, imagePath), imageBytes);
    const indexPath = path.join(releaseRoot, 'evidence-resources.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.resources.push({ resourceId, sourceId: 'old', sourceSnapshotHash: manifest.sourceSnapshot[0]!.contentHash,
      kind: 'image', resourceHash: imageHash });
    index.evidenceFiles.push({ resourceId, path: imagePath, hash: imageHash, bytes: imageBytes.length,
      kind: 'image', evidenceIds: ['image-evidence'],
      image: { src: 'illustration.png', imageHash, caption: 'Published image caption' } });
    const indexBytes = JSON.stringify(index);
    fs.writeFileSync(indexPath, indexBytes);
    const indexHash = `sha256:${crypto.createHash('sha256').update(indexBytes).digest('hex')}`;
    const draft = { objects: [{ objectId: 'object-old', canonical: { path: 'carry.md' } }], evidence: [{
      evidenceId: 'image-evidence', objectId: 'object-old',
      sourceRef: { sourceId: 'old', sourceSnapshotHash: manifest.sourceSnapshot[0]!.contentHash,
        resourceId, resourceHash: imageHash },
      selector: { kind: 'media_region', imageHash }, quoteHash: computeQuoteHash('Published image caption'),
      readReceiptId: 'old-build-receipt',
    }] } as Parameters<typeof seedProgressiveCarriedReceipts>[0]['draft'];
    const input = { stagingRoot: releaseRoot, buildId: 'build-new', knowledgeBaseRoot: sourceRoot,
      snapshot: new RawSourceSnapshot(manifest.sourceSnapshot), draft, carriedPaths: new Set(['carry.md']),
      baselineReleaseRoot: releaseRoot, baselineEvidenceHash: indexHash };
    expect(seedProgressiveCarriedReceipts(input)).toBe(1);
    expect(draft.evidence[0]!.readReceiptId).toMatch(/^krr_stage_/);
    const carried = rebindBaselineImageEvidence({ buildId: 'following-build', draft, snapshot: input.snapshot,
      releaseRoot, evidenceIndexHash: indexHash });
    expect(draft.evidence[0]!.readReceiptId).toMatch(/^krr_seed_/);
    expect(carried).toHaveLength(1);
    expect(JSON.parse(carried[0]!)).toMatchObject({ readReceiptId: draft.evidence[0]!.readReceiptId,
      buildId: 'following-build', toolCallId: 'baseline-carry-image', resourceId });
    const changed = new RawSourceSnapshot([{ ...manifest.sourceSnapshot[0]!, contentHash: 'changed-source' }]);
    expect(rebindBaselineImageEvidence({ buildId: 'changed-build', draft, snapshot: changed,
      releaseRoot, evidenceIndexHash: indexHash })).toEqual([]);
    fs.writeFileSync(path.join(releaseRoot, imagePath), 'tampered');
    expect(() => seedProgressiveCarriedReceipts(input)).toThrow('图片证据文件损坏');
    expect(() => rebindBaselineImageEvidence({ buildId: 'next-build', draft, snapshot: input.snapshot,
      releaseRoot, evidenceIndexHash: indexHash })).toThrow('图片证据文件损坏');
  });
});
