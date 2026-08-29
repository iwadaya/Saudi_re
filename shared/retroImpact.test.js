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
  bookShareFrac,
  programmeFromStored,
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
  });

  it('pins xlRecovery and the reinstatement premium to independently derived values', () => {
    // Independent reference (machine-precision erf, cross-checked by Simpson
    // integration of the lognormal survival function — two methods agreeing
    // to 1e-9 relative; the module's A&S erf is allowed ~1.5e-7):
    //   lossAfterQs = 2.2m × (1 − 0.15) = 1.87m, CV 0.9
    //   σ² = ln(1 + 0.9²) = ln(1.81)  → σ = 0.7702771224
    //   μ  = ln(1,870,000) − σ²/2     = 14.1447855662
    //   π(K) = m·Φ((μ+σ²−lnK)/σ) − K·Φ((μ−lnK)/σ),  m = 1.87m
    //   π(2.5m) = 383,599.84   π(8.5m) = 26,962.33   π(14.5m) = 4,563.28
    // xlRecovery = E[min(max(S−2.5m,0), 12m)] = π(2.5m) − π(14.5m) = 379,036.56
    expect(r.xlRecovery).toBeCloseTo(379_036.56, -1);
    // Reinstatement premium must be premium × pct × E[min(layer loss, r·L)]/L
    // (the reinstated amount is a capped variable INSIDE the expectation),
    // not premium × pct × min(E[layer loss]/L, r):
    //   E[min(layer loss, 1×6m)] = π(2.5m) − π(8.5m) = 356,637.51
    //   reinstatement premium = 480,000 × 100% × 356,637.51/6m = 28,531.00
    expect(r.xlReinstatementPremium).toBeCloseTo(28_531.0, 0);
    // Jensen's inequality: the old min(E[burn], r) formula (= 30,322.9 here)
    // must strictly overstate the correct expectation.
    expect(r.xlReinstatementPremium).toBeLessThan(
      r.xlPremium * Math.min(r.xlRecovery / PROGRAMME.xlLimit, PROGRAMME.xlReinstatements));
  });

  it('charges no reinstatement premium when none are bought or they are free', () => {
    const none = evaluateRetroAtLine({
      linePct: 10, subject: SUBJECT,
      programme: { ...PROGRAMME, xlReinstatements: 0 },
    });
    expect(none.xlReinstatementPremium).toBe(0);
    const free = evaluateRetroAtLine({
      linePct: 10, subject: SUBJECT,
      programme: { ...PROGRAMME, xlReinstatementPct: 0 },
    });
    expect(free.xlReinstatementPremium).toBe(0);
    // …and a 50% term is exactly half the 100% charge.
    const half = evaluateRetroAtLine({
      linePct: 10, subject: SUBJECT,
      programme: { ...PROGRAMME, xlReinstatementPct: 50 },
    });
    expect(half.xlReinstatementPremium).toBeCloseTo(r.xlReinstatementPremium / 2, 6);
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

describe('programmeFromStored', () => {
  it('maps a stored QS + XL pair onto the single-layer model', () => {
    const { programme, sourceNames, unusedNames, hasStored } = programmeFromStored([
      { programme_type: 'QUOTA_SHARE', programme_name: 'WA QS', cession_pct: '25', commission_pct: '30' },
      { programme_type: 'XL_CAT', programme_name: 'Cat XL', attachment: '5,000,000', occurrence_limit: '20000000', rol_pct: 12.5, reinstatements: 2 },
    ]);
    expect(hasStored).toBe(true);
    expect(programme.qsCessionPct).toBe(25);
    expect(programme.qsCommissionPct).toBe(30);
    expect(programme.xlEnabled).toBe(true);
    expect(programme.xlAttachment).toBe(5_000_000);
    expect(programme.xlLimit).toBe(20_000_000);
    expect(programme.xlRolPct).toBe(12.5);
    expect(programme.xlReinstatements).toBe(2);
    expect(sourceNames).toEqual(['WA QS', 'Cat XL']);
    expect(unusedNames).toEqual([]);
  });

  it('with only an XL stored, the QS cession is 0 (no pro-rata retro exists)', () => {
    const { programme } = programmeFromStored([
      { programme_type: 'STOP_LOSS', programme_name: 'SL', attachment: 1, occurrence_limit: 2, rol_pct: 5, reinstatements: 0 },
    ]);
    expect(programme.qsCessionPct).toBe(0);
    expect(programme.xlEnabled).toBe(true);
  });

  it('with only a QS stored, the XL is off', () => {
    const { programme } = programmeFromStored([
      { programme_type: 'SURPLUS', programme_name: 'Surp', cession_pct: 40, commission_pct: 25 },
    ]);
    expect(programme.qsCessionPct).toBe(40);
    expect(programme.xlEnabled).toBe(false);
    expect(programme.xlLimit).toBe(0);
  });

  it('reports extra programmes beyond the first of each kind as unused', () => {
    const { sourceNames, unusedNames } = programmeFromStored([
      { programme_type: 'XL_PER_RISK', programme_name: 'Risk XL', occurrence_limit: 1 },
      { programme_type: 'XL_CAT', programme_name: 'Cat XL', occurrence_limit: 1 },
      { programme_type: 'QUOTA_SHARE', programme_name: 'QS 1', cession_pct: 10 },
      { programme_type: 'QUOTA_SHARE', programme_name: 'QS 2', cession_pct: 5 },
    ]);
    expect(sourceNames).toEqual(['QS 1', 'Risk XL']);
    expect(unusedNames).toEqual(['QS 2', 'Cat XL']);
  });

  it('empty / missing input falls back to the illustrative default, flagged hasStored=false', () => {
    for (const input of [[], null, undefined]) {
      const out = programmeFromStored(input);
      expect(out.hasStored).toBe(false);
      expect(out.programme).toEqual({ ...DEFAULT_RETRO_PROGRAMME });
      expect(out.sourceNames).toEqual([]);
    }
  });
});

describe('bookShareFrac', () => {
  it('is subject ÷ book for a contract already inside the book', () => {
    expect(bookShareFrac({ subjectExposure: 80e6, bookExposure: 320e6 })).toBeCloseTo(0.25, 12);
  });
  it('adds a quote to the denominator (not yet written into the book)', () => {
    expect(bookShareFrac({ subjectExposure: 80e6, bookExposure: 240e6, subjectInBook: false })).toBeCloseTo(0.25, 12);
  });
  it('caps at 1 and treats degenerate exposures as no scaling', () => {
    expect(bookShareFrac({ subjectExposure: 500e6, bookExposure: 100e6 })).toBe(1);
    expect(bookShareFrac({ subjectExposure: 0, bookExposure: 100e6 })).toBe(1);
    expect(bookShareFrac({ subjectExposure: 100e6, bookExposure: 0 })).toBe(1);
    expect(bookShareFrac({})).toBe(1);
  });
});

describe('programmeFromStored — whole-account scaling', () => {
  const XL = {
    programme_type: 'WHOLE_ACCOUNT_XL', programme_name: 'WA Cat XL',
    attachment: 20_000_000, occurrence_limit: 80_000_000,
    rol_pct: 12, reinstatements: 1, book_exposure: 320_000_000,
  };

  it('scales attachment and limit to the treaty share; rates pass through', () => {
    const out = programmeFromStored([XL], { subjectExposure: 80_000_000 });
    expect(out.shareFrac).toBeCloseTo(0.25, 12);
    expect(out.scaled).toBe(true);
    expect(out.programme.xlAttachment).toBe(5_000_000);   // 20m × 25%
    expect(out.programme.xlLimit).toBe(20_000_000);       // 80m × 25%
    expect(out.programme.xlRolPct).toBe(12);              // rate — unscaled
    expect(out.programme.xlReinstatements).toBe(1);
    expect(out.bookExposure).toBe(320_000_000);
    expect(out.subjectExposure).toBe(80_000_000);
  });

  it('rounds scaled amounts to quotable figures (3 significant digits)', () => {
    const out = programmeFromStored(
      [{ ...XL, attachment: 17_777_777, occurrence_limit: 53_333_333 }],
      { subjectExposure: 80_000_000 },
    );
    expect(out.programme.xlAttachment).toBe(4_440_000);   // 4,444,444.25 → 3 s.f.
    expect(out.programme.xlLimit).toBe(13_300_000);       // 13,333,333.25 → 3 s.f.
  });

  it('a quote joins the book denominator before scaling', () => {
    const out = programmeFromStored(
      [{ ...XL, book_exposure: 240_000_000 }],
      { subjectExposure: 80_000_000, subjectInBook: false },
    );
    expect(out.shareFrac).toBeCloseTo(0.25, 12);
    expect(out.bookExposure).toBe(320_000_000); // effective denominator shown to the user
  });

  it('does not scale when the treaty IS the whole in-scope book', () => {
    const out = programmeFromStored(
      [{ ...XL, book_exposure: 80_000_000 }],
      { subjectExposure: 80_000_000 },
    );
    expect(out.shareFrac).toBe(1);
    expect(out.scaled).toBe(false);
    expect(out.programme.xlAttachment).toBe(20_000_000);  // raw stored terms
    expect(out.programme.xlLimit).toBe(80_000_000);
  });

  it('does not scale without exposure data (opts omitted / zero exposures)', () => {
    for (const opts of [undefined, { subjectExposure: 0 }, {}]) {
      const out = programmeFromStored([XL], opts);
      expect(out.scaled).toBe(false);
      expect(out.programme.xlAttachment).toBe(20_000_000);
      expect(out.programme.xlLimit).toBe(80_000_000);
    }
  });

  it('QS cession is never scaled — it is already proportional to the line', () => {
    const out = programmeFromStored(
      [{ programme_type: 'QUOTA_SHARE', programme_name: 'WA QS', cession_pct: 25, commission_pct: 30 }, XL],
      { subjectExposure: 80_000_000 },
    );
    expect(out.programme.qsCessionPct).toBe(25);
    expect(out.programme.qsCommissionPct).toBe(30);
  });
});

describe('programmeFromStored — currency conversion', () => {
  const EUR_XL = {
    programme_type: 'XL_CAT', programme_name: 'EUR Cat XL', currency_code: 'EUR',
    attachment: 10_000_000, occurrence_limit: 40_000_000,
    rol_pct: 12, reinstatements: 1,
  };

  it('converts XL amounts into treaty currency via fx_to_subject; rates untouched', () => {
    const out = programmeFromStored([{ ...EUR_XL, fx_to_subject: 4, fx_missing: false }]);
    expect(out.converted).toBe(true);
    expect(out.fxToSubject).toBe(4);
    expect(out.fromCurrency).toBe('EUR');
    expect(out.programme.xlAttachment).toBe(40_000_000);
    expect(out.programme.xlLimit).toBe(160_000_000);
    expect(out.programme.xlRolPct).toBe(12);            // a rate — no conversion
  });

  it('applies FX then the book share as one multiplier with one rounding pass', () => {
    const out = programmeFromStored(
      [{ ...EUR_XL, fx_to_subject: 4.05, fx_missing: false, book_exposure: 320_000_000 }],
      { subjectExposure: 80_000_000 },
    );
    // 10m × 4.05 × 25% = 10.125m → 10.1m at 3 s.f.; 40m × 4.05 × 25% = 40.5m.
    expect(out.programme.xlAttachment).toBe(10_100_000);
    expect(out.programme.xlLimit).toBe(40_500_000);
    expect(out.converted).toBe(true);
    expect(out.scaled).toBe(true);
  });

  it('same currency (fx 1) leaves amounts untouched and unflagged', () => {
    const out = programmeFromStored([{ ...EUR_XL, fx_to_subject: 1, fx_missing: false }]);
    expect(out.converted).toBe(false);
    expect(out.programme.xlAttachment).toBe(10_000_000);
  });

  it('a missing exchange rate is surfaced, amounts left unconverted', () => {
    const out = programmeFromStored([{ ...EUR_XL, fx_to_subject: 1, fx_missing: true }]);
    expect(out.fxMissing).toBe(true);
    expect(out.converted).toBe(false);
    expect(out.programme.xlAttachment).toBe(10_000_000);
  });

  it('rows without fx fields behave as fx 1 (back-compat)', () => {
    const out = programmeFromStored([EUR_XL]);
    expect(out.fxToSubject).toBe(1);
    expect(out.converted).toBe(false);
    expect(out.fxMissing).toBe(false);
  });
});

describe('programmeFromStored — book FX flags', () => {
  it('surfaces the count of in-scope treaties missing an exchange rate', () => {
    const out = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'Cat XL',
      attachment: 1, occurrence_limit: 2, book_exposure: 100, book_fx_missing: 3,
    }]);
    expect(out.bookFxMissing).toBe(3);
  });
  it('defaults to 0 without the field or without an XL', () => {
    expect(programmeFromStored([{ programme_type: 'XL_CAT', programme_name: 'X', occurrence_limit: 1 }]).bookFxMissing).toBe(0);
    expect(programmeFromStored([{ programme_type: 'QUOTA_SHARE', programme_name: 'Q', cession_pct: 10 }]).bookFxMissing).toBe(0);
    expect(programmeFromStored([]).bookFxMissing).toBe(0);
  });
});

