// server/tests/integration/facExperienceAndMethods.integration.test.js
//
// Phase 2 against a real database: the loss experience that finally reaches
// a price, the loss-cost methods behind it, and the audit trail of how they
// were combined.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: fac experience, loss-cost methods and the blend', () => {
  let harness;
  const risks = [];
  let propertyCob;
  let occupancyCode;
  let zone;

  async function newRisk(body = {}) {
    const r = await harness
      .fetchApp('POST', '/api/fac/risks', { body: { insured_name: 'Phase 2 IT Risk', ...body } })
      .then((x) => x.json());
    risks.push(r.fac_risk_id);
    return r.fac_risk_id;
  }

  /** A property risk the engine can actually price. */
  async function pricableRisk(extra = {}) {
    return newRisk({
      fac_cob_id: propertyCob.fac_cob_id,
      occupancy_code: occupancyCode,
      risk_country_zone: zone,
      pd_sum_insured: 100_000_000,
      bi_sum_insured: 0,
      uw_year: 2026,
      ...extra,
    });
  }

  beforeAll(async () => {
    harness = await bootApp();
    const classes = await harness.fetchApp('GET', '/api/fac/lookups/classes').then((r) => r.json());
    propertyCob = classes.find((c) => c.code === 'PAR');
    const occ = await pool.query(
      `SELECT occupancy_code FROM public.fac_occupancy_master
        WHERE active = true AND flexa_base_rate_pm > 0 LIMIT 1`,
    );
    const z = await pool.query(
      `SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1`,
    );
    occupancyCode = occ.rows[0]?.occupancy_code;
    zone = z.rows[0]?.country_zone;
  });

  afterAll(async () => {
    if (harness) {
      for (const id of risks) { try { await harness.fetchApp('DELETE', `/api/fac/risks/${id}`); } catch { /* best effort */ } }
      await harness.close();
    }
    await closePools();
  });

  // ── Experience basis ─────────────────────────────────────────────────
  describe('experience basis (migration 135)', () => {
    it('round-trips the per-year exposure and the risk-level assumptions', async () => {
      const id = await newRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/experience`, {
        body: {
          basis: [
            { loss_year: 2024, exposure_base: 80_000_000, premium: 90_000, rate_change_pct: 5 },
            { loss_year: 2025, exposure_base: 100_000_000, premium: 110_000, rate_change_pct: 10 },
          ],
          severity_trend_pct: 6,
          experience_years: 5,
        },
      });

      const out = await harness.fetchApp('GET', `/api/fac/risks/${id}/experience`).then((r) => r.json());
      expect(out.basis).toHaveLength(2);
      expect(Number(out.basis[0].exposure_base)).toBe(80_000_000);
      expect(Number(out.severity_trend_pct)).toBe(6);
      expect(Number(out.experience_years)).toBe(5);
    });

    it('replaces the whole set, so a removed year is removed', async () => {
      const id = await newRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/experience`, {
        body: { basis: [{ loss_year: 2024, exposure_base: 1 }, { loss_year: 2025, exposure_base: 2 }] },
      });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/experience`, {
        body: { basis: [{ loss_year: 2025, exposure_base: 2 }] },
      });
      const out = await harness.fetchApp('GET', `/api/fac/risks/${id}/experience`).then((r) => r.json());
      expect(out.basis).toHaveLength(1);
      expect(out.basis[0].loss_year).toBe(2025);
    });

    it('rejects a year outside any sane range', async () => {
      const id = await newRisk();
      const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/experience`, {
        body: { basis: [{ loss_year: 12, exposure_base: 1 }] },
      });
      expect(res.status).toBe(400);
    });

    it('writes an audit event', async () => {
      const id = await newRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/experience`, {
        body: { basis: [{ loss_year: 2025, exposure_base: 1 }] },
      });
      const { rows } = await pool.query(
        `SELECT payload FROM public.contract_audit_event
          WHERE contract_id = $1 AND event_type = 'FAC_EXPERIENCE_SAVED'`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.year_count).toBe(1);
    });

    it('cascades on risk delete', async () => {
      const id = await newRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/experience`, {
        body: { basis: [{ loss_year: 2025, exposure_base: 1 }] },
      });
      await harness.fetchApp('DELETE', `/api/fac/risks/${id}`);
      const { rows } = await pool.query(
        'SELECT 1 FROM public.fac_experience_basis WHERE fac_risk_id = $1', [id],
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ── The methods ──────────────────────────────────────────────────────
  describe('loss-cost methods through POST /price', () => {
    it('runs every method and reports the ones with no data as unavailable', async () => {
      if (!occupancyCode || !zone) return;
      const id = await pricableRisk();
      const out = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
        .then((r) => r.json());

      expect(out.ok).toBe(true);
      const byCode = Object.fromEntries(out.technical.candidates.map((c) => [c.code, c]));
      expect(byCode.WORKBOOK_RATE.available).toBe(true);
      // No history, no curve, no bound comparables in this scope.
      expect(byCode.BURNING_COST.available).toBe(false);
      expect(byCode.EXPOSURE_CURVE.available).toBe(false);
      expect(byCode.EXPOSURE_CURVE.unavailableReason).toMatch(/curve set|exposure bands/i);
      // The workbook rate therefore carries the whole weight.
      expect(out.technical.weights).toEqual({ WORKBOOK_RATE: 1 });
    });

    it('changes nothing for a risk with no Phase 2 data', async () => {
      // The invariant: technical gross equals the engine's own final gross.
      if (!occupancyCode || !zone) return;
      const id = await pricableRisk();
      const out = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, {
        body: { commission_pct: 0.2, margin_pct: 0.05, other_expenses_pct: 0.005 },
      }).then((r) => r.json());
      expect(out.technical.technicalGrossPm).toBeCloseTo(out.result.final_gross_rate_pm, 8);
    });

    it('blends in the burning cost once there is experience', async () => {
      if (!occupancyCode || !zone) return;
      const id = await pricableRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/experience`, {
        body: {
          basis: [2021, 2022, 2023, 2024, 2025].map((y) => ({ loss_year: y, exposure_base: 100_000_000 })),
          severity_trend_pct: 0,
        },
      });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/losses`, {
        body: {
          losses: Array.from({ length: 6 }, (_, i) => ({
            loss_year: 2021 + (i % 5), fgu_paid: 100_000, is_open: false,
          })),
        },
      });

      const out = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
        .then((r) => r.json());
      const burn = out.technical.candidates.find((c) => c.code === 'BURNING_COST');
      expect(burn.available).toBe(true);
      // 600k over 5 years = 120k a year on 100m = 1.2‰
      expect(burn.ratePm).toBeCloseTo(1.2, 6);
      expect(out.technical.weights.BURNING_COST).toBeGreaterThan(0);
      expect(out.technical.credibility.z).toBeGreaterThan(0);
    });

    it('keeps an excluded loss out of the rate but visible in the count', async () => {
      if (!occupancyCode || !zone) return;
      const id = await pricableRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/experience`, {
        body: {
          basis: [2024, 2025].map((y) => ({ loss_year: y, exposure_base: 100_000_000 })),
          severity_trend_pct: 0,
        },
      });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/losses`, {
        body: {
          losses: [
            { loss_year: 2025, fgu_paid: 100_000, is_open: false },
            {
              loss_year: 2024, fgu_paid: 50_000_000, is_open: false,
              exclude_from_rating: true, exclusion_reason: 'Plant since sold',
            },
          ],
        },
      });
      const out = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
        .then((r) => r.json());
      const burn = out.technical.candidates.find((c) => c.code === 'BURNING_COST');
      expect(burn.diagnostics.claims_excluded).toBe(1);
      expect(burn.diagnostics.total_as_if).toBeCloseTo(100_000, 2);
    });

    it('exposure-rates once a curve band is configured for the family', async () => {
      if (!occupancyCode || !zone) return;
      const { rows } = await pool.query(
        `SELECT curve_id FROM public.fac_exposure_curve WHERE curve_code = 'LINEAR'`,
      );
      const curveId = rows[0].curve_id;
      await pool.query(
        `INSERT INTO public.fac_curve_band (family_code, min_exposure, max_exposure, curve_id)
         VALUES ('SCHEDULE_PROPERTY', 0, NULL, $1)`,
        [curveId],
      );
      try {
        const id = await pricableRisk();
        const out = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
          .then((r) => r.json());
        const curve = out.technical.candidates.find((c) => c.code === 'EXPOSURE_CURVE');
        expect(curve.available).toBe(true);
        expect(curve.diagnostics.bands[0].curve).toBe('LINEAR');
        expect(out.technical.weights.EXPOSURE_CURVE).toBeGreaterThan(0);
      } finally {
        await pool.query(
          `DELETE FROM public.fac_curve_band WHERE family_code = 'SCHEDULE_PROPERTY' AND curve_id = $1`,
          [curveId],
        );
      }
    });
  });

  // ── The audit trail ──────────────────────────────────────────────────
  describe('per-method audit trail', () => {
    it('records every candidate behind a saved rate, weighted or not', async () => {
      if (!occupancyCode || !zone) return;
      const id = await pricableRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
        body: { commission_pct: 0.2, margin_pct: 0.05 },
      });

      const out = await harness.fetchApp('GET', `/api/fac/risks/${id}/pricing-methods`)
        .then((r) => r.json());
      const byCode = Object.fromEntries(out.methods.map((m) => [m.method_code, m]));

      expect(byCode.WORKBOOK_RATE.available).toBe(true);
      expect(Number(byCode.WORKBOOK_RATE.weight)).toBe(1);
      expect(byCode.WORKBOOK_RATE.weight_source).toBe('MECHANICAL');
      // An unavailable method is recorded with its reason and no weight —
      // so "we had no loss history" is a fact on the record, not an absence.
      expect(byCode.BURNING_COST.available).toBe(false);
      expect(byCode.BURNING_COST.unavailable_reason).toBeTruthy();
      expect(byCode.BURNING_COST.weight).toBeNull();
      expect(byCode.BURNING_COST.weight_source).toBe('EXCLUDED');
    });

    it('replaces the trail on each save rather than accumulating', async () => {
      if (!occupancyCode || !zone) return;
      const id = await pricableRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, { body: { commission_pct: 0.2 } });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, { body: { commission_pct: 0.25 } });
      const { rows } = await pool.query(
        `SELECT method_code, count(*) FROM public.fac_pricing_method
          WHERE fac_risk_id = $1 GROUP BY method_code HAVING count(*) > 1`,
        [id],
      );
      expect(rows).toHaveLength(0);
    });

    it('stores the blend on the priced row', async () => {
      if (!occupancyCode || !zone) return;
      const id = await pricableRisk();
      const saved = await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
        body: {
          commission_pct: 0.2, margin_pct: 0.05,
          blended_loss_cost_pm: 1.5, blend_weights: { WORKBOOK_RATE: 1 },
        },
      }).then((r) => r.json());
      expect(Number(saved.blended_loss_cost_pm)).toBeCloseTo(1.5, 6);
      expect(saved.blend_weights).toEqual({ WORKBOOK_RATE: 1 });
    });
  });

  // ── The curve library ────────────────────────────────────────────────
  describe('exposure-curve library', () => {
    it('serves the baseline curve and names its source', async () => {
      const out = await harness.fetchApp('GET', '/api/fac/reference/curves').then((r) => r.json());
      const linear = out.curves.find((c) => c.curve_code === 'LINEAR');
      expect(linear).toBeTruthy();
      expect(linear.kind).toBe('TABULATED');
      // Every curve has to say where it came from — a curve nobody can
      // attribute is a rate nobody can defend.
      expect(linear.source).toMatch(/G\(x\) = x/);
    });

    it('ships exactly one curve, because the rest are not ours to invent', async () => {
      const out = await harness.fetchApp('GET', '/api/fac/reference/curves').then((r) => r.json());
      expect(out.curves).toHaveLength(1);
    });
  });
});
