import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PiRpcProcess, buildPiProcessEnv } from '../src/agent/pi-rpc-process.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { PiPluginService } from '../src/agent/pi-plugin-service.js';
import { piExtensionPath } from '../src/agent/agent-assets.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-work-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('native startup flags and image settings use the selected private Pi home', async () => {
  const dir = path.join(root, 'argv'); const user = path.join(dir, 'user'); const data = path.join(dir, 'data');
  const overlay = path.join(data, 'agent/pi-home-local'); fs.mkdirSync(user, { recursive: true }); fs.mkdirSync(overlay, { recursive: true });
  fs.writeFileSync(path.join(user, 'settings.json'), '{"images":{"autoResize":true}}');
  fs.writeFileSync(path.join(overlay, 'settings.json'), '{}');
  const cli = path.join(dir, 'fake-pi.cjs');
  fs.writeFileSync(cli, `const fs=require('fs');fs.writeFileSync(process.env.ARGV_OUTPUT,JSON.stringify({argv:process.argv.slice(2),dir:process.env.PI_CODING_AGENT_DIR}));console.log(JSON.stringify({type:'ready'}));process.stdin.resume();`);
  for (const enabled of [false, true]) {
    const output = path.join(dir, `argv-${enabled}.json`);
    const env = buildPiProcessEnv({ mode: 'app-llm', parentEnv: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: user, AMAGI_SUBAGENT: '1', AMAGI_DISPATCH_MODEL: 'sentinel' }, dataRoot: data, agentUrl: '', runToken: '', nativeWork: true, preserveUploadedImages: true, ...(enabled ? { nativeWorkAgentDir: overlay } : {}) });
    expect(env.AMAGI_SUBAGENT).toBeUndefined(); expect(env.AMAGI_DISPATCH_MODEL).toBeUndefined();
    env.ARGV_OUTPUT = output;
    const rpc = new PiRpcProcess({ nodePath: process.execPath, piCliPath: cli, nativeWork: true, localResources: enabled, tools: [], cwd: dir, env, noSession: true });
    try {
      await rpc.start(); const actual = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(actual.dir).toBe(enabled ? overlay : path.join(data, 'agent/pi-home'));
      expect(actual.argv).toContain(enabled ? '--approve' : '--no-approve');
      for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes']) expect(actual.argv.includes(flag)).toBe(!enabled);
      expect(actual.argv).not.toContain('--no-mcp');
      expect(actual.argv).not.toContain('--no-context-files');
    } finally { await rpc.terminate(); }
  }
  expect(fs.readFileSync(path.join(user, 'settings.json'), 'utf8')).toBe('{"images":{"autoResize":true}}');
  expect(JSON.parse(fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8')).images.autoResize).toBe(false);
});

