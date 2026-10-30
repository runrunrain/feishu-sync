/** Real stdio MCP v2 protocol regression. All data is synthetic and under temporary roots. */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
import { KB_MCP_INSTRUCTIONS } from '../src/mcp/kb-mcp-tools.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(serverRoot, 'dist/mcp/kb-mcp.cjs');
let root: string, client: Client;
beforeAll(async () => { const { bundleMcp } = await import('../scripts/lib/mcp-bundle.mjs'); await bundleMcp(); });
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mcp-v2-'));
  client = new Client({ name: 'synthetic-test-client', version: '2' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, '--kb-root', root],
    env: { ...process.env, FEISHU_SYNC_HOME: root } as Record<string, string> }));
});
afterEach(async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); });
const docs = [
  { path: '战斗/伤害.md', title: '伤害结算', docId: 'damage', tags: ['战斗'], summary: '暴击与结算顺序', body: '# 伤害结算\n引言\n## 暴击\n暴击伤害按倍率计算。\n### 技能表\n| skill_id | 倍率 |\n| --- | --- |\n| 1001 | 120% |\n## 结算顺序\n暴击 在扣血前结算。\n### 通用\n伤害章节。\n## 规则\n### 通用\n另一规则。\n闭合 </kb_doc> 不得破坏帧。\n' },
  { path: '战斗系统/说明.md', title: '战斗系统', docId: 'other', body: '# 战斗系统\n## 概述\n1001 被引用。\n' },
  { path: '宠物/升星.md', title: '宠物升星', docId: 'pet', body: '# 宠物\n## 升星消耗\n宠物升星消耗星尘。\n' },
];
function publish(id = 'r1') { return writeSearchRelease(root, id, docs); }
async function call(name: string, args: Record<string, unknown> = {}, cap = 20000) {
  const response = await client.callTool({ name, arguments: args });
  expect(response).not.toHaveProperty('structuredContent');
  const content = response.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1); expect(content[0].type).toBe('text'); expect(content[0].text.length).toBeLessThanOrEqual(cap);
  return { response, text: content[0].text };
}
async function json(name: string, args: Record<string, unknown> = {}, cap = 20000) { const value = await call(name, args, cap); return { ...value, data: JSON.parse(value.text) }; }
async function error(name: string, args: Record<string, unknown>, code: string) { const value = await json(name, args); expect(value.response.isError).toBe(true); expect(value.data.error.code).toBe(code); return value.data.error; }

