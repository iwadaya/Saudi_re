// server/tests/integration/pricingStrict.integration.test.js
//
// Server-side actuarial AUTHORITY check for the NP pricing save path.
//
// The pricing verifier (server/src/lib/pricingVerifier.js) re-derives each
// NP pricing output row server-side and compares it against the client-sent
// total_price. Two operating modes share one code path:
//
//   • warn-only (default)   — drift is logged + surfaced via the
//                             X-Pricing-Drift-Count header, but the save
//                             still succeeds.
//   • strict (PRICING_STRICT=1) — drift is rejected with 422 PRICING_DRIFT
//                             BEFORE anything is written.
//
// pricingVerifier.isStrictMode() reads process.env.PRICING_STRICT at call
// time, so flipping it inside a test changes behaviour for the very next
// request. The env-isolation setup (tests/setup/env-isolation.js) snapshots
// and restores process.env per test, so each case is hermetic.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';

// A self-consistent output row: blended = (40·10 + 30·10 + 30·10)/100 = 10,
// loading 0% → deriveComponentTotal === 10. total_price agrees ⇒ no drift.
const cleanOutput = () => ({
  layer_number: 1,
  section: 'AS_IF',
  pure_burning_cost: 10,
  pareto_pricing: 10,
  exposure_rating: 10,
  burn_weight_pct: 40,
  pareto_weight_pct: 30,
  exposure_weight_pct: 30,
  pricing_loading_pct: 0,
  total_price: 10,
});

// Same inputs (weights still sum to 100) but a fabricated total_price the
// canonical formula cannot reproduce ⇒ a single total_price drift.
const driftedOutput = () => ({ ...cleanOutput(), total_price: 25 });

describe.skipIf(shouldSkipDb)('integration: PRICING_STRICT server-side pricing authority', () => {
  let harness;
  let quoteId;

  beforeAll(async () => {
    harness = await bootApp();
    const refs = await seedRefs({ category: 'NON_PROPORTIONAL' });
    const q = await harness
      .fetchApp('POST', '/api/quotes', {
        body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
      })
      .then((r) => r.json());
    quoteId = q.quote_id;
    expect(quoteId).toBeTruthy();
  });

  afterAll(async () => {
    if (harness) {
      try { await harness.fetchApp('DELETE', `/api/quotes/${quoteId}`); } catch {}
      await harness.close();
    }
    await closePools();
  });

  it('warn-only (default): drifted pricing still saves but flags drift via header', async () => {
    delete process.env.PRICING_STRICT; // explicit: default warn-only mode
    const res = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/np-pricing`, {
      body: { outputs: [driftedOutput()] },
    });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('x-pricing-drift-count'))).toBeGreaterThanOrEqual(1);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('strict (PRICING_STRICT=1): drifted pricing is rejected with 422 PRICING_DRIFT', async () => {
    process.env.PRICING_STRICT = '1';
    const res = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/np-pricing`, {
      body: { outputs: [driftedOutput()] },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('PRICING_DRIFT');
    expect(Array.isArray(body.drifts)).toBe(true);
    expect(body.drifts.length).toBeGreaterThanOrEqual(1);
    expect(body.drifts.some((d) => d.field === 'total_price')).toBe(true);
  });

  it('strict (PRICING_STRICT=1): self-consistent pricing passes and saves', async () => {
    process.env.PRICING_STRICT = '1';
    const res = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/np-pricing`, {
      body: { outputs: [cleanOutput()] },
    });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('x-pricing-drift-count'))).toBe(0);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
