// goldenMaster.test.jsx — Phase 4.1 safety net for the NpFinalPricing
// decomposition (docs/frontend-hardening.md).
//
// Renders the screen against the canonical bind-path fixture and pins
// EVERY computed numeric output to explicit literal values captured from
// the pre-refactor screen: per-layer table cells (premiums, ROL/rate,
// reinstatement labels, burning cost / pareto / exposure / blended
// prices, probabilities), FQ summary totals, component totals, hero
// figures, and the exact relational save payload.
//
// RULE: these expectations may NEVER be edited as part of a refactor.
// If a refactor makes one of these assertions fail, the refactor changed
// pricing behaviour — fix the refactor, not the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import NpFinalPricing from './NpFinalPricing.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock, npTreatySnapshot } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function renderScreen({ quoteMode = false } = {}) {
  return renderBindScreen(<NpFinalPricing />, {
    route: quoteMode ? '/np/final-quote' : '/np/final-pricing',
    contractId: quoteMode ? bindIds.quote : bindIds.contract,
    quoteMode,
    appState: {
      wizardMode: 'NP',
      npTreatyDetail: {
        contractId: quoteMode ? bindIds.quote : bindIds.contract,
        cedant: 'Audit Cedant',
        cedantName: 'Audit Cedant',
        countryName: 'Saudi Arabia',
        currencyCode: 'SAR',
        classIds: [bindIds.cobMotor, bindIds.cobProperty],
        classOfBusinessIds: [bindIds.cobMotor, bindIds.cobProperty],
        lineOfBusinessLabels: ['Motor', 'Property'],
        xlType: 'RISK',
        numberOfLayers: 2,
        deductible: 100000,
        brokeragePct: 7,
        estGnpi: 1500000,
        taxesPct: 2,
      },
      npStructureLayers: npTreatySnapshot.terms.np_structure.layers,
    },
  });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { resetApi(); });

// Serialize a table into a cell matrix. Inputs render as "[value]"
// (checkboxes as "[x]"/"[ ]"), static cells as trimmed text — so the
// expected literals below pin both the value AND whether the cell is
// an editable input.
const rowsOf = (table) => Array.from(table.querySelectorAll('tr')).map((tr) =>
  Array.from(tr.querySelectorAll('th,td')).map((cell) => {
    const input = cell.querySelector('input');
    if (input) return input.type === 'checkbox' ? `[${input.checked ? 'x' : ' '}]` : `[${input.value}]`;
    const select = cell.querySelector('select');
    if (select) return `[${select.value}]`;
    return (cell.textContent || '').trim();
  }));

const settleTreatyMode = async (container) => {
  expect(await screen.findByText(/Risk XL Layers/i)).toBeInTheDocument();
  // Auto-column chain settled: reinsurer ROL derived from the component
  // UW prices (2.80% risk + 1.11% cat = 3.91%).
  await waitFor(() => {
    expect(container.querySelector('.np-mini-input--reinsurer').value).toBe('3.91%');
  });
};

