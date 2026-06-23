// server/tests/integration/dashboardPortfolioOverview.integration.test.js
//
// Behaviour pin for GET /api/dashboard/page/portfolio-overview. The tab fans a
// shared prop+NP `units` set into seven aggregates (KPIs, region/LOB summaries,
// month series, region×treaty / lob×treaty / lob×region pivots). This test seeds
// a small, deterministic portfolio — isolated by a unique uw_year so the ?uwYear
// filter never sees other rows — and asserts the exact roll-ups, so a refactor of
// how `units` is materialised cannot silently change the numbers.
//
// Skipped by default; run with TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

// Astronomically unlikely uw_year so the ?uwYear filter isolates THIS test's
// contracts from any other data or test sharing the DB.
const UW_YEAR = 4000 + Math.floor(Math.random() * 5000);

async function one(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

describe.skipIf(shouldSkipDb)('integration: dashboard portfolio-overview aggregation', () => {
  let harness;
  const refs = {};
  const contractIds = [];

  beforeAll(async () => {
    harness = await bootApp();
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const code = suffix.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase();

    const [eu, me, currency, broker, cedant, ttProp, ttNp, cobProp, cobEng, cobMar] = await Promise.all([
      one(`INSERT INTO public.country (country_code, country_name, region) VALUES ($1,$2,'Europe') RETURNING country_id`, [`A${code}`, `DO EU ${suffix}`]),
      one(`INSERT INTO public.country (country_code, country_name, region) VALUES ($1,$2,'GCC') RETURNING country_id`, [`B${code}`, `DO ME ${suffix}`]),
      one(`INSERT INTO public.currency (currency_code, currency_name) VALUES ($1,$2) RETURNING currency_id`, [`X${code}`, `DO Ccy ${suffix}`]),
      one(`INSERT INTO public.brokers (broker_name) VALUES ($1) RETURNING broker_id`, [`DO Broker ${suffix}`]),
      one(`INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id`, [`DO Cedant ${suffix}`]),
      one(`INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,'PROPORTIONAL') RETURNING treaty_type_id`, [`DO QS ${suffix}`]),
      one(`INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,'NON_PROPORTIONAL') RETURNING treaty_type_id`, [`DO XL ${suffix}`]),
      one(`INSERT INTO public.class_of_business (class_of_business, code) VALUES ($1,$2) RETURNING class_of_business_id`, [`DO Property ${suffix}`, `P${code}`]),
      one(`INSERT INTO public.class_of_business (class_of_business, code) VALUES ($1,$2) RETURNING class_of_business_id`, [`DO Engineering ${suffix}`, `E${code}`]),
      one(`INSERT INTO public.class_of_business (class_of_business, code) VALUES ($1,$2) RETURNING class_of_business_id`, [`DO Marine ${suffix}`, `M${code}`]),
    ]);
    Object.assign(refs, {
      euId: eu.country_id, meId: me.country_id, currencyId: currency.currency_id,
      brokerId: broker.broker_id, cedantId: cedant.company_id,
      ttProp: ttProp.treaty_type_id, ttNp: ttNp.treaty_type_id,
      ttPropName: `DO QS ${suffix}`, ttNpName: `DO XL ${suffix}`,
      cobProp: cobProp.class_of_business_id, cobEng: cobEng.class_of_business_id, cobMar: cobMar.class_of_business_id,
      propName: `DO Property ${suffix}`, engName: `DO Engineering ${suffix}`, marName: `DO Marine ${suffix}`,
    });

    const newContract = async (countryId, treatyTypeId, inception) => {
      const row = await one(
        `INSERT INTO public.contract
           (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year, inception_date, uw_status, signed_line_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'SIGNED',100) RETURNING contract_id`,
        [refs.cedantId, refs.brokerId, countryId, refs.currencyId, treatyTypeId, UW_YEAR, inception],
      );
      contractIds.push(row.contract_id);
      return row.contract_id;
    };
    const link = (contractId, cobId) =>
      pool.query(`INSERT INTO public.contract_class_of_business (contract_id, class_of_business_id) VALUES ($1,$2)`, [contractId, cobId]);

    // C1 — PROP, Europe, Property. premium=1000, exposure=5000, balance=5, margin=0.20
    const c1 = await newContract(refs.euId, refs.ttProp, `${UW_YEAR}-03-15`);
    await pool.query(`INSERT INTO public.contract_prop_details (contract_id, quota_share_epi, surplus_epi, total_capacity) VALUES ($1,1000,0,5000)`, [c1]);
    await pool.query(`INSERT INTO public.contract_pricing_outputs (contract_id, actuarial_margin, updated_at) VALUES ($1,0.20, now())`, [c1]);
    await link(c1, refs.cobProp);

    // C2 — PROP, Middle East, Engineering. premium=2500, exposure=5000, balance=2, margin=0.10
    const c2 = await newContract(refs.meId, refs.ttProp, `${UW_YEAR}-06-10`);
    await pool.query(`INSERT INTO public.contract_prop_details (contract_id, quota_share_epi, surplus_epi, total_capacity) VALUES ($1,2000,500,5000)`, [c2]);
    await pool.query(`INSERT INTO public.contract_pricing_outputs (contract_id, actuarial_margin, updated_at) VALUES ($1,0.10, now())`, [c2]);
    await link(c2, refs.cobEng);

    // C3 — NP, Europe, Marine. one layer: premium=5%*10000=500, exposure=10000, rol=0.05, margin=0.15
    const c3 = await newContract(refs.euId, refs.ttNp, `${UW_YEAR}-09-20`);
    await pool.query(`INSERT INTO public.contract_np_layers (contract_id, layer_number, layer_limit, uw_price, modelled_margin) VALUES ($1,1,10000,5,0.15)`, [c3]);
    await link(c3, refs.cobMar);
  });

  afterAll(async () => {
    try {
      if (contractIds.length) {
        await pool.query(`DELETE FROM public.contract_class_of_business WHERE contract_id = ANY($1)`, [contractIds]);
        await pool.query(`DELETE FROM public.contract_prop_details WHERE contract_id = ANY($1)`, [contractIds]);
        await pool.query(`DELETE FROM public.contract_np_layers WHERE contract_id = ANY($1)`, [contractIds]);
        await pool.query(`DELETE FROM public.contract_pricing_outputs WHERE contract_id = ANY($1)`, [contractIds]);
        await pool.query(`DELETE FROM public.contract WHERE contract_id = ANY($1)`, [contractIds]);
      }
      await pool.query(`DELETE FROM public.treaty_type WHERE treaty_type_id = ANY($1)`, [[refs.ttProp, refs.ttNp]]);
      await pool.query(`DELETE FROM public.class_of_business WHERE class_of_business_id = ANY($1)`, [[refs.cobProp, refs.cobEng, refs.cobMar]]);
      await pool.query(`DELETE FROM public.country WHERE country_id = ANY($1)`, [[refs.euId, refs.meId]]);
      await pool.query(`DELETE FROM public.currency WHERE currency_id = $1`, [refs.currencyId]);
      await pool.query(`DELETE FROM public.companies WHERE company_id = $1`, [refs.cedantId]);
      await pool.query(`DELETE FROM public.brokers WHERE broker_id = $1`, [refs.brokerId]);
    } catch { /* best-effort cleanup on a disposable test DB */ }
    await harness.close();
    await closePools();
  });

  it('rolls prop + NP units into the portfolio-overview KPIs, summaries and pivots', async () => {
    const res = await harness.fetchApp('GET', `/api/dashboard/page/portfolio-overview?uwYear=${UW_YEAR}`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    // ── KPIs ──
    expect(body.kpis.contracts).toBe(3);
    expect(body.kpis.premium).toBeCloseTo(4000, 6);     // 1000 + 2500 + 500
    expect(body.kpis.exposure).toBeCloseTo(20000, 6);   // 5000 + 5000 + 10000
    expect(body.kpis.balance).toBeCloseTo(10000 / 3500, 6);  // prop-only Σexp/Σprem
    expect(body.kpis.avgRol).toBeCloseTo(0.05, 6);           // only the NP layer carries rol
    expect(body.kpis.avgUwMargin).toBeCloseTo(525 / 4000, 6); // premium-weighted: (200+250+75)/4000

    // ── Region summary (premium-desc, 'Other' dropped) ──
    const byRegion = Object.fromEntries(body.summaryByRegion.map((r) => [r.region, r]));
    expect(byRegion['Middle East'].contracts).toBe(1);
    expect(byRegion['Middle East'].premium).toBeCloseTo(2500, 6);
    expect(byRegion['Middle East'].exposure).toBeCloseTo(5000, 6);
    expect(byRegion.Europe.contracts).toBe(2);            // C1 prop + C3 NP
    expect(byRegion.Europe.premium).toBeCloseTo(1500, 6); // 1000 + 500
    expect(byRegion.Europe.exposure).toBeCloseTo(15000, 6);
    expect(body.summaryByRegion[0].region).toBe('Middle East'); // ordered by premium desc
    expect(byRegion.Europe.portfolioPct).toBeCloseTo(1500 / 4000, 6);

    // ── LOB summary (each contract carries one class of business) ──
    const byLob = Object.fromEntries(body.summaryByLob.map((r) => [r.lob, r]));
    expect(byLob[refs.propName].premium).toBeCloseTo(1000, 6);
    expect(byLob[refs.engName].premium).toBeCloseTo(2500, 6);
    expect(byLob[refs.marName].premium).toBeCloseTo(500, 6);

    // ── Month series ──
    const byMonth = Object.fromEntries(body.series.premiumByMonth.map((m) => [m.month, m.value]));
    expect(byMonth[`${UW_YEAR}-03`]).toBeCloseTo(1000, 6);
    expect(byMonth[`${UW_YEAR}-06`]).toBeCloseTo(2500, 6);
    expect(byMonth[`${UW_YEAR}-09`]).toBeCloseTo(500, 6);

    // ── Region × treaty premium pivot ──
    const prt = body.premiumRegionTreaty;
    expect(prt.totals.total).toBeCloseTo(4000, 6);
    const prtByRegion = Object.fromEntries(prt.rows.map((r) => [r.region, r.values]));
    expect(prtByRegion.Europe[refs.ttPropName]).toBeCloseTo(1000, 6);
    expect(prtByRegion.Europe[refs.ttNpName]).toBeCloseTo(500, 6);
    expect(prtByRegion['Middle East'][refs.ttPropName]).toBeCloseTo(2500, 6);

    // ── Region × treaty weighted-margin pivot (exercises mw_num/mw_den path) ──
    expect(body.uwMarginRegionTreaty.totals.total).toBeCloseTo(525 / 4000, 6);
  });
});
