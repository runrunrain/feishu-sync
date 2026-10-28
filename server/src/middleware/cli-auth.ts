/**
 * CLI 认证中间件（设计 kb-agent-upgrade §6.2，参考 agent-knowledge §9.6
 * 的「回环 + 无 Origin + 令牌」三重校验模式）
 *
 * 作用于 `/api/cli/*` 命令执行域，与 desktop token 认证域完全分离：
 *  1. 仅接受回环来源（Host 为 127.0.0.1 / localhost / [::1]）——阻断
 *     DNS rebinding 与跨机访问；
 *  2. 拒绝带 Origin 头的请求——浏览器页面不可达（防 CSRF/rebinding）；
 *  3. 必须携带有效 X-Cli-Token（timing-safe 比对，令牌来自
 *     `<dataRoot>/run/endpoint.json` 同源的 CliEndpoint 内存态）。
 *
 * 任一不满足 → 401 cli_token_invalid（设计 §8：四态统一该错误码，
 * message 区分原因）。desktop token 在本域**不被接受**（分离域）。
 *
 * 审计：actor='cli' 的非 GET 请求在完成后追加
 * `<dataRoot>/agent/audit/cli.jsonl`（时间、方法、路径、状态码；不记
 * body——正文可能含配置值，命令名已含于路径）。
 */

import type { MiddlewareHandler } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { CliEndpoint } from '../cli-endpoint.js';

const LOOPBACK_HOSTS = new Set([
  '127.0.0.1', 'localhost', '[::1]', '[0:0:0:0:0:0:0:1]',
]);

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.startsWith('[')
    ? host.replace(/:\d+$/, '')
    : host.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(bare) || bare === '[::1]';
}

/** CLI 请求头名（任务书指定；设计 §6.2 原文名 X-Feishu-Sync-Cli-Token，
 * 实现采用短名，S9 报告契约以本文件为准）。 */
export const CLI_TOKEN_HEADER = 'X-Cli-Token';

export interface CliAuthDeps {
  cliEndpoint: CliEndpoint;
  dataRoot: string;
}

export function cliAuthMiddleware(deps: CliAuthDeps): MiddlewareHandler {
  const { cliEndpoint, dataRoot } = deps;
  const auditFile = path.join(dataRoot, 'agent', 'audit', 'cli.jsonl');

  return async (c, next) => {
    // 回环判定：优先 Host 头（真实 HTTP 总是携带；Node fetch 测试路径下
    // undici 可能丢弃 Host，回退到请求 URL 的 host）。两者都非回环 → 拒绝。
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
      return c.json(
        { error: 'cli_token_invalid', message: 'CLI API 仅接受回环来源' },
        401,
      );
    }
    const origin = c.req.header('Origin');
    if (origin !== undefined && origin !== '') {
      return c.json(
        { error: 'cli_token_invalid', message: 'CLI API 拒绝浏览器来源（Origin 头存在）' },
        401,
      );
    }
    const token = c.req.header(CLI_TOKEN_HEADER) ?? '';
    if (!token || !cliEndpoint.verify(token)) {
      return c.json(
        { error: 'cli_token_invalid', message: 'CLI 令牌缺失或无效' },
        401,
      );
    }
    // 标记 CLI 主体（供审计/后续切片区分 actor；与 desktop 域互斥）。
    (c as any).cliActor = true;

    await next();

    // 审计：非 GET 请求记一行（时间、方法、路径、状态码；不记 body）。
    if (c.req.method !== 'GET') {
      appendAudit(auditFile, {
        time: new Date().toISOString(),
        method: c.req.method,
        path: c.req.path,
        status: c.res?.status ?? 0,
      });
    }
  };
}

function appendAudit(auditFile: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (error) {
    // 审计失败不阻断已完成的请求，但必须可见。
    console.warn('[cli-auth] audit append failed:', error);
  }
}