describe('NpFinalPricing golden master (treaty mode)', () => {
  it('renders the exact hero figures', async () => {
    const { container } = renderScreen();
    await settleTreatyMode(container);

    expect(container.querySelector('.bbg-hero').textContent).toBe(
      'RISK & CAT XLCEDANT Audit CedantCOUNTRY Saudi ArabiaCOB Motor, PropertyCCY SARUW YEAR —DRAFT' +
      '▸ Structure MetricsLayers2Total Earned PremSAR 1,550,000Total ROL103.33%COST STRUCTUREBrokerage7%' +
      'Est. GNPI · 100% TreatySAR1,500,000Total LimitSAR 1,500,000Treaty TypeRISK & CAT XLXL TypeRISKAcctg Method—Layers2TOTAL ROL103.33%' +
      '▸ Layer StructureRISK XLLayers2DeductibleSAR 100,000Total LimitSAR 1,500,000CAT XLLayers1DeductibleSAR 100,000Total LimitSAR 500,000',
    );
  });

  it('renders the exact Risk XL / Cat XL component tables', async () => {
    const { container } = renderScreen();
    await settleTreatyMode(container);

    const tables = container.querySelectorAll('.np-final-wide-table--layers');
    expect(rowsOf(tables[0])).toEqual([
      ['Layer', 'Limit', 'Deductible', 'Pure Burn', 'Pareto', 'Burn + Pareto', 'ExposureMBBEFD', 'Wt Burn %', 'Wt Pareto %', 'Wt Exp %', 'Loading %', 'Total ROL', 'UW Price', 'Prob. Attachment', 'Prob. Exhaustion'],
      ['L1', '500,000', '100,000', '[1.00%]', '[2.00%]', '1.50%', '[4.00%]', '[40]', '[10]', '50', '[7]', '2.80%', '[2.80%]', '[0.00%]', '[0.00%]'],
      ['TOTAL', '500,000', '', '1.00%', '2.00%', '1.50%', '4.00%', '40', '10', '50', '7', '2.80%', '2.80%', '', ''],
    ]);
    expect(rowsOf(tables[1])).toEqual([
      ['Layer', 'Limit', 'Deductible', 'Pure Burn', 'Pareto', 'Burn + Pareto', 'ExposureDmg Ratio', 'Wt Burn %', 'Wt Pareto %', 'Wt Exp %', 'Loading %', 'Total ROL', 'UW Price', 'Prob. Attachment', 'Prob. Exhaustion'],
      ['L1', '500,000', '100,000', '[0.50%]', '[0.60%]', '0.55%', '[1.50%]', '[50]', '[0]', '50', '[10]', '1.11%', '[1.11%]', '[0.00%]', '[0.00%]'],
      ['TOTAL', '500,000', '', '0.50%', '0.60%', '0.55%', '1.50%', '50', '0', '50', '10', '1.11%', '1.11%', '', ''],
    ]);
  });

  it('renders the exact combined pricing table (reinsurer/lead/expiring/margins)', async () => {
    const { container } = renderScreen();
    await settleTreatyMode(container);

    expect(rowsOf(container.querySelector('.np-final-table--pricing'))).toEqual([
      ['Layer', 'Limit', 'Deductible', 'Reinstatements', 'Reinsurer', 'Lead', 'Expiring', 'Hist. Margin', 'Margin', 'Tech Ratio', '% Diff'],
      ['L1', '500,000', '100,000', '–', '[3.91%]', '[10.00%]', '[9.00%]', '–', '56.56%', '–', '-60.90%'],
      ['TOTAL', '500,000', '', '', '3.91%', '10.00%', '9.00%', '–', '56.56%', '–', '-60.90%'],
    ]);
  });

  it('derives the exact programme-limit money figures from a 10% share', async () => {
    const { container } = renderScreen();
    await settleTreatyMode(container);

    const progTable = container.querySelector('.np-final-wide-table--programme');
    expect(rowsOf(progTable)).toEqual([
      ['Layer', 'Share', 'Premium', 'Per Risk Limit', 'Cat Limit', 'Cedant Total Limit', 'Agg Contribution', 'Total Country Agg', 'Annual Aggregate Limit', 'Expected Shortfall'],
      ['L1', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]'],
      ['Total', '', '–', '–', '–', '–', '', '', '–', ''],
    ]);

    const shareInput = progTable.querySelector('input.np-mini-input--center:not([readonly])');
    fireEvent.change(shareInput, { target: { value: '10' } });
    expect(rowsOf(container.querySelector('.np-final-wide-table--programme'))).toEqual([
      ['Layer', 'Share', 'Premium', 'Per Risk Limit', 'Cat Limit', 'Cedant Total Limit', 'Agg Contribution', 'Total Country Agg', 'Annual Aggregate Limit', 'Expected Shortfall'],
      ['L1', '[10%]', '[90,000]', '[50,000]', '[50,000]', '[]', '[]', '[]', '[50,000]', '[1,955]'],
      ['Total', '', '90,000', '50,000', '50,000', '–', '', '', '50,000', ''],
    ]);
  });

  it('computes the exact offer-modal economics (premium, ROL, AI line, scores)', async () => {
    const { container } = renderScreen();
    await settleTreatyMode(container);

    fireEvent.click(screen.getByRole('button', { name: /Offer Treaty/i }));
    const offModal = container.querySelector('.off-modal');
    expect(offModal.querySelector('.off-ai').textContent).toBe(
      '✦ AI Suggested Line SizeApply to all →10.0%Run pricing engine to generate suggestion.Avg ROL8.50%Tech Ratio—Margin—',
    );
    expect(offModal.querySelector('.off-hm-scores').textContent).toBe(
      'Premium Score 0/100Margin Score 40/100Classification Balanced',
    );
    expect(rowsOf(offModal.querySelector('.off-card table'))).toEqual([
      ['Layer', 'Written %', 'Limit', 'Premium', 'ROL %', 'Tech Ratio', '✦ AI Lineapply all', 'Signed %unlocks on approval'],
      ['L1', '[]', '500,000', '42,500', '8.50%', '—', '10.0% →', '[]'],
    ]);
  });

  it('auto-computes the exact technical-analysis treaty metrics', async () => {
    const { container } = renderScreen();
    await settleTreatyMode(container);

    fireEvent.click(screen.getByRole('button', { name: /Technical Analysis/i }));
    await waitFor(() => expect(container.querySelector('.screen-modal[role="dialog"]')).toBeTruthy());
    const techModal = container.querySelector('.screen-modal[role="dialog"]');
    await waitFor(() => {
      expect(rowsOf(techModal.querySelector('table'))).toEqual([
        ['Metric', 'Previous Year', 'Current Year', '% Change'],
        ['Deductible as % of Cover', '[22.50%]', '[6.67%]', '-70.4%'],
        ['Deductible as % EGNPI', '[11.25%]', '[6.67%]', '-40.7%'],
        ['% Change EGNPI', '[800,000]', '[1,500,000]', '+87.5%'],
        ['% Change Aggregates', '[500,000]', '[]', '—'],
        ['% Change in Rates', '[87.5000%]', '[103.3333%]', '+18.1%'],
        ['% Change in Risk Profile', '[175.0000%]', '[103.3333%]', '-41.0%'],
        ['EGNPI', '[800,000]', '[1,500,000]', '+87.5%'],
      ]);
    });
  });

  it('persists the exact relational pricing payload on save', async () => {
    const { container } = renderScreen();
    await settleTreatyMode(container);

    fireEvent.click(container.querySelector('.bbg-btn--save'));
    await waitFor(() => expect(apiMock.saveNpPricing).toHaveBeenCalled());
    const [, payload] = apiMock.saveNpPricing.mock.calls.at(-1);
    expect(payload.inputs).toEqual({
      burn_weight_pct: '40',
      exposure_weight_pct: '50',
      pareto_weight_pct: '10',
      pricing_loading_pct: '7',
    });
    expect(payload.layer_inputs).toEqual([{ layer_number: 1, expiring_pricing_pct: '9.00%' }]);
    expect(payload.outputs).toEqual([
      {
        layer_number: 1, section: 'RISK',
        pure_burning_cost: '1.00%', pareto_pricing: '2.00%',
        burn_plus_pareto: '1.50%', exposure_rating: '4.00%',
        burn_weight_pct: '40', exposure_weight_pct: '50',
        pareto_weight_pct: '10',
        pricing_loading_pct: '7', total_price: '2.80%',
        prob_attach: '', prob_exhaust: '',
      },
      {
        layer_number: 1, section: 'CAT',
        pure_burning_cost: '0.50%', pareto_pricing: '0.60%',
        burn_plus_pareto: '0.55%', exposure_rating: '1.50%',
        burn_weight_pct: '50', exposure_weight_pct: '50',
        pareto_weight_pct: '0',
        pricing_loading_pct: '10', total_price: '1.11%',
        prob_attach: '', prob_exhaust: '',
      },
    ]);
    expect(payload.layer_margins).toEqual([
      {
        layer_number: 1,
        hist_margin: null,
        modelled_margin: 56.56,
        tech_ratio: null,
        uw_price: 3.91,
        expiring_price: 9,
        lead_price: 10,
      },
    ]);

    await waitFor(() => expect(apiMock.saveNonPropTreaty).toHaveBeenCalled());
    const [, treatyPayload] = apiMock.saveNonPropTreaty.mock.calls.at(-1);
    expect(treatyPayload.terms.np_final_pricing.layers[0]).toMatchObject({
      layer: 'L1',
      limit: '500000',
      deductible: '100000',
      risk: true,
      cat: true,
      riskPureBurn: '1.00%',
      riskPareto: '2.00%',
      riskAvgBurnPareto: '1.50%',
      riskExposure: '4.00%',
      riskTotalPrice: '2.80%',
      riskUwPrice: '2.80%',
      catPureBurn: '0.50%',
      catPareto: '0.60%',
      catAvgBurnPareto: '0.55%',
      catExposure: '1.50%',
      catTotalPrice: '1.11%',
      catUwPrice: '1.11%',
      totalPrice: '3.91%',
      uwPrice: '8.50%',
      reinsurerPricing: '3.91%',
      leadPricing: '10.00%',
      expiringPricing: '9.00%',
      reinsurerMargin: '56.56%',
    });
  });
});

