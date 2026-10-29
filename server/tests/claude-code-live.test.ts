import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'node:net';
import { ClaudeCodeProcess } from '../src/agent/claude-code-process.js';
import { resolveClaudeCodePath } from '../src/agent/claude-runtime.js';
import { parseSessionJsonl } from '../src/agent/session-service.js';
import { SessionService } from '../src/agent/session-service.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { AppPluginStore } from '../src/agent/app-plugin-store.js';
import { TaskService } from '../src/agent/tasks/task-service.js';
import { RoleRegistry } from '../src/agent/tasks/role-registry.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { ApprovalService } from '../src/agent/approvals/approval-service.js';
import { createOpsToolFamily } from '../src/agent/tools/app-command-family.js';
import type { BuildRunState } from '../src/agent/agent-tool-service.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { buildDefaultAgentConfig, buildDefaultStandardKbConfig } from '../src/types/agent-knowledge.js';
import { agentInternalRoutes } from '../src/routes/agent-internal.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Config } from '../src/types/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fixture-'));
const exe = resolveClaudeCodePath();
const key = 'fixture-secret-not-real';
let server: http.Server;
let port = 0;
const requests: any[] = [];
let toolCalls = 0;
let fixtureTool = 'kb_search';
let fixtureArgs: Record<string, unknown> = { query: 'fixture' };
let fixtureText = 'FIXTURE_OK';

