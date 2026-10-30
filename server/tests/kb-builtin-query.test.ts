/** P3 real AgentToolService capability path, with synthetic published releases only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { getToolSpec } from '../src/agent/tool-specs.js';
import { toolsForRunKind } from '../src/types/agent-knowledge.js';
import { getKbQueryService } from '../src/kb/search/kb-query-service.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
let root: string, out: string, tools: AgentToolService;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-builtin-'));
  out = path.join(root, 'published');
  writeSearchRelease(out, 'r1', [
    { path: '战斗/伤害.md', title: '伤害结算', docId: 'damage', body: '# 伤害\n## 暴击\n伤害按暴击倍率结算。\n### 技能表\n| skill_id | 倍率 |\n| --- | --- |\n| 1001 | 120% |\n## 护甲\n护甲减伤。\n' },
    { path: '战斗系统/引用.md', title: '引用', docId: 'reference', body: '# 引用\n## 说明\n1001 的引用。\n' },
  ]);
  tools = new AgentToolService({ dataRoot: root, documentsProvider: () => [] });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const create = (runKind: 'discuss' | 'work' | 'build') => tools.createRunContext({ runKind, outputRoot: out, knowledgeBaseRoot: path.join(root, 'raw') });

describe.each(['discuss', 'work'] as const)('%s read-only query tools', (runKind) => {
  it('returns the shared ranker hits and segment prefix, not a parallel search implementation', async () => {
    const { token } = create(runKind);
    const result = await tools.executeTool(token, 'kb_search', { query: '暴击 伤害', pathPrefix: '战斗', limit: 20 });
    expect(JSON.parse(result.content[0].text)).toEqual(await getKbQueryService(out).search({ query: '暴击 伤害', pathPrefix: '战斗', limit: 20, releaseId: 'r1' }));
    expect(JSON.parse(result.content[0].text).results[0].hits[0].anchor).toContain('战斗/伤害.md#');
  });
  it('reads a section with existing zero-based pagination and immutable line coordinates', async () => {
    const { token } = create(runKind);
    const result = await tools.executeTool(token, 'kb_read', { docId: 'damage', section: '暴击 › 技能表', offset: 1, limit: 1 });
    expect(result.content[0].text).toContain('     5\t| skill_id');
    expect(result.content[0].text).not.toContain('护甲减伤');
    expect(result.details).toMatchObject({ docId: 'damage', releaseId: 'r1', offset: 1, returnedLines: 1, nextOffset: 2, sources: ['fixture'] });
    const anchored = await tools.executeTool(token, 'kb_read', { path: '战斗/伤害.md#护甲' });
    expect(anchored.content[0].text).toContain('护甲减伤');
  });
  it('drains exact grep pages, exposes table headers and rejects unsafe regex', async () => {
    const { token } = create(runKind);
    const first = JSON.parse((await tools.executeTool(token, 'kb_grep', { pattern: '1001', maxMatches: 1 })).content[0].text);
    expect(first.totalMatches).toBe(2); expect(first.next).toBeTypeOf('string');
    const next = JSON.parse((await tools.executeTool(token, 'kb_grep', { pattern: '1001', maxMatches: 1, cursor: first.next })).content[0].text);
    expect(next.next).toBeNull();
    const matches = [...first.files, ...next.files].flatMap((f: { matches: unknown[] }) => f.matches);
    expect(matches).toHaveLength(2); expect(JSON.stringify(matches)).toContain('tableHeader');
    await expect(tools.executeTool(token, 'kb_grep', { pattern: '(a+)+$', mode: 'regex' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(tools.executeTool(token, 'kb_grep', { pattern: '(a|aa)+$', mode: 'regex' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(getToolSpec('kb_grep')?.parameters.properties).toHaveProperty('mode', { type: 'string', enum: ['literal'] });
  });
});
it('registers grep consistently in specs, process tools and server capability tokens, never build/task', async () => {
  expect(getToolSpec('kb_grep')?.description).toContain('只读');
  for (const kind of ['discuss', 'work'] as const) {
    expect(toolsForRunKind(kind)).toContain('kb_grep');
    expect(create(kind).context.allowedTools).toContain('kb_grep');
  }
  for (const kind of ['build', 'task', 'probe'] as const) expect(toolsForRunKind(kind)).not.toContain('kb_grep');
  const { token } = create('build');
  await expect(tools.executeTool(token, 'kb_grep', { pattern: '1001' })).rejects.toMatchObject({ code: 'tool_not_allowed' });
  await expect(tools.executeTool('wrong-token', 'kb_grep', { pattern: '1001' })).rejects.toMatchObject({ code: 'run_token_invalid' });
});
it('refuses corrupted bodies through built-in read and discloses query errors', async () => {
  fs.appendFileSync(path.join(out, 'releases/r1/docs/战斗/伤害.md'), 'tamper');
  const { token } = create('discuss');
  await expect(tools.executeTool(token, 'kb_read', { docId: 'damage' })).rejects.toMatchObject({ code: 'kb_integrity_error' });
  const hits = JSON.parse((await tools.executeTool(token, 'kb_search', { query: '暴击' })).content[0].text);
  expect(hits.results).toEqual([]);
});

it('reads exact # filenames and their anchors through the same resolver as the facade', async () => {
  writeSearchRelease(out, 'sharp', [
    { path: 'C#指南.md', docId: 'sharp', body: '# C#\n## 协议#附录\n准确的语言指南。\n' },
    { path: 'C#指南.md#扩展.md', docId: 'extension', body: '# 扩展\n## 标题\n最长文件名。\n' },
  ]);
  const { token } = create('discuss');
  for (const ref of ['C#指南.md', 'C#指南.md#协议#附录']) {
    const result = await tools.executeTool(token, 'kb_read', { path: ref });
    expect(result.details?.path).toBe('C#指南.md');
    expect(result.content[0].text).toContain('准确的语言指南');
  }
  for (const ref of ['C#指南.md#扩展.md', 'C#指南.md#扩展.md#标题']) {
    const result = await tools.executeTool(token, 'kb_read', { path: ref });
    expect(result.details?.path).toBe('C#指南.md#扩展.md');
    expect(result.content[0].text).toContain('最长文件名');
  }
});
