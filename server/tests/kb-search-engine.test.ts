import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize } from '../src/kb/search/normalize.js';
import { buildOutline, resolveAnchor } from '../src/kb/search/outline.js';
import { parseQuery, fallbackTerms } from '../src/kb/search/query.js';
import { indexDoc, assembleIndex } from '../src/kb/search/index-core.js';
import { rankLexV1, countTerm, LEX_V1 } from '../src/kb/search/rank-lex-v1.js';
import { makeSnippet, normalizedSpans } from '../src/kb/search/snippet.js';
import { grepDocs } from '../src/kb/search/grep.js';
import { l1SearchDocs, legacySearchDocs, searchDocs } from '../src/kb/kb-search.js';
import { KbQueryService } from '../src/kb/search/kb-query-service.js';
import { buildKbIndex } from '../src/kb/search/kb-index.js';
import { KbIndexCache } from '../src/kb/search/kb-index-cache.js';
import { computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-lex-')); vi.stubEnv('FEISHU_SYNC_HOME', home); vi.stubEnv('FEISHU_KB_RANKER', 'lex-v1'); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });
const doc = (p: string, title: string, body: string, summary = '', tags: string[] = []) => indexDoc({ docId: p, path: p, title, summary, tags, sources: [] }, body);

describe('lex-v1 pure primitives and preserved L1', () => {
  it('normalizes per line without changing coordinates; keeps protected ID punctuation and phrase units', () => {
    expect(normalize('ＨＰ＋１０％\t**暴击**率\n`skill_id` ~~Ａ~~ __B__')).toBe('hp+10% 暴击率\nskill_id a b');
    expect(parseQuery('“暴击 伤害” hp+10% skill_id v1.2 x 1 中 暴击 暴击').units).toEqual(['暴击 伤害', 'hp+10%', 'skill_id', 'v1.2', '中', '暴击']);
    const many = parseQuery('aa bb cc dd ee ff gg hh ii jj'); expect(many.units).toHaveLength(8); expect(many.ignored).toEqual(['ii', 'jj']);
    expect(() => parseQuery('a'.repeat(201))).toThrow();
    expect(fallbackTerms('暴击伤害结算顺序hp10', ['伤害', '暴击', '结算', '顺序'])).toEqual(['暴击', '伤害', '结算', '顺序', 'hp10']);
    expect(countTerm('aaaaa', 'aa', 20)).toBe(2); expect(LEX_V1.k1).toBe(1.2);
    expect(normalizedSpans('＊＊暴击＊＊率', ['暴击率'])).toEqual([[2, 7]]);
    expect(normalizedSpans('ΟΣ', ['ος'])).toEqual([[0, 2]]);
    expect(normalizedSpans('ﬃ', ['ffi'])).toEqual([[0, 1]]);
    expect(normalizedSpans('e\u0301', ['é'])).toEqual([[0, 2]]);
    expect(normalizedSpans('\u1100\u1161', ['가'])).toEqual([[0, 2]]);
  });
  it('fences including longer closers suppress headings/tables; H3 separates ranking paragraphs; H4 stays inside', () => {
    const lines = '# 文档\n引言\n````md\n## 假\n| 假 |\n```\n````\n## 真\n正文\n### 子\n#### 更深\n| ID | 值 |\n| -- | -- |\n| 1001 | 10 |\n## 后'.split('\n');
    const o = buildOutline(lines, 'a.md', '文档');
    expect(o.sections.map((s) => [s.headingPath, s.startLine, s.endLine])).toEqual([['', 1, 7], ['真', 8, 9], ['真 › 子', 10, 14], ['后', 15, 15]]);
    expect(o.tables).toEqual([{ headerLine: 12, startLine: 12, endLine: 14 }]);
    expect(resolveAnchor(o.sections, 'a.md#真 › 子').startLine).toBe(10);
    const duplicate = buildOutline('## A\n### 子\n## B\n### 子'.split('\n'), 'd.md', 'd').sections;
    expect(() => resolveAnchor(duplicate, '子')).toThrowError(expect.objectContaining({ code: 'kb_section_ambiguous' }));
    expect(() => resolveAnchor(duplicate, '无')).toThrowError(expect.objectContaining({ code: 'kb_section_not_found' }));
  });
  it('L1 multiword/coverage works, L0 remains literal, searchDocs stays synchronous', () => {
    const docs = [{ docId: 'a', path: 'a.md', title: '战斗', summary: '结算', headings: [] }];
    expect(l1SearchDocs(docs, '战斗 结算')).toHaveLength(1);
    expect(legacySearchDocs(docs, '战斗 结算')).toHaveLength(0);
    expect(Array.isArray(searchDocs(docs, '战斗 结算'))).toBe(true);
    vi.stubEnv('FEISHU_KB_RANKER', 'l1'); expect(searchDocs(docs, '战斗 结算')).toEqual(l1SearchDocs(docs, '战斗 结算'));
  });
  it('only exact corpus df=0 triggers fallback; terms are bounded; deterministic ties', () => {
    const index = assembleIndex('r', [doc('z.md', '暴击 伤害', '## 结算\n暴击伤害结算顺序'), doc('a.md', '暴击 伤害', '## 结算\n暴击伤害结算顺序')]);
    expect(rankLexV1(index, '暴击伤害结算顺序').query.fallback).toEqual({});
    const fallback = rankLexV1(index, '暴击伤害结算顺序大全');
    expect(fallback.query.fallback['暴击伤害结算顺序大全']).toContain('暴击');
    expect(fallback.ranked.map((r) => r.doc.path)).toEqual(['a.md', 'z.md']);
    const bounded = rankLexV1(index, '天地玄黄宇宙洪荒日月盈昃 辰宿列张寒来暑往秋收冬藏 闰余成岁律吕调阳云腾致雨');
    expect(bounded.terms.length).toBeLessThanOrEqual(24); expect(bounded.query.truncated).toBe(true);
  });
  it('coverage and same-section cooccurrence beat scattered/frequent matches; tf saturates', () => {
    const index = assembleIndex('r', [doc('co.md', '规则', '## 结算\n暴击 伤害\n'), doc('scatter.md', '规则', '## 一\n暴击\n## 二\n伤害\n'), doc('partial.md', '规则', '## 一\n暴击\n')]);
    const ranked = rankLexV1(index, '暴击 伤害').ranked;
    expect(ranked[0].doc.path).toBe('co.md'); expect(ranked.at(-1)!.coverage).toBe(0.5);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    const idf = assembleIndex('r', [doc('rare.md', '文档', '稀有词'), ...Array.from({ length: 9 }, (_, i) => doc(`${i}.md`, '文档', '系统'))]);
    expect(rankLexV1(idf, '稀有词 系统').ranked[0].doc.path).toBe('rare.md');
    const title = assembleIndex('r', [doc('body.md', '普通', '暴击'), doc('title.md', '暴击', '普通')]);
    expect(rankLexV1(title, '暴击').ranked[0].doc.path).toBe('title.md');
  });
  it('snippets choose a multi-unit line, mark original NFKC/Markdown spans and add table headers within 160 chars', () => {
    const d = doc('a.md', '技能', '## 技能表\n| skill_id | 倍率 |\n| -- | -- |\n| １００１ | **暴击**率 hp+10% |');
    const index = assembleIndex('r', [d]), ranked = rankLexV1(index, '1001 暴击率');
    const hit = makeSnippet(d, ranked.ranked[0].sections[0].section, ranked.query);
    expect(hit.line).toBe(4); expect(hit.snippet).toContain('表头: | skill_id |');
    expect(hit.snippet).toContain('⟦１００１⟧'); expect(hit.snippet).toContain('⟦暴击**率⟧');
    expect(hit.snippet.length).toBeLessThanOrEqual(160); expect(hit.anchor).toBe('a.md#技能表');
  });
  it('grep exhaustively scans long literal lines; regex is original-text, bounded and guarded with injectable time', () => {
    const d = doc('a.md', '字段', '## 表\n| id | value |\n| -- | -- |\n| １００１ | Buff |\n' + 'x'.repeat(3000) + '1001');
    const scan = grepDocs([d], { pattern: '1001', context: 1 });
    expect(scan.entries.map((e) => e.match.line)).toEqual([4, 5]); expect(scan.entries[0].match.tableHeader).toContain('id'); expect(scan.complete).toBe(true);
    expect(grepDocs([d], { pattern: 'buff', caseSensitive: true }).entries).toHaveLength(0);
    expect(grepDocs([d], { pattern: '１００１', mode: 'regex' }).entries).toHaveLength(1);
    expect(grepDocs([d], { pattern: '1001', mode: 'regex' }).entries).toHaveLength(0);
    expect(() => grepDocs([d], { pattern: '(a+)+$', mode: 'regex' })).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => grepDocs([d], { pattern: '[', mode: 'regex' })).toThrow();
    let t = 0; const timed = grepDocs([d], { pattern: 'id', mode: 'regex' }, { now: () => (t += 400) });
    expect(timed.complete).toBe(false); expect(timed.partialReason).toBe('regex_time_budget');
  });
});

