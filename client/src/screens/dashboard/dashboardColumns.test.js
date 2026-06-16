import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_EXPORT_MANIFEST,
  REGION_COLS,
  LOB_COLS,
  BY_YEAR_COLS,
  ROL_BAND_COLS,
  BALANCE_BAND_COLS,
  TREATY_TYPE_COLS,
  KPI_ROWS,
  MONTH_SERIES_COLS,
} from './dashboardColumns';

// These defs are the single source of truth shared by the on-screen tables and
// the Excel exporter — lock their shape so screen/file can't drift apart.

const KINDS = new Set(['money', 'pct', 'mult', 'int', 'text']);
const TYPES = new Set(['kpis', 'series', 'table', 'pivot']);
const TAB_IDS = [
  'portfolio-overview', 'portfolio-summary', 'regional-analysis',
  'portfolio-technical-analysis', 'regional-technical-analysis',
  'return-analysis-proportional', 'return-analysis-nonproportional',
];

describe('dashboard column definitions', () => {
  const ALL = [REGION_COLS, LOB_COLS, BY_YEAR_COLS, ROL_BAND_COLS, BALANCE_BAND_COLS, TREATY_TYPE_COLS, KPI_ROWS, MONTH_SERIES_COLS];

  it('every column has a key, a label and a valid kind', () => {
    for (const defs of ALL) {
      expect(defs.length).toBeGreaterThan(0);
      for (const c of defs) {
        expect(typeof c.key).toBe('string');
        expect(typeof c.label).toBe('string');
        expect(KINDS.has(c.kind)).toBe(true);
      }
    }
  });

  it('uses the right kinds: balance=mult, premium/exposure=money, rates=pct', () => {
    const k = (cols, key) => cols.find((c) => c.key === key)?.kind;
    expect(k(REGION_COLS, 'balance')).toBe('mult');
    expect(k(REGION_COLS, 'premium')).toBe('money');
    expect(k(REGION_COLS, 'exposure')).toBe('money');
    expect(k(REGION_COLS, 'rol')).toBe('pct');
    expect(k(BY_YEAR_COLS, 'balance')).toBe('mult');
    expect(k(BY_YEAR_COLS, 'uwYear')).toBe('int');
    expect(k(TREATY_TYPE_COLS, 'balance')).toBe('mult');
    expect(k(KPI_ROWS, 'balance')).toBe('mult');
  });

  it('LOB columns mirror region columns past the label column', () => {
    expect(LOB_COLS.slice(1)).toEqual(REGION_COLS.slice(1));
  });
});

describe('DASHBOARD_EXPORT_MANIFEST', () => {
  it('covers every dashboard tab, KPIs first', () => {
    for (const id of TAB_IDS) {
      const blocks = DASHBOARD_EXPORT_MANIFEST[id];
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks[0].type).toBe('kpis');
    }
  });

  it('blocks are well-formed and every sheet name is Excel-safe & unique per tab', () => {
    for (const id of TAB_IDS) {
      const seen = new Set();
      for (const b of DASHBOARD_EXPORT_MANIFEST[id]) {
        expect(TYPES.has(b.type)).toBe(true);
        expect(typeof b.key).toBe('string');
        expect(typeof b.sheet).toBe('string');
        expect(b.sheet.length).toBeLessThanOrEqual(31);   // Excel cap
        expect(b.sheet).not.toMatch(/[*?:/\\[\]]/);        // Excel-forbidden chars
        expect(seen.has(b.sheet)).toBe(false);
        seen.add(b.sheet);
        if (b.type === 'pivot') {
          expect(KINDS.has(b.kind)).toBe(true);
          expect(typeof b.rowLabel).toBe('string');
        } else {
          expect(Array.isArray(b.cols)).toBe(true);
          for (const c of b.cols) expect(KINDS.has(c.kind)).toBe(true);
        }
      }
    }
  });
});
