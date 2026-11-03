import { describe, expect, it } from 'vitest';
import { annotateRawReadPage, compactBlankCsvPage, skipBlankCsvContinuation } from '../src/kb/csv-read-compact.js';

describe('compactBlankCsvPage', () => {
  const content = 'A,B\nx,y\n,\n,\n,\n,\nz,w\n"multi\n,\nline",x';
  const lines = content.split('\n');
  const segments = [{ resourceId: 'source#csv:table.csv', outStart: 1, outEnd: lines.length, resStart: 1 }];
  const resources = [{ resourceId: 'source#csv:table.csv', kind: 'csv' as const, lines }];

  it('折叠完整空白逻辑记录，同时保留原始物理行坐标和多行引号内容', () => {
    const display = compactBlankCsvPage(lines, 0, segments, resources);
    expect(display).toEqual([
      'A,B', 'x,y',
      '<blank_csv_rows resource_id="source#csv:table.csv" resource_lines="3-6" output_lines="3-6" count="4" />',
      'z,w', '"multi', ',', 'line",x',
    ]);
  });

  it('仍按原始页界分片，短空白段与正文行不压缩', () => {
    expect(compactBlankCsvPage(lines.slice(2, 4), 2, segments, resources)).toEqual([',', ',']);
    expect(compactBlankCsvPage(['文本', ',', ',', ','], 0,
      [{ resourceId: 'source', outStart: 1, outEnd: 4, resStart: 1 }],
      [{ resourceId: 'source', kind: 'text', lines: ['文本', ',', ',', ','] }])).toEqual(['文本', ',', ',', ',']);
  });

  it('续页游标跨过已验证的长空白 CSV 段，仍使用原始行坐标', () => {
    const skip = skipBlankCsvContinuation(2, lines.length, segments, resources);
    expect(skip).toEqual({
      nextOffset: 6,
      skipped: { resourceId: 'source#csv:table.csv', outputStart: 3, outputEnd: 6,
        resourceStart: 3, resourceEnd: 6 },
    });
    expect(skipBlankCsvContinuation(7, lines.length, segments, resources))
      .toEqual({ nextOffset: 7, skipped: null });
  });

  it('逐行标出拼接坐标、资源行与 CSV 逻辑记录，折叠空行后仍不漂移', () => {
    expect(annotateRawReadPage(lines, 0, segments, resources)).toEqual([
      '[O1/R1/C1] A,B', '[O2/R2/C2] x,y',
      '<blank_csv_rows resource_id="source#csv:table.csv" resource_lines="3-6" output_lines="3-6" count="4" />',
      '[O7/R7/C7] z,w', '[O8/R8/C8] "multi', '[O9/R9/C8] ,', '[O10/R10/C8] line",x',
    ]);
    expect(annotateRawReadPage(lines.slice(2, 4), 2, segments, resources, true))
      .toEqual(['[O3/R3/C3] ,', '[O4/R4/C4] ,']);
    expect(annotateRawReadPage(['heading', 'text'], 4,
      [{ resourceId: 'source', outStart: 5, outEnd: 6, resStart: 2 }],
      [{ resourceId: 'source', kind: 'text', lines: ['first', 'heading', 'text'] }]))
      .toEqual(['[O5/R2] heading', '[O6/R3] text']);
  });
});
