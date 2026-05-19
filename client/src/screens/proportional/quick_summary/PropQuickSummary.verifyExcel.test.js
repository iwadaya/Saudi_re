// Integration test for the Quick Summary screen.
//
// Drives the EXACT pipeline used by PropQuickSummary.jsx:
//   raw contract payload → buildTreatyTerms() → runFinancialEngine()
//                                                    ↓
//                                              per-year rows + totals
//
// Inputs are Tab 6 of quick_summary_verification.xlsx (FIXED 27.5%,
// brokerage 1.25%, taxes 5%, PC 20% with perpetual LCF, LP 80-120% @50%).
// We assert every row + total + the headline KPIs the screen renders.

import { describe, it, expect } from 'vitest';
import { buildTreatyTerms } from '../../../logic/propTreatyEngine';
import { runFinancialEngine } from './PropQuickSummary.jsx';

// Build a contract payload that mirrors the API shape the screen consumes.
// (Field names taken from buildTreatyTerms reading: c.header, c.detail,
// c.commissions, c.lossParticipation.)
function makeContract() {
  return {
    header: { treaty_type_name: 'QUOTA SHARE' },
    detail: {
      brokerage_pct: 1.25,
      taxes_pct: 5,
      loss_cap_pct: 0,
      aal: 0,
    },
    commissions: {
      mode: 'FIXED',
      fixed_commission_qs_pct: 27.5,
      sliding_table: [],
      mgmt_expenses_pct: 5,
      profit_commission_pct: 20,
      lcf_years: 999,
      lcf_extinction: false,
    },
    lossParticipation: {
      enabled: true,
      min_loss_ratio_pct: 80,
      max_loss_ratio_pct: 120,
      reinsurer_share_pct: 50,
      slides: [],
    },
  };
}

const rows = [
  { year: 2020, ultPrem: 1_200_000, ultLoss:   700_000, actPrem: 1_200_000, actLoss:   700_000 },
  { year: 2021, ultPrem: 1_300_000, ultLoss:   950_000, actPrem: 1_300_000, actLoss:   950_000 },
  { year: 2022, ultPrem: 1_400_000, ultLoss: 1_500_000, actPrem: 1_400_000, actLoss: 1_500_000 },
  { year: 2023, ultPrem: 1_500_000, ultLoss:   900_000, actPrem: 1_500_000, actLoss:   900_000 },
  { year: 2024, ultPrem: 1_600_000, ultLoss: 1_100_000, actPrem: 1_600_000, actLoss: 1_100_000 },
];

const expectedByYear = {
  2020: { ultClaims:   700_000, comm: 330_000, brokerage: 15_000, taxes: 60_000, lpc:        0, profitComm: 22_000, result:   73_000 },
  2021: { ultClaims:   950_000, comm: 357_500, brokerage: 16_250, taxes: 65_000, lpc:        0, profitComm:      0, result:  -88_750 },
  2022: { ultClaims: 1_500_000, comm: 385_000, brokerage: 17_500, taxes: 70_000, lpc:  190_000, profitComm:      0, result: -382_500 },
  2023: { ultClaims:   900_000, comm: 412_500, brokerage: 18_750, taxes: 75_000, lpc:        0, profitComm:      0, result:   93_750 },
  2024: { ultClaims: 1_100_000, comm: 440_000, brokerage: 20_000, taxes: 80_000, lpc:        0, profitComm:      0, result:  -40_000 },
};

const close = (a, b, tol = 0.5) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('Quick Summary screen — integration with Tab 6 of the spreadsheet', () => {
  it('buildTreatyTerms maps contract → terms with every field the engine needs', () => {
    const terms = buildTreatyTerms(makeContract(), {});
    // Sanity-check the mapping that the engine relies on
    expect(terms.mode).toBe('FIXED');
    close(terms.fixed_commission_pct, 27.5);
    close(terms.brokerage_pct, 1.25);
    close(terms.taxes_pct, 5);
    close(terms.loss_cap_pct, 0);
    close(terms.mgmt_expenses_pct, 5);
    close(terms.profit_commission_pct, 20);
    close(terms.lcf_years, 999);
    expect(terms.lcf_extinction).toBe(false);
    expect(terms.lp_enabled).toBe(true);
    close(terms.lp_min_loss_ratio_pct, 80);
    close(terms.lp_max_loss_ratio_pct, 120);
    close(terms.lp_reinsurer_share_pct, 50);
    expect(Array.isArray(terms.lp_slides)).toBe(true);
    expect(terms.lp_slides.length).toBe(0);
  });

  it('runFinancialEngine reproduces every Tab 6 row + total + KPI for the Projected column', () => {
    const terms = buildTreatyTerms(makeContract(), {});
    const { rows: out, totals } = runFinancialEngine(rows, terms);

    for (const r of out) {
      const e = expectedByYear[r.year];
      close(r.ultClaims,  e.ultClaims);
      close(r.comm,       e.comm);
      close(r.brokerage,  e.brokerage);
      close(r.taxes,      e.taxes);
      close(r.lpc,        e.lpc);
      close(r.profitComm, e.profitComm);
      close(r.result,     e.result);
    }

    // Totals (Tab 6 row 25)
    close(totals.premium,    7_000_000);
    close(totals.ultClaims,  5_150_000);
    close(totals.comm,       1_925_000);
    close(totals.brokerage,     87_500);
    close(totals.taxes,        350_000);
    close(totals.lpc,          190_000);
    close(totals.profitComm,    22_000);
    close(totals.result,      -344_500);

    // Headline KPIs (Tab 6 cells C28, C29, C30)
    const ulr   = totals.ultClaims / totals.premium;
    const cr    = (totals.ultClaims + totals.comm + totals.brokerage + totals.taxes + totals.profitComm - totals.lpc) / totals.premium;
    const margP = totals.result / totals.premium;
    close(ulr,   0.735714, 1e-3);
    close(cr,    1.049214, 1e-3);
    close(margP, -0.049214, 1e-3);
  });

  it('runFinancialEngine reproduces every Tab 6 row + total for the Actual column', () => {
    // Same inputs on the actual side, so the projected and actual columns
    // both have to land on Tab 6 numbers.
    const terms = buildTreatyTerms(makeContract(), {});
    const { rows: out, totals } = runFinancialEngine(rows, terms);

    for (const r of out) {
      const e = expectedByYear[r.year];
      close(r.actClaims,    e.ultClaims);
      close(r.actComm,      e.comm);
      close(r.actBrokerage, e.brokerage);
      close(r.actTaxes,     e.taxes);
      close(r.actLPC,       e.lpc);
      close(r.actPC,        e.profitComm);
      close(r.actResult,    e.result);
    }

    close(totals.actPremium,    7_000_000);
    close(totals.actClaims,     5_150_000);
    close(totals.actComm,       1_925_000);
    close(totals.actBrokerage,     87_500);
    close(totals.actTaxes,        350_000);
    close(totals.actLPC,          190_000);
    close(totals.actPC,            22_000);
    close(totals.actResult,      -344_500);
  });

  it('handles the contract.loss_participation snake_case alias (alternate API shape)', () => {
    // Some endpoints return loss_participation instead of lossParticipation.
    // The engine accepts either, so verify the mapping holds when only the
    // snake-case key is present.
    const c = makeContract();
    c.loss_participation = c.lossParticipation;
    delete c.lossParticipation;
    const terms = buildTreatyTerms(c, {});
    const { totals } = runFinancialEngine(rows, terms);
    close(totals.result, -344_500);
    close(totals.lpc,     190_000);
  });
});
