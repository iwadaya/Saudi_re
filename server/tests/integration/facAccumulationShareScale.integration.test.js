// server/tests/integration/facAccumulationShareScale.integration.test.js
//
// Regression guard for percent-scale risk shares in the accumulation engine.
// Risk-level shares (our_share_pct / ri_share_pct) are stored as 0..100 in
// fac_risk, while location-level carrier shares are stored as fractions (0..1).
// The accumulation math must convert the risk-level fallback by /100.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const d = shouldSkipDb ? describe.skip : describe;

d('fac accumulation share scale', () => {
  let app;
  let refs;
  let facCobId;

  beforeAll(async () => {
    app = await bootApp();
    {
      const seeded = await seedRefs({ category: 'PROPORTIONAL' });
      refs = {
        cedant_id: seeded.cedant_id,
        broker_id: seeded.broker_id,
        country_id: seeded.country_id,
        currency_id: seeded.currency_id,
      };
    }
    const { rows } = await pool.query(
      `SELECT fac_cob_id
         FROM public.fac_class_of_business
        WHERE rating_family = 'SCHEDULE_PROPERTY'
        LIMIT 1`,
    );
    facCobId = rows[0]?.fac_cob_id || null;
    expect(facCobId).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await closePools();
  });

  async function createRiskWithOneLocation({ insuredName, zone, sharePct, status }) {
    const created = await app.fetchApp('POST', '/api/fac/risks', {
      body: {
        insured_name: insuredName,
        fac_cob_id: facCobId,
        uw_year: 2026,
        status,
        our_share_pct: sharePct,
        ...refs,
      },
    });
    expect(created.status).toBe(201);
    const risk = await created.json();
    expect(risk.fac_risk_id).toBeTruthy();

    const locRes = await app.fetchApp('PUT', `/api/fac/risks/${risk.fac_risk_id}/locations`, {
      body: {
        locations: [
          {
            location_name: `${insuredName} Site`,
            cresta_zone: zone,
            pd_si: 100_000_000,
            bi_si: 0,
            pd_pml_pct: 1,
          },
        ],
      },
    });
    expect(locRes.status).toBe(200);
    return risk.fac_risk_id;
  }

  it('interprets risk-level shares as percentages in zone committed/adding maths', async () => {
    const zone = `IT-SHARE-ZONE-${Date.now()}`;

    // Bound committed exposure: 100m x 100% PML x 15% share = 15m.
    const boundRiskId = await createRiskWithOneLocation({
      insuredName: 'IT Bound Percent Share',
      zone,
      sharePct: 15,
      status: 'BOUND',
    });
    expect(boundRiskId).toBeTruthy();

    // Refresh the materialized view so the bound position is visible as committed.
    const refresh = await app.fetchApp('POST', '/api/fac/accumulation/refresh', { body: {} });
    expect(refresh.status).toBe(200);

    // Candidate risk contribution: 100m x 100% PML x 20% share = 20m.
    const draftRiskId = await createRiskWithOneLocation({
      insuredName: 'IT Draft Percent Share',
      zone,
      sharePct: 20,
      status: 'DRAFT',
    });
    expect(draftRiskId).toBeTruthy();

    // Per-risk line check also uses risk-level share, so set a capacity band to
    // force that check to execute and assert the same 20% interpretation.
    const pricing = await app.fetchApp('PUT', `/api/fac/risks/${draftRiskId}/pricing`, {
      body: { max_capacity_pct: 0.3 },
    });
    expect(pricing.status).toBe(200);

    const out = await app.fetchApp('GET', `/api/fac/risks/${draftRiskId}/accumulation`)
      .then((r) => r.json());
    const line = out.checks.find((c) => c.level === 'PER_RISK_LINE');
    const check = out.checks.find(
      (c) => c.level === 'ZONE_ACCUMULATION' && c.zone === zone,
    );
    expect(line).toBeTruthy();
    expect(line.written).toBeCloseTo(20_000_000, 2);
    expect(check).toBeTruthy();
    expect(check.committed).toBeCloseTo(15_000_000, 2);
    expect(check.adding).toBeCloseTo(20_000_000, 2);
    expect(check.wouldBe).toBeCloseTo(35_000_000, 2);
  }, 60_000);
});
