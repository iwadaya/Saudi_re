// server/tests/integration/facLayersAndFamilies.integration.test.js
//
// Phase 3 against a real database: the excess tower, and the four rating
// families that no longer reach the property engine.
//
// The rate tables migration 136 creates ship EMPTY by design, so these tests
// load their own fixtures into them and clean them up afterwards. That is
// also the point of the first group: with nothing loaded, a marine or
// casualty risk must come back with a named reason, not a price and not a
// stack trace.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: fac layers and the Phase 3 families', () => {
  let harness;
  const risks = [];
  let classes;

  const cobFor = (code) => classes.find((c) => c.code === code);

  async function newRisk(body = {}) {
    const r = await harness
      .fetchApp('POST', '/api/fac/risks', { body: { insured_name: 'Phase 3 IT Risk', ...body } })
      .then((x) => x.json());
    risks.push(r.fac_risk_id);
    return r.fac_risk_id;
  }

  beforeAll(async () => {
    harness = await bootApp();
    classes = await harness.fetchApp('GET', '/api/fac/lookups/classes').then((r) => r.json());
  });

  afterAll(async () => {
    // Leave the rate tables as migration 136 shipped them: empty.
    await pool.query("DELETE FROM public.fac_liability_base_rate WHERE source = 'INTEGRATION_TEST'");
    await pool.query("DELETE FROM public.fac_ilf_curve WHERE source = 'INTEGRATION_TEST'");
    await pool.query("DELETE FROM public.fac_transit_base_rate WHERE source = 'INTEGRATION_TEST'");
    await pool.query("DELETE FROM public.fac_hull_base_rate WHERE source = 'INTEGRATION_TEST'");
    await pool.query("DELETE FROM public.fac_hull_factor WHERE source = 'INTEGRATION_TEST'");
    await pool.query("DELETE FROM public.fac_war_rate WHERE source = 'INTEGRATION_TEST'");
    if (harness) {
      for (const id of risks) {
        try { await harness.fetchApp('DELETE', `/api/fac/risks/${id}`); } catch { /* best effort */ }
      }
      await harness.close();
    }
    await closePools();
  });

  // ── The tower ───────────────────────────────────────────────────────────

  describe('the excess tower', () => {
    it('starts empty and round-trips a three-layer tower', async () => {
      const id = await newRisk({ placement_type: 'NON_PROPORTIONAL' });

      const before = await harness.fetchApp('GET', `/api/fac/risks/${id}/layers`).then((r) => r.json());
      expect(before).toEqual([]);

      const saved = await harness.fetchApp('PUT', `/api/fac/risks/${id}/layers`, {
        body: {
          layers: [
            { layer_no: 1, attachment: 0, limit_amount: 5_000_000, our_share_pct: 0.25, reinstatements: 2, premium: 400_000 },
            { layer_no: 2, attachment: 5_000_000, limit_amount: 10_000_000, our_share_pct: 0.10, reinstatements: 1, premium: 250_000 },
            { layer_no: 3, attachment: 15_000_000, limit_amount: null, our_share_pct: 0.05, reinstatements: null, premium: 90_000 },
          ],
        },
      }).then((r) => r.json());

      expect(saved).toHaveLength(3);
      expect(saved.map((l) => l.layer_no)).toEqual([1, 2, 3]);
      // NULL is unlimited, and unlimited is not zero.
      expect(saved[2].limit_amount).toBeNull();
      expect(saved[2].reinstatements).toBeNull();
      expect(Number(saved[1].attachment)).toBe(5_000_000);
    });

    it('replaces the whole tower on save, so a removed layer is gone', async () => {
      const id = await newRisk({ placement_type: 'NON_PROPORTIONAL' });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/layers`, {
        body: {
          layers: [
            { layer_no: 1, attachment: 0, limit_amount: 1_000_000 },
            { layer_no: 2, attachment: 1_000_000, limit_amount: 4_000_000 },
          ],
        },
      });
      const after = await harness.fetchApp('PUT', `/api/fac/risks/${id}/layers`, {
        body: { layers: [{ layer_no: 1, attachment: 0, limit_amount: 1_000_000 }] },
      }).then((r) => r.json());
      expect(after).toHaveLength(1);
    });

    it('refuses a layer number outside the tower range', async () => {
      const id = await newRisk({ placement_type: 'NON_PROPORTIONAL' });
      const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/layers`, {
        body: { layers: [{ layer_no: 99, attachment: 0, limit_amount: 1_000_000 }] },
      });
      expect(res.status).toBe(400);
    });

    it('refuses a zero or negative limit — unlimited is NULL, not 0', async () => {
      const id = await newRisk({ placement_type: 'NON_PROPORTIONAL' });
      const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/layers`, {
        body: { layers: [{ layer_no: 1, attachment: 0, limit_amount: 0 }] },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('deletes the tower with the risk', async () => {
      const id = await newRisk({ placement_type: 'NON_PROPORTIONAL' });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/layers`, {
        body: { layers: [{ layer_no: 1, attachment: 0, limit_amount: 1_000_000 }] },
      });
      await harness.fetchApp('DELETE', `/api/fac/risks/${id}`);
      const { rows } = await pool.query(
        'SELECT 1 FROM public.fac_layer WHERE fac_risk_id = $1', [id],
      );
      expect(rows).toHaveLength(0);
    });

    it('records the save in the audit trail', async () => {
      const id = await newRisk({ placement_type: 'NON_PROPORTIONAL' });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/layers`, {
        body: { layers: [{ layer_no: 1, attachment: 0, limit_amount: 1_000_000 }] },
      });
      const events = await harness
        .fetchApp('GET', `/api/fac/risks/${id}/audit-events`).then((r) => r.json());
      const list = Array.isArray(events) ? events : events.events || [];
      expect(list.some((e) => e.event_type === 'FAC_LAYERS_SAVED')).toBe(true);
    });
  });

  // ── Families with nothing loaded ────────────────────────────────────────

  describe('a family with no rates loaded says so', () => {
    it('prices a liability risk to a named reason, not a crash', async () => {
      const gl = cobFor('GL');
      const id = await newRisk({ fac_cob_id: gl.fac_cob_id, uw_year: 2026 });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: {
          sections: [{
            section_no: 1, fac_cob_id: gl.fac_cob_id, exposure_base: 250_000_000,
            exposure_unit: 'TURNOVER', limit_amount: 5_000_000,
          }],
        },
      });
      const priced = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
        .then((r) => r.json());

      expect(priced.ok).toBe(true);
      expect(priced.family).toBe('LIABILITY_LIMIT');
      const ilf = priced.technical.candidates.find((c) => c.code === 'ILF_CURVE');
      expect(ilf.available).toBe(false);
      expect(ilf.unavailableReason).toMatch(/rate/i);
    });

    it('serves the rate-table endpoint empty rather than 404', async () => {
      const tables = await harness
        .fetchApp('GET', '/api/fac/reference/rate-tables').then((r) => r.json());
      expect(Array.isArray(tables.liability_base_rates)).toBe(true);
      expect(Array.isArray(tables.ilf_curves)).toBe(true);
      expect(Array.isArray(tables.war_rates)).toBe(true);
    });
  });

  // ── Families with rates loaded ──────────────────────────────────────────

  describe('with rates loaded, each family prices on its own basis', () => {
    it('prices casualty against turnover through an ILF curve', async () => {
      const gl = cobFor('GL');
      await pool.query(
        `INSERT INTO public.fac_liability_base_rate
           (fac_cob_id, territory, basis_unit, basis_divisor, basic_limit,
            loss_cost_per_unit, source)
         VALUES ($1, 'WORLDWIDE', 'TURNOVER', 1000000, 1000000, 400, 'INTEGRATION_TEST')`,
        [gl.fac_cob_id],
      );
      await pool.query(
        `INSERT INTO public.fac_ilf_curve
           (curve_code, curve_name, family_code, territory, source, kind, basic_limit, params)
         VALUES ('IT-GL-WW', 'Test GL worldwide', 'LIABILITY_LIMIT', 'WORLDWIDE',
                 'INTEGRATION_TEST', 'POWER', 1000000, '{"doubling_loading": 0.20}'::jsonb)`,
      );

      const id = await newRisk({ fac_cob_id: gl.fac_cob_id, uw_year: 2026 });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: {
          sections: [{
            section_no: 1, fac_cob_id: gl.fac_cob_id, exposure_base: 250_000_000,
            exposure_unit: 'TURNOVER', limit_amount: 5_000_000,
          }],
        },
      });
      const priced = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
        .then((r) => r.json());

      const ilf = priced.technical.candidates.find((c) => c.code === 'ILF_CURVE');
      expect(ilf.available).toBe(true);
      // 250m ÷ 1m × 400 = 100,000 at the basic limit, stepped by 5^log₂(1.2).
      expect(ilf.lossCost).toBeCloseTo(100_000 * 5 ** Math.log2(1.2), 2);
      // The premium base is the turnover, not a sum insured this risk has none of.
      expect(priced.technical.premiums.expectedLoss).toBeCloseTo(ilf.lossCost, 2);
    });

    it('prices cargo against turnover and war as its own section', async () => {
      const cargo = cobFor('CARGO');
      await pool.query(
        `INSERT INTO public.fac_transit_base_rate
           (commodity, conveyance, route_region, rate_pm, source)
         VALUES ('MACHINERY', 'SEA', 'WORLDWIDE', 0.6, 'INTEGRATION_TEST')`,
      );
      await pool.query(
        `INSERT INTO public.fac_war_rate (region, basis, rate_pm, breach_ap_pm, source)
         VALUES ('ARABIAN_GULF', 'ANNUAL', 0.75, 0.9, 'INTEGRATION_TEST')`,
      );

      const id = await newRisk({ fac_cob_id: cargo.fac_cob_id, uw_year: 2026 });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: {
          sections: [{
            section_no: 1, fac_cob_id: cargo.fac_cob_id, exposure_base: 100_000_000,
            limit_amount: 5_000_000,
            exposure_detail: {
              commodity: 'MACHINERY', conveyance: 'SEA', route_region: 'WORLDWIDE',
              war_region: 'ARABIAN_GULF',
            },
          }],
        },
      });
      const priced = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
        .then((r) => r.json());

      const transit = priced.technical.candidates.find((c) => c.code === 'TRANSIT_RATE');
      const war = priced.technical.candidates.find((c) => c.code === 'WAR_SECTION');
      expect(transit.ratePm).toBeCloseTo(0.6, 6);
      expect(war.available).toBe(true);
      // War is added beside the blend, never averaged into it.
      expect(priced.technical.blendedLossCostPm).toBeCloseTo(0.6, 6);
      expect(priced.technical.additiveLoadPm).toBeCloseTo(0.75, 6);
      expect(priced.technical.expectedLossPm).toBeCloseTo(1.35, 6);
    });

    it('prices hull per mille of the agreed value, with the loaded factors', async () => {
      const hull = cobFor('HM');
      await pool.query(
        `INSERT INTO public.fac_hull_base_rate
           (vessel_type, tonnage_min, tonnage_max, rate_pm, source)
         VALUES ('BULK_CARRIER', 20000, 80000, 3.5, 'INTEGRATION_TEST')`,
      );
      await pool.query(
        `INSERT INTO public.fac_hull_factor (factor_kind, factor_key, factor, source)
         VALUES ('CLASS', 'NON_IACS', 1.30, 'INTEGRATION_TEST')
         ON CONFLICT (factor_kind, factor_key) DO NOTHING`,
      );

      const id = await newRisk({ fac_cob_id: hull.fac_cob_id, uw_year: 2026 });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: {
          sections: [{
            section_no: 1, fac_cob_id: hull.fac_cob_id, sum_insured: 30_000_000,
            exposure_detail: {
              vessel_type: 'BULK_CARRIER', tonnage: 45000, class_society: 'NON_IACS',
            },
          }],
        },
      });
      const priced = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
        .then((r) => r.json());

      const hullRate = priced.technical.candidates.find((c) => c.code === 'HULL_RATE');
      expect(hullRate.available).toBe(true);
      expect(hullRate.ratePm).toBeCloseTo(3.5 * 1.30, 6);
      expect(hullRate.diagnostics.factors_applied.CLASS.factor).toBeCloseTo(1.30, 6);
    });

    it('serves the loaded tables back through the reference endpoint', async () => {
      const tables = await harness
        .fetchApp('GET', '/api/fac/reference/rate-tables').then((r) => r.json());
      expect(tables.ilf_curves.some((c) => c.curve_code === 'IT-GL-WW')).toBe(true);
      expect(tables.hull_base_rates.some((r) => r.vessel_type === 'BULK_CARRIER')).toBe(true);
      expect(tables.war_rates.some((r) => r.region === 'ARABIAN_GULF')).toBe(true);
    });

    it('persists every candidate, available or not, to the method audit trail', async () => {
      const gl = cobFor('GL');
      const id = await newRisk({ fac_cob_id: gl.fac_cob_id, uw_year: 2026 });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: {
          sections: [{
            section_no: 1, fac_cob_id: gl.fac_cob_id, exposure_base: 250_000_000,
            exposure_unit: 'TURNOVER', limit_amount: 5_000_000,
          }],
        },
      });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
        body: { final_rate_per_mille: 1.2 },
      });
      const methods = await harness
        .fetchApp('GET', `/api/fac/risks/${id}/pricing-methods`).then((r) => r.json());
      const codes = (methods.methods || methods).map((m) => m.method_code);
      expect(codes).toContain('ILF_CURVE');
      expect(codes).toContain('BURNING_COST');
    });
  });

  // ── The property engine is untouched ────────────────────────────────────

  it('still prices a property risk exactly as before Phase 3', async () => {
    const par = cobFor('PAR');
    const occ = await pool.query(
      `SELECT occupancy_code FROM public.fac_occupancy_master
        WHERE active = true AND flexa_base_rate_pm > 0 LIMIT 1`,
    );
    const z = await pool.query(
      'SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1',
    );
    const id = await newRisk({
      fac_cob_id: par.fac_cob_id,
      occupancy_code: occ.rows[0].occupancy_code,
      risk_country_zone: z.rows[0].country_zone,
      pd_sum_insured: 100_000_000,
      bi_sum_insured: 0,
      uw_year: 2026,
    });
    const priced = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
      .then((r) => r.json());

    expect(priced.ok).toBe(true);
    expect(priced.family).toBe('SCHEDULE_PROPERTY');
    // The workbook rate is still the exposure candidate, and with no loads
    // the pipeline's gross rate is the engine's own.
    const workbook = priced.technical.candidates.find((c) => c.code === 'WORKBOOK_RATE');
    expect(workbook.available).toBe(true);
    expect(priced.technical.technicalGrossPm).toBeCloseTo(priced.result.final_gross_rate_pm, 6);
  });
});
