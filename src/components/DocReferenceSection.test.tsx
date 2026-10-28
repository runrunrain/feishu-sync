/**
 * P1-S4 引用消费前端组件测试（SSR）：
 *  - DocReferenceSection：引用/被引用列表（标题+方向+类型+未同步标记）、
 *    两侧皆空不渲染
 *  - SourceReferenceLossWarning：删除确认的引用悬空风险提示文案
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocReferenceSection } from './DocReferenceSection';
import { SourceReferenceLossWarning } from './SourceBatchDialog';
import type { DocumentContent } from '../types';

const content = (overrides: Partial<DocumentContent> = {}): DocumentContent => ({
  objToken: 'a',
  title: 'A',
  objType: 'docx',
  mdPath: 'a.md',
  mdContent: '# A',
  mdTruncated: false,
  csvTables: [],
  ...overrides,
});

describe('DocReferenceSection', () => {
  it('展开态：出边/入边列表（标题、方向、类型、未同步标记）', () => {
    const html = renderToStaticMarkup(
      <DocReferenceSection
        defaultOpen
        content={content({
          references: [
            { direction: 'out', token: 'wiki-b', targetType: 'docx', origin: 'body', kind: 'link', title: 'B 文档', occurrences: 2, objToken: 'b', localRelPath: 'b.md', synced: true },
            { direction: 'out', token: 'ext-0000000000000', targetType: 'sheet', origin: 'body', kind: 'link', title: '外部表', occurrences: 1, objToken: null, localRelPath: null, synced: false },
          ],
          referencedBy: [
            { srcObjToken: 'd', targetToken: 'a', targetType: 'docx', label: null, origin: 'body', kind: 'cite', occurrences: 1, updatedAt: '', srcTitle: 'D 文档', srcLocalRelPath: 'd.md' },
          ],
        })}
      />,
    );
    expect(html).toContain('本文档引用');
    expect(html).toContain('B 文档');
    expect(html).toContain('外部表');
    expect(html).toContain('表格');
    expect(html).toContain('未纳入同步');
    expect(html).toContain('引用本文档');
    expect(html).toContain('D 文档');
    expect(html).toContain('（引用 2 · 被引用 1）');
  });

  it('收起态默认不列明细，但头部计数可见；两侧皆空不渲染', () => {
    const collapsed = renderToStaticMarkup(
      <DocReferenceSection
        content={content({ references: [{ direction: 'out', token: 'wiki-b', targetType: 'docx', origin: 'body', kind: 'link', title: 'B', occurrences: 1, objToken: 'b', localRelPath: 'b.md', synced: true }] })}
      />,
    );
    expect(collapsed).toContain('引用关系');
    expect(collapsed).not.toContain('本文档引用');
    expect(renderToStaticMarkup(<DocReferenceSection content={content()} />)).toBe('');
  });
});

describe('SourceReferenceLossWarning', () => {
  it('风险提示：计数、文档标题与引用方清单；超 3 个引用方折叠为「等」', () => {
    const html = renderToStaticMarkup(
      <SourceReferenceLossWarning
        items={[
          { objToken: 'a', title: '文档a', referencedByCount: 5, sources: [
            { objToken: 'b', title: '文档b', localRelPath: 'b.md' },
            { objToken: 'c', title: '文档c', localRelPath: 'c.md' },
            { objToken: 'd', title: '文档d', localRelPath: 'd.md' },
            { objToken: 'e', title: '文档e', localRelPath: 'e.md' },
          ] },
        ]}
      />,
    );
    expect(html).toContain('引用悬空风险：1 篇待删文档被选集外的文档引用');
    expect(html).toContain('「文档a」被 5 篇引用');
    expect(html).toContain('文档b、文档c、文档d');
    expect(html).toContain('等');
  });

  it('空清单不渲染', () => {
    expect(renderToStaticMarkup(<SourceReferenceLossWarning items={[]} />)).toBe('');
  });
});
