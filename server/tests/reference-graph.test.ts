/**
 * reference-graph 纯函数单测（P1-S2，设计 P1 §2.6 测试表 + P1-S1 RP 裁定修正）。
 *
 * fixture：server/tests/fixtures/p1s1-lark-cli/（P1-S1 真实 lark-cli 1.0.98
 * 实测样本，token 为已删除资源仅留结构对照）。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_REFERENCE_EDGES,
  extractBodyReferences,
  extractDocumentReferences,
  extractRefmapSupplement,
  mergeReferences,
  type SourceReferenceEdge,
} from '../src/kb/reference-graph.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'p1s1-lark-cli');
const inlineCitesMarkdown = fs.readFileSync(path.join(fixtureDir, 'fetch-markdown-inline-cites.md'), 'utf-8');
const refmapCommentsFixture = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, 'fetch-refmap-comments.json'), 'utf-8'),
) as { data: { document: { reference_map?: unknown } } };
const noRefmapDocumentFixture = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, 'fetch-no-refmap.json'), 'utf-8'),
) as { data: { document: Record<string, unknown> } };

/** 构造 token 形态字符串（[A-Za-z0-9]{16,64}，长度 26 与真实 token 同量级）。 */
const mkToken = (prefix: string, len = 26): string =>
  (prefix + 'a'.repeat(Math.max(0, len - prefix.length))).slice(0, len);

const edge = (over: Partial<SourceReferenceEdge> & { targetToken: string }): SourceReferenceEdge => ({
  targetType: 'unknown',
  title: null,
  direction: 'out',
  origin: 'body',
  kind: 'cite',
  occurrences: 1,
  ...over,
});

