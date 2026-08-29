import { describe, it, expect } from 'vitest';
import {
  projectStraightStats,
  LDF_CONFIG,
  DEFAULT_LDF_KEY,
  DEV_FACTORS,
  IS_BENCHMARK_LDF,
} from './straightProjections.js';

describe('LDF_CONFIG', () => {
  it('exposes the class-keyed entries', () => {
    expect(LDF_CONFIG.PROPERTY_CAT.ldfs.length).toBeGreaterThan(0);
    expect(LDF_CONFIG.PROPERTY_NONCAT.ldfs.length).toBeGreaterThan(0);
    expect(LDF_CONFIG.ENGINEERING.ldfs.length).toBeGreaterThan(0);
    expect(LDF_CONFIG.LIABILITY.ldfs.length).toBeGreaterThan(0);
    expect(LDF_CONFIG.MARINE.ldfs.length).toBeGreaterThan(0);
  });

  it('DEFAULT_LDF_KEY points to an entry that exists', () => {
    expect(LDF_CONFIG[DEFAULT_LDF_KEY]).toBeDefined();
  });

  it('every entry carries provenance fields (source + reviewed + label)', () => {
    for (const [key, cfg] of Object.entries(LDF_CONFIG)) {
      expect(cfg, `missing fields on ${key}`).toMatchObject({
        label:    expect.any(String),
        source:   expect.any(String),
        ldfs:     expect.any(Array),
      });
      // reviewed is null when unreviewed; otherwise an ISO date string.
      expect(cfg.reviewed === null || typeof cfg.reviewed === 'string').toBe(true);
    }
  });

  it('LDFs are all >= 1 (factors can\'t shrink cumulative claims)', () => {
    for (const [key, cfg] of Object.entries(LDF_CONFIG)) {
      cfg.ldfs.forEach((ldf, i) => {
        expect(ldf, `${key}[${i}] = ${ldf}`).toBeGreaterThanOrEqual(1);
      });
    }
  });
});

describe('IS_BENCHMARK_LDF', () => {
  it('is exported as true so the UI can render a warning banner', () => {
    expect(IS_BENCHMARK_LDF).toBe(true);
  });
});

describe('DEV_FACTORS', () => {
  it('mirrors LDF_CONFIG, adding label/source/reviewed/ldfs/cdfs fields', () => {
    for (const key of Object.keys(LDF_CONFIG)) {
      expect(DEV_FACTORS[key]).toBeDefined();
      expect(DEV_FACTORS[key].ldfs).toHaveLength(LDF_CONFIG[key].ldfs.length);
      expect(DEV_FACTORS[key].source).toBe(LDF_CONFIG[key].source);
      expect(DEV_FACTORS[key].reviewed).toBe(LDF_CONFIG[key].reviewed);
      expect(DEV_FACTORS[key].cdfs.length).toBe(LDF_CONFIG[key].ldfs.length + 1);
    }
  });

  it('CDFs are monotonically non-increasing from oldest to newest dev period', () => {
    for (const [key, factors] of Object.entries(DEV_FACTORS)) {
      const cdfs = factors.cdfs;
      for (let i = 1; i < cdfs.length; i++) {
        expect(cdfs[i - 1], `${key}: cdf[${i - 1}] should be ≥ cdf[${i}]`).toBeGreaterThanOrEqual(cdfs[i]);
      }
      expect(cdfs[cdfs.length - 1]).toBe(1.0); // tail = 1
    }
  });
});

describe('projectStraightStats', () => {
  const stats = [
    { year: 2021, premium: 100, paid: 50, os: 10 },
    { year: 2022, premium: 100, paid: 40, os: 20 },
    { year: 2023, premium: 100, paid: 30, os: 30 },
  ];

  it('returns an empty array for null / empty input', () => {
    expect(projectStraightStats(null)).toEqual([]);
    expect(projectStraightStats([])).toEqual([]);
  });

  it('produces ultimate >= actual for every row (loss can only grow)', () => {
    const result = projectStraightStats(stats, 'PROPERTY_NONCAT');
    expect(result).toHaveLength(3);
    for (const row of result) {
      expect(row.ultLoss).toBeGreaterThanOrEqual(row.actLoss);
      expect(row.ultPrem).toBeGreaterThanOrEqual(row.actPrem);
      expect(row.devFactor).toBeGreaterThanOrEqual(1);
    }
  });

  it('the newest year gets the largest dev factor (least developed)', () => {
    const r = projectStraightStats(stats, 'LIABILITY');
    // Sorted ascending → r[0] is oldest, r[r.length-1] is newest
    expect(r[r.length - 1].devFactor).toBeGreaterThan(r[0].devFactor);
  });

  it('falls back to DEFAULT_LDF_KEY when classKey is unknown', () => {
    const known   = projectStraightStats(stats, DEFAULT_LDF_KEY);
    const fallback = projectStraightStats(stats, 'NOT_A_REAL_KEY');
    expect(fallback).toEqual(known);
  });

  it('uses DEFAULT_LDF_KEY when no classKey is passed', () => {
    const omitted = projectStraightStats(stats);
    const explicit = projectStraightStats(stats, DEFAULT_LDF_KEY);
    expect(omitted).toEqual(explicit);
  });

  it('a long-tail-ish class projects to a higher ultimate than a short-tail-ish one', () => {
    const property = projectStraightStats(stats, 'PROPERTY_NONCAT');
    const liability = projectStraightStats(stats, 'LIABILITY');
    expect(liability[2].devFactor).toBeGreaterThan(property[2].devFactor);
  });
});

