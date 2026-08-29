// server/tests/integration/cedantSummaryMargins.integration.test.js
//
// Unit-consistency pin for GET /api/cedants/:cedantId/cedant-summary and
// /np-layers. NP layer margins are STORED as whole percents (15 = 15%,
// written by the NP screen's pctToNum save path) while PROP margins live in
// contract_pricing_outputs as fractions (0.09 = 9%). The endpoint must
// serve ONE unit — fractions — for every row, so the client's
// premium-weighted portfolio blend (CedantSummaryTabs) is exact:
// PROP 0.09 @ 1M + NP 15%-stored @ 1M must blend to 12%, and the NP
// net_technical_result must be premium × fractional margin (150,000 — not
// 15,000,000).
//
// Skipped by default; run with TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';

async function one(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

describe.skipIf(shouldSkipDb)('integration: cedant-summary margin units', () => {
  let harness;
  let refs;
  let propId;
  let npId;
  const contractIds = [];

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'NON_PROPORTIONAL' });

    const newContract = async () => {
      const row = await one(
        `INSERT INTO public.contract
           (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year, inception_date, uw_status)
         VALUES ($1,$2,$3,$4,$5,2031,'2031-01-01','SIGNED') RETURNING contract_id`,
        [refs.cedant_id, refs.broker_id, refs.country_id, refs.currency_id, refs.treaty_type_id],
      );
      contractIds.push(row.contract_id);
      return row.contract_id;
    };

    // PROP contract — margins already fractions in contract_pricing_outputs.
    propId = await newContract();
    await pool.query(
      `INSERT INTO public.contract_prop_details (contract_id, quota_share_epi, surplus_epi, total_capacity)
       VALUES ($1, 1000000, 0, 5000000)`, [propId],
    );
    await pool.query(
      `INSERT INTO public.contract_pricing_outputs (contract_id, actuarial_margin, actual_margin, updated_at)
       VALUES ($1, 0.09, 0.09, now())`, [propId],
    );

    // NP contract — margins stored as WHOLE percents on the layer rows.
    npId = await newContract();
    await pool.query(`INSERT INTO public.contract_np_details (contract_id) VALUES ($1)`, [npId]);
    await pool.query(
      `INSERT INTO public.contract_np_layers
         (contract_id, layer_number, layer_limit, earned_premium, modelled_margin, hist_margin)
       VALUES ($1, 1, 2000000, 1000000, 15, 10)`, [npId],
    );
  });

  afterAll(async () => {
    try {
      if (contractIds.length) {
        await pool.query(`DELETE FROM public.contract_np_layers WHERE contract_id = ANY($1)`, [contractIds]);
        await pool.query(`DELETE FROM public.contract_np_details WHERE contract_id = ANY($1)`, [contractIds]);
        await pool.query(`DELETE FROM public.contract_prop_details WHERE contract_id = ANY($1)`, [contractIds]);
        await pool.query(`DELETE FROM public.contract_pricing_outputs WHERE contract_id = ANY($1)`, [contractIds]);
        await pool.query(`DELETE FROM public.contract WHERE contract_id = ANY($1)`, [contractIds]);
      }
    } finally {
      await harness.close();
      await closePools();
    }
  });

  it('serves NP margins as FRACTIONS, same unit as PROP rows', async () => {
    const res = await harness.fetchApp('GET', `/api/cedants/${refs.cedant_id}/cedant-summary`);
    expect(res.status).toBe(200);
    const rows = await res.json();

    const prop = rows.find(r => String(r.contract_id) === String(propId));
    const np = rows.find(r => String(r.contract_id) === String(npId));
    expect(prop).toBeTruthy();
    expect(np).toBeTruthy();

    expect(Number(prop.actuarial_margin)).toBeCloseTo(0.09, 6);
    // Stored 15 (= 15%) → served 0.15; stored 10 (= 10%) → served 0.10.
    expect(Number(np.actuarial_margin)).toBeCloseTo(0.15, 6);
    expect(Number(np.actual_margin)).toBeCloseTo(0.10, 6);
    // NTR = premium × fractional margin, so it is 150,000 — not 15,000,000.
    expect(Number(np.net_technical_result)).toBeCloseTo(150000, 2);

    // The exact blend the Overview tab computes: (0.09×1M + 0.15×1M) / 2M.
    const blended =
      (Number(prop.actuarial_margin) * Number(prop.premium)
        + Number(np.actuarial_margin) * Number(np.premium))
      / (Number(prop.premium) + Number(np.premium));
    expect(blended).toBeCloseTo(0.12, 6);
  });

  it('np-layers net_technical_result uses the fractional margin', async () => {
    const res = await harness.fetchApp('GET', `/api/cedants/${refs.cedant_id}/np-layers`);
    expect(res.status).toBe(200);
    const { layers } = await res.json();
    const layer = layers.find(l => String(l.contract_id) === String(npId));
    expect(layer).toBeTruthy();
    expect(Number(layer.net_technical_result)).toBeCloseTo(150000, 2);
  });
});