describe('extractBodyReferences（正文双解析主体）', () => {
  it('P1-S1 fixture：链接 + cite + sheet 三形态都出边，@user cite 不产生边', () => {
    const edges = extractBodyReferences(inlineCitesMarkdown);
    // 排序：occurrences 全 1 → targetToken 字典序，同 token 按 kind（cite < link）
    expect(edges.map((e) => [e.targetToken, e.targetType, e.kind, e.title])).toEqual([
      ['PhQvsydSBhy0UStlHk0c3zoJnoe', 'sheet', 'sheet', null],
      ['VtS3d0GPLoAxLJxAGHLcv1tMnQZ', 'docx', 'cite', 'p1s1-发布测试A'],
      ['VtS3d0GPLoAxLJxAGHLcv1tMnQZ', 'docx', 'link', '文档A的链接'],
    ]);
    for (const e of edges) {
      expect(e.direction).toBe('out');
      expect(e.origin).toBe('body');
      expect(e.occurrences).toBe(1);
    }
  });

  it('七种资源路径段映射归一类型（sheets→sheet、base→bitable），query/fragment 剥离', () => {
    const md = [
      `[a](https://x.feishu.cn/docx/${mkToken('docx')}?from=copy)`,
      `[b](https://x.feishu.cn/wiki/${mkToken('wiki')}#heading)`,
      `[c](https://custom.tenant.cn/sheets/${mkToken('sh')})`,
      `[d](https://www.doubao.com/base/${mkToken('bt')})`,
      `[e](https://x.feishu.cn/slides/${mkToken('sl')})`,
      `[f](https://x.feishu.cn/mindnote/${mkToken('mn')})`,
      `[g](https://x.feishu.cn/file/${mkToken('fi')})`,
    ].join('\n');
    const byToken = new Map(extractBodyReferences(md).map((e) => [e.targetToken, e.targetType]));
    expect(byToken.get(mkToken('docx'))).toBe('docx');
    expect(byToken.get(mkToken('wiki'))).toBe('wiki');
    expect(byToken.get(mkToken('sh'))).toBe('sheet');
    expect(byToken.get(mkToken('bt'))).toBe('bitable');
    expect(byToken.get(mkToken('sl'))).toBe('slides');
    expect(byToken.get(mkToken('mn'))).toBe('mindnote');
    expect(byToken.get(mkToken('fi'))).toBe('file');
  });

  it('裸 URL（无链接语法）也被提取；自定义域名与 doubao 域按路径段路由', () => {
    const t1 = mkToken('bare1');
    const t2 = mkToken('bare2');
    const edges = extractBodyReferences(
      `正文中直接出现 https://custom.tenant.cn/wiki/${t1} 以及 https://www.doubao.com/docx/${t2} 结束。`,
    );
    expect(edges.map((e) => [e.targetToken, e.targetType, e.kind, e.title])).toEqual([
      [t1, 'wiki', 'link', null],
      [t2, 'docx', 'link', null],
    ]);
  });

  it('代码块与行内代码内的 URL/cite/sheet 不提取（``` 与 ~~~ 围栏）', () => {
    const ok = mkToken('ok');
    const blocked = mkToken('blk');
    const inline = mkToken('inl');
    const inlineCite = mkToken('inl2');
    const md = [
      `前置 [ok](https://x.feishu.cn/docx/${ok})`,
      '',
      '```ts',
      `const url = 'https://x.feishu.cn/wiki/${blocked}';`,
      `<cite doc-id="${mkToken('cb')}" file-type="docx" title="x"></cite>`,
      '```',
      '',
      '~~~',
      `https://x.feishu.cn/docx/${mkToken('cb2')}`,
      '~~~',
      '',
      `行内代码 \`https://x.feishu.cn/base/${inline}\` 与 \`<cite doc-id="${inlineCite}" file-type="docx"></cite>\` 不计`,
    ].join('\n');
    const edges = extractBodyReferences(md);
    expect(edges.map((e) => e.targetToken)).toEqual([ok]);
  });

  it('自引用排除：selfTokens 命中（obj_token 与 wiki_node_token 两种）丢弃', () => {
    const selfObj = mkToken('selfobj');
    const selfWiki = mkToken('selfwiki');
    const other = mkToken('other');
    const md = [
      `[self1](https://x.feishu.cn/docx/${selfObj})`,
      `<cite doc-id="${selfWiki}" file-type="wiki" title="我"></cite>`,
      `[other](https://x.feishu.cn/wiki/${other})`,
    ].join('\n');
    const edges = extractBodyReferences(md, { selfTokens: [selfObj, selfWiki] });
    expect(edges.map((e) => e.targetToken)).toEqual([other]);
  });

  it('媒体排除：![…](…) 图片与 <img> 标签不入图；excludeTokens（媒体计划 token 集）命中丢弃', () => {
    const media = mkToken('media1');
    const mediaImg = mkToken('media2');
    const fileLink = mkToken('filelk');
    const md = [
      `![封面](https://internal-drive.larksuite.com/file/${media})`,
      `<img src="https://x.feishu.cn/file/${mediaImg}" alt="a" />`,
      `[云文件](https://x.feishu.cn/file/${fileLink})`,
    ].join('\n');
    expect(extractBodyReferences(md).map((e) => e.targetToken)).toEqual([fileLink]);
    expect(extractBodyReferences(md, { excludeTokens: [media, mediaImg, fileLink] })).toEqual([]);
  });

  it('重复链接/裸 URL/cite 累加 occurrences；title 首个非空生效', () => {
    const t = mkToken('dup');
    const citeTok = mkToken('dupc');
    const md = [
      `[a](https://x.feishu.cn/docx/${t})`,
      `https://x.feishu.cn/docx/${t}`,
      `[b](https://x.feishu.cn/docx/${t}?x=1)`,
      `<cite doc-id="${citeTok}" file-type="docx"></cite>`,
      `<cite doc-id="${citeTok}" file-type="docx" title="补标题"></cite>`,
    ].join('\n');
    const edges = extractBodyReferences(md);
    expect(edges.find((e) => e.kind === 'link')?.occurrences).toBe(3);
    const citeEdge = edges.find((e) => e.kind === 'cite');
    expect(citeEdge?.occurrences).toBe(2);
    expect(citeEdge?.title).toBe('补标题');
  });

  it('cite 属性形态与 parseCiteTag 对应：file-type 缺失→unknown；citation 容器含 doc-id 照常提取（RP-2 已知边界：create 侧静默丢弃）', () => {
    const unknownTok = mkToken('unk1');
    const citationTok = mkToken('cite1');
    const md = [
      `<cite doc-id="${unknownTok}" title="无类型"></cite>`,
      `<cite doc-id="${citationTok}" type="citation" title="参考文献"></cite>`,
    ].join('\n');
    const edges = extractBodyReferences(md);
    expect(edges.map((e) => [e.targetToken, e.targetType, e.title])).toEqual([
      [citationTok, 'unknown', '参考文献'],
      [unknownTok, 'unknown', '无类型'],
    ]);
  });

  it('title 实体解码与截断（200）', () => {
    const t = mkToken('ent1');
    const longTitle = '长'.repeat(230);
    const md = `[A &amp; B](https://x.feishu.cn/docx/${t})\n<cite doc-id="${mkToken('ent2')}" file-type="docx" title="${longTitle}"></cite>`;
    const edges = extractBodyReferences(md);
    expect(edges.find((e) => e.kind === 'link')?.title).toBe('A & B');
    expect(edges.find((e) => e.kind === 'cite')?.title?.length).toBe(200);
  });

  it('上限保护：默认 500 条，按 occurrences 降序截断', () => {
    const lines: string[] = [];
    const hot = mkToken('hot000000000000000');
    for (let i = 0; i < 5; i += 1) lines.push(`[h](https://x.feishu.cn/docx/${hot})`);
    for (let i = 0; i < 501; i += 1) {
      lines.push(`[x](https://x.feishu.cn/wiki/${mkToken('t' + String(i).padStart(5, '0'))})`);
    }
    const edges = extractBodyReferences(lines.join('\n'));
    expect(edges).toHaveLength(MAX_REFERENCE_EDGES);
    expect(edges[0]).toMatchObject({ targetToken: hot, occurrences: 5 });
    // 501 个 1 次边按字典序 tie-break，截掉字典序最大的两个（t00499、t00500）
    expect(edges.some((e) => e.targetToken === mkToken('t' + String(500).padStart(5, '0')))).toBe(false);
    expect(edges.some((e) => e.targetToken === mkToken('t' + String(499).padStart(5, '0')))).toBe(false);
    expect(edges.some((e) => e.targetToken === mkToken('t' + String(498).padStart(5, '0')))).toBe(true);
    // 自定义上限
    expect(extractBodyReferences(lines.join('\n'), { maxEdges: 2 })).toHaveLength(2);
  });
});