describe('programmeFromStored — layered towers', () => {
  const TOWER = {
    programme_type: 'XL_CAT', programme_name: 'Cat Tower',
    attachment: null, occurrence_limit: null, rol_pct: null, reinstatements: null,
    layers: [
      { layer_number: 1, attachment: 5_000_000, occurrence_limit: 10_000_000, rol_pct: 18, reinstatements: 2 },
      { layer_number: 2, attachment: 15_000_000, occurrence_limit: 25_000_000, rol_pct: 9, reinstatements: 1 },
    ],
  };

  it('flattens a tower: bottom attachment, Σ limits, limit-weighted ROL, min reinstatements', () => {
    const out = programmeFromStored([TOWER]);
    expect(out.layerCount).toBe(2);
    expect(out.programme.xlAttachment).toBe(5_000_000);
    expect(out.programme.xlLimit).toBe(35_000_000);
    expect(out.programme.xlRolPct).toBeCloseTo((18 * 10 + 9 * 25) / 35, 10);
    expect(out.programme.xlReinstatements).toBe(1);
  });

  it('flattened tower still converts and scales like a single cover', () => {
    const out = programmeFromStored(
      [{ ...TOWER, fx_to_subject: 2, fx_missing: false, book_exposure: 320_000_000 }],
      { subjectExposure: 80_000_000 },
    );
    // (5m att, 35m lim) × fx 2 × share 25% → 2.5m xs …, limit 17.5m.
    expect(out.programme.xlAttachment).toBe(2_500_000);
    expect(out.programme.xlLimit).toBe(17_500_000);
  });

  it('ignores blank layers and falls back to programme-level terms when none are usable', () => {
    const out = programmeFromStored([{ ...TOWER, layers: [{ occurrence_limit: 0 }], attachment: 1_000_000, occurrence_limit: 4_000_000, rol_pct: 12 }]);
    expect(out.layerCount).toBe(0);
    expect(out.incompleteLayers).toBe(1);
    expect(out.programme.xlAttachment).toBe(1_000_000);
    expect(out.programme.xlLimit).toBe(4_000_000);
  });
});

