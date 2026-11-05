/** Workspace selects cwd; scoped application tools retain their own guards. */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/index.js';
import type { AgentToolService } from '../src/agent/agent-tool-service.js';
import { serverDistRoot } from '../src/agent/agent-assets.js';
import type { Hono } from 'hono';

let app: Hono;
let toolService: AgentToolService;
let serverRoot: string;
let repoRoot: string;
let plainWs: string;
let conflictWs: string;
let dynamicWs: string;
let knowledgeWs: string;
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
  knowledgeWs = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-knowledge-'));
  const configResp = await call('GET', '/api/config', undefined);
  originalKnowledgeRoot = String(configResp.json?.knowledgeBaseRoot ?? '');
  await call('PUT', '/api/config', { knowledgeBaseRoot: knowledgeWs });
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
  for (const dir of [plainWs, conflictWs, dynamicWs, knowledgeWs]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Workspace 起始目录', () => {
  it('允许用户主目录、项目、运行时与知识库目录作为起始位置', async () => {
    const config = await call('GET', '/api/config');
    const dirs = [os.homedir(), repoRoot, serverRoot, plainWs, config.json.knowledgeBaseRoot].filter(Boolean);
    for (const dir of dirs) {
      const result = await call('POST', '/api/agent/workspaces', { name: '起始目录', path: dir });
      expect(result.status, dir).toBe(201);
      expect(result.json.path).toBe(fs.realpathSync(dir));
    }
  });

  it('接受目录符号链接，拒绝相对路径、文件与不存在目录', async () => {
    const link = path.join(plainWs, 'alias');
    fs.symlinkSync(conflictWs, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await call('POST', '/api/agent/workspaces', { name: '别名', path: link })).json.path).toBe(fs.realpathSync(conflictWs));
    const file = path.join(plainWs, 'file.txt');
    fs.writeFileSync(file, 'fixture');
    for (const target of ['relative/path', file, path.join(plainWs, 'missing')]) {
      const result = await call('POST', '/api/agent/workspaces', { name: '无效目录', path: target });
      expect(result.status).toBe(400);
      expect(result.json.error).toBe('workspace_path_invalid');
    }
  });

  it('Workspace 与知识库、标准库路径重叠不再阻止配置保存', async () => {
    const before = await call('GET', '/api/config');
    const auth = await call('POST', '/api/agent/workspaces', { name: '项目', path: conflictWs });
    expect(auth.status).toBe(201);
    try {
      const put = await call('PUT', '/api/config', { knowledgeBaseRoot: conflictWs, standardKb: { outputRoot: path.join(conflictWs, 'standard') } });
      expect(put.status).toBe(200);
      expect((await call('GET', '/api/config')).json.knowledgeBaseRoot).toBe(conflictWs);
    } finally {
      await call('PUT', '/api/config', { knowledgeBaseRoot: before.json.knowledgeBaseRoot, standardKb: { outputRoot: before.json.standardKb.outputRoot } });
    }
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