describe('extractRefmapSupplement（补充扫描，键缺失容错）', () => {
  it('P1-S1 fixture：仅 comments 组 → 保留组排除，结果为空', () => {
    expect(extractRefmapSupplement(refmapCommentsFixture.data.document.reference_map)).toEqual([]);
  });

  it('P1-S1 fixture：reference_map 键整体缺失（RP-3）→ 空，不抛错', () => {
    expect('reference_map' in noRefmapDocumentFixture.data.document).toBe(false);
    expect(extractRefmapSupplement(noRefmapDocumentFixture.data.document.reference_map)).toEqual([]);
    expect(extractRefmapSupplement(undefined)).toEqual([]);
    expect(extractRefmapSupplement(null)).toEqual([]);
  });

  it('非对象输入宽容降级：string/number/boolean/数组 → 空数组', () => {
    for (const bad of ['{"comments":{}}', 42, true, [], [{ token: mkToken('ar1') }]]) {
      expect(extractRefmapSupplement(bad)).toEqual([]);
    }
  });

  it('URL 属性值 → refmap 边（origin=refmap，kind=组名）', () => {
    const t = mkToken('url1');
    const refmap = {
      'html5-block': {
        html5_1: { data: `<board>引用 https://x.feishu.cn/docx/${t} 内嵌</board>` },
      },
    };
    expect(extractRefmapSupplement(refmap)).toEqual([
      { targetToken: t, targetType: 'docx', title: null, direction: 'out', origin: 'refmap', kind: 'html5-block', occurrences: 1 },
    ]);
  });

  it('token 键名 + obj_type → 类型化边；类型缺失 → unknown；title/name 属性作标题', () => {
    const t1 = mkToken('tok1');
    const t2 = mkToken('tok2');
    const refmap = {
      mentions: {
        r1: { token: t1, obj_type: 'sheets', title: '表格 A' },
        r2: { wiki_token: t2, name: 'B' },
      },
    };
    const edges = extractRefmapSupplement(refmap);
    expect(edges).toEqual([
      { targetToken: t1, targetType: 'sheet', title: '表格 A', direction: 'out', origin: 'refmap', kind: 'mentions', occurrences: 1 },
      { targetToken: t2, targetType: 'unknown', title: 'B', direction: 'out', origin: 'refmap', kind: 'mentions', occurrences: 1 },
    ]);
  });

  it('深度 ≤4：ref 对象直接属性可扫，再嵌一层的 token 不扫', () => {
    const shallow = mkToken('dep1');
    const deep = mkToken('dep2');
    const refmap = {
      g: {
        r: { token: shallow, extra: { token: deep } } as Record<string, unknown>,
      },
    };
    const edges = extractRefmapSupplement(refmap);
    expect(edges.map((e) => e.targetToken)).toEqual([shallow]);
  });

  it('同 (type, token, kind) 重复出现累加 occurrences；kind 组名截断 64、title 截断 200', () => {
    const t = mkToken('acc1');
    const longGroup = 'g'.repeat(80);
    const longTitle = 'T'.repeat(230);
    const refmap = {
      [longGroup]: {
        r1: { token: t, title: longTitle },
        r2: { token: t, title: 'x' },
      },
    };
    const edges = extractRefmapSupplement(refmap);
    expect(edges).toHaveLength(1);
    expect(edges[0].occurrences).toBe(2);
    expect(edges[0].kind).toBe('g'.repeat(64));
    expect(edges[0].title?.length).toBe(200);
  });

  it('自引用与 excludeTokens 过滤同样生效', () => {
    const self = mkToken('self1');
    const excluded = mkToken('exc1');
    const kept = mkToken('keep');
    const refmap = { g: { r1: { token: self }, r2: { token: excluded }, r3: { token: kept } } };
    expect(
      extractRefmapSupplement(refmap, { selfTokens: [self], excludeTokens: [excluded] }).map((e) => e.targetToken),
    ).toEqual([kept]);
  });
});

