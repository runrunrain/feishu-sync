/**
 * F3-R01/R02 消费链回归：Workspace 授权与配置合并的受保护运行资源围栏
 *
 * 真实 buildServer 入口（app.fetch，desktopMode:false 无鉴权）：
 *  - R01：应用完整运行依赖树（server src/dist、根/子包 node_modules、
 *    electron/、dist-electron/）与外部 Node 安装根（resolver 真实解析的
 *    nodePath 所在目录）内的目录一律拒绝授权；
 *  - 普通独立文档目录仍可授权（可用性不被破坏）；
 *  - R02：合并后配置交叉校验——knowledgeBaseRoot / outputRoot 与已授权
 *    Workspace 冲突时 PUT /api/config 拒绝（400 config_validation_failed）
 *    且不落盘；
 *  - R02：能力使用时动态复核——配置变更后旧 run context 的 ws_write
 *    立即 403，绕过路由授权的旧上下文不得永久生效。
 * FEISHU_SYNC_HOME 由 vitest globalSetup 隔离（跨文件共享，afterAll 还原）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/index.js';
import type { AgentToolService } from '../src/agent/agent-tool-service.js';
import { serverDistRoot } from '../src/agent/agent-assets.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';
import type { Hono } from 'hono';
import { makeRuntimeInstallation } from './helpers/runtime-installation.js';
import { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { AgentProcessPool } from '../src/agent/agent-process-pool.js';

let app: Hono;
let toolService: AgentToolService;
let serverRoot: string;
let repoRoot: string;
let plainWs: string;
let conflictWs: string;
let dynamicWs: string;
let originalKnowledgeRoot: string;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const request = new Request(`http://127.0.0.1:1${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Host: '127.0.0.1', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const response = await app.fetch(request);
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

beforeAll(async () => {
  app = await buildServer({ desktopMode: false }) as unknown as Hono;
  toolService = (app as unknown as { __agentToolService: AgentToolService }).__agentToolService;
  serverRoot = path.dirname(serverDistRoot());
  repoRoot = path.dirname(serverRoot);
  plainWs = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-plain-'));
  conflictWs = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-conflict-'));
  dynamicWs = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dynamic-'));
  const configResp = await call('GET', '/api/config', undefined);
  originalKnowledgeRoot = String(configResp.json?.knowledgeBaseRoot ?? '');
});

afterAll(async () => {
  // 共享 FEISHU_SYNC_HOME：删除本文件授权的 workspace + 恢复 knowledgeBaseRoot
  const list = await call('GET', '/api/agent/workspaces', undefined).catch(() => null);
  for (const ws of list?.json?.workspaces ?? []) {
    await call('DELETE', `/api/agent/workspaces/${ws.id}`, undefined).catch(() => undefined);
  }
  if (originalKnowledgeRoot) {
    await call('PUT', '/api/config', { knowledgeBaseRoot: originalKnowledgeRoot }).catch(() => undefined);
  }
  for (const dir of [plainWs, conflictWs, dynamicWs]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('R01：受保护运行资源拒绝 Workspace 授权', () => {
  it('A→B切换后旧A进程仍存活：旧Node/pi/npm根继续拒绝授权和旧能力写入', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-runtime-switch-'));
    const a = makeRuntimeInstallation(path.join(root, 'a'));
    const b = makeRuntimeInstallation(path.join(root, 'b'));
    // 无模型/无工具的协议进程，只发首帧并等待stdin；不加载pi或认证文件。
    const cli = path.join(a.piRoot, 'dist', 'cli.js');
    fs.writeFileSync(cli, `process.stdout.write(JSON.stringify({type:'ready'})+'\\n'); process.stdin.resume();`);
    const rpc = new PiRpcProcess({ nodePath: a.nodePath, piCliPath: cli, cwd: root, env: {}, tools: [], noSession: true });
    const pool = (app as unknown as { __agentPool: AgentProcessPool }).__agentPool;
    const originalRuntime = (await call('GET', '/api/config')).json.agent.runtime;
    try {
      expect((await call('PUT', '/api/config', { agent: { runtime: { nodePath: a.nodePath } } })).status).toBe(200);
      await rpc.start();
      pool.register('old-runtime-a', rpc, 'session');
      expect((await call('POST', '/api/agent/workspaces', { name: '运行中A', path: a.piRoot })).status).toBe(400);
      expect((await call('PUT', '/api/config', { agent: { runtime: { nodePath: b.nodePath } } })).status).toBe(200);
      expect(rpc.isExited()).toBe(false);
      expect(pool.has('old-runtime-a')).toBe(true);
      for (const target of [path.dirname(a.nodePath), a.piRoot, a.npmRoot]) {
        const denied = await call('POST', '/api/agent/workspaces', { name: '仍需保护旧A', path: target });
        expect(denied.status).toBe(400);
        expect(denied.json.error).toBe('workspace_path_forbidden');
      }
      const { token } = toolService.createRunContext({
        runKind: 'work', sessionId: 'stale-a', workspaceRoot: a.piRoot,
        outputRoot: '/tmp/old-a-out-none', knowledgeBaseRoot: '/tmp/old-a-raw-none',
      });
      try {
        const write = await call('POST', '/api/agent-internal/tools/ws_write', {
          toolCallId: 'write-old-a', args: { path: 'dist/review-note.md', content: 'harmless fixture note' },
        }, { 'X-Agent-Run-Token': token });
        expect(write.status).toBe(403);
        expect(fs.existsSync(path.join(a.piRoot, 'dist', 'review-note.md'))).toBe(false);
      } finally { toolService.revokeToken(token); }
      expect(fs.existsSync(a.marker)).toBe(false);
      expect(fs.existsSync(b.marker)).toBe(false);
    } finally {
      await pool.terminate('old-runtime-a');
      await rpc.terminate();
      await call('PUT', '/api/config', { agent: { runtime: originalRuntime } });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('临时npm symlink布局（外置包=%s）：路由、反向配置及旧能力均拒绝写入', async (externalPackage) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-npm-install-'));
    const fixture = makeRuntimeInstallation(fixtureRoot);
    let npmRoot = fixture.npmRoot;
    if (externalPackage) {
      npmRoot = path.join(fixtureRoot, 'external', 'npm');
      fs.mkdirSync(path.dirname(npmRoot), { recursive: true });
      fs.renameSync(fixture.npmRoot, npmRoot);
      const entry = path.join(path.dirname(fixture.nodePath), 'npm');
      fs.unlinkSync(entry);
      fs.symlinkSync(path.join(npmRoot, 'bin', 'npm-cli.js'), entry);
    }
    const before = await call('GET', '/api/config');
    const originalRuntime = before.json.agent.runtime;
    let registeredId: string | undefined;
    try {
      // 尚未选中此安装时登记，随后把Node指向它：反向配置必须拒绝且不落盘。
      const auth = await call('POST', '/api/agent/workspaces', { name: '尚未选中的安装', path: npmRoot });
      expect(auth.status).toBe(201);
      registeredId = auth.json.id;
      const rejected = await call('PUT', '/api/config', { agent: { runtime: { nodePath: fixture.nodePath } } });
      expect(rejected.status).toBe(400);
      expect(rejected.json.error).toBe('config_validation_failed');
      expect((await call('GET', '/api/config')).json.agent.runtime).toEqual(originalRuntime);
      await call('DELETE', `/api/agent/workspaces/${registeredId}`);
      registeredId = undefined;

      const configured = await call('PUT', '/api/config', { agent: { runtime: { nodePath: fixture.nodePath } } });
      expect(configured.status).toBe(200);
      for (const target of [npmRoot, path.join(npmRoot, 'lib')]) {
        const result = await call('POST', '/api/agent/workspaces', { name: 'npm不能写', path: target });
        expect(result.status).toBe(400);
        expect(result.json.error).toBe('workspace_path_forbidden');
      }
      // 模拟配置更新前已发出的旧能力；动态guard必须使用新安装根。
      const { token } = toolService.createRunContext({
        runKind: 'work', sessionId: 's_npm_stale', workspaceRoot: npmRoot,
        outputRoot: '/tmp/npm-no-output', knowledgeBaseRoot: '/tmp/npm-no-raw',
      });
      const originalCli = fs.readFileSync(path.join(npmRoot, 'lib', 'cli.js'), 'utf8');
      const write = await call('POST', '/api/agent-internal/tools/ws_write', {
        toolCallId: 'npm-stale-write', args: { path: 'lib/cli.js', content: '// must be rejected' },
      }, { 'X-Agent-Run-Token': token });
      expect(write.status).toBe(403);
      expect(write.json.error).toBe('workspace_path_forbidden');
      expect(fs.readFileSync(path.join(npmRoot, 'lib', 'cli.js'), 'utf8')).toBe(originalCli);
      toolService.revokeToken(token);
      expect(fs.existsSync(fixture.marker)).toBe(false);
      // 独立资料的可用性在同一个配置下继续成立。
      const documents = path.join(fixtureRoot, 'documents');
      fs.mkdirSync(documents);
      const plain = await call('POST', '/api/agent/workspaces', { name: '普通资料', path: documents });
      expect(plain.status).toBe(201);
      await call('DELETE', `/api/agent/workspaces/${plain.json.id}`);
    } finally {
      if (registeredId) await call('DELETE', `/api/agent/workspaces/${registeredId}`);
      await call('PUT', '/api/config', { agent: { runtime: originalRuntime } });
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('应用运行依赖树内的目录 → 400 workspace_path_forbidden', async () => {
    const cases: Array<[string, string]> = [
      ['server/node_modules', path.join(serverRoot, 'node_modules')],
      ['server 源码树', path.join(serverRoot, 'src')],
      ['server 构建产物树', path.join(serverRoot, 'dist')],
      ['完整应用根', repoRoot],
      ['前端源码', path.join(repoRoot, 'src')],
      ['根 node_modules', path.join(repoRoot, 'node_modules')],
      ['electron 源码目录', path.join(repoRoot, 'electron')],
      ['dist-electron 构建产物', path.join(repoRoot, 'dist-electron')],
    ];
    for (const [label, dir] of cases) {
      if (!fs.existsSync(dir)) continue; // 打包环境可能缺某棵树，存在的必须拒
      const result = await call('POST', '/api/agent/workspaces', { name: `bad-${label}`, path: dir });
      expect(result.status, label).toBe(400);
      expect(result.json.error, label).toBe('workspace_path_forbidden');
    }
  });

  it('外部 Node 安装根（resolver 真实解析的 nodePath 所在目录）→ 400', async () => {
    const resolver = new PiRuntimeResolver();
    const runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(path.join(os.tmpdir(), 'ws-resolve-')));
    const nodeDir = path.dirname(runtime.nodePath ?? process.execPath);
    const result = await call('POST', '/api/agent/workspaces', { name: 'bad-node-bin', path: nodeDir });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('workspace_path_forbidden');
  });

  it('普通独立文档目录 → 201 授权成功（可用性不破坏）', async () => {
    const result = await call('POST', '/api/agent/workspaces', { name: '正常文档目录', path: plainWs });
    expect(result.status).toBe(201);
    expect(result.json.path).toBe(fs.realpathSync(plainWs));
  });
});

describe('R02：合并后配置交叉校验', () => {
  it('knowledgeBaseRoot 与已授权 Workspace 冲突 → PUT 拒绝且不落盘', async () => {
    const auth = await call('POST', '/api/agent/workspaces', { name: '冲突工作区', path: conflictWs });
    expect(auth.status).toBe(201);
    const before = await call('GET', '/api/config', undefined);
    const put = await call('PUT', '/api/config', { knowledgeBaseRoot: conflictWs });
    expect(put.status).toBe(400);
    expect(put.json.error).toBe('config_validation_failed');
    const after = await call('GET', '/api/config', undefined);
    expect(after.json.knowledgeBaseRoot).toBe(before.json.knowledgeBaseRoot);
  });

  it('standardKb.outputRoot 位于已授权 Workspace 内 → PUT 拒绝', async () => {
    const put = await call('PUT', '/api/config', {
      standardKb: { outputRoot: path.join(conflictWs, 'std-kb') },
    });
    expect(put.status).toBe(400);
    expect(put.json.error).toBe('config_validation_failed');
  });

  it('能力使用时动态复核：配置变更后旧 run context 的 ws_write → 403', async () => {
    // dynamicWs 不入 config.workspaces（直接构造 run context，模拟旧授权
    // /绕过路由的上下文）；变更前写成功。
    const { token } = toolService.createRunContext({
      runKind: 'work',
      sessionId: 's_r02_dynamic',
      workspaceRoot: dynamicWs,
      outputRoot: path.join(os.tmpdir(), 'r02-out-none'),
      knowledgeBaseRoot: path.join(os.tmpdir(), 'r02-kb-none'),
    });
    const before = await call('POST', '/api/agent-internal/tools/ws_write', {
      toolCallId: 'w1',
      args: { path: 'a.md', content: 'x' },
    }, { 'X-Agent-Run-Token': token });
    expect(before.status).toBe(200);

    // 配置变更：knowledgeBaseRoot 指向 dynamicWs（未授权 → 不触发交叉校验，
    // 模拟手工改配置文件/旧版落盘产生的冲突）
    const put = await call('PUT', '/api/config', { knowledgeBaseRoot: dynamicWs });
    expect(put.status).toBe(200);

    // 同一令牌再次写：动态复核拒绝，旧授权立即失效
    const after = await call('POST', '/api/agent-internal/tools/ws_write', {
      toolCallId: 'w2',
      args: { path: 'b.md', content: 'y' },
    }, { 'X-Agent-Run-Token': token });
    expect(after.status).toBe(403);
    expect(after.json.error).toBe('workspace_path_forbidden');
    expect(fs.existsSync(path.join(dynamicWs, 'b.md'))).toBe(false);
  });
});
