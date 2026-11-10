/**
 * pi-home retry 设置修复测试（Work 会话「Request timed out. 直接终止」根因）
 *
 * 背景：宿主曾对非原生会话发送 set_auto_retry{enabled:false}，而 Pi 的
 * setAutoRetryEnabled 会把 retry.enabled 持久化进共享 pi-home 的
 * settings.json。原生 Work 会话随后读到 retry 关闭，瞬时错误（Pi 判定为
 * 可重试的 "Request timed out." 等）不再自动重试，直接以
 * model_request_failed 终止运行。buildPiProcessEnv 在 spawn 前修复该污染。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPiProcessEnv,
  classifyPromptError,
  repairPiHomeRetrySetting,
} from '../src/agent/pi-rpc-process.js';

let dataRoot: string;

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-retry-fix-'));
});

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const piHome = () => path.join(dataRoot, 'agent', 'pi-home');
const settingsFile = () => path.join(piHome(), 'settings.json');

function writeSettings(value: unknown): void {
  fs.mkdirSync(piHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsFile(), JSON.stringify(value, null, 2), { mode: 0o600 });
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;
}

describe('repairPiHomeRetrySetting', () => {
  it('把被持久化污染的 retry.enabled:false 修复为 true，保留其余 retry 字段与顶层键', () => {
    writeSettings({
      packages: ['/some/pkg'],
      retry: { enabled: false, maxRetries: 5, provider: { timeoutMs: 300000 } },
      images: { autoResize: false },
    });
    repairPiHomeRetrySetting(piHome());
    const next = readSettings();
    expect((next.retry as Record<string, unknown>).enabled).toBe(true);
    expect((next.retry as Record<string, unknown>).maxRetries).toBe(5);
    expect((next.retry as Record<string, unknown>).provider).toEqual({ timeoutMs: 300000 });
    expect(next.packages).toEqual(['/some/pkg']);
    expect(next.images).toEqual({ autoResize: false });
  });

  it('retry 缺失 / 已启用 / 非对象 / 文件缺失 / JSON 无效时不改不抛', () => {
    writeSettings({ retry: { enabled: true } });
    repairPiHomeRetrySetting(piHome());
    expect((readSettings().retry as Record<string, unknown>).enabled).toBe(true);

    writeSettings({ packages: [] });
    repairPiHomeRetrySetting(piHome());
    expect(readSettings()).toEqual({ packages: [] });

    writeSettings({ retry: { maxRetries: 3 } });
    repairPiHomeRetrySetting(piHome());
    expect(readSettings().retry).toEqual({ maxRetries: 3 });

    writeSettings({ retry: ['nope'] });
    repairPiHomeRetrySetting(piHome());
    expect(readSettings().retry).toEqual(['nope']);

    fs.rmSync(settingsFile());
    expect(() => repairPiHomeRetrySetting(piHome())).not.toThrow();

    fs.writeFileSync(settingsFile(), '{ not json', { mode: 0o600 });
    expect(() => repairPiHomeRetrySetting(piHome())).not.toThrow();
  });
});

describe('buildPiProcessEnv retry 修复', () => {
  it('app-llm 会话 spawn 修复共享 pi-home 的 retry 污染', () => {
    writeSettings({ retry: { enabled: false, provider: { timeoutMs: 300000 } } });
    buildPiProcessEnv({
      mode: 'app-llm',
      parentEnv: { PATH: process.env.PATH },
      dataRoot,
      agentUrl: 'http://127.0.0.1:1',
      runToken: 't',
      preserveUploadedImages: true,
    });
    const retry = readSettings().retry as Record<string, unknown>;
    expect(retry.enabled).toBe(true);
    expect(retry.provider).toEqual({ timeoutMs: 300000 });
  });

  it('nativeWork 覆盖目录路径不触发共享 pi-home 的修复', () => {
    writeSettings({ retry: { enabled: false } });
    const overlay = path.join(dataRoot, 'agent', 'pi-home-local', 'overlay-x');
    fs.mkdirSync(overlay, { recursive: true, mode: 0o700 });
    buildPiProcessEnv({
      mode: 'app-llm',
      parentEnv: { PATH: process.env.PATH },
      dataRoot,
      agentUrl: 'http://127.0.0.1:1',
      runToken: 't',
      nativeWork: true,
      nativeWorkAgentDir: overlay,
    });
    // 覆盖目录由 prepareLocalWorkHome 从（已修复的）共享设置重新生成，这里不代管。
    expect((readSettings().retry as Record<string, unknown>).enabled).toBe(false);
  });

  it('用户本机 pi-home（pi-agent-dir 继承路径）不受修复影响', () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-user-home-'));
    try {
      const userSettings = path.join(userHome, 'settings.json');
      fs.writeFileSync(userSettings, JSON.stringify({ retry: { enabled: false } }), { mode: 0o600 });
      buildPiProcessEnv({
        mode: 'pi-agent-dir',
        parentEnv: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: userHome },
        dataRoot,
        agentUrl: 'http://127.0.0.1:1',
        runToken: 't',
      });
      // pi-agent-dir 无 nativeWorkAgentDir 时仍指向应用 pi-home；用户目录键只是
      // 只读共享源（FEISHU_SYNC_AGENT_SHARED_PI_HOME），不应被改写。
      const retry = JSON.parse(fs.readFileSync(userSettings, 'utf8')).retry as Record<string, unknown>;
      expect(retry.enabled).toBe(false);
    } finally {
      fs.rmSync(userHome, { recursive: true, force: true });
    }
  });
});

describe('classifyPromptError 超时归类', () => {
  it('提供方超时文本归为 model_timeout，其余维持既有分类', () => {
    expect(classifyPromptError('Request timed out.')).toBe('model_timeout');
    expect(classifyPromptError('request timeout after 600000ms')).toBe('model_timeout');
    expect(classifyPromptError('Deadline exceeded after 30s')).toBe('model_timeout');
    expect(classifyPromptError('fetch failed: ETIMEDOUT')).toBe('model_timeout');
    expect(classifyPromptError('insufficient_quota: billing')).toBe('model_quota_exceeded');
    expect(classifyPromptError('No API key configured')).toBe('model_auth_missing');
    expect(classifyPromptError('Model not found: foo')).toBe('model_unconfigured');
    expect(classifyPromptError('overloaded_error')).toBe('model_request_failed');
  });
});
