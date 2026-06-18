import { describe, it, expect } from 'vitest';
import { triangleDevColumns } from './builder.js';

// The aggregate renewal-pack triangle is anchored at the oldest origin year and
// each row should develop out across the full underwriting-year span. The dev
// axis must therefore be driven by that span, not by the deepest single
// contract's experience window — otherwise summing treaties with rolling ~8yr
// windows yields more UW-year rows than DY columns.
describe('triangleDevColumns', () => {
  it('spans the full underwriting-year range even when contracts only carry 8 dev years', () => {
    // 2014..2026 origin span = 13 years; deepest contract present = DY8 (96m).
    const devSet = new Set([12, 24, 36, 48, 60, 72, 84, 96]);
    const cols = triangleDevColumns(2014, 2026, devSet);
    expect(cols).toHaveLength(13); // DY1..DY13, not clipped to 8
    expect(cols[0]).toBe(12);
    expect(cols[cols.length - 1]).toBe(156); // DY13
  });

  it('never drops a development period that is actually present', () => {
    // Deeper data than the span → keep the deeper columns.
    const devSet = new Set([12, 24, 36, 120]); // DY10 present
    const cols = triangleDevColumns(2024, 2026, devSet); // span 3
    expect(cols).toContain(120);
    expect(cols[cols.length - 1]).toBe(120); // DY10 retained
    expect(cols).toEqual([12, 24, 36, 48, 60, 72, 84, 96, 108, 120]);
  });

  it('falls back to the present periods when bounds are unknown', () => {
    expect(triangleDevColumns(null, null, new Set([24, 12]))).toEqual([12, 24]);
    expect(triangleDevColumns(null, null, new Set())).toEqual([]);
  });
});
