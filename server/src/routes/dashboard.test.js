import { describe, it, expect } from 'vitest';
import {
  buildPivot,
  buildWeightedPivot,
  normalizePivot,
  unitsCte,
  unitsLobCte,
  UNIT_AGGREGATES,
} from './dashboard.js';

// The dashboard's shared query layer is the single place prop and NP metrics
// are reconciled, so the pure helpers (pivot maths + CTE SQL shape) are worth
// locking down without a database.

describe('buildPivot', () => {
  const rows = [
    { region: 'Europe', tt: 'QS', premium: 30 },
    { region: 'Europe', tt: 'XL', premium: 10 },
    { region: 'Asia',   tt: 'QS', premium: 60 },
    { region: 'Other',  tt: 'QS', premium: 999 }, // excluded
  ];

  it('sums values per cell and rolls up row/column/grand totals', () => {
    const p = buildPivot(rows, 'region', 'tt', 'premium');
    expect(p.columns).toEqual(['QS', 'XL']);
    const europe = p.rows.find(r => r.region === 'Europe');
    expect(europe.values).toEqual({ QS: 30, XL: 10 });
    expect(europe.total).toBe(40);
    expect(p.totals.values).toEqual({ QS: 90, XL: 10 });
    expect(p.totals.total).toBe(100);
  });

  it("drops the 'Other'/empty bucket", () => {
    const p = buildPivot(rows, 'region', 'tt', 'premium');
    expect(p.rows.map(r => r.region)).not.toContain('Other');
  });
});

describe('buildWeightedPivot', () => {
  // ROL-style data: cell = Σnum/Σden, weighted by den, NOT an average of ratios.
  const rows = [
    { region: 'Europe', tt: 'QS', n: 10, d: 100 }, // 0.10
    { region: 'Europe', tt: 'XL', n: 90, d: 300 }, // 0.30
    { region: 'Asia',   tt: 'QS', n: 5,  d: 0   }, // den 0 → 0, no NaN
  ];
  const p = buildWeightedPivot(rows, 'region', 'tt', 'n', 'd');

  it('computes each cell as Σnum / Σden (den 0 → 0)', () => {
    const europe = p.rows.find(r => r.region === 'Europe');
    expect(europe.values.QS).toBeCloseTo(0.1, 10);
    expect(europe.values.XL).toBeCloseTo(0.3, 10);
    const asia = p.rows.find(r => r.region === 'Asia');
    expect(asia.values.QS).toBe(0);
    expect(asia.total).toBe(0);
  });

  it('weights the row total by denominator (not a mean of cell ratios)', () => {
    const europe = p.rows.find(r => r.region === 'Europe');
    // weighted: (10+90)/(100+300) = 0.25 ; naive average of 0.1 and 0.3 = 0.2
    expect(europe.total).toBeCloseTo(0.25, 10);
    expect(europe.total).not.toBeCloseTo(0.2, 5);
  });

  it('weights column and grand totals the same way', () => {
    expect(p.totals.values.QS).toBeCloseTo(15 / 100, 10); // (10+5)/(100+0)
    expect(p.totals.values.XL).toBeCloseTo(90 / 300, 10);
    expect(p.totals.total).toBeCloseTo(105 / 400, 10);    // (10+90+5)/(100+300+0)
  });
});

describe('normalizePivot', () => {
  const premium = buildPivot([
    { lob: 'Fire',   tt: 'QS', premium: 30 },
    { lob: 'Fire',   tt: 'XL', premium: 10 },
    { lob: 'Marine', tt: 'QS', premium: 60 },
  ], 'lob', 'tt', 'premium');
  const norm = normalizePivot(premium);

  it('expresses every cell as a share of total premium', () => {
    const fire = norm.rows.find(r => r.lob === 'Fire');
    expect(fire.values.QS).toBeCloseTo(0.3, 10);
    expect(fire.values.XL).toBeCloseTo(0.1, 10);
    expect(fire.total).toBeCloseTo(0.4, 10);
  });

  it('row/column/grand totals are also shares; grand total is 1', () => {
    expect(norm.totals.values.QS).toBeCloseTo(0.9, 10);
    expect(norm.totals.values.XL).toBeCloseTo(0.1, 10);
    expect(norm.totals.total).toBeCloseTo(1, 10);
  });

  it('is safe when total premium is zero', () => {
    const zero = normalizePivot({ columns: ['QS'], rows: [{ key: 'Fire', lob: 'Fire', values: { QS: 0 }, total: 0 }], totals: { values: { QS: 0 }, total: 0 } });
    expect(zero.totals.total).toBe(0);
    expect(zero.rows[0].values.QS).toBe(0);
  });
});

describe('unitsCte', () => {
  const where = "WHERE c.uw_status NOT IN ('DRAFT','DECLINED','NTU') AND c.uw_year = $1";
  const sql = unitsCte(where, 1.25);

  it('builds a UNION ALL of one PROP and one NP half under a `units` CTE', () => {
    expect(sql).toContain('units AS (');
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain("'PROP'::text AS kind");
    expect(sql).toContain("'NP'::text AS kind");
  });

  it('uses booked reinsurer premium (uw_price% × layer_limit) for NP', () => {
    // uw_price is a ROL percent, so it is divided by 100 for booked premium
    expect(sql).toContain('COALESCE(l.uw_price,0)/100.0 * COALESCE(l.layer_limit,0)');
    expect(sql).not.toContain('est_gnpi');
  });

  it('stores NP rol as a fraction (uw_price / 100) for fmtPct', () => {
    expect(sql).toContain('l.uw_price / 100.0 AS rol');
  });

  it('applies the where clause to BOTH halves and interpolates the fx divisor', () => {
    expect(sql.split(where).length - 1).toBe(2);
    expect(sql).toContain('/ 1.25');
  });

  it('non-LOB variant does not join class_of_business', () => {
    expect(sql).not.toContain('cob.class_of_business AS lob');
  });

  it('exposes inception_date so premiumByMonth can group by month', () => {
    expect(sql).toContain('c.inception_date AS inception_date');
  });
});

describe('unitsLobCte', () => {
  const where = "WHERE c.uw_status NOT IN ('DRAFT','DECLINED','NTU')";
  const sql = unitsLobCte(where, 1);

  it('fans rows out per class of business while keeping the units shape', () => {
    expect(sql).toContain('cob.class_of_business AS lob');
    expect(sql).toContain('public.contract_class_of_business ccb');
    expect(sql).toContain('units AS (');
    expect(sql).toContain('UNION ALL');
    expect(sql.split(where).length - 1).toBe(2);
  });
});

describe('UNIT_AGGREGATES', () => {
  it('exposes premium-weighted rate aggregates over the units CTE', () => {
    expect(UNIT_AGGREGATES.premium).toBe('SUM(premium)');
    expect(UNIT_AGGREGATES.exposure).toBe('SUM(exposure)');
    for (const key of ['avgRol', 'balance', 'uwMargin']) {
      expect(UNIT_AGGREGATES[key]).toContain('*premium)');
      expect(UNIT_AGGREGATES[key]).toContain('NULLIF(SUM(premium) FILTER');
    }
    expect(UNIT_AGGREGATES.avgRol).toContain('rol');
    expect(UNIT_AGGREGATES.balance).toContain('balance');
    expect(UNIT_AGGREGATES.uwMargin).toContain('margin');
  });
});
