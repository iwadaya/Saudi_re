// server/tests/integration/quoteBind.integration.test.js
//
// P0-6 quote → contract binding. Exercises the lifecycle:
//   create → price (seed sub-tables) → sign → bind → dashboard reflects exposure,
// plus the snapshot-immutability, double-bind, and rollback guarantees.
//
// NOTE: /quotes/:id/offer/mark-signed is disabled in this build (410
// QUOTE_SIGN_DISABLED), so the test sets the quote to SIGNED directly to stand in
// for the (separately-gated) approval outcome — binding itself is what's under test.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

// Unique uw_year so the dashboard slice contains ONLY this test's contract.
// Kept within the validated range (uwYear caps at 2200 — see validation/common.js;
// the POST /quotes create body is now schema-validated like the PUT path), while
// staying clear of the near-present years other suites seed (2024–2087).
const UW_YEAR = 2100 + (process.pid % 90);

describe.skipIf(shouldSkipDb)('integration: quote → contract bind lifecycle', () => {
  let harness;
  let refs;
  let cobId;

  async function newSignedQuoteWithData() {
    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: UW_YEAR, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
    }).then((r) => r.json());
    const id = q.quote_id;

    // ── "price": seed a flat table, pricing, a profile (+band), shared losses, a doc ──
    await pool.query(
      `INSERT INTO public.quote_prop_details (quote_id, total_capacity, qs_limit, quota_share_epi) VALUES ($1,$2,$3,$4)`,
      [id, 5_000_000, 5_000_000, 1_000_000]);
    await pool.query(`INSERT INTO public.quote_class_of_business (quote_id, class_of_business_id) VALUES ($1,$2)`, [id, cobId]);
    await pool.query(`INSERT INTO public.quote_pricing_outputs (quote_id, epi, loss_ratio, margin) VALUES ($1,$2,$3,$4)`, [id, 1_000_000, 0.55, 0.12]);

    const prof = await pool.query(
      `INSERT INTO public.quote_risk_profile (quote_id, class_of_business_id, pml_percentage) VALUES ($1,$2,$3) RETURNING profile_id`,
      [id, cobId, 100]);
    await pool.query(
      `INSERT INTO public.quote_risk_profile_band (profile_id, from_amt, to_amt, no_of_risks, total_sum_insured, gross_premium) VALUES ($1,$2,$3,$4,$5,$6)`,
      [prof.rows[0].profile_id, 0, 1_000_000, 10, 5_000_000, 250_000]);

    // Losses live in the shared contract_* tables keyed by quote_id (the snapshot).
    const rep = await pool.query(
      `INSERT INTO public.contract_large_loss_report (quote_id, report_date) VALUES ($1,$2) RETURNING report_id`,
      [id, '2026-01-01']);
    await pool.query(
      `INSERT INTO public.contract_large_losses (report_id, uw_year, loss_name, incurred, is_selected) VALUES ($1,$2,$3,$4,true)`,
      [rep.rows[0].report_id, 2024, 'Big loss', 800_000]);

    await pool.query(
      `INSERT INTO public.contract_document (quote_id, file_name, mime_type, storage_path) VALUES ($1,'slip.pdf','application/pdf','quotes/x/slip.pdf')`,
      [id]);

    // Stand in for the approval outcome (mark-signed is separately disabled).
    await pool.query(
      `UPDATE public.quote SET status='SIGNED', uw_status='SIGNED', signed_line_pct=100, signed_at=now() WHERE quote_id=$1`, [id]);
    return id;
  }

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
    const c = await pool.query(`INSERT INTO public.class_of_business (class_of_business) VALUES ($1) RETURNING class_of_business_id`,
      [`Bind COB ${Date.now()}-${process.pid}`]);
    cobId = c.rows[0].class_of_business_id;
  });

  afterAll(async () => {
    // Clean up the rows this test's pid created (uw_year is its unique sentinel)
    // so bound SIGNED contracts don't accumulate in the shared test DB — a
    // stale leftover in a colliding uw_year breaks the pre-bind
    // `kpis.contracts === 0` assertion on a later run.
    try {
      const { rows: cs } = await pool.query(`SELECT contract_id FROM public.contract WHERE uw_year=$1`, [UW_YEAR]);
      for (const r of cs) { try { await harness.fetchApp('DELETE', `/api/treaties/${r.contract_id}`); } catch {} }
      const { rows: qs } = await pool.query(`SELECT quote_id FROM public.quote WHERE uw_year=$1`, [UW_YEAR]);
      for (const r of qs) { try { await harness.fetchApp('DELETE', `/api/quotes/${r.quote_id}`); } catch {} }
    } catch {}
    if (harness) await harness.close();
    await closePools();
  });

  it('binds a signed quote into a SIGNED contract, copies every sub-table, and leaves the quote snapshot intact', async () => {
    const quoteId = await newSignedQuoteWithData();

    // Dashboard does not see the quote pre-bind.
    const before = await harness.fetchApp('GET', `/api/dashboard/page/portfolio-overview?uwYear=${UW_YEAR}`).then((r) => r.json());
    expect(before.kpis.contracts).toBe(0);

    const res = await harness.fetchApp('POST', `/api/quotes/${quoteId}/bind`);
    expect(res.status).toBe(201);
    const body = await res.json();
    const contractId = body.contract_id;
    expect(contractId).toBeTruthy();
    expect(body.source_quote_id).toBe(quoteId);

    // Contract header: SIGNED + linked to the quote.
    const c = (await pool.query(`SELECT uw_status, source_quote_id, signed_line_pct, uw_year FROM public.contract WHERE contract_id=$1`, [contractId])).rows[0];
    expect(c.uw_status).toBe('SIGNED');
    expect(c.source_quote_id).toBe(quoteId);
    expect(Number(c.signed_line_pct)).toBe(100);
    expect(c.uw_year).toBe(UW_YEAR);

    // Contract-owned copies of each sub-table.
    const count = async (sql, p) => Number((await pool.query(sql, p)).rows[0].n);
    expect(await count(`SELECT count(*) n FROM public.contract_prop_details WHERE contract_id=$1`, [contractId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM public.contract_class_of_business WHERE contract_id=$1`, [contractId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM public.contract_pricing_outputs WHERE contract_id=$1`, [contractId])).toBe(1);
    // profile + remapped band
    const cap = (await pool.query(`SELECT total_capacity FROM public.contract_prop_details WHERE contract_id=$1`, [contractId])).rows[0];
    expect(Number(cap.total_capacity)).toBe(5_000_000);
    const prof = (await pool.query(`SELECT profile_id FROM public.contract_risk_profile WHERE contract_id=$1`, [contractId])).rows[0];
    expect(prof).toBeTruthy();
    expect(await count(`SELECT count(*) n FROM public.contract_risk_profile_band WHERE profile_id=$1`, [prof.profile_id])).toBe(1);
    // shared loss report + remapped losses, now contract-owned
    const rep = (await pool.query(`SELECT report_id FROM public.contract_large_loss_report WHERE contract_id=$1`, [contractId])).rows[0];
    expect(rep).toBeTruthy();
    expect(await count(`SELECT count(*) n FROM public.contract_large_losses WHERE report_id=$1`, [rep.report_id])).toBe(1);
    // document copied to the contract
    expect(await count(`SELECT count(*) n FROM public.contract_document WHERE contract_id=$1`, [contractId])).toBe(1);

    // The quote SNAPSHOT is untouched: its own rows still exist, keyed by quote_id.
    expect(await count(`SELECT count(*) n FROM public.quote_prop_details WHERE quote_id=$1`, [quoteId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM public.contract_large_loss_report WHERE quote_id=$1`, [quoteId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM public.contract_document WHERE quote_id=$1`, [quoteId])).toBe(1);
    const q = (await pool.query(`SELECT bound_contract_id, bound_at FROM public.quote WHERE quote_id=$1`, [quoteId])).rows[0];
    expect(q.bound_contract_id).toBe(contractId);
    expect(q.bound_at).toBeTruthy();

    // Audit on both sides.
    expect(await count(`SELECT count(*) n FROM public.contract_audit_event WHERE contract_id=$1 AND event_type='BOUND_FROM_QUOTE'`, [contractId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM public.audit_log WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type='QUOTE_BOUND'`, [quoteId])).toBe(1);

    // Dashboard now reflects the bound contract's exposure.
    const after = await harness.fetchApp('GET', `/api/dashboard/page/portfolio-overview?uwYear=${UW_YEAR}`).then((r) => r.json());
    expect(after.kpis.contracts).toBe(1);

    // Decoupled: editing the bound contract does NOT mutate the quote snapshot.
    await pool.query(`UPDATE public.contract_prop_details SET total_capacity=$2 WHERE contract_id=$1`, [contractId, 9_999_999]);
    const snap = (await pool.query(`SELECT total_capacity FROM public.quote_prop_details WHERE quote_id=$1`, [quoteId])).rows[0];
    expect(Number(snap.total_capacity)).toBe(5_000_000);

    // Double-bind is rejected.
    const second = await harness.fetchApp('POST', `/api/quotes/${quoteId}/bind`);
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('ALREADY_BOUND');
  });

  it('rejects binding a quote that is not SIGNED', async () => {
    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: UW_YEAR, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
    }).then((r) => r.json());
    const res = await harness.fetchApp('POST', `/api/quotes/${q.quote_id}/bind`);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('QUOTE_NOT_SIGNED');
    // No contract was created for this quote.
    const n = Number((await pool.query(`SELECT count(*) n FROM public.contract WHERE source_quote_id=$1`, [q.quote_id])).rows[0].n);
    expect(n).toBe(0);
  });
});
