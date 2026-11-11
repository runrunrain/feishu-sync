import { beforeAll, beforeEach, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeRawCatalog } from '../src/kb/raw-mcp-catalog.js';
import { RawQueryService } from '../src/kb/raw-query-service.js';
import { KbQueryService } from '../src/kb/search/kb-query-service.js';
import { registerKbTools } from '../src/mcp/kb-mcp-tools.js';
import { createHttpGateway } from '../src/kb-lan/http-gateway.js';
import { tokenDigest } from '../src/kb-lan/token-store.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import type { DocumentRecord } from '../src/types/index.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';

let root: string, raw: string, catalog: string, records: DocumentRecord[];
beforeAll(async () => { const { bundleMcp } = await import('../scripts/lib/mcp-bundle.mjs'); await bundleMcp(); });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-mcp-')); raw = path.join(root, 'raw'); catalog = path.join(root, 'catalog.json'); fs.mkdirSync(raw); records = []; });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function add(rel: string, body: string, extra: Partial<DocumentRecord> = {}) {
  const file = path.join(raw, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
  records.push({ objToken: `t${records.length}`, title: path.basename(rel), localRelPath: rel, objType: 'docx', status: 'synced', ...extra } as DocumentRecord);
}
const publish = () => writeRawCatalog(catalog, raw, records, () => []);
const query = () => new RawQueryService(catalog);

it('old app-owned stdio entries gain raw tools, but unrelated standard roots do not inherit raw access', async () => {
  add('规则.md', '规则');
  const standard = path.join(root, 'standard');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ standardKb: { outputRoot: standard } }));
  writeRawCatalog(path.join(root, 'mcp/raw-catalog.json'), raw, records, () => []);
  for (const [kbRoot, count] of [[standard, 20], [path.join(root, 'unrelated'), 9]] as const) {
    const client = new Client({ name: 'legacy-config', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp/kb-mcp.cjs'), '--kb-root', kbRoot],
        env: { ...process.env, FEISHU_SYNC_HOME: root } as Record<string, string>, stderr: 'pipe' }));
      expect((await client.listTools()).tools).toHaveLength(count);
    } finally { await client.close(); }
  }
});

it('returns labelled fragment candidates only when an unquoted exact raw search has no match', async () => {
  add('战斗规则.md', '战斗中由任务看板分发任务。');
  add('农业规则.md', '农业生产。'); publish();
  const fallback: any = await query().call('raw_search', { query: '战斗任务' }, 6000);
  expect(fallback.results).toEqual([expect.objectContaining({ objToken: 't0', matchType: 'fallback', matchedFragments: expect.arrayContaining(['战斗', '任务']) })]);
  expect(fallback.warning).toContain('不能视为完整命中');
  const phrase: any = await query().call('raw_search', { query: '"战斗任务"' }, 6000);
  expect(phrase.total).toBe(0);
  add('直接命中.md', '战斗任务是一个明确术语。'); publish();
  const exact: any = await query().call('raw_search', { query: '战斗任务' }, 6000);
  expect(exact.results).toHaveLength(1); expect(exact.results[0].objToken).toBe('t2');
  expect(exact.results[0]).not.toHaveProperty('matchType');
});

it('uses app candidates, skips trash/unsynced, reads retained local files despite current cloud permission errors', async () => {
  add('100/设计.md', '100 是概念层', { status: 'error', lastSyncedAt: '2026-10-01T00:00:00Z' });
  add('pending.md', '未同步', { status: 'placeholder' as never });
  add('.trash-bin/deleted.md', '不能暴露'); publish();
  expect(await query().call('raw_list', {}, 6000)).toMatchObject({ total: 1, sourceKind: 'raw' });
  expect(await query().call('raw_read', { objToken: 't0' }, 6000)).toMatchObject({ lines: [{ line: 1, text: '100 是概念层' }] });
  fs.unlinkSync(path.join(raw, '100/设计.md'));
  expect(await query().call('raw_list', {}, 6000)).toMatchObject({ total: 0 });
});