describe('NpFinalPricing golden master (quote mode)', () => {
  const settleQuoteMode = async () => {
    expect(await screen.findByText(/Quote Pricing/i)).toBeInTheDocument();
    expect(await screen.findByText(/Expiring Structure/i)).toBeInTheDocument();
    // Expiring layers hydrated from the server snapshot (3 scaffold rows
    // collapse to the single relational row).
    await waitFor(() => {
      const expCard = screen.getByText(/Expiring Structure/i).closest('section');
      expect(expCard.querySelectorAll('tbody tr').length).toBe(1);
    });
  };

  it('hydrates the expiring structure with the exact derived pricing', async () => {
    const { container } = renderScreen({ quoteMode: true });
    await settleQuoteMode();

    expect(container.querySelector('.bm-curve-badge').textContent).toBe(
      'Market default (a=0.108, b=-1.074)a=0.10800b=-1.0740Add >=2 expiring layers with rates to calibrate',
    );
    const expCard = screen.getByText(/Expiring Structure/i).closest('section');
    expect(rowsOf(expCard.querySelector('table'))).toEqual([
      ['#', 'Limit', 'Attachment', 'EGNPI', 'Rate %', 'ROL %', 'Premium', 'MDP', 'Reinst.', 'Geomean', 'x=G/E', 'Risk', 'Cat'],
      ['1', '[400,000]', '[90,000]', '[800,000]', '[4%]', '8.00%', '32,000', '[5000]', '[1]', '210,000', '0.2625', '[x]', '[ ]'],
      ['TOTAL', '400,000', '90,000', '800,000', '4.00%', '8.00%', '32,000', '', '', '', '', '', ''],
    ]);
  });

  it('prices a new structure layer on the implied curve with exact figures', async () => {
    renderScreen({ quoteMode: true });
    await settleQuoteMode();

    fireEvent.click(screen.getByRole('button', { name: /\+ Add Structure/i }));
    const structure = (await screen.findByText(/^Structure 1$/i)).closest('section');
    const cells = structure.querySelectorAll('input.bm-cell');
    fireEvent.change(cells[0], { target: { value: '750000' } });
    fireEvent.change(cells[1], { target: { value: '100000' } });
    // Limit + attachment auto-fill EGNPI from the curve baseEgnpi (1.5M) and
    // price the layer on the implied curve (market default a=0.108, b=-1.074).
    await waitFor(() => {
      const priced = screen.getByText(/^Structure 1$/i).closest('section').querySelectorAll('input.bm-cell');
      expect(priced[2].value).toBe('1,500,000');
    });

    expect(rowsOf(screen.getByText(/^Structure 1$/i).closest('section').querySelector('table'))).toEqual([
      ['#', 'Limit', 'Attachment', 'EGNPI', 'Geomean', 'x=G/E', 'ROL % ↗', 'Premium ↗', 'Rate % ↗', 'Risk', 'Cat', ''],
      ['1', '[750,000]', '[100,000]', '[1,500,000]', '291,548', '0.1944', '62.73%', '470,445', '31.3630%', '[x]', '[x]', '✕'],
      ['TOTAL', '750,000', '', '1,500,000', '', '', '62.73%', '470,445', '', '', '', ''],
    ]);
  });

  it('splits the exact risk/cat component analysis and totals', async () => {
    const { container } = renderScreen({ quoteMode: true });
    await settleQuoteMode();

    fireEvent.click(screen.getByRole('button', { name: /\+ Add Structure/i }));
    const structure = (await screen.findByText(/^Structure 1$/i)).closest('section');
    const cells = structure.querySelectorAll('input.bm-cell');
    fireEvent.change(cells[0], { target: { value: '750000' } });
    fireEvent.change(cells[1], { target: { value: '100000' } });
    await waitFor(() => {
      const priced = screen.getByText(/^Structure 1$/i).closest('section').querySelectorAll('input.bm-cell');
      expect(priced[2].value).toBe('1,500,000');
    });

    const paButton = Array.from(screen.getByText(/^Structure 1$/i).closest('section').querySelectorAll('button'))
      .find((b) => /^Pricing Analysis$/i.test((b.textContent || '').trim()));
    fireEvent.click(paButton);
    await screen.findByText(/Risk Pricing Analysis/i);
    const paTables = Array.from(container.querySelector('.bm-modal').querySelectorAll('table'));

    // Two header rows (IMPLIED group banner + its Expiring/Country/Region/Global
    // sub-labels) + the single data row + the per-column <tfoot> total. Money cells
    // are bare (no "SAR"); weights are per-row [50]/[0]/[50]; the tfoot sums
    // amounts and limit-weights the rate columns.
    const componentRows = (scope) => [
      ['Layer', 'Active', 'Limit', 'Deductible', 'EGNPI', 'Reinst.', '% Reinst.', 'Pure Burn', 'Pareto', 'Exposure', 'Wt Burn', 'Wt Pareto', 'Wt Exp', 'Blend', 'Implied', 'UW Price', 'P(Attach)', 'P(Exhaust)', 'Note'],
      ['Expiring', 'Country', 'Region', 'Global'],
      ['1', '[x]', '750,000', '100,000', '1,500,000', '[]', '[]', `[${scope}]`, '[0%]', `[${scope}]`, '[50]', '[0]', '[50]', '53.32%', '62.73%', '—', '—', '—', '[62.726%]', '—', '—', '[]'],
      ['TOTAL', '1', '750,000', '—', '1,500,000', '—', '—', '53.32%', '—', '53.32%', '—', '—', '—', '53.32%', '62.73%', '—', '—', '—', '62.73%', '—', '—', '—'],
    ];
    expect(rowsOf(paTables[0])).toEqual(componentRows('53.3171%'));
    expect(rowsOf(paTables[1])).toEqual(componentRows('53.3171%'));
    // Total Section is now a combined PER-LAYER table fusing risk + cat: the
    // single layer is risk+cat active, so UW ROL = risk ROL + cat ROL
    // (62.73% + 62.73% = 125.45%), EP = limit × ROL = 940,890, rate = EP ÷ EGNPI.
    // Limit/EGNPI are counted once per layer (not risk+cat doubled).
    expect(rowsOf(paTables[2])).toEqual([
      ['Layer', 'Limit', 'Deductible', 'Reinstatements', 'EGNPI', 'Rate', 'Earned Premium', 'ROL'],
      ['1', '750,000', '100,000', '—', '1,500,000', '62.73%', '940,890', '125.45%'],
      ['TOTAL', '750,000', '—', '—', '1,500,000', '62.73%', '940,890', '125.45%'],
    ]);
  });
});
