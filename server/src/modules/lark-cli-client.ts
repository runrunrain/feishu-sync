/**
 * LarkCliClient - Encapsulates all lark-cli subprocess calls
 *
 * Implements the design from 飞书认证架构专项设计 §五:
 * - checkAuthReady(): version + auth status + required scopes validation
 * - listWikiNodes(): wiki +node-list with space-id and parent-node-token
 * - getNode(): wiki +node-get returning space_id, obj_token, obj_edit_time, has_child
 * - api(): generic lark-cli api command fallback
 * - QPS throttling: token bucket (wiki 10, docx 5, sheets 5)
 * - Error classification: 99991400 (rate limit), 40403 (no permission), timeout, auth errors
 *
 * IMPORTANT: This module must NOT contain any Feishu token variables.
 * All token management is delegated to lark-cli.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { LarkCliNodeInfo, LarkCliConfig } from '../types/index.js';

const execFileAsync = promisify(execFile);

export class LarkCliClient {
  private qpsLimiter: Map<string, number[]> = new Map();

  constructor(private config: LarkCliConfig) {}

  /**
   * Check if lark-cli is ready (version + authentication + scope validation)
   */
  async checkAuthReady(): Promise<{ ready: boolean; error?: string }> {
    try {
      // 1. Check if lark-cli is installed
      const versionResult = await this.execLarkCli(['--version']);
      if (!versionResult.ok) {
        return { ready: false, error: 'lark-cli 未安装，请执行 npm install -g lark-cli' };
      }

      // 2. Check authentication status
      const statusResult = await this.execLarkCli(['auth', 'status']);
      if (!statusResult.data || !statusResult.data.identity) {
        return { ready: false, error: '未认证，请执行 lark-cli auth login' };
      }

      if (statusResult.data.identity !== 'user') {
        return { ready: false, error: `认证身份不是 user，当前身份: ${statusResult.data.identity}` };
      }

      // 3. Check required scopes
      const currentScopes = statusResult.data.scopes || [];
      const missingScopes = this.config.requiredScopes.filter((s) => !currentScopes.includes(s));
      if (missingScopes.length > 0) {
        return { ready: false, error: `缺少权限：${missingScopes.join(', ')}，请执行 lark-cli auth login --scope` };
      }

      return { ready: true };
    } catch (error) {
      return { ready: false, error: `认证检查失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * List wiki subtree nodes (supporting pagination and recursion)
   */
  async listWikiNodes(options: {
    spaceId?: string;
    parentNodeToken?: string;
    pageSize?: number;
  }): Promise<LarkCliNodeInfo[]> {
    await this.throttle('wiki');

    const args = ['wiki', '+node-list', '--format', 'json', '--page-all'];
    if (options.spaceId) args.push('--space-id', options.spaceId);
    if (options.parentNodeToken) args.push('--parent-node-token', options.parentNodeToken);
    if (options.pageSize) args.push('--page-size', String(options.pageSize));

    const result = await this.execLarkCli(args);
    return result.data?.items || [];
  }

  /**
   * Get node details (supports URL/node_token/obj_token)
   * Returns space_id, obj_token, obj_edit_time, has_child, etc.
   */
  async getNode(nodeTokenOrUrl: string): Promise<LarkCliNodeInfo> {
    await this.throttle('wiki');

    const args = ['wiki', '+node-get', '--node-token', nodeTokenOrUrl, '--format', 'json'];
    const result = await this.execLarkCli(args);

    // Map fields based on actual lark-cli output (validated by 实测)
    return {
      node_token: result.data.node_token,
      obj_token: result.data.obj_token,
      obj_type: result.data.obj_type,
      title: result.data.title,
      space_id: result.data.space_id,
      obj_edit_time: parseInt(result.data.obj_edit_time, 10),
      has_child: result.data.has_child,
    };
  }

  /**
   * Generic OpenAPI call (fallback)
   */
  async api(method: 'GET' | 'POST', apiPath: string, options?: {
    params?: Record<string, any>;
    data?: Record<string, any>;
    as?: 'user' | 'bot';
  }): Promise<any> {
    const args = ['api', method, apiPath, '--format', 'json'];
    if (options?.as) args.push('--as', options.as);
    if (options?.params) args.push('--params', JSON.stringify(options.params));
    if (options?.data) args.push('--data', JSON.stringify(options.data));

    return this.execLarkCli(args);
  }

  /**
   * Execute lark-cli subprocess (core encapsulation)
   */
  private async execLarkCli(args: string[]): Promise<any> {
    const larkCliPath = this.config.larkCliPath || this.getDefaultLarkCliPath();
    const timeout = this.config.timeout || 30000;

    try {
      const { stdout, stderr } = await execFileAsync(larkCliPath, args, {
        timeout,
        encoding: 'utf-8',
        shell: process.platform === 'win32', // Use shell on Windows for .cmd files
      });

      // Detect authentication errors
      if (this.detectAuthError(stderr)) {
        throw new Error('认证失效，请执行 lark-cli auth login');
      }

      return this.parseJsonOutput(stdout);
    } catch (error: any) {
      // Classify errors
      const errorStderr = error.stderr || '';
      if (error.killed && error.signal === 'SIGTERM') {
        throw new Error('lark-cli 执行超时');
      }
      if (errorStderr?.includes?.('99991400')) {
        throw new Error('QPS 限频，请稍后重试');
      }
      if (errorStderr?.includes?.('40403')) {
        throw new Error('无权限访问该节点');
      }
      throw new Error(`lark-cli 执行失败：${errorStderr || error.message}`);
    }
  }

  /**
   * Parse lark-cli JSON output with robust error handling
   * - Strips BOM, ANSI codes, and surrounding whitespace
   * - Extracts JSON fragment from first { to last } (tolerates log lines)
   * - Preserves original output in error message for debugging
   * - Handles both ok-result format (from api commands) and direct data format (from auth/wiki commands)
   */
  private parseJsonOutput(stdout: string): any {
    // Remove BOM (UTF-8) and ANSI escape codes
    const cleaned = stdout
      .replace(/^﻿/, '') // BOM
      .replace(/\x1b\[[0-9;]*m/g, '') // ANSI escape codes
      .trim();

    // Handle non-JSON output (e.g., version command)
    if (!cleaned.startsWith('{')) {
      return {
        ok: true,
        data: { version: cleaned },
      };
    }

    // Extract JSON fragment (from first { to last })
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
      throw new Error(`解析 lark-cli 输出失败：未找到有效 JSON 结构\n原始输出：${stdout}`);
    }

    const jsonStr = cleaned.substring(firstBrace, lastBrace + 1);

    try {
      const json = JSON.parse(jsonStr);

      // Handle api command responses with ok field
      if ('ok' in json && json.ok === false) {
        throw new Error(`lark-cli 返回错误：${json.msg || '未知错误'}`);
      }

      // For direct data responses (auth status, wiki nodes), return as-is
      // Wrap in ok: true for consistency
      return 'ok' in json ? json : { ok: true, data: json };
    } catch (error) {
      throw new Error(`解析 lark-cli 输出失败：${error instanceof Error ? error.message : String(error)}\n原始输出：${stdout}`);
    }
  }

  /**
   * Detect authentication errors from stderr
   */
  private detectAuthError(stderr: string): boolean {
    if (!stderr) return false;
    return stderr.includes('not authenticated') ||
           stderr.includes('token expired') ||
           stderr.includes('unauthorized');
  }

  /**
   * QPS throttling (token bucket algorithm)
   */
  private async throttle(apiType: 'wiki' | 'docx' | 'sheets'): Promise<void> {
    const limit = { wiki: 10, docx: 5, sheets: 5 }[apiType];
    const now = Date.now();
    const calls = this.qpsLimiter.get(apiType) || [];

    // Remove calls older than 1 second
    const recentCalls = calls.filter((t) => now - t < 1000);

    if (recentCalls.length >= limit) {
      const oldestCall = recentCalls[0];
      const waitTime = 1000 - (now - oldestCall);
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    recentCalls.push(now);
    this.qpsLimiter.set(apiType, recentCalls);
  }

  /**
   * Get default lark-cli executable path based on platform
   */
  private getDefaultLarkCliPath(): string {
    // On Windows, use lark-cli.cmd; on Unix, use lark-cli
    // On Windows with spawn EINVAL, try lark-cli.cmd first, then lark-cli
    if (process.platform === 'win32') {
      return 'lark-cli.cmd';
    }
    return 'lark-cli';
  }
}
