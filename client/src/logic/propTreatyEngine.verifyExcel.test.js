// Verifies propTreatyEngine.js against every scenario in
// quick_summary_verification.xlsx (all six tabs).
//
// Run with: cd client && npx vitest run propTreatyEngine.verifyExcel

import { describe, it, expect } from 'vitest';
import { applyLossCap, calcComm, calcLPC, makePCCalc } from './propTreatyEngine';

const close = (a, b, tol = 0.5) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

// ============== Tab 1: Loss Cap ==============
describe('Tab 1 — applyLossCap @ 120% cap', () => {
  const t = { loss_cap_pct: 120, aal: 0 };
  const PREM = 1_000_000;
  it.each([
    ['LR 50%',   500_000,   500_000],
    ['LR 80%',   800_000,   800_000],
    ['At 120%', 1_200_000, 1_200_000],
    ['Above cap 150%', 1_500_000, 1_200_000],
    ['Above cap 200%', 2_000_000, 1_200_000],
  ])('%s', (_n, raw, expCap) => close(applyLossCap(raw, PREM, t), expCap));
});

// ============== Tab 2: Fixed Commission + Brokerage + Taxes ==============
describe('Tab 2 — Fixed 27.5%, brokerage 1.25%, taxes 5%', () => {
  const t = {
    mode: 'FIXED', fixed_commission_pct: 27.5,
    brokerage_pct: 1.25, taxes_pct: 5, loss_cap_pct: 0,
  };
  const years = [
    { y: 2020, prem: 1_000_000, claims:   650_000, expComm: 275_000, expBrok: 12_500, expTax: 50_000, expMargin:   12_500 },
    { y: 2021, prem: 1_100_000, claims:   800_000, expComm: 302_500, expBrok: 13_750, expTax: 55_000, expMargin:  -71_250 },
    { y: 2022, prem: 1_200_000, claims: 1_050_000, expComm: 330_000, expBrok: 15_000, expTax: 60_000, expMargin: -255_000 },
    { y: 2023, prem: 1_300_000, claims:   780_000, expComm: 357_500, expBrok: 16_250, expTax: 65_000, expMargin:   81_250 },
    { y: 2024, prem: 1_400_000, claims:   910_000, expComm: 385_000, expBrok: 17_500, expTax: 70_000, expMargin:   17_500 },
  ];
  it('per-year commission / brokerage / taxes / margin match', () => {
    let total = 0;
    for (const y of years) {
      const comm = calcComm(y.prem, y.claims, t);
      const brok = y.prem * 0.0125;
      const tax  = y.prem * 0.05;
      const margin = y.prem - applyLossCap(y.claims, y.prem, t) - comm - brok - tax;
      close(comm,   y.expComm);
      close(brok,   y.expBrok);
      close(tax,    y.expTax);
      close(margin, y.expMargin);
      total += margin;
    }
    close(total, -215_000);
  });
});

// ============== Tab 3 — Sliding (band style) ==============
describe('Tab 3A — Sliding band (60%-85% LR, 20%-32.5% comm)', () => {
  const t = {
    mode: 'SLIDING',
    sliding_min_loss_ratio: 60, sliding_max_loss_ratio: 85,
    sliding_min_commission: 20, sliding_max_commission: 32.5,
    sliding_table: [], loss_cap_pct: 0,
  };
  it.each([
    ['LR 40%',     400_000, 325_000],
    ['LR 60%',     600_000, 325_000],
    ['LR 72.5%',   725_000, 262_500],
    ['LR 85%',     850_000, 200_000],
    ['LR 100%', 1_000_000, 200_000],
  ])('%s', (_n, claims, exp) => close(calcComm(1_000_000, claims, t), exp));
});

// ============== Tab 3 — Sliding (table style) ==============
describe('Tab 3B — Sliding table (5 points)', () => {
  const t = {
    mode: 'SLIDING',
    sliding_table: [
      { loss_ratio_pct: 55, commission_pct: 32.5 },
      { loss_ratio_pct: 65, commission_pct: 30 },
      { loss_ratio_pct: 75, commission_pct: 27.5 },
      { loss_ratio_pct: 85, commission_pct: 25 },
      { loss_ratio_pct: 95, commission_pct: 20 },
    ],
    loss_cap_pct: 0,
  };
  it.each([
    ['LR 40%',     400_000, 325_000],
    ['LR 60%',     600_000, 312_500],
    ['LR 70%',     700_000, 287_500],
    ['LR 80%',     800_000, 262_500],
    ['LR 95%',     950_000, 200_000],
    ['LR 110%', 1_100_000, 200_000],
  ])('%s', (_n, claims, exp) => close(calcComm(1_000_000, claims, t), exp));
});

// ============== Tab 4A — LPC single band ==============
describe('Tab 4A — LPC single band (70%-100%, share 50%)', () => {
  const t = {
    lp_enabled: true,
    lp_min_loss_ratio_pct: 70, lp_max_loss_ratio_pct: 100,
    lp_reinsurer_share_pct: 50, lp_slides: [], loss_cap_pct: 0,
  };
  it.each([
    ['LR 60%',    600_000,       0],
    ['LR 70%',    700_000,       0],
    ['LR 85%',    850_000,  75_000],
    ['LR 100%', 1_000_000, 150_000],
    ['LR 120%', 1_200_000, 150_000],
  ])('%s', (_n, claims, expCredit) => close(calcLPC(1_000_000, claims, t), expCredit));
});

