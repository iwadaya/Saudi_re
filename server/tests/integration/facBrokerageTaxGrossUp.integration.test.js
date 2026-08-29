// server/tests/integration/facBrokerageTaxGrossUp.integration.test.js
//
// Audit F76 end to end: fac_risk.brokerage_pct / taxes_pct (whole percent,
// captured on the Coverage Structure screen) must reach the shared engine's
// technical gross-up, whose denominator is 1 - comm - brok - tax - margin
// (shared/fac/pipeline.js). Before the fix computeFacPricing never passed
// them, so a brokered risk grossed up by 1 - comm - margin only and the
// technical gross rate was understated on all brokered business.
//
// Hand-derived: with commission 25% + margin 5% (both engine fractions) the
// denominator is 0.70 without brokerage/taxes; adding brokerage 5% + taxes
// 2% (whole-percent 5 and 2 on the risk) it becomes 0.63 — the gross rate
// rises by the factor 0.70/0.63 = 1.111… on the identical technical net.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: fac technical gross-up includes brokerage and taxes (F76)', () => {
  let harness;
  let propertyCob;
  let occupancyCode;
  let countryZone;
  const risks = [];

  async function newRisk(body = {}) {
    const r = await harness
      .fetchApp('POST', '/api/fac/risks', { body: { insured_name: 'GrossUp IT Risk', ...body } })
      .then((x) => x.json());
    risks.push(r.fac_risk_id);
    return r.fac_risk_id;
  }

  const price = (id, body) => harness
    .fetchApp('POST', `/api/fac/risks/${id}/price`, { body })
    .then((r) => r.json());

  beforeAll(async () => {
    harness = await bootApp();
    const classes = await harness.fetchApp('GET', '/api/fac/lookups/classes').then((r) => r.json());
    propertyCob = classes.find((c) => c.code === 'PAR');
    const occ = await pool.query(
      `SELECT occupancy_code FROM public.fac_occupancy_master
        WHERE active = true AND flexa_base_rate_pm > 0 LIMIT 1`,
    );
    const zone = await pool.query(
      'SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1',
    );
    occupancyCode = occ.rows[0]?.occupancy_code;
    countryZone = zone.rows[0]?.country_zone;
  });

  afterAll(async () => {
    if (harness) {
      for (const id of risks) { try { await harness.fetchApp('DELETE', `/api/fac/risks/${id}`); } catch { /* best effort */ } }
      await harness.close();
    }
    await closePools();
  });

  it('grosses up by 1 - comm - brok - tax - margin, moving the premium by 0.70/0.63', async () => {
    if (!occupancyCode || !countryZone) return; // reference set not seeded here

    const base = {
      fac_cob_id: propertyCob.fac_cob_id,
      occupancy_code: occupancyCode,
      risk_country_zone: countryZone,
      pd_sum_insured: 100_000_000,
      bi_sum_insured: 0,
    };
    // Whole percent on the risk (validation pct100): brokerage 5, taxes 2.
    const brokeredId = await newRisk({ ...base, brokerage_pct: 5, taxes_pct: 2 });
    const cleanId = await newRisk(base);

    const engineInputs = { commission_pct: 0.25, margin_pct: 0.05 };
    const brokered = await price(brokeredId, engineInputs);
    const clean = await price(cleanId, engineInputs);

    expect(brokered.ok).toBe(true);
    expect(clean.ok).toBe(true);
    expect(brokered.technical?.priced).toBe(true);
    expect(clean.technical?.priced).toBe(true);

    // The denominators, exactly.
    expect(clean.technical.grossUpDenominator).toBeCloseTo(0.70, 12);
    expect(brokered.technical.grossUpDenominator).toBeCloseTo(0.63, 12);

    // Brokerage/taxes touch ONLY the gross-up: the technical net is identical.
    expect(brokered.technical.technicalNetPm)
      .toBeCloseTo(clean.technical.technicalNetPm, 10);

    // Gross = net / denominator on both risks…
    expect(brokered.technical.technicalGrossPm)
      .toBeCloseTo(brokered.technical.technicalNetPm / 0.63, 10);
    expect(clean.technical.technicalGrossPm)
      .toBeCloseTo(clean.technical.technicalNetPm / 0.70, 10);

    // …so the brokered gross rate — and hence the technical gross premium —
    // is 0.70/0.63 = 1.1111… × the clean one. The old code produced the
    // clean number for both (the audit's 10% understatement: 0.63/0.70 = 0.9).
    expect(brokered.technical.technicalGrossPm / clean.technical.technicalGrossPm)
      .toBeCloseTo(0.70 / 0.63, 10);
    expect(brokered.technical.premiums.technicalGross)
      .toBeCloseTo(clean.technical.premiums.technicalGross * (0.70 / 0.63), 4);
  });
});