describe('mergeReferences（合并去重归一，body 优先）', () => {
  it('同 (token,type) body 优先：refmap 行丢弃、title 取 body；refmap 独有目标保留 origin=refmap', () => {
    const shared = mkToken('shar');
    const onlyRef = mkToken('onlyr');
    const body = [edge({ targetToken: shared, targetType: 'docx', kind: 'cite', title: '正文标题', occurrences: 2 })];
    const refmap = [
      edge({ targetToken: shared, targetType: 'docx', origin: 'refmap', kind: 'mentions', title: 'sidecar 标题', occurrences: 5 }),
      edge({ targetToken: onlyRef, targetType: 'wiki', origin: 'refmap', kind: 'mentions', title: '仅 sidecar', occurrences: 1 }),
    ];
    const merged = mergeReferences(body, refmap);
    expect(merged).toEqual([
      // occurrences 降序：body(2) 在前
      { targetToken: shared, targetType: 'docx', title: '正文标题', direction: 'out', origin: 'body', kind: 'cite', occurrences: 2 },
      { targetToken: onlyRef, targetType: 'wiki', title: '仅 sidecar', direction: 'out', origin: 'refmap', kind: 'mentions', occurrences: 1 },
    ]);
  });

  it('body 行 title 为 null 时回填组内 refmap 的首个非空 title', () => {
    const t = mkToken('backf');
    const body = [edge({ targetToken: t, targetType: 'docx', kind: 'link', title: null })];
    const refmap = [edge({ targetToken: t, targetType: 'docx', origin: 'refmap', kind: 'g', title: '补齐标题' })];
    expect(mergeReferences(body, refmap)[0]).toMatchObject({ title: '补齐标题', origin: 'body', kind: 'link' });
  });

  it('输入数组内重复行去重累加 occurrences；body 同 token 多 kind 保留多行', () => {
    const t = mkToken('mult');
    const body = [
      edge({ targetToken: t, targetType: 'docx', kind: 'cite', occurrences: 1 }),
      edge({ targetToken: t, targetType: 'docx', kind: 'cite', occurrences: 2, title: null }),
      edge({ targetToken: t, targetType: 'docx', kind: 'link', occurrences: 1 }),
    ];
    const merged = mergeReferences(body, []);
    expect(merged.map((e) => [e.kind, e.occurrences])).toEqual([
      ['cite', 3],
      ['link', 1],
    ]);
  });

  it('合并上限 500：body + refmap 独有目标合计超限时按 occurrences 降序截断', () => {
    const body: SourceReferenceEdge[] = [];
    for (let i = 0; i < 400; i += 1) {
      body.push(edge({ targetToken: mkToken('b' + String(i).padStart(5, '0')), kind: 'link', occurrences: 1 }));
    }
    const refmap: SourceReferenceEdge[] = [];
    for (let i = 0; i < 200; i += 1) {
      refmap.push(edge({ targetToken: mkToken('r' + String(i).padStart(5, '0')), origin: 'refmap', kind: 'g', occurrences: 2 }));
    }
    const merged = mergeReferences(body, refmap);
    expect(merged).toHaveLength(MAX_REFERENCE_EDGES);
    expect(merged.filter((e) => e.origin === 'refmap').length).toBe(200); // occurrences 2 的 refmap 行全部保留
    expect(merged.filter((e) => e.origin === 'body').length).toBe(300);
  });

  it('宽容空输入与 null 元素', () => {
    expect(mergeReferences([], [])).toEqual([]);
    expect(mergeReferences([null as unknown as SourceReferenceEdge], []).length).toBe(0);
  });
});

