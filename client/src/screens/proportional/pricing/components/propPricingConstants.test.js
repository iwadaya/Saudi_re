import { describe, expect, it } from 'vitest';
import {
  calcLPC,
  cn,
  fitPareto,
  fmt,
  fmtPct,
  mbbefdG,
  parsePct,
  paretoQ,
} from './propPricingConstants.js';

describe('proportional pricing shared helpers', () => {
  it('uses the canonical flexible number parser for cn', () => {
    expect(cn('1,234.50')).toBe(1234.5);
    expect(cn('SAR 1,000')).toBe(1000);
    expect(cn('(500)')).toBe(-500);
  });

  it('formats money-ish and ratio cells consistently', () => {
    expect(fmt(1_234_567)).toBe('1,234,567');
    expect(fmt(null)).toBe('—');
    expect(fmtPct(0.1234)).toBe('12.34%');
  });

  it('parses percentage labels used by share scenarios', () => {
    expect(parsePct('5%')).toBe(0.05);
    expect(parsePct('2.5')).toBeCloseTo(0.025);
    expect(parsePct('0.05')).toBe(0.05);
    expect(parsePct('')).toBe(0);
  });

  it('calculates multi-corridor loss participation credit', () => {
    const terms = {
      lossPartEnabled: true,
      lpSlides: [
        { minLr: 60, maxLr: 80, share: 50 },
        { minLr: 80, maxLr: 100, share: 75 },
      ],
    };
    expect(calcLPC(1_000_000, 900_000, terms)).toBe(175_000);
  });

  it('keeps exposure curve and Pareto helpers bounded', () => {
    expect(mbbefdG(0, 3)).toBe(0);
    expect(mbbefdG(1, 3)).toBe(1);
    expect(mbbefdG(0.5, 0)).toBe(0.5);

    const fit = fitPareto([1_000, 2_000, 4_000], 1_000);
    expect(fit.n).toBe(3);
    expect(fit.alpha).toBeGreaterThan(0);
    expect(paretoQ(0.99, fit.alpha, 1_000)).toBeGreaterThan(1_000);
  });
});
