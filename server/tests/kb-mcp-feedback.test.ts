import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KbQueryService } from '../src/kb/search/kb-query-service.js';
import { sourceVersionWarning, suggestDocPaths } from '../src/kb/search/query-metadata.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
import { KbVersionStore } from '../src/kb/kb-version-store.js';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot } from '../src/kb/raw-source-snapshot.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-feedback-')); vi.stubEnv('FEISHU_KB_RANKER', 'lex-v1'); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const service = () => new KbQueryService(root, { prewarm: false });

describe('actual MCP feedback regressions', () => {
  it('explains literal metacharacters and explicitly selects working character-class regex', async () => {
    writeSearchRelease(root, 'r1', [{ path: '民心.md', body: '愿留\n愿纳\n愿从\n愿战\n愿从' }]);
    const s = service();
    expect(await s.grep({ pattern: '愿[留纳从战]' })).toMatchObject({ mode: 'literal', totalMatches: 0, hint: expect.stringContaining('regex') });
    expect(await s.grep({ pattern: '愿[留纳从战]', mode: 'regex' })).toMatchObject({ mode: 'regex', totalMatches: 5, complete: true });
    expect(await s.grep({ pattern: '愿从' })).toMatchObject({ totalMatches: 2 });
    await expect(s.grep({ pattern: '[', mode: 'regex' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('does not claim regex results are complete when long lines were truncated', async () => {
    writeSearchRelease(root, 'r1', [{ path: 'long.md', body: 'x'.repeat(2100) + '愿从' }]);
    expect(await service().grep({ pattern: '愿从', mode: 'regex' })).toMatchObject({ complete: false, partial: true, partialReason: 'regex_line_limit', regexTruncatedLines: 1 });
    expect(await service().grep({ pattern: '愿从' })).toMatchObject({ totalMatches: 1, complete: true });
  });

  it('keeps fragment-only hits below exact hits with zero exact coverage and exposes absent units', async () => {
    writeSearchRelease(root, 'r1', [
      { path: 'exact.md', title: '参考', body: '规范' },
      { path: 'fallback.md', title: '设计 文档', body: '## 设计\n设计 '.repeat(30) + '\n## 文档\n文档 '.repeat(30) },
    ]);
    const result = await service().search({ query: 'Excel 设计文档 画板 规范' });
    expect(result.results[0]).toMatchObject({ path: 'exact.md', matchedUnits: ['规范'], coverage: 0.25 });
    expect(result.results[1]).toMatchObject({ path: 'fallback.md', fallbackUnits: ['设计文档'], matchedUnits: [], coverage: 0, matchType: 'fallback' });
    expect(result).toMatchObject({ unmatchedUnits: ['excel', '设计文档', '画板'], warning: expect.any(String) });
    expect(result.results[0].score!).toBeGreaterThan(result.results[1].score!);
  });

  it('quoted Chinese phrases never silently fall back into fragments', async () => {
    writeSearchRelease(root, 'r1', [{ path: 'a.md', title: '设计 文档', body: '设计与文档' }]);
    expect((await service().search({ query: '设计文档' })).results).toHaveLength(1);
    const quoted = await service().search({ query: '"设计文档"' });
    expect(quoted.results).toHaveLength(0); expect(quoted.query.fallback).toEqual({});
    expect((await service().search({ query: '设计文档 "设计文档"' })).results).toHaveLength(0);
  });

  it('returns bounded typo/path suggestions and never substitutes the requested document', async () => {
    writeSearchRelease(root, 'r1', [{ path: '民心系统/民心机制与阶层博弈规则.md', title: '民心机制与阶层博弈规则', body: '愿从' },
      { path: '世界/地形.md', title: '地形', body: '山川' }]);
    await expect(service().read({ path: '民心系统/民心机治.md' })).rejects.toMatchObject({ code: 'kb_not_found', details: { suggestions: ['民心系统/民心机制与阶层博弈规则.md'] } });
    await expect(service().outline({ path: '民心机治与阶层博弈规则.md' })).rejects.toMatchObject({ code: 'kb_not_found', details: { suggestions: ['民心系统/民心机制与阶层博弈规则.md'] } });
    expect(suggestDocPaths([{ path: '地形.md', title: '地形', docId: 'k1' }], '完全无关')).toEqual([]);
  });

  it('reports scope and title/path label mismatch without changing source data or claiming a content version', async () => {
    const manifest = writeSearchRelease(root, 'r1', [{ path: 'a.md', body: '规则' }, { path: 'b.md', body: '机制' }]);
    manifest.sourceSnapshot = [{ objToken: 'fixture', objType: 'docx', title: '设计思路V.1.5', relPath: '100/设计思路V.1.3.md', contentHash: 'hash', objEditTime: null }];
    const file = path.join(root, 'releases/r1/manifest.json'); fs.writeFileSync(file, JSON.stringify(manifest));
    const before = fs.readFileSync(file);
    const s = service(); const info = await s.releaseInfo();
    expect(info).toMatchObject({ sourceCount: 1, docCount: 2, coverage: { kind: 'curated', referencedSourceCount: 1 } });
    expect(info.sources[0]).toMatchObject({ referencedBy: 2, warning: { code: 'source_version_label_mismatch', titleVersion: '1.5', pathVersion: '1.3' } });
    expect((await s.read({ path: 'a.md' })).text).toContain('内容版本未确认');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(sourceVersionWarning({ title: '人物V1.5', relPath: '世界V1.3/人物V1.5.md' })).toBeUndefined();
    expect(sourceVersionWarning({ title: '人物V1.5', relPath: '世界V1.3/人物.md' })).toBeUndefined();
  });

  it('paginates large source inventories rather than dropping coverage metadata or paths', async () => {
    const m = writeSearchRelease(root, 'r1', [{ path: 'a.md', body: '规则' }]);
    m.sourceSnapshot = Array.from({ length: 35 }, (_, i) => ({ objToken: `s${i}`, objType: 'docx', title: `源${i}`, relPath: `100/源${i}.md`, contentHash: 'hash', objEditTime: null }));
    fs.writeFileSync(path.join(root, 'releases/r1/manifest.json'), JSON.stringify(m));
    let cursor: string | undefined; const ids: string[] = [];
    do {
      const page = await service().releaseInfo({ maxChars: 2000, cursor });
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(1488);
      ids.push(...page.sources.map((source) => source.objToken)); cursor = page.next ?? undefined;
    } while (cursor);
    expect(ids).toEqual(m.sourceSnapshot.map((source) => source.objToken));
  });

  it('persists explicit merge destinations, exposes them in MCP, and leaves historical unknowns unknown', async () => {
    const base = writeSearchRelease(root, 'old', [{ path: '旧.md', body: '旧内容' }, { path: '未知.md', body: '独立内容' }]);
    const next = writeSearchRelease(root, 'new', [{ path: '新.md', body: '重组后的内容' }]); next.baseReleaseId = 'old';
    fs.writeFileSync(path.join(root, 'releases/new/manifest.json'), JSON.stringify(next));
    new KbVersionStore(root).writeVersion(next, base, {}, { baseReleaseId: 'old', sources: [], affectedDocs: [] }, '合并旧内容', [{ path: '旧.md', mergedInto: ['新.md'] }]);
    const changes = (await service().releaseInfo({ includeChanges: true })).changes!.docs;
    expect(changes.find((item) => item.path === '旧.md')).toMatchObject({ kind: 'removed', mergedInto: ['新.md'] });
    expect(changes.find((item) => item.path === '未知.md')).toMatchObject({ kind: 'removed', mergedInto: null, removalNote: expect.stringContaining('未记录') });
    expect(() => new KbVersionStore(root).writeVersion(next, base, {}, { baseReleaseId: 'old', sources: [], affectedDocs: [] }, '', [{ path: '旧.md', mergedInto: ['缺失.md'] }])).toThrow('invalid_doc_merge');
  });

  it('accepts merge declarations through the real build tool and rejects invalid targets before completing', async () => {
    const stagingRoot = path.join(root, 'staging'); fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(stagingRoot, 'docs/新.md'), '新内容');
    const state: BuildRunState = { stagingRoot, knowledgeBaseRoot: root, snapshot: new RawSourceSnapshot([]), mode: 'full', workset: new Map(), finishInfo: null,
      baseDocPaths: new Set(['旧.md', '旧目录/旧.md']) };
    const tools = new AgentToolService({ dataRoot: root, documentsProvider: () => [] });
    const { token } = tools.createRunContext({ runKind: 'build', buildId: 'b1', outputRoot: root, knowledgeBaseRoot: root, buildState: state });
    try {
      await expect(tools.executeTool(token, 'kb_finish', { summary: '完成', docMerges: [{ path: '旧.md', mergedInto: ['../outside.md'] }] })).rejects.toThrow();
      expect(state.finishInfo).toBeNull();
      await expect(tools.executeTool(token, 'kb_finish', { summary: '完成', docMerges: [{ path: '编造.md', mergedInto: ['新.md'] }] })).rejects.toThrow('构建基准版本');
      expect(state.finishInfo).toBeNull();
      await tools.executeTool(token, 'kb_finish', { summary: '完成', docMerges: [{ path: '旧目录/旧.md', mergedInto: ['新.md'] }] });
      expect(state.finishInfo).toMatchObject({ docMerges: [{ path: '旧目录/旧.md', mergedInto: ['新.md'] }] });
    } finally { tools.revokeToken(token); }
  });
});
