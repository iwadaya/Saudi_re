// server/tests/integration/facHomeSummary.integration.test.js
//
// Behaviour pin for GET /api/fac/home-summary — the fac twin of /home/summary.
// Seeds risks across the statuses the home panels split on and asserts list
// membership, the renewals window (a bound risk already referenced by a
// renewal must not reappear as a candidate), and the region premium rollup.
// The endpoint is portfolio-wide and unfiltered, so on a shared test DB the
// assertions check for THIS test's rows (unique names) rather than exact
// global counts.
//
// Skipped by default; run with TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

async function one(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

const CURRENT_YEAR = new Date().getFullYear();

describe.skipIf(shouldSkipDb)('integration: fac home summary', () => {
  let harness;
  const refs = {};
  const riskIds = [];
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const name = (tag) => `FH ${tag} ${suffix}`;

  beforeAll(async () => {
    harness = await bootApp();
    const code = suffix.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase();

    const [me, currency, cedant, cob] = await Promise.all([
      one(`INSERT INTO public.country (country_code, country_name, region) VALUES ($1,$2,'GCC') RETURNING country_id`, [`H${code}`, `FH ME ${suffix}`]),
      one(`INSERT INTO public.currency (currency_code, currency_name) VALUES ($1,$2) RETURNING currency_id`, [`W${code}`, `FH Ccy ${suffix}`]),
      one(`INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id`, [`FH Cedant ${suffix}`]),
      one(`INSERT INTO public.fac_class_of_business (class_name, category, code) VALUES ($1,'PROPERTY',$2) RETURNING fac_cob_id`, [`FH Property ${suffix}`, `FH${code}`]),
    ]);
    Object.assign(refs, { meId: me.country_id, currencyId: currency.currency_id, cedantId: cedant.company_id, cobId: cob.fac_cob_id });

    const newRisk = async (fields) => {
      const base = {
        cedant_id: refs.cedantId, country_id: refs.meId, currency_id: refs.currencyId,
        fac_cob_id: refs.cobId, uw_year: CURRENT_YEAR, placement_type: 'PROPORTIONAL',
      };
      const all = { ...base, ...fields };
      const cols = Object.keys(all);
      const row = await one(
        `INSERT INTO public.fac_risk (${cols.join(',')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING fac_risk_id, fac_ref`,
        cols.map((c) => all[c]),
      );
      riskIds.push(row.fac_risk_id);
      return row;
    };

    await newRisk({ insured_name: name('Draft'), status: 'DRAFT' });
    await newRisk({ insured_name: name('Quoted'), status: 'QUOTED' });
    // Renewal candidate: bound, expiring inside the 60-day window.
    await newRisk({ insured_name: name('Renewable'), status: 'BOUND', ri_premium: 1234, expiry_date: `${CURRENT_YEAR + 1}-01-01` });
    // Already-renewed: bound + expiring, but a child references its fac_ref.
    const renewed = await newRisk({ insured_name: name('AlreadyRenewed'), status: 'BOUND', expiry_date: `${CURRENT_YEAR + 1}-01-01` });
    await newRisk({ insured_name: name('RenewalChild'), status: 'DRAFT', renewal_or_new: 'Renewal', expiring_reference: renewed.fac_ref });
    await newRisk({ insured_name: name('Declined'), status: 'DECLINED' });

    // Pin the window: both bound risks expire 10 days out (date arithmetic in
    // SQL avoids timezone drift between JS and the DB clock).
    await pool.query(
      `UPDATE public.fac_risk SET expiry_date = CURRENT_DATE + 10
        WHERE fac_risk_id = ANY($1) AND status = 'BOUND'`, [riskIds],
    );
  });

  afterAll(async () => {
    try {
      if (riskIds.length) await pool.query(`DELETE FROM public.fac_risk WHERE fac_risk_id = ANY($1)`, [riskIds]);
      await pool.query(`DELETE FROM public.fac_class_of_business WHERE fac_cob_id = $1`, [refs.cobId]);
      await pool.query(`DELETE FROM public.country WHERE country_id = $1`, [refs.meId]);
      await pool.query(`DELETE FROM public.currency WHERE currency_id = $1`, [refs.currencyId]);
      await pool.query(`DELETE FROM public.companies WHERE company_id = $1`, [refs.cedantId]);
    } catch { /* best-effort cleanup on a disposable test DB */ }
    await harness.close();
    await closePools();
  });

  it('splits risks into the four home panels and windows renewals correctly', async () => {
    const res = await harness.fetchApp('GET', '/api/fac/home-summary');
    expect(res.ok).toBe(true);
    const body = await res.json();

    const names = (list) => (list || []).map((r) => r.insured_name);
    expect(names(body.drafts)).toContain(name('Draft'));
    expect(names(body.drafts)).toContain(name('RenewalChild'));
    expect(names(body.quotes)).toContain(name('Quoted'));
    // quotes stay out of the history panel (they have their own)
    expect(names(body.submitted)).not.toContain(name('Quoted'));
    expect(names(body.submitted)).toContain(name('Declined'));
    expect(names(body.submitted)).toContain(name('Renewable'));

    // Renewals: the un-renewed bound risk is a candidate; the one already
    // referenced by a renewal child is not.
    expect(names(body.renewals)).toContain(name('Renewable'));
    expect(names(body.renewals)).not.toContain(name('AlreadyRenewed'));

    // Rows carry what the panels render.
    const draft = body.drafts.find((r) => r.insured_name === name('Draft'));
    expect(draft.cedant_name).toBe(`FH Cedant ${suffix}`);
    expect(draft.cob).toBe(`FH Property ${suffix}`);
    expect(draft.fac_ref).toMatch(/^FAC-\d{4}-\d+/);

    // Stats are whole-book counts — at least this test's contribution.
    expect(body.stats.total).toBeGreaterThanOrEqual(6);
    expect(body.stats.drafts).toBeGreaterThanOrEqual(2);
    expect(body.stats.quoted).toBeGreaterThanOrEqual(1);
    expect(body.stats.bound).toBeGreaterThanOrEqual(2);
    expect(body.stats.declined).toBeGreaterThanOrEqual(1);

    // Region premium: the current-year bound premium lands in Middle East.
    const me = (body.region_premiums || []).find((r) => r.region_bucket === 'Middle East');
    expect(me).toBeTruthy();
    expect(Number(me.total_epi)).toBeGreaterThanOrEqual(1234);
  });
});
