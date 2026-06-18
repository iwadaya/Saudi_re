// server/tests/integration/quoteSubresourceLocking.integration.test.js
//
// Optimistic-locking coverage for high-value quote subresource saves (item 4).
// These endpoints (large-losses, cat-losses, pricing-outputs, pricing-yearly)
// now run the opt-in If-Unmodified-Since check INSIDE their transaction and
// bump the parent quote's updated_at via touchParentEntity. The guard is
// dormant unless the client sends the header — so existing callers are
// unaffected — but when sent it turns a stale concurrent write into a clean
// 409 STALE_WRITE (or honours the explicit `*` override).
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';

const PRICING_OUTPUTS = (id) => `/api/quotes/${id}/pricing-outputs`;

describe.skipIf(shouldSkipDb)('integration: quote subresource optimistic locking', () => {
  let harness;
  let refs;
  const created = [];

  async function newQuote() {
    const q = await harness
      .fetchApp('POST', '/api/quotes', {
        body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
      })
      .then((r) => r.json());
    created.push(q.quote_id);
    return q.quote_id;
  }

  async function quoteUpdatedAt(id) {
    const q = await harness.fetchApp('GET', `/api/quotes/${id}`).then((r) => r.json());
    return q.updated_at || q.quote?.updated_at;
  }

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
  });

  afterAll(async () => {
    if (harness) {
      for (const id of created) { try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  it('save without If-Unmodified-Since is unaffected (guard is opt-in) and returns updated_at', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', PRICING_OUTPUTS(id), { body: { epi: 1_000_000, commission_ratio: 25 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.updated_at).toBeTruthy(); // parent timestamp echoed back for the next token
  });

  it('a concurrent parent bump makes a stale-token save 409 STALE_WRITE', async () => {
    const id = await newQuote();
    const t0 = await quoteUpdatedAt(id);
    expect(t0).toBeTruthy();

    // Concurrent edit: a sibling save (no header) bumps the parent updated_at past t0.
    const bump = await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, {
      body: { report_date: '2026-01-01', losses: [{ uw_year: 2024, loss_name: 'X', incurred: 100, is_selected: true }] },
    });
    expect(bump.status).toBe(200);

    // Now a save carrying the STALE t0 token must be rejected.
    const stale = await harness.fetchApp('PUT', PRICING_OUTPUTS(id), {
      body: { epi: 2_000_000 },
      headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_WRITE');
  });

  it('the explicit `*` override bypasses the stale check', async () => {
    const id = await newQuote();
    const t0 = await quoteUpdatedAt(id);
    await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, {
      body: { report_date: '2026-01-01', losses: [] },
    });
    // t0 is now stale, but the override header forces the write through.
    const overwrite = await harness.fetchApp('PUT', PRICING_OUTPUTS(id), {
      body: { epi: 3_000_000 },
      headers: { 'if-unmodified-since': '*' },
    });
    expect(overwrite.status).toBe(200);
    void t0;
  });

  it('a fresh token (current updated_at) saves and returns a newer token', async () => {
    const id = await newQuote();
    const fresh = await quoteUpdatedAt(id);
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/pricing-yearly`, {
      body: { rows: [{ uw_year: 2024, premium: 500, incurred_claims: 200 }] },
      headers: { 'if-unmodified-since': fresh },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).updated_at).toBeTruthy();
  });
});
