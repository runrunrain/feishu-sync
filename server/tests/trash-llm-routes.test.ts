/**
 * P4-T13 backend route tests.
 *
 * Coverage strategy:
 *   - trash.ts: path-traversal guard, restore moves file back from
 *     .trash-bin, purge removes fs artifacts + DB row, all=1 batch,
 *     API contract shape matches src/api/client.ts (洛神 P4-2).
 *   - llm.ts: request validation (missing channel/llm/apiKey), timeout
 *     classification, response never leaks apiKey, success path with
 *     fake channel.
 *
 * No real LLM calls; channels are mocked via dependency injection
 * (llm.ts builds channels internally, so we exercise validation paths
 * directly and unit-test the channel impls through their own test file).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We import the trash route helpers indirectly via the Hono app. To test
// path-safety internals without spinning a full server, we duplicate the
// resolution algorithm checks against the implementation by exporting
// helpers through a sub-path. Since trash.ts only exports the Hono app,
// we exercise behavior end-to-end with Hono's test client instead.
import { trashRoutes } from '../src/routes/trash.js';
import { llmRoutes } from '../src/routes/llm.js';

// ============================================================================
// In-memory fakes
// ============================================================================

interface FakeDoc {
  objToken: string;
  obj_token?: string;
  title: string;
  localMdPath?: string;
  local_md_path?: string;
  cloudDeleted?: number;
  cloud_deleted?: number;
  lastSeenAt?: string | null;
  last_seen_at?: string | null;
  updatedAt?: string;
  updated_at?: string;
}

function makeFakeStore(docs: FakeDoc[]) {
  const rows = docs.map((d) => ({
    objToken: d.objToken ?? d.obj_token,
    obj_token: d.objToken ?? d.obj_token,
    title: d.title,
    localMdPath: d.localMdPath ?? d.local_md_path ?? '',
    local_md_path: d.localMdPath ?? d.local_md_path ?? '',
    cloudDeleted: d.cloudDeleted ?? d.cloud_deleted ?? 0,
    cloud_deleted: d.cloudDeleted ?? d.cloud_deleted ?? 0,
    lastSeenAt: d.lastSeenAt ?? d.last_seen_at ?? null,
    last_seen_at: d.lastSeenAt ?? d.last_seen_at ?? null,
    updatedAt: d.updatedAt ?? d.updated_at ?? '2026-06-18T00:00:00Z',
    updated_at: d.updatedAt ?? d.updated_at ?? '2026-06-18T00:00:00Z',
  }));

  let list = rows.filter((r) => r.cloudDeleted === 1);
  const purged: string[] = [];
  const restored: string[] = [];

  return {
    listCloudDeleted: () => list.slice(),
    getDocumentByObjToken: (tok: string) =>
      rows.find((r) => r.objToken === tok) ?? null,
    restoreCloudDeleted: (tok: string) => {
      restored.push(tok);
      rows.forEach((r) => {
        if (r.objToken === tok) {
          r.cloudDeleted = 0;
          r.cloud_deleted = 0;
        }
      });
      list = rows.filter((r) => r.cloudDeleted === 1);
    },
    purgeCloudDeleted: (tok: string) => {
      purged.push(tok);
      const idx = rows.findIndex((r) => r.objToken === tok);
      if (idx >= 0) rows.splice(idx, 1);
      list = rows.filter((r) => r.cloudDeleted === 1);
    },
    deleteDocumentByToken: (tok: string) => {
      const idx = rows.findIndex((r) => r.objToken === tok);
      if (idx < 0) return false;
      rows.splice(idx, 1);
      list = rows.filter((r) => r.cloudDeleted === 1);
      return true;
    },
    _purged: () => purged.slice(),
    _restored: () => restored.slice(),
  };
}

function buildDiApp(deps: Record<string, any>) {
  // Dynamically import Hono to create a wrapping app.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Hono } = require('hono');
  const wrap = new Hono();
  wrap.use('*', async (c: any, next: any) => {
    Object.assign(c, deps);
    await next();
  });
  wrap.route('/', trashRoutes);
  return wrap;
}

function buildLlmDiApp(deps: Record<string, any>) {
  const { Hono } = require('hono');
  const wrap = new Hono();
  wrap.use('*', async (c: any, next: any) => {
    Object.assign(c, deps);
    await next();
  });
  wrap.route('/', llmRoutes);
  return wrap;
}

// ----------------------------------------------------------------------------
// Temp knowledge-base fixtures
// ----------------------------------------------------------------------------

let tmpRoot: string;

function setupKb(): string {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-trash-test-'));
  // Mirror production layout: docs/ + .trash-bin/
  fs.mkdirSync(path.join(tmpRoot, 'docs', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, '.trash-bin'), { recursive: true });
  return tmpRoot;
}

function teardownKb() {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  tmpRoot = '' as any;
}

// ============================================================================
// trash route tests
// ============================================================================

describe('trash routes', () => {
  beforeEach(() => setupKb());
  afterEach(() => teardownKb());

  it('GET /api/trash returns { items: TrashedDoc[] } shape', async () => {
    const store = makeFakeStore([
      {
        objToken: 'AAA',
        title: 'Doc A',
        localMdPath: 'docs/a.md',
        cloudDeleted: 1,
        lastSeenAt: '2026-06-18T10:00:00Z',
      },
    ]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });
    const res = await app.fetch(new Request('http://x/api/trash'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(1);
    const item = body.items[0];
    expect(item.obj_token).toBe('AAA');
    expect(item.title).toBe('Doc A');
    expect(item.local_path).toBe('docs/a.md');
    expect(item.deleted_at).toBe('2026-06-18T10:00:00Z');
    expect(item.reason).toBe('cloud_deleted');
  });

  it('POST /api/trash/restore moves file back from .trash-bin and clears flag', async () => {
    // Stage: original path missing, .trash-bin has the file.
    const original = path.join(tmpRoot, 'docs', 'a.md');
    const staged = path.join(tmpRoot, '.trash-bin', 'docs', 'a.md');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, 'hello');
    expect(fs.existsSync(original)).toBe(false);

    const store = makeFakeStore([
      {
        objToken: 'AAA',
        title: 'A',
        localMdPath: 'docs/a.md',
        cloudDeleted: 1,
        lastSeenAt: '2026-06-18T10:00:00Z',
      },
    ]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });

    const res = await app.fetch(
      new Request('http://x/api/trash/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ obj_token: 'AAA' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fs.existsSync(original)).toBe(true);
    expect(fs.existsSync(staged)).toBe(false);
    expect(store._restored()).toEqual(['AAA']);
  });

  it('POST /api/trash/restore is idempotent when already restored', async () => {
    const store = makeFakeStore([
      {
        objToken: 'BBB',
        title: 'B',
        localMdPath: 'docs/b.md',
        cloudDeleted: 0,
      },
    ]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });
    const res = await app.fetch(
      new Request('http://x/api/trash/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ obj_token: 'BBB' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(store._restored()).toEqual([]);
  });

  it('POST /api/trash/restore returns 404 for unknown obj_token', async () => {
    const store = makeFakeStore([]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });
    const res = await app.fetch(
      new Request('http://x/api/trash/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ obj_token: 'NOPE' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('DELETE /api/trash/purge?obj_token unlinks both original and staged files, deletes row', async () => {
    const original = path.join(tmpRoot, 'docs', 'c.md');
    const staged = path.join(tmpRoot, '.trash-bin', 'docs', 'c.md');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(original, 'orig');
    fs.writeFileSync(staged, 'stage');

    const store = makeFakeStore([
      {
        objToken: 'CCC',
        title: 'C',
        localMdPath: 'docs/c.md',
        cloudDeleted: 1,
        lastSeenAt: '2026-06-18T10:00:00Z',
      },
    ]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });
    const res = await app.fetch(
      new Request('http://x/api/trash/purge?obj_token=CCC', { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: 1 });
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(staged)).toBe(false);
    expect(store._purged()).toEqual(['CCC']);
  });

  it('DELETE /api/trash/purge?all=1 purges every trashed row', async () => {
    const store = makeFakeStore([
      { objToken: 'D1', title: 'D1', localMdPath: 'docs/d1.md', cloudDeleted: 1, lastSeenAt: 't' },
      { objToken: 'D2', title: 'D2', localMdPath: 'docs/d2.md', cloudDeleted: 1, lastSeenAt: 't' },
      { objToken: 'D3', title: 'D3', localMdPath: 'docs/d3.md', cloudDeleted: 0 }, // not trashed
    ]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });
    const res = await app.fetch(
      new Request('http://x/api/trash/purge?all=1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purged).toBe(2);
    expect(store._purged().sort()).toEqual(['D1', 'D2']);
  });

  it('DELETE /api/trash/purge with neither param returns 400', async () => {
    const store = makeFakeStore([]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });
    const res = await app.fetch(new Request('http://x/api/trash/purge', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });

  it('DELETE /api/trash/purge with both params returns 400', async () => {
    const store = makeFakeStore([]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });
    const res = await app.fetch(
      new Request('http://x/api/trash/purge?obj_token=X&all=1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(400);
  });

  it('Path-traversal local_md_path is refused (no file outside root is touched)', async () => {
    // A malicious row whose local_md_path escapes the KB root via ../
    const outsideTarget = path.join(os.tmpdir(), 'feishu-trash-outside-marker.md');
    fs.writeFileSync(outsideTarget, 'should-not-be-deleted');

    const store = makeFakeStore([
      {
        objToken: 'EVIL',
        title: 'E',
        localMdPath: '../../../feishu-trash-outside-marker.md',
        cloudDeleted: 1,
        lastSeenAt: 't',
      },
    ]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });
    const res = await app.fetch(
      new Request('http://x/api/trash/purge?obj_token=EVIL', { method: 'DELETE' }),
    );
    // DB row is still purged (it's just a stale malicious record) but
    // the file outside the root MUST remain.
    expect(res.status).toBe(200);
    expect(fs.existsSync(outsideTarget)).toBe(true);
    fs.unlinkSync(outsideTarget);
  });

  it('POST /api/trash/restore with missing obj_token returns 400', async () => {
    const store = makeFakeStore([]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });
    const res = await app.fetch(
      new Request('http://x/api/trash/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// manual-delete route tests（2026-09 手动删除节点）
// ============================================================================

describe('POST /api/trash/manual-delete', () => {
  beforeEach(() => setupKb());
  afterEach(() => teardownKb());

  it('moves live doc file to .trash-bin and hard-deletes the row', async () => {
    const original = path.join(tmpRoot, 'docs', 'sub', '残留节点.md');
    fs.writeFileSync(original, '# 残留内容');
    const store = makeFakeStore([
      { objToken: 'residual-doc', title: '残留节点', localMdPath: 'docs/sub/残留节点.md', cloudDeleted: 0 },
    ]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });

    const res = await app.fetch(
      new Request('http://x/api/trash/manual-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ obj_token: 'residual-doc' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.file_moved_to_trash).toBe(true);
    // 文件进回收站目录（镜像相对路径），原位消失，行被硬删
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, '.trash-bin', 'docs', 'sub', '残留节点.md'))).toBe(true);
    expect(store.getDocumentByObjToken('residual-doc')).toBeNull();
  });

  it('deletes the row directly when local file already missing (手动删过文件)', async () => {
    const store = makeFakeStore([
      { objToken: 'ghost-doc', title: '无文件残留', localMdPath: 'docs/sub/ghost.md', cloudDeleted: 0 },
    ]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });

    const res = await app.fetch(
      new Request('http://x/api/trash/manual-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ obj_token: 'ghost-doc' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.file_moved_to_trash).toBe(false);
    expect(store.getDocumentByObjToken('ghost-doc')).toBeNull();
  });

  it('rejects trash-managed rows with 409 and is idempotent for missing rows', async () => {
    const store = makeFakeStore([
      { objToken: 'trashed-doc', title: '回收站行', localMdPath: 'docs/trashed.md', cloudDeleted: 1 },
    ]);
    const app = buildDiApp({ localMapStore: store, configManager: { getConfig: () => ({ knowledgeBaseRoot: tmpRoot }) } });

    // 回收站行 → 409，避免与回收站面板双语义交叉
    const res409 = await app.fetch(
      new Request('http://x/api/trash/manual-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ obj_token: 'trashed-doc' }),
      }),
    );
    expect(res409.status).toBe(409);
    expect(store.getDocumentByObjToken('trashed-doc')).not.toBeNull();

    // 行不存在 → 幂等 ok + already_gone
    const resGone = await app.fetch(
      new Request('http://x/api/trash/manual-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ obj_token: 'no-such-doc' }),
      }),
    );
    expect(resGone.status).toBe(200);
    expect((await resGone.json()).already_gone).toBe(true);

    // 缺 obj_token → 400
    const res400 = await app.fetch(
      new Request('http://x/api/trash/manual-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res400.status).toBe(400);
  });
});

// ============================================================================
// llm test-channel route tests
// ============================================================================

describe('llm test-channel route', () => {
  const validLlm = {
    openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'sk-test-key',
    model: 'glm-4-flash',
    directModel: 'glm-4-flash',
    claudeCliModel: 'glm-5.2',
    temperature: 0.2,
  };

  it('rejects invalid channel name', async () => {
    const app = buildLlmDiApp({});
    const res = await app.fetch(
      new Request('http://x/api/llm/test-channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'bogus', llm: validLlm }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing llm config', async () => {
    const app = buildLlmDiApp({});
    const res = await app.fetch(
      new Request('http://x/api/llm/test-channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'direct' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('empty apiKey returns 200 with success=false and a friendly error (not 500)', async () => {
    const app = buildLlmDiApp({});
    const res = await app.fetch(
      new Request('http://x/api/llm/test-channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'direct',
          llm: { ...validLlm, apiKey: '' },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/api\s*key/i);
  });

  it('uses the persisted key when Settings sends the GET-mask sentinel', async () => {
    const app = buildLlmDiApp({
      configManager: {
        load: async () => ({ llm: { apiKey: 'saved-key-must-not-leak' } }),
      },
    });
    const res = await app.fetch(
      new Request('http://x/api/llm/test-channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'direct',
          // A refused local endpoint avoids any real provider call. If the
          // route treated `***` as the credential, this test would still
          // leak the sentinel into a provider request; the implementation
          // instead resolves it only in memory from ConfigManager.
          llm: {
            ...validLlm,
            apiKey: '***',
            openAiCompatBaseUrl: 'http://127.0.0.1:1/v1',
          },
          timeoutMs: 800,
        }),
      }),
    );
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).not.toMatch(/apiKey is empty/i);
    expect(JSON.stringify(body)).not.toContain('saved-key-must-not-leak');
  });

  it('direct channel with unreachable endpoint returns success=false (timeout/error), no apiKey in response', async () => {
    const app = buildLlmDiApp({});
    const res = await app.fetch(
      new Request('http://x/api/llm/test-channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'direct',
          // unreachable URL so the SDK fails fast / times out
          llm: { ...validLlm, openAiCompatBaseUrl: 'http://127.0.0.1:1/api/v4' },
          timeoutMs: 800,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    // Response shape omits apiKey entirely.
    expect(JSON.stringify(body)).not.toContain('sk-test-key');
    expect(typeof body.model).toBe('string');
  });

  it('response shape matches ChannelTestResult contract (no apiKey key)', async () => {
    const app = buildLlmDiApp({});
    const res = await app.fetch(
      new Request('http://x/api/llm/test-channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'direct',
          llm: { ...validLlm, openAiCompatBaseUrl: 'http://127.0.0.1:1/api/v4' },
          timeoutMs: 800,
        }),
      }),
    );
    const body = await res.json();
    expect(body).toHaveProperty('success');
    expect(body).toHaveProperty('durationMs');
    expect(body).toHaveProperty('model');
    // No apiKey ever in response.
    const keys = Object.keys(body);
    expect(keys.some((k) => /key/i.test(k))).toBe(false);
  });

  it('invalid JSON returns 400', async () => {
    const app = buildLlmDiApp({});
    const res = await app.fetch(
      new Request('http://x/api/llm/test-channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
  });
});
