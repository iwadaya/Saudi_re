// server/tests/integration/facPhase4.integration.test.js
//
// Phase 4 against a real database: the last five families, multi-section
// pricing, the capacity check that has been missing since the module was
// built, and the portfolio views that read the book back.
//
// The rate tables migration 137 creates ship empty by design, so these tests
// load their own fixtures and clean up afterwards.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const SRC = 'PHASE4_INTEGRATION_TEST';

describe.skipIf(shouldSkipDb)('integration: fac Phase 4 families, capacity and portfolio', () => {
  let harness;
  const risks = [];
  let classes;

  const cobFor = (code) => classes.find((c) => c.code === code);

  async function newRisk(body = {}) {
    const r = await harness
      .fetchApp('POST', '/api/fac/risks', { body: { insured_name: 'Phase 4 IT Risk', ...body } })
      .then((x) => x.json());
    risks.push(r.fac_risk_id);
    return r.fac_risk_id;
  }

  async function setSections(id, sections) {
    return harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, { body: { sections } })
      .then((r) => r.json());
  }

  const price = (id) => harness
    .fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
    .then((r) => r.json());

  beforeAll(async () => {
    harness = await bootApp();
    classes = await harness.fetchApp('GET', '/api/fac/lookups/classes').then((r) => r.json());
  });

  afterAll(async () => {
    for (const table of [
      'fac_project_base_rate', 'fac_project_factor', 'fac_project_load_rate',
      'fac_plant_base_rate', 'fac_plant_factor',
      'fac_energy_base_rate', 'fac_energy_sublimit_rate',
      'fac_cyber_base_rate', 'fac_cyber_control_factor',
      'fac_motor_base_rate', 'fac_pa_base_rate',
      'fac_ilf_curve', 'fac_liability_base_rate', 'fac_zone_budget',
    ]) {
      try { await pool.query(`DELETE FROM public.${table} WHERE source = $1`, [SRC]); } catch { /* best effort */ }
    }
    if (harness) {
      for (const id of risks) {
        try { await harness.fetchApp('DELETE', `/api/fac/risks/${id}`); } catch { /* best effort */ }
      }
      await harness.close();
    }
    await closePools();
  });

  // ── Every family answers, loaded or not ─────────────────────────────────

  describe('a family with no rates loaded names the table to load', () => {
    const cases = [
      ['CAR', 'PROJECT_WORKS', 'PROJECT_RATE', /project rate table|contract value|project type/i],
      ['MB', 'PLANT_OPERATIONAL', 'PLANT_RATE', /plant rate table|replacement value/i],
      ['EONS', 'ENERGY_ASSET', 'ENERGY_RATE', /asset values|asset type|hazard band/i],
      ['CY1', 'CYBER_LIMIT', 'CYBER_RATE', /dependencies|revenue|cyber/i],
      ['MOT', 'MOTOR_FLEET', 'MOTOR_RATE', /vehicles|motor rate table/i],
      ['PA', 'PA_BENEFIT', 'PA_RATE', /members|PA rate table/i],
    ];

    for (const [code, family, method, reason] of cases) {
      it(`${family} reports itself unavailable, not broken`, async () => {
        const cob = cobFor(code);
        const id = await newRisk({ fac_cob_id: cob.fac_cob_id, uw_year: 2026 });
        const out = await price(id);
        expect(out.ok).toBe(true);
        expect(out.family).toBe(family);
        const candidate = out.technical.candidates.find((c) => c.code === method);
        expect(candidate).toBeTruthy();
        expect(candidate.available).toBe(false);
        expect(candidate.unavailableReason).toMatch(reason);
      });
    }
  });

  // ── With rates loaded ───────────────────────────────────────────────────

  describe('with rates loaded, each family prices on its own basis', () => {
    it('prices a project over its whole period, not per annum', async () => {
      await pool.query(
        // effective_from matters: this risk incepts on 2026-01-01, and a rate
        // that only comes into force today is correctly not applied to it.
        `INSERT INTO public.fac_project_base_rate
           (project_type, territory, contract_value_min, contract_value_max, rate_pm,
            period_factor_per_month, period_baseline_months, source, effective_from)
         VALUES ('POWER', 'WORLDWIDE', 50000000, 500000000, 2.5, 0.03, 12, $1, '2020-01-01')`,
        [SRC],
      );
      const cob = cobFor('CAR');
      const id = await newRisk({
        fac_cob_id: cob.fac_cob_id, uw_year: 2026,
        inception_date: '2026-01-01', expiry_date: '2028-01-01',
      });
      await setSections(id, [{
        section_no: 1, fac_cob_id: cob.fac_cob_id, sum_insured: 200_000_000,
        exposure_detail: { project_type: 'POWER' },
      }]);
      const out = await price(id);
      const candidate = out.technical.candidates.find((c) => c.code === 'PROJECT_RATE');
      expect(candidate.available).toBe(true);
      // 24 months at 3%/month over a 12-month baseline → 1.36 × 2.5‰.
      expect(candidate.diagnostics.period_months).toBe(24);
      expect(candidate.ratePm).toBeCloseTo(3.4, 6);
      expect(candidate.diagnostics.period_basis_note).toMatch(/whole project period/i);
    });

    it('rates plant item by item, with an item-level PML', async () => {
      await pool.query(
        `INSERT INTO public.fac_plant_base_rate (machine_type, territory, rate_pm, source)
         VALUES ('GAS_TURBINE', 'WORLDWIDE', 4.0, $1)`,
        [SRC],
      );
      const cob = cobFor('MB');
      const id = await newRisk({ fac_cob_id: cob.fac_cob_id, uw_year: 2026 });
      await setSections(id, [{
        section_no: 1, fac_cob_id: cob.fac_cob_id, sum_insured: 40_000_000,
        exposure_detail: {
          items: [{ machine_type: 'GAS_TURBINE', replacement_value: 40_000_000, pml_pct: 0.5 }],
        },
      }]);
      const out = await price(id);
      const candidate = out.technical.candidates.find((c) => c.code === 'PLANT_RATE');
      expect(candidate.available).toBe(true);
      expect(candidate.diagnostics.items[0].exposed_value).toBe(20_000_000);
      expect(candidate.lossCost).toBeCloseTo((20_000_000 * 4.0) / 1000, 2);
    });

    it('prices energy sub-limits beside the asset rate, never inside it', async () => {
      await pool.query(
        `INSERT INTO public.fac_energy_base_rate
           (asset_type, process_hazard_band, territory, rate_pm, source)
         VALUES ('OFFSHORE_PLATFORM', 'STANDARD', 'WORLDWIDE', 5.0, $1)`,
        [SRC],
      );
      await pool.query(
        `INSERT INTO public.fac_energy_sublimit_rate (sublimit_kind, sublimit_key, rate_pm, source)
         VALUES ('CONTROL_OF_WELL', 'DEFAULT', 6.0, $1)`,
        [SRC],
      );
      const cob = cobFor('EOFF');
      const id = await newRisk({ fac_cob_id: cob.fac_cob_id, uw_year: 2026 });
      await setSections(id, [{
        section_no: 1, fac_cob_id: cob.fac_cob_id, sum_insured: 800_000_000,
        exposure_detail: {
          asset_type: 'OFFSHORE_PLATFORM', process_hazard_band: 'STANDARD',
          sublimits: { CONTROL_OF_WELL: 150_000_000 },
        },
      }]);
      const out = await price(id);
      const asset = out.technical.candidates.find((c) => c.code === 'ENERGY_RATE');
      const cow = out.technical.candidates.find((c) => c.code === 'SUBLIMIT_CONTROL_OF_WELL');
      expect(asset.ratePm).toBeCloseTo(5.0, 6);
      expect(cow.available).toBe(true);
      // Added to the blend, never averaged into it.
      expect(out.technical.blendedLossCostPm).toBeCloseTo(5.0, 6);
      expect(out.technical.additiveLoadPm).toBeGreaterThan(0);
      expect(out.technical.additiveSections.map((s) => s.code))
        .toContain('SUBLIMIT_CONTROL_OF_WELL');
    });

    it('refuses to price an untagged cyber risk, however complete the rest is', async () => {
      await pool.query(
        `INSERT INTO public.fac_cyber_base_rate
           (industry_code, revenue_min, revenue_max, territory, basic_limit,
            rate_per_million, source)
         VALUES ('ALL', 100000000, 1000000000, 'WORLDWIDE', 5000000, 12000, $1)`,
        [SRC],
      );
      await pool.query(
        `INSERT INTO public.fac_ilf_curve
           (curve_code, curve_name, family_code, territory, source, kind, basic_limit, params)
         VALUES ('IT-CY-WW', 'Test cyber', 'CYBER_LIMIT', 'WORLDWIDE', $1, 'POWER', 5000000,
                 '{"doubling_loading": 0.45}'::jsonb)`,
        [SRC],
      );
      const cob = cobFor('CY1');
      const untaggedId = await newRisk({ fac_cob_id: cob.fac_cob_id, uw_year: 2026 });
      await setSections(untaggedId, [{
        section_no: 1, fac_cob_id: cob.fac_cob_id, exposure_base: 400_000_000,
        limit_amount: 10_000_000, exposure_detail: {},
      }]);
      const untagged = await price(untaggedId);
      const blocked = untagged.technical.candidates.find((c) => c.code === 'CYBER_RATE');
      expect(blocked.available).toBe(false);
      expect(blocked.diagnostics.gate).toBe('DEPENDENCIES_UNTAGGED');

      const taggedId = await newRisk({ fac_cob_id: cob.fac_cob_id, uw_year: 2026 });
      await setSections(taggedId, [{
        section_no: 1, fac_cob_id: cob.fac_cob_id, exposure_base: 400_000_000,
        limit_amount: 10_000_000, exposure_detail: { dependencies: ['AWS'] },
      }]);
      const tagged = await price(taggedId);
      const priced = tagged.technical.candidates.find((c) => c.code === 'CYBER_RATE');
      expect(priced.available).toBe(true);
      expect(priced.diagnostics.loss_cost_per_million).toBeGreaterThan(0);
    });

    it('costs a motor fleet per vehicle-year', async () => {
      await pool.query(
        `INSERT INTO public.fac_motor_base_rate
           (vehicle_category, territory, od_cost_per_vehicle_year,
            tpl_cost_per_vehicle_year, tpl_basic_limit, source)
         VALUES ('PRIVATE', 'WORLDWIDE', 900, 400, 1000000, $1)`,
        [SRC],
      );
      const cob = cobFor('MOT');
      const id = await newRisk({ fac_cob_id: cob.fac_cob_id, uw_year: 2026 });
      await setSections(id, [{
        section_no: 1, fac_cob_id: cob.fac_cob_id, exposure_base: 500,
        sum_insured: 60_000_000, limit_amount: 1_000_000,
        exposure_detail: { vehicle_category: 'PRIVATE' },
      }]);
      const out = await price(id);
      const candidate = out.technical.candidates.find((c) => c.code === 'MOTOR_RATE');
      expect(candidate.available).toBe(true);
      expect(candidate.lossCost).toBeCloseTo(500 * 1300, 2);
      expect(candidate.diagnostics.cost_per_vehicle_year).toBeCloseTo(1300, 6);
    });

    it('rates a PA scheme per benefit unit, and refuses the wrong cover basis', async () => {
      await pool.query(
        `INSERT INTO public.fac_pa_base_rate
           (occupational_class, cover_basis, territory, rate_per_unit, source)
         VALUES ('1', '24_HOUR', 'WORLDWIDE', 0.0012, $1)`,
        [SRC],
      );
      const cob = cobFor('PA');
      const id = await newRisk({ fac_cob_id: cob.fac_cob_id, uw_year: 2026 });
      await setSections(id, [{
        section_no: 1, fac_cob_id: cob.fac_cob_id, exposure_base: 400,
        exposure_detail: { occupational_class: '1', benefit_units: 250_000 },
      }]);
      const out = await price(id);
      const candidate = out.technical.candidates.find((c) => c.code === 'PA_RATE');
      expect(candidate.available).toBe(true);
      expect(candidate.lossCost).toBeCloseTo(400 * 250_000 * 0.0012, 2);

      // Occupational-only has no rate loaded, and 24-hour is not substituted.
      const occId = await newRisk({ fac_cob_id: cob.fac_cob_id, uw_year: 2026 });
      await setSections(occId, [{
        section_no: 1, fac_cob_id: cob.fac_cob_id, exposure_base: 400,
        exposure_detail: {
          occupational_class: '1', benefit_units: 250_000, cover_basis: 'OCCUPATIONAL',
        },
      }]);
      const occOut = await price(occId);
      expect(occOut.technical.candidates.find((c) => c.code === 'PA_RATE').available).toBe(false);
    });
  });

  // ── Multi-section ───────────────────────────────────────────────────────

  describe('multi-section pricing', () => {
    it('prices a property + liability risk through both families and sums the money', async () => {
      await pool.query(
        `INSERT INTO public.fac_liability_base_rate
           (fac_cob_id, territory, basis_unit, basis_divisor, basic_limit,
            loss_cost_per_unit, source)
         VALUES ($1, 'WORLDWIDE', 'TURNOVER', 1000000, 1000000, 400, $2)`,
        [cobFor('GL').fac_cob_id, SRC],
      );
      await pool.query(
        `INSERT INTO public.fac_ilf_curve
           (curve_code, curve_name, family_code, territory, source, kind, basic_limit, params)
         VALUES ('IT-P4-GL', 'Test GL', 'LIABILITY_LIMIT', 'WORLDWIDE', $1, 'POWER', 1000000,
                 '{"doubling_loading": 0.20}'::jsonb)`,
        [SRC],
      );

      const par = cobFor('PAR');
      const gl = cobFor('GL');
      const occ = await pool.query(
        `SELECT occupancy_code FROM public.fac_occupancy_master
          WHERE active = true AND flexa_base_rate_pm > 0 LIMIT 1`,
      );
      const zone = await pool.query(
        'SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1',
      );
      const id = await newRisk({
        fac_cob_id: par.fac_cob_id,
        occupancy_code: occ.rows[0].occupancy_code,
        risk_country_zone: zone.rows[0].country_zone,
        pd_sum_insured: 0, bi_sum_insured: 0, uw_year: 2026,
      });
      await setSections(id, [
        { section_no: 1, fac_cob_id: par.fac_cob_id, sum_insured: 100_000_000 },
        {
          section_no: 2, fac_cob_id: gl.fac_cob_id, exposure_base: 250_000_000,
          exposure_unit: 'TURNOVER', limit_amount: 5_000_000,
        },
      ]);

      const out = await price(id);
      expect(out.ok).toBe(true);
      expect(out.sections).toHaveLength(2);
      expect(out.sections.map((s) => s.family))
        .toEqual(['SCHEDULE_PROPERTY', 'LIABILITY_LIMIT']);
      // Each on its own base — one sum insured for both was the old shortcut.
      expect(Number(out.sections[0].premium_base)).toBe(100_000_000);
      expect(Number(out.sections[1].premium_base)).toBe(250_000_000);
      expect(out.technical.multiSection).toBe(true);
      const total = out.sections.reduce((t, s) => t + s.loss_cost, 0);
      expect(out.technical.premiums.expectedLoss).toBeCloseTo(total, 2);
    });

    it('records each section group\'s methods against its own section', async () => {
      const par = cobFor('PAR');
      const gl = cobFor('GL');
      const occ = await pool.query(
        `SELECT occupancy_code FROM public.fac_occupancy_master
          WHERE active = true AND flexa_base_rate_pm > 0 LIMIT 1`,
      );
      const zone = await pool.query(
        'SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1',
      );
      const id = await newRisk({
        fac_cob_id: par.fac_cob_id,
        occupancy_code: occ.rows[0].occupancy_code,
        risk_country_zone: zone.rows[0].country_zone,
        pd_sum_insured: 0, bi_sum_insured: 0, uw_year: 2026,
      });
      await setSections(id, [
        { section_no: 1, fac_cob_id: par.fac_cob_id, sum_insured: 100_000_000 },
        {
          section_no: 2, fac_cob_id: gl.fac_cob_id, exposure_base: 250_000_000,
          exposure_unit: 'TURNOVER', limit_amount: 5_000_000,
        },
      ]);
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
        body: { final_rate_per_mille: 1.2 },
      });

      const { rows } = await pool.query(
        `SELECT method_code, section_id FROM public.fac_pricing_method
          WHERE fac_risk_id = $1 ORDER BY method_code`,
        [id],
      );
      // Section-scoped rows for each family's own method, and risk-level rows
      // for the blend across them.
      expect(rows.some((r) => r.method_code === 'ILF_CURVE' && r.section_id)).toBe(true);
      expect(rows.some((r) => r.method_code === 'WORKBOOK_RATE' && r.section_id)).toBe(true);
      expect(rows.some((r) => r.method_code === 'SECTION_TOTAL' && !r.section_id)).toBe(true);
    });

    it('stores the technical rate and adequacy for the portfolio view', async () => {
      const par = cobFor('PAR');
      const occ = await pool.query(
        `SELECT occupancy_code FROM public.fac_occupancy_master
          WHERE active = true AND flexa_base_rate_pm > 0 LIMIT 1`,
      );
      const zone = await pool.query(
        'SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1',
      );
      const id = await newRisk({
        fac_cob_id: par.fac_cob_id,
        occupancy_code: occ.rows[0].occupancy_code,
        risk_country_zone: zone.rows[0].country_zone,
        pd_sum_insured: 100_000_000, bi_sum_insured: 0, uw_year: 2026,
      });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
        body: { final_rate_per_mille: 2.0 },
      });
      const { rows } = await pool.query(
        `SELECT technical_gross_rate_pm, technical_adequacy
           FROM public.fac_pricing WHERE fac_risk_id = $1`,
        [id],
      );
      expect(Number(rows[0].technical_gross_rate_pm)).toBeGreaterThan(0);
      expect(Number(rows[0].technical_adequacy)).toBeCloseTo(
        2.0 / Number(rows[0].technical_gross_rate_pm), 3,
      );
    });
  });

  // ── Capacity (F14) ──────────────────────────────────────────────────────

  describe('the capacity check', () => {
    it('reports committed exposure and says when no budget is set', async () => {
      const par = cobFor('PAR');
      const id = await newRisk({
        fac_cob_id: par.fac_cob_id, uw_year: 2026, our_share_pct: 50,
      });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/locations`, {
        body: {
          locations: [{
            location_name: 'Site A', cresta_zone: 'P4-TEST-ZONE',
            pd_si: 100_000_000, bi_si: 0, pd_pml_pct: 0.4,
          }],
        },
      });
      const out = await harness.fetchApp('GET', `/api/fac/risks/${id}/accumulation`)
        .then((r) => r.json());
      expect(out.status).toBe('NO_BUDGET');
      const zone = out.checks.find((c) => c.level === 'ZONE_ACCUMULATION');
      expect(zone.zone).toBe('P4-TEST-ZONE');
      expect(zone.adding).toBeCloseTo(100_000_000 * 0.4 * 0.5, 2);
      expect(zone.message).toMatch(/load one in fac_zone_budget/i);
    });

    it('breaches once a budget is loaded and the zone is full', async () => {
      await pool.query(
        `INSERT INTO public.fac_zone_budget (cresta_zone, peril, budget_pml, source)
         VALUES ('P4-TIGHT-ZONE', 'ALL', 1000000, $1)`,
        [SRC],
      );
      const par = cobFor('PAR');
      const id = await newRisk({ fac_cob_id: par.fac_cob_id, uw_year: 2026, our_share_pct: 100 });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/locations`, {
        body: {
          locations: [{
            location_name: 'Site B', cresta_zone: 'P4-TIGHT-ZONE',
            pd_si: 50_000_000, bi_si: 0, pd_pml_pct: 1,
          }],
        },
      });
      const out = await harness.fetchApp('GET', `/api/fac/risks/${id}/accumulation`)
        .then((r) => r.json());
      expect(out.status).toBe('BREACH');
      expect(out.referral).toBe(true);
      expect(out.reasons.join(' ')).toMatch(/over by/i);
    });

    it('refuses a bind that breaches, and allows it with a recorded override', async () => {
      const par = cobFor('PAR');
      const id = await newRisk({ fac_cob_id: par.fac_cob_id, uw_year: 2026, our_share_pct: 100 });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/locations`, {
        body: {
          locations: [{
            location_name: 'Site C', cresta_zone: 'P4-TIGHT-ZONE',
            pd_si: 80_000_000, bi_si: 0, pd_pml_pct: 1,
          }],
        },
      });
      await pool.query(
        "UPDATE public.fac_risk SET status = 'QUOTED' WHERE fac_risk_id = $1", [id],
      );

      const refused = await harness.fetchApp('POST', `/api/fac/risks/${id}/bind`, { body: {} });
      expect(refused.status).toBe(409);
      const body = await refused.json();
      expect(body.code).toBe('CAPACITY_BREACH');

      const allowed = await harness.fetchApp('POST', `/api/fac/risks/${id}/bind`, {
        body: {
          capacity_override: true,
          capacity_override_reason: 'Referral approved by the chief underwriter',
        },
      });
      expect(allowed.status).toBe(200);

      const events = await harness.fetchApp('GET', `/api/fac/risks/${id}/audit-events`)
        .then((r) => r.json());
      const list = Array.isArray(events) ? events : events.events || [];
      const bound = list.find((e) => e.event_type === 'FAC_BOUND');
      expect(bound.payload.capacity_override).toBe(true);
      expect(bound.payload.capacity_status).toBe('BREACH');
      expect(bound.payload.capacity_override_reason).toMatch(/chief underwriter/i);
    });

    it('rejects an override with no reason', async () => {
      const par = cobFor('PAR');
      const id = await newRisk({ fac_cob_id: par.fac_cob_id, uw_year: 2026 });
      await pool.query(
        "UPDATE public.fac_risk SET status = 'QUOTED' WHERE fac_risk_id = $1", [id],
      );
      const res = await harness.fetchApp('POST', `/api/fac/risks/${id}/bind`, {
        body: { capacity_override: true },
      });
      expect(res.status).toBe(400);
    });

    it('counts a bound risk in the next risk\'s check', async () => {
      // The bind above refreshed the view; a new risk in the same zone must
      // now see that committed exposure.
      const par = cobFor('PAR');
      const id = await newRisk({ fac_cob_id: par.fac_cob_id, uw_year: 2026, our_share_pct: 100 });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/locations`, {
        body: {
          locations: [{
            location_name: 'Site D', cresta_zone: 'P4-TIGHT-ZONE',
            pd_si: 1_000_000, bi_si: 0, pd_pml_pct: 1,
          }],
        },
      });
      const out = await harness.fetchApp('GET', `/api/fac/risks/${id}/accumulation`)
        .then((r) => r.json());
      const zone = out.checks.find((c) => c.level === 'ZONE_ACCUMULATION');
      expect(zone.committed).toBeGreaterThan(0);
    });
  });

  // ── Portfolio ───────────────────────────────────────────────────────────

  describe('portfolio analytics', () => {
    it('reports the adequacy distribution, counting what it could not measure', async () => {
      const out = await harness.fetchApp('GET', '/api/fac/portfolio/adequacy?uwYear=2026')
        .then((r) => r.json());
      expect(Array.isArray(out.bands)).toBe(true);
      expect(out.bands).toHaveLength(6);
      expect(typeof out.unmeasured).toBe('number');
    });

    it('reports the hit ratio by family with the selection gap', async () => {
      const out = await harness.fetchApp('GET', '/api/fac/portfolio/hit-ratio?uwYear=2026')
        .then((r) => r.json());
      expect(typeof out.quoted).toBe('number');
      expect(Array.isArray(out.families)).toBe(true);
      for (const f of out.families) {
        expect(f).toHaveProperty('selection_gap');
      }
    });

    it('reports capacity utilisation, keeping zones with no budget visible', async () => {
      const out = await harness.fetchApp('GET', '/api/fac/portfolio/capacity')
        .then((r) => r.json());
      expect(Array.isArray(out.zones)).toBe(true);
      expect(typeof out.zones_without_budget).toBe('number');
    });
  });
});
