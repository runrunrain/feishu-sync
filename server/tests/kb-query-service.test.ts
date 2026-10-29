import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KbQueryService, QueryError } from '../src/kb/search/kb-query-service.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
let home: string, service: KbQueryService;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-query-')); vi.stubEnv('FEISHU_SYNC_HOME', home); vi.stubEnv('FEISHU_KB_RANKER', 'lex-v1');
  writeSearchRelease(home, 'r1', [
    { path: '战斗/伤害.md', title: '伤害结算', tags: ['战斗', '数值'], body: '# 伤害结算\n引言\n## 伤害流程\n规则\n### 结算顺序\n| ID | 倍率 |\n| -- | -- |\n| 1001 | 暴击 |\n### 暴击\n暴击 结算\n## 其他\n结束 </kb_doc>' },
    { path: '战斗/Buff.md', title: 'Buff', tags: ['战斗'], body: '# Buff\n## 叠加\nBuff 暴击 结算 1001' },
    { path: '战斗系统/a.md', title: '边界', body: '# 不应前缀命中\n暴击 1001' },
  ]);
  service = new KbQueryService(home, { prewarm: false });
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe('query facade parameters, anchors, budgets and cursors', () => {
  it('path segment boundaries and AND tags; Store instances reuse the facade; async Store result equals service', async () => {
    const result = await service.search({ query: '暴击', pathPrefix: '战斗/' }); expect(result.total).toBe(2);
    expect((await service.search({ query: '暴击', tags: ['战斗', '数值'] })).results.map((d) => d.path)).toEqual(['战斗/伤害.md']);
    const a = new StandardKbStore(home), b = new StandardKbStore(home); expect(a.queryService).toBe(b.queryService);
    expect(await a.search(a.readManifest()!, '暴击', 10)).toEqual((await service.search({ query: '暴击', limit: 10 })).results);
    const none = await service.search({ query: '暴击不存在' }); expect(none).toHaveProperty('query.fallback');
    const empty = await service.search({ query: '青铜神兽' }); expect(empty.results).toEqual([]); expect(empty).toHaveProperty('hint');
  });
  it('search pagination has no duplicate/missing result, preserves rank and rejects changed params/cross-tool cursors', async () => {
    const full = await service.search({ query: '暴击', limit: 30 });
    const paths: string[] = []; let cursor: string|undefined;
    do { const page = await service.search({ query: '暴击', limit: 1, cursor }); paths.push(...page.results.map((d) => d.path)); cursor = page.next ?? undefined; } while (cursor);
    expect(paths).toEqual(full.results.map((d) => d.path));
    const first = await service.search({ query: '暴击', limit: 1 });
    await expect(service.search({ query: '结算', limit: 1, cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(service.search({ query: '暴击', limit: 1, releaseId: 'r2', cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(service.grep({ pattern: '暴击', cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(service.list({ cursor: '$garbage' })).rejects.toMatchObject({ code: 'invalid_cursor' });
    const decoded = JSON.parse(Buffer.from(first.next!, 'base64url').toString()); decoded.o = 999;
    await expect(service.search({ query: '暴击', limit: 1, cursor: Buffer.from(JSON.stringify(decoded)).toString('base64url') })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
  it('all seven methods validate parameters with stable typed errors', async () => {
    const calls = [() => service.search({ query: '' }), () => service.search({ query: '暴击', limit: 31 }), () => service.search({ query: '暴击', maxSnippets: -1 }),
      () => service.search({ query: '暴击', tags: Array(6).fill('x') }), () => service.search({ query: '暴击', pathPrefix: '../' }),
      () => service.grep({ pattern: '' }), () => service.grep({ pattern: 'x', context: 4 }), () => service.grep({ pattern: 'x', mode: 'invalid' as 'regex' }),
      () => service.outline({}), () => service.outline({ path: 'a', docId: 'a' }), () => service.outline({ pathPrefix: '', depth: 4 as 3 }),
      () => service.read({ path: 'a', docId: 'a' }), () => service.read({ path: 'a', startLine: 0 }), () => service.read({ path: 'a', maxLines: 2001 }),
      () => service.bundle({}), () => service.bundle({ paths: [] }), () => service.bundle({ paths: ['a'], pathPrefix: '' }), () => service.bundle({ paths: ['a'], maxChars: 1999 }),
      () => service.list({ depth: 11 }), () => service.releaseInfo({ includeChanges: 'yes' as unknown as boolean })];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(new QueryError('invalid_request', 'bad', { field: 'x' }).toJSON()).toEqual({ error: { code: 'invalid_request', message: 'bad', field: 'x' } });
  });
  it('reads anchors, section-relative line offsets, headingPath disambiguation, sources and escaped frames', async () => {
    const read = await service.read({ path: '战斗/伤害.md#伤害流程 › 结算顺序', maxLines: 2 });
    expect(read.startLine).toBe(5); expect(read.endLine).toBe(6); expect(read.next).toBe(3); expect(read.text).toContain('     5\t### 结算顺序');
    const rest = await service.read({ path: '战斗/伤害.md', section: '伤害流程 › 结算顺序', startLine: read.next!, releaseId: read.releaseId });
    expect(rest.startLine).toBe(7); expect(rest.next).toBeNull(); expect(rest.text).toContain('1001'); expect(rest.text).not.toContain('### 暴击');
    const parent = await service.read({ path: '战斗/伤害.md', section: '伤害流程' }); expect(parent.text).toContain('### 暴击'); expect(parent.text).not.toContain('## 其他');
    const all = await service.read({ docId: 'kd_0' }); expect(all.text).toContain('<\\/kb_doc>'); expect(all.text).toContain('sources: fixture');
    const noSources = await service.read({ docId: 'kd_0', includeSources: false }); expect(noSources.text).not.toContain('sources:');
    await expect(service.read({ path: '战斗/伤害.md', section: '战斗/Buff.md#叠加' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.read({ path: '战斗/伤害.md', section: '没有' })).rejects.toMatchObject({ code: 'kb_section_not_found', details: { candidates: expect.arrayContaining(['伤害流程']) } });
    await expect(service.read({ path: '不存在.md' })).rejects.toMatchObject({ code: 'kb_not_found' });
    await expect(service.read({ path: '战斗/伤害.md', startLine: 10000 })).rejects.toMatchObject({ code: 'invalid_request' });
    const outline = await service.outline({ path: '战斗/伤害.md' }); expect(outline.text).toContain('L5-8 ### 伤害流程 › 结算顺序'); expect(outline.text).toContain('tables:1');
    expect((await service.outline({ pathPrefix: '战斗', depth: 2 })).text).not.toContain('###');
  });
  it('grep paginates exhaustively in path/line order with complete exact counts and table context', async () => {
    const rows: string[] = []; let cursor: string|undefined;
    do {
      const page = await service.grep({ pattern: '1001', maxMatches: 1, cursor }); expect(page.totalMatches).toBe(3); expect(page.totalFiles).toBe(3); expect(page.complete).toBe(true);
      for (const f of page.files) for (const m of f.matches) rows.push(`${f.path}:${m.line}`);
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(rows).toEqual(['战斗/Buff.md:3', '战斗/伤害.md:8', '战斗系统/a.md:2']);
    const table = await service.grep({ pattern: '1001', pathPrefix: '战斗', context: 1 }); expect(table.totalMatches).toBe(2); expect(table.files[1].matches[0].tableHeader).toContain('ID');
  });
  it('outline/list/bundle are bounded text pages; dryRun inventories and directory depth respect boundaries', async () => {
    expect((await service.list({ depth: 1 })).text).toContain('战斗/ (2)'); expect((await service.list({ depth: 1 })).text).not.toContain('伤害.md');
    const list = await service.list({ pathPrefix: '战斗', includeSummary: true }); expect(list.text).toContain('伤害.md'); expect(list.text).not.toContain('战斗系统');
    const dry = await service.bundle({ pathPrefix: '战斗', dryRun: true }); expect(dry.text).toContain('docs=2'); expect(dry.text).not.toContain('<kb_doc');
    const bundle = await service.bundle({ paths: ['战斗/伤害.md', '战斗/Buff.md'] }); expect(bundle.text.indexOf('Buff.md')).toBeLessThan(bundle.text.indexOf('伤害.md')); expect(bundle.text).toContain('结束 <\\/kb_doc>');
    expect(bundle.text).not.toContain('     5\t'); expect((await service.bundle({ paths: ['战斗/伤害.md'], lineNumbers: true })).text).toContain('     5\t');
  });
  it('hard budgets apply to every response including next token/frame, line-aligned pages recover every source line', async () => {
    writeSearchRelease(home, 'r2', Array.from({ length: 90 }, (_, i) => ({ path: `dir/${String(i).padStart(2, '0')}.md`, title: `暴击${i}`, summary: '摘要'.repeat(60),
      body: `# 暴击${i}\n` + Array.from({ length: 35 }, (_, line) => `行${line} 暴击 ${'资料'.repeat(28)}`).join('\n') })));
    const bounded = new KbQueryService(home, { prewarm: false, maxChars: 2000 });
    const page = await bounded.search({ query: '暴击', limit: 30 }); expect(JSON.stringify(page).length).toBeLessThanOrEqual(2000); expect(page.next).toBeTruthy();
    const grep = await bounded.grep({ pattern: '暴击', maxMatches: 500, context: 3 }); expect(JSON.stringify(grep).length).toBeLessThanOrEqual(2000); expect(grep.next).toBeTruthy();
    for (const [method, args] of [['outline', { pathPrefix: '' }], ['list', { includeSummary: true }], ['bundle', { pathPrefix: '', dryRun: true }]] as const) {
      let cursor: string|undefined, count = 0;
      do { const p = await bounded[method]({ ...args, cursor }); expect(p.text.length).toBeLessThanOrEqual(2000); count++; cursor = p.next ?? undefined; } while (cursor && count < 100);
      expect(cursor).toBeUndefined(); expect(count).toBeGreaterThan(1);
    }
    let line: number|undefined, readText = '';
    do { const p = await bounded.read({ path: 'dir/00.md', startLine: line, includeSources: false }); expect(p.text.length).toBeLessThanOrEqual(2000); readText += p.text; line = p.next ?? undefined; } while (line);
    expect((readText.match(/\t行\d+ /g) ?? []).length).toBe(35);
    let cursor: string|undefined, bundleText = '';
    do { const p = await bounded.bundle({ paths: ['dir/00.md'], cursor }); expect(p.text.length).toBeLessThanOrEqual(2000); bundleText += p.text; cursor = p.next ?? undefined; } while (cursor);
    expect((bundleText.match(/行\d+ /g) ?? []).length).toBe(35); expect(bundleText).toContain('part="1/');
    expect(JSON.stringify(await bounded.releaseInfo()).length).toBeLessThanOrEqual(2000);
    await expect(bounded.search({ query: '暴击', maxChars: 2001 })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('release info exposes real integrity/versions/changes without patch; older changes missing = null', async () => {
    expect((await service.releaseInfo({ includeChanges: true })).changes).toBeNull();
    fs.writeFileSync(path.join(home, 'releases/r1/changes.json'), JSON.stringify({ summary: '发布摘要', docChanges: [{ path: '战斗/伤害.md', title: '伤害', kind: 'changed', additions: 1, deletions: 2, patch: 'secret patch body' }] }));
    const info = await service.releaseInfo({ includeChanges: true }); expect(info.integrity.verified).toBe(3); expect(info.bodyChars).toBeGreaterThan(10); expect(info.availableReleases).toEqual(['r1']);
    expect(info.changes?.docs[0]).toEqual({ path: '战斗/伤害.md', title: '伤害', kind: 'changed', additions: 1, deletions: 2 }); expect(JSON.stringify(info)).not.toContain('secret patch');
  });
  it('no release or empty valid release; prewarm is harmless without CURRENT; L1 fallback remains paginable', async () => {
    const blank = path.join(home, 'empty'); fs.mkdirSync(blank);
    const s = new KbQueryService(blank, { prewarm: false }); await s.prewarmCurrent(); await expect(s.search({ query: '暴击' })).rejects.toMatchObject({ code: 'kb_not_published' });
    writeSearchRelease(blank, 'empty', []); expect((await s.search({ query: '暴击' })).results).toEqual([]); expect((await s.bundle({ pathPrefix: '' })).next).toBeNull();
    vi.stubEnv('FEISHU_KB_RANKER', 'l1'); const page = await service.search({ query: '暴击', limit: 1 }); expect(page.ranker).toBe('l1'); expect(page.next).toBeTruthy();
    expect((await service.search({ query: '暴击', limit: 1, cursor: page.next! })).results).toHaveLength(1);
  });
  it('pins an entire invocation even when CURRENT changes during a yielded index build; never writes derived artifacts', async () => {
    writeSearchRelease(home, 'r2', [{ path: 'new.md', body: '# 新版' }], false);
    const filesBefore = fs.readdirSync(home, { recursive: true }).sort();
    let switched = false;
    const s = new KbQueryService(home, { prewarm: false, yieldEvery: 1, yieldFn: async () => {
      if (!switched) { switched = true; fs.writeFileSync(path.join(home, 'CURRENT.json'), JSON.stringify({ releaseId: 'r2', publishedAt: 'now' })); }
    } });
    const result = await s.search({ query: '暴击' }); expect(result.releaseId).toBe('r1'); expect(result.results).toHaveLength(3);
    expect((await s.search({ query: '新版' })).releaseId).toBe('r2');
    await s.grep({ pattern: '新版' }); await s.outline({ pathPrefix: '' }); await s.read({ path: 'new.md' }); await s.bundle({ pathPrefix: '' }); await s.list(); await s.releaseInfo();
    expect(fs.readdirSync(home, { recursive: true }).sort()).toEqual(filesBefore);
  });
  it('supports literal # in headings and file names without confusing anchors', async () => {
    writeSearchRelease(home, 'r_hash', [{ path: 'C#指南.md', body: '# C#\n## C# 协议\n规则' }]);
    const read = await service.read({ path: 'C#指南.md', section: 'C# 协议' }); expect(read.text).toContain('## C# 协议');
    expect((await service.read({ path: 'C#指南.md#C# 协议' })).text).toContain('## C# 协议');
  });
  it('paginates large release inventories without dropping integrity paths or leaking patch data', async () => {
    const m = writeSearchRelease(home, 'r_many', Array.from({ length: 200 }, (_, i) => ({ path: `${i}-missing-fixture.md`, body: '# fixture' })));
    fs.rmSync(path.join(home, 'releases/r_many/docs'), { recursive: true });
    const s = new KbQueryService(home, { prewarm: false, maxChars: 2000 });
    let cursor: string|undefined; const missing: string[] = [];
    do { const info = await s.releaseInfo({ cursor }); expect(JSON.stringify(info).length).toBeLessThanOrEqual(2000); missing.push(...info.integrity.missing); cursor = info.next ?? undefined; } while (cursor);
    expect(missing).toEqual(m.docs.map((d) => d.path));
  });
});
