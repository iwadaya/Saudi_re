// server/tests/integration/cresta.integration.test.js
//
// Round-trip + slice-semantics test for CRESTA aggregates. Both quote
// and treaty endpoints share saveCrestaSlice() under the hood, so the
// quote path is exercised here as the canonical case (cheaper to set
// up — POST /api/quotes returns a quote_id directly) and the treaty
// path is exercised with a single round-trip to confirm the kind
// switch works.
//
// What we lock in:
//   1. PUT then GET returns identical numeric/text values (DB save
//      really happened, types coerced as expected).
//   2. Re-PUTting the same slice key replaces (not appends) — the
//      DELETE-then-INSERT contract is the whole reason we serialise
//      with pg_advisory_xact_lock and the unique index on the slice
//      tuple. A regression here means double rows in production.
//   3. Different slice keys (different country_id) coexist on the
//      same parent — saves are scoped, not global.
//   4. Validation rejects bad payloads (negative aggregates,
//      percentages > 100) with 400. Schema-level guards already have
//      unit coverage; this confirms the route wiring routes them to
//      the validator, not straight to the DB.
//
// Gated by TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

const COUNTRY_A = '11111111-1111-1111-1111-111111111111';
const COUNTRY_B = '22222222-2222-2222-2222-222222222222';

describe.skipIf(shouldSkipDb)('integration: CRESTA aggregates round-trip + slice semantics', () => {
  let harness;
  const createdQuotes = [];
  const createdTreaties = [];

  beforeAll(async () => { harness = await bootApp(); });

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

  async function newQuote() {
    const res = await harness.fetchApp('POST', '/api/quotes', {
      body: { uw_year: 2026, status: 'DRAFT', experience_source: 'TRIANGLE', inception_date: '2026-01-01' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.quote_id).toBeTruthy();
    createdQuotes.push(body.quote_id);
    return body.quote_id;
  }

  it('PUT then GET round-trips numeric values and percentages on a quote', async () => {
    const quoteId = await newQuote();

    const put = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cresta`, {
      body: {
        country_id: COUNTRY_A,
        treaty_type: 'Both',
        rows: [
          {
            country_id: COUNTRY_A,
            zone_id: '01',
            zone_name: 'Tokyo',
            eq_agg: '1,000,000',
            ws_agg: 250000,
            flood_agg: 0,
            srcc_agg: '',
            others_agg: null,
            residential_bldg_pct: 40,
            commercial_bldg_pct: 30,
            commercial_cont_pct: 10,
            industrial_bldg_pct: 15,
            industrial_cont_pct: 5,
          },
        ],
      },
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const get = await harness.fetchApp('GET', `/api/quotes/${quoteId}/cresta`);
    expect(get.status).toBe(200);
    const rows = await get.json();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.zone_id).toBe('01');
    expect(r.zone_name).toBe('Tokyo');
    // NUMERIC columns return as strings from pg by default.
    expect(Number(r.eq_agg)).toBe(1_000_000);
    expect(Number(r.ws_agg)).toBe(250_000);
    expect(Number(r.flood_agg)).toBe(0);
    // '' and null both become null per numOrNull / save logic.
    expect(r.srcc_agg).toBeNull();
    expect(r.others_agg).toBeNull();
    expect(Number(r.residential_bldg_pct)).toBe(40);
    expect(Number(r.industrial_cont_pct)).toBe(5);
    expect(r.treaty_type).toBe('Both');
    expect(r.country_id).toBe(COUNTRY_A);
  });

  it('re-PUTting the same slice replaces (does not append) rows', async () => {
    const quoteId = await newQuote();

    const slice = {
      country_id: COUNTRY_A,
      treaty_type: 'Both',
      rows: [
        { country_id: COUNTRY_A, zone_id: '01', zone_name: 'Tokyo',  eq_agg: 100 },
        { country_id: COUNTRY_A, zone_id: '02', zone_name: 'Osaka',  eq_agg: 200 },
      ],
    };

    const first = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cresta`, { body: slice });
    expect(first.status).toBe(200);

    // Same slice, fewer rows — must REPLACE the previous two.
    const second = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cresta`, {
      body: { ...slice, rows: [{ country_id: COUNTRY_A, zone_id: '03', zone_name: 'Kyoto', eq_agg: 300 }] },
    });
    expect(second.status).toBe(200);

    const get = await harness.fetchApp('GET', `/api/quotes/${quoteId}/cresta`);
    const rows = await get.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].zone_id).toBe('03');
    expect(Number(rows[0].eq_agg)).toBe(300);
  });

  it('different country slices coexist on the same quote', async () => {
    const quoteId = await newQuote();

    const a = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cresta`, {
      body: {
        country_id: COUNTRY_A,
        treaty_type: 'Both',
        rows: [{ country_id: COUNTRY_A, zone_id: '01', zone_name: 'Tokyo', eq_agg: 100 }],
      },
    });
    expect(a.status).toBe(200);

    const b = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cresta`, {
      body: {
        country_id: COUNTRY_B,
        treaty_type: 'Both',
        rows: [{ country_id: COUNTRY_B, zone_id: 'X1', zone_name: 'Berlin', eq_agg: 500 }],
      },
    });
    expect(b.status).toBe(200);

    const get = await harness.fetchApp('GET', `/api/quotes/${quoteId}/cresta`);
    const rows = await get.json();
    expect(rows).toHaveLength(2);
    const byCountry = Object.fromEntries(rows.map((r) => [r.country_id, r]));
    expect(byCountry[COUNTRY_A].zone_id).toBe('01');
    expect(byCountry[COUNTRY_B].zone_id).toBe('X1');
  });

  it('rejects negative aggregates and >100% percentages with 400', async () => {
    const quoteId = await newQuote();

    const negative = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cresta`, {
      body: { rows: [{ zone_id: '01', eq_agg: -1 }] },
    });
    expect(negative.status).toBe(400);

    const overPct = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cresta`, {
      body: { rows: [{ zone_id: '01', residential_bldg_pct: 150 }] },
    });
    expect(overPct.status).toBe(400);
  });

  it('treaty endpoint round-trips through the same save helper', async () => {
    const create = await harness.fetchApp('POST', '/api/treaties', {
      body: { uw_year: 2026, status: 'DRAFT', experience_source: 'TRIANGLE', inception_date: '2026-01-01' },
    });
    expect(create.status).toBe(201);
    const { contract_id } = await create.json();
    expect(contract_id).toBeTruthy();
    createdTreaties.push(contract_id);

    const put = await harness.fetchApp('PUT', `/api/treaties/${contract_id}/cresta`, {
      body: {
        country_id: COUNTRY_A,
        treaty_type: 'Both',
        rows: [{ country_id: COUNTRY_A, zone_id: '01', zone_name: 'Tokyo', eq_agg: 777 }],
      },
    });
    expect(put.status).toBe(200);

    const get = await harness.fetchApp('GET', `/api/treaties/${contract_id}/cresta`);
    expect(get.status).toBe(200);
    const rows = await get.json();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].eq_agg)).toBe(777);
    expect(rows[0].country_id).toBe(COUNTRY_A);
  });
});