it('marks a permission placeholder as unusable evidence across list, search and read', async () => {
  add('受限.md', '# 受限\n> **注意**: 该文档在飞书侧权限受限（当前账号无访问权限，API 返回 40403 no permission），无法获取内容。\n> 如需查阅，请在飞书中向文档所有者申请权限后重新获取。');
  add('正常.md', '正文讨论权限受限，但这不是占位文档。');
  publish();
  const list: any = await query().call('raw_list', {}, 6000);
  expect(list.results.find((item: any) => item.objToken === 't0')).toMatchObject({ sourceAvailability: 'permission_denied_placeholder', usableAsEvidence: false });
  expect(list.results.find((item: any) => item.objToken === 't1')).not.toHaveProperty('sourceAvailability');
  const search: any = await query().call('raw_search', { query: '受限' }, 6000);
  expect(search.results.find((item: any) => item.objToken === 't0')).toMatchObject({ sourceAvailability: 'permission_denied_placeholder', usableAsEvidence: false });
  expect(await query().call('raw_read', { objToken: 't0' }, 6000)).toMatchObject({ sourceAvailability: 'permission_denied_placeholder', usableAsEvidence: false });
  await expect(query().call('raw_list_sheets', { objToken: 't0' }, 6000)).rejects.toMatchObject({ code: 'raw_workbook_unavailable', details: { reason: 'permission_denied_placeholder' } });
});

it('fences catalog entries, symlinks, and CSV attachments; no arbitrary client path reads', async () => {
  add('safe.md', '内容'); fs.writeFileSync(path.join(root, 'secret.md'), 'secret');
  writeRawCatalog(catalog, raw, [...records, { ...records[0], objToken: 'bad', localRelPath: '../secret.md' }], () => [path.join(root, 'secret.md')]);
  expect(await query().call('raw_list', {}, 6000)).toMatchObject({ total: 1 });
  await expect(query().call('raw_read', { path: '../secret.md' }, 6000)).rejects.toMatchObject({ code: 'raw_not_found' });
  fs.unlinkSync(path.join(raw, 'safe.md')); fs.symlinkSync(path.join(root, 'secret.md'), path.join(raw, 'safe.md'));
  expect(await query().call('raw_list', {}, 6000)).toMatchObject({ total: 0 });
});

it('paginates reads and searches with change checks, includes registered CSV, preserves source bytes', async () => {
  add('200/规则.md', '标题\n200 数据结构\n300 系统功能\n400 玩法');
  fs.writeFileSync(path.join(raw, '数据.csv'), '编号,名称\n200,模型');
  writeRawCatalog(catalog, raw, records, () => ['数据.csv']);
  const first: any = await query().call('raw_read', { objToken: 't0', limit: 2 }, 1800);
  expect(first.nextOffset).toBe(2);
  const second: any = await query().call('raw_read', { objToken: 't0', offset: first.nextOffset, contentHash: first.contentHash }, 1800);
  expect(JSON.stringify(second)).toContain('200,模型');
  const csvLine = second.lines.find((item: { text: string }) => item.text === '200,模型');
  const csvSegment = second.sourceSegments.find((item: { kind: string }) => item.kind === 'csv');
  expect(csvSegment).toMatchObject({ path: '数据.csv' });
  expect(csvLine.line - csvSegment.startLine + csvSegment.sourceStartLine).toBe(2);
  fs.appendFileSync(path.join(raw, '数据.csv'), '\n300,系统');
  await expect(query().call('raw_read', { objToken: 't0', offset: 2, contentHash: first.contentHash }, 1800)).rejects.toMatchObject({ code: 'raw_changed' });
  const listed: any = await query().call('raw_list', { limit: 1 }, 1800);
  add('100/概念.md', '概念'); publish();
  await expect(query().call('raw_list', { offset: 1, catalogHash: listed.catalogHash }, 1800)).rejects.toMatchObject({ code: 'raw_changed' });
  expect(fs.readFileSync(path.join(raw, '200/规则.md'), 'utf8')).toBe('标题\n200 数据结构\n300 系统功能\n400 玩法');
});

