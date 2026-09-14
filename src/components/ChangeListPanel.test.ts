import { describe, expect, it } from 'vitest';
import { groupDiffChanges, computeSelectableDocs } from './ChangeListPanel';
import type { ChangedDocument, DiffReport } from '../types';

function makeDoc(overrides: Partial<ChangedDocument>): ChangedDocument {
  return {
    objToken: 'tok_test',
    objType: 'docx',
    title: '测试文档',
    changeType: 'modified',
    cloudModifiedTime: '2026-09-14T08:00:00.000Z',
    localSyncedTime: null,
    localMdPath: 'test/doc.md',
    ...overrides,
  };
}

describe('ChangeListPanel logic & contracts', () => {
  it('correctly classifies added, modified, mediaGap and deleted documents', () => {
    const docAdded = makeDoc({ objToken: 't1', changeType: 'added' });
    const docModNormal = makeDoc({ objToken: 't2', changeType: 'modified' });
    const docMediaGap = makeDoc({
      objToken: 't3',
      changeType: 'modified',
      mediaGapReason: 'missing 2 images',
    });
    const docDeleted = makeDoc({ objToken: 't4', changeType: 'deleted' });

    const diff: DiffReport = {
      added: [docAdded],
      modified: [docModNormal, docMediaGap],
      deleted: [docDeleted],
      unchanged: 10,
      totalCloud: 14,
      totalLocal: 13,
      checkedAt: '2026-09-14T10:00:00.000Z',
    };

    const grouped = groupDiffChanges(diff);
    expect(grouped.added).toHaveLength(1);
    expect(grouped.modified).toHaveLength(1);
    expect(grouped.mediaGap).toHaveLength(1);
    expect(grouped.deleted).toHaveLength(1);

    expect(grouped.added[0].objToken).toBe('t1');
    expect(grouped.modified[0].objToken).toBe('t2');
    expect(grouped.mediaGap[0].objToken).toBe('t3');
    expect(grouped.deleted[0].objToken).toBe('t4');
  });

  it('preserves empty groups when diff is null', () => {
    const grouped = groupDiffChanges(null);
    expect(grouped.added).toEqual([]);
    expect(grouped.modified).toEqual([]);
    expect(grouped.mediaGap).toEqual([]);
    expect(grouped.deleted).toEqual([]);
  });

  describe('computeSelectableDocs regression red-lines', () => {
    const added = [makeDoc({ objToken: 'a1', changeType: 'added' })];
    const modified = [makeDoc({ objToken: 'm1', changeType: 'modified' })];
    const mediaGap = [makeDoc({ objToken: 'mg1', changeType: 'modified', mediaGapReason: 'gap' })];
    const deleted = [makeDoc({ objToken: 'd1', changeType: 'deleted' })];
    const grouped = { added, modified, mediaGap, deleted };

    it('tab=all: selectable includes ONLY added + modified, strictly excludes mediaGap and deleted', () => {
      const selectable = computeSelectableDocs('all', grouped);
      const tokens = selectable.map((d) => d.objToken);
      expect(tokens).toContain('a1');
      expect(tokens).toContain('m1');
      expect(tokens).not.toContain('mg1');
      expect(tokens).not.toContain('d1');
      expect(selectable).toHaveLength(2);
    });

    it('tab=added: selects only added docs', () => {
      const selectable = computeSelectableDocs('added', grouped);
      expect(selectable.map((d) => d.objToken)).toEqual(['a1']);
    });

    it('tab=modified: selects only modified docs', () => {
      const selectable = computeSelectableDocs('modified', grouped);
      expect(selectable.map((d) => d.objToken)).toEqual(['m1']);
    });

    it('tab=mediaGap: selectable is scoped to mediaGap items only', () => {
      const selectable = computeSelectableDocs('mediaGap', grouped);
      expect(selectable.map((d) => d.objToken)).toEqual(['mg1']);
    });

    it('tab=deleted: selectable is strictly empty (cannot batch-sync deleted)', () => {
      const selectable = computeSelectableDocs('deleted', grouped);
      expect(selectable).toEqual([]);
    });
  });
});
