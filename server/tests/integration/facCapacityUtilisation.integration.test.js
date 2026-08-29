// server/tests/integration/facCapacityUtilisation.integration.test.js
//
// capacityUtilisation against a real database (audit F75).
//
// fac_zone_budget's UNIQUE(cresta_zone, peril, uw_year) expressly allows a
// zone to carry several active budget rows at once — a NULL-uw_year default
// plus a year- or peril-specific row. The old query LEFT JOINed the budget
// table before grouping and grouped by the budget columns, so such a zone
// appeared once per budget row, each carrying the zone's FULL committed
// exposure: committed was double-counted and the zone could be counted twice
// in over_budget. The fix aggregates committed per zone first and then
// attaches exactly ONE budget via a deterministic LATERAL pick (most
// specific uw_year first, 'ALL' peril before per-peril).
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { capacityUtilisation } from '../../src/services/facPortfolioService.js';

const SRC = 'M5_F75_TEST';
// Unique per run so a shared test DB never collides across runs.
const ZONE = `M5-F75-${Date.now().toString(36)}`;

describe.skipIf(shouldSkipDb)('integration: capacityUtilisation with multiple active budget rows (F75)', () => {
  let riskId;

  beforeAll(async () => {
    // One BOUND risk with one location in the zone. our_share_pct is whole
    // percent (100 → share 1.0 in the view, migration 145), so:
    //   committed_si  = (100M pd + 0 bi) × 1.0            = 100,000,000
    //   committed_pml = 100M × pd_pml_pct 0.8 × 1.0       =  80,000,000
    const risk = await pool.query(
      `INSERT INTO public.fac_risk (insured_name, status, uw_year, our_share_pct)
       VALUES ('M5 F75 Utilisation Risk', 'BOUND', 2026, 100)
       RETURNING fac_risk_id`,
    );
    riskId = risk.rows[0].fac_risk_id;
    await pool.query(
      `INSERT INTO public.fac_location (fac_risk_id, location_name, cresta_zone, pd_si, bi_si, pd_pml_pct)
       VALUES ($1, 'Site F75', $2, 100000000, 0, 0.8)`,
      [riskId, ZONE],
    );
    await pool.query('REFRESH MATERIALIZED VIEW public.mv_fac_accumulation');

    // TWO active budget rows for the same zone — the shape the schema
    // allows and the old query double-counted: an all-years zone-wide
    // default and a 2026 earthquake-specific row.
    await pool.query(
      `INSERT INTO public.fac_zone_budget (cresta_zone, peril, uw_year, budget_si, budget_pml, source, active)
       VALUES ($1, 'ALL', NULL, 500000000, 400000000, $2, true),
              ($1, 'EQ',  2026, 300000000, 250000000, $2, true)`,
      [ZONE, SRC],
    );
  });

  afterAll(async () => {
    try { await pool.query('DELETE FROM public.fac_zone_budget WHERE source = $1', [SRC]); } catch { /* best effort */ }
    if (riskId) {
      try { await pool.query('DELETE FROM public.fac_risk WHERE fac_risk_id = $1', [riskId]); } catch { /* best effort */ }
    }
    try { await pool.query('REFRESH MATERIALIZED VIEW public.mv_fac_accumulation'); } catch { /* best effort */ }
    await closePools();
  });

  it('reports the zone ONCE, with committed exposure counted once, against the all-years default', async () => {
    const out = await capacityUtilisation({});
    const mine = out.zones.filter((z) => z.cresta_zone === ZONE);

    // One row per zone — not one per budget. The old shape returned two
    // rows here, each with the full 100M/80M committed against a different
    // budget.
    expect(mine).toHaveLength(1);
    const [zone] = mine;
    expect(zone.committed_si).toBeCloseTo(100_000_000, 2);
    expect(zone.committed_pml).toBeCloseTo(80_000_000, 2);
    expect(zone.risk_count).toBe(1);

    // No uw_year filter → the all-years (NULL uw_year) default wins the
    // deterministic pick: budget_pml 400M, utilisation 80M / 400M = 0.2.
    expect(zone.budget).toBe(400_000_000);
    expect(zone.budget_source).toBe(SRC);
    expect(zone.utilisation).toBeCloseTo(0.2, 12);
    expect(zone.headroom).toBeCloseTo(320_000_000, 2);
  });

  it('prefers the uw_year-specific budget when the year filter matches it', async () => {
    const out = await capacityUtilisation({ uwYear: 2026 });
    const mine = out.zones.filter((z) => z.cresta_zone === ZONE);

    expect(mine).toHaveLength(1);
    const [zone] = mine;
    expect(zone.committed_pml).toBeCloseTo(80_000_000, 2);
    // Most specific uw_year first: the 2026 row (250M PML) beats the NULL
    // default. Utilisation 80M / 250M = 0.32.
    expect(zone.budget).toBe(250_000_000);
    expect(zone.utilisation).toBeCloseTo(0.32, 12);
  });

  it('counts the zone at most once in over_budget', async () => {
    // Shrink the budgets so the zone is over on BOTH rows — the old query
    // then counted it twice in over_budget.
    await pool.query(
      'UPDATE public.fac_zone_budget SET budget_pml = 50000000 WHERE source = $1',
      [SRC],
    );
    try {
      const out = await capacityUtilisation({ uwYear: 2026 });
      const mine = out.zones.filter((z) => z.cresta_zone === ZONE);
      expect(mine).toHaveLength(1);
      expect(mine[0].utilisation).toBeCloseTo(80_000_000 / 50_000_000, 12); // 1.6 — over
      // over_budget counts zones, and this zone contributes exactly one.
      const othersOver = out.zones.filter(
        (z) => z.cresta_zone !== ZONE && z.utilisation !== null && z.utilisation > 1,
      ).length;
      expect(out.over_budget).toBe(othersOver + 1);
    } finally {
      await pool.query(
        `UPDATE public.fac_zone_budget SET budget_pml = CASE WHEN uw_year IS NULL THEN 400000000 ELSE 250000000 END
          WHERE source = $1`,
        [SRC],
      );
    }
  });
});
