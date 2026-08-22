// server/tests/integration/facRiskPartialUpdate.integration.test.js
//
// PUT /api/fac/risks/:id must MERGE, not replace.
//
// Three screens save slices of a risk rather than the whole thing:
// FacCoverageStructure (placement + shares + premium), FacDeductibles, and
// FacPricing (ri_premium + original_rate alone). The handler used to write
// every column from the body on every call, so any of those slices NULLed
// everything it did not mention. insured_name is NOT NULL, so it surfaced as
//
//   500 — null value in column "insured_name" ... violates not-null constraint
//
// which was luck: the constraint is the only reason the other ~50 columns were
// not silently wiped instead. These tests pin the merge semantics.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const d = shouldSkipDb ? describe.skip : describe;

d('fac risk — partial update merges', () => {
  let app, refs;

  beforeAll(async () => { app = await bootApp(); refs = await seedRefs({ category: 'PROPORTIONAL' }); }, 60_000);
  afterAll(async () => { await app?.close(); await closePools(); });

  /** A fully-populated risk to save slices against. */
  async function seedRisk(extra = {}) {
    const r = await (await app.fetchApp('POST', '/api/fac/risks', {
      body: {
        insured_name: 'IT Full Risk',
        insured_address: '12 King Fahd Rd, Riyadh',
        nature_of_business: 'Petrochemical manufacturing',
        total_sum_insured: 500_000_000,
        pd_sum_insured: 400_000_000,
        bi_sum_insured: 100_000_000,
        pml_amount: 50_000_000,
        deductible_description: 'USD 1m each and every loss',
        uw_year: 2026,
        status: 'QUOTED',
        ...refs, ...extra,
      },
    })).json();
    expect(r.fac_risk_id).toBeTruthy();
    return r;
  }

  it('accepts the Coverage Structure slice — the reported 500', async () => {
    const risk = await seedRisk();
    const res = await app.fetchApp('PUT', `/api/fac/risks/${risk.fac_risk_id}`, {
      body: {
        placement_type: 'PROPORTIONAL',
        cedant_retention_pct: 20, ri_share_pct: 80, our_share_pct: 15,
        commission_pct: 25, brokerage_pct: 10, taxes_pct: 5,
        original_premium: 1_000_000, ri_premium: 800_000, original_rate: 0.2,
      },
    });
    expect(res.status).toBe(200);
  }, 30_000);

  it('leaves every unsent field untouched', async () => {
    const risk = await seedRisk();
    await app.fetchApp('PUT', `/api/fac/risks/${risk.fac_risk_id}`, {
      body: { ri_premium: 777_000, original_rate: 0.31 }, // the FacPricing slice
    });

    const { rows } = await pool.query('SELECT * FROM public.fac_risk WHERE fac_risk_id = $1', [risk.fac_risk_id]);
    const after = rows[0];
    expect(Number(after.ri_premium)).toBe(777_000);
    expect(Number(after.original_rate)).toBeCloseTo(0.31, 6);
    // …and nothing else moved.
    expect(after.insured_name).toBe('IT Full Risk');
    expect(after.insured_address).toBe('12 King Fahd Rd, Riyadh');
    expect(after.nature_of_business).toBe('Petrochemical manufacturing');
    expect(Number(after.total_sum_insured)).toBe(500_000_000);
    expect(Number(after.pd_sum_insured)).toBe(400_000_000);
    expect(Number(after.pml_amount)).toBe(50_000_000);
    expect(after.deductible_description).toBe('USD 1m each and every loss');
    expect(after.uw_year).toBe(2026);
    expect(after.status).toBe('QUOTED');   // a slice must not reset the workflow
    expect(after.cedant_id).toBe(refs.cedant_id);
  }, 30_000);

  it('still clears a field the client explicitly sends as null', async () => {
    // "Omitted" and "cleared" are different intents and must stay different:
    // the risk-detail form clears a field by sending an explicit null.
    const risk = await seedRisk();
    const res = await app.fetchApp('PUT', `/api/fac/risks/${risk.fac_risk_id}`, {
      body: { nature_of_business: null, pml_amount: null },
    });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      'SELECT nature_of_business, pml_amount, insured_name FROM public.fac_risk WHERE fac_risk_id = $1',
      [risk.fac_risk_id]);
    expect(rows[0].nature_of_business).toBeNull();
    expect(rows[0].pml_amount).toBeNull();
    expect(rows[0].insured_name).toBe('IT Full Risk'); // untouched
  }, 30_000);

  it('rejects a blank insured_name with 400, not a 500 from the constraint', async () => {
    const risk = await seedRisk();
    for (const bad of [null, '', '   ']) {
      const res = await app.fetchApp('PUT', `/api/fac/risks/${risk.fac_risk_id}`, {
        body: { insured_name: bad },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    }
  }, 30_000);

  it('is a no-op that returns the row when nothing updatable is sent', async () => {
    const risk = await seedRisk();
    const res = await app.fetchApp('PUT', `/api/fac/risks/${risk.fac_risk_id}`, { body: {} });
    expect(res.status).toBe(200);
    expect((await res.json()).insured_name).toBe('IT Full Risk');
  }, 30_000);

  it('still applies a full-form save from the risk detail screen', async () => {
    const risk = await seedRisk();
    const res = await app.fetchApp('PUT', `/api/fac/risks/${risk.fac_risk_id}`, {
      body: {
        insured_name: 'IT Renamed Risk',
        insured_address: 'New address',
        total_sum_insured: 900_000_000,
        status: 'BOUND',
        ...refs,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.insured_name).toBe('IT Renamed Risk');
    expect(Number(body.total_sum_insured)).toBe(900_000_000);
    expect(body.status).toBe('BOUND');
  }, 30_000);

  it('404s for a risk that does not exist', async () => {
    const res = await app.fetchApp('PUT', '/api/fac/risks/00000000-0000-0000-0000-0000000000ff', {
      body: { ri_premium: 1 },
    });
    expect([403, 404]).toContain(res.status); // the edit-lock guard may answer first
  }, 30_000);
});
