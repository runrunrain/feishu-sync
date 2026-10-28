/**
 * publish-render 单测（P1 §4.3 契约逐条锚定）
 *
 * 覆盖：feishu_sync_kb 头部去除、标题规则（头部 title 字段 → 首个 H1 →
 * basename 回退、同名 H1 移除）、相对链接改写（已发布 → 云端 URL、
 * 未发布 → 去链接保留文字 + link_target_unpublished、外部形式原样保留）、
 * 本地图片替换（> ［图片未发布：alt］ + image_not_published）、代码保护
 * （围栏与行内代码内不改写）、确定性（同输入同 body 字节与 contentHash、
 * Map 键序无关）、边界（空文档 / 纯代码块 / 无头部文档）。
 */

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderForPublish, type PublishWarning } from '../src/kb/publish-render.js';

const KB_HEADER = `<!--
feishu_sync_kb:
  doc_id: kd_x
  sources:
    - raw/a.md
  build_id: kb_1
-->
`;

const GUIDE = 'guides/intro.md';

function render(markdown: string, urlMap: Record<string, string> = {}, kbPath = GUIDE) {
  return renderForPublish({
    kbPath,
    markdown,
    publishedUrlByKbPath: new Map(Object.entries(urlMap)),
  });
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('renderForPublish · 头部与标题', () => {
  it('去头部注释；标题取首个 H1；与标题相同的首个 H1 从正文移除', () => {
    const r = render(KB_HEADER + '# 标题甲\n\n正文段落。\n');
    expect(r.title).toBe('标题甲');
    expect(r.body).toBe('\n正文段落。\n');
    expect(r.warnings).toEqual([]);
  });

  it('头部 title 字段优先于 H1；H1 与标题不同则保留在正文', () => {
    const headerWithTitle = KB_HEADER.replace('  build_id:', '  title: 头部标题\n  build_id:');
    const r = render(headerWithTitle + '# H1标题\n\n正文。\n');
    expect(r.title).toBe('头部标题');
    expect(r.body).toContain('# H1标题');
  });

  it('无 H1 且头部无 title → 回退 basename（去 .md）', () => {
    const r = render(KB_HEADER + '只有正文。\n', {}, 'folder/deep/名称.md');
    expect(r.title).toBe('名称');
    expect(r.body).toBe('只有正文。\n');
  });

  it('无头部文档直接以 H1 起始', () => {
    const r = render('# 只有H1\n正文');
    expect(r.title).toBe('只有H1');
    expect(r.body).toBe('正文');
  });
});

describe('renderForPublish · 链接改写', () => {
  const doc = KB_HEADER + '# T\n见 [邻居](../ref/glossary.md) 与 [兄弟](./sibling.md)、[子页](sub/x.md)。\n';

  it('已发布目标 → 改写为云端 URL（../ 与 ./ 与子目录均按 kbPath 解析）', () => {
    const r = render(doc, {
      'ref/glossary.md': 'https://x.feishu.cn/docs/G1',
      'guides/sibling.md': 'https://x.feishu.cn/docs/G2',
      'guides/sub/x.md': 'https://x.feishu.cn/docs/G3',
    });
    expect(r.title).toBe('T');
    expect(r.body).toBe(
      '见 [邻居](https://x.feishu.cn/docs/G1) 与 [兄弟](https://x.feishu.cn/docs/G2)、[子页](https://x.feishu.cn/docs/G3)。\n',
    );
    expect(r.warnings).toEqual([]);
  });

  it('带 fragment 的相对链接：按路径部分解析，改写后 fragment 丢弃', () => {
    const r = render('见 [术语](../ref/glossary.md#sec)', { 'ref/glossary.md': 'https://x.feishu.cn/docs/G1' });
    expect(r.body).toBe('见 [术语](https://x.feishu.cn/docs/G1)');
  });

  it('未发布目标 → 去链接保留文字 + link_target_unpublished 警告', () => {
    const r = render(doc);
    expect(r.body).toBe('见 邻居 与 兄弟、子页。\n');
    expect(r.warnings).toEqual([
      { code: 'link_target_unpublished', kbPath: GUIDE, target: 'ref/glossary.md', text: '邻居' },
      { code: 'link_target_unpublished', kbPath: GUIDE, target: 'guides/sibling.md', text: '兄弟' },
      { code: 'link_target_unpublished', kbPath: GUIDE, target: 'guides/sub/x.md', text: '子页' },
    ] satisfies PublishWarning[]);
  });

  it('解析越界（../../x.md）的目标按未发布处理', () => {
    const r = render('看 [外部邻居](../../outside.md)');
    expect(r.body).toBe('看 外部邻居');
    expect(r.warnings.map((w) => w.target)).toEqual(['../outside.md']);
  });

  it('源引用与外部形式原样保留：https / mailto / 纯锚点 / 根相对', () => {
    const md = '[飞书原文](https://feishu.cn/wiki/x) [邮件](mailto:a@b.c) [本节](#anchor) [根相对](/a/b.md)';
    const r = render(md);
    expect(r.body).toBe(md);
    expect(r.warnings).toEqual([]);
  });

  it('同一未发布目标的多次引用只告警一次（按 code+target 去重）', () => {
    const r = render('[甲](../ref/g.md) 再见 [乙](../ref/g.md)');
    expect(r.body).toBe('甲 再见 乙');
    expect(r.warnings).toHaveLength(1);
  });
});

describe('renderForPublish · 图片替换', () => {
  it('本地相对路径图片 → 引用块占位 + image_not_published', () => {
    const r = render('前文\n\n![架构图](../assets/arch.png)\n\n后文');
    expect(r.body).toBe('前文\n\n> ［图片未发布：架构图］\n\n后文');
    expect(r.warnings).toEqual([
      { code: 'image_not_published', kbPath: GUIDE, target: 'assets/arch.png', text: '架构图' },
    ]);
  });

  it('alt 为空时占位使用原 URL', () => {
    const r = render('![](img/a.png)');
    expect(r.body).toBe('> ［图片未发布：img/a.png］');
    expect(r.warnings[0]?.text).toBe('img/a.png');
  });

  it('远程图片原样保留、不告警', () => {
    const md = '![远图](https://cdn.example.com/a.png)';
    const r = render(md);
    expect(r.body).toBe(md);
    expect(r.warnings).toEqual([]);
  });
});

describe('renderForPublish · 代码保护', () => {
  it('围栏代码块内的链接/图片不改写（纯代码块文档完全不动）', () => {
    const md = KB_HEADER + '# 示例\n\n```md\n[内部](other.md) ![图](i.png)\n```\n';
    const r = render(md);
    expect(r.title).toBe('示例');
    expect(r.body).toBe('\n```md\n[内部](other.md) ![图](i.png)\n```\n');
    expect(r.warnings).toEqual([]);
  });

  it('行内代码 span 内的链接语法不改写', () => {
    const md = '用 `[t](x.md)` 语法演示';
    const r = render(md);
    expect(r.body).toBe(md);
    expect(r.warnings).toEqual([]);
  });

  it('未闭合反引号视为普通文字，其内链接仍按规则处理', () => {
    const r = render('`code [t](x.md) 未闭合');
    expect(r.body).toBe('`code t 未闭合');
    expect(r.warnings.map((w) => w.code)).toEqual(['link_target_unpublished']);
  });
});

describe('renderForPublish · 确定性与哈希', () => {
  const md = KB_HEADER + '# 标题\n\n[邻居](../ref/g.md) ![图](../ref/g.png)\n';

  it('同输入两次调用结果完全一致（body 字节 + contentHash）', () => {
    const a = render(md, { 'ref/g.md': 'https://x/U1' });
    const b = render(md, { 'ref/g.md': 'https://x/U1' });
    expect(a).toEqual(b);
    expect(a.contentHash).toBe(sha256(a.body));
  });

  it('publishedUrlByKbPath 键序无关（只做查找，不遍历）', () => {
    const m1 = new Map([
      ['ref/g.md', 'https://x/U1'],
      ['other.md', 'https://x/U2'],
    ]);
    const m2 = new Map([
      ['other.md', 'https://x/U2'],
      ['ref/g.md', 'https://x/U1'],
    ]);
    expect(renderForPublish({ kbPath: GUIDE, markdown: md, publishedUrlByKbPath: m1 }))
      .toEqual(renderForPublish({ kbPath: GUIDE, markdown: md, publishedUrlByKbPath: m2 }));
  });

  it('URL 变化（两遍发布重渲染）→ body 与 contentHash 变化', () => {
    const before = render(md);
    const after = render(md, { 'ref/g.md': 'https://x/U1' });
    expect(after.body).not.toBe(before.body);
    expect(after.contentHash).not.toBe(before.contentHash);
  });
});

describe('renderForPublish · 边界', () => {
  it('空文档：标题回退 basename，body 为空串，哈希为 sha256("")', () => {
    const r = render('', {}, 'folder/doc.md');
    expect(r).toEqual({
      title: 'doc',
      body: '',
      warnings: [],
      contentHash: sha256(''),
    });
  });

  it('只有头部与标题的文档', () => {
    const r = render(KB_HEADER + '# 单标题\n');
    expect(r.title).toBe('单标题');
    expect(r.body).toBe('');
    expect(r.warnings).toEqual([]);
  });

  it('自链接可解析到自身路径（改写与否取决于调用方提供的映射）', () => {
    const r = render('[自己](intro.md)', { 'guides/intro.md': 'https://x/self' });
    expect(r.body).toBe('[自己](https://x/self)');
  });
});
