// server/tests/integration/quoteNpPricingInputs.integration.test.js
//
// SERVER PARITY AUDIT (regression lock) for the quote-mode NP pricing engine.
//
// calcLayerPricing(api, id, layers, detail, mode, quoteMode=true) fetches every
// actuarial input from the /api/quotes/:id/* routes. For quote pricing to match
// a bound non-prop treaty, each of those quote routes must read/write the
// quote_* (or shared-with-quote_id) tables and return the SAME shape as its
// /api/treaties/:id/* twin. This test seeds each input through the quote PUT and
// reads it back through the quote GET, and — for the risk profile that drives
// MBBEFD exposure rating — proves quote and contract storage are independent.
//
// Endpoints covered (one per engine fetch):
//   • large-losses                       getLargeLosses
//   • cat-losses                         getCatLosses
//   • loss-selection/:type/latest        getLossSelectionLatest
//   • risk-profiles/:cobId               getRiskProfile   ← explicit (MBBEFD)
//   • cresta                             getCrestaData
//   • np/egnpi-year                      getNpEgnpiYear
//   • cobs                               getContractCobs
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const N = (v) => Number(v);

describe.skipIf(shouldSkipDb)('integration: quote-mode NP pricing inputs (engine parity)', () => {
  let harness;
  let refs;
  let cobId;
  let quoteId;
  let contractId;
  const createdQuoteIds = [];
  const createdContractIds = [];

  async function seedRefs() {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const code = suffix.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase();
    const [country, currency, broker, cedant, treatyType, cob] = await Promise.all([
      pool.query(`INSERT INTO public.country (country_code, country_name, region, is_active) VALUES ($1,$2,'R',false) RETURNING country_id`, [`Z${code}`, `QP Country ${suffix}`]),
      pool.query(`INSERT INTO public.currency (currency_code, currency_name, is_active) VALUES ($1,$2,false) RETURNING currency_id`, [`X${code}`, `QP Currency ${suffix}`]),
      pool.query(`INSERT INTO public.brokers (broker_name, is_active) VALUES ($1,false) RETURNING broker_id`, [`QP Broker ${suffix}`]),
      pool.query(`INSERT INTO public.companies (company_name, is_active) VALUES ($1,false) RETURNING company_id`, [`QP Cedant ${suffix}`]),
      pool.query(`INSERT INTO public.treaty_type (treaty_type, category, is_active) VALUES ($1,'NON_PROPORTIONAL',false) RETURNING treaty_type_id`, [`QP TType ${suffix}`]),
      pool.query(`INSERT INTO public.class_of_business (class_of_business, code, is_active) VALUES ($1,$2,false) RETURNING class_of_business_id`, [`QP Motor ${suffix}`, `M${code}`.slice(0, 10)]),
    ]);
    cobId = cob.rows[0].class_of_business_id;
    return {
      cedant_id: cedant.rows[0].company_id,
      broker_id: broker.rows[0].broker_id,
      currency_id: currency.rows[0].currency_id,
      country_id: country.rows[0].country_id,
      treaty_type_id: treatyType.rows[0].treaty_type_id,
    };
  }

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs();
    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: 2026, status: 'DRAFT', experience_source: 'TRIANGLE', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
    }).then((r) => r.json());
    quoteId = q.quote_id;
    createdQuoteIds.push(quoteId);
    const c = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: 2026, status: 'DRAFT', experience_source: 'TRIANGLE', inception_date: '2026-01-01' },
    }).then((r) => r.json());
    contractId = c.contract_id;
    createdContractIds.push(contractId);
  });

  afterAll(async () => {
    if (harness) {
      for (const id of createdQuoteIds) { try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {} }
      for (const id of createdContractIds) { try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  it('large-losses: quote PUT → quote GET round-trips losses (shared table, quote_id FK)', async () => {
    const put = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/large-losses`, {
      body: { report_date: '2026-01-01', losses: [
        { uw_year: 2021, loss_name: 'LL-A', class_of_business: 'Motor', incurred: 1_200_000, is_selected: true },
        { uw_year: 2022, loss_name: 'LL-B', class_of_business: 'Motor', incurred: 900_000, is_selected: true },
      ] },
    });
    expect(put.status).toBe(200);
    const get = await harness.fetchApp('GET', `/api/quotes/${quoteId}/large-losses`).then((r) => r.json());
    expect(get.losses).toHaveLength(2);
    expect(get.losses.map((l) => N(l.incurred)).sort((a, b) => a - b)).toEqual([900_000, 1_200_000]);
  });

  it('cat-losses: quote PUT → quote GET round-trips losses', async () => {
    const put = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cat-losses`, {
      body: { report_date: '2026-01-01', losses: [
        { uw_year: 2020, loss_name: 'CAT-A', class_of_business: 'Motor', incurred: 5_000_000, is_selected: true },
      ] },
    });
    expect(put.status).toBe(200);
    const get = await harness.fetchApp('GET', `/api/quotes/${quoteId}/cat-losses`).then((r) => r.json());
    expect(get.losses).toHaveLength(1);
    expect(N(get.losses[0].incurred)).toBe(5_000_000);
  });

  it('loss-selection latest: quote snapshot PUT → quote GET returns the snapshot', async () => {
    const put = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/loss-selection/large/snapshot`, {
      body: {
        pareto_alpha: 1.8, pareto_xm: 250_000, observation_years: 10, threshold: 250_000,
        selected_losses: [{ uw_year: 2021, incurred: 1_200_000, inflation_factor: 1 }],
      },
    });
    expect(put.status).toBe(200);
    const get = await harness.fetchApp('GET', `/api/quotes/${quoteId}/loss-selection/large/latest`).then((r) => r.json());
    expect(get.snapshot).toBeTruthy();
    expect(N(get.snapshot.pareto_alpha)).toBeCloseTo(1.8, 4);
    expect(N(get.snapshot.observation_years)).toBe(10);
  });

  it('risk-profiles: quote PUT → quote GET round-trips curve + bands (drives MBBEFD)', async () => {
    const put = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/risk-profiles/${cobId}`, {
      body: {
        pml_percentage: 60, selected_curve: 'Y3', gross_loss_ratio: 55,
        bands: [
          { from_amt: 0, to_amt: 1_000_000, no_of_risks: 100, total_sum_insured: 100_000_000, gross_premium: 500_000 },
          { from_amt: 1_000_000, to_amt: 5_000_000, no_of_risks: 50, total_sum_insured: 100_000_000, gross_premium: 400_000 },
        ],
      },
    });
    expect(put.status).toBe(200);
    const get = await harness.fetchApp('GET', `/api/quotes/${quoteId}/risk-profiles/${cobId}`).then((r) => r.json());
    expect(get.profile).toBeTruthy();
    expect(get.profile.selected_curve).toBe('Y3');           // engine: curve selection
    expect(N(get.profile.pml_percentage)).toBeCloseTo(60, 4); // engine: PML
    expect(N(get.profile.gross_loss_ratio)).toBeCloseTo(55, 4); // engine: Step-8 multiplier
    expect(get.bands).toHaveLength(2);                         // engine: MBBEFD bands
    expect(N(get.bands[0].no_of_risks)).toBe(100);
    expect(N(get.bands[0].total_sum_insured)).toBe(100_000_000);
  });

  it('risk-profiles: quote and contract storage are independent (quote flag honoured)', async () => {
    // Contract gets a DIFFERENT curve under the SAME cobId.
    const put = await harness.fetchApp('PUT', `/api/treaties/${contractId}/risk-profiles/${cobId}`, {
      body: { pml_percentage: 80, selected_curve: 'Y1', bands: [{ from_amt: 0, to_amt: 500_000, no_of_risks: 10, total_sum_insured: 5_000_000 }] },
    });
    expect(put.status).toBe(200);
    const contractGet = await harness.fetchApp('GET', `/api/treaties/${contractId}/risk-profiles/${cobId}`).then((r) => r.json());
    const quoteGet = await harness.fetchApp('GET', `/api/quotes/${quoteId}/risk-profiles/${cobId}`).then((r) => r.json());
    expect(contractGet.profile.selected_curve).toBe('Y1');   // contract_risk_profile
    expect(quoteGet.profile.selected_curve).toBe('Y3');      // quote_risk_profile — untouched
    expect(N(quoteGet.profile.pml_percentage)).toBeCloseTo(60, 4);
  });

  it('cresta: quote PUT → quote GET round-trips zone aggregates', async () => {
    const put = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cresta`, {
      body: {
        treaty_type: 'Both', country_id: refs.country_id, cob_id: cobId,
        rows: [{ country_id: refs.country_id, zone_id: 'Z1', zone_name: 'Zone 1', eq_agg: 1_000_000, ws_agg: 500_000, flood_agg: 0, srcc_agg: 0, others_agg: 0 }],
      },
    });
    expect(put.status).toBe(200);
    const rows = await harness.fetchApp('GET', `/api/quotes/${quoteId}/cresta`).then((r) => r.json());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const z1 = rows.find((r) => r.zone_id === 'Z1');
    expect(z1).toBeTruthy();
    expect(N(z1.eq_agg)).toBe(1_000_000);
  });

  it('np/egnpi-year: quote PUT → quote GET round-trips per-year EGNPI', async () => {
    const put = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/np/egnpi-year`, {
      body: { rows: [
        { uw_year: 2021, egnpi: 40_000_000, inflation_pct: 5, rate_change_pct: 2 },
        { uw_year: 2022, egnpi: 45_000_000, inflation_pct: 4, rate_change_pct: 1 },
      ] },
    });
    expect(put.status).toBe(200);
    const rows = await harness.fetchApp('GET', `/api/quotes/${quoteId}/np/egnpi-year`).then((r) => r.json());
    expect(rows).toHaveLength(2);
    const y2021 = rows.find((r) => N(r.uw_year) === 2021);
    expect(N(y2021.egnpi)).toBe(40_000_000);
  });

  it('cobs: quote PUT → quote GET returns the linked class-of-business', async () => {
    const put = await harness.fetchApp('PUT', `/api/quotes/${quoteId}/cobs`, { body: { class_ids: [cobId] } });
    expect(put.status).toBe(200);
    const rows = await harness.fetchApp('GET', `/api/quotes/${quoteId}/cobs`).then((r) => r.json());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r) => String(r.class_of_business_id) === String(cobId))).toBe(true);
  });
});