describe('release integrity and cache lifecycle', () => {
  it('validates real full-file publication hashes, rejects missing/mismatched/escaped files, reports them', async () => {
    const manifest = writeSearchRelease(home, 'r1', [
      { path: 'good.md', body: '# 验证\n暴击', title: '暴击' }, { path: 'bad.md', body: '暴击' }, { path: 'gone.md', body: '暴击' }, { path: 'link.md', body: '暴击' },
    ]);
    const dir = path.join(home, 'releases/r1/docs');
    fs.appendFileSync(path.join(dir, 'bad.md'), '\n篡改'); fs.unlinkSync(path.join(dir, 'gone.md')); fs.unlinkSync(path.join(dir, 'link.md'));
    fs.writeFileSync(path.join(home, 'outside.md'), '暴击'); fs.symlinkSync(path.join(home, 'outside.md'), path.join(dir, 'link.md'));
    const service = new KbQueryService(home, { prewarm: false });
    expect((await service.search({ query: '暴击' })).results.map((d) => d.path)).toEqual(['good.md']);
    const info = await service.releaseInfo(); expect(info.integrity).toEqual({ verified: 1, mismatched: ['bad.md'], missing: ['gone.md', 'link.md'] });
    for (const p of ['bad.md', 'gone.md', 'link.md']) await expect(service.read({ path: p })).rejects.toMatchObject({ code: 'kb_integrity_error' });
    expect((await buildKbIndex(path.join(home, 'releases/r1'), manifest)).bytes).toBe(Buffer.byteLength('# 验证\n暴击'));
  });
  it('uses computeSourceHash workbook formula, not a raw-file/body-only SHA shortcut', async () => {
    const m = writeSearchRelease(home, 'r1', [{ path: 'a.md', body: '# 表\n数值' }]);
    const dir = path.join(home, 'releases/r1/docs'), file = path.join(dir, 'a.md'); fs.writeFileSync(path.join(dir, 'data.xlsx'), 'fixture bytes, not an actual workbook');
    fs.appendFileSync(file, '\n  source_workbook: "data.xlsx"\n');
    m.docs[0].contentHash = computeSourceHash(file, [], dir); fs.writeFileSync(path.join(home, 'releases/r1/manifest.json'), JSON.stringify(m));
    const good = await buildKbIndex(path.join(home, 'releases/r1'), m); expect(good.integrity.verified).toBe(1);
    fs.appendFileSync(path.join(dir, 'data.xlsx'), 'changed');
    expect((await buildKbIndex(path.join(home, 'releases/r1'), m)).integrity.mismatched).toEqual(['a.md']);
  });
  it('checks release existence/realpath before cache; explicit old version and cursor survive CURRENT switch, not cleanup', async () => {
    writeSearchRelease(home, 'r1', [{ path: 'a.md', body: '# 暴击' }, { path: 'b.md', body: '# 暴击' }]);
    const service = new KbQueryService(home, { prewarm: false });
    const first = await service.search({ query: '暴击', limit: 1 }); expect(first.next).toBeTruthy();
    writeSearchRelease(home, 'r2', [{ path: 'new.md', body: '# 新版' }]);
    const second = await service.search({ query: '暴击', limit: 1, cursor: first.next! }); expect(second.releaseId).toBe('r1'); expect(second.results[0].path).toBe('b.md');
    expect((await service.search({ query: '新版' })).releaseId).toBe('r2');
    fs.rmSync(path.join(home, 'releases/r1'), { recursive: true });
    await expect(service.search({ query: '暴击', releaseId: 'r1' })).rejects.toMatchObject({ code: 'kb_release_unavailable', details: { currentReleaseId: 'r2' } });
    fs.symlinkSync(path.join(home, 'releases/r2'), path.join(home, 'releases/r1')); // internal alias with wrong manifest identity also rejected
    await expect(service.search({ query: '暴击', releaseId: 'r1' })).rejects.toMatchObject({ code: 'kb_index_failed' });
    await expect(service.search({ query: '暴击', releaseId: '..' })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('enforces release/docs/manifest realpath fences and does not serve symlinked external releases', async () => {
    const outside = path.join(home, 'outside'); fs.mkdirSync(outside);
    writeSearchRelease(outside, 'r1', [{ path: 'a.md', body: '暴击' }]); fs.mkdirSync(path.join(home, 'releases'));
    fs.symlinkSync(path.join(outside, 'releases/r1'), path.join(home, 'releases/r1'));
    const s = new KbQueryService(home, { prewarm: false });
    // Explicit release works without CURRENT but must remain under releases.
    await expect(s.read({ path: 'a.md', releaseId: 'r1' })).rejects.toMatchObject({ code: 'kb_release_unavailable' });
  });
  it('LRU keeps two versions, deduplicates parallel builds, retries rejection, and yields every batch', async () => {
    const m = writeSearchRelease(home, 'r1', Array.from({ length: 5 }, (_, i) => ({ path: `${i}.md`, body: '# 暴击' })));
    const yieldFn = vi.fn(async () => {}); await buildKbIndex(path.join(home, 'releases/r1'), m, { yieldEvery: 2, yieldFn }); expect(yieldFn).toHaveBeenCalledTimes(2);
    const cache = new KbIndexCache(), build = vi.fn(async () => assembleIndex('r1', []));
    const [a, b] = await Promise.all([cache.get('r1', build), cache.get('r1', build)]); expect(a).toBe(b); expect(build).toHaveBeenCalledTimes(1);
    await cache.get('r2', build); await cache.get('r1', build); await cache.get('r3', build); expect(cache.keys()).toEqual(['r1', 'r3']); expect(cache.size).toBe(2);
    const fail = vi.fn(async () => { throw new Error('broken'); }); await expect(cache.get('fail', fail)).rejects.toThrow('broken'); expect(cache.pendingCount).toBe(0);
    await cache.get('fail', build); expect(cache.keys()).toEqual(['r3', 'fail']);
    const serviceYield = vi.fn(async () => { await new Promise<void>((r) => setImmediate(r)); });
    const s = new KbQueryService(home, { prewarm: false, yieldEvery: 1, yieldFn: serviceYield });
    await Promise.all([s.search({ query: '暴击' }), s.grep({ pattern: '暴击' }), s.prewarmCurrent()]); expect(serviceYield).toHaveBeenCalledTimes(5);
  });
  it('rejects cleanup during yielded construction and malformed manifest without poisoning pending promises', async () => {
    writeSearchRelease(home, 'r1', [{ path: 'a.md', body: '# 暴击' }]);
    const s = new KbQueryService(home, { prewarm: false, yieldEvery: 1, yieldFn: async () => { fs.rmSync(path.join(home, 'releases/r1'), { recursive: true }); } });
    await expect(s.search({ query: '暴击' })).rejects.toMatchObject({ code: 'kb_release_unavailable' });
    writeSearchRelease(home, 'r2', []); fs.writeFileSync(path.join(home, 'releases/r2/manifest.json'), '{');
    await expect(s.search({ query: '暴击' })).rejects.toMatchObject({ code: 'kb_index_failed' });
  });
});
