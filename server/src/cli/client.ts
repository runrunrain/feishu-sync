/**
 * CLI HTTP 与端点发现层（设计 kb-agent-upgrade §6.1/§6.4）
 *
 * 发现顺序：`--home` > `FEISHU_SYNC_HOME` > `~/.feishu-sync`，读
 * `<home>/run/endpoint.json`（S8 契约：{ schemaVersion, url, pid,
 * startedAt, appVersion, cliToken }）。
 *
 * HTTP 用 node:http/https 而非全局 fetch：undici 的默认 headersTimeout
 * （5 分钟）会截断 auth login complete 等 long-poll 命令（最长约 12 分钟），
 * node:http 无内建超时，超时边界由本层显式控制。
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

/** CLI 请求头（S8 实现：middleware/cli-auth.ts 的 CLI_TOKEN_HEADER）。 */
export const CLI_TOKEN_HEADER = 'X-Cli-Token';

export interface EndpointInfo {
  url: string;
  cliToken: string;
  appVersion?: string;
  endpointFile: string;
}

export type EndpointLoadResult =
  | { ok: true; endpoint: EndpointInfo }
  | { ok: false; code: 'app_not_running' | 'endpoint_invalid'; message: string; endpointFile: string };

/** 数据根解析：--home > FEISHU_SYNC_HOME > ~/.feishu-sync（与 server 端 resolveDataRoot 对齐）。 */
export function resolveHome(cliHome?: string): string {
  if (cliHome && cliHome.trim()) return path.resolve(cliHome.trim());
  const fromEnv = process.env.FEISHU_SYNC_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.feishu-sync');
}

export function endpointFilePath(home: string): string {
  return path.join(home, 'run', 'endpoint.json');
}

/** 读取并校验端点文件；缺失/损坏归入 exit-3 语义（设计 §6.4）。 */
export function loadEndpoint(home: string): EndpointLoadResult {
  const file = endpointFilePath(home);
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      code: 'app_not_running',
      message: `未发现运行中的应用（${file} 不存在）`,
      endpointFile: file,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {
      ok: false,
      code: 'app_not_running',
      message: `端点文件损坏（${file}），请在应用中重新开启命令行访问`,
      endpointFile: file,
    };
  }
  const payload = raw as Partial<{ url?: unknown; cliToken?: unknown; appVersion?: unknown }> | null;
  if (
    !payload || typeof payload !== 'object'
    || typeof payload.url !== 'string' || !/^https?:\/\//i.test(payload.url)
    || typeof payload.cliToken !== 'string' || payload.cliToken.length === 0
  ) {
    return {
      ok: false,
      code: 'endpoint_invalid',
      message: `端点文件格式非法（${file}）`,
      endpointFile: file,
    };
  }
  return {
    ok: true,
    endpoint: {
      url: payload.url.replace(/\/+$/, ''),
      cliToken: payload.cliToken,
      appVersion: typeof payload.appVersion === 'string' ? payload.appVersion : undefined,
      endpointFile: file,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class HttpCallError extends Error {
  kind: 'network' | 'timeout';
  constructor(kind: 'network' | 'timeout', message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

export interface HttpInit {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** 最小 JSON-over-HTTP 客户端（Node 内建，零依赖；供 CLI 子进程使用）。 */
export function httpJson(urlString: string, init: HttpInit): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      reject(new HttpCallError('network', `非法 URL：${urlString}`));
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers: {
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(init.body, 'utf-8')) } : {}),
          ...init.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = null;
          try {
            body = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          resolve({ status: response.statusCode ?? 0, body, text });
        });
      },
    );
    request.setTimeout(init.timeoutMs, () => {
      request.destroy(new HttpCallError('timeout', `请求超时（${Math.round(init.timeoutMs / 1000)}s）：${init.method} ${urlString}`));
    });
    request.on('error', (error) => {
      reject(error instanceof HttpCallError
        ? error
        : new HttpCallError('network', `${init.method} ${urlString} 失败：${error.message}`));
    });
    if (init.body !== undefined) request.write(init.body, 'utf-8');
    request.end();
  });
}
