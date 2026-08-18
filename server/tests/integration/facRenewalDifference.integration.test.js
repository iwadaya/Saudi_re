// server/tests/integration/facRenewalDifference.integration.test.js
//
// Phase 5: why the price moved.
//
// The interesting cases are the ones a headline rate change hides — a premium
// up 50% with the rate flat, and a rate up 10% that is still losing ground
// against technical.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: fac renewal differencing', () => {
  let harness;
  const risks = [];
  let par;

  async function boundRisk({ reference, si, ratePm, technicalPm, deductible = 250_000 }) {
    const risk = await harness.fetchApp('POST', '/api/fac/risks', {
      body: {
        insured_name: 'Renewal IT Insured',
        fac_cob_id: par.fac_cob_id,
        pd_sum_insured: si, bi_sum_insured: 0, total_sum_insured: si,
        deductible_amount: deductible,
        uw_year: 2025, our_share_pct: 0.25,
      },
    }).then((r) => r.json());
    risks.push(risk.fac_risk_id);

    await pool.query(
      `INSERT INTO public.fac_pricing
         (fac_risk_id, final_rate_per_mille, final_premium,
          technical_gross_rate_pm, technical_adequacy)
       VALUES ($1,$2,$3,$4,$5)`,
      [risk.fac_risk_id, ratePm, (si * ratePm) / 1000, technicalPm, ratePm / technicalPm],
    );
    await pool.query(
      'UPDATE public.fac_risk SET bound_reference = $2, status = $3 WHERE fac_risk_id = $1',
      [risk.fac_risk_id, reference, 'BOUND'],
    );
    return risk.fac_risk_id;
  }

  async function renewalOf({ reference, si, ratePm, technicalPm, deductible = 250_000 }) {
    const risk = await harness.fetchApp('POST', '/api/fac/risks', {
      body: {
        insured_name: 'Renewal IT Insured',
        fac_cob_id: par.fac_cob_id,
        pd_sum_insured: si, bi_sum_insured: 0, total_sum_insured: si,
        deductible_amount: deductible,
        uw_year: 2026, our_share_pct: 0.25,
        renewal_or_new: 'RENEWAL', expiring_reference: reference,
      },
    }).then((r) => r.json());
    risks.push(risk.fac_risk_id);
    await pool.query(
      `INSERT INTO public.fac_pricing
         (fac_risk_id, final_rate_per_mille, final_premium,
          technical_gross_rate_pm, technical_adequacy)
       VALUES ($1,$2,$3,$4,$5)`,
      [risk.fac_risk_id, ratePm, (si * ratePm) / 1000, technicalPm, ratePm / technicalPm],
    );
    return risk.fac_risk_id;
  }

  const difference = (id) => harness
    .fetchApp('GET', `/api/fac/risks/${id}/renewal-difference`).then((r) => r.json());

  beforeAll(async () => {
    harness = await bootApp();
    const classes = await harness.fetchApp('GET', '/api/fac/lookups/classes').then((r) => r.json());
    par = classes.find((c) => c.code === 'PAR');
  });

  afterAll(async () => {
    if (harness) {
      for (const id of risks) {
        try { await harness.fetchApp('DELETE', `/api/fac/risks/${id}`); } catch { /* best effort */ }
      }
      await harness.close();
    }
    await closePools();
  });

  it('splits a premium rise into the part that is rate and the part that is exposure', async () => {
    const ref = 'FAC-RENEWAL-IT-1';
    await boundRisk({ reference: ref, si: 100_000_000, ratePm: 2.0, technicalPm: 2.0 });
    const renewal = await renewalOf({
      reference: ref, si: 120_000_000, ratePm: 2.2, technicalPm: 2.1,
    });

    const out = await difference(renewal);
    expect(out.decomposition.measurable).toBe(true);
    expect(out.decomposition.rate_change_pct).toBeCloseTo(0.10, 6);
    expect(out.decomposition.exposure_change_pct).toBeCloseTo(0.20, 6);
    expect(out.decomposition.premium_change_pct).toBeCloseTo(0.32, 6);
    expect(out.expiring.reference).toBe(ref);
  });

  it('shows a flat rate behind a premium that went up by half', async () => {
    const ref = 'FAC-RENEWAL-IT-2';
    await boundRisk({ reference: ref, si: 100_000_000, ratePm: 2.0, technicalPm: 2.0 });
    const renewal = await renewalOf({
      reference: ref, si: 150_000_000, ratePm: 2.0, technicalPm: 2.0,
    });

    const out = await difference(renewal);
    // The whole reason this endpoint exists: the broker sees +50% and the
    // underwriter has not moved the rate at all.
    expect(out.decomposition.rate_change_pct).toBeCloseTo(0, 9);
    expect(out.decomposition.premium_change_pct).toBeCloseTo(0.50, 6);
  });

  it('flags a rate cut that was bought with a higher deductible', async () => {
    const ref = 'FAC-RENEWAL-IT-3';
    await boundRisk({
      reference: ref, si: 100_000_000, ratePm: 2.0, technicalPm: 2.0, deductible: 250_000,
    });
    const renewal = await renewalOf({
      reference: ref, si: 100_000_000, ratePm: 1.7, technicalPm: 1.8, deductible: 1_000_000,
    });

    const out = await difference(renewal);
    expect(out.decomposition.rate_change_partly_structural).toBe(true);
    expect(out.decomposition.structure_changes.map((c) => c.key)).toContain('deductible_amount');
    expect(out.decomposition.structure_note).toMatch(/different product/i);
  });

  it('reports a rate rise that is still losing ground against technical', async () => {
    const ref = 'FAC-RENEWAL-IT-4';
    await boundRisk({ reference: ref, si: 100_000_000, ratePm: 1.90, technicalPm: 2.00 });
    const renewal = await renewalOf({
      reference: ref, si: 100_000_000, ratePm: 2.09, technicalPm: 2.40,
    });

    const out = await difference(renewal);
    expect(out.decomposition.rate_change_pct).toBeCloseTo(0.10, 6);
    // Up 10%, and further below technical than last year.
    expect(out.adequacy_move).toBeLessThan(0);
    expect(out.adequacy_note).toMatch(/further below technical/i);
  });

  it('says the predecessor is missing rather than reporting no change', async () => {
    const renewal = await renewalOf({
      reference: 'FAC-DOES-NOT-EXIST', si: 100_000_000, ratePm: 2.0, technicalPm: 2.0,
    });
    const out = await difference(renewal);
    expect(out.decomposition.measurable).toBe(false);
    expect(out.note).toMatch(/predecessor is not here, not because nothing changed/i);
  });

  it('says plainly when a risk is not a renewal at all', async () => {
    const plain = await harness.fetchApp('POST', '/api/fac/risks', {
      body: { insured_name: 'Not A Renewal', fac_cob_id: par.fac_cob_id, uw_year: 2026 },
    }).then((r) => r.json());
    risks.push(plain.fac_risk_id);

    const out = await difference(plain.fac_risk_id);
    expect(out.expiring_reference).toBeNull();
    expect(out.note).toBe('This is not a renewal.');
  });

  it('404s for a risk that does not exist', async () => {
    const res = await harness.fetchApp(
      'GET', '/api/fac/risks/00000000-0000-0000-0000-0000000000ff/renewal-difference',
    );
    expect(res.status).toBe(404);
  });
});