describe('projectStraightStats — dev age from year distance, not array position (F55)', () => {
  // PROPERTY_NONCAT LDFs [1.250, 1.080, 1.025, 1.010, 1.005] give age-indexed
  // CDFs (cdf[k] = product of ldfs[k..end], k = years since the newest year):
  //   cdf[0] = 1.25 × 1.08 × 1.025 × 1.010 × 1.005 = 1.4045754375
  //   cdf[1] = 1.08 × 1.025 × 1.010 × 1.005        = 1.1236603500
  //   cdf[2] = 1.025 × 1.010 × 1.005               = 1.0404262500  (1.04042625)
  //   cdf[3] = 1.010 × 1.005                       = 1.0150500000
  //   cdf[4] = 1.005
  //   cdf[5] = 1.0
  // Premium LDFs [1.050, 1.015, 1.005, 1.0, ...] →
  //   premCdf[0] = 1.050 × 1.015 × 1.005 = 1.07107875, premCdf[3] = 1.0.

  it('a gap year no longer shifts every older year onto too-young factors', () => {
    // Years [2019, 2020, 2023] — 2021/2022 missing. Newest = 2023.
    //   2023: devIdx 2023−2023 = 0 → CDF 1.4045754375 → ult 60 × … = 84.27452625
    //   2020: devIdx 2023−2020 = 3 → CDF 1.01505      → ult 60.903
    //   2019: devIdx 2023−2019 = 4 → CDF 1.005        → ult 60.3
    // The pre-fix positional devIdx (n−1−i) gave 2020 → cdf[1] = 1.12366035
    // (ult 67.419621) and 2019 → cdf[2] = 1.04042625 (ult 62.425575).
    const gap = [
      { year: 2019, premium: 100, paid: 60, os: 0 },
      { year: 2020, premium: 100, paid: 60, os: 0 },
      { year: 2023, premium: 100, paid: 60, os: 0 },
    ];
    const byYear = Object.fromEntries(
      projectStraightStats(gap, 'PROPERTY_NONCAT').map(r => [r.year, r]),
    );
    expect(byYear[2023].devFactor).toBeCloseTo(1.4045754375, 10);
    expect(byYear[2023].ultLoss).toBeCloseTo(84.27452625, 8);
    expect(byYear[2020].devFactor).toBeCloseTo(1.01505, 10);
    expect(byYear[2020].ultLoss).toBeCloseTo(60.903, 8);
    expect(byYear[2019].devFactor).toBeCloseTo(1.005, 10);
    expect(byYear[2019].ultLoss).toBeCloseTo(60.3, 8);
    // Premium side follows the same age convention: 2020 is 4 years
    // developed → premium fully earned (CDF 1.0), not premCdf[1].
    expect(byYear[2020].premDevFactor).toBe(1.0);
    expect(byYear[2023].premDevFactor).toBeCloseTo(1.07107875, 10);
  });

  it('a complete (gap-free) triangle is unchanged by the distance-based age', () => {
    const full = [2019, 2020, 2021, 2022, 2023].map(year => ({
      year, premium: 100, paid: 60, os: 0,
    }));
    const r = projectStraightStats(full, 'PROPERTY_NONCAT');
    // position == distance here, so factors read straight off the CDF array
    expect(r.map(x => x.devFactor)).toEqual([1.005, 1.01505, 1.04042625, 1.12366035, 1.4045754375].map(v => expect.closeTo(v, 8)));
  });

  it('duplicate year rows share ONE dev age instead of two different ones', () => {
    const dup = [
      { year: 2023, premium: 100, paid: 30, os: 0 },
      { year: 2023, premium: 100, paid: 50, os: 0 },
    ];
    const r = projectStraightStats(dup, 'PROPERTY_NONCAT');
    expect(r[0].devFactor).toBeCloseTo(1.4045754375, 10);
    expect(r[1].devFactor).toBe(r[0].devFactor);
  });

  it('years far older than the curve clamp to fully developed (CDF 1.0)', () => {
    const wide = [
      { year: 2010, premium: 100, paid: 60, os: 0 },
      { year: 2023, premium: 100, paid: 60, os: 0 },
    ];
    const byYear = Object.fromEntries(
      projectStraightStats(wide, 'PROPERTY_NONCAT').map(r => [r.year, r]),
    );
    expect(byYear[2010].devFactor).toBe(1.0); // devIdx 13 ≥ curve length → tail
    expect(byYear[2010].ultLoss).toBe(60);
    expect(byYear[2023].devFactor).toBeCloseTo(1.4045754375, 10);
  });
});