describe('programmeFromStored — incomplete layers (F38)', () => {
  // attachment is NULLABLE in retro_programme_layer; a partially-entered
  // layer must not be coerced to "attaches at ground-up".
  const PARTIAL_TOWER = {
    programme_type: 'XL_CAT', programme_name: 'Cat Tower',
    layers: [
      { layer_number: 1, attachment: null, occurrence_limit: 10_000_000, rol_pct: 18 },
      { layer_number: 2, attachment: 15_000_000, occurrence_limit: 25_000_000, rol_pct: 9, reinstatements: 0 },
    ],
  };

  it('excludes a NULL-attachment layer instead of dragging the tower to ground-up', () => {
    const out = programmeFromStored([PARTIAL_TOWER]);
    expect(out.programme.xlAttachment).toBe(15_000_000);  // NOT min(0, 15m) = 0
    expect(out.programme.xlLimit).toBe(25_000_000);       // NOT 10m + 25m
    expect(out.programme.xlRolPct).toBe(9);               // weighted over usable layers only
    expect(out.layerCount).toBe(1);
    expect(out.incompleteLayers).toBe(1);                 // surfaced for the UI
  });

  it('the excluded layer no longer flips recoveries to near-total (pinned)', () => {
    const { programme } = programmeFromStored([PARTIAL_TOWER]);
    const r = evaluateRetroAtLine({ linePct: 10, subject: SUBJECT, programme });
    // Independent reference for E[min(max(S−15m,0), 25m)], S ~ Lognormal with
    // mean 2.2m (no stored QS → lossAfterQs = grossExpectedLoss), CV 0.9:
    //   σ = 0.7702771224, μ = ln(2,200,000) − σ²/2 = 14.3072171568
    //   π(15m) − π(40m) = 8,411.90 (closed form with machine-precision erf,
    //   cross-checked by numeric integration; module erf tolerance < 5).
    expect(r.xlRecovery).toBeCloseTo(8_411.9, -1);
    // The pre-fix flatten attached at 0 and recovered ~2.2m — the entire
    // expected loss. Guard the order of magnitude too.
    expect(r.xlRecovery).toBeLessThan(10_000);
  });

  it('a stored attachment of 0 is a real value, not an incomplete layer', () => {
    const out = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'GU',
      layers: [{ layer_number: 1, attachment: 0, occurrence_limit: 10_000_000, rol_pct: 18 }],
    }]);
    expect(out.programme.xlAttachment).toBe(0);
    expect(out.layerCount).toBe(1);
    expect(out.incompleteLayers).toBe(0);
  });

  it('surfaces a missing programme-level attachment instead of passing it silently', () => {
    const missing = programmeFromStored([
      { programme_type: 'XL_CAT', programme_name: 'X', attachment: null, occurrence_limit: 10_000_000, rol_pct: 12 },
    ]);
    expect(missing.xlAttachmentMissing).toBe(true);
    expect(missing.programme.xlAttachment).toBe(0);       // conservative back-compat value…
    const present = programmeFromStored([
      { programme_type: 'XL_CAT', programme_name: 'X', attachment: 2_000_000, occurrence_limit: 10_000_000, rol_pct: 12 },
    ]);
    expect(present.xlAttachmentMissing).toBe(false);      // …and no flag when it is stored
  });
});

