/**
 * P5 CORS middleware tests (P0-bug-1 regression coverage).
 *
 * Reproduces the dev:all failure reported in wukong P5 §5.1 P0-bug-1:
 * when the server runs in standalone/dev mode (desktopMode=false), the
 * browser at http://localhost:5173 must receive a permissive
 * Access-Control-Allow-Origin so vite's cross-origin requests to
 * http://127.0.0.1:3001 succeed.
 *
 * Strategy: invoke corsMiddleware directly with the options that
 * index.ts now passes (devMode = !desktopMode) and exercise the
 * resulting handler against both desktop and dev origins.
 */

import { describe, it, expect } from 'vitest';
import { corsMiddleware } from '../src/middleware/cors.js';
import { Hono } from 'hono';

function buildApp(devMode: boolean) {
  const app = new Hono();
  app.use('*', corsMiddleware({ devMode }));
  app.get('/probe', (c) => c.json({ ok: true }));
  app.get('/api/anything', (c) => c.json({ ok: true }));
  return app;
}

async function options(app: any, origin: string) {
  return app.fetch(
    new Request('http://127.0.0.1:3001/api/anything', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-desktop-token',
      },
    }),
  );
}

describe('corsMiddleware devMode=true (dev:all / standalone)', () => {
  const app = buildApp(true);

  it('accepts vite origin http://localhost:5173', async () => {
    const res = await options(app, 'http://localhost:5173');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173',
    );
  });

  it('accepts vite origin http://127.0.0.1:5173', async () => {
    const res = await options(app, 'http://127.0.0.1:5173');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://127.0.0.1:5173',
    );
  });

  it('rejects random foreign origin', async () => {
    const res = await options(app, 'https://evil.example.com');
    // hono/cors returns 204 with no allow-origin header when origin gated.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('corsMiddleware devMode=false (Electron desktop)', () => {
  const app = buildApp(false);

  it('accepts app://feishu-sync.local', async () => {
    const res = await options(app, 'app://feishu-sync.local');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'app://feishu-sync.local',
    );
  });

  it('rejects localhost:5173 in desktop mode (production Electron same-origin)', async () => {
    const res = await options(app, 'http://localhost:5173');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