it('real stdio and authenticated HTTP expose identical raw tools/results, matching in-app search without a standard release', async () => {
  add('100/概念.md', '100 定义产品概念'); add('200/结构.md', '200 定义数据结构\n设计规则'); publish();
  const standard = new KbQueryService(path.join(root, 'standard'), { prewarm: false });
  const token = 'fskb_' + 'a'.repeat(43);
  const gateway = createHttpGateway({ host: '127.0.0.1', port: 0, maxSessions: 3, allowCidrs: ['127.0.0.0/8'], digests: [tokenDigest(token)], register: (server, state) => registerKbTools(server, standard, state, query()) });
  const local = new Client({ name: 'raw-test', version: '1' }), remote = new Client({ name: 'raw-test', version: '1' });
  try {
    await gateway.listen();
    await local.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp/kb-mcp.cjs'), '--data-root', root, '--kb-root', standard.kbRoot, '--raw-catalog', catalog], stderr: 'pipe' }));
    await remote.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    expect((await local.listTools()).tools).toEqual((await remote.listTools()).tools);
    expect((await local.listTools()).tools).toHaveLength(20);
    for (const [name, args] of [['raw_list', { pathPrefix: '200' }], ['raw_search', { query: '200 数据结构' }], ['raw_read', { objToken: 't1' }]] as const) {
      const request = { name, arguments: args }; const a = await local.callTool(request), b = await remote.callTool(request);
      expect(a.isError).not.toBe(true); expect(a).toEqual(b);
    }
    const app = new AgentToolService({ dataRoot: root, documentsProvider: () => records });
    const ctx = app.createRunContext({ runKind: 'discuss', outputRoot: standard.kbRoot, knowledgeBaseRoot: raw });
    try {
      const inside = JSON.parse((await app.executeTool(ctx.token, 'raw_search', { query: '200 数据结构' })).content[0].text);
      const outside: any = await query().call('raw_search', { query: '200 数据结构' }, 6000);
      expect(outside.results.map(({ score: _score, ...rest }: any) => rest)).toEqual(inside.results);
    } finally { app.revokeToken(ctx.token); }
    const invalid = await local.callTool({ name: 'raw_read', arguments: { path: '../secret.md' } }); expect(invalid.isError).toBe(true);
    const combined = await local.callTool({ name: 'search_all_knowledge', arguments: { query: '数据结构' } });
    const combinedRemote = await remote.callTool({ name: 'search_all_knowledge', arguments: { query: '数据结构' } });
    expect(combinedRemote).toEqual(combined);
    const combinedValue = JSON.parse((combined.content as Array<{ text: string }>)[0].text);
    expect(combinedValue.standard.error.code).toBe('kb_not_published');
    expect(combinedValue.raw.results[0].title).toBe('结构.md');
  } finally { await local.close(); await remote.close(); await gateway.close(); }
});

it('combined search preserves both sources and independent pagination', async () => {
  add('甲.md', '战斗规则甲'); add('乙.md', '战斗规则乙'); publish();
  const standard = path.join(root, 'standard');
  writeSearchRelease(standard, 'r_test', [{ path: '规则甲.md', body: '# 战斗规则甲\n战斗规则甲' }, { path: '规则乙.md', body: '# 战斗规则乙\n战斗规则乙' }]);
  const client = new Client({ name: 'combined-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp/kb-mcp.cjs'), '--data-root', root, '--kb-root', standard, '--raw-catalog', catalog], stderr: 'pipe' }));
    const tool = (await client.listTools()).tools.find((item) => item.name === 'search_all_knowledge');
    expect(tool?.outputSchema).toBeDefined();
    const call = async (args: Record<string, unknown>) => {
      const response = await client.callTool({ name: 'search_all_knowledge', arguments: args });
      const parsed = JSON.parse((response.content as Array<{ text: string }>)[0].text);
      expect(response.structuredContent).toEqual(parsed);
      return parsed;
    };
    const first = await call({ query: '战斗', limit: 1 });
    expect(first.standard).toMatchObject({ sourceKind: 'standard', releaseId: 'r_test', total: 2 });
    expect(first.raw).toMatchObject({ sourceKind: 'raw', total: 2, nextOffset: 1 });
    const next = await call({ query: '战斗', limit: 1, standardCursor: first.standard.next, rawOffset: first.raw.nextOffset, rawCatalogHash: first.raw.catalogHash });
    expect(next.standard.results[0].path).not.toBe(first.standard.results[0].path);
    expect(next.raw.results[0].objToken).not.toBe(first.raw.results[0].objToken);
  } finally { await client.close(); }
});
