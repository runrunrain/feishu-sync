/**
 * /api/kb/build-runtime* 路由测试（plugin-install-fix）：
 * 默认安装（空体）走 Git 获取链（host 契约）、sourceDir 严格校验与透传、
 * busy 409 与获取失败 400 的错误映射、未接线 503。host 以最小桩替换——
 * 默认链与状态诚实性由 amagi-git/live 测试覆盖真实实现。
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kbRoutes } from '../src/routes/kb.js';
import { ToolError } from '../src/agent/agent-tool-service.js';
import type { BuildRuntimeHost } from '../src/kb/build-runtime-host.js';

function makeApp(host: Partial<BuildRuntimeHost> | null): Hono {
  const app = new Hono();
  app.route('/', kbRoutes({
    buildService: null as never,
    configManager: null as never,
    localMapStore: null as never,
    documentsProvider: null as never,
    sheetCsvPaths: () => [],
    ...(host ? { buildRuntime: host as BuildRuntimeHost } : {}),
  }));
  return app;
}

async function post(app: Hono, body: unknown): Promise<{ status: number; data: any }> {
  const response = await app.request('/api/kb/build-runtime/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

describe('POST /api/kb/build-runtime/install', () => {
  it('默认（空体）→ host.installAmagi({})：Git 获取链；响应带 layout/dependenciesIncluded/acquisition', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-rt-route-'));
    try {
      const calls: unknown[] = [];
      const host = {
        installAmagi: async (input: unknown) => {
          calls.push(input);
          return {
            installed: true, fresh: true, version: '2.21.31',
            installDir: path.join(root, 'agent/runtime-packages/amagi-pi@2.21.31'),
            packageRoot: path.join(root, 'p'),
            contentHash: 'abc123',
            record: {
              layout: 'source', dependenciesIncluded: true,
              acquisition: {
                via: 'pi-git-install',
                gitSource: 'git:github.com/runrunrain/amagi-pi@929000ecbd8725e72b191493345d6abeef51c147',
                repoUrl: 'https://github.com/runrunrain/amagi-pi.git',
                commit: '929000ecbd8725e72b191493345d6abeef51c147',
                acquiredAt: '2026-01-01T00:00:00Z',
                acquiredPackageRoot: path.join(root, '.acquire-x/git/github.com/runrunrain/amagi-pi'),
                piInstallArgs: [],
              },
            },
          };
        },
      };
      const app = makeApp(host);
      const { status, data } = await post(app, {});
      expect(status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toHaveProperty('sourceDir'); // 默认 Git 链（不带 sourceDir）
      expect(data).toMatchObject({ installed: true, fresh: true, version: '2.21.31', layout: 'source', dependenciesIncluded: true });
      expect(data.acquisition).toMatchObject({
        gitSource: 'git:github.com/runrunrain/amagi-pi@929000ecbd8725e72b191493345d6abeef51c147',
        commit: '929000ecbd8725e72b191493345d6abeef51c147',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('相对路径/不存在路径 → 400 invalid_request（不进安装链）', async () => {
    let called = 0;
    const host = { installAmagi: async () => { called += 1; return null; } };
    const app = makeApp(host);
    const rel = await post(app, { sourceDir: 'relative/path' });
    expect(rel.status).toBe(400);
    expect(rel.data.error).toBe('invalid_request');
    const missing = await post(app, { sourceDir: '/definitely/not/exists/amagi-pi' });
    expect(missing.status).toBe(400);
    expect(called).toBe(0);
  });

  it('存在目录 → sourceDir 透传 host', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-rt-route-2-'));
    try {
      const dir = path.join(root, 'amagi-src');
      fs.mkdirSync(dir, { recursive: true });
      const seen: unknown[] = [];
      const host = { installAmagi: async (input: unknown) => { seen.push(input); return { fresh: true, version: '2.21.31', installDir: dir, contentHash: 'h', record: {} }; } };
      const app = makeApp(host);
      const { status } = await post(app, { sourceDir: dir });
      expect(status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ sourceDir: dir });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('busy（409 amagi_install_busy）与获取失败（400 amagi_install_failed）如实映射', async () => {
    const busyHost = { installAmagi: async () => { throw new ToolError('amagi_install_busy', '已有 amagi-pi 安装/校验进行中', 409); } };
    const busy = await post(makeApp(busyHost), {});
    expect(busy.status).toBe(409);
    expect(busy.data.error).toBe('amagi_install_busy');

    const failHost = {
      installAmagi: async () => { throw new ToolError('amagi_install_failed', 'amagi_acquisition_failed: Git 获取失败（需本机可用 git 与网络；也可改填本地 amagi-pi 目录安装）: …', 400); },
    };
    const fail = await post(makeApp(failHost), {});
    expect(fail.status).toBe(400);
    expect(fail.data.error).toBe('amagi_install_failed');
    expect(fail.data.message).toContain('本地 amagi-pi 目录');
  });

  it('宿主未接线 → 503 build_runtime_unavailable', async () => {
    const app = makeApp(null);
    const { status, data } = await post(app, {});
    expect(status).toBe(503);
    expect(data.error).toBe('build_runtime_unavailable');
  });
});

describe('GET /api/kb/build-runtime', () => {
  it('DTO 直通（含 candidates/discoveryIssues/gitSource）', async () => {
    const host = {
      statusDto: async () => ({
        orchestrationMode: 'pi-amagi',
        runtime: { nodePath: '/n', nodeVersion: null, piCliPath: '/p', piVersion: '1.4.0' },
        amagi: {
          pinnedVersion: '2.21.31', installed: false, version: null, installDir: null,
          contentHash: null, layout: null, installState: 'missing', installDetail: null,
          gitSource: 'git:github.com/runrunrain/amagi-pi@929000ecbd8725e72b191493345d6abeef51c147',
          commit: '929000ecbd8725e72b191493345d6abeef51c147', repoUrl: 'https://github.com/runrunrain/amagi-pi.git',
          candidates: [{ origin: 'global-pi-home', source: '/Users/x/amagi-pi', sourceType: 'local', packagePath: '/Users/x/amagi-pi', version: '2.21.36', matchesPin: false }],
          discoveryIssues: [],
        },
        probe: null,
        error: null,
      }),
    };
    const app = makeApp(host as Partial<BuildRuntimeHost>);
    const response = await app.request('/api/kb/build-runtime');
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.amagi.candidates[0].version).toBe('2.21.36');
    expect(data.amagi.candidates[0].matchesPin).toBe(false);
    expect(data.amagi.installState).toBe('missing');
  });

  it('宿主未接线 → 503', async () => {
    const response = await makeApp(null).request('/api/kb/build-runtime');
    expect(response.status).toBe(503);
  });
});
