// server/tests/integration/optimisticLockRace.integration.test.js
//
// Regression coverage for the optimistic-lock RACE on the two flagship
// writers, PUT /api/treaties/:id and PUT /api/quotes/:id.
//
// assertEntityUnchanged takes its FOR UPDATE row lock on the transaction
// client — but both PUTs used to call it BEFORE `BEGIN`, so the lock lived
// in an implicit single-statement transaction and released immediately.
// Two concurrent saves carrying the SAME If-Unmodified-Since baseline could
// then both pass the check and both commit: the second silently overwrote
// the first (lost update), defeating the very protection the header opts
// into. The 40-underwriter agent simulation (load-test/agents) reproduced
// that outcome in 39 of 40 races before the fix.
//
// These tests race N concurrent same-baseline saves and require EXACTLY ONE
// winner; every loser must roll back atomically (no partial writes).
//
// Gated by TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools, seedRefs } from './helpers.js';

const RACERS = 8;

describe.skipIf(shouldSkipDb)('integration: same-baseline write races (optimistic lock)', () => {
  let harness;
  let refs;
  const createdTreaties = [];
  const createdQuotes = [];

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs();
  });

  afterAll(async () => {
    for (const id of createdQuotes) {
      try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch { /* cleanup */ }
    }
    for (const id of createdTreaties) {
      try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch { /* cleanup */ }
    }
    await harness.close();
    await closePools();
  });

  async function createTreaty() {
    const res = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: 2030, inception_date: '2030-01-01' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    createdTreaties.push(body.contract_id);
    return body.contract_id;
  }

  async function createQuote() {
    const res = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: 2030, inception_date: '2030-01-01' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    createdQuotes.push(body.quote_id);
    return body.quote_id;
  }

  it('treaty PUT: N same-baseline concurrent saves admit exactly one winner', async () => {
    const id = await createTreaty();
    const g0 = await harness.fetchApp('GET', `/api/treaties/${id}`);
    expect(g0.status).toBe(200);
    const baseline = (await g0.json()).updated_at;
    expect(baseline).toBeTruthy();

    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, i) => harness.fetchApp('PUT', `/api/treaties/${id}`, {
        headers: { 'if-unmodified-since': baseline },
        body: { terms: { header: { contract_description: `racer-${i}` } } },
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), i }))),
    );

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(RACERS - 1);
    for (const l of losers) expect(l.body?.code).toBe('STALE_WRITE');

    // The surviving row must carry the winner's payload — and only theirs.
    const g1 = await harness.fetchApp('GET', `/api/treaties/${id}`);
    const after = await g1.json();
    expect(after.header.contract_description).toBe(`racer-${winners[0].i}`);
  });

  it('quote PUT: N same-baseline concurrent saves admit exactly one winner', async () => {
    const id = await createQuote();
    const g0 = await harness.fetchApp('GET', `/api/quotes/${id}`);
    expect(g0.status).toBe(200);
    const baseline = (await g0.json()).updated_at;
    expect(baseline).toBeTruthy();

    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, i) => harness.fetchApp('PUT', `/api/quotes/${id}`, {
        headers: { 'if-unmodified-since': baseline },
        body: { terms: { header: { contract_description: `racer-${i}` } } },
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), i }))),
    );

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(RACERS - 1);
    for (const l of losers) expect(l.body?.code).toBe('STALE_WRITE');

    const g1 = await harness.fetchApp('GET', `/api/quotes/${id}`);
    const after = await g1.json();
    expect(after.header.contract_description).toBe(`racer-${winners[0].i}`);
  });

  it('a losing save rolls back atomically — no slice of it persists', async () => {
    const id = await createTreaty();
    const g0 = await harness.fetchApp('GET', `/api/treaties/${id}`);
    const baseline = (await g0.json()).updated_at;

    // Move the row on (winner), then race a stale multi-slice save.
    const win = await harness.fetchApp('PUT', `/api/treaties/${id}`, {
      headers: { 'if-unmodified-since': baseline },
      body: { terms: { header: { contract_description: 'winner' } } },
    });
    expect(win.status).toBe(200);

    const stale = await harness.fetchApp('PUT', `/api/treaties/${id}`, {
      headers: { 'if-unmodified-since': baseline },
      body: {
        terms: {
          header: { contract_description: 'loser' },
          detail: { qs_limit: 123456 },
          commissions: { mode: 'FIXED', fixed_commission_pct: 31 },
        },
      },
    });
    expect(stale.status).toBe(409);

    const g1 = await harness.fetchApp('GET', `/api/treaties/${id}`);
    const after = await g1.json();
    expect(after.header.contract_description).toBe('winner');
    // No prop-details / commissions row may exist at all yet, so normalise
    // "absent" and "NULL column" to the same expectation.
    expect(after.detail.qs_limit ?? null).toBeNull();
    expect(after.commissions.fixed_commission_pct ?? null).toBeNull();
  });
});
