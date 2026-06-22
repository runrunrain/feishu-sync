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
