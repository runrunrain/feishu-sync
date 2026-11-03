import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileBlankCsvCoverage } from '../src/kb/blank-csv-coverage.js';
import { selectProgressiveCoverage } from '../src/kb/progressive-coverage.js';
import type { CoverageItem } from '../src/kb/knowledge-schema.js';
import type { RawSourceSnapshot } from '../src/kb/raw-source-snapshot.js';

function item(sourceId: string, category: string, reason = ''): CoverageItem {
  return {
    itemId: `${sourceId}:${category}`,
    sourceRef: { sourceId, sourceSnapshotHash: 'hash', resourceId: sourceId, resourceHash: 'hash' },
    category, importance: 'important', disposition: 'unresolved', targetObjectIds: [], reason,
  };
}

describe('mechanical coverage reconciliation', () => {
  it('excludes only source-proven empty workbook tabs', () => {
    const coverage = [
      item('source', '③配置表设计（回填）'),
      item('source', 'data_structure', '子表「③配置表设计（回填）」正文为空，待回填'),
      item('source', '②数据设计'),
      item('source', '④编辑功能设计'),
      item('source', 'rule', '有内容的规则待人工核对'),
    ];
    const content = [
      '## 子表: ③配置表设计（回填）', '[CSV 原始数据](x.csv)', '', '---',
      '## 子表: ②数据设计', '[CSV 原始数据](y.csv)', '', '---',
      '## 子表: ④编辑功能设计', '[CSV 原始数据](z.csv)', '实际编辑规则', '', '---',
    ].join('\n');
    const snapshot = {
      get: () => ({}),
      readVerified: () => ({ content, attachments: [
        { path: '③配置表设计（回填）.csv', content: ',,\n,,\n' },
        { path: '②数据设计.csv', content: 'rule,field\n' },
        { path: '④编辑功能设计.csv', content: ',,\n' },
      ] }),
    } as unknown as RawSourceSnapshot;
    expect(reconcileBlankCsvCoverage(coverage, snapshot, '/source')).toBe(2);
    expect(coverage.map((entry) => entry.disposition)).toEqual([
      'excluded_template', 'excluded_template', 'unresolved', 'unresolved', 'unresolved',
    ]);
    expect(coverage[0]?.reason).toContain('来源填充后需重新构建');
  });

  it('keeps pending blockers outside the promoted source out of a stage', () => {
    const carried = { ...item('old', 'definition'), disposition: 'mapped' as const, targetObjectIds: ['object'] };
    const ready = { ...item('ready', 'rule'), disposition: 'mapped' as const, targetObjectIds: ['ready-object'] };
    const blocked = item('pending', 'missing');
    expect(selectProgressiveCoverage([carried], [ready, blocked], {
      promotedSources: new Set(['ready']), includedObjectIds: new Set(['object', 'ready-object']),
      promotedObjectIds: new Set(['ready-object']), retainedSources: new Set(['old']),
    }))
      .toEqual([carried, ready]);
  });

  it('同一来源仅晋级已审文档的覆盖项，保留正式兄弟文档的覆盖项', () => {
    const from = (name: string, objectIds: string[]) => ({
      ...item('shared', name), disposition: 'mapped' as const, targetObjectIds: objectIds,
    });
    const carried = from('carried', ['old-object']);
    const ready = from('ready', ['ready-object']);
    const unfinished = from('unfinished', ['draft-object']);
    const selected = selectProgressiveCoverage([carried], [ready, unfinished], {
      promotedSources: new Set(['shared']), includedObjectIds: new Set(['old-object', 'ready-object']),
      promotedObjectIds: new Set(['ready-object']), retainedSources: new Set(['shared']),
    });
    expect(selected).toEqual([carried, ready]);
  });

  it('reads a linked sibling CSV when the old sheet index omitted its attachment', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-csv-'));
    try {
      const sourcePath = path.join(root, '表格.md');
      const csvDir = path.join(root, '表格.csv-data');
      fs.mkdirSync(csvDir);
      fs.writeFileSync(path.join(csvDir, '配置.csv'), ',,\n');
      const content = '## 子表: 配置\n\n[CSV 原始数据](表格.csv-data/配置.csv)\n\n---\n';
      fs.writeFileSync(sourcePath, content);
      const snapshot = {
        get: () => ({}), readVerified: () => ({ content, realPath: sourcePath, attachments: [] }),
      } as unknown as RawSourceSnapshot;
      const coverage = [item('source', '配置')];
      expect(reconcileBlankCsvCoverage(coverage, snapshot, root)).toBe(1);
      expect(coverage[0]?.disposition).toBe('excluded_template');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
