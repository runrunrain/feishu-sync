import { describe, expect, it } from 'vitest';
import { parseCiteTag } from './feishu-cite';
import { extractFeishuTenantHost, resolveFeishuTenantHost } from './feishu-url';

describe('feishu cite utilities', () => {
  describe('extractFeishuTenantHost and resolveFeishuTenantHost', () => {
    it('extracts tenant host from canonical wiki URL', () => {
      const url = 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb';
      expect(extractFeishuTenantHost(url)).toBe('qcnbafdrjx7n.feishu.cn');
    });

    it('extracts tenant host from share URL with query params', () => {
      const url = 'https://tenant-1.feishu.cn/wiki/abc1234?fromScene=spaceOverview';
      expect(extractFeishuTenantHost(url)).toBe('tenant-1.feishu.cn');
    });

    it('returns null for non-feishu or invalid URLs', () => {
      expect(extractFeishuTenantHost('https://google.com/test')).toBeNull();
      expect(extractFeishuTenantHost('not-a-url')).toBeNull();
      expect(extractFeishuTenantHost(null)).toBeNull();
      expect(extractFeishuTenantHost(undefined)).toBeNull();
    });

    it('resolves first valid host from watchedRootUrls or watchedRoots', () => {
      const urls = [
        'invalid',
        'https://my-team.feishu.cn/wiki/TOKEN1',
        'https://other.feishu.cn/wiki/TOKEN2',
      ];
      expect(resolveFeishuTenantHost(urls)).toBe('my-team.feishu.cn');

      const roots = [
        { url: 'https://roots-team.feishu.cn/wiki/ROOT1' },
      ];
      expect(resolveFeishuTenantHost([], roots)).toBe('roots-team.feishu.cn');
    });
  });

  describe('parseCiteTag', () => {
    it('parses standard doc cite tag with title and doc-id', () => {
      const tag = '<cite doc-id="DUZzwzedWiXmeSk9gGscuWCuneh" file-type="wiki" title="战斗实体感知吸引力-300 by 小星" type="doc"></cite>';
      const parsed = parseCiteTag(tag, 'qcnbafdrjx7n.feishu.cn');

      expect(parsed.docId).toBe('DUZzwzedWiXmeSk9gGscuWCuneh');
      expect(parsed.title).toBe('战斗实体感知吸引力-300 by 小星');
      expect(parsed.displayText).toBe('战斗实体感知吸引力-300 by 小星');
      expect(parsed.url).toBe('https://qcnbafdrjx7n.feishu.cn/wiki/DUZzwzedWiXmeSk9gGscuWCuneh');
    });

    it('falls back to docId as displayText if title is missing', () => {
      const tag = '<cite doc-id="TOKEN123" file-type="wiki" type="doc"></cite>';
      const parsed = parseCiteTag(tag, 'my-team.feishu.cn');

      expect(parsed.docId).toBe('TOKEN123');
      expect(parsed.title).toBeNull();
      expect(parsed.displayText).toBe('TOKEN123');
      expect(parsed.url).toBe('https://my-team.feishu.cn/wiki/TOKEN123');
    });

    it('falls back to feishu.cn if tenantHost is omitted', () => {
      const tag = '<cite doc-id="TOKEN123" title="测试标题"></cite>';
      const parsed = parseCiteTag(tag);

      expect(parsed.url).toBe('https://feishu.cn/wiki/TOKEN123');
      expect(parsed.displayText).toBe('测试标题');
    });

    it('handles user cite tag without doc-id gracefully', () => {
      const tag = '<cite type="user" user-id="ou_7ba878dd433a8c1c4dba82596c3b472c" user-name="赵春玉(Joey)"></cite>';
      const parsed = parseCiteTag(tag);

      expect(parsed.docId).toBeNull();
      expect(parsed.url).toBeNull();
      expect(parsed.displayText).toBe('@赵春玉(Joey)');
    });

    it('handles empty or malformed cite tag without crashing', () => {
      const emptyTag = '<cite></cite>';
      const parsedEmpty = parseCiteTag(emptyTag);
      expect(parsedEmpty.docId).toBeNull();
      expect(parsedEmpty.url).toBeNull();
      expect(parsedEmpty.displayText).toBe('');

      const malformedTag = '<cite doc-id=broken-attr';
      const parsedMalformed = parseCiteTag(malformedTag);
      expect(parsedMalformed.docId).toBe('broken-attr');
      expect(parsedMalformed.url).toBe('https://feishu.cn/wiki/broken-attr');
    });

    it('decodes HTML entities inside cite title', () => {
      const tag = '<cite doc-id="TOKEN" title="&lt;示例&gt; &amp; &quot;说明&quot;"></cite>';
      const parsed = parseCiteTag(tag);
      expect(parsed.title).toBe('<示例> & "说明"');
      expect(parsed.displayText).toBe('<示例> & "说明"');
    });
  });
});
