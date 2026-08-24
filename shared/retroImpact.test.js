// Tests for shared/retroImpact.js — the retro impact / line optimiser
// behind the "Retro Impact" button on the offer modals.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETRO_PROGRAMME,
  RETRO_LINE_STEP_PCT,
  authorityCapPct,
  buildRetroLineCurve,
  defaultRetroProgramme,
  evaluateRetroAtLine,
  normaliseProgramme,
  normaliseSubject,
  optimiseRetroLine,
} from './retroImpact.js';

// A realistic proportional subject: USD 40m EPI at 100%, USD 500m
// capacity, 55% expected loss ratio + 38% expenses (7% margin).
const SUBJECT = {
  grossPremium100: 40_000_000,
  grossLimit100: 500_000_000,
  expectedLossRatio: 0.55,
  expenseRatio: 0.38,
  lossCv: 0.9,
  authorityMaxLimit: 50_000_000,
};

const PROGRAMME = {
  qsCessionPct: 15,
  qsCommissionPct: 30,
  xlEnabled: true,
  xlAttachment: 2_500_000,
  xlLimit: 6_000_000,
  xlRolPct: 8,
  xlReinstatements: 1,
  xlReinstatementPct: 100,
  costOfCapitalPct: 15,
};

describe('normaliseSubject / normaliseProgramme', () => {
  it('coerces loose strings and clamps to sane ranges', () => {
    const s = normaliseSubject({ grossPremium100: '40,000,000', expectedLossRatio: '0.55', lossCv: 0, maxLinePct: 250 });
    expect(s.grossPremium100).toBe(40_000_000);
    expect(s.expectedLossRatio).toBe(0.55);
    expect(s.lossCv).toBe(0.5);      // zero CV floored to the default
    expect(s.maxLinePct).toBe(100);  // capped

    const p = normaliseProgramme({ qsCessionPct: '120', xlReinstatements: 2.7, xlRolPct: -4 });
    expect(p.qsCessionPct).toBe(100);
    expect(p.xlReinstatements).toBe(3);
    expect(p.xlRolPct).toBe(0);
    expect(p.xlEnabled).toBe(true);
  });
});

describe('defaultRetroProgramme', () => {
  it('sizes the XL off the expected loss at the seed line', () => {
    const p = defaultRetroProgramme({ grossPremium100: 40e6, expectedLossRatio: 0.55, seedLinePct: 10 });
    // Expected loss at 10% line = 2.2m → attach ≈ 1.5×, limit ≈ 2×.
    expect(p.xlAttachment).toBeGreaterThan(0);
    expect(p.xlLimit).toBeGreaterThan(p.xlAttachment * 0.5);
    expect(p.qsCessionPct).toBe(DEFAULT_RETRO_PROGRAMME.qsCessionPct);
  });

  it('degrades to zero-sized XL with no premium', () => {
    const p = defaultRetroProgramme({});
    expect(p.xlAttachment).toBe(0);
    expect(p.xlLimit).toBe(0);
  });
});

describe('evaluateRetroAtLine', () => {
  const r = evaluateRetroAtLine({ linePct: 10, subject: SUBJECT, programme: PROGRAMME });

  it('scales the gross position linearly with the line', () => {
    expect(r.grossPremium).toBeCloseTo(4_000_000, 6);
    expect(r.grossExpectedLoss).toBeCloseTo(2_200_000, 6);
    expect(r.grossExpenses).toBeCloseTo(1_520_000, 6);
    expect(r.grossLimit).toBeCloseTo(50_000_000, 6);
    expect(r.grossResult).toBeCloseTo(280_000, 6);
  });

  it('applies the QS on original terms', () => {
    expect(r.qsCededPremium).toBeCloseTo(600_000, 6);            // 15% of 4m
    expect(r.qsCommission).toBeCloseTo(180_000, 6);              // 30% of ceded
    expect(r.qsRecovery).toBeCloseTo(330_000, 6);                // 15% of 2.2m
    expect(r.lossAfterQs).toBeCloseTo(1_870_000, 6);
  });

  it('prices the XL on the net-of-QS aggregate with reinstatement premium', () => {
    expect(r.xlPremium).toBeCloseTo(480_000, 6);                 // 6m × 8%
    expect(r.xlCover).toBe(12_000_000);                          // limit × (1 + 1 reinst)
    expect(r.xlRecovery).toBeGreaterThan(0);
    expect(r.xlRecovery).toBeLessThan(r.lossAfterQs);
    // Reinstatement premium is pro-rata to the expected burn.
    expect(r.xlReinstatementPremium).toBeCloseTo(
      r.xlPremium * Math.min(r.xlRecovery / PROGRAMME.xlLimit, 1), 6);
  });

  it('nets spend/recovery consistently (spend − recovery = net cost)', () => {
    expect(r.retroSpend).toBeCloseTo(r.qsCededPremium - r.qsCommission + r.xlSpend, 6);
    expect(r.retroRecovery).toBeCloseTo(r.qsRecovery + r.xlRecovery, 6);
    expect(r.retroNetCost).toBeCloseTo(r.retroSpend - r.retroRecovery, 6);
    expect(r.netResult).toBeCloseTo(r.grossResult - r.retroNetCost, 4);
  });

  it('shows PML relief: retro cuts the 1-in-100 outcome', () => {
    expect(r.grossPml).toBeGreaterThan(r.grossExpectedLoss);
    expect(r.netPml).toBeLessThan(r.grossPml);
    expect(r.pmlRelief).toBeCloseTo(r.grossPml - r.netPml, 6);
  });

  it('flags authority breaches', () => {
    expect(r.withinAuthority).toBe(true);                        // 50m limit at 10% = at cap
    const over = evaluateRetroAtLine({ linePct: 11, subject: SUBJECT, programme: PROGRAMME });
    expect(over.withinAuthority).toBe(false);
  });

  it('with the programme switched off the walk collapses to gross', () => {
    const off = evaluateRetroAtLine({
      linePct: 10,
      subject: SUBJECT,
      programme: { ...PROGRAMME, qsCessionPct: 0, xlEnabled: false },
    });
    expect(off.retroSpend).toBe(0);
    expect(off.retroRecovery).toBe(0);
    expect(off.netResult).toBeCloseTo(off.grossResult, 6);
    expect(off.netPml).toBeCloseTo(off.grossPml, 6);
  });

  it('handles a zero-premium subject without NaNs', () => {
    const z = evaluateRetroAtLine({ linePct: 10, subject: {}, programme: PROGRAMME });
    expect(z.netResult).toBe(0);
    expect(Number.isFinite(z.riskAdjustedResult)).toBe(true);
  });
});

