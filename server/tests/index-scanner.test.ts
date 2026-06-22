/**
 * Unit tests for IndexScanner.parseMetadata three-format compatibility.
 *
 * Covers R1.1-AC1/AC2 from 02-迭代需求分析.md and the B5 fix described in
 * 01-现状与差距分析.md §3.1 (G1.1) and 03-迭代架构设计.md §2.2.2.
 */
import { describe, it, expect } from 'vitest';
import { IndexScanner } from '../src/modules/index-scanner.js';

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
