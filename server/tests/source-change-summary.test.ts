import { describe, expect, it } from 'vitest';
import { contentResourceHash } from '../src/kb/evidence-locator.js';
import { summarizeSourceChanges, type SourceChangeBaseline } from '../src/kb/source-change-summary.js';

function fixture() {
  const before = Array.from({ length: 30 }, (_, index) => `rule ${index + 1}`).join('\n');
  const lines = before.split('\n'); lines[14] = 'changed rule';
  const baseline: SourceChangeBaseline = { releaseId: 'r1', contents: { tok: before }, index: {
    schemaVersion: 1, normalization: 'utf8-bytes-in-source-contents', evidenceFiles: [], resources: [{
      resourceId: 'tok', sourceId: 'tok', sourceSnapshotHash: 'old', kind: 'text',
      resourceHash: contentResourceHash(before), byteOffset: 0, byteLength: Buffer.byteLength(before),
    }],
  } };
  return { baseline, input: { resources: [{ resourceId: 'tok', sourceId: 'tok', kind: 'text' as const, lines }],
    // A derived image description separates raw text output coordinates.
    segments: [{ resourceId: 'tok', resStart: 1, resEnd: 10, outStart: 1, outEnd: 10 },
      { outStart: 11, outEnd: 20 }, { resourceId: 'tok', resStart: 11, resEnd: 30, outStart: 21, outEnd: 40 }] } };
}

describe('incremental source reading hints', () => {
  it('identifies the changed resource and maps a bounded reading range through derived output', () => {
    const { baseline, input } = fixture();
    expect(summarizeSourceChanges(baseline, input)).toMatchObject({ baselineAvailable: true, unchangedResources: 0,
      changes: [{ resourceId: 'tok', change: 'changed', resourceLineStart: 12, resourceLineEnd: 18,
        outputStart: 22, outputEnd: 28 }] });
    input.resources[0]!.lines = baseline.contents.tok!.split('\n');
    expect(summarizeSourceChanges(baseline, input)).toMatchObject({ unchangedResources: 1, changes: [] });
  });

  it('reports unindexed legacy sheets as unknown and identifies removed indexed sheets', () => {
    const { baseline, input } = fixture();
    baseline.index!.resources.push({ ...baseline.index!.resources[0]!, resourceId: 'tok#csv:gone.csv', kind: 'csv', path: 'gone.csv' });
    const withUnknown = { ...input, resources: [...input.resources,
      { resourceId: 'tok#csv:unindexed.csv', sourceId: 'tok', kind: 'csv' as const, lines: ['a,b'] }] };
    const summary = summarizeSourceChanges(baseline, withUnknown);
    expect(summary.changes).toContainEqual({ resourceId: 'tok#csv:unindexed.csv', change: 'baseline_unindexed', currentLines: 1 });
    expect(summary.changes).toContainEqual({ resourceId: 'tok#csv:gone.csv', change: 'removed' });
    expect(summarizeSourceChanges(null, withUnknown).baselineAvailable).toBe(false);
  });

  it('rejects corrupt frozen bytes instead of declaring them a source change', () => {
    const { baseline, input } = fixture();
    baseline.contents.tok = 'corrupt';
    expect(() => summarizeSourceChanges(baseline, input)).toThrow('基准区段无效');
  });
});