describe('programmeFromStored — stored reinstatement terms (F39)', () => {
  it('honours a free (0%) stored reinstatement instead of the illustrative 100%', () => {
    const { programme } = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'Free reinst XL',
      layers: [{ layer_number: 1, attachment: 2_500_000, occurrence_limit: 6_000_000, rol_pct: 8, reinstatements: 1, reinstatement_pct: 0 }],
    }]);
    expect(programme.xlReinstatementPct).toBe(0);
    const r = evaluateRetroAtLine({ linePct: 10, subject: SUBJECT, programme });
    expect(r.xlReinstatementPremium).toBe(0);             // the contract levies nothing
    expect(r.xlSpend).toBeCloseTo(r.xlPremium, 6);
  });

  it('flattens the stored per-layer reinstatement % limit-weighted', () => {
    const { programme } = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'Tower',
      layers: [
        { layer_number: 1, attachment: 5_000_000, occurrence_limit: 10_000_000, rol_pct: 18, reinstatements: 1, reinstatement_pct: 0 },
        { layer_number: 2, attachment: 15_000_000, occurrence_limit: 25_000_000, rol_pct: 9, reinstatements: 1, reinstatement_pct: 100 },
      ],
    }]);
    // (0×10m + 100×25m) / 35m = 500/7 = 71.4285714…
    expect(programme.xlReinstatementPct).toBeCloseTo(500 / 7, 10);
  });

  it('reads a programme-level reinstatement_pct when a flat row carries one', () => {
    const { programme } = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'X',
      attachment: 2_500_000, occurrence_limit: 6_000_000, rol_pct: 8,
      reinstatements: 1, reinstatement_pct: 50,
    }]);
    expect(programme.xlReinstatementPct).toBe(50);
  });

  it('falls back to the conservative 100% default only when nothing is stored', () => {
    const { programme } = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'X',
      attachment: 2_500_000, occurrence_limit: 6_000_000, rol_pct: 8, reinstatements: 1,
    }]);
    expect(programme.xlReinstatementPct).toBe(DEFAULT_RETRO_PROGRAMME.xlReinstatementPct);
  });
});