it('real Pi switches between private application resources and local overlay without duplicate packages', async () => {
  const resolver = new PiRuntimeResolver(); const runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(root));
  expect(runtime.nodePath).toBeTruthy(); expect(runtime.piCliPath).toBeTruthy();
  const home = path.join(root, 'closed-home'); const cwd = path.join(home, 'project'); const data = path.join(home, 'data');
  const skill = (dir: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture ${name}\n---\nfixture`);
  };
  skill(path.join(home, '.agents/skills/user-fixture'), 'user-fixture');
  skill(path.join(cwd, '.pi/skills/project-fixture'), 'project-fixture');
  skill(path.join(cwd, '.agents/skills/project-agents-fixture'), 'project-agents-fixture');
  skill(path.join(home, 'app-skill'), 'app-fixture');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'CLOSED_PROJECT_CONTEXT');
  fs.mkdirSync(path.join(cwd, '.pi/extensions'), { recursive: true });
  const ext = (name: string) => `export default pi=>pi.registerTool({name:'${name}',label:'fixture',description:'fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}]})});`;
  fs.writeFileSync(path.join(cwd, '.pi/extensions/project.js'), ext('project_fixture_tool'));
  fs.writeFileSync(path.join(cwd, '.pi/settings.json'), JSON.stringify({ extensions: ['./extensions/project.js'] }));
  const mcpFile = path.join(home, 'mcp.mjs');
  fs.writeFileSync(mcpFile, `import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'echo',description:'fixture',inputSchema:{type:'object',properties:{}}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`);
  fs.writeFileSync(path.join(cwd, '.pi/mcp.json'), JSON.stringify({ mcpServers: { forbiddenfixture: { command: runtime.nodePath, args: [mcpFile], exposure: 'direct' } } }));
  const appExtension = path.join(home, 'app-extension.mjs');
  fs.writeFileSync(appExtension, `export default pi=>{pi.registerTool({name:'app_fixture_tool',label:'fixture',description:'fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}]})});pi.registerMcpServer('appfixture',{command:${JSON.stringify(runtime.nodePath)},args:[${JSON.stringify(mcpFile)}],exposure:'direct'});}`);
  const userDir = path.join(home, '.pi/agent'); const localPkg = path.join(userDir, 'same'); const appPkg = path.join(home, 'app-package');
  for (const [dir, which] of [[localPkg, 'local'], [appPkg, 'app']] as const) {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'amagi-pi', pi: { extensions: ['./extension.mjs'] } }));
    fs.writeFileSync(path.join(dir, 'extension.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(home, `${which}-loaded`))},'yes');${ext('dedup_fixture_tool')}`);
  }
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({ packages: ['./same'] }));
  fs.writeFileSync(path.join(userDir, 'mcp.json'), JSON.stringify({ mcpServers: { localfixture: { command: runtime.nodePath, args: [mcpFile], exposure: 'direct' } } }));
  fs.mkdirSync(data, { recursive: true });
  const config = buildDefaultAgentConfig(data);
  const plugins = new PiPluginService({ dataRoot: data, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  const initial = await plugins.refresh(); await plugins.mutate('install', { expectedRevision: initial.revision, source: appPkg });
  const appSettingsPath = path.join(plugins.agentDir, 'settings.json');
  fs.writeFileSync(appSettingsPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(appSettingsPath, 'utf8')), extensions: ['-builtin:codemode'] }));
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/agent-internal/tools') { res.setHeader('Content-Type', 'application/json'); res.end('[]'); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(chunk({ role: 'assistant', content: 'OK' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = buildPiProcessEnv({ mode: 'app-llm', parentEnv: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, dataRoot: data, agentUrl: url, runToken: 'fixture', apiKey: 'fixture', nativeWork: true });
  env.FEISHU_SYNC_AGENT_PROVIDER_JSON = JSON.stringify({ baseUrl: `${url}/v1`, models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 2048 }] });
  env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot!;
  const snapshot = JSON.stringify({ schemaVersion: 1, plugins: [] }); const snapshotFile = path.join(home, 'snapshot.json'); fs.writeFileSync(snapshotFile, snapshot);
  env.FEISHU_SYNC_AGENT_PLUGIN_SNAPSHOT = snapshotFile; env.FEISHU_SYNC_AGENT_PLUGIN_REVISION = crypto.createHash('sha256').update(snapshot).digest('hex');
  const appPackageExtensions = plugins.nativeWorkPackages().packages.flatMap((pkg) => pkg.extensions);
  const builtins = await plugins.enabledWorkBuiltins();
  expect(builtins).toContain('builtin:mcp'); expect(builtins).not.toContain('builtin:codemode');
  const rpc = new PiRpcProcess({ nodePath: runtime.nodePath!, piCliPath: runtime.piCliPath!, extensionPath: piExtensionPath()!, additionalExtensionPaths: [appExtension, ...appPackageExtensions], additionalBuiltinExtensions: builtins, additionalSkillPaths: [path.join(home, 'app-skill')], nativeWork: true, localResources: false, tools: [], model: 'feishu-sync-llm/fixture', thinking: 'off', cwd, env, noSession: true });
  try {
    await rpc.start(30000); expect((await rpc.prompt('fixture')).outcome).toBe('completed');
    const messages = JSON.stringify(requests[0].messages); const tools = JSON.stringify(requests[0].tools);
    expect(messages).toContain('CLOSED_PROJECT_CONTEXT'); expect(messages).toContain('app-fixture');
    expect(messages).not.toContain('project-fixture'); expect(messages).not.toContain('project-agents-fixture'); expect(messages).not.toContain('user-fixture');
    expect(tools).toContain('app_fixture_tool'); expect(tools).toContain('appfixture'); expect(tools).not.toContain('project_fixture_tool'); expect(tools).not.toContain('forbiddenfixture');
    expect(requests[0].tools.map((tool: any) => tool.function.name)).not.toContain('codemode');
    expect(tools).toContain('dedup_fixture_tool'); expect(fs.existsSync(path.join(home, 'app-loaded'))).toBe(true);
    await rpc.terminate();
    fs.unlinkSync(path.join(home, 'app-loaded'));
    const overlay = await plugins.prepareLocalWorkHome(userDir, cwd);
    const overlaySettings = fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8');
    const openEnv = buildPiProcessEnv({ mode: 'app-llm', parentEnv: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, dataRoot: data, agentUrl: url, runToken: 'fixture', apiKey: 'fixture', nativeWork: true, nativeWorkAgentDir: overlay });
    openEnv.FEISHU_SYNC_AGENT_PROVIDER_JSON = env.FEISHU_SYNC_AGENT_PROVIDER_JSON; openEnv.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot!;
    openEnv.FEISHU_SYNC_AGENT_PLUGIN_SNAPSHOT = snapshotFile; openEnv.FEISHU_SYNC_AGENT_PLUGIN_REVISION = env.FEISHU_SYNC_AGENT_PLUGIN_REVISION;
    const open = new PiRpcProcess({ nodePath: runtime.nodePath!, piCliPath: runtime.piCliPath!, extensionPath: piExtensionPath()!, nativeWork: true, localResources: true, tools: [], model: 'feishu-sync-llm/fixture', thinking: 'off', cwd, env: openEnv, noSession: true });
    try {
      await open.start(30000); expect((await open.prompt('fixture')).outcome).toBe('completed');
      const openMessages = JSON.stringify(requests[1].messages); const openTools = JSON.stringify(requests[1].tools);
      expect(openMessages).toContain('project-fixture'); expect(openMessages).toContain('project-agents-fixture'); expect(openMessages).toContain('user-fixture');
      expect(openTools).toContain('project_fixture_tool'); expect(openTools).toContain('forbiddenfixture'); expect(openTools).toContain('localfixture');
      expect(requests[1].tools.filter((tool: any) => tool.function.name === 'dedup_fixture_tool')).toHaveLength(1);
      expect(fs.existsSync(path.join(home, 'local-loaded'))).toBe(true); expect(fs.existsSync(path.join(home, 'app-loaded'))).toBe(false);
    } finally { await open.terminate(); }
    expect(fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8')).toBe(overlaySettings);
    fs.unlinkSync(path.join(home, 'local-loaded'));
    const projectPkg = path.join(cwd, '.pi', 'project-package'); fs.mkdirSync(projectPkg);
    fs.writeFileSync(path.join(projectPkg, 'package.json'), JSON.stringify({ name: 'amagi-pi', pi: { extensions: ['./extension.mjs'] } }));
    fs.writeFileSync(path.join(projectPkg, 'extension.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(home, 'project-loaded'))},'yes');${ext('dedup_fixture_tool')}`);
    fs.writeFileSync(path.join(cwd, '.pi/settings.json'), JSON.stringify({ packages: ['./project-package'] }));
    const projectOverlay = await plugins.prepareLocalWorkHome(userDir, cwd);
    openEnv.PI_CODING_AGENT_DIR = projectOverlay;
    const projectRun = new PiRpcProcess({ nodePath: runtime.nodePath!, piCliPath: runtime.piCliPath!, extensionPath: piExtensionPath()!, nativeWork: true, localResources: true, tools: [], model: 'feishu-sync-llm/fixture', thinking: 'off', cwd, env: openEnv, noSession: true });
    try {
      await projectRun.start(30000); expect((await projectRun.prompt('fixture')).outcome).toBe('completed');
      expect(requests[2].tools.filter((tool: any) => tool.function.name === 'dedup_fixture_tool')).toHaveLength(1);
      expect(fs.existsSync(path.join(home, 'project-loaded'))).toBe(true);
      expect(fs.existsSync(path.join(home, 'local-loaded'))).toBe(false); expect(fs.existsSync(path.join(home, 'app-loaded'))).toBe(false);
    } finally { await projectRun.terminate(); }
  } finally {
    await rpc.terminate(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60000);

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
    { name: 'bash', args: { command: `cat '${outside.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`, timeout: 10 } },
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
  // Pi discovers Git Bash using ProgramFiles before PATH (which may start with WSL bash.exe).
  const env = buildPiProcessEnv({ mode: 'app-llm', parentEnv: {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot,
    ProgramFiles: process.env.ProgramFiles, 'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
  }, dataRoot: root, agentUrl: url, runToken: 'fixture-token', apiKey: 'fixture-key', nativeWork: true });
  env.FEISHU_SYNC_AGENT_PROVIDER_JSON = JSON.stringify({ baseUrl: `${url}/v1`, models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 2048 }] });
  env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot!;
  const rpc = new PiRpcProcess({ nodePath: runtime.nodePath, piCliPath: runtime.piCliPath, extensionPath: piExtensionPath()!, nativeWork: true, localResources: true, selfTriggeredRounds: true, tools: ['kb_search'], model: 'feishu-sync-llm/fixture', thinking: 'off', cwd, env, noSession: true, promptTimeoutMs: 20000 });
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