describe('extractDocumentReferences（组合入口，P1-S3 消费形态）', () => {
  it('body 主体 + refmap 补充：fixture 正文 + comments-only refmap → 仅 body 边，truncated=false', () => {
    const result = extractDocumentReferences({
      markdown: inlineCitesMarkdown,
      referenceMap: refmapCommentsFixture.data.document.reference_map,
      selfTokens: ['XjO4dP7NGoWVMfxMn3HcReVMnrf'],
    });
    expect(result.truncated).toBe(false);
    expect(result.edges).toHaveLength(3);
    expect(result.edges.every((e) => e.origin === 'body')).toBe(true);
  });

  it('referenceMap 键缺失省略不报错（RP-3）', () => {
    const result = extractDocumentReferences({ markdown: `[x](https://x.feishu.cn/docx/${mkToken('comb')})` });
    expect(result.edges.map((e) => e.targetToken)).toEqual([mkToken('comb')]);
  });

  it('超上限时 truncated=true 并截断（S3 记 references_truncated 警告）', () => {
    const t1 = mkToken('c1');
    const t2 = mkToken('c2');
    const t3 = mkToken('c3');
    const result = extractDocumentReferences({
      markdown: [
        `[1](https://x.feishu.cn/docx/${t1})`,
        `[2](https://x.feishu.cn/docx/${t2})`,
        `[3](https://x.feishu.cn/docx/${t3})`,
      ].join('\n'),
      maxEdges: 2,
    });
    expect(result.edges).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
