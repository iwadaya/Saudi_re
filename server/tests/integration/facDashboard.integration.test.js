// server/tests/integration/facDashboard.integration.test.js
//
// Behaviour pin for GET /api/fac-dashboard/page/* — the facultative twin of
// dashboardPortfolioOverview.integration.test.js. Seeds a small, deterministic
// fac book (two proportional risks, one XL, plus a DRAFT and a DECLINED that
// must be excluded) — isolated by a unique uw_year so the ?uwYear filter never
// sees other rows — and asserts the exact roll-ups: our-share premium/exposure,
// the prop Rate ‰ headline, XL ROL, the margin-vs-technical weighting, and the
// technical tab's band/type aggregates.
//
// Skipped by default; run with TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

// Astronomically unlikely uw_year so the ?uwYear filter isolates THIS test's
// risks from any other data or test sharing the DB.
const UW_YEAR = 4000 + Math.floor(Math.random() * 5000);

async function one(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

describe.skipIf(shouldSkipDb)('integration: fac dashboard aggregation', () => {
  let harness;
  const refs = {};
  const riskIds = [];

  beforeAll(async () => {
    harness = await bootApp();
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const code = suffix.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase();

    const [eu, me, currency, cedant, cobProp, cobEng, cobMar] = await Promise.all([
      one(`INSERT INTO public.country (country_code, country_name, region, is_active) VALUES ($1,$2,'Europe',false) RETURNING country_id`, [`C${code}`, `FD EU ${suffix}`]),
      one(`INSERT INTO public.country (country_code, country_name, region, is_active) VALUES ($1,$2,'GCC',false) RETURNING country_id`, [`D${code}`, `FD ME ${suffix}`]),
      one(`INSERT INTO public.currency (currency_code, currency_name, is_active) VALUES ($1,$2,false) RETURNING currency_id`, [`Y${code}`, `FD Ccy ${suffix}`]),
      one(`INSERT INTO public.companies (company_name, is_active) VALUES ($1,false) RETURNING company_id`, [`FD Cedant ${suffix}`]),
      one(`INSERT INTO public.fac_class_of_business (class_name, category, code, is_active) VALUES ($1,'PROPERTY',$2,false) RETURNING fac_cob_id`, [`FD Property ${suffix}`, `FP${code}`]),
      one(`INSERT INTO public.fac_class_of_business (class_name, category, code, is_active) VALUES ($1,'ENGINEERING',$2,false) RETURNING fac_cob_id`, [`FD Engineering ${suffix}`, `FE${code}`]),
      one(`INSERT INTO public.fac_class_of_business (class_name, category, code, is_active) VALUES ($1,'MARINE',$2,false) RETURNING fac_cob_id`, [`FD Marine ${suffix}`, `FM${code}`]),
    ]);
    Object.assign(refs, {
      euId: eu.country_id, meId: me.country_id, currencyId: currency.currency_id, cedantId: cedant.company_id,
      cobProp: cobProp.fac_cob_id, cobEng: cobEng.fac_cob_id, cobMar: cobMar.fac_cob_id,
      propName: `FD Property ${suffix}`, engName: `FD Engineering ${suffix}`, marName: `FD Marine ${suffix}`,
    });

    const newRisk = async (fields) => {
      const cols = Object.keys(fields);
      const row = await one(
        `INSERT INTO public.fac_risk (${cols.join(',')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING fac_risk_id`,
        cols.map((c) => fields[c]),
      );
      riskIds.push(row.fac_risk_id);
      return row.fac_risk_id;
    };
    const price = (riskId, finalPm, technicalPm) =>
      pool.query(`INSERT INTO public.fac_pricing (fac_risk_id, final_rate_per_mille, technical_gross_rate_pm) VALUES ($1,$2,$3)`,
        [riskId, finalPm, technicalPm]);

    const base = {
      cedant_id: refs.cedantId, currency_id: refs.currencyId, uw_year: UW_YEAR, status: 'BOUND',
    };

    // R1 — PROP, Europe, Property. Our share: 80% RI × 50% signed of TSI 1m →
    // exposure 400,000; ri_premium 400 → rate 1.0‰. Margin 1 − 0.8/1.0 = 0.20.
    const r1 = await newRisk({
      ...base, insured_name: 'FD Prop EU', country_id: refs.euId, fac_cob_id: refs.cobProp,
      placement_type: 'PROPORTIONAL', inception_date: `${UW_YEAR}-03-15`,
      total_sum_insured: 1_000_000, ri_share_pct: 80, our_share_pct: 50, ri_premium: 400,
    });
    await price(r1, 1.0, 0.8);

    // R2 — PROP, Middle East, Engineering. 100% shares of TSI 500k → exposure
    // 500,000; ri_premium 250 → rate 0.5‰. Margin 1 − 0.45/0.5 = 0.10.
    const r2 = await newRisk({
      ...base, insured_name: 'FD Prop ME', country_id: refs.meId, fac_cob_id: refs.cobEng,
      placement_type: 'PROPORTIONAL', inception_date: `${UW_YEAR}-06-10`,
      total_sum_insured: 500_000, ri_share_pct: 100, our_share_pct: 100, ri_premium: 250,
    });
    await price(r2, 0.5, 0.45);

    // R3 — XL, Europe, Marine. 50% of a 200k layer → exposure 100,000;
    // ri_premium 5,000 → ROL 5%. Margin 1 − 1.7/2.0 = 0.15.
    const r3 = await newRisk({
      ...base, insured_name: 'FD XL EU', country_id: refs.euId, fac_cob_id: refs.cobMar,
      placement_type: 'NON_PROPORTIONAL', inception_date: `${UW_YEAR}-09-20`,
      np_limit: 200_000, np_our_share_pct: 50, ri_premium: 5_000,
    });
    await price(r3, 2.0, 1.7);

    // Excluded from the live book: a DRAFT and a DECLINED risk.
    await newRisk({
      ...base, insured_name: 'FD Draft', country_id: refs.euId, fac_cob_id: refs.cobProp,
      placement_type: 'PROPORTIONAL', status: 'DRAFT', total_sum_insured: 9_000_000, ri_premium: 9_000,
    });
    await newRisk({
      ...base, insured_name: 'FD Declined', country_id: refs.euId, fac_cob_id: refs.cobProp,
      placement_type: 'PROPORTIONAL', status: 'DECLINED', total_sum_insured: 9_000_000, ri_premium: 9_000,
    });
  });

  afterAll(async () => {
    try {
      if (riskIds.length) {
        // fac_pricing rows cascade from fac_risk deletes.
        await pool.query(`DELETE FROM public.fac_risk WHERE fac_risk_id = ANY($1)`, [riskIds]);
      }
      await pool.query(`DELETE FROM public.fac_class_of_business WHERE fac_cob_id = ANY($1)`, [[refs.cobProp, refs.cobEng, refs.cobMar]]);
      await pool.query(`DELETE FROM public.country WHERE country_id = ANY($1)`, [[refs.euId, refs.meId]]);
      await pool.query(`DELETE FROM public.currency WHERE currency_id = $1`, [refs.currencyId]);
      await pool.query(`DELETE FROM public.companies WHERE company_id = $1`, [refs.cedantId]);
    } catch { /* best-effort cleanup on a disposable test DB */ }
    await harness.close();
    await closePools();
  });

  it('serves the fac filter universe including both FAC types', async () => {
    const res = await harness.fetchApp('GET', '/api/fac-dashboard/filters');
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.facTypes).toEqual(['Proportional FAC', 'XL FAC']);
    expect(body.uwYears).toContain(UW_YEAR);
  });

  it('rolls prop + XL fac risks into the portfolio-overview KPIs, summaries and pivots', async () => {
    const res = await harness.fetchApp('GET', `/api/fac-dashboard/page/portfolio-overview?uwYear=${UW_YEAR}`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    // ── KPIs (DRAFT + DECLINED excluded) ──
    expect(body.kpis.risks).toBe(3);
    expect(body.kpis.premium).toBeCloseTo(5650, 6);        // 400 + 250 + 5000
    expect(body.kpis.exposure).toBeCloseTo(1_000_000, 6);  // 400k + 500k + 100k
    expect(body.kpis.rate).toBeCloseTo(1000 * 650 / 900_000, 6); // prop-only Σprem/ΣSI ‰
    expect(body.kpis.avgRol).toBeCloseTo(0.05, 6);              // only the XL risk carries rol
    expect(body.kpis.avgUwMargin).toBeCloseTo(855 / 5650, 6);   // (80 + 25 + 750) / 5650

    // ── Region summary (premium-desc, 'Other' dropped) ──
    const byRegion = Object.fromEntries(body.summaryByRegion.map((r) => [r.region, r]));
    expect(byRegion.Europe.risks).toBe(2);                 // R1 prop + R3 XL
    expect(byRegion.Europe.premium).toBeCloseTo(5400, 6);
    expect(byRegion.Europe.exposure).toBeCloseTo(500_000, 6);
    expect(byRegion['Middle East'].risks).toBe(1);
    expect(byRegion['Middle East'].premium).toBeCloseTo(250, 6);
    expect(body.summaryByRegion[0].region).toBe('Europe'); // ordered by premium desc
    expect(byRegion.Europe.portfolioPct).toBeCloseTo(5400 / 5650, 6);
    expect(byRegion['Middle East'].rate).toBeCloseTo(0.5, 6);

    // ── Class summary (each risk carries one fac class) ──
    const byLob = Object.fromEntries(body.summaryByLob.map((r) => [r.lob, r]));
    expect(byLob[refs.propName].premium).toBeCloseTo(400, 6);
    expect(byLob[refs.propName].rate).toBeCloseTo(1.0, 6);
    expect(byLob[refs.engName].premium).toBeCloseTo(250, 6);
    expect(byLob[refs.marName].premium).toBeCloseTo(5000, 6);
    expect(byLob[refs.marName].rol).toBeCloseTo(0.05, 6);

    // ── Month series ──
    const byMonth = Object.fromEntries(body.series.premiumByMonth.map((m) => [m.month, m.value]));
    expect(byMonth[`${UW_YEAR}-03`]).toBeCloseTo(400, 6);
    expect(byMonth[`${UW_YEAR}-06`]).toBeCloseTo(250, 6);
    expect(byMonth[`${UW_YEAR}-09`]).toBeCloseTo(5000, 6);

    // ── Region × FAC type premium pivot ──
    const prt = body.premiumRegionFacType;
    expect(prt.totals.total).toBeCloseTo(5650, 6);
    const prtByRegion = Object.fromEntries(prt.rows.map((r) => [r.region, r.values]));
    expect(prtByRegion.Europe['Proportional FAC']).toBeCloseTo(400, 6);
    expect(prtByRegion.Europe['XL FAC']).toBeCloseTo(5000, 6);
    expect(prtByRegion['Middle East']['Proportional FAC']).toBeCloseTo(250, 6);

    // ── Region × FAC type weighted-margin pivot (mw_num/mw_den path) ──
    expect(body.uwMarginRegionFacType.totals.total).toBeCloseTo(855 / 5650, 6);
  });

  it('bands the technical tab by Rate ‰ (prop) and ROL (XL) and maps FAC type kinds', async () => {
    const res = await harness.fetchApp('GET', `/api/fac-dashboard/page/portfolio-technical-analysis?uwYear=${UW_YEAR}`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    // Rate bands: declared order, zero-filled where empty.
    expect(body.rateBands.map((b) => b.band)).toEqual(['0–0.5‰', '0.5–1‰', '1–2‰', '>2‰']);
    const rateBand = Object.fromEntries(body.rateBands.map((b) => [b.band, b]));
    expect(rateBand['0.5–1‰'].risks).toBe(1);              // R2 at 0.5‰ (half-open lower edge)
    expect(rateBand['0.5–1‰'].premium).toBeCloseTo(250, 6);
    expect(rateBand['1–2‰'].risks).toBe(1);                // R1 at 1.0‰
    expect(rateBand['1–2‰'].rate).toBeCloseTo(1.0, 6);
    expect(rateBand['0–0.5‰'].risks).toBe(0);

    // ROL bands: the XL risk sits exactly on the 5% edge → '5–10%'.
    const rolBand = Object.fromEntries(body.rolBands.map((b) => [b.band, b]));
    expect(rolBand['5–10%'].risks).toBe(1);
    expect(rolBand['5–10%'].premium).toBeCloseTo(5000, 6);
    expect(rolBand['0–5%'].risks).toBe(0);

    // FAC type breakdown (premium desc) + kind map for the diagonal matrix.
    expect(body.byFacType.map((t) => t.facType)).toEqual(['XL FAC', 'Proportional FAC']);
    const byType = Object.fromEntries(body.byFacType.map((t) => [t.facType, t]));
    expect(byType['XL FAC'].kind).toBe('NP');
    expect(byType['XL FAC'].rol).toBeCloseTo(0.05, 6);
    expect(byType['Proportional FAC'].kind).toBe('PROP');
    expect(byType['Proportional FAC'].rate).toBeCloseTo(1000 * 650 / 900_000, 6);
    expect(body.facKindByType).toEqual({ 'XL FAC': 'NP', 'Proportional FAC': 'PROP' });

    // FAC type × year pivots: prop rate cell weighted Σprem/ΣSI; XL rate NULL.
    const yr = String(UW_YEAR);
    const rateRows = Object.fromEntries(body.facTypeRateByYear.rows.map((r) => [r.key, r]));
    expect(rateRows['Proportional FAC'].values[yr]).toBeCloseTo(1000 * 650 / 900_000, 6);
    expect(rateRows['XL FAC']?.values?.[yr] ?? null).toBeNull();
    const rolRows = Object.fromEntries(body.facTypeRolByYear.rows.map((r) => [r.key, r]));
    expect(rolRows['XL FAC'].values[yr]).toBeCloseTo(0.05, 6);
    expect(body.facTypeUwMarginByYear.totals.total).toBeCloseTo(855 / 5650, 6);
    expect(body.facTypePremiumByYear.totals.total).toBeCloseTo(5650, 6);
  });

  it('applies the FAC type filter through the placement-type mapping', async () => {
    const res = await harness.fetchApp('GET',
      `/api/fac-dashboard/page/portfolio-overview?uwYear=${UW_YEAR}&facType=${encodeURIComponent('XL FAC')}`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.kpis.risks).toBe(1);
    expect(body.kpis.premium).toBeCloseTo(5000, 6);
    expect(body.kpis.rate).toBeNull();      // no proportional units in scope
    expect(body.kpis.avgRol).toBeCloseTo(0.05, 6);
  });
});
