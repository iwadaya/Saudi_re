// server/src/routes/clientEvents.test.js
// The router-level 20/min cap app.js relies on when it exempts /client-events
// from the global limiters. Runs the real router over HTTP (ephemeral listener)
// with an injected identity — no DB involved.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';

const { default: clientEventsRouter } = await import('./clientEvents.js');

let listener;
let baseUrl;
let currentUser = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use('/api', clientEventsRouter);
  listener = await new Promise((resolve) => { const l = app.listen(0, () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${listener.address().port}`;
});
afterAll(async () => { await new Promise((r) => listener.close(r)); });

async function post(body) {
  return fetch(`${baseUrl}/api/client-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /client-events rate limit (20/min per user)', () => {
  it('accepts a valid report, rejects an invalid one', async () => {
    currentUser = { userId: 'user-a' };
    const ok = await post({ type: 'boundary', message: 'boom' });
    expect(ok.status).toBe(204);
    const bad = await post({ type: 'boundary' }); // missing message
    expect(bad.status).toBe(400);
  });

  it('caps a single user at 20 requests/min with 429 after', async () => {
    currentUser = { userId: 'user-b' };
    const statuses = [];
    for (let i = 0; i < 22; i++) {
      const r = await post({ type: 'other', message: `event ${i}` });
      statuses.push(r.status);
      if (r.status === 429) {
        const body = await r.json();
        expect(body.error).toMatch(/Too many client events/);
        break;
      }
    }
    expect(statuses.filter((s) => s === 204).length).toBe(20);
    expect(statuses.at(-1)).toBe(429);
  });

  it('the cap is per-user: another user still gets through after one is throttled', async () => {
    // user-b is throttled from the previous test; user-c has a fresh bucket.
    currentUser = { userId: 'user-c' };
    const r = await post({ type: 'other', message: 'different bucket' });
    expect(r.status).toBe(204);
  });
});
