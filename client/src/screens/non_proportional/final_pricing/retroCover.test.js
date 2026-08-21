// retroCover.test.js — hand-computed golden values for the retro cover math.
//
// Reference tower used throughout (100% terms):
//   L1  limit 10,000,000  premium 1,000,000 (10% ROL)  technical 6%
//   L2  limit 20,000,000  premium 1,600,000 ( 8% ROL)  technical 5%
//   tower 30,000,000   premium 2,600,000   expected loss 1,600,000
//
// Reference programme: 4,000,000 xs 1,000,000 at 3% ROL, no quota share.
// Working, per written line x (fraction):
//   event    = 30,000,000x     premium = 2,600,000x    exp loss = 1,600,000x
//   recovery = clamp(30,000,000x − 1,000,000, 0, 4,000,000)
//   retro cost = 3% × recovery
// so above the retention and while protected:
//   net margin = 1,000,000x − 900,000x + 30,000 = 100,000x + 30,000
// and the largest fully-protected line is 5,000,000 / 30,000,000 = 16.66%.

import { describe, it, expect } from 'vitest';
import {
  aiLineSuggestion, analyseRetroCover, buildRetroLayers, normaliseProgramme,
  optimiseLine, programmeFromRecord, retroImpact, retroLineCurve, retroVerdict,
} from './retroCover.js';

const LAYERS = [
  { label: 'L1', limit: 10_000_000, premium100: 1_000_000, techRolPct: 6 },
  { label: 'L2', limit: 20_000_000, premium100: 1_600_000, techRolPct: 5 },
];
const PROG = normaliseProgramme({
  cessionPct: 0, commissionPct: 25, retentionAmt: 1_000_000,
  limitAmt: 4_000_000, rolPct: 3, usedLimitAmt: 0, maxLinePct: 25,
});

describe('retroImpact', () => {
  it('splits a 10% line across retention, retro recovery and cost of cover', () => {
    const r = retroImpact(LAYERS, PROG, 10);
    expect(r.linePct).toBeCloseTo(10, 10);
    expect(r.grossEventLoss).toBe(3_000_000);
    expect(r.grossPremium).toBe(260_000);
    expect(r.grossExpLoss).toBe(160_000);          // 10m×6%×10% + 20m×5%×10%
    expect(r.retroRecovery).toBe(2_000_000);       // 3m − 1m retention
    expect(r.netRetainedEvent).toBe(1_000_000);    // capped at the retention
    expect(r.unprotected).toBe(0);
    expect(r.retroCost).toBe(60_000);              // 3% × 2,000,000
    expect(r.netPremium).toBe(200_000);            // 260,000 − 60,000
    expect(r.netMargin).toBe(40_000);              // 200,000 − 160,000
    expect(r.netMarginPct).toBeCloseTo(20, 10);
    expect(r.retroCostRatioPct).toBeCloseTo(23.0769, 3);
    expect(r.retentionUtilPct).toBeCloseTo(100, 10);
    expect(r.retroLimitUtilPct).toBeCloseTo(50, 10);
    expect(r.returnOnCapacity).toBeCloseTo(0.04, 10);
    expect(r.fullyProtected).toBe(true);
  });

  it('leaves the excess unprotected once the retro limit is exhausted', () => {
    const r = retroImpact(LAYERS, PROG, 20);
    expect(r.grossEventLoss).toBe(6_000_000);
    expect(r.retroRecovery).toBe(4_000_000);       // limit, not 5,000,000
    expect(r.unprotected).toBe(1_000_000);
    expect(r.netRetainedEvent).toBe(2_000_000);    // retention + the gap
    expect(r.retentionUtilPct).toBeCloseTo(200, 10);
    expect(r.fullyProtected).toBe(false);
  });

  it('keeps a line below the retention entirely net', () => {
    const r = retroImpact(LAYERS, PROG, 2);        // event 600,000 < 1,000,000
    expect(r.retroRecovery).toBe(0);
    expect(r.retroCost).toBe(0);
    expect(r.netRetainedEvent).toBe(600_000);
    expect(r.netMargin).toBe(20_000);              // 52,000 premium − 32,000
    expect(r.returnOnCapacity).toBeCloseTo(1 / 30, 10);
  });

  it('cedes premium, losses and exposure through a retro quota share first', () => {
    const qs = normaliseProgramme({ ...PROG, cessionPct: 25, commissionPct: 20 });
    const r = retroImpact(LAYERS, qs, 10);
    expect(r.cededPremium).toBe(65_000);           // 25% of 260,000
    expect(r.commissionIncome).toBe(13_000);       // 20% of the cession
    expect(r.qsNetPremium).toBe(208_000);          // 260,000 − 65,000 + 13,000
    expect(r.qsNetEventLoss).toBe(2_250_000);      // 3,000,000 × 75%
    expect(r.qsNetExpLoss).toBe(120_000);          // 160,000 × 75%
    expect(r.retroRecovery).toBe(1_250_000);       // 2,250,000 − 1,000,000
    expect(r.retroCost).toBe(37_500);
    expect(r.netMargin).toBe(50_500);              // 208,000 − 37,500 − 120,000
  });

  it('nets off limit the rest of the book has already burned', () => {
    const used = normaliseProgramme({ ...PROG, usedLimitAmt: 3_000_000 });
    const r = retroImpact(LAYERS, used, 10);
    expect(r.availableLimit).toBe(1_000_000);
    expect(r.retroRecovery).toBe(1_000_000);
    expect(r.unprotected).toBe(1_000_000);
    expect(r.netRetainedEvent).toBe(2_000_000);
    expect(r.fullyProtected).toBe(false);
  });

  it('accepts a per-layer line and reports the limit-weighted average', () => {
    const r = retroImpact(LAYERS, PROG, [15, 5]);  // 1.5m + 1.0m exposure
    expect(r.grossEventLoss).toBe(2_500_000);
    expect(r.linePct).toBeCloseTo(8.3333, 3);      // 2.5m / 30m
    expect(r.grossPremium).toBe(230_000);          // 150,000 + 80,000
  });

  it('reports a zero position for an empty tower instead of dividing by zero', () => {
    const r = retroImpact([], PROG, 10);
    expect(r.grossEventLoss).toBe(0);
    expect(r.netMarginPct).toBe(0);
    expect(r.retroLimitUtilPct).toBe(0);
    expect(r.fullyProtected).toBe(true);
  });
});