describe('programmeFromStored — stored premium / ROL (F40)', () => {
  it('derives the flat ROL from stored premium ÷ limit instead of the 12% default', () => {
    const out = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'X',
      attachment: 2_000_000, occurrence_limit: 10_000_000, rol_pct: null, premium: 500_000,
    }]);
    expect(out.programme.xlRolPct).toBe(5);               // 100 × 500k / 10m
    expect(out.xlRolDefaulted).toBe(false);
  });

  it('both storage shapes of the same cover give the same premium-derived ROL', () => {
    const flat = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'X',
      attachment: 2_000_000, occurrence_limit: 10_000_000, rol_pct: null, premium: 500_000,
    }]);
    const layered = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'X',
      layers: [{ layer_number: 1, attachment: 2_000_000, occurrence_limit: 10_000_000, rol_pct: null, premium: 500_000 }],
    }]);
    expect(layered.programme.xlRolPct).toBe(5);           // was 0 (free cover) pre-fix
    expect(layered.programme.xlRolPct).toBe(flat.programme.xlRolPct);
    expect(layered.xlRolDefaulted).toBe(false);
  });

  it('mixes stored rates and premium-derived rates limit-weighted in a tower', () => {
    const out = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'Tower',
      layers: [
        { layer_number: 1, attachment: 2_000_000, occurrence_limit: 10_000_000, rol_pct: 18 },
        { layer_number: 2, attachment: 12_000_000, occurrence_limit: 30_000_000, rol_pct: null, premium: 1_500_000 },
      ],
    }]);
    // layer 2 ROL = 100 × 1.5m/30m = 5 → (18×10m + 5×30m)/40m = 8.25
    expect(out.programme.xlRolPct).toBeCloseTo(8.25, 10);
    expect(out.xlRolDefaulted).toBe(false);
  });

  it('an explicitly stored 0% ROL is honoured, not treated as missing', () => {
    const out = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'X',
      attachment: 2_000_000, occurrence_limit: 10_000_000, rol_pct: 0, premium: 500_000,
    }]);
    expect(out.programme.xlRolPct).toBe(0);
    expect(out.xlRolDefaulted).toBe(false);
  });

  it('uses ONE illustrative fallback on both paths and flags it', () => {
    const flat = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'X',
      attachment: 2_000_000, occurrence_limit: 10_000_000,
    }]);
    expect(flat.programme.xlRolPct).toBe(DEFAULT_RETRO_PROGRAMME.xlRolPct);
    expect(flat.xlRolDefaulted).toBe(true);
    const layered = programmeFromStored([{
      programme_type: 'XL_CAT', programme_name: 'X',
      layers: [{ layer_number: 1, attachment: 2_000_000, occurrence_limit: 10_000_000 }],
    }]);
    expect(layered.programme.xlRolPct).toBe(DEFAULT_RETRO_PROGRAMME.xlRolPct);
    expect(layered.xlRolDefaulted).toBe(true);
  });

  it('premium-derived ROL is a rate — untouched by FX conversion and book scaling', () => {
    const out = programmeFromStored(
      [{
        programme_type: 'XL_CAT', programme_name: 'EUR XL', currency_code: 'EUR',
        attachment: 2_000_000, occurrence_limit: 10_000_000, rol_pct: null, premium: 500_000,
        fx_to_subject: 4, fx_missing: false, book_exposure: 320_000_000,
      }],
      { subjectExposure: 80_000_000 },
    );
    expect(out.converted).toBe(true);
    expect(out.scaled).toBe(true);
    expect(out.programme.xlRolPct).toBe(5);               // ratio of raw stored terms
  });
});
