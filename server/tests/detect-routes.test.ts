/**
 * detect-routes tests (v0.2.0 detect positional-arg fix coverage).
 *
 * Validates the POST /api/detect/changes endpoint contract:
 *   - 400 when rootUrl is missing/empty/non-string (the regression that
 *     leaked undefined into lark-cli as `positional arguments are not
 *     supported (got ["json"])`; see detect.ts header)
 *   - 400 when rootUrl is neither a Feishu wiki URL nor a raw token
 *   - 500 when ChangeDetector is not initialized
 *   - 200 happy path: ChangeDetector.detectChanges(rootUrl) invoked exactly
 *     once with the validated rootUrl; result returned verbatim
 *
 * Strategy: build a tiny Hono app wrapping `detectRoutes` with a DI
 * context, backed by a stub ChangeDetector that records calls. No real
 * lark-cli invocation is exercised here — the regression is precisely
 * about preventing the request from reaching lark-cli with malformed
 * input, so a stub is sufficient and faster than e2e.
 */

import { describe, it, expect } from 'vitest';

const { Hono } = require('hono');
import { detectRoutes } from '../src/routes/detect.js';

// ---------------------------------------------------------------------------
// Stub ChangeDetector — records the last rootUrl it received.
// ---------------------------------------------------------------------------

interface RecordedCall {
  rootUrl: string;
}

function makeStubDetector(result: any, shouldThrow = false) {
  const calls: RecordedCall[] = [];
  return {
    instance: {
      async detectChanges(rootUrl: string) {
        calls.push({ rootUrl });
        if (shouldThrow) {
          throw new Error('stub failure');
        }
        return result;
      },
    },
    calls,
  };
}

/**
 * Stub ChangeDetector whose detectChanges output depends on the rootUrl.
 * Used by /api/detect/changes-all tests to assert per-root outcomes are
 * preserved in the aggregated envelope.
 */
function makePerRootStub(perRoot: Record<string, any>) {
  const calls: RecordedCall[] = [];
  return {
    instance: {
      async detectChanges(rootUrl: string) {
        calls.push({ rootUrl });
        const entry = perRoot[rootUrl];
        if (entry && entry.throw) {
          throw new Error(entry.throw);
        }
        return entry?.result ?? { changed: false, changedDocuments: [], totalNodes: 0 };
      },
    },
    calls,
  };
}

/**
 * Minimal ConfigManager stub exposing only getConfig().watchedRootUrls.
 */
function makeStubConfig(watchedRootUrls: string[]) {
  return {
    getConfig: () => ({ watchedRootUrls }),
  };
}

function buildApp(deps: Record<string, any>) {
  const wrap = new Hono();
  wrap.use('*', async (c: any, next: any) => {
    Object.assign(c, deps);
    await next();
  });
  wrap.route('/', detectRoutes);
  return wrap;
}

const FEISHU_URL =
  'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb';
