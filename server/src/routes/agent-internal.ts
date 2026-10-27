/**
 * Agent 内部工具 API（设计 §9.6）— 仅 pi 扩展调用
 *
 * 挂载在 desktop auth 中间件**之前**，自带三重校验：
 *  1. 仅接受回环来源（Host 为 127.0.0.1 / localhost / [::1]）；
 *  2. 拒绝带 Origin 头的请求（浏览器不可达）；
 *  3. 必须带有效 X-Agent-Run-Token（timing-safe 比对）。
 *
 * server 在此处产生会话/构建 SSE 的 tool 事件摘要以外的审计记录
 * （Work 写操作审计在 AgentToolService 内落盘）。
 */

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AgentToolService } from '../agent/agent-tool-service.js';

const LOOPBACK_HOSTS = new Set([
  '127.0.0.1', 'localhost', '[::1]', '[0:0:0:0:0:0:0:1]', '127.0.0.1:*', 'localhost:*',
]);

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.split(':')[0] === '[' ? host.replace(/:\d+$/, '') : host.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(bare) || bare === '[::1]';
}

export function agentInternalRoutes(toolService: AgentToolService): Hono {
  const routes = new Hono();

  // 三重校验中间件（对 /api/agent-internal/* 全部生效）
  routes.use('/api/agent-internal/*', async (c, next) => {
    // 回环判定：优先 Host 头（真实 HTTP 总是携带；Node fetch 测试路径下
    // undici 会丢弃 Host，回退到请求 URL 的 host）。两者都非回环 → 拒绝。
    const headerHost = c.req.header('Host');
    const urlHost = (() => {
      try {
        return new URL(c.req.url).host;
      } catch {
        return undefined;
      }
    })();
    const host = headerHost || urlHost;
    if (!host || !isLoopbackHost(host)) {
      return c.json({ error: 'run_token_invalid', message: '内部 API 仅接受回环来源' }, 401);
    }
    const origin = c.req.header('Origin');
    if (origin !== undefined && origin !== '') {
      return c.json({ error: 'run_token_invalid', message: '内部 API 拒绝浏览器来源（Origin 头存在）' }, 403);
    }
    const token = c.req.header('X-Agent-Run-Token') ?? '';
    const context = token ? toolService.getContext(token) : null;
    if (!context) {
      return c.json({ error: 'run_token_invalid', message: '运行令牌无效或已过期' }, 401);
    }
    await next();
  });

  routes.get('/api/agent-internal/tools', (c) => {
    const token = c.req.header('X-Agent-Run-Token') ?? '';
    const specs = toolService.getToolSpecsForToken(token);
    if (specs === null) {
      return c.json({ error: 'run_token_invalid', message: '运行令牌无效或已过期' }, 401);
    }
    return c.json(specs);
  });

  routes.post('/api/agent-internal/tools/:name', async (c) => {
    const token = c.req.header('X-Agent-Run-Token') ?? '';
    const name = c.req.param('name');
    let body: { toolCallId?: unknown; args?: unknown };
    try {
      body = await c.req.json() as { toolCallId?: unknown; args?: unknown };
    } catch {
      return c.json({ error: 'invalid_json', message: '请求体必须是 JSON' }, 400);
    }
    const args = body.args && typeof body.args === 'object' ? body.args as Record<string, unknown> : {};
    try {
      const result = await toolService.executeTool(token, name, args);
      return c.json(result);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'tool_error';
      const status = ((error as { status?: number }).status ?? 400) as ContentfulStatusCode;
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: code, message }, status);
    }
  });

  return routes;
}
