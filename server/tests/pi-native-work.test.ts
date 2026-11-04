import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PiRpcProcess, buildPiProcessEnv } from '../src/agent/pi-rpc-process.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { piExtensionPath } from '../src/agent/agent-assets.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-work-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('real Pi loads project context/skills/extensions/MCP and executes native tools outside cwd alongside app tools', async (ctx) => {
  const runtime = await new PiRuntimeResolver().resolveRuntime(buildDefaultAgentConfig(root));
  if (!runtime.nodePath || !runtime.piCliPath) { ctx.skip(); return; }
  const cwd = path.join(root, 'project');
  const outside = path.join(root, 'outside', 'result.txt');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.pi', 'skills', 'native-work-fixture'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'PROJECT_CONTEXT_NATIVE_WORK_FIXTURE');
  fs.writeFileSync(path.join(cwd, '.pi', 'skills', 'native-work-fixture', 'SKILL.md'), '---\nname: native-work-fixture\ndescription: Native Work fixture skill\n---\nFIXTURE_SKILL_BODY');
  fs.writeFileSync(path.join(cwd, '.pi', 'extensions', 'future-tool.js'), `export default function(pi) {
    pi.registerTool({name:'future_native_tool',label:'Fixture',description:'Fixture native extension',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'FUTURE_NATIVE_OK'}]})});
  }`);
  // Minimal MCP JSON-RPC server; no network or external credentials involved.
  const mcpFile = path.join(root, 'mcp-fixture.mjs');
  fs.writeFileSync(mcpFile, `import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line); if(m.id===undefined)return;
      let result={};
      if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
      if(m.method==='tools/list')result={tools:[{name:'echo',description:'Fixture echo',inputSchema:{type:'object',properties:{}}}]};
      if(m.method==='tools/call')result={content:[{type:'text',text:'MCP_NATIVE_OK'}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });`);
  fs.writeFileSync(path.join(cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: runtime.nodePath, args: [mcpFile], exposure: 'direct' } } }));

  const calls = [
    { name: 'write', args: { path: outside, content: 'native-initial' } },
    { name: 'read', args: { path: outside } },
    { name: 'edit', args: { path: outside, oldText: 'native-initial', newText: 'native-edited' } },
    { name: 'bash', args: { command: `cat '${outside}'`, timeout: 10 } },
    { name: 'future_native_tool', args: {} },
    { name: 'kb_search', args: { query: 'fixture' } },
    { name: 'mcp__fixture__echo', args: {} },
  ];
  const requests: any[] = [];
  let appCalls = 0;
  let requestError: unknown;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (req.url === '/api/agent-internal/tools') {
      expect(req.headers['x-agent-run-token']).toBe('fixture-token');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ name: 'kb_search', label: 'KB', description: 'Search fixture KB', parameters: { type: 'object', properties: { query: { type: 'string' } } } }]));
      return;
    }
    if (req.url === '/api/agent-internal/tools/kb_search') {
      appCalls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'APP_KB_OK' }] }));
      return;
    }
    try {
      const request = JSON.parse(body);
      requests.push(request);
      const index = requests.length - 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = index < calls.length
        ? { tool_calls: [{ index: 0, id: `native_${index}`, type: 'function', function: { name: calls[index].name, arguments: JSON.stringify(calls[index].args) } }] }
        : { content: 'NATIVE_WORK_OK' };
      const chunk = (delta: unknown, reason: string | null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      res.end(chunk({ role: 'assistant' }, null) + chunk(delta, null) + chunk({}, index < calls.length ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) { requestError = error; res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = buildPiProcessEnv({ mode: 'app-llm', parentEnv: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot }, dataRoot: root, agentUrl: url, runToken: 'fixture-token', apiKey: 'fixture-key', nativeWork: true });
  env.FEISHU_SYNC_AGENT_PROVIDER_JSON = JSON.stringify({ baseUrl: `${url}/v1`, models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 2048 }] });
  env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot!;
  const rpc = new PiRpcProcess({ nodePath: runtime.nodePath, piCliPath: runtime.piCliPath, extensionPath: piExtensionPath()!, nativeWork: true, selfTriggeredRounds: true, tools: ['kb_search'], model: 'feishu-sync-llm/fixture', thinking: 'off', cwd, env, noSession: true, promptTimeoutMs: 20000 });
  const errors: unknown[] = [];
  rpc.on('tool_execution_end', (event) => { if (event.isError) errors.push(event); });
  try {
    await rpc.start(30000);
    const outcome = await rpc.prompt('Run the fixture tools.');
    expect(requestError).toBeUndefined();
    expect(outcome).toMatchObject({ outcome: 'completed', lastAssistantText: 'NATIVE_WORK_OK' });
    expect(errors).toEqual([]);
    expect(fs.readFileSync(outside, 'utf8')).toBe('native-edited');
    expect(appCalls).toBe(1);
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash', 'future_native_tool', 'kb_search']));
    const context = JSON.stringify(requests[0].messages);
    expect(context).toContain('PROJECT_CONTEXT_NATIVE_WORK_FIXTURE');
    expect(context).toContain('native-work-fixture');
    // MCP is exposed directly or through Pi's lazy MCP discovery tool.
    expect(JSON.stringify(requests[0].tools)).toMatch(/mcp/i);
    const results = JSON.stringify(requests.at(-1).messages);
    expect(results).toContain('FUTURE_NATIVE_OK');
    expect(results).toContain('APP_KB_OK');
    expect(results).toContain('MCP_NATIVE_OK');
  } finally {
    await rpc.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60000);
