// stopLossPricingState.test.ts — pins the burning-cost input contract of
// buildLayerEngineArgs (finding F19):
//
//   • Every year of the experience window stays in the engine input — a
//     BLANK aggregate is a zero-loss year (aggregate 0), not a missing
//     year. The old `lossRatio != null` filter dropped blank years, so
//     the engine annualised over entered years only and OVERSTATED the
//     burning cost by windowYears / enteredYears (5× in the pinned case),
//     contradicting the module's own documented contract
//     ("Empty aggregates are kept so the burning-cost denominator
//     includes zero-loss years — see annualiseLoss").
//   • A year with an ENTERED aggregate but no EGNPI premium is excluded
//     with an explicit warning (surfaced through priceStopLoss's result),
//     never dropped silently.
//   • When no year has a computable loss ratio, no burning-cost input is
//     emitted (unchanged behaviour: exposure rating prices alone).

import { describe, expect, it } from 'vitest';
import { priceStopLoss } from '../../../../logic/stopLossPricing';
import {
  DEFAULT_INPUTS,
  buildBurningCostRows,
  buildLayerEngineArgs,
  buildSharedEngineArgs,
  buildYearRange,
  buildYearlyRows,
  parseEgnpiRows,
} from './stopLossPricingState';
import type { StopLossInputs, YearAggregateRow } from './stopLossPricingState';

// 5-year window 2020..2024 (UW year 2025).
const NP_DETAIL = { startYear: '2025', experienceStartYear: '2020' };
// Flat EGNPI 10M, no rate changes → on-level factors all 1.
const EGNPI_ROWS = [2020, 2021, 2022, 2023, 2024].map((y) => ({ uw_year: y, egnpi: '10000000' }));
// Layer 50% xs 100% LR on EPI 10M → 5,000,000 xs 10,000,000 absolute.
const LAYER = { attachmentLossRatio: '100', limitLossRatio: '50', epi: '10000000' };

function priceWindow(savedAggregates: YearAggregateRow[], egnpiRows: unknown = EGNPI_ROWS) {
  const yearRange = buildYearRange(NP_DETAIL);
  expect(yearRange).toEqual([2020, 2021, 2022, 2023, 2024]);
  const yearlyRows = buildYearlyRows(yearRange, savedAggregates);
  const premiumData = parseEgnpiRows(egnpiRows);
  const burningCostRows = buildBurningCostRows(yearRange, yearlyRows, premiumData);
  const inputs: StopLossInputs = { ...DEFAULT_INPUTS };
  const shared = buildSharedEngineArgs(inputs);
  const args = buildLayerEngineArgs([LAYER], shared, burningCostRows)[0];
  return { args, result: priceStopLoss(args) };
}

describe('buildLayerEngineArgs — zero-loss years stay in the window', () => {
  it('one 12M aggregate in a 5-year window annualises over 5 years, not 1', () => {
    const { args, result } = priceWindow([{ year: 2020, aggregate: '12000000' }]);

    // All five window years reach the engine; blanks as zero-loss years.
    expect(args.yearlyAggregates).toEqual([
      { year: 2020, aggregate: 12_000_000 }, // LR 1.2 × EPI 10M
      { year: 2021, aggregate: 0 },
      { year: 2022, aggregate: 0 },
      { year: 2023, aggregate: 0 },
      { year: 2024, aggregate: 0 },
    ]);

    // Hand-computed: layer hit = min(12M − 10M, 5M) = 2,000,000 in ONE year
    // of a FIVE-year window → annual loss 2M / 5 = 400,000, ROL = 400,000 /
    // 5,000,000 = 8%. The pre-fix filter kept only the entered year →
    // 2,000,000 annual (40% ROL), a 5× overstatement.
    expect(result.burningCost?.nYears).toBe(5);
    expect(result.burningCost?.annualLoss).toBeCloseTo(400_000, 6);
    expect(result.burningCost?.rol).toBeCloseTo(0.08, 10);
    expect(result.warnings).toEqual([]);
  });

  it('an explicit zero aggregate is also a zero-loss year (kept, no warning)', () => {
    const { args, result } = priceWindow([
      { year: 2020, aggregate: '12000000' },
      { year: 2021, aggregate: '0' },
    ]);
    expect(args.yearlyAggregates).toHaveLength(5);
    expect(result.burningCost?.nYears).toBe(5);
    expect(result.burningCost?.annualLoss).toBeCloseTo(400_000, 6);
    expect(result.warnings).toEqual([]);
  });
});

describe('buildLayerEngineArgs — entered aggregate without a premium', () => {
  it('warns and excludes the year from BOTH numerator and denominator', () => {
    // EGNPI table is missing 2021, but the user entered a 2021 aggregate.
    const egnpiMissing2021 = EGNPI_ROWS.filter((r) => r.uw_year !== 2021);
    const { args, result } = priceWindow(
      [
        { year: 2020, aggregate: '12000000' },
        { year: 2021, aggregate: '3000000' },
      ],
      egnpiMissing2021,
    );

    // 2021 cannot produce a loss ratio → excluded, with a warning; the
    // remaining window (2020 + three zero-loss years) still prices.
    expect(args.yearlyAggregates).toEqual([
      { year: 2020, aggregate: 12_000_000 },
      { year: 2022, aggregate: 0 },
      { year: 2023, aggregate: 0 },
      { year: 2024, aggregate: 0 },
    ]);
    expect(result.burningCost?.nYears).toBe(4);
    expect(result.burningCost?.annualLoss).toBeCloseTo(500_000, 6); // 2M / 4
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/2021/);
    expect(result.warnings[0]).toMatch(/no EGNPI premium/);
  });
});

describe('buildLayerEngineArgs — no computable history', () => {
  it('emits no burning-cost input when every aggregate is blank', () => {
    const { args, result } = priceWindow([]);
    // No entered data → no burning-cost history to price on. (Zero-filling
    // here would drag a spurious 0-burn method into the blend.)
    expect(args.yearlyAggregates).toBeUndefined();
    expect(result.burningCost).toBeNull();
  });
});
