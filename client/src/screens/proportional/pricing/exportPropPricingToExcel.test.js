// exportPropPricingToExcel.test.js — the Pricing Components sheet must
// re-emit the grid's already-percent strings without rescaling (a '63.40%'
// cell previously exported as '6340.00%') and must read the grid's 'actual'
// key (propPricingHydration maps actual_stats_value → 'actual', so the old
// c.actual_stats read left the Actual Stats column permanently '–').

import { describe, expect, it } from 'vitest';
import { buildPropPricingSheets } from './exportPropPricingToExcel.js';

const sheetByName = (sheets, name) => sheets.find(s => s.name === name);

describe('buildPropPricingSheets — Pricing Components sheet', () => {
  it('does not rescale already-percent grid strings and reads the actual key', () => {
    const sheets = buildPropPricingSheets({
      components: {
        'Attritional Loss Ratio': { actuarial: '63.40%', uw: '35', market: '41.00%', actual: '33.33%' },
        Taxes: { actuarial: '1.00%', uw: '', market: '', actual: '1.00%' },
      },
    });
    const aoa = sheetByName(sheets, 'Pricing Components').aoa;
    expect(aoa[0]).toEqual(['Component', 'Actuarial', 'UW', 'Market', 'Actual Stats']);

    const attr = aoa.find(r => r[0] === 'Attritional Loss Ratio');
    // '63.40%' stays 63.40%; a bare '35' typed in the UW column means 35%
    // (same parsePct convention as the screen); 'actual' populates the
    // Actual Stats column.
    expect(attr).toEqual(['Attritional Loss Ratio', '63.40%', '35.00%', '41.00%', '33.33%']);

    // A thin 1% row must NOT come out as 100.00%.
    const taxes = aoa.find(r => r[0] === 'Taxes');
    expect(taxes).toEqual(['Taxes', '1.00%', '–', '–', '1.00%']);
  });

  it('formats a fractional techResult as a percent', () => {
    const sheets = buildPropPricingSheets({ components: {}, techResult: 0.0863 });
    const aoa = sheetByName(sheets, 'Pricing Components').aoa;
    const tr = aoa.find(r => r[0] === 'Technical Result');
    expect(tr).toEqual(['Technical Result', '8.63%', '', '', '']);
  });
});
