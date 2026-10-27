/**
 * Agent 内部工具 API 授权测试（设计 §12.1 内部 API 授权行）
 *
 * 用 buildServer 真实入口 + app.fetch：
 *  - 无令牌 → 401 run_token_invalid
 *  - 非 loopback Host → 401
 *  - 带 Origin → 403（浏览器不可达）
 *  - Discuss 令牌调 ws_write → 403 tool_not_allowed
 *  - Build 令牌写 staging 外 → 400/403
 *  - Work 令牌 ws_write 在绑定 Workspace 内成功、越界拒绝
 * 全程 FEISHU_SYNC_HOME 由 vitest globalSetup 隔离为临时目录。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/index.js';
import type { AgentToolService } from '../src/agent/agent-tool-service.js';
import type { Hono } from 'hono';

let workspaceRoot: string;
let kbRoot: string;
let outputRoot: string;
let stagingRoot: string;
let toolService: AgentToolService;
let app: Hono;

async function call(
  method: 'GET' | 'POST',
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
  origin = 'http://127.0.0.1:1',
): Promise<{ status: number; json: any }> {
  const request = new Request(`${origin}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Host: '127.0.0.1',
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const response = await app.fetch(request);
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

beforeAll(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-it-ws-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-it-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-it-out-'));
  fs.mkdirSync(path.join(outputRoot, 'releases'), { recursive: true });
  stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-it-stage-'));
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });

  app = await buildServer({ desktopMode: false }) as unknown as Hono;
  // buildServer 已在 auth 之前挂载内部 API（带自己的 toolService）
  toolService = (app as unknown as { __agentToolService: AgentToolService }).__agentToolService;
});

afterAll(() => {
  for (const dir of [workspaceRoot, kbRoot, outputRoot, stagingRoot]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('内部 API 三重校验', () => {
  it('无令牌 → 401 run_token_invalid', async () => {
    const result = await call('GET', '/api/agent-internal/tools', undefined);
    expect(result.status).toBe(401);
    expect(result.json.error).toBe('run_token_invalid');
  });

  it('伪造令牌 → 401', async () => {
    const result = await call('GET', '/api/agent-internal/tools', undefined, {
      'X-Agent-Run-Token': 'not-a-real-token',
    });
    expect(result.status).toBe(401);
  });

  it('非 loopback Host → 401', async () => {
    const { token } = toolService.createRunContext({
      runKind: 'discuss',
      outputRoot,
      knowledgeBaseRoot: kbRoot,
    });
    // Node fetch 保留显式 Host 头；非回环 Host 直接拒绝
    const result = await call('GET', '/api/agent-internal/tools', undefined, {
      'X-Agent-Run-Token': token,
      Host: 'evil.example.com',
    });
    expect(result.status).toBe(401);
  });

  it('带 Origin 头 → 403（浏览器不可达）', async () => {
    const { token } = toolService.createRunContext({
      runKind: 'discuss',
      outputRoot,
      knowledgeBaseRoot: kbRoot,
    });
    const result = await call('GET', '/api/agent-internal/tools', undefined, {
      'X-Agent-Run-Token': token,
      Origin: 'http://localhost:5173',
    });
    expect(result.status).toBe(403);
  });

  it('合法 discuss 令牌 → 工具规格下发（只含 4 个只读工具）', async () => {
    const { token } = toolService.createRunContext({
      runKind: 'discuss',
      outputRoot,
      knowledgeBaseRoot: kbRoot,
    });
    const result = await call('GET', '/api/agent-internal/tools', undefined, {
      'X-Agent-Run-Token': token,
    });
    expect(result.status).toBe(200);
    const names = (result.json as Array<{ name: string }>).map((spec) => spec.name).sort();
    expect(names).toEqual(['kb_read', 'kb_search', 'raw_read', 'raw_search']);
  });
});

describe('工具授权（runKind 白名单）', () => {
  it('Discuss 令牌调 ws_write → 403 tool_not_allowed', async () => {
    const { token } = toolService.createRunContext({
      runKind: 'discuss',
      outputRoot,
      knowledgeBaseRoot: kbRoot,
    });
    const result = await call('POST', '/api/agent-internal/tools/ws_write', {
      toolCallId: 't1',
      args: { path: 'x.md', content: 'hi' },
    }, { 'X-Agent-Run-Token': token });
    expect(result.status).toBe(403);
    expect(result.json.error).toBe('tool_not_allowed');
  });

  it('Discuss 令牌调 kb_search（未发布）→ 404 kb_not_published', async () => {
    const { token } = toolService.createRunContext({
      runKind: 'discuss',
      outputRoot,
      knowledgeBaseRoot: kbRoot,
    });
    const result = await call('POST', '/api/agent-internal/tools/kb_search', {
      toolCallId: 't2',
      args: { query: 'x' },
    }, { 'X-Agent-Run-Token': token });
    expect(result.status).toBe(404);
    expect(result.json.error).toBe('kb_not_published');
  });

  it('Work 令牌 ws_write 在绑定 Workspace 内成功；越界路径拒绝', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'existing.md'), '旧内容');
    const { token } = toolService.createRunContext({
      runKind: 'work',
      sessionId: 's_it1',
      workspaceRoot,
      outputRoot,
      knowledgeBaseRoot: kbRoot,
    });
    const ok = await call('POST', '/api/agent-internal/tools/ws_write', {
      toolCallId: 't3',
      args: { path: 'sub/新文件.md', content: '工作内容' },
    }, { 'X-Agent-Run-Token': token });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(path.join(workspaceRoot, 'sub', '新文件.md'), 'utf-8')).toBe('工作内容');

    const escape = await call('POST', '/api/agent-internal/tools/ws_write', {
      toolCallId: 't4',
      args: { path: '../../escape.md', content: '逃逸' },
    }, { 'X-Agent-Run-Token': token });
    expect(escape.status).toBe(400);
    expect(escape.json.error).toBe('path_invalid');
    expect(fs.existsSync(path.join(path.dirname(workspaceRoot), 'escape.md'))).toBe(false);

    // 审计落盘：work 写操作 → audit/<sessionId>.jsonl（不含正文）
    const auditFile = path.join(
      (toolService as unknown as { dataRoot: string }).dataRoot,
      'agent', 'audit', 's_it1.jsonl',
    );
    expect(fs.existsSync(auditFile)).toBe(true);
    const auditLine = fs.readFileSync(auditFile, 'utf-8');
    expect(auditLine).toContain('"tool":"ws_write"');
    expect(auditLine).toContain('"path":"sub/新文件.md"');
    expect(auditLine).not.toContain('工作内容'); // 正文不进审计
  });

  it('Build 令牌 kb_write_doc 写 staging 内成功；非法 source 拒绝', async () => {
    const RawSourceSnapshotModule = await import('../src/kb/raw-source-snapshot.js');
    const rawFile = path.join(kbRoot, '原始.md');
    fs.writeFileSync(rawFile, '# 原始\n内容');
    const snapshot = RawSourceSnapshotModule.RawSourceSnapshot.fromEntries(
      [{
        objToken: 'tokIT', objType: 'docx', title: '原始', relPath: '原始.md',
        contentHash: RawSourceSnapshotModule.computeSourceHash(rawFile, []),
        objEditTime: null,
      }],
      { knowledgeBaseRoot: kbRoot },
    );
    const { token } = toolService.createRunContext({
      runKind: 'build',
      buildId: 'b_it1',
      outputRoot,
      knowledgeBaseRoot: kbRoot,
      buildState: {
        knowledgeBaseRoot: kbRoot,
        snapshot,
        workset: new Map([['tokIT', 'added']]),
        stagingRoot,
        finishInfo: null,
      },
    });
    const ok = await call('POST', '/api/agent-internal/tools/kb_write_doc', {
      toolCallId: 't5',
      args: {
        path: '分类/标准.md',
        title: '标准',
        markdown: '正文内容',
        sources: ['tokIT'],
        summary: '摘要',
      },
    }, { 'X-Agent-Run-Token': token });
    expect(ok.status).toBe(200);
    const written = fs.readFileSync(path.join(stagingRoot, 'docs', '分类', '标准.md'), 'utf-8');
    expect(written).toContain('feishu_sync_kb:');
    expect(written).toContain('doc_id: kd_');
    expect(written.startsWith('<!--')).toBe(true);

    const badSource = await call('POST', '/api/agent-internal/tools/kb_write_doc', {
      toolCallId: 't6',
      args: {
        path: '坏.md', title: '坏', markdown: 'x',
        sources: ['tok-not-in-snapshot'], summary: 'x',
      },
    }, { 'X-Agent-Run-Token': token });
    expect(badSource.status).toBe(400);
    expect(badSource.json.error).toBe('invalid_request');
  });

  it('模式切换撤销旧令牌：revokeBySession 后 401', async () => {
    const { token } = toolService.createRunContext({
      runKind: 'work',
      sessionId: 's_it2',
      workspaceRoot,
      outputRoot,
      knowledgeBaseRoot: kbRoot,
    });
    const before = await call('GET', '/api/agent-internal/tools', undefined, {
      'X-Agent-Run-Token': token,
    });
    expect(before.status).toBe(200);
    toolService.revokeBySession('s_it2');
    const after = await call('GET', '/api/agent-internal/tools', undefined, {
      'X-Agent-Run-Token': token,
    });
    expect(after.status).toBe(401);
  });
});
