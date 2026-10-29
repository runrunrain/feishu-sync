import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SyncResultList } from './SyncResultList';
import type { SyncResult } from '../types';

const base: SyncResult = {
  success: true, mode: 'apply', startedAt: '', completedAt: '', duration: 1000, failedDocuments: [],
  syncedDocuments: [{ objToken: 'sheet', title: '表格', localMdPath: 'sheet.md', cloudModifiedTime: '',
    size: 100, imagesCount: 0, attachmentsCount: 0, sheetsCount: 1, sheetAcquisition: 'csv-fallback',
    sheetAcquisitionIssue: '单元格资源不可读取' }],
};

describe('同步结果', () => {
  it('distinguishes a saved CSV fallback from a completed Excel sync', () => {
    const html = renderToStaticMarkup(<SyncResultList result={base} />);
    expect(html).toContain('同步完成（含待修复项）');
    expect(html).toContain('0 成功 / 1 待修复 / 0 失败');
    expect(html).toContain('CSV 后备已保存');
    expect(html).toContain('单元格资源不可读取');
    expect(html).not.toContain('成功 (1)');
  });

  it('counts a reconstructed workbook as a completed sync', () => {
    const result: SyncResult = { ...base, syncedDocuments: [{ ...base.syncedDocuments[0], sheetAcquisition: 'read-reconstruction' }] };
    const html = renderToStaticMarkup(<SyncResultList result={result} />);
    expect(html).toContain('1 成功 / 0 失败');
    expect(html).toContain('只读重建 Excel');
    expect(html).not.toContain('待修复');
  });
});
