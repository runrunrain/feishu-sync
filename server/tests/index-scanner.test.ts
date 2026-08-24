/**
 * Unit tests for IndexScanner.parseMetadata three-format compatibility.
 *
 * Covers R1.1-AC1/AC2 from 02-迭代需求分析.md and the B5 fix described in
 * 01-现状与差距分析.md §3.1 (G1.1) and 03-迭代架构设计.md §2.2.2.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexScanner, resolveDocumentTitle } from '../src/modules/index-scanner.js';

// The scanner only needs parseMetadata for these tests. Construct with
// stub dependencies — they are never invoked in unit-level parsing tests.
const scanner = new IndexScanner({
  localMapStore: {},
  larkCliClient: {},
  config: {},
});

describe('IndexScanner.parseMetadata — format 1: YAML-in-comment new spec', () => {
  it('parses full YAML-in-comment header with all fields', () => {
    const content = `<!--
feishu_sync:
  obj_token: HmhRdCs3goAlVNxXmBhcX3Uknng
  wiki_node_token: PUMawWxe7iGYIMkCpZscvXImnNe
  space_id: ODIxNjUxNTc
  obj_type: docx
  original_link: https://qcnbafdrjx7n.feishu.cn/wiki/PUMawWxe7iGYIMkCpZscvXImnNe
  fetch_date: 2026-06-18
  last_synced_modify_time: 2026-06-15T10:30:00Z
-->

# Real content below
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('yaml_html');
    expect(meta!.obj_token).toBe('HmhRdCs3goAlVNxXmBhcX3Uknng');
    expect(meta!.wiki_node_token).toBe('PUMawWxe7iGYIMkCpZscvXImnNe');
    expect(meta!.space_id).toBe('ODIxNjUxNTc');
    expect(meta!.obj_type).toBe('docx');
    expect(meta!.original_link).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/PUMawWxe7iGYIMkCpZscvXImnNe',
    );
    expect(meta!.fetch_date).toBe('2026-06-18');
    expect(meta!.last_synced_modify_time).toBe('2026-06-15T10:30:00Z');
  });

  it('parses YAML header with sheet obj_type', () => {
    const content = `<!--
feishu_sync:
  obj_token: SheetTOKEN123
  obj_type: sheet
  original_link: https://example.feishu.cn/wiki/SheetNODE
-->

body`;
    const meta = scanner.parseMetadata(content);
    expect(meta!.obj_type).toBe('sheet');
    expect(meta!.obj_token).toBe('SheetTOKEN123');
  });

  it('rejects comment that lacks feishu_sync marker (falls through to other formats)', () => {
    // A comment that happens to start the file but is not a feishu_sync block
    // should not be misclassified as yaml_html.
    const content = `<!-- artifact: implementation-report -->
<!-- task_id: foo -->

# body`;
    const meta = scanner.parseMetadata(content);
    // No feishu fields anywhere → null
    expect(meta).toBeNull();
  });

  it('tolerates unknown YAML keys for forward compatibility', () => {
    const content = `<!--
feishu_sync:
  obj_token: TOKabc
  future_field_xyz: some-value
-->
body`;
    const meta = scanner.parseMetadata(content);
    expect(meta!.obj_token).toBe('TOKabc');
  });
});

describe('IndexScanner.parseMetadata — format 2: legacy Chinese HTML comment', () => {
  it('parses canonical legacy Chinese HTML header with obj_token + (docx) qualifier', () => {
    // Real sample from 知识库/策划 - Designer/500-【总述】工具与拓展.md
    const content = `<!--
来源: 飞书知识库 策划 - Designer
节点: 500-【总述】工具与拓展
原始链接: https://qcnbafdrjx7n.feishu.cn/wiki/NtetwU8GdiBlsPkdUCWcVjFJnnd
obj_token: JjdsdQ9okozH0qx7zOncnVOfnue (docx)
获取日期: 2026-06-15
-->

# 500-【总述】工具与拓展
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('legacy_html_zh');
    expect(meta!.obj_token).toBe('JjdsdQ9okozH0qx7zOncnVOfnue');
    expect(meta!.obj_type).toBe('docx');
    expect(meta!.original_link).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/NtetwU8GdiBlsPkdUCWcVjFJnnd',
    );
    expect(meta!.fetch_date).toBe('2026-06-15');
  });

  it('parses legacy HTML header that uses document_id instead of obj_token', () => {
    const content = `<!--
来源: 飞书文档
document_id: Du9Fdux8KoRbHZxluLfcMja1nUh
原始链接: https://x.feishu.cn/wiki/AbcDEF123
获取日期: 2026-06-15
-->
body`;
    const meta = scanner.parseMetadata(content);
    expect(meta!.header_format).toBe('legacy_html_zh');
    expect(meta!.obj_token).toBe('Du9Fdux8KoRbHZxluLfcMja1nUh');
    expect(meta!.original_link).toBe('https://x.feishu.cn/wiki/AbcDEF123');
  });

  it('returns null for short sheet-style comment with no extractable fields', () => {
    // Real sample: 电子表格导出 .md → `<!-- 来源：飞书电子表格 -->`
    // (no obj_token, no original_link). Should return null so caller skips.
    const content = `<!-- 来源：飞书电子表格 -->

# Sheet title

| col1 | col2 |
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).toBeNull();
  });

  it('handles sheet qualifier obj_type extraction', () => {
    const content = `<!--
来源: 飞书知识库
obj_token: SheetTOKEN999 (sheet)
原始链接: https://x.feishu.cn/wiki/SheetNODE
-->
body`;
    const meta = scanner.parseMetadata(content);
    expect(meta!.obj_type).toBe('sheet');
  });
});

describe('IndexScanner.parseMetadata — format 3: legacy blockquote', () => {
  it('parses real blockquote header from [必读] 研发规范/README.md', () => {
    // Real sample observed in 知识库/[必读] 研发规范/README.md.
    // Format: H1 title, then blockquote list with document_id + 文档链接.
    const content = `# [必读] 研发规范

> 本地副本来源：飞书文档
> - 原始标题：[必读] 研发规范
> - 文档链接：https://qcnbafdrjx7n.feishu.cn/wiki/NudewPkE9inlGhkEDA1c9FSsnkb
> - document_id：Du9Fdux8KoRbHZxluLfcMja1nUh
> - revision_id：478
> - 获取日期：2026-06-15

---

## 统一规范

正文内容...
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('blockquote');
    // blockquote uses document_id as obj_token when obj_token field is absent
    expect(meta!.obj_token).toBe('Du9Fdux8KoRbHZxluLfcMja1nUh');
    expect(meta!.original_link).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/NudewPkE9inlGhkEDA1c9FSsnkb',
    );
    expect(meta!.fetch_date).toBe('2026-06-15');
  });

  it('parses blockquote header at file start (no leading H1)', () => {
    const content = `> 本地副本来源：飞书文档
> - 文档链接：https://example.feishu.cn/wiki/NodeXXX
> - obj_token：PlainObjToken123
> - 获取日期：2026-06-15

正文`;
    const meta = scanner.parseMetadata(content);
    expect(meta!.header_format).toBe('blockquote');
    expect(meta!.obj_token).toBe('PlainObjToken123');
    expect(meta!.original_link).toBe('https://example.feishu.cn/wiki/NodeXXX');
  });

  it('does not match ordinary quoted prose', () => {
    // Blockquote that's just narrative text without metadata fields.
    const content = `# Some doc

> 这是一段引用的说明文字，用于强调某个观点。
> 引用继续，没有飞书字段。

更多正文`;
    const meta = scanner.parseMetadata(content);
    expect(meta).toBeNull();
  });
});

describe('IndexScanner.parseMetadata — priority + backward compatibility', () => {
  it('YAML new spec wins over legacy formats when both present', () => {
    // Should not happen in practice but verifies priority order.
    const content = `<!--
feishu_sync:
  obj_token: YAML_TOKEN
  original_link: https://yaml.feishu.cn/wiki/YamlNode
-->

<!-- 来源: legacy
obj_token: LEGACY_TOKEN
-->
body`;
    const meta = scanner.parseMetadata(content);
    expect(meta!.header_format).toBe('yaml_html');
    expect(meta!.obj_token).toBe('YAML_TOKEN');
  });

  it('legacy HTML wins over blockquote when both present', () => {
    // Unusual but verifies documented priority.
    const content = `<!--
来源: legacy HTML
obj_token: HTML_TOKEN
原始链接: https://html.feishu.cn/wiki/HtmlNode
-->

> - obj_token: BQ_TOKEN
> - 文档链接：https://bq.feishu.cn/wiki/BqNode
`;
    const meta = scanner.parseMetadata(content);
    expect(meta!.header_format).toBe('legacy_html_zh');
    expect(meta!.obj_token).toBe('HTML_TOKEN');
  });

  it('returns null for content with no recognizable header (R1.1-AC2 — does not break)', () => {
    // Pure content with no comment and no blockquote. IndexScanner must not
    // throw or fabricate fields.
    const content = `# Plain document

This file has no feishu header at all.

## Section

- bullet 1
- bullet 2
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).toBeNull();
  });

  it('returns null for content starting with H1 + plain prose (no metadata)', () => {
    // Real-world case: many README/INDEX.md files start with H1 + descriptive
    // text but no feishu header. Must skip cleanly without false positives.
    const content = `# 技术 - Dev 知识库导览页

## 来源说明

- 来源：飞书知识库《技术 - Dev》
- 父节点链接：https://qcnbafdrjx7n.feishu.cn/wiki/QdZpwOmgBi25JVkAUmYcBiMinIf
- 获取日期：2026-06-16
- 本文档收录：48 个节点（全部 docx）

## 目录树

- [技术 - Dev](README.md)
`;
    const meta = scanner.parseMetadata(content);
    // The "来源：飞书知识库《技术 - Dev》" prose line has no blockquote
    // prefix and no document_id/obj_token marker → not a header.
    expect(meta).toBeNull();
  });
});

describe('IndexScanner.parseMetadata — format 4: bold key-value header', () => {
  it('parses full bold_kv header with markdown link + obj token + date', () => {
    // Real-world form from 技术-Dev tree (most common variant).
    const content = `# 1.1.面向数据

**来源**: [飞书 Wiki](https://qcnbafdrjx7n.feishu.cn/wiki/QGzqwvUuZive33kl350c95Son6g)
**Obj Token**: TuKOdlvPfoOBfYx1aM7cu4Pdnxq
**获取日期**: 2026-06-16

---

### 设计原则
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('bold_kv');
    expect(meta!.obj_token).toBe('TuKOdlvPfoOBfYx1aM7cu4Pdnxq');
    expect(meta!.original_link).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/QGzqwvUuZive33kl350c95Son6g',
    );
    expect(meta!.fetch_date).toBe('2026-06-16');
  });

  it('parses bare URL (no markdown link wrapper) in 来源 field', () => {
    // Some files use a bare URL instead of `[text](URL)`.
    const content = `# Sample

**来源**: https://qcnbafdrjx7n.feishu.cn/wiki/BareUrlToken123
**Obj Token**: BareTokABCdef
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('bold_kv');
    expect(meta!.obj_token).toBe('BareTokABCdef');
    expect(meta!.original_link).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/BareUrlToken123',
    );
  });

  it('parses Chinese full-width colon in field separators', () => {
    // Real-world files often mix ASCII ':' and full-width '：'.
    const content = `# 标题

**来源**：[飞书 Wiki](https://qcnbafdrjx7n.feishu.cn/wiki/FullWidthToken)
**Obj Token**：FullWidthTok
**获取日期**：2026-06-16
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('bold_kv');
    expect(meta!.obj_token).toBe('FullWidthTok');
    expect(meta!.original_link).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/FullWidthToken',
    );
    expect(meta!.fetch_date).toBe('2026-06-16');
  });

  it('parses header with only original_link (no obj_token) — still indexable via getNode fallback', () => {
    const content = `# Doc With Link Only

**来源**: [飞书 Wiki](https://qcnbafdrjx7n.feishu.cn/wiki/LinkOnlyToken)
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('bold_kv');
    expect(meta!.obj_token).toBeUndefined();
    expect(meta!.original_link).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/LinkOnlyToken',
    );
  });

  it('returns null when bold markers present but no feishu field', () => {
    // Bold prose like "**重要**：请注意" must NOT trigger a false positive.
    const content = `# Plain

**重要**：请注意这条规则。
**警告**：另一条普通强调。
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).toBeNull();
  });

  it('returns null when only 获取日期 present (no obj_token/link)', () => {
    // Defensive: a date alone is insufficient to index.
    const content = `# Sample

**获取日期**: 2026-06-16
`;
    const meta = scanner.parseMetadata(content);
    expect(meta).toBeNull();
  });
});

describe('resolveDocumentTitle', () => {
  it('uses the first ATX H1 for README.md after feishu_sync header comment', () => {
    const content = `<!--
feishu_sync:
  obj_token: TOK123
-->

# 服务器架构

body
`;
    const title = resolveDocumentTitle(
      path.join('知识库', '技术 - Dev', '服务器架构', 'README.md'),
      content,
    );
    expect(title).toBe('服务器架构');
  });

  it('skips YAML front-matter and HTML comments before the H1', () => {
    const content = `---
title: ignored
---
<!--
feishu_sync:
  obj_token: TOK
-->

# Real Title From H1
`;
    expect(resolveDocumentTitle('/kb/node/README.md', content)).toBe(
      'Real Title From H1',
    );
  });

  it('falls back to parent directory name when README has no H1', () => {
    const content = `<!--
feishu_sync:
  obj_token: TOK
-->

Just prose, no heading.
`;
    const title = resolveDocumentTitle(
      path.join('/kb', '技术 - Dev', '数据层', 'README.md'),
      content,
    );
    expect(title).toBe('数据层');
  });

  it('falls back to "README" when parent name is unusable (filesystem root)', () => {
    // path.dirname('/README.md') === '/' → basename is empty → final fallback.
    const content = 'no heading here\n';
    const atRoot = path.join(path.parse(process.cwd()).root, 'README.md');
    expect(resolveDocumentTitle(atRoot, content)).toBe('README');
  });

  it('uses filename stem for ordinary non-README markdown', () => {
    const content = `# This H1 is ignored for non-README

body
`;
    expect(
      resolveDocumentTitle(path.join('/kb', 'docs', '1.1.面向数据.md'), content),
    ).toBe('1.1.面向数据');
  });

  it('does not treat H2 as the README title', () => {
    const content = `<!--
feishu_sync:
  obj_token: TOK
-->

## Not an H1

More text.
`;
    expect(
      resolveDocumentTitle(path.join('/kb', '父节点', 'README.md'), content),
    ).toBe('父节点');
  });
});

describe('IndexScanner scan policy', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not index markdown in reserved operational directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-scan-policy-'));
    temporaryRoots.push(root);
    const indexed: Array<{ objToken: string; localMdPath: string }> = [];
    const writeMappedFile = (relativePath: string, token: string) => {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `<!--\nobj_token: ${token}\n-->\n# ${token}\n`);
      return target;
    };

    const included = writeMappedFile('docs/included.md', 'INCLUDED');
    for (const [dir, token] of [
      ['_reports', 'REPORT'],
      ['.trash-bin', 'TRASH'],
      ['.staging', 'DOT_STAGING'],
      ['_staging', 'UNDERSCORE_STAGING'],
      ['.recovery', 'DOT_RECOVERY'],
      ['_recovery', 'UNDERSCORE_RECOVERY'],
      ['.restore', 'DOT_RESTORE'],
      ['_restore', 'UNDERSCORE_RESTORE'],
    ]) {
      writeMappedFile(`${dir}/${token}.md`, token);
    }

    const indexScanner = new IndexScanner({
      localMapStore: {
        upsertDocument: (document: { objToken: string; localMdPath: string }) => indexed.push(document),
      },
      larkCliClient: {},
      config: {},
    });

    const result = await indexScanner.scanKnowledgeBase(root);

    expect(result.scanned).toBe(1);
    expect(result.indexed).toBe(1);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({ objToken: 'INCLUDED', localMdPath: included });
  });

  it('indexes README with H1 title and forwards identity fields to upsert', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-scan-identity-'));
    temporaryRoots.push(root);

    const readmeDir = path.join(root, '技术 - Dev', '服务器架构');
    fs.mkdirSync(readmeDir, { recursive: true });
    const readmePath = path.join(readmeDir, 'README.md');
    fs.writeFileSync(
      readmePath,
      `<!--
feishu_sync:
  obj_token: HmhRdCs3goAlVNxXmBhcX3Uknng
  wiki_node_token: PUMawWxe7iGYIMkCpZscvXImnNe
  space_id: ODIxNjUxNTc
  obj_type: docx
  original_link: https://qcnbafdrjx7n.feishu.cn/wiki/PUMawWxe7iGYIMkCpZscvXImnNe
  fetch_date: 2026-06-18
  last_synced_modify_time: 2026-06-15T10:30:00Z
-->

# 服务器架构

body
`,
    );

    const plainPath = path.join(root, '技术 - Dev', '1.1.面向数据.md');
    fs.writeFileSync(
      plainPath,
      `<!--
feishu_sync:
  obj_token: PlainTokABC
  wiki_node_token: PlainNodeABC
  space_id: SpaceXYZ
  obj_type: docx
  original_link: https://example.feishu.cn/wiki/PlainNodeABC
  fetch_date: 2026-06-16
-->

# H1 that must not become title for non-README
`,
    );

    // README without H1 → parent dir title
    const noH1Dir = path.join(root, '技术 - Dev', '数据层');
    fs.mkdirSync(noH1Dir, { recursive: true });
    const noH1Path = path.join(noH1Dir, 'README.md');
    fs.writeFileSync(
      noH1Path,
      `<!--
feishu_sync:
  obj_token: NoH1Tok
  wiki_node_token: NoH1Node
  space_id: SpaceNoH1
  original_link: https://example.feishu.cn/wiki/NoH1Node
  fetch_date: 2026-06-17
-->

prose only
`,
    );

    type UpsertArg = {
      objToken: string;
      title: string;
      wikiNodeToken: string | null;
      spaceId: string | null;
      originalLink: string | null;
      lastSyncedModifyTime: string;
      localMdPath: string;
      localRelPath?: string | null;
      status: string;
    };
    const indexed: UpsertArg[] = [];

    const indexScanner = new IndexScanner({
      localMapStore: {
        upsertDocument: (document: UpsertArg) => indexed.push(document),
      },
      larkCliClient: {},
      config: { knowledgeBaseRoot: root },
    });

    const result = await indexScanner.scanKnowledgeBase(root);

    expect(result.scanned).toBe(3);
    expect(result.indexed).toBe(3);
    expect(indexed).toHaveLength(3);

    const byToken = Object.fromEntries(indexed.map((d) => [d.objToken, d]));

    // README with H1
    expect(byToken['HmhRdCs3goAlVNxXmBhcX3Uknng']).toMatchObject({
      title: '服务器架构',
      wikiNodeToken: 'PUMawWxe7iGYIMkCpZscvXImnNe',
      spaceId: 'ODIxNjUxNTc',
      originalLink:
        'https://qcnbafdrjx7n.feishu.cn/wiki/PUMawWxe7iGYIMkCpZscvXImnNe',
      lastSyncedModifyTime: '2026-06-15T10:30:00Z',
      localMdPath: readmePath,
      localRelPath: '技术 - Dev/服务器架构/README.md',
      status: 'synced',
    });

    // Ordinary .md → filename stem (not H1)
    expect(byToken['PlainTokABC']).toMatchObject({
      title: '1.1.面向数据',
      wikiNodeToken: 'PlainNodeABC',
      spaceId: 'SpaceXYZ',
      originalLink: 'https://example.feishu.cn/wiki/PlainNodeABC',
      lastSyncedModifyTime: '2026-06-16',
      localMdPath: plainPath,
      localRelPath: '技术 - Dev/1.1.面向数据.md',
      status: 'synced',
    });

    // README without H1 → parent directory name; fetch_date used when no last_synced_modify_time
    expect(byToken['NoH1Tok']).toMatchObject({
      title: '数据层',
      wikiNodeToken: 'NoH1Node',
      spaceId: 'SpaceNoH1',
      originalLink: 'https://example.feishu.cn/wiki/NoH1Node',
      lastSyncedModifyTime: '2026-06-17',
      localMdPath: noH1Path,
      localRelPath: '技术 - Dev/数据层/README.md',
      status: 'synced',
    });
  });

  it('omits localRelPath when knowledgeBaseRoot is not configured', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-scan-norel-'));
    temporaryRoots.push(root);
    const mdPath = path.join(root, 'doc.md');
    fs.writeFileSync(
      mdPath,
      `<!--
feishu_sync:
  obj_token: NoRelTok
  original_link: https://example.feishu.cn/wiki/NoRel
-->
# Doc
`,
    );

    const indexed: Array<Record<string, unknown>> = [];
    const indexScanner = new IndexScanner({
      localMapStore: {
        upsertDocument: (document: Record<string, unknown>) => indexed.push(document),
      },
      larkCliClient: {},
      config: {},
    });

    await indexScanner.scanKnowledgeBase(root);

    expect(indexed).toHaveLength(1);
    expect(indexed[0].objToken).toBe('NoRelTok');
    expect(indexed[0]).not.toHaveProperty('localRelPath');
  });
});
