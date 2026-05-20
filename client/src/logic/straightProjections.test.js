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