describe('retroLineCurve + optimiseLine', () => {
  it('sweeps in quarter-point steps up to the programme ceiling', () => {
    const curve = retroLineCurve(LAYERS, PROG);
    expect(curve[0].linePct).toBeCloseTo(0.25, 10);
    expect(curve.at(-1).linePct).toBeCloseTo(25, 10);
    expect(curve).toHaveLength(100);
  });

  it('optimises onto the largest fully-protected line when retro is cheap', () => {
    // Return on capacity climbs with the line while the retention is fixed, so
    // the optimum sits at the top of the protected range: 16.5% on the grid
    // (16.75% would put 5,025,000 through a 5,000,000 programme).
    const { optimal, capacity, constrained } = optimiseLine(retroLineCurve(LAYERS, PROG));
    expect(constrained).toBe(false);
    expect(capacity.linePct).toBeCloseTo(16.5, 10);
    expect(optimal.linePct).toBeCloseTo(16.5, 10);
    expect(optimal.netMargin).toBeCloseTo(46_500, 6);   // 100,000 × 0.165 + 30,000
  });

  it('pulls the optimum back under the retention when the cover is expensive', () => {
    // At 15% ROL each point of line above the retention costs more margin than
    // it earns, so the best return on capacity is the largest line that stays
    // inside the retention: 30,000,000 × 3.25% = 975,000.
    const dear = normaliseProgramme({ ...PROG, rolPct: 15 });
    const { optimal } = optimiseLine(retroLineCurve(LAYERS, dear));
    expect(optimal.linePct).toBeCloseTo(3.25, 10);
    expect(optimal.retroCost).toBe(0);
    expect(optimal.netRetainedEvent).toBe(975_000);
  });

  it('returns no optimum when nothing the treaty can write is protected', () => {
    const tiny = normaliseProgramme({ ...PROG, retentionAmt: 0, limitAmt: 10_000, usedLimitAmt: 0 });
    const { optimal, capacity } = optimiseLine(retroLineCurve(LAYERS, tiny));
    expect(optimal).toBeNull();
    expect(capacity).toBeNull();
  });
});

describe('analyseRetroCover + retroVerdict', () => {
  const analyse = (over = {}, opts = {}) =>
    analyseRetroCover(LAYERS, { ...PROG, ...over }, { suggestedLinePct: 10, ...opts });

  it('scores the suggested line, the written line and the optimum together', () => {
    const a = analyse({}, { currentLines: [15, 5] });
    expect(a.suggested.linePct).toBeCloseTo(10, 10);
    expect(a.current.grossEventLoss).toBe(2_500_000);
    expect(a.optimal.linePct).toBeCloseTo(16.5, 10);
    expect(a.hasExposure).toBe(true);
  });

  it('omits the written-line scenario until a line is entered', () => {
    expect(analyse({}, { currentLines: ['', ''] }).current).toBeNull();
    expect(analyse({}, { suggestedLinePct: 0 }).suggested).toBeNull();
  });

  it('flags headroom above the suggested line', () => {
    const v = retroVerdict(analyse());
    expect(v.status).toBe('HEADROOM');
    expect(v.headline).toMatch(/16\.5%/);
    expect(v.detail).toMatch(/50\.0% of the retro limit/);
  });

  it('flags a suggested line that outruns the programme', () => {
    const v = retroVerdict(analyse({}, { suggestedLinePct: 20 }));
    expect(v.status).toBe('BREACH');
    expect(v.detail).toMatch(/1,000,000 above retention/);
    expect(v.detail).toMatch(/16\.5% is the largest fully-protected line/);
  });

  it('flags a suggested line that is buying more retro than it earns', () => {
    const v = retroVerdict(analyse({ rolPct: 15 }));
    expect(v.status).toBe('OVER');
    expect(v.headline).toMatch(/3\.25%/);
  });

  it('calls the suggested line aligned when it lands on the optimum', () => {
    const v = retroVerdict(analyse({}, { suggestedLinePct: 16.5 }));
    expect(v.status).toBe('ALIGNED');
  });

  it('says so when there is nothing to analyse', () => {
    expect(retroVerdict(analyseRetroCover([], PROG, { suggestedLinePct: 10 })).status).toBe('NONE');
    expect(retroVerdict(analyseRetroCover(LAYERS, PROG, {})).status).toBe('NONE');
  });

  it('analyses nothing at all when no retro contract has been captured', () => {
    const a = analyseRetroCover(LAYERS, null, { suggestedLinePct: 10, currentLines: [15, 5] });
    expect(a.hasProgramme).toBe(false);
    expect(a.curve).toEqual([]);
    expect(a.suggested).toBeNull();
    expect(a.current).toBeNull();
    expect(a.optimal).toBeNull();

    const v = retroVerdict(a);
    expect(v.status).toBe('NO_PROGRAMME');
    expect(v.detail).toMatch(/administrator captures it/i);
  });
});