const RAW_TOKEN = 'Wramw1XxRihIgnkCrhqcdEbRnHb';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/detect/changes', () => {
  it('returns 400 missing_rootUrl when body has no rootUrl', async () => {
    const stub = makeStubDetector({ changed: false, changedDocuments: [] });
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrls: [] }), // the historical bug shape
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('missing_rootUrl');
    // ChangeDetector must NOT be called when the request is malformed.
    expect(stub.calls.length).toBe(0);
  });

  it('returns 400 missing_rootUrl when rootUrl is empty string', async () => {
    const stub = makeStubDetector({ changed: false, changedDocuments: [] });
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrl: '' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('missing_rootUrl');
    expect(stub.calls.length).toBe(0);
  });

  it('returns 400 missing_rootUrl when rootUrl is undefined (JSON null)', async () => {
    const stub = makeStubDetector({ changed: false, changedDocuments: [] });
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrl: null }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('missing_rootUrl');
    expect(stub.calls.length).toBe(0);
  });

  it('returns 400 missing_rootUrl when rootUrl is non-string', async () => {
    const stub = makeStubDetector({ changed: false, changedDocuments: [] });
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrl: 12345 }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('missing_rootUrl');
    expect(stub.calls.length).toBe(0);
  });

  it('returns 400 missing_rootUrl when body is not valid JSON', async () => {
    const stub = makeStubDetector({ changed: false, changedDocuments: [] });
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('missing_rootUrl');
    expect(stub.calls.length).toBe(0);
  });

  it('returns 400 invalid_rootUrl when rootUrl is a random string', async () => {
    const stub = makeStubDetector({ changed: false, changedDocuments: [] });
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrl: 'just some words' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_rootUrl');
    expect(stub.calls.length).toBe(0);
  });

  it('returns 400 invalid_rootUrl for non-feishu https URL', async () => {
    const stub = makeStubDetector({ changed: false, changedDocuments: [] });
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrl: 'https://github.com/some/repo' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_rootUrl');
    expect(stub.calls.length).toBe(0);
  });

  it('returns 500 ChangeDetector_not_initialized when dependency missing', async () => {
    // Build app WITHOUT injecting changeDetector — simulates broken DI wiring.
    const app = buildApp({});

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrl: FEISHU_URL }),
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('ChangeDetector not initialized');
  });

  it('happy path: accepts Feishu wiki URL and forwards to ChangeDetector', async () => {
    const stubResult = {
      changed: true,
      changedDocuments: [{ title: 'doc1', changeType: 'added' }],
      checkedAt: '2026-06-22T00:00:00.000Z',
      totalNodes: 1,
    };
    const stub = makeStubDetector(stubResult);
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrl: FEISHU_URL }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(stubResult);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].rootUrl).toBe(FEISHU_URL);
  });

  it('happy path: accepts raw token and forwards to ChangeDetector', async () => {
    const stubResult = {
      changed: false,
      changedDocuments: [],
      checkedAt: '2026-06-22T00:00:00.000Z',
      totalNodes: 0,
    };
    const stub = makeStubDetector(stubResult);
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrl: RAW_TOKEN }),
      }),
    );
    expect(res.status).toBe(200);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].rootUrl).toBe(RAW_TOKEN);
  });

  it('forwards ChangeDetector errors as 500 without swallowing', async () => {
    const stub = makeStubDetector(null, true /* shouldThrow */);
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootUrl: FEISHU_URL }),
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Change detection failed');
    expect(body.message).toBe('stub failure');
  });
});

// ---------------------------------------------------------------------------
// POST /api/detect/changes-all (v0.2.0 multi-root-detect)
// ---------------------------------------------------------------------------

const ROOT_A = 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb';
const ROOT_B = 'https://qcnbafdrjx7n.feishu.cn/wiki/QdZpwOmgBi25JVkAUmYcBiMinIf';
const ROOT_C = 'https://qcnbafdrjx7n.feishu.cn/wiki/NudewPkE9inlGhkEDA1c9FSsnkb';
const ROOT_D = 'https://qcnbafdrjx7n.feishu.cn/wiki/FEaww3vUHieIumk6FdIc92WHnyh';