// ============== Tab 4B — LPC multi-slide stack ==============
describe('Tab 4B — LPC multi-slide (3 bands)', () => {
  const t = {
    lp_enabled: true,
    lp_slides: [
      { min_lr: 70, max_lr: 80, share: 30 },
      { min_lr: 80, max_lr: 90, share: 50 },
      { min_lr: 90, max_lr: 110, share: 75 },
    ],
    loss_cap_pct: 0,
  };
  it.each([
    ['LR 65%',    650_000,        0],
    ['LR 75%',    750_000,   15_000],
    ['LR 85%',    850_000,   55_000],
    ['LR 95%',    950_000,  117_500],
    ['LR 110%', 1_100_000,  230_000],
    ['LR 130%', 1_300_000,  230_000],
  ])('%s', (_n, claims, expCredit) => close(calcLPC(1_000_000, claims, t), expCredit));
});

// ============== Tab 5 — Profit Commission with perpetual LCF ==============
describe('Tab 5 — makePCCalc with perpetual LCF', () => {
  it('matches every year of the LCF stream', () => {
    const t = {
      profit_commission_pct: 20, mgmt_expenses_pct: 5,
      lcf_years: 999, lcf_extinction: false, loss_cap_pct: 0,
    };
    const COMM = 275_000; // fixed 27.5% of 1M premium
    const pc = makePCCalc(t);
    const stream = [
      { y: 2020, prem: 1e6, claims:   650_000, expPC: 5_000 },
      { y: 2021, prem: 1e6, claims: 1_200_000, expPC:     0 },
      { y: 2022, prem: 1e6, claims:   500_000, expPC:     0 },
      { y: 2023, prem: 1e6, claims:   700_000, expPC:     0 },
      { y: 2024, prem: 1e6, claims:   400_000, expPC:     0 },
      { y: 2025, prem: 1e6, claims: 1_100_000, expPC:     0 },
      { y: 2026, prem: 1e6, claims:   600_000, expPC:     0 },
    ];
    let total = 0;
    for (const s of stream) {
      const got = pc(s.y, s.prem, s.claims, COMM);
      close(got, s.expPC);
      total += got;
    }
    close(total, 5_000);
  });
});

// ============== Tab 6 — Combined Quick Summary ==============
describe('Tab 6 — Combined Quick Summary (FIXED + LPC band + PC LCF)', () => {
  const t = {
    mode: 'FIXED', fixed_commission_pct: 27.5,
    brokerage_pct: 1.25, taxes_pct: 5, loss_cap_pct: 0,
    profit_commission_pct: 20, mgmt_expenses_pct: 5,
    lcf_years: 999, lcf_extinction: false,
    lp_enabled: true,
    lp_min_loss_ratio_pct: 80, lp_max_loss_ratio_pct: 120,
    lp_reinsurer_share_pct: 50, lp_slides: [],
  };
  const years = [
    { y: 2020, prem: 1_200_000, claims:   700_000, expComm: 330_000, expBrok: 15_000, expTax: 60_000, expLPC:       0, expPC: 22_000, expMargin:   73_000 },
    { y: 2021, prem: 1_300_000, claims:   950_000, expComm: 357_500, expBrok: 16_250, expTax: 65_000, expLPC:       0, expPC:      0, expMargin:  -88_750 },
    { y: 2022, prem: 1_400_000, claims: 1_500_000, expComm: 385_000, expBrok: 17_500, expTax: 70_000, expLPC: 190_000, expPC:      0, expMargin: -382_500 },
    { y: 2023, prem: 1_500_000, claims:   900_000, expComm: 412_500, expBrok: 18_750, expTax: 75_000, expLPC:       0, expPC:      0, expMargin:   93_750 },
    { y: 2024, prem: 1_600_000, claims: 1_100_000, expComm: 440_000, expBrok: 20_000, expTax: 80_000, expLPC:       0, expPC:      0, expMargin:  -40_000 },
  ];

  it('per-year commission, brokerage, taxes, LPC, PC, margin', () => {
    const pcFn = makePCCalc(t);
    let totMargin = 0, totPC = 0, totPrem = 0, totClaims = 0;
    for (const y of years) {
      const capped = applyLossCap(y.claims, y.prem, t);
      const comm = calcComm(y.prem, y.claims, t);
      const brok = y.prem * 0.0125;
      const tax  = y.prem * 0.05;
      const lpc  = calcLPC(y.prem, y.claims, t);
      const pcPaid = pcFn(y.y, y.prem, y.claims, comm);
      const margin = y.prem - capped - comm - brok - tax - pcPaid + lpc;

      close(comm,   y.expComm);
      close(brok,   y.expBrok);
      close(tax,    y.expTax);
      close(lpc,    y.expLPC);
      close(pcPaid, y.expPC);
      close(margin, y.expMargin);

      totMargin += margin; totPC += pcPaid; totPrem += y.prem; totClaims += capped;
    }
    close(totMargin, -344_500);
    close(totPC,       22_000);
    close(totClaims / totPrem, 0.735714, 1e-3);
    close(totMargin / totPrem, -0.049214, 1e-3);
  });
});
