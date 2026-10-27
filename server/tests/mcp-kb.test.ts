/**
 * MCP stdio 真实协议测试（设计 §12.1 MCP 行）
 *
 * 用 @modelcontextprotocol/sdk 的 StdioClientTransport 连接构建产物
 * server/dist/mcp/kb-mcp.cjs（真实外部 Node 子进程），调用四个工具：
 *  - 未发布 → kb_not_published
 *  - 发布 → search/get/list/release_info 返回真实数据
 *  - 发布切换后 → 结果随 CURRENT 指针变化
 * 隔离：--kb-root 指向临时目录，不触任何真实数据。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpScript = path.join(serverRoot, 'dist', 'mcp', 'kb-mcp.cjs');

let kbRoot: string;
let client: Client;
let transport: StdioClientTransport;

function writeRelease(releaseId: string, docs: Array<{ path: string; docId: string; title: string; sources: string[]; body: string }>): void {
  const releaseDir = path.join(kbRoot, 'releases', releaseId);
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(releaseDir, 'docs'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    releaseId,
    buildId: `b_${releaseId}`,
    mode: 'full',
    baseReleaseId: null,
    publishedAt: new Date().toISOString(),
    model: 'test/model',
    sourceSnapshot: docs.flatMap((doc) => doc.sources.map((token) => ({
      objToken: token, objType: 'docx', title: token, relPath: `${token}.md`,
      contentHash: `sha256:${token}`, objEditTime: null,
    }))),
    docs: docs.map((doc) => ({
      docId: doc.docId,
      path: doc.path,
      title: doc.title,
      summary: `${doc.title} 摘要`,
      headings: [],
      tags: [],
      sources: doc.sources,
      contentHash: 'sha256:x',
      updatedInBuild: `b_${releaseId}`,
    })),
    skippedSources: [],
  };
  for (const doc of docs) {
    const full = path.join(releaseDir, 'docs', doc.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `<!--\nfeishu_sync_kb:\n  doc_id: ${doc.docId}\n  sources:\n${doc.sources.map((s) => `    - ${s}`).join('\n')}\n  build_id: b_${releaseId}\n-->\n# ${doc.title}\n${doc.body}\n`);
  }
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(kbRoot, 'CURRENT.json'), JSON.stringify({
    schemaVersion: 1,
    releaseId,
    publishedAt: manifest.publishedAt,
  }, null, 2));
}

beforeAll(async () => {
  // CI：test 先于 build 运行；产物缺失时用与 build 相同的共享入口按需打包
  //（同一 esbuild 配置，见 scripts/lib/mcp-bundle.mjs——不产生第二份配置）。
  if (!fs.existsSync(mcpScript)) {
    const { bundleMcp } = await import('../scripts/lib/mcp-bundle.mjs');
    await bundleMcp();
  }
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mcp-it-'));
  client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpScript, '--kb-root', kbRoot],
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close().catch(() => undefined);
  fs.rmSync(kbRoot, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

describe('kb-mcp stdio 四工具', () => {
  it('列出工具：四个只读工具', async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'get_knowledge', 'get_release_info', 'list_knowledge', 'search_knowledge',
    ]);
    for (const tool of listed.tools) {
      expect((tool as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint).toBe(true);
    }
  });

  it('未发布 → search/get/list 均报 kb_not_published', async () => {
    for (const name of ['search_knowledge', 'get_knowledge', 'list_knowledge', 'get_release_info']) {
      const result = await callTool(name, name === 'search_knowledge' ? { query: 'x' } : name === 'get_knowledge' ? { docId: 'kd_x' } : {});
      expect((result as { isError?: boolean }).isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('kb_not_published');
    }
  });

  it('发布后 → 四工具返回真实数据', async () => {
    writeRelease('r_mcp1', [
      { path: '战斗/结算.md', docId: 'kd_m1', title: '战斗结算', sources: ['tokA'], body: '伤害 = 攻击 × (1 - 减伤)。' },
      { path: '经济/资源.md', docId: 'kd_m2', title: '资源产出', sources: ['tokB'], body: '金币产出按小时结算。' },
    ]);
    const info = await callTool('get_release_info', {});
    const infoText = (info.content as Array<{ text: string }>)[0].text;
    expect(infoText).toContain('r_mcp1');
    expect(infoText).toContain('"docCount": 2');

    const search = await callTool('search_knowledge', { query: '结算' });
    const searchText = (search.content as Array<{ text: string }>)[0].text;
    expect(searchText).toContain('kd_m1');
    expect(searchText).toContain('战斗结算');

    const get = await callTool('get_knowledge', { docId: 'kd_m1' });
    const getText = (get.content as Array<{ text: string }>)[0].text;
    expect(getText).toContain('# 战斗结算');
    expect(getText).toContain('tokA');

    const list = await callTool('list_knowledge', { prefix: '战斗/' });
    const listText = (list.content as Array<{ text: string }>)[0].text;
    expect(listText).toContain('kd_m1');
    expect(listText).not.toContain('kd_m2');
  });

  it('发布切换后 → 每次调用重新读 CURRENT，结果即时变化', async () => {
    writeRelease('r_mcp2', [
      { path: '新/单篇.md', docId: 'kd_n1', title: '新版唯一', sources: ['tokC'], body: '第二个发布版本。' },
    ]);
    const info = await callTool('get_release_info', {});
    const infoText = (info.content as Array<{ text: string }>)[0].text;
    expect(infoText).toContain('r_mcp2');
    // 旧文档不再可见
    const getOld = await callTool('get_knowledge', { docId: 'kd_m1' });
    expect((getOld as { isError?: boolean }).isError).toBe(true);
  });
});