describe('programme helpers', () => {
  // The admin-captured record (server shape) for one underwriting year.
  const RECORD = {
    retro_programme_id: 'r1', uw_year: 2026, currency: 'USD', label: '2026 Cat XL Retro',
    retention_amt: 1_000_000, limit_amt: 4_000_000, rol_pct: 3,
    used_limit_amt: 0, cession_pct: 0, commission_pct: 25, max_line_pct: 25,
  };

  it('maps the admin retro contract onto the pricing shape', () => {
    expect(programmeFromRecord(RECORD)).toEqual({
      retentionAmt: 1_000_000, limitAmt: 4_000_000, rolPct: 3, usedLimitAmt: 0,
      cessionPct: 0, commissionPct: 25, maxLinePct: 25,
      uwYear: 2026, currency: 'USD', label: '2026 Cat XL Retro',
    });
  });

  it('reads numeric columns that arrive as strings from the database', () => {
    const p = programmeFromRecord({ ...RECORD, retention_amt: '1000000.00', rol_pct: '3.500000' });
    expect(p.retentionAmt).toBe(1_000_000);
    expect(p.rolPct).toBe(3.5);
  });

  it('returns null without a record — there is nothing to analyse', () => {
    expect(programmeFromRecord(null)).toBeNull();
    expect(programmeFromRecord(undefined)).toBeNull();
  });

  it('defaults blank columns to zero, keeps the line ceiling, clamps percentages', () => {
    const p = normaliseProgramme({ commissionPct: 140, rolPct: '7.5%', retentionAmt: '2,000,000' });
    expect(p.commissionPct).toBe(100);
    expect(p.rolPct).toBe(7.5);
    expect(p.retentionAmt).toBe(2_000_000);
    expect(p.limitAmt).toBe(0);                    // blank on the record → no cover
    expect(p.maxLinePct).toBe(25);
  });

  it('builds layers from the offer modal rows, per-layer technical over average', () => {
    const built = buildRetroLayers(
      [{ layer: 'L1', limit: 10_000_000, ep100: 1_000_000 }, { layer: 'L2', limit: 20_000_000, ep100: 1_600_000 }],
      [{ technicalRatio: '6' }, {}],
      5,
    );
    expect(built[0].techRolPct).toBe(6);
    expect(built[1].techRolPct).toBe(5);           // falls back to the average
  });
});

describe('aiLineSuggestion', () => {
  it('reproduces the offer modal suggestion — margin 60%, balance 40%', () => {
    // avg ROL 9%, technical 5% → margin 4% → mQ = 0.04/0.3 = 0.13333
    // tower 30m over 50m EGNPI → balance 0.6 → bQ = 0.01
    // (0.13333×0.6 + 0.01×0.4) × 20 = 1.68 → 1.7%
    const s = aiLineSuggestion({
      layers: [{ limit: 10_000_000, rolPct: 10 }, { limit: 20_000_000, rolPct: 8 }],
      egnpi: 50_000_000, techRatioAvgPct: 5,
    });
    expect(s.avgRolPct).toBeCloseTo(9, 10);
    expect(s.marginAct).toBeCloseTo(0.04, 10);
    expect(s.linePct).toBeCloseTo(1.7, 10);
    expect(s.reason).toMatch(/Thin margin \(4\.0%\)/);
  });

  it('caps the line at 20% and reads a strong margin', () => {
    const s = aiLineSuggestion({
      layers: [{ limit: 100_000_000, rolPct: 40 }], egnpi: 1_000_000, techRatioAvgPct: 5,
    });
    expect(s.linePct).toBe(20);
    expect(s.reason).toMatch(/Strong margin/);
  });

  it('falls back to 10% when the engine has produced nothing', () => {
    const s = aiLineSuggestion({ layers: [{ limit: 10_000_000, rolPct: 0 }], egnpi: 0 });
    expect(s.linePct).toBe(10);
    expect(s.reason).toMatch(/Run pricing engine/);
  });
});