function event(type: string, value: object): string { return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`; }
function response(isTool: boolean): string {
  const message = { id: `msg_${Math.random().toString(16).slice(2)}`, type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
  const block = isTool ? { type: 'tool_use', id: 'toolu_01fixture', name: `mcp__feishu_sync__${fixtureTool}`, input: {} } : { type: 'text', text: '' };
  const delta = isTool ? { type: 'input_json_delta', partial_json: JSON.stringify(fixtureArgs) } : { type: 'text_delta', text: fixtureText };
  return event('message_start', { type: 'message_start', message })
    + event('content_block_start', { type: 'content_block_start', index: 0, content_block: block })
    + event('content_block_delta', { type: 'content_block_delta', index: 0, delta })
    + event('content_block_stop', { type: 'content_block_stop', index: 0 })
    + event('message_delta', { type: 'message_delta', delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    + event('message_stop', { type: 'message_stop' });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : null;
      if (req.url === '/api/agent-internal/tools') {
        if (req.headers['x-agent-run-token'] !== 'test-run-token') { res.writeHead(401); res.end('{}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ name: 'kb_search', description: 'search test', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }]));
      } else if (req.url === '/api/agent-internal/tools/kb_search') {
        if (req.headers['x-agent-run-token'] !== 'test-run-token') { res.writeHead(401); res.end('{}'); return; }
        toolCalls++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'found fixture' }] }));
      } else if (String(req.url).includes('/v1/messages')) {
        requests.push({ body, headers: req.headers });
        const hasToolResult = JSON.stringify(body.messages).includes('tool_result');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(response(!hasToolResult));
      } else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; resolve(); }));
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });

describe('Claude Code with an app-configured Anthropic provider', () => {
  it('upgrades existing session records to the Pi backend without changing their history path', () => {
    const dbPath = path.join(root, 'legacy.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL,
      workspace_id TEXT, pi_session_file TEXT, last_error_code TEXT, last_error_message TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
      INSERT INTO agent_sessions (id, title, mode, pi_session_file, created_at, updated_at)
      VALUES ('legacy', 'Old session', 'discuss', 'old-history.jsonl', '2026-01-01', '2026-01-01')`);
    db.close();
    const store = new LocalMapStore(dbPath);
    try {
      store.initialize();
      expect(store.getAgentSession('legacy')).toMatchObject({ runtime_backend: 'pi', pi_session_file: 'old-history.jsonl' });
    } finally { store.close(); }
  });

  it.skipIf(!exe)('streams a response and invokes only the application MCP tool', async () => {
    const bridgePath = path.resolve('src/agent/claude-bridge.cjs');
    const process = new ClaudeCodeProcess({ executable: exe!, nodePath: processExecPath(), bridgePath, cwd: path.join(root, 'cwd'), sessionDir: path.join(root, 'sessions'), sessionId: 'test-session',
      tools: ['kb_search'], model: 'fixture-model', baseUrl: `http://127.0.0.1:${port}`, apiKey: key, agentUrl: `http://127.0.0.1:${port}`,
      runToken: 'test-run-token', parentEnv: globalThis.process.env, thinking: 'off' });
    await process.start();
    try {
      const outcome = await process.prompt('Find the fixture', { timeoutMs: 45_000 });
      expect(outcome).toMatchObject({ outcome: 'completed', lastAssistantText: 'FIXTURE_OK' });
      expect(toolCalls).toBe(1);
      expect(requests[0].body.model).toBe('fixture-model');
      expect(requests[0].headers['x-api-key']).toBe(key);
      expect(JSON.stringify(requests[0].body.tools)).toContain('mcp__feishu_sync__kb_search');
      expect(JSON.stringify(requests[0].body.tools)).not.toContain('Bash');
      expect(JSON.stringify(requests[0].body)).not.toContain(key);
      expect(JSON.stringify(requests[0].body)).not.toContain('test-run-token');
      const state = await process.sendCommand<{ sessionFile: string }>('get_state');
      expect(parseSessionJsonl(fs.readFileSync(state.data!.sessionFile, 'utf8')).some((m) => m.text === 'FIXTURE_OK')).toBe(true);
    } finally { await process.terminate(); }
    const resumed = new ClaudeCodeProcess({ executable: exe!, nodePath: processExecPath(), bridgePath, cwd: path.join(root, 'cwd'), sessionDir: path.join(root, 'sessions'), sessionId: 'test-session',
      tools: ['kb_search'], model: 'fixture-model', baseUrl: `http://127.0.0.1:${port}`, apiKey: key, agentUrl: `http://127.0.0.1:${port}`,
      runToken: 'test-run-token', parentEnv: globalThis.process.env, thinking: 'off' });
    await resumed.start();
    try {
      const result = await resumed.prompt('Follow-up question', { timeoutMs: 45_000 });
      expect(result.outcome).toBe('completed');
      expect(JSON.stringify(requests.at(-1)?.body.messages)).toContain('Find the fixture');
      const history = await resumed.sendCommand<{ sessionFile: string }>('get_state');
      const messages = parseSessionJsonl(fs.readFileSync(history.data!.sessionFile, 'utf8'));
      expect(messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual(['Find the fixture', 'Follow-up question']);
    } finally { await resumed.terminate(); }
  }, 60_000);

  it.skipIf(!exe)('binds a session to Claude Code and revokes its tool token after each run', async () => {
    fixtureTool = 'raw_search';
    const dataRoot = path.join(root, 'session-test'); fs.mkdirSync(dataRoot, { recursive: true });
    const store = new LocalMapStore(path.join(dataRoot, 'state.db')); store.initialize();
    const toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    const tokens = new Set<string>();
    const toolApp = new Hono();
    toolApp.use('*', async (c, next) => { const token = c.req.header('x-agent-run-token'); if (token) tokens.add(token); await next(); });
    toolApp.route('/', agentInternalRoutes(toolService));
    const internalServer = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: toolApp.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
    });
    const internalPort = (internalServer.address() as AddressInfo).port;
    const agent = buildDefaultAgentConfig(dataRoot);
    agent.runtime = { backend: 'claude-code', nodePath: processExecPath(), claudeCliPath: exe! };
    agent.model = { ...agent.model, source: 'app-llm', providerId: 'fixture', modelId: 'model' };
    const config = { agent, standardKb: buildDefaultStandardKbConfig(dataRoot), knowledgeBaseRoot: dataRoot,
      llm: { activeProviderId: 'fixture', activeModelId: 'model', providers: [{ id: 'fixture', name: 'fixture', enabled: true,
        apiKey: key, openAiCompatBaseUrl: `http://127.0.0.1:${port}`, protocol: 'anthropic-messages', defaultModelId: 'model',
        models: [{ id: 'model', name: 'fixture', openAiModel: 'fixture-model', enabled: true }] }] } } as Config;
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const resolver = new PiRuntimeResolver();
    const pluginStore = new AppPluginStore(dataRoot, () => ({ buildRules: 'BUILD_FIXTURE', styleGuide: 'STYLE_FIXTURE' }), () => { throw new Error('Pi resources must not load'); });
    const service = new SessionService({ dataRoot, pool, toolService, resolver, configProvider: () => config,
      internalBaseUrl: () => `http://127.0.0.1:${internalPort}`, extensionPath: () => null, pluginStore,
      workspaceGuards: () => ({ knowledgeBaseRoot: dataRoot, outputRoot: config.standardKb.outputRoot, dataRoot }) });
    try {
      const session = service.create(store, { title: 'Claude fixture' });
      expect(session.backend).toBe('claude-code');
      const ready = await resolver.checkReadiness({ agentConfig: config.agent, llmConfig: config.llm, runningProcesses: 0 });
      expect(ready).toMatchObject({ code: 'ready', runtime: { backend: 'claude-code' }, model: { model: 'fixture-model' } });
      const incompatible = structuredClone(config);
      incompatible.llm.providers![0].protocol = 'openai-completions';
      const rejected = await resolver.checkReadiness({ agentConfig: incompatible.agent, llmConfig: incompatible.llm, runningProcesses: 0 });
      expect(rejected.code).toBe('claude_protocol_unsupported');
      const dual = structuredClone(config);
      dual.llm.providers![0].protocol = 'openai-completions';
      dual.llm.providers![0].openAiCompatBaseUrl = 'https://example.invalid/v1';
      dual.llm.providers![0].protocolBaseUrls = { 'anthropic-messages': `http://127.0.0.1:${port}` };
      expect((await resolver.checkReadiness({ agentConfig: dual.agent, llmConfig: dual.llm, runningProcesses: 0 })).code).toBe('ready');
      const piSource = structuredClone(config);
      piSource.agent.model.source = 'pi-agent-dir';
      expect((await resolver.checkReadiness({ agentConfig: piSource.agent, llmConfig: piSource.llm, runningProcesses: 0 })).code).toBe('ready');
      piSource.llm.providers![0].protocol = 'openai-completions';
      expect((await resolver.checkReadiness({ agentConfig: piSource.agent, llmConfig: piSource.llm, runningProcesses: 0 })).code).toBe('claude_protocol_unsupported');
      config.llm.providers![0] = dual.llm.providers![0];
      const accepted = await service.sendMessage(store, session.id, { text: 'Find the fixture' });
      const deadline = Date.now() + 30_000;
      while (service.isRunning(session.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
      const events = service.sseSince(session.id, null).events;
      expect(events.some((event) => event.event === 'run_end' && (event.data as any).outcome === 'completed')).toBe(true);
      expect(events.some((event) => event.event === 'tool' && (event.data as any).toolName === 'raw_search' && (event.data as any).callId)).toBe(true);
      expect(accepted.accepted).toBe(true);
      expect(service.messages(store, session.id).some((message) => message.text === 'FIXTURE_OK')).toBe(true);
      expect(service.messages(store, session.id).some((message) => message.role === 'tool' && message.tool?.name === 'raw_search')).toBe(true);
      expect(pool.runningCount()).toBe(0);
      expect(tokens.size).toBeGreaterThan(0);
      expect([...tokens].every((token) => toolService.getContext(token) === null)).toBe(true);
      expect(JSON.stringify(requests.at(-1)?.body.system)).toContain('知识库设计讨论助手');
      config.agent.runtime.backend = 'pi';
      expect(service.configForSession(store, session.id).agent.runtime.backend).toBe('claude-code');

      // A task follows its parent session's backend even after the global default changes.
      fixtureText = 'FIXTURE_OK\n<!--FS:DONE-->';
      const tasks = new TaskService({ dataRoot, pool, toolService, roles: new RoleRegistry(), resolver,
        configProvider: () => config, sessionConfig: (id) => service.configForSession(store, id),
        sessionInfo: (id) => id === session.id ? { id, mode: 'discuss', workspaceId: null, workspacePath: null } : null,
        internalBaseUrl: () => `http://127.0.0.1:${internalPort}`, emitTaskUpdate: () => undefined,
        extensionPath: () => null, orchestrationEnabled: () => true,
        pluginRevision: (scope, backend) => pluginStore.snapshot(scope, { includeNative: backend !== 'claude-code' }).revision,
        frozenSnapshot: (scope, revision, backend) => pluginStore.frozenSnapshot(scope, revision, { includeNative: backend !== 'claude-code' }) });
      const task = tasks.submit(store, { sessionId: session.id, role: 'kb-analyst', title: 'Fixture', task: 'Find the fixture' });
      await tasks.whenSettled(task.id);
      expect(String(store.getAgentTask(task.id)?.status)).toBe('done');
      expect([...tokens].every((token) => toolService.getContext(token) === null)).toBe(true);
      expect(JSON.stringify(requests.at(-1)?.body.tools)).not.toContain('app_command');

      // Both standard build process paths use the same bridge and release their run tokens.
      fixtureTool = 'raw_list'; fixtureArgs = {}; fixtureText = 'FIXTURE_OK';
      config.agent.runtime.backend = 'claude-code';
      const builds = new KbBuildService({ dataRoot, pool, toolService, resolver, configProvider: () => config,
        documentsProvider: () => [], sheetCsvPaths: () => [], internalBaseUrl: () => `http://127.0.0.1:${internalPort}`,
        extensionPath: () => null, promptAssets: () => ({ buildRules: 'BUILD_FIXTURE', styleGuide: 'STYLE_FIXTURE' }), pluginStore });
      const state = { knowledgeBaseRoot: dataRoot, snapshot: { entries: [] }, mode: 'full', workset: new Map(), stagingRoot: dataRoot, finishInfo: null } as unknown as BuildRunState;
      const internal = builds as unknown as {
        spawnBuildProcess: (id: string, state: BuildRunState, snapshot: ReturnType<AppPluginStore['snapshot']>) => Promise<PiRpcProcess>;
        spawnWorkerProcess: (input: Record<string, unknown>) => Promise<void>;
      };
      const snapshot = pluginStore.snapshot('build', { includeNative: false });
      const build = await internal.spawnBuildProcess('fixture-build', state, snapshot);
      expect((await build.prompt('List sources', { timeoutMs: 30_000 })).outcome).toBe('completed');
      expect(JSON.stringify(requests.at(-1)?.body.system)).toContain('BUILD_FIXTURE');
      await pool.terminate('build:fixture-build');
      const worker: { workerId: string; poolKey: string; unitId: string | null; rpc: PiRpcProcess | null } = { workerId: 'w1', poolKey: 'build:fixture-worker', unitId: 'u1', rpc: null };
      const slot = await pool.acquire('background');
      await internal.spawnWorkerProcess({ buildId: 'fixture-build', entry: {}, buildState: state, worker, pluginSnapshot: snapshot, slot });
      expect((await worker.rpc!.prompt('List sources', { timeoutMs: 30_000 })).outcome).toBe('completed');
      await pool.terminate(worker.poolKey);
      expect([...tokens].every((token) => toolService.getContext(token) === null)).toBe(true);

      // Work mutations still require the application's approval tied to this run.
      const approvals = new ApprovalService({ dataRoot, timeoutMs: 10_000, emit: (id, event, data) => service.emitSse(id, event, data) });
      let buildHits = 0;
      const opsApp = new Hono();
      opsApp.post('/api/kb/builds', async (c) => { buildHits++; return c.json({ accepted: await c.req.json() }, 201); });
      toolService.registerToolFamily(createOpsToolFamily({ approvals, getApp: () => opsApp, desktopToken: 'fixture',
        configProvider: () => config, sessionRunState: (id) => service.runState(id),
        toolCallRun: (id, callId) => service.runOfToolCall(id, callId), currentRunId: (id) => service.currentRunId(id),
        sessionAbortSignal: (id) => service.abortSignal(id) }));
      try {
        const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
        config.agent.workspaces = [{ id: 'ws_fixture', name: 'Fixture', path: workspace, createdAt: new Date().toISOString() }];
        const workSession = service.create(store, { title: 'Work fixture' });
        await service.switchMode(store, workSession.id, { mode: 'work', workspaceId: 'ws_fixture', confirm: 'WORK' });
        fixtureTool = 'app_command'; fixtureArgs = { command: 'kb.build', args: { mode: 'full' } };
        await service.sendMessage(store, workSession.id, { text: 'Build the test library' });
        const untilApproval = Date.now() + 20_000;
        while (!approvals.listPending(workSession.id).length && service.isRunning(workSession.id) && Date.now() < untilApproval) await new Promise((resolve) => setTimeout(resolve, 30));
        const [approval] = approvals.listPending(workSession.id);
        expect(approval?.command).toBe('kb.build');
        expect(buildHits).toBe(0);
        approvals.decide(workSession.id, approval.id, 'approve');
        const untilDone = Date.now() + 20_000;
        while (service.isRunning(workSession.id) && Date.now() < untilDone) await new Promise((resolve) => setTimeout(resolve, 30));
        expect(buildHits).toBe(1);
        expect(service.sseSince(workSession.id, null).events.some((event) => event.event === 'run_end' && (event.data as any).outcome === 'completed')).toBe(true);
      } finally { approvals.close(); }
    } finally {
      await pool.closeAll(); store.close(); await new Promise<void>((resolve) => internalServer.close(() => resolve()));
      fixtureTool = 'kb_search'; fixtureArgs = { query: 'fixture' }; fixtureText = 'FIXTURE_OK';
    }
  }, 60_000);
});
function processExecPath() {
  // SQLite tests can run under Electron's ABI; the tool bridge still needs
  // the external Node runtime used by the application in production.
  return process.versions.electron
    ? execFileSync(process.platform === 'win32' ? 'node.exe' : 'node', ['-p', 'process.execPath'], { encoding: 'utf8', windowsHide: true }).trim()
    : process.execPath;
}
