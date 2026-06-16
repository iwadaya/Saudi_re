// server/tests/integration/npExpiring.integration.test.js
//
// Round-trip for the NP (non-prop) expiring structure on both sides of
// the quote/treaty duality. The two endpoints share a single handler via
// entityContext(req) so the fields that land on disk for a quote must
// come back out of the equivalent treaty endpoint the same way. If the
// dual routes drift, this test screams.
//
// Covers:
//   • POST  /api/treaties                      (fresh blank contract)
//   • PUT   /api/treaties/:id/np/expiring      (save layers + terms)
//   • GET   /api/treaties/:id/np/expiring      (reads back what we wrote)
//   • Quote variant of the same pair           (/api/quotes/:id/np/expiring)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools, seedRefs } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: NP expiring structure round-trip', () => {
  let harness;
  let refs;
  const createdTreaties = [];
  const createdQuotes = [];

  beforeAll(async () => { harness = await bootApp(); refs = await seedRefs({ category: 'NON_PROPORTIONAL' }); });
  afterAll(async () => {
    for (const id of createdTreaties) {
      try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch {}
    }
    for (const id of createdQuotes) {
      try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {}
    }
    await harness.close();
    await closePools();
  });

  it('treaty: PUT layers + terms → GET returns the same values', async () => {
    const c = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: 2026, inception_date: '2026-01-01' },
    }).then((r) => r.json());
    createdTreaties.push(c.contract_id);

    const layers = [
      { layer_number: 1, attachment: 1_000_000, layer_limit: 5_000_000, egnpi: 20_000_000, rate: 0.0234, peril_scope: 'BOTH' },
      { layer_number: 2, attachment: 6_000_000, layer_limit: 10_000_000, egnpi: 20_000_000, rate: 0.0112, peril_scope: 'CAT' },
    ];
    const terms = {
      egnpi: 20_000_000, deductible: 250_000,
      risk_limit: 5_000_000, cat_limit: 10_000_000,
      brokerage_pct: 10, no_claims_bonus_pct: 0, profit_commission_pct: 15,
      notes: 'np-expiring-integration',
    };

    const put = await harness.fetchApp('PUT', `/api/treaties/${c.contract_id}/np/expiring`, {
      body: { layers, terms, coveredProps: ['PROP-A', 'PROP-B'] },
    });
    expect(put.status).toBe(200);

    const get = await harness.fetchApp('GET', `/api/treaties/${c.contract_id}/np/expiring`);
    expect(get.status).toBe(200);
    const body = await get.json();

    expect(body.layers).toHaveLength(2);
    // Layers come back ordered by layer_number
    expect(body.layers[0].layer_number).toBe(1);
    expect(Number(body.layers[0].layer_limit)).toBe(5_000_000);
    expect(body.layers[1].peril_scope).toBe('CAT');
    expect(Number(body.terms.brokerage_pct)).toBe(10);
    expect(body.terms.notes).toBe('np-expiring-integration');
    expect(body.coveredProps).toEqual(['PROP-A', 'PROP-B']);
  });

  it('treaty: re-PUT with fewer layers replaces the prior set (no stale rows)', async () => {
    const c = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: 2026, inception_date: '2026-01-01' },
    }).then((r) => r.json());
    createdTreaties.push(c.contract_id);

    // Save three layers
    await harness.fetchApp('PUT', `/api/treaties/${c.contract_id}/np/expiring`, {
      body: {
        layers: [
          { layer_number: 1, attachment: 1, layer_limit: 10, egnpi: 100, rate: 0.1 },
          { layer_number: 2, attachment: 11, layer_limit: 20, egnpi: 100, rate: 0.2 },
          { layer_number: 3, attachment: 31, layer_limit: 30, egnpi: 100, rate: 0.3 },
        ],
        terms: { egnpi: 100 },
      },
    });

    // Replace with one layer
    await harness.fetchApp('PUT', `/api/treaties/${c.contract_id}/np/expiring`, {
      body: {
        layers: [{ layer_number: 1, attachment: 1, layer_limit: 99, egnpi: 200, rate: 0.5 }],
        terms: { egnpi: 200 },
      },
    });

    const body = await harness.fetchApp('GET', `/api/treaties/${c.contract_id}/np/expiring`).then((r) => r.json());
    expect(body.layers).toHaveLength(1);
    expect(Number(body.layers[0].layer_limit)).toBe(99);
    expect(Number(body.terms.egnpi)).toBe(200);
  });

  it('quote: the /api/quotes/:id/np/expiring alias round-trips too', async () => {
    // Quote creation mirrors treaty creation on the same endpoint
    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01' },
    }).then((r) => r.json());
    const qid = q.quote_id || q.id;
    createdQuotes.push(qid);

    const put = await harness.fetchApp('PUT', `/api/quotes/${qid}/np/expiring`, {
      body: {
        layers: [{ layer_number: 1, attachment: 500_000, layer_limit: 2_000_000, egnpi: 10_000_000, rate: 0.04 }],
        terms: { egnpi: 10_000_000, risk_limit: 2_000_000 },
      },
    });
    expect(put.status).toBe(200);

    const body = await harness.fetchApp('GET', `/api/quotes/${qid}/np/expiring`).then((r) => r.json());
    expect(body.layers).toHaveLength(1);
    expect(Number(body.layers[0].attachment)).toBe(500_000);
    expect(Number(body.terms.risk_limit)).toBe(2_000_000);
  });

  it('GET on an empty treaty returns the zero-layers shape without throwing', async () => {
    const c = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: 2026, inception_date: '2026-01-01' },
    }).then((r) => r.json());
    createdTreaties.push(c.contract_id);

    const res = await harness.fetchApp('GET', `/api/treaties/${c.contract_id}/np/expiring`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.layers)).toBe(true);
    expect(body.layers).toHaveLength(0);
    // terms may be null for a blank contract
    expect(body.terms === null || typeof body.terms === 'object').toBe(true);
  });
});
