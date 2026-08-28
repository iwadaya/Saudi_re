// server/tests/integration/pricingGuardsHardening.integration.test.js
//
// Live coverage for the M4 pricing hardening:
//   F60 — PUT /treaties/:id/pricing-outputs and /pricing-yearly honour the
//         assignee edit-lock and the opt-in If-Unmodified-Since stale-write
//         guard exactly like POST /pricing/save (409 STALE_WRITE, `*`
//         override, fresh-token pass, updated_at echoed back).
//   F61 — component snapshots: created_by comes from the verified actor (a
//         client-forged created_by is ignored), deletes are contract-scoped +
//         edit-locked, and an unknown snapshot id is a 404, not a no-op 200.
//   F106 — POST /pricing/gem/:contractId/compute rejects (422) a curve whose
//         occupancy/loss category doesn't match its slot.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';

const OTHER_USER = '00000000-0000-0000-0000-000000000002';
const asOther = { 'x-user-id': OTHER_USER, 'x-user-role': 'CU' };

describe.skipIf(shouldSkipDb)('integration: pricing guards hardening (F60/F61/F106)', () => {
  let harness;
  let refs;
  const created = [];
  const gemCurveIds = [];

  async function newTreaty() {
    const t = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01' },
    }).then((r) => r.json());
    expect(t.contract_id).toBeTruthy();
    created.push(t.contract_id);
    return t.contract_id;
  }

  async function contractUpdatedAt(id) {
    const { rows } = await pool.query('SELECT updated_at FROM public.contract WHERE contract_id=$1', [id]);
    return rows[0].updated_at.toISOString();
  }

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
  });

  afterAll(async () => {
    if (gemCurveIds.length) {
      await pool.query('DELETE FROM public.gem_vulnerability_function WHERE id = ANY($1::bigint[])', [gemCurveIds]);
    }
    if (harness) {
      for (const id of created) { try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  // ── F60 ──────────────────────────────────────────────────────────────────
  it('F60: save without If-Unmodified-Since is unaffected (guard opt-in) and returns updated_at', async () => {
    const id = await newTreaty();
    const res = await harness.fetchApp('PUT', `/api/treaties/${id}/pricing-outputs`, { body: { epi: 1_000_000 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.updated_at).toBeTruthy();
  });

  it('F60: a stale token can no longer wipe the yearly rows — 409 STALE_WRITE, rows intact', async () => {
    const id = await newTreaty();
    const seed = await harness.fetchApp('PUT', `/api/treaties/${id}/pricing-yearly`, {
      body: { rows: [{ uw_year: 2024, ultimate_premium: 100, ultimate_loss: 40 }] },
    });
    expect(seed.status).toBe(200);
    const t0 = new Date(Date.now() - 3_600_000).toISOString(); // clearly stale

    const stale = await harness.fetchApp('PUT', `/api/treaties/${id}/pricing-yearly`, {
      body: { rows: [] },
      headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_WRITE');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM public.contract_pricing_yearly WHERE contract_id=$1', [id]);
    expect(rows[0].n).toBe(1); // the DELETE-then-reinsert never ran
  });

  it('F60: stale token on pricing-outputs is also rejected; `*` override and a fresh token pass', async () => {
    const id = await newTreaty();
    const t0 = new Date(Date.now() - 3_600_000).toISOString();
    const stale = await harness.fetchApp('PUT', `/api/treaties/${id}/pricing-outputs`, {
      body: { epi: 2_000_000 },
      headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);

    const override = await harness.fetchApp('PUT', `/api/treaties/${id}/pricing-outputs`, {
      body: { epi: 3_000_000 },
      headers: { 'if-unmodified-since': '*' },
    });
    expect(override.status).toBe(200);

    const fresh = await contractUpdatedAt(id);
    const ok = await harness.fetchApp('PUT', `/api/treaties/${id}/pricing-yearly`, {
      body: { rows: [{ uw_year: 2025, ultimate_premium: 5 }] },
      headers: { 'if-unmodified-since': fresh },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).updated_at).toBeTruthy();
  });

  it('F60: a non-assignee is 403 READ_ONLY on both PUTs (route-level lock)', async () => {
    const id = await newTreaty();
    for (const path of [`/api/treaties/${id}/pricing-outputs`, `/api/treaties/${id}/pricing-yearly`]) {
      const res = await harness.fetchApp('PUT', path, {
        body: path.endsWith('yearly') ? { rows: [] } : { epi: 1 },
        headers: asOther,
      });
      expect(res.status, path).toBe(403);
      expect((await res.json()).code).toBe('READ_ONLY');
    }
  });

  // ── F61 ──────────────────────────────────────────────────────────────────
  it('F61: snapshot created_by is the verified actor — a forged body value is ignored', async () => {
    const id = await newTreaty();
    const snap = await harness.fetchApp('POST', `/api/pricing/${id}/component-snapshot`, {
      body: { label: 'iter-1', components: [{ component_name: 'Attritional' }], created_by: 'FORGED-NAME' },
    }).then((r) => r.json());
    expect(snap.id).toBeTruthy();
    expect(snap.created_by).not.toBe('FORGED-NAME');
    expect(snap.created_by).toBeTruthy(); // verified identity (display name or user id)
  });

  it('F61: a non-assignee cannot delete another contract\'s snapshot by enumerating ids', async () => {
    const id = await newTreaty();
    const snap = await harness.fetchApp('POST', `/api/pricing/${id}/component-snapshot`, {
      body: { label: 'keep-me', components: [] },
    }).then((r) => r.json());

    const res = await harness.fetchApp('DELETE', `/api/pricing/component-snapshot/${snap.id}`, { headers: asOther });
    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT 1 FROM public.pricing_component_snapshots WHERE id=$1', [snap.id]);
    expect(rows.length).toBe(1); // still there

    const gone = await harness.fetchApp('DELETE', `/api/pricing/component-snapshot/${snap.id}`);
    expect(gone.status).toBe(200); // the assignee may delete it
    const { rows: after } = await pool.query('SELECT 1 FROM public.pricing_component_snapshots WHERE id=$1', [snap.id]);
    expect(after.length).toBe(0);
  });

  it('F61: deleting an unknown or non-integer snapshot id is a 404, not a silent 200', async () => {
    expect((await harness.fetchApp('DELETE', '/api/pricing/component-snapshot/999999999')).status).toBe(404);
    expect((await harness.fetchApp('DELETE', '/api/pricing/component-snapshot/abc')).status).toBe(404);
  });

  // ── F106 ─────────────────────────────────────────────────────────────────
  it('F106: a curve that does not match its slot\'s occupancy/loss category is a 422', async () => {
    const id = await newTreaty();
    await pool.query(
      `INSERT INTO public.contract_cresta_data (contract_id, country_id, zone_id, zone_name, eq_agg,
         residential_bldg_pct, commercial_bldg_pct, commercial_cont_pct, industrial_bldg_pct, industrial_cont_pct)
       VALUES ($1,$2,'IT-Z1','IT Zone 1', 1000000, 0, 100, 0, 0, 0)`,
      [id, refs.country_id],
    );
    const mk = async (lossCategory, taxonomy, occupancy) => {
      const { rows } = await pool.query(
        `INSERT INTO public.gem_vulnerability_function
           (model_version, country_code, country_name, loss_category, taxonomy, occupancy, imt, imls, mean_lrs)
         VALUES ('IT-M4', 'ZZIT', 'IT Land', $1, $2, $3, 'PGA', '{0.1,0.2,0.4}', '{0.01,0.1,0.3}')
         RETURNING id`,
        [lossCategory, taxonomy, occupancy],
      );
      gemCurveIds.push(Number(rows[0].id));
      return Number(rows[0].id);
    };
    const fatalCurve = await mk('fatalities', `IT/FATAL/RES-${Date.now()}`, 'RES');
    const comStructural = await mk('structural', `IT/OK/COM-${Date.now()}`, 'COM');

    // A fatalities curve on a building slot must be rejected, not priced.
    const bad = await harness.fetchApp('POST', `/api/pricing/gem/${id}/compute`, {
      body: { curveAssignments: { commercialBldg: fatalCurve }, intensities: { PGA: 0.3 } },
    });
    expect(bad.status).toBe(422);
    const badBody = await bad.json();
    expect(badBody.code).toBe('CURVE_SLOT_MISMATCH');
    expect(badBody.error).toMatch(/commercialBldg/);

    // The matching curve computes fine.
    const ok = await harness.fetchApp('POST', `/api/pricing/gem/${id}/compute`, {
      body: { curveAssignments: { commercialBldg: comStructural }, intensities: { PGA: 0.3 } },
    });
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    // PGA 0.30 sits midway between (0.2 → 0.1) and (0.4 → 0.3): MDR 0.2 × 1,000,000 TSI.
    expect(okBody.groundUpEqLoss).toBeCloseTo(200_000, 0);
  });
});