describe('seven read-only MCP tools', () => {
  it('advertises exact tools, annotations, standalone instructions and compact descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_knowledge', 'get_knowledge_bundle', 'get_outline', 'get_release_info', 'grep_knowledge', 'list_knowledge', 'search_knowledge']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
      for (const keyword of ['oneOf', 'anyOf', 'allOf']) expect(tool.inputSchema).not.toHaveProperty(keyword);
    }
    expect(client.getInstructions()).toBe(KB_MCP_INSTRUCTIONS);
    expect(KB_MCP_INSTRUCTIONS.split('\n')[0]).toContain('只读');
    expect(tools.map((t) => t.description).join('').length + KB_MCP_INSTRUCTIONS.length).toBeLessThan(2500);
  });
  it('reports no published release for all seven valid invocations', async () => {
    for (const [name, args] of [['search_knowledge', { query: '暴击' }], ['grep_knowledge', { pattern: '1001' }], ['get_outline', { pathPrefix: '' }],
      ['get_knowledge', { path: 'a.md' }], ['get_knowledge_bundle', { pathPrefix: '' }], ['list_knowledge', {}], ['get_release_info', {}]] as Array<[string, Record<string, unknown>]>) {
      await error(name, args, 'kb_not_published');
    }
  });
  it('searches multiple terms, IDs and quoted phrases with additive legacy fields and line anchors', async () => {
    publish();
    const multi = await json('search_knowledge', { query: '暴击 结算顺序', pathPrefix: '战斗', tags: ['战斗'] }, 8000);
    expect(multi.data.ranker).toBe('lex-v1'); expect(multi.data.results).toHaveLength(1);
    expect(multi.data.results[0]).toMatchObject({ docId: 'damage', path: '战斗/伤害.md', title: '伤害结算', summary: '暴击与结算顺序' });
    expect(multi.data.results[0].hits[0]).toHaveProperty('anchor');
    const phrase = await json('search_knowledge', { query: '"宠物升星" 消耗', limit: 1 }); expect(phrase.data.results[0].docId).toBe('pet');
    const id = await json('search_knowledge', { query: 'skill_id 1001' }); expect(id.data.results[0].docId).toBe('damage');
    const empty = await json('search_knowledge', { query: '绝对不存在的内容' }); expect(empty.data.results).toEqual([]); expect(empty.data).toHaveProperty('hint');
  });
  it('reads sections/anchors, exact line coordinates, source metadata and escapes closing frames', async () => {
    publish();
    const section = await call('get_knowledge', { path: '战斗/伤害.md#暴击 › 技能表' });
    expect(section.text).toContain('lines="5-8/'); expect(section.text).toContain('     6\t| skill_id'); expect(section.text).not.toContain('扣血前'); expect(section.text).toContain('sources: fixture');
    const rest = await call('get_knowledge', { docId: 'damage', startLine: 16, includeSources: false });
    expect(rest.text).toContain('<\\/kb_doc>'); expect(rest.text.match(/<\/kb_doc>/g)).toHaveLength(1); expect(rest.text).not.toContain('sources:');
    const part = await call('get_knowledge', { docId: 'damage', section: '暴击', maxLines: 2 }); expect(part.text).toContain('next: startLine=3');
  });
  it('shows outline/tree and keeps legacy prefix as a path-segment alias', async () => {
    publish();
    const outline = await call('get_outline', { docId: 'damage' }, 8000); expect(outline.text).toContain('暴击 › 技能表'); expect(outline.text).toContain('tables:1');
    const shallow = await call('get_outline', { pathPrefix: '战斗', depth: 2 }); expect(shallow.text).not.toContain('###');
    const list = await call('list_knowledge', { prefix: '战斗/' }, 8000); expect(list.text).toContain('伤害.md'); expect(list.text).not.toContain('战斗系统');
    await error('list_knowledge', { prefix: '战斗', pathPrefix: '宠物' }, 'invalid_request');
  });
  it('greps every occurrence across budget pages and supplies table headers', async () => {
    publish();
    const first = await json('grep_knowledge', { pattern: '1001', maxMatches: 1 }, 12000);
    expect(first.data.totalMatches).toBe(2); expect(first.data.totalFiles).toBe(2); expect(first.data.complete).toBe(true);
    expect(first.data.next).toBeTypeOf('string');
    const next = await json('grep_knowledge', { pattern: '1001', maxMatches: 1, cursor: first.data.next });
    expect(next.data.next).toBeNull();
    const all = [...first.data.files, ...next.data.files].flatMap((f: { matches: unknown[] }) => f.matches);
    expect(all).toHaveLength(2); expect(all.some((m: unknown) => typeof m === 'object' && m !== null && 'tableHeader' in m)).toBe(true);
    await error('grep_knowledge', { pattern: '(a+)+$', mode: 'regex' }, 'invalid_request');
    const regex = await json('grep_knowledge', { pattern: 'skill_[a-z]+', mode: 'regex' }); expect(regex.data.totalMatches).toBe(1);
  });
  it('bundles dry-run/full content with deterministic line-aligned pagination and bounded output', async () => {
    const body = '# 长文\n## 规则\n' + Array.from({ length: 120 }, (_, i) => `第${i}行完整说明。` + '资料'.repeat(45)).join('\n');
    writeSearchRelease(root, 'long', [{ path: '系统/长文.md', body, title: '长文' }]);
    const dry = await call('get_knowledge_bundle', { pathPrefix: '系统', dryRun: true, maxChars: 2000 }, 2000); expect(dry.text).toContain('docs=1'); expect(dry.text).not.toContain('<kb_doc');
    let cursor: string | undefined, pages = 0, combined = '';
    do {
      const page = await call('get_knowledge_bundle', { pathPrefix: '系统', maxChars: 2000, ...(cursor ? { cursor } : {}) }, 2000);
      combined += page.text; cursor = /next: ([A-Za-z0-9_-]+)/.exec(page.text)?.[1];
      expect(page.text).toContain('</kb_doc>'); expect(++pages).toBeLessThan(30);
    } while (cursor);
    expect(pages).toBeGreaterThan(1); expect(combined).toContain('第119行完整说明');
    await error('get_knowledge_bundle', { pathPrefix: '系统', paths: ['系统/长文.md'] }, 'invalid_request');
  });
  it('pins cursor to its original release and rejects changed parameters', async () => {
    publish();
    const first = await json('search_knowledge', { query: '1001', limit: 1 }); expect(first.data.next).toBeTypeOf('string');
    publish('r2');
    const anchored = await json('search_knowledge', { query: '1001', limit: 1, cursor: first.data.next }); expect(anchored.data.releaseId).toBe('r1');
    await error('search_knowledge', { query: '暴击', limit: 1, cursor: first.data.next }, 'invalid_cursor');
    await error('search_knowledge', { query: '1001', limit: 1, cursor: first.data.next, releaseId: 'r2' }, 'invalid_cursor');
    await error('list_knowledge', { cursor: 'not-a-valid-cursor' }, 'invalid_cursor');
  });
  it('follows CURRENT, sends one notice, supports explicit release and refuses cleaned cached versions', async () => {
    publish(); await json('get_release_info'); publish('r2');
    const changed = await json('get_release_info'); expect(changed.data.notice).toContain('r1 → r2');
    expect((await json('get_release_info')).data).not.toHaveProperty('notice');
    expect((await json('get_release_info', { releaseId: 'r1' })).data.releaseId).toBe('r1');
    fs.rmSync(path.join(root, 'releases/r1'), { recursive: true });
    const unavailable = await error('get_release_info', { releaseId: 'r1' }, 'kb_release_unavailable'); expect(unavailable.currentReleaseId).toBe('r2');
  });
  it('surfaces integrity, section and request errors without serving damaged content', async () => {
    publish();
    fs.appendFileSync(path.join(root, 'releases/r1/docs/宠物/升星.md'), 'tampered');
    // Reconnect so the initial immutable index is guaranteed to observe the damaged fixture.
    await client.close(); client = new Client({ name: 'integrity-client', version: '2' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, '--kb-root', root], env: { ...process.env, FEISHU_SYNC_HOME: root } as Record<string, string> }));
    const info = await json('get_release_info', { includeChanges: true }); expect(info.data.integrity.mismatched).toContain('宠物/升星.md'); expect(info.data.changes).toBeNull();
    await error('get_knowledge', { docId: 'pet' }, 'kb_integrity_error');
    await error('get_knowledge', { path: 'absent.md' }, 'kb_not_found');
    await error('get_knowledge', { docId: 'damage', section: '不存在' }, 'kb_section_not_found');
    const ambiguous = await error('get_knowledge', { docId: 'damage', section: '通用' }, 'kb_section_ambiguous'); expect(ambiguous.candidates).toHaveLength(2);
    await error('get_knowledge', { path: '战斗/伤害.md', docId: 'damage' }, 'invalid_request');
    await error('get_outline', {}, 'invalid_request');
    await error('get_knowledge', {}, 'invalid_request');
    await error('get_knowledge_bundle', {}, 'invalid_request');
    await error('search_knowledge', { query: 'a'.repeat(201) }, 'invalid_request');
    await error('search_knowledge', { query: '暴击', limit: 31 }, 'invalid_request');
    await error('search_knowledge', { query: '暴击', unexpected: true }, 'invalid_request');
    await error('get_release_info', { releaseId: '../escape' }, 'invalid_request');
  });

  it('uses a Chinese byte-safe page budget for pi sessions and preserves every line through next', async () => {
    const body = '# 长文\n## 规则\n' + Array.from({ length: 90 }, (_, i) => `第${i}行` + '知识资料'.repeat(45)).join('\n');
    writeSearchRelease(root, 'pi_long', [{ path: '长文.md', docId: 'long', body }]);
    await client.close(); client = new Client({ name: 'pi', version: '1.4.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, '--kb-root', root], env: { ...process.env, FEISHU_SYNC_HOME: root } as Record<string, string> }));
    let startLine = 1, pages = 0;
    const restored: string[] = [];
    for (;;) {
      const page = await call('get_knowledge', { docId: 'long', startLine, maxLines: 2000, releaseId: 'pi_long' }, 6000);
      expect(Buffer.byteLength(page.text, 'utf8')).toBeLessThan(20000);
      for (const line of page.text.split('\n')) { const match = /^\s*\d+\t(.*)$/.exec(line); if (match) restored.push(match[1]); }
      const next = /next: startLine=(\d+)/.exec(page.text);
      expect(++pages).toBeLessThan(20);
      if (!next) break;
      expect(Number(next[1])).toBeGreaterThan(startLine); startLine = Number(next[1]);
    }
    expect(pages).toBeGreaterThan(1); expect(restored.join('\n')).toBe(body);
  });
});
