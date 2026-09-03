/**
 * media-gap 模块单测
 *
 * 覆盖契约：
 *   1. stripFeishuSyncHeader: 剥离首部 feishu_sync YAML 注释块，保留普通注释与正文
 *   2. scanRawMediaTags: 识别正文中各类未本地化原始媒体标签（whiteboard/image/file/source/img，
 *      含 <synced-source> 包裹、自闭合、乱序属性、已本地化 token 过滤）
 *   3. collectLocalImageRefs: 文档目录 md 与 *.csv-data/*.csv 图片引用聚合与文件名去重
 *   4. detectMediaGaps:
 *      - docx 正文残留标签检测与 detail 统计
 *      - sheet 云端 vs 本地计数三态（多/等/少）
 *      - workbook-info 抛错软失败容错
 *      - 缺失文件与非 synced 状态守卫
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  stripFeishuSyncHeader,
  scanRawMediaTags,
  collectLocalImageRefs,
  detectMediaGaps,
  __resetWorkbookInfoCacheForTest,
} from '../src/modules/media-gap.js';
import type { DocumentRecord } from '../src/types/index.js';

describe('media-gap unit tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-gap-test-'));
    // workbook-info 结果缓存是模块级单例，用例间必须重置，
    // 否则前一个用例的真实调用会污染后续 mock 断言。
    __resetWorkbookInfoCacheForTest();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // -------------------------------------------------------------------------
  // 1. stripFeishuSyncHeader
  // -------------------------------------------------------------------------
  describe('stripFeishuSyncHeader', () => {
    it('strips leading feishu_sync YAML comment block and leaves body intact', () => {
      const md = `<!--
feishu_sync:
  obj_token: "I4DqdGJJ7oqg5hx5ltnc6Jk1n3b"
  wiki_node_token: "JqWNwfbqliQU7NkfN3hcQJIKnAb"
  obj_type: "docx"
-->
# 标题

正文内容
`;
      const stripped = stripFeishuSyncHeader(md);
      expect(stripped).toBe('# 标题\n\n正文内容\n');
    });

    it('tolerates leading blank lines before feishu_sync comment block', () => {
      const md = `

<!--
feishu_sync:
  obj_token: "tok123"
-->
# 标题
`;
      const stripped = stripFeishuSyncHeader(md);
      expect(stripped).toBe('# 标题\n');
    });

    it('leaves content intact if opening comment is not a feishu_sync header', () => {
      const md = `<!-- Copyright 2026 -->\n# 标题`;
      expect(stripFeishuSyncHeader(md)).toBe(md);
    });

    it('leaves content intact if there is no opening comment', () => {
      const md = `# 普通文档\n正文内容`;
      expect(stripFeishuSyncHeader(md)).toBe(md);
    });

    it('handles empty or blank input gracefully', () => {
      expect(stripFeishuSyncHeader('')).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // 2. scanRawMediaTags
  // -------------------------------------------------------------------------
  describe('scanRawMediaTags', () => {
    it('recognizes standard whiteboard tags (open/close and self-closing)', () => {
      const body = `
<whiteboard token="SPb7wKhdzhscrubfoMOcRiYanrc"></whiteboard>
<whiteboard token="KCDLwL0FzhIlH8buDwIcyf6DnVh" />
`;
      const tokens = scanRawMediaTags(body);
      expect(tokens).toEqual([
        'SPb7wKhdzhscrubfoMOcRiYanrc',
        'KCDLwL0FzhIlH8buDwIcyf6DnVh',
      ]);
    });

    it('recognizes raw tags wrapped inside <synced-source>', () => {
      const body = `
<synced-source><whiteboard token="HhSAwzL6VhXsyvbhkMdc5X4cn7d"></whiteboard></synced-source>
`;
      const tokens = scanRawMediaTags(body);
      expect(tokens).toEqual(['HhSAwzL6VhXsyvbhkMdc5X4cn7d']);
    });

    it('recognizes image, file, source and img raw tags', () => {
      const body = `
<image token="boxcn_img_123" />
<file token="boxcn_file_456" />
<source token="boxcn_source_789" />
<img src="ZOpibM5HmovQ21xhmdyc9c0pnyK" alt="test" />
`;
      const tokens = scanRawMediaTags(body);
      expect(tokens).toEqual([
        'boxcn_img_123',
        'boxcn_file_456',
        'boxcn_source_789',
        'ZOpibM5HmovQ21xhmdyc9c0pnyK',
      ]);
    });

    it('handles disordered attributes correctly', () => {
      const body = `
<whiteboard class="board" id="w1" token="disordered_token" data-kind="wb"></whiteboard>
<img alt="preview" width="300" src="img_token_order" height="200"/>
`;
      const tokens = scanRawMediaTags(body);
      expect(tokens).toEqual(['disordered_token', 'img_token_order']);
    });

    it('does NOT report tags that are already localized (images/ or attachments/)', () => {
      const body = `
<whiteboard token="images/01-abc.jpg"></whiteboard>
<whiteboard token="images\\02-win.png" />
<file token="attachments/guide.pdf"></file>
<source token="attachments\\spec.docx" />
<img src="images/banner.png" />
<image token="images/diagram.svg" />
`;
      const tokens = scanRawMediaTags(body);
      expect(tokens).toEqual([]);
    });

    it('extracts unlocalized tokens while ignoring localized ones in mixed content', () => {
      const body = `
<whiteboard token="images/already_done.jpg"></whiteboard>
<whiteboard token="raw_whiteboard_1"></whiteboard>
<file token="attachments/done.pdf"/>
<file token="raw_file_2"/>
`;
      const tokens = scanRawMediaTags(body);
      expect(tokens).toEqual(['raw_whiteboard_1', 'raw_file_2']);
    });
  });

  // -------------------------------------------------------------------------
  // 3. collectLocalImageRefs
  // -------------------------------------------------------------------------
  describe('collectLocalImageRefs', () => {
    it('collects and deduplicates image references across md and csv files', () => {
      const docDir = path.join(tmpDir, '战斗技能系统');
      const csvDataDir = path.join(docDir, '战斗技能系统.csv-data');
      fs.mkdirSync(csvDataDir, { recursive: true });

      // Markdown file contains appendix and inline references
      const mdContent = `
# 战斗技能系统

![图片: A7](images/idea_A7.jpg)
  ![idea A7 浮动图片](images/idea_A7.jpg)
* **![图片**：D3](images/flow_D3.png)
`;
      fs.writeFileSync(path.join(docDir, '战斗技能系统.md'), mdContent, 'utf-8');

      // CSV file also contains the same image reference
      const csvContent = `
col1,col2,col3
val1,![图片: A7](images/idea_A7.jpg),val3
`;
      fs.writeFileSync(path.join(csvDataDir, 'idea.csv'), csvContent, 'utf-8');

      const refs = collectLocalImageRefs(docDir);
      // idea_A7.jpg appears in md twice and csv once, but must only be counted once
      expect(Array.from(refs).sort()).toEqual(['flow_D3.png', 'idea_A7.jpg'].sort());
    });

    it('returns empty set if directory does not exist or has no images', () => {
      expect(collectLocalImageRefs(path.join(tmpDir, 'nonexistent'))).toEqual(new Set());

      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });
      fs.writeFileSync(path.join(emptyDir, 'test.md'), '# No images here', 'utf-8');
      expect(collectLocalImageRefs(emptyDir)).toEqual(new Set());
    });
  });

  // -------------------------------------------------------------------------
  // 4. detectMediaGaps
  // -------------------------------------------------------------------------
  describe('detectMediaGaps', () => {
    const makeDocRecord = (overrides: Partial<DocumentRecord>): DocumentRecord => ({
      objToken: 'tok_default',
      wikiNodeToken: 'wiki_default',
      objType: 'docx',
      title: 'Default Title',
      localMdPath: 'Default.md',
      lastSyncedModifyTime: '2026-07-01T00:00:00.000Z',
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
      status: 'synced',
      syncState: 'synced',
      ...overrides,
    });

    it('detects docx local_placeholder_tags gap when raw tags exist', async () => {
      const mdPath = path.join(tmpDir, 'DocWithTags.md');
      fs.writeFileSync(
        mdPath,
        `<!--
feishu_sync:
  obj_token: "doc_1"
-->
# 标题
<whiteboard token="wb_1"></whiteboard>
<whiteboard token="wb_2"></whiteboard>
`,
        'utf-8',
      );

      const record = makeDocRecord({
        objToken: 'doc_1',
        objType: 'docx',
        localMdPath: mdPath,
      });

      const client = {
        getWorkbookInfo: async () => ({ sheets: [] }),
      };

      const gaps = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: client,
      });

      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toEqual({
        objToken: 'doc_1',
        reason: 'local_placeholder_tags',
        detail: 2,
      });
    });

    it('produces no gap for clean docx without raw tags', async () => {
      const mdPath = path.join(tmpDir, 'CleanDoc.md');
      fs.writeFileSync(
        mdPath,
        `<!--
feishu_sync:
  obj_token: "doc_clean"
-->
# 标题
![飞书白板](images/01-wb.jpg)
`,
        'utf-8',
      );

      const record = makeDocRecord({
        objToken: 'doc_clean',
        objType: 'docx',
        localMdPath: mdPath,
      });

      const client = {
        getWorkbookInfo: async () => ({ sheets: [] }),
      };

      const gaps = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: client,
      });

      expect(gaps).toHaveLength(0);
    });

    it('evaluates sheet cloud vs local image count: 多 / 等 / 少 三态', async () => {
      const sheetDir = path.join(tmpDir, 'SheetTest');
      fs.mkdirSync(sheetDir, { recursive: true });
      const mdPath = path.join(sheetDir, 'SheetDoc.md');
      fs.writeFileSync(
        mdPath,
        `<!--
feishu_sync:
  obj_token: "sheet_tok"
-->
# 表格
![图片](images/existing1.png)
`,
        'utf-8',
      );

      const record = makeDocRecord({
        objToken: 'sheet_tok',
        objType: 'sheet',
        localMdPath: mdPath,
      });

      // 1. 多态 (cloud 2 > local 1) -> gap
      const clientMore = {
        getWorkbookInfo: async () => ({
          data: {
            sheets: [
              { sheet_id: 's1', float_image_count: 1 },
              { sheet_id: 's2', float_image_count: 1 },
            ],
          },
        }),
      };
      const gapsMore = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: clientMore,
        apiScope: 'full',
      });
      expect(gapsMore).toHaveLength(1);
      expect(gapsMore[0]).toEqual({
        objToken: 'sheet_tok',
        reason: 'sheet_cloud_images_missing',
        detail: '云端 2 张 / 本地 1 张',
      });

      // 2. 等态 (cloud 1 == local 1) -> no gap（重置缓存后独立核对）
      __resetWorkbookInfoCacheForTest();
      const clientEqual = {
        getWorkbookInfo: async () => ({
          data: {
            sheets: [{ sheet_id: 's1', float_image_count: 1 }],
          },
        }),
      };
      const gapsEqual = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: clientEqual,
        apiScope: 'full',
      });
      expect(gapsEqual).toHaveLength(0);

      // 3. 少态 (cloud 0 < local 1) -> no gap（重置缓存后独立核对）
      __resetWorkbookInfoCacheForTest();
      const clientLess = {
        getWorkbookInfo: async () => ({
          data: {
            sheets: [{ sheet_id: 's1', float_image_count: 0 }],
          },
        }),
      };
      const gapsLess = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: clientLess,
        apiScope: 'full',
      });
      expect(gapsLess).toHaveLength(0);

      // 4. 缓存行为：同 token 5 分钟内重复核对不重复发 API，
      //    结果与首次一致（多态的 gap 仍然产出）。
      __resetWorkbookInfoCacheForTest();
      let apiCalls = 0;
      const clientCounting = {
        getWorkbookInfo: async () => {
          apiCalls += 1;
          return { data: { sheets: [{ float_image_count: 2 }] } };
        },
      };
      await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: clientCounting,
        apiScope: 'full',
      });
      const gapsCached = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: clientCounting,
        apiScope: 'full',
      });
      expect(apiCalls).toBe(1);
      expect(gapsCached).toHaveLength(1);
    });

    it('skips all workbook-info calls under the default local-only scope (polling-safe)', async () => {
      const sheetDir = path.join(tmpDir, 'SheetLocalOnly');
      fs.mkdirSync(sheetDir, { recursive: true });
      const mdPath = path.join(sheetDir, 'SheetLocalOnly.md');
      fs.writeFileSync(mdPath, '# 表格\n', 'utf-8');

      const record = makeDocRecord({
        objToken: 'sheet_local_only',
        objType: 'sheet',
        localMdPath: mdPath,
      });

      let calls = 0;
      const client = {
        getWorkbookInfo: async () => {
          calls += 1;
          return { data: { sheets: [{ float_image_count: 9 }] } };
        },
      };

      const gaps = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: client,
        // 不传 apiScope：默认 local-only，零云端调用
      });

      expect(calls).toBe(0);
      expect(gaps).toHaveLength(0);
    });

    it('soft-fails gracefully when getWorkbookInfo throws an error', async () => {
      const sheetDir = path.join(tmpDir, 'SheetErr');
      fs.mkdirSync(sheetDir, { recursive: true });
      const mdPath = path.join(sheetDir, 'SheetErr.md');
      fs.writeFileSync(mdPath, '# 表格', 'utf-8');

      const record = makeDocRecord({
        objToken: 'sheet_err',
        objType: 'sheet',
        localMdPath: mdPath,
      });

      const clientThrows = {
        getWorkbookInfo: async () => {
          throw new Error('API Rate Limit or Permission Denied');
        },
      };

      // Must not throw, simply returns empty gaps
      const gaps = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: clientThrows,
      });
      expect(gaps).toHaveLength(0);
    });

    it('skips records whose status is not synced and syncState is not synced', async () => {
      const mdPath = path.join(tmpDir, 'PendingDoc.md');
      fs.writeFileSync(mdPath, '<whiteboard token="wb_test"/>', 'utf-8');

      const record = makeDocRecord({
        objToken: 'doc_pending',
        status: 'changed',
        syncState: 'pending_modified',
        localMdPath: mdPath,
      });

      const gaps = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: { getWorkbookInfo: async () => ({}) },
      });
      expect(gaps).toHaveLength(0);
    });

    it('skips records whose localMdPath does not exist on disk', async () => {
      const record = makeDocRecord({
        objToken: 'doc_nofile',
        localMdPath: path.join(tmpDir, 'does_not_exist.md'),
      });

      const gaps = await detectMediaGaps({
        records: [record],
        knowledgeBaseRoot: tmpDir,
        larkCliClient: { getWorkbookInfo: async () => ({}) },
      });
      expect(gaps).toHaveLength(0);
    });
  });
});