describe('authorityCapPct', () => {
  it('caps the line where the gross limit hits the authority', () => {
    expect(authorityCapPct(SUBJECT)).toBe(10);                   // 50m ÷ 500m
  });
  it('falls back to maxLinePct with no cap configured', () => {
    expect(authorityCapPct({ ...SUBJECT, authorityMaxLimit: 0 })).toBe(100);
  });
});

describe('buildRetroLineCurve', () => {
  it('walks the grid up to the max line', () => {
    const curve = buildRetroLineCurve({ subject: { ...SUBJECT, maxLinePct: 5 }, programme: PROGRAMME });
    expect(curve.length).toBe(Math.round(5 / RETRO_LINE_STEP_PCT));
    expect(curve[0].linePct).toBeCloseTo(RETRO_LINE_STEP_PCT, 9);
    expect(curve[curve.length - 1].linePct).toBeCloseTo(5, 9);
  });
});

describe('optimiseRetroLine', () => {
  it('respects the authority cap and reports it', () => {
    const r = optimiseRetroLine({ subject: SUBJECT, programme: PROGRAMME, currentLinePct: 5 });
    expect(r.capPct).toBe(10);
    expect(r.suggestedLinePct).toBeGreaterThan(0);
    expect(r.suggestedLinePct).toBeLessThanOrEqual(10);
    expect(r.best.linePct).toBe(r.suggestedLinePct);
    expect(r.reason).toContain('%');
  });

  it('finds an interior optimum when the fixed XL stops earning at scale', () => {
    const r = optimiseRetroLine({
      subject: { ...SUBJECT, authorityMaxLimit: 0 },
      programme: PROGRAMME,
      currentLinePct: 10,
    });
    // The optimum must be a real interior point — neither the smallest
    // nor the largest line on the grid.
    expect(r.suggestedLinePct).toBeGreaterThan(RETRO_LINE_STEP_PCT);
    expect(r.suggestedLinePct).toBeLessThan(100);
    // And it must actually be the argmax of the curve.
    const maxRa = Math.max(...r.curve.map((c) => c.riskAdjustedResult));
    expect(r.best.riskAdjustedResult).toBeCloseTo(maxRa, 6);
  });

  it('compares against the no-retro alternative at the same line', () => {
    const r = optimiseRetroLine({ subject: SUBJECT, programme: PROGRAMME });
    expect(r.noRetro.linePct).toBe(r.best.linePct);
    expect(r.noRetro.retroSpend).toBe(0);
    // With this working-layer XL, retro improves the risk-adjusted result.
    expect(r.best.riskAdjustedResult).toBeGreaterThan(r.noRetro.riskAdjustedResult);
  });

  it('reports the uplift vs the current written line', () => {
    const r = optimiseRetroLine({ subject: SUBJECT, programme: PROGRAMME, currentLinePct: 2 });
    expect(r.current.linePct).toBe(2);
    expect(r.uplift).toBeCloseTo(r.best.riskAdjustedResult - r.current.riskAdjustedResult, 6);
  });

  it('degrades gracefully with an empty subject', () => {
    const r = optimiseRetroLine({ subject: {}, programme: PROGRAMME });
    expect(r.suggestedLinePct).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.uplift)).toBe(true);
    expect(typeof r.reason).toBe('string');
  });
});
