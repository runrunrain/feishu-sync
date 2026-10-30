/** Real HTTP route + built-in tool dispatch + SDK stdio tools/call, all on synthetic immutable files. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { kbRoutes, type KbRouteDeps } from '../src/routes/kb.js';
import { KbQueryService } from '../src/kb/search/kb-query-service.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { KB_SEARCH_SPEC } from '../src/agent/tool-specs.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'dist/mcp/kb-mcp.cjs');
const electron = path.join(root, '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-consistency-')); vi.stubEnv('FEISHU_SYNC_HOME', home); vi.stubEnv('FEISHU_KB_RANKER', 'lex-v1');
  writeSearchRelease(home, 'r_same', [
    { path: '战斗/结算.md', title: '暴击结算', body: '# 暴击结算\n## 结算顺序\n暴击 伤害在结算链中判定' },
    { path: '战斗/表.md', title: '技能表', body: '# 技能表\n| ID | 名称 |\n| -- | -- |\n| 1001 | 暴击 |' },
    { path: '其他/系统.md', title: '系统', body: '# 系统\n只有结算' },
  ]);
  if (!fs.existsSync(bundle)) { const { bundleMcp } = await import('../scripts/lib/mcp-bundle.mjs'); await bundleMcp(); }
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe('P1 real reader entrances', () => {
  it('budget-sized search pages remain continuable, while the legacy UI returns the full requested top-k', async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-budget-adapters-'));
    let tool: AgentToolService | undefined;
    let token: string | undefined;
    try {
      const body = '# 规则\n## 暴击\n暴击 伤害' + '完整规则说明'.repeat(40) + '\n## 结算\n暴击 伤害' + '其他完整说明'.repeat(40);
      const manifest = writeSearchRelease(fixtureRoot, 'r_budget', Array.from({ length: 24 }, (_, i) => ({ path: `系统/${String(i).padStart(2, '0')}.md`, docId: `d${i}`, title: '暴击伤害规则', summary: '规则摘要'.repeat(30), body })));
      const facade = new KbQueryService(fixtureRoot, { prewarm: false });
      const first = await facade.search({ query: '暴击 伤害', limit: 20 });
      expect(first.results.length).toBeLessThan(20); expect(first.next).toBeTypeOf('string');
      const store = new StandardKbStore(fixtureRoot);
      const top = await store.search(manifest, '暴击 伤害', 20);
      expect(top).toHaveLength(20);
      const routes = kbRoutes({ configManager: { load: async () => ({ standardKb: { outputRoot: fixtureRoot } }) }, buildService: {}, localMapStore: {}, documentsProvider: () => [], sheetCsvPaths: () => [] } as unknown as KbRouteDeps);
      const response = await routes.request(`/api/kb/search?q=${encodeURIComponent('暴击 伤害')}&limit=20`);
      expect(response.status).toBe(200); expect((await response.json()).results).toEqual(top);
      tool = new AgentToolService({ dataRoot: fixtureRoot, documentsProvider: () => [] });
      token = tool.createRunContext({ runKind: 'discuss', outputRoot: fixtureRoot, knowledgeBaseRoot: fixtureRoot }).token;
      expect(KB_SEARCH_SPEC.parameters.properties).toHaveProperty('cursor');
      const a = JSON.parse((await tool.executeTool(token, 'kb_search', { query: '暴击 伤害', limit: 20 })).content[0].text);
      expect(a.results).toEqual(first.results); expect(a.next).toBeTypeOf('string');
      writeSearchRelease(fixtureRoot, 'r_later', [{ path: '新.md', body: '# 新库' }]);
      const b = JSON.parse((await tool.executeTool(token, 'kb_search', { query: '暴击 伤害', limit: 20, cursor: a.next })).content[0].text);
      expect(b.releaseId).toBe('r_budget');
      expect(b.results.length).toBeGreaterThan(0);
      expect(b.results.some((hit: { docId: string }) => a.results.some((prior: { docId: string }) => prior.docId === hit.docId))).toBe(false);
      expect([...a.results, ...b.results].slice(0, 20)).toEqual(top);
      await store.queryService.prewarmCurrent();
    } finally { if (token) tool?.revokeToken(token); fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
  it('artifact has no native database module or .node imports', () => {
    const built = fs.readFileSync(bundle, 'utf8');
    expect(built).not.toContain('better-sqlite3');
    expect(built).not.toMatch(/(?:require|import)\s*\(\s*['"][^'"]*\.node['"]/);
  });
  for (const runtime of ['node', 'electron-node20'] as const) {
    it.skipIf(runtime === 'electron-node20' && !fs.existsSync(electron))(`${runtime}: UI, built-in kb_search, SDK search_knowledge return identical ranked fields and body coordinates`, async () => {
      fs.writeFileSync(path.join(home, 'CURRENT.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'r_same', publishedAt: '2026-10-29T00:00:00Z' }));
      const tool = new AgentToolService({ dataRoot: home, documentsProvider: () => [] });
      const token = tool.createRunContext({ runKind: 'discuss', outputRoot: home, knowledgeBaseRoot: home }).token;
      // Only unused build/DB dependencies are test doubles. The real search route/store/service and file I/O run unchanged.
      const routes = kbRoutes({ configManager: { load: async () => ({ standardKb: { outputRoot: home } }) }, buildService: {}, localMapStore: {}, documentsProvider: () => [], sheetCsvPaths: () => [] } as unknown as KbRouteDeps);
      const transport = new StdioClientTransport({ command: runtime === 'node' ? process.execPath : electron, args: [bundle, '--kb-root', home],
        env: { FEISHU_SYNC_HOME: home, FEISHU_KB_RANKER: 'lex-v1', ...(runtime === 'electron-node20' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stderr: 'pipe' });
      const client = new Client({ name: 'p1-integration', version: '1' }, { capabilities: {} });
      try {
        await client.connect(transport);
        for (const query of ['暴击 结算', '1001', '暴击伤害结算']) {
          const response = await routes.request(`/api/kb/search?q=${encodeURIComponent(query)}&limit=20`); expect(response.status).toBe(200);
          const ui = await response.json();
          const builtin = JSON.parse((await tool.executeTool(token, 'kb_search', { query, limit: 20 })).content[0].text);
          const called = await client.callTool({ name: 'search_knowledge', arguments: { query, limit: 20 } }); expect(called.isError).not.toBe(true);
          const mcp = JSON.parse((called.content as Array<{ text: string }>)[0].text);
          const service = await new KbQueryService(home, { prewarm: false }).search({ query, limit: 20 });
          // P2 adds query/total/ranker metadata to MCP; equality covers every ranked hit field, not transport-only envelopes.
          expect(mcp.releaseId).toBe(ui.releaseId); expect(mcp.results).toEqual(ui.results);
          expect(builtin.releaseId).toBe(ui.releaseId); expect(builtin.results).toEqual(ui.results);
          expect(ui).toEqual({ releaseId: service.releaseId, results: service.results });
          if (query === '1001') { expect(ui.results[0].hits[0].line).toBe(4); expect(ui.results[0].hits[0].snippet).toContain('表头:'); }
        }
        // Warm cache must not survive release cleanup, and CURRENT switching is observable at all real entrances.
        writeSearchRelease(home, 'r_new', [{ path: '新.md', body: '# 新版本', title: '新版本' }]);
        const changed = await client.callTool({ name: 'search_knowledge', arguments: { query: '新版本' } });
        expect(JSON.parse((changed.content as Array<{ text: string }>)[0].text).releaseId).toBe('r_new');
      } finally { tool.revokeToken(token); await client.close(); }
    });
  }
});
