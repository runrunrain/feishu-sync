import { describe, expect, it } from 'vitest';

const { Hono } = require('hono');
import { mappingRoutes } from '../src/routes/mapping.js';

function buildApp(localMapStore: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (context: any, next: () => Promise<void>) => {
    context.localMapStore = localMapStore;
    await next();
  });
  app.route('/', mappingRoutes);
  return app;
}

describe('missing deletion candidate routes', () => {
  it('lists candidates without constructing unrelated mapping dependencies', async () => {
    const candidates = [{ objToken: 'candidate-1', syncState: 'missing_candidate' }];
    const app = buildApp({
      listMissingCandidates: () => candidates,
      confirmMissingCandidateDeletion: () => false,
    });

    const response = await app.fetch(new Request('http://x/api/mapping/missing-candidates'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ candidates });
  });

  it('requires a literal DELETE confirmation before mutating candidate state', async () => {
    let confirmations = 0;
    const app = buildApp({
      listMissingCandidates: () => [],
      confirmMissingCandidateDeletion: () => {
        confirmations += 1;
        return true;
      },
    });

    const response = await app.fetch(new Request('http://x/api/mapping/missing-candidates/candidate-1/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'delete' }),
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('confirmation_required');
    expect(confirmations).toBe(0);
  });

  it('confirms a current candidate and rejects a stale candidate', async () => {
    const calls: Array<{ objToken: string; confirmedAt: string }> = [];
    let candidateIsCurrent = true;
    const app = buildApp({
      listMissingCandidates: () => [],
      confirmMissingCandidateDeletion: (objToken: string, confirmedAt: string) => {
        calls.push({ objToken, confirmedAt });
        return candidateIsCurrent;
      },
    });

    const confirmed = await app.fetch(new Request('http://x/api/mapping/missing-candidates/candidate-1/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    }));
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ confirmed: true, objToken: 'candidate-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ objToken: 'candidate-1' });
    expect(calls[0].confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    candidateIsCurrent = false;
    const stale = await app.fetch(new Request('http://x/api/mapping/missing-candidates/candidate-1/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe('candidate_not_found_or_stale');
  });
});
