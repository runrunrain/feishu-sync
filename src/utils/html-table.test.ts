import { describe, expect, it } from 'vitest';
import {
  decodeHtmlEntities,
  extractHtmlTableBlocks,
  parseHtmlTable,
  parseSafeInlineStyle,
  sanitizeHtmlTable,
} from './html-table';

describe('html-table utilities', () => {
  describe('decodeHtmlEntities', () => {
    it('decodes standard HTML entities', () => {
      expect(decodeHtmlEntities('&lt;div&gt;&amp;&quot;&#39;&apos;&nbsp;')).toBe('<div>&"\'\'\u00A0');
    });

    it('decodes numeric and hex character references', () => {
      expect(decodeHtmlEntities('&#65;&#66;&#x43;')).toBe('ABC');
    });

    it('handles empty or normal strings without change', () => {
      expect(decodeHtmlEntities('')).toBe('');
      expect(decodeHtmlEntities('normal text')).toBe('normal text');
    });
  });

  describe('parseSafeInlineStyle', () => {
    it('parses whitelisted CSS properties', () => {
      const parsed = parseSafeInlineStyle('vertical-align: top; text-align: center; width: 100px;');
      expect(parsed).toEqual({
        verticalAlign: 'top',
        textAlign: 'center',
        width: '100px',
      });
    });

    it('ignores unsafe styles like expression, url, and javascript', () => {
      expect(parseSafeInlineStyle('background-image: url(javascript:alert(1))')).toEqual({});
      expect(parseSafeInlineStyle('width: expression(alert(1))')).toEqual({});
    });
  });

  describe('sanitizeHtmlTable', () => {
    it('strips script and style tags completely', () => {
      const input = '<table><script>alert("xss")</script><tr><td>test</td></tr><style>body{color:red}</style></table>';
      const clean = sanitizeHtmlTable(input);
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('alert');
      expect(clean).not.toContain('<style');
      expect(clean).toContain('<td>test</td>');
    });

    it('strips on* event handlers', () => {
      const input = '<table><tr><td onclick="bad()" onerror="bad2()">cell</td></tr></table>';
      const clean = sanitizeHtmlTable(input);
      expect(clean).not.toContain('onclick');
      expect(clean).not.toContain('onerror');
      expect(clean).toContain('cell');
    });

    it('disarms javascript: links', () => {
      const input = '<table><tr><td><a href="javascript:alert(1)">link</a></td></tr></table>';
      const clean = sanitizeHtmlTable(input);
      expect(clean).not.toContain('javascript:');
      expect(clean).toContain('href="#"');
    });
  });

  describe('parseHtmlTable', () => {
    it('parses a table with thead, tbody, colspan, rowspan, and vertical-align="top"', () => {
      const raw = `
        <table>
          <colgroup><col/><col/><col/></colgroup>
          <thead>
            <tr>
              <th vertical-align="top">机制</th>
              <th vertical-align="top">部队</th>
              <th vertical-align="top">塔</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td vertical-align="top">心态上限</td>
              <td vertical-align="top">100</td>
              <td vertical-align="top">100</td>
            </tr>
            <tr>
              <td colspan="3" vertical-align="top"><b>损失</b></td>
            </tr>
            <tr>
              <td vertical-align="top">心态≥80 伤害系数</td>
              <td vertical-align="top">100%</td>
              <td rowspan="4" vertical-align="top">远程开关（&gt;0有效）</td>
            </tr>
            <tr>
              <td vertical-align="top">心态 50–79 伤害系数</td>
              <td vertical-align="top">90%</td>
            </tr>
          </tbody>
        </table>
      `;

      const block = parseHtmlTable(raw);
      expect(block).not.toBeNull();
      expect(block!.type).toBe('html_table');
      expect(block!.colgroup?.length).toBe(3);

      // thead
      expect(block!.headRows.length).toBe(1);
      expect(block!.headRows[0].cells.length).toBe(3);
      expect(block!.headRows[0].cells[0]).toMatchObject({
        tag: 'th',
        content: '机制',
        valign: 'top',
      });

      // tbody
      expect(block!.bodyRows.length).toBe(4);
      // Row 0
      expect(block!.bodyRows[0].cells.length).toBe(3);
      expect(block!.bodyRows[0].cells[0].content).toBe('心态上限');

      // Row 1 with colspan=3 and <b>
      expect(block!.bodyRows[1].cells.length).toBe(1);
      expect(block!.bodyRows[1].cells[0]).toMatchObject({
        tag: 'td',
        colspan: 3,
        valign: 'top',
        content: '<b>损失</b>',
      });

      // Row 2 with rowspan=4
      expect(block!.bodyRows[2].cells.length).toBe(3);
      expect(block!.bodyRows[2].cells[2]).toMatchObject({
        tag: 'td',
        rowspan: 4,
        valign: 'top',
        content: '远程开关（&gt;0有效）',
      });

      // Row 3 (2 cells because 3rd column was spanned)
      expect(block!.bodyRows[3].cells.length).toBe(2);
    });

    it('parses tables without thead / tbody (direct tr)', () => {
      const raw = `
        <table>
          <tr><th>Col1</th><th>Col2</th></tr>
          <tr><td>A</td><td>B</td></tr>
        </table>
      `;
      const block = parseHtmlTable(raw);
      expect(block).not.toBeNull();
      expect(block!.headRows.length).toBe(1);
      expect(block!.headRows[0].cells[0].content).toBe('Col1');
      expect(block!.bodyRows.length).toBe(1);
      expect(block!.bodyRows[0].cells[0].content).toBe('A');
    });

    it('returns null for non-table strings', () => {
      expect(parseHtmlTable('not a table')).toBeNull();
      expect(parseHtmlTable('<table></table>')).toBeNull();
    });
  });

  describe('extractHtmlTableBlocks', () => {
    it('splits markdown text into paragraphs and table blocks', () => {
      const md = `
# 标题一

前置段落

<table>
  <thead><tr><th>Header</th></tr></thead>
  <tbody><tr><td>Cell</td></tr></tbody>
</table>

后置段落
      `;

      const segments = extractHtmlTableBlocks(md);
      expect(segments.length).toBe(3);
      expect(segments[0].type).toBe('text');
      expect(segments[0].content).toContain('# 标题一');
      expect(segments[1].type).toBe('table');
      if (segments[1].type === 'table') {
        expect(segments[1].block.headRows[0].cells[0].content).toBe('Header');
      }
      expect(segments[2].type).toBe('text');
      expect(segments[2].content).toContain('后置段落');
    });
  });
});
