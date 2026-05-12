import { describe, it, expect } from 'vitest';
import {
  projectStraightStats,
  LDF_CONFIG,
  DEV_FACTORS,
  IS_BENCHMARK_LDF,
} from './straightProjections.js';

describe('LDF_CONFIG', () => {
  it('exposes the legacy SHORT_TAIL / LONG_TAIL fallback keys with the original values', () => {
    expect(LDF_CONFIG.SHORT_TAIL.ldfs).toEqual([1.250, 1.080, 1.025, 1.010, 1.005]);
    expect(LDF_CONFIG.LONG_TAIL.ldfs).toEqual([2.100, 1.450, 1.220, 1.130, 1.075, 1.045, 1.025, 1.010]);
  });

  it('exposes the new class-keyed entries', () => {
    expect(LDF_CONFIG.PROPERTY_CAT.ldfs.length).toBeGreaterThan(0);
    expect(LDF_CONFIG.PROPERTY_NONCAT.ldfs.length).toBeGreaterThan(0);
    expect(LDF_CONFIG.ENGINEERING.ldfs.length).toBeGreaterThan(0);
    expect(LDF_CONFIG.LIABILITY.ldfs.length).toBeGreaterThan(0);
    expect(LDF_CONFIG.MARINE.ldfs.length).toBeGreaterThan(0);
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

  it('falls back to SHORT_TAIL when classKey is unknown', () => {
    const known   = projectStraightStats(stats, 'SHORT_TAIL');
    const fallback = projectStraightStats(stats, 'NOT_A_REAL_KEY');
    expect(fallback).toEqual(known);
  });

  it('legacy SHORT_TAIL key still works (backwards compatibility)', () => {
    const out = projectStraightStats(stats, 'SHORT_TAIL');
    expect(out).toHaveLength(3);
    expect(out[2].devFactor).toBeGreaterThanOrEqual(1);
  });

  it('legacy LONG_TAIL key still works', () => {
    const out = projectStraightStats(stats, 'LONG_TAIL');
    expect(out).toHaveLength(3);
    // Long tail's per-period LDFs are larger so a 3-year-old year is still
    // far less developed than under SHORT_TAIL.
    const short = projectStraightStats(stats, 'SHORT_TAIL');
    expect(out[2].devFactor).toBeGreaterThan(short[2].devFactor);
  });
});
