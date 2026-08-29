// exportPricingToExcel.test.js — the Risk/Cat XL layer sheets label the
// Wt Burn / Wt Exp / Loading columns '%', so they must go out as pct()
// strings like their neighbours. Emitting bare numbers let the workbook
// engine's integer numFmt round a 12.5% loading to '13'.

import { describe, expect, it } from 'vitest';
import { buildNpPricingSheets } from './exportPricingToExcel.js';

const sheetByName = (sheets, name) => sheets.find(s => s.name === name);

describe('buildNpPricingSheets — Risk/Cat XL layer sheets', () => {
  const layers = [
    {
      layer: 1, risk: true, limit: '1000000', deductible: '500000',
      riskPureBurn: '2.50%', riskPareto: '0.00%', riskAvgBurnPareto: '2.50%',
      riskExposure: '1.20%', riskWeightBurn: '50', riskWeightExposure: '25',
      riskLoading: '12.5', riskTotalPrice: '4.10%', riskUwPrice: '4.10%',
    },
    {
      layer: 2, cat: true, limit: '2000000', deductible: '1500000',
      catPureBurn: '0.80%', catPareto: '0.00%', catAvgBurnPareto: '0.80%',
      catExposure: '0.50%', catWeightBurn: '50', catWeightExposure: '25',
      catLoading: '12.5', catTotalPrice: '1.40%', catUwPrice: '1.40%',
    },
  ];

  it('emits Wt Burn / Wt Exp / Loading as pct strings (no integer rounding)', () => {
    const sheets = buildNpPricingSheets({ layers });

    const riskRow = sheetByName(sheets, 'Risk XL Layers').aoa[1];
    // Columns: ...,'Wt Burn %','Wt Exp %','Loading %',... at indices 7-9.
    expect(riskRow.slice(7, 10)).toEqual(['50.00%', '25.00%', '12.50%']);
    expect(riskRow[3]).toBe('2.50%');   // neighbours unchanged

    const catRow = sheetByName(sheets, 'Cat XL Layers').aoa[1];
    expect(catRow.slice(7, 10)).toEqual(['50.00%', '25.00%', '12.50%']);
    expect(catRow[3]).toBe('0.80%');
  });
});
