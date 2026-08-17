// server/tests/integration/facSectionsAndPricing.integration.test.js
//
// The facultative multi-class slice, end to end against a real database:
//
//   • fac_risk_section round-trips a multi-section, multi-class split with a
//     sum insured per class (migration 133, finding F6). Before it existed the
//     screen collected all of that and persisted only the first class and the
//     summed total, so it vanished on reload.
//   • fac_class_of_business carries the taxonomy every class is mapped into
//     (migration 134), and a section resolves its rating family from it.
//   • POST /price is the server-side pricing authority — it returns either a
//     price or a blocker, and never throws at a class it cannot rate yet.
//   • PUT /pricing stamps provenance and counts drift against its own
//     recomputation.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: fac sections, taxonomy and server-side pricing', () => {
  let harness;
  const risks = [];
  let propertyCob;
  let hullCob;

  async function newRisk(body = {}) {
    const r = await harness
      .fetchApp('POST', '/api/fac/risks', { body: { insured_name: 'Sections IT Risk', ...body } })
      .then((x) => x.json());
    risks.push(r.fac_risk_id);
    return r.fac_risk_id;
  }

  beforeAll(async () => {
    harness = await bootApp();
    const classes = await harness.fetchApp('GET', '/api/fac/lookups/classes').then((r) => r.json());
    propertyCob = classes.find((c) => c.code === 'PAR');
    hullCob = classes.find((c) => c.code === 'HM');
  });

  afterAll(async () => {
    if (harness) {
      for (const id of risks) { try { await harness.fetchApp('DELETE', `/api/fac/risks/${id}`); } catch { /* best effort */ } }
      await harness.close();
    }
    await closePools();
  });

  // ── Taxonomy ─────────────────────────────────────────────────────────
  describe('taxonomy (migration 134)', () => {
    it('maps every class to a segment, a rating family and an exposure basis', async () => {
      const classes = await harness.fetchApp('GET', '/api/fac/lookups/classes').then((r) => r.json());
      expect(classes.length).toBeGreaterThan(0);
      for (const c of classes) {
        expect(c.segment_code).toBeTruthy();
        expect(c.rating_family).toBeTruthy();
        expect(c.exposure_basis).toBeTruthy();
      }
    });

    it('separates hull, cargo and marine liability, which price nothing alike', async () => {
      const classes = await harness.fetchApp('GET', '/api/fac/lookups/classes').then((r) => r.json());
      const byCode = Object.fromEntries(classes.map((c) => [c.code, c]));
      expect(byCode.HM.rating_family).toBe('HULL_VALUE');
      expect(byCode.CARGO.rating_family).toBe('TRANSIT_VALUES');
      expect(byCode.MLIA.rating_family).toBe('MARINE_LIABILITY');
      // …and that one segment spans all three.
      expect(new Set([byCode.HM, byCode.CARGO, byCode.MLIA].map((c) => c.segment_code)))
        .toEqual(new Set(['MARINE_TRANSIT']));
    });

    it('serves the family registry with what each family rates on', async () => {
      const { families } = await harness.fetchApp('GET', '/api/fac/reference/families').then((r) => r.json());
      const byCode = Object.fromEntries(families.map((f) => [f.code, f]));
      expect(byCode.SCHEDULE_PROPERTY.implemented).toBe(true);
      expect(byCode.LIABILITY_LIMIT.implemented).toBe(false);
      expect(byCode.LIABILITY_LIMIT.rating_basis).toBe('LIMIT_ILF');
      expect(byCode.TRANSIT_VALUES.rating_basis).toBe('TURNOVER');
      expect(byCode.PROJECT_WORKS.period_basis).toBe('PROJECT');
    });

    it('names the reference set in force', async () => {
      const version = await harness.fetchApp('GET', '/api/fac/reference/rate-version').then((r) => r.json());
      expect(version.version_label).toBe('FAC-REF-2026.1');
      expect(version.effective_to).toBeNull();
    });
  });

  // ── Sections ─────────────────────────────────────────────────────────
  describe('sections (migration 133, finding F6)', () => {
    it('round-trips a two-section split with a sum insured per class', async () => {
      const id = await newRisk();
      const saved = await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: {
          sections: [
            { section_no: 1, fac_cob_id: propertyCob.fac_cob_id, sum_insured: 300_000_000 },
            { section_no: 2, fac_cob_id: hullCob.fac_cob_id, sum_insured: 120_000_000 },
          ],
        },
      }).then((r) => r.json());

      expect(saved).toHaveLength(2);
      // The split survives the round trip — which is the whole point.
      const reloaded = await harness.fetchApp('GET', `/api/fac/risks/${id}/sections`).then((r) => r.json());
      expect(reloaded.map((s) => [s.section_no, s.code, Number(s.sum_insured)])).toEqual([
        [1, 'PAR', 300_000_000],
        [2, 'HM', 120_000_000],
      ]);
    });

    it('denormalises the rating family from the class at write time', async () => {
      const id = await newRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: { sections: [{ section_no: 1, fac_cob_id: hullCob.fac_cob_id, sum_insured: 1 }] },
      });
      const { rows } = await pool.query(
        `SELECT rating_family FROM public.fac_risk_section WHERE fac_risk_id = $1`, [id],
      );
      expect(rows[0].rating_family).toBe('HULL_VALUE');
    });

    it('replaces the whole set, so removing a class removes it', async () => {
      const id = await newRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: {
          sections: [
            { section_no: 1, fac_cob_id: propertyCob.fac_cob_id, sum_insured: 10 },
            { section_no: 1, fac_cob_id: hullCob.fac_cob_id, sum_insured: 20 },
          ],
        },
      });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: { sections: [{ section_no: 1, fac_cob_id: propertyCob.fac_cob_id, sum_insured: 10 }] },
      });
      const reloaded = await harness.fetchApp('GET', `/api/fac/risks/${id}/sections`).then((r) => r.json());
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].code).toBe('PAR');
    });

    it('rejects a section with no class', async () => {
      const id = await newRisk();
      const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: { sections: [{ section_no: 1, sum_insured: 10 }] },
      });
      expect(res.status).toBe(400);
    });

    it('writes an audit event', async () => {
      const id = await newRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: { sections: [{ section_no: 1, fac_cob_id: propertyCob.fac_cob_id, sum_insured: 5 }] },
      });
      const { rows } = await pool.query(
        `SELECT payload FROM public.contract_audit_event WHERE contract_id=$1 AND event_type='FAC_SECTIONS_SAVED'`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.section_count).toBe(1);
    });

    it('cascades on risk delete', async () => {
      const id = await newRisk();
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/sections`, {
        body: { sections: [{ section_no: 1, fac_cob_id: propertyCob.fac_cob_id, sum_insured: 5 }] },
      });
      await harness.fetchApp('DELETE', `/api/fac/risks/${id}`);
      const { rows } = await pool.query(
        `SELECT 1 FROM public.fac_risk_section WHERE fac_risk_id = $1`, [id],
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ── Server-side pricing ──────────────────────────────────────────────
  describe('POST /price — the server as pricing authority', () => {
    it('answers with a blocker, not an error, for a class with no engine', async () => {
      // The old path handed every class to the property engine, which threw
      // `Unknown occupancy_code`, and the screen rendered the exception (F1).
      const id = await newRisk({ fac_cob_id: hullCob.fac_cob_id, insured_name: 'MV Integration' });
      const res = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} });
      expect(res.status).toBe(200);
      const out = await res.json();
      expect(out.ok).toBe(false);
      expect(out.family).toBe('HULL_VALUE');
      expect(out.blocker.reason).toBe('NOT_IMPLEMENTED');
      expect(out.blocker.message).toMatch(/agreed value/i);
    });

    it('names the missing input for a property risk that cannot be rated yet', async () => {
      const id = await newRisk({ fac_cob_id: propertyCob.fac_cob_id });
      const out = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
        .then((r) => r.json());
      expect(out.ok).toBe(false);
      expect(out.family).toBe('SCHEDULE_PROPERTY');
      expect(out.blocker.reason).toBe('MISSING_INPUT');
      expect(out.blocker.missing).toContain('occupancy_code');
    });

    it('prices a property risk and reports the exposure basis it used', async () => {
      const occ = await pool.query(
        `SELECT occupancy_code FROM public.fac_occupancy_master
          WHERE active = true AND flexa_base_rate_pm IS NOT NULL LIMIT 1`,
      );
      const zone = await pool.query(
        `SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1`,
      );
      if (!occ.rows[0] || !zone.rows[0]) return; // reference set not seeded here

      const id = await newRisk({
        fac_cob_id: propertyCob.fac_cob_id,
        occupancy_code: occ.rows[0].occupancy_code,
        risk_country_zone: zone.rows[0].country_zone,
        pd_sum_insured: 100_000_000,
        bi_sum_insured: 0,
      });

      const out = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, {
        body: { commission_pct: 0.2, margin_pct: 0.05, other_expenses_pct: 0.005 },
      }).then((r) => r.json());

      expect(out.ok).toBe(true);
      expect(out.family).toBe('SCHEDULE_PROPERTY');
      expect(out.exposure.basis).toBe('RISK_HEADER');
      expect(out.exposure.total_si).toBe(100_000_000);
      expect(out.rate_table_version).toBe('FAC-REF-2026.1');
      expect(out.result.final_gross_rate_pm).toBeGreaterThan(0);
      // No factor selections, so the score is provisional and no grade is
      // issued — INCOMPLETE, never DECLINE (F5).
      expect(out.result.uw_action).toBe('INCOMPLETE');
      expect(out.result.capacity_grade).toBeNull();
    });

    it('prefers locations over the risk header once a schedule exists', async () => {
      const occ = await pool.query(
        `SELECT occupancy_code FROM public.fac_occupancy_master
          WHERE active = true AND flexa_base_rate_pm IS NOT NULL LIMIT 1`,
      );
      const zone = await pool.query(
        `SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1`,
      );
      if (!occ.rows[0] || !zone.rows[0]) return;

      const id = await newRisk({
        fac_cob_id: propertyCob.fac_cob_id,
        occupancy_code: occ.rows[0].occupancy_code,
        risk_country_zone: zone.rows[0].country_zone,
        pd_sum_insured: 100_000_000,
        bi_sum_insured: 0,
      });
      await harness.fetchApp('PUT', `/api/fac/risks/${id}/locations`, {
        body: { locations: [{ location_name: 'Site A', pd_si: 40_000_000, bi_si: 10_000_000 }] },
      });

      const out = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: {} })
        .then((r) => r.json());
      expect(out.exposure.basis).toBe('LOCATIONS');
      expect(out.exposure.total_si).toBe(50_000_000);
      // BI is present on the profile, so the PD share is below 1 and the BI
      // rate actually moves the net rate — it cannot be computed and then
      // weighted at zero (F10).
      expect(out.exposure.bi_included).toBe(true);
      expect(out.exposure.pd_si_share).toBeCloseTo(0.8, 9);
      expect(out.result.bi_rate_pm).toBeGreaterThan(0);
    });
  });

  // ── Provenance + drift ───────────────────────────────────────────────
  describe('PUT /pricing — provenance and drift', () => {
    it('stamps the rate table, family and exposure basis on the saved row', async () => {
      const id = await newRisk({ fac_cob_id: propertyCob.fac_cob_id });
      const saved = await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
        body: { commission_pct: 0.2, margin_pct: 0.05 },
      }).then((r) => r.json());

      expect(saved.rate_table_version).toBe('FAC-REF-2026.1');
      expect(saved.family_code).toBe('SCHEDULE_PROPERTY');
    });

    it('counts drift against its own recomputation without blocking the save', async () => {
      const occ = await pool.query(
        `SELECT occupancy_code FROM public.fac_occupancy_master
          WHERE active = true AND flexa_base_rate_pm > 0 LIMIT 1`,
      );
      const zone = await pool.query(
        `SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1`,
      );
      if (!occ.rows[0] || !zone.rows[0]) return;

      const id = await newRisk({
        fac_cob_id: propertyCob.fac_cob_id,
        occupancy_code: occ.rows[0].occupancy_code,
        risk_country_zone: zone.rows[0].country_zone,
        pd_sum_insured: 10_000_000,
      });

      // A total rate the server will not agree with.
      const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
        body: { commission_pct: 0.2, margin_pct: 0.05, total_rate_pm: 999 },
      });
      expect(res.status).toBe(200);                                  // warn-only
      expect(Number(res.headers.get('x-fac-pricing-drift-count'))).toBeGreaterThan(0);
    });

    it('reports zero drift when the submitted figures match', async () => {
      const occ = await pool.query(
        `SELECT occupancy_code FROM public.fac_occupancy_master
          WHERE active = true AND flexa_base_rate_pm > 0 LIMIT 1`,
      );
      const zone = await pool.query(
        `SELECT country_zone FROM public.fac_natcat_rate WHERE active = true LIMIT 1`,
      );
      if (!occ.rows[0] || !zone.rows[0]) return;

      const id = await newRisk({
        fac_cob_id: propertyCob.fac_cob_id,
        occupancy_code: occ.rows[0].occupancy_code,
        risk_country_zone: zone.rows[0].country_zone,
        pd_sum_insured: 10_000_000,
      });
      const inputs = { commission_pct: 0.2, margin_pct: 0.05, other_expenses_pct: 0.005 };
      const priced = await harness.fetchApp('POST', `/api/fac/risks/${id}/price`, { body: inputs })
        .then((r) => r.json());

      const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
        body: {
          ...inputs,
          total_rate_pm: priced.result.total_rate_pm,
          final_gross_rate_pm: priced.result.final_gross_rate_pm,
          underwriting_score: priced.result.underwriting_score,
        },
      });
      expect(res.headers.get('x-fac-pricing-drift-count')).toBe('0');
    });
  });
});
