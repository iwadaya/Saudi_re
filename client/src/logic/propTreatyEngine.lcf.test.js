// Pins the loss-carry-forward semantics of makePCCalc against the REAL save
// encoding written by PropTreatyDetail.jsx (handleSave, commissions payload):
//
//   'Extinction' → { lcf_years: null, lcf_extinction: true }
//       deficits carry forward perpetually until absorbed by later profits.
//   'N years'    → { lcf_years: N, lcf_extinction: false }
//       a year-Y deficit can offset profits in years Y+1 .. Y+N, then expires.
//
// Every expectation below is hand-computed:
//   yearProfit = premium - claims - commission - mgmt expenses
//   PC         = max(0, yearProfit - absorbable deficits) x pc%
//
// Regression context: the engine previously read these two flags INVERTED
// (Extinction disabled the carry-forward entirely, and N-years never expired),
// so Extinction treaties overpaid PC and N-years treaties underpaid it.

import { describe, it, expect } from 'vitest';
import { makePCCalc } from './propTreatyEngine';

describe('makePCCalc — Extinction encoding {lcf_years: null, lcf_extinction: true}', () => {
  const t = {
    profit_commission_pct: 20, mgmt_expenses_pct: 0,
    lcf_years: null, lcf_extinction: true, loss_cap_pct: 0,
  };

  it('a prior-year deficit fully absorbs the next profitable year (PC 0, not 100,000)', () => {
    const pc = makePCCalc(t);
    // 2020: 1,000,000 - 1,500,000 = -500,000 -> deficit 500,000, PC 0
    expect(pc(2020, 1_000_000, 1_500_000, 0)).toBe(0);
    // 2021: profit +500,000, entirely absorbed by the 2020 deficit -> PC 0
    // (inverted engine ignored the LCF and paid 500,000 x 20% = 100,000)
    expect(pc(2021, 1_000_000, 500_000, 0)).toBe(0);
    // 2022: profit +500,000, deficit exhausted -> PC = 500,000 x 20% = 100,000
    expect(pc(2022, 1_000_000, 500_000, 0)).toBe(100_000);
  });

  it('deficits never expire — absorbed only by cumulative profits', () => {
    const pc = makePCCalc(t);
    // 2020: 1,000,000 - 2,000,000 = -1,000,000 -> deficit 1,000,000
    expect(pc(2020, 1_000_000, 2_000_000, 0)).toBe(0);
    // 2021..2030: profit 100,000/yr; ten years absorb exactly the 1,000,000
    // deficit -> PC 0 every year, no matter how old the deficit gets.
    for (let y = 2021; y <= 2030; y++) {
      expect(pc(y, 1_000_000, 900_000, 0)).toBe(0);
    }
    // 2031: deficit gone -> PC = 100,000 x 20% = 20,000
    expect(pc(2031, 1_000_000, 900_000, 0)).toBe(20_000);
  });
});

describe('makePCCalc — N-years encoding {lcf_years: N, lcf_extinction: false}', () => {
  const t = {
    profit_commission_pct: 20, mgmt_expenses_pct: 0,
    lcf_years: 2, lcf_extinction: false, loss_cap_pct: 0,
  };

  it('an expired deficit no longer suppresses PC (100,000 in 2027, not 0)', () => {
    const pc = makePCCalc(t);
    // 2020: 1,000,000 - 2,000,000 = -1,000,000 -> deficit 1,000,000, PC 0
    expect(pc(2020, 1_000_000, 2_000_000, 0)).toBe(0);
    // 2027: profit +500,000; the 2020 deficit is 7 years old (> 2) -> expired.
    // PC = 500,000 x 20% = 100,000 (inverted engine carried it forever -> 0).
    expect(pc(2027, 1_000_000, 500_000, 0)).toBe(100_000);
  });

  it('deficit offsets within the N-year window, residual expires at the boundary', () => {
    const pc = makePCCalc(t);
    // 2020: deficit 1,000,000
    expect(pc(2020, 1_000_000, 2_000_000, 0)).toBe(0);
    // 2021 (age 1 <= 2): profit 500,000 absorbed -> deficit 500,000, PC 0
    expect(pc(2021, 1_000_000, 500_000, 0)).toBe(0);
    // 2022 (age 2 <= 2): profit 300,000 absorbed -> deficit 200,000, PC 0
    expect(pc(2022, 1_000_000, 700_000, 0)).toBe(0);
    // 2023 (age 3 > 2): residual 200,000 expires -> full profit pays PC:
    // PC = 500,000 x 20% = 100,000
    expect(pc(2023, 1_000_000, 500_000, 0)).toBe(100_000);
  });

  it('FIFO purge drops only out-of-window deficits, keeping newer ones', () => {
    const pc = makePCCalc(t);
    // 2020: 1,000,000 - 1,400,000 = -400,000 -> deficit(2020) 400,000
    expect(pc(2020, 1_000_000, 1_400_000, 0)).toBe(0);
    // 2021: profit exactly 0 -> PC 0, no new deficit
    expect(pc(2021, 1_000_000, 1_000_000, 0)).toBe(0);
    // 2022: 1,000,000 - 1,300,000 = -300,000 -> deficit(2022) 300,000
    expect(pc(2022, 1_000_000, 1_300_000, 0)).toBe(0);
    // 2023: profit 500,000. deficit(2020) is 3 years old (> 2) -> purged;
    // deficit(2022) is 1 year old -> absorbs 300,000. Remaining 200,000:
    // PC = 200,000 x 20% = 40,000
    expect(pc(2023, 1_000_000, 500_000, 0)).toBe(40_000);
  });
});

describe('makePCCalc — no LCF configured {lcf_years: 0, lcf_extinction: false}', () => {
  it('each profitable year pays PC independently, losses are not carried', () => {
    const t = {
      profit_commission_pct: 20, mgmt_expenses_pct: 0,
      lcf_years: 0, lcf_extinction: false, loss_cap_pct: 0,
    };
    const pc = makePCCalc(t);
    expect(pc(2020, 1_000_000, 1_500_000, 0)).toBe(0);
    // 2021: profit 500,000; prior loss ignored -> PC = 100,000
    expect(pc(2021, 1_000_000, 500_000, 0)).toBe(100_000);
  });
});
