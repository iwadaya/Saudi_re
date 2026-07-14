// server/tests/integration/aggDrilldown.integration.test.js
//
// Regression coverage for GET /api/pricing/agg-drilldown/:id (the shared
// Aggregate Analysis panel).
//
// CRESTA rows are stored per (treaty_type, cob, country, zone) slice, so a
// zone legitimately spans several rows. The drilldown must aggregate them to
// ONE row per zone — the original query returned raw rows, which made every
// zone repeat once per slice in the "By Zone" tab.
//
// Also locks in `contract.portfolio_includes_contract`: bound contracts are
// part of the country book (so a share scenario first removes their 100%
// contribution), quotes are not (their share is purely additive).
//
// Gated by TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools, seedRefs } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: aggregate drilldown zone aggregation', () => {
  let harness;
  let refs;
  const createdQuotes = [];
  const createdTreaties = [];

  beforeAll(async () => { harness = await bootApp(); refs = await seedRefs(); });

  afterAll(async () => {
    for (const id of createdQuotes) {
      try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {}
    }
    for (const id of createdTreaties) {
      try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch {}
    }
    await harness.close();
    await closePools();
  });

  async function putSlices(kind, id) {
    // Two slices (different treaty_type) that both contain zone 01 — the
    // exact shape that produced duplicate zone rows in the drilldown.
    const base = kind === 'quote' ? `/api/quotes/${id}/cresta` : `/api/treaties/${id}/cresta`;
    const a = await harness.fetchApp('PUT', base, {
      body: {
        country_id: refs.country_id,
        treaty_type: 'Prop',
        rows: [
          { country_id: refs.country_id, zone_id: '01', zone_name: 'Tokyo', eq_agg: 100 },
          { country_id: refs.country_id, zone_id: '02', zone_name: 'Osaka', eq_agg: 200 },
        ],
      },
    });
    expect(a.status).toBe(200);
    const b = await harness.fetchApp('PUT', base, {
      body: {
        country_id: refs.country_id,
        treaty_type: 'NonProp',
        rows: [{ country_id: refs.country_id, zone_id: '01', zone_name: 'Tokyo', ws_agg: 50 }],
      },
    });
    expect(b.status).toBe(200);
  }

  it('returns one row per zone for a quote, and flags it as outside the portfolio', async () => {
    const create = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: 2026, status: 'DRAFT', experience_source: 'TRIANGLE', inception_date: '2026-01-01' },
    });
    expect(create.status).toBe(201);
    const { quote_id: quoteId } = await create.json();
    createdQuotes.push(quoteId);

    await putSlices('quote', quoteId);

    const res = await harness.fetchApp('GET', `/api/pricing/agg-drilldown/${quoteId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.contract.portfolio_includes_contract).toBe(false);

    const zoneIds = body.zones.map((z) => z.zone_id);
    expect(zoneIds).toHaveLength(new Set(zoneIds).size); // no repeated zones
    expect(body.zones).toHaveLength(2);

    const tokyo = body.zones.find((z) => z.zone_id === '01');
    expect(tokyo.zone_name).toBe('Tokyo');
    expect(Number(tokyo.eq_agg)).toBe(100);
    expect(Number(tokyo.ws_agg)).toBe(50);
    expect(Number(tokyo.total_agg)).toBe(150);
  });

  it('returns one row per zone for a bound contract, flagged as inside the portfolio', async () => {
    const create = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: 2026, status: 'DRAFT', experience_source: 'TRIANGLE', inception_date: '2026-01-01' },
    });
    expect(create.status).toBe(201);
    const { contract_id: contractId } = await create.json();
    createdTreaties.push(contractId);

    await putSlices('contract', contractId);

    const res = await harness.fetchApp('GET', `/api/pricing/agg-drilldown/${contractId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.contract.portfolio_includes_contract).toBe(true);

    expect(body.zones).toHaveLength(2);
    const tokyo = body.zones.find((z) => z.zone_id === '01');
    expect(Number(tokyo.total_agg)).toBe(150);

    // The country-portfolio zone rollup must be deduped the same way and
    // include this contract's own rows.
    const portfolioTokyo = body.portfolio.zones.find((z) => z.zone_id === '01');
    expect(portfolioTokyo).toBeTruthy();
    expect(Number(portfolioTokyo.total_agg)).toBeGreaterThanOrEqual(150);
    const portfolioZoneIds = body.portfolio.zones.map((z) => z.zone_id);
    expect(portfolioZoneIds).toHaveLength(new Set(portfolioZoneIds).size);
  });
});