describe('POST /api/detect/changes-all', () => {
  it('returns 500 ChangeDetector_not_initialized when detector missing', async () => {
    const app = buildApp({
      configManager: makeStubConfig([ROOT_A]),
    });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('ChangeDetector not initialized');
  });

  it('returns 500 ConfigManager_not_initialized when config missing', async () => {
    const stub = makeStubDetector({ changed: false, changedDocuments: [] });
    const app = buildApp({ changeDetector: stub.instance });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('ConfigManager not initialized');
  });

  it('returns 400 no_watched_roots when config.watchedRootUrls is empty', async () => {
    const stub = makeStubDetector({ changed: false, changedDocuments: [] });
    const app = buildApp({
      changeDetector: stub.instance,
      configManager: makeStubConfig([]),
    });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('no_watched_roots');
    expect(stub.calls.length).toBe(0);
  });

  it('aggregates 4 watchedRoots sequentially in configured order', async () => {
    const perRoot = {
      [ROOT_A]: {
        result: {
          changed: true,
          changedDocuments: [{ title: 'A1', changeType: 'added' }],
          totalNodes: 35,
          checkedAt: '2026-06-22T00:00:00.000Z',
        },
      },
      [ROOT_B]: {
        result: {
          changed: false,
          changedDocuments: [],
          totalNodes: 55,
          checkedAt: '2026-06-22T00:00:01.000Z',
        },
      },
      [ROOT_C]: {
        result: {
          changed: true,
          changedDocuments: [{ title: 'C1', changeType: 'modified' }],
          totalNodes: 1,
          checkedAt: '2026-06-22T00:00:02.000Z',
        },
      },
      [ROOT_D]: {
        result: {
          changed: false,
          changedDocuments: [],
          totalNodes: 3,
          checkedAt: '2026-06-22T00:00:03.000Z',
        },
      },
    };
    const stub = makePerRootStub(perRoot);
    const app = buildApp({
      changeDetector: stub.instance,
      configManager: makeStubConfig([ROOT_A, ROOT_B, ROOT_C, ROOT_D]),
    });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(true);
    expect(body.totalNodes).toBe(35 + 55 + 1 + 3);
    expect(body.changedDocuments.length).toBe(2);
    expect(body.results.length).toBe(4);
    expect(body.results.map((r: any) => r.rootUrl)).toEqual([
      ROOT_A,
      ROOT_B,
      ROOT_C,
      ROOT_D,
    ]);
    expect(body.results.every((r: any) => r.status === 'ok')).toBe(true);
    expect(stub.calls.length).toBe(4);
    expect(stub.calls.map((c) => c.rootUrl)).toEqual([ROOT_A, ROOT_B, ROOT_C, ROOT_D]);
  });

  it('captures per-root failures without aborting the batch', async () => {
    const perRoot = {
      [ROOT_A]: {
        result: {
          changed: false,
          changedDocuments: [],
          totalNodes: 35,
          checkedAt: '2026-06-22T00:00:00.000Z',
        },
      },
      [ROOT_B]: { throw: 'stub failure' },
      [ROOT_C]: {
        result: {
          changed: true,
          changedDocuments: [{ title: 'C1', changeType: 'added' }],
          totalNodes: 1,
          checkedAt: '2026-06-22T00:00:02.000Z',
        },
      },
      [ROOT_D]: {
        result: {
          changed: false,
          changedDocuments: [],
          totalNodes: 3,
          checkedAt: '2026-06-22T00:00:03.000Z',
        },
      },
    };
    const stub = makePerRootStub(perRoot);
    const app = buildApp({
      changeDetector: stub.instance,
      configManager: makeStubConfig([ROOT_A, ROOT_B, ROOT_C, ROOT_D]),
    });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBe(4);
    const failed = body.results.find((r: any) => r.status === 'error');
    expect(failed).toBeDefined();
    expect(failed.rootUrl).toBe(ROOT_B);
    expect(failed.error).toBe('stub failure');
    expect(failed.result).toBeUndefined();
    const okRoots = body.results.filter((r: any) => r.status === 'ok');
    expect(okRoots.length).toBe(3);
    expect(body.totalNodes).toBe(35 + 1 + 3);
    expect(body.changed).toBe(true);
  });

  it('sets changed=false when every root reports no changes', async () => {
    const perRoot = {
      [ROOT_A]: {
        result: { changed: false, changedDocuments: [], totalNodes: 10, checkedAt: 't' },
      },
      [ROOT_B]: {
        result: { changed: false, changedDocuments: [], totalNodes: 20, checkedAt: 't' },
      },
    };
    const stub = makePerRootStub(perRoot);
    const app = buildApp({
      changeDetector: stub.instance,
      configManager: makeStubConfig([ROOT_A, ROOT_B]),
    });

    const res = await app.fetch(
      new Request('http://x/api/detect/changes-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(false);
    expect(body.changedDocuments.length).toBe(0);
    expect(body.totalNodes).toBe(30);
  });
});
