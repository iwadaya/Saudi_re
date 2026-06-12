// PropPricing.goldenMaster.test.jsx — Phase-6 money-path coverage AND the
// golden-master safety net for the later Phase-4 decomposition of PropPricing.
//
// The first test renders the screen against a rich, internally consistent
// fixture and pins the EXACT numbers the auto-calc engine produces today in
// every component-table cell (attritional / large / cat loadings, commissions,
// brokerage, taxes across the actuarial / actual / market / UW / downside
// columns), the derived Result and Maximum Commissions rows, and the full
// savePricingComposite payload (including the hidden exposure column, the
// share-scenario auto-fill and the persisted margins). If a decomposition
// changes any of these numbers, these assertions are the tripwire.
//
// Derivation of the pinned values (so future readers can re-derive them):
//   EPI                = 6,000,000 (quota share, td.quotaShareEpi)
//   treaty capacity    = 10,000,000 (detail.qs_limit), event limit = 3,000,000
//   PROJECTED yearly   = 10,000,000 prem / 5,500,000 loss
//   ACTUAL yearly      =  9,000,000 prem / 5,000,000 loss
//   large losses (raw) = 1,200,000 (700k + 500k; one is_selected:false row excluded)
//   cat losses (raw)   =   800,000 (paid 500k + os 300k fallback)
//   strip flag ON      → actuarial attritional = (5.5M − 1.2M − 0.8M) / 10M = 35.00%
//                        actual attritional    = (5.0M − 1.2M − 0.8M) /  9M = 33.33%
//                        actual large = 1.2M/9M = 13.33%, actual cat = 0.8M/9M = 8.89%
//   large Pareto snap  α=2,   xm=500k, n=10, years=5 → layer xm→capacity
//                        = (10/5)·(LEV(10M) − LEV(500k)) = 2·475,000 = 950,000
//                        → 950,000 / 6M = 15.83%
//   cat Pareto snap    α=1.5, xm=1M,   n=4,  years=8 → layer xm→event limit
//                        = (4/8)·(LEV(3M) − LEV(1M)) ≈ 422,649.73 → 7.04%
//   commissions 24%, brokerage 7.5%, taxes 2% (treaty detail terms)
//   market averages     supplied verbatim by api.getMarketAverage
//   downside attritional = max(worstLR, 2.50) → 250.00% (no triangle rows)
//   exposure            = one Y3 band: 4M SI, 2M top, PML 100%
//                        → 4M · G(0.5, c=3) / 6M (MBBEFD)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import PropPricing from './PropPricing.jsx';
import { renderBindScreen, makeHttpError } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock, propContractSnapshot } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function renderScreen({ quoteMode = false } = {}) {
  return renderBindScreen(<PropPricing />, {
    route: '/prop/pricing',
    contractId: bindIds.contract,
    quoteMode,
    appState: {
      wizardMode: 'PROP',
      propTreatyDetail: {
        contractId: bindIds.contract,
        cedantName: 'Audit Cedant',
        countryName: 'Saudi Arabia',
        currencyCode: 'SAR',
        treatyTypeName: 'Quota Share',
        quotaShareEpi: '6000000',
        fixedCommissionQSPct: '24%',
        brokeragePct: '7.5%',
        taxesPct: '2%',
      },
    },
  });
}

// ── Golden-master fixture ────────────────────────────────────────────────────
function goldenMasterOverrides() {
  const contract = JSON.parse(JSON.stringify(propContractSnapshot));
  // Strip large/CAT from the projected basis so all three loss components are
  // exercised independently (attritional + explicit Pareto large/cat loadings).
  contract.detail.strip_large_cat_losses = true;

  return {
    getContract: vi.fn().mockResolvedValue(contract),
    // No saved component rows: every number below must come out of the
    // auto-calc engine, not out of a previously saved grid.
    getPricing: vi.fn().mockResolvedValue({
      outputs: { status: 'DRAFT' },
      components: [],
      share_scenarios: [],
      leads: null,
    }),
    getPricingYearly: vi.fn().mockResolvedValue([
      { uw_year: 2022, ultimate_premium: 4500000, ultimate_loss: 2700000, record_type: 'ACTUAL' },
      { uw_year: 2023, ultimate_premium: 4500000, ultimate_loss: 2300000, record_type: 'ACTUAL' },
      { uw_year: 2024, ultimate_premium: 5000000, ultimate_loss: 2750000, record_type: 'PROJECTED' },
      { uw_year: 2025, ultimate_premium: 5000000, ultimate_loss: 2750000, record_type: 'PROJECTED' },
    ]),
    getLossSelectionLatest: vi.fn((id, lossType) => Promise.resolve(
      lossType === 'large'
        ? { snapshot: { pareto_alpha: 2, pareto_xm: 500000, observation_years: 5, selected_count: 10 } }
        : { snapshot: { pareto_alpha: 1.5, pareto_xm: 1000000, observation_years: 8, selected_count: 4 } },
    )),
    getLargeLosses: vi.fn().mockResolvedValue({
      losses: [
        { uw_year: 2022, incurred: 700000, is_selected: true },
        { uw_year: 2023, incurred: 500000, is_selected: true },
        // Deselected rows must NOT feed the loadings.
        { uw_year: 2023, incurred: 999999, is_selected: false },
      ],
    }),
    getCatLosses: vi.fn().mockResolvedValue({
      // No `incurred` field → the paid + os fallback path is pinned too.
      losses: [{ uw_year: 2022, paid: 500000, os: 300000 }],
    }),
    getContractCobs: vi.fn().mockResolvedValue([
      { class_of_business_id: bindIds.cobProperty, cob_id: bindIds.cobProperty, name: 'Property' },
    ]),
    getRiskProfile: vi.fn().mockResolvedValue({
      profile: { pml_percentage: 100, selected_curve: 'Y3' },
      bands: [{ total_sum_insured: 4000000, to_amt: 2000000 }],
    }),
    getCountry: vi.fn().mockResolvedValue({ id: bindIds.country, name: 'Saudi Arabia', region: 'GCC' }),
    getMarketAverage: vi.fn().mockResolvedValue({
      components: {
        'Attritional Loss Ratio': 0.41,
        'Large Loss Loading': 0.12,
        'Cat Loss Loading': 0.05,
        'Commissions': 0.26,
        'Brokerage': 0.04,
        'Taxes': 0.025,
      },
      tier: 'country',
      contractCount: 7,
    }),
  };
}

// ── Component-table readers ──────────────────────────────────────────────────
// Table column order (PropComponentTable): actuarial, actual, market, uw,
// downside, then the free-text comment input. The exposure column is held in
// state and persisted but not rendered, so it is pinned via the save payload.
const GRID_COLS = ['actuarial', 'actual', 'market', 'uw', 'downside'];

function componentRow(label) {
  const labelCell = screen
    .getAllByText(label)
    .find((el) => el.classList.contains('bbg-td--label'));
  if (!labelCell) throw new Error(`No component row labelled "${label}"`);
  return labelCell.closest('tr');
}

function readEditableRow(label) {
  const inputs = within(componentRow(label)).getAllByRole('textbox');
  return Object.fromEntries(GRID_COLS.map((col, i) => [col, inputs[i].value]));
}

function readCalcRow(label) {
  const spans = componentRow(label).querySelectorAll('.bbg-calc-val');
  return Object.fromEntries(GRID_COLS.map((col, i) => [col, spans[i].textContent]));
}

function uwOverrideInput(label) {
  return within(componentRow(label)).getAllByRole('textbox')[3];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetApi();
});

describe('PropPricing golden master (money path)', () => {
  it('pins every auto-calculated component cell and the saved composite payload', async () => {
    resetApi(goldenMasterOverrides());
    const { container } = renderScreen();

    await screen.findByText(/Component Pricing Comparison/i);
    // Settle: the final auto-calc pass writes the attritional actuarial cell
    // and the market column in the same state update.
    await waitFor(() => {
      expect(readEditableRow('Attritional Loss Ratio').actuarial).toBe('35.00%');
      expect(readEditableRow('Taxes').market).toBe('2.50%');
    });

    // ── Golden grid: every displayed cell, hard-coded ──
    expect(readEditableRow('Attritional Loss Ratio')).toEqual({
      actuarial: '35.00%', actual: '33.33%', market: '41.00%', uw: '35.00%', downside: '250.00%',
    });
    expect(readEditableRow('Large Loss Loading')).toEqual({
      actuarial: '15.83%', actual: '13.33%', market: '12.00%', uw: '15.83%', downside: '15.83%',
    });
    expect(readEditableRow('Cat Loss Loading')).toEqual({
      actuarial: '7.04%', actual: '8.89%', market: '5.00%', uw: '7.04%', downside: '7.04%',
    });
    expect(readEditableRow('Commissions')).toEqual({
      actuarial: '24.00%', actual: '24.00%', market: '26.00%', uw: '24.00%', downside: '24.00%',
    });
    expect(readEditableRow('Brokerage')).toEqual({
      actuarial: '7.50%', actual: '7.50%', market: '4.00%', uw: '7.50%', downside: '7.50%',
    });
    expect(readEditableRow('Taxes')).toEqual({
      actuarial: '2.00%', actual: '2.00%', market: '2.50%', uw: '2.00%', downside: '2.00%',
    });

    // ── Downstream totals: technical result + reinsurer max commission ──
    expect(readCalcRow('Result')).toEqual({
      actuarial: '8.63%', actual: '10.95%', market: '9.50%', uw: '8.63%', downside: '-206.37%',
    });
    expect(readCalcRow('Maximum Commissions (Reinsurer)')).toEqual({
      actuarial: '22.63%', actual: '24.95%', market: '25.50%', uw: '22.63%', downside: '-192.37%',
    });

    // This fixture has real factors/losses — no placeholder or staleness banners.
    expect(screen.queryByText(/placeholder benchmark curves/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Loss selection is outdated/i)).not.toBeInTheDocument();

    // The engine consulted both Pareto snapshots and the market-average API
    // with the treaty's country / treaty-type / COB / region context.
    expect(apiMock.getLossSelectionLatest).toHaveBeenCalledWith(bindIds.contract, 'large');
    expect(apiMock.getLossSelectionLatest).toHaveBeenCalledWith(bindIds.contract, 'cat');
    expect(apiMock.getMarketAverage).toHaveBeenCalledWith(
      bindIds.country,
      bindIds.contract,
      { treatyTypeId: 'treaty-qs', cobIds: [bindIds.cobProperty], region: 'GCC' },
    );

    // ── Share-scenario auto-fill: the 100% row's Max Downside is derived from
    //    the downside combined ratio (3.0637) × EPI. Wait for the share-grid
    //    effect (it lands one effect cycle after the component grid) ──
    await waitFor(() => {
      expect(document.querySelector('input.bbg-inp--downside')).toHaveValue('-12,382,200');
    });
    // The fractional share rows scale off the 100% row: 1% of -12,382,200.
    expect(document.querySelectorAll('.bbg-ro-val--downside')[0]).toHaveTextContent('-123,822');

    // ── Save: the composite payload pins the same numbers plus the hidden
    //    exposure column, margins, EPI and the share-scenario auto-fill ──
    fireEvent.click(container.querySelector('.bbg-btn--save'));
    await waitFor(() => expect(apiMock.savePricingComposite).toHaveBeenCalledTimes(1));

    const [payload, opts] = apiMock.savePricingComposite.mock.calls[0];
    expect(opts).toEqual({ ifUnmodifiedSince: '2026-05-01T10:00:00.000Z' });
    expect(payload.contract_id).toBe(bindIds.contract);

    expect(payload.components).toEqual([
      { component_name: 'Attritional Loss Ratio', actuarial_value: '35.00%', uw_value: '35.00%', market_value: '41.00%', actual_stats_value: '33.33%', exposure_value: '52.34%', comment: '' },
      { component_name: 'Large Loss Loading', actuarial_value: '15.83%', uw_value: '15.83%', market_value: '12.00%', actual_stats_value: '13.33%', exposure_value: '15.83%', comment: '' },
      { component_name: 'Cat Loss Loading', actuarial_value: '7.04%', uw_value: '7.04%', market_value: '5.00%', actual_stats_value: '8.89%', exposure_value: '7.04%', comment: '' },
      { component_name: 'Commissions', actuarial_value: '24.00%', uw_value: '24.00%', market_value: '26.00%', actual_stats_value: '24.00%', exposure_value: '24.00%', comment: '' },
      { component_name: 'Brokerage', actuarial_value: '7.50%', uw_value: '7.50%', market_value: '4.00%', actual_stats_value: '7.50%', exposure_value: '7.50%', comment: '' },
      { component_name: 'Taxes', actuarial_value: '2.00%', uw_value: '2.00%', market_value: '2.50%', actual_stats_value: '2.00%', exposure_value: '2.00%', comment: '' },
      // Result + Maximum Commissions are derived rows — persisted empty.
      { component_name: 'Result', actuarial_value: '', uw_value: '', market_value: '', actual_stats_value: '', exposure_value: '', comment: '' },
      { component_name: 'Maximum Commissions (Reinsurer)', actuarial_value: '', uw_value: '', market_value: '', actual_stats_value: '', exposure_value: '', comment: '' },
    ]);

    expect(payload.outputs).toMatchObject({ status: 'DRAFT', epi: 6000000 });
    expect(payload.outputs.actuarial_margin).toBeCloseTo(0.0863, 10);
    expect(payload.outputs.actual_margin).toBeCloseTo(0.1095, 10);
    expect(payload.outputs.uw_margin).toBeCloseTo(0.0863, 10);

    expect(payload.share_scenarios).toEqual([
      { share_label: '1%' },
      { share_label: '2.5%' },
      { share_label: '5%' },
      {
        share_label: '100%',
        limit_amt: '10000000',
        premium_amt: '6000000',
        event_limit: '3000000',
        cedant_limit: '20000000',
        downside_amt: '-12382200',
        shortfall_amt: '0',
      },
    ]);
  });

  it('save lifecycle: dirty indicator, optimistic-lock token, and token rotation', async () => {
    apiMock.savePricingComposite.mockResolvedValue({ ok: true, updated_at: '2026-05-02T08:00:00.000Z' });
    const { container } = renderScreen();

    await screen.findByText(/Component Pricing Comparison/i);
    // Settle the auto-calc before editing so the UW re-seed can't race the edit.
    await waitFor(() => expect(readEditableRow('Attritional Loss Ratio').actuarial).toBe('55.00%'));

    const saveBtn = container.querySelector('.bbg-btn--save');
    expect(saveBtn).not.toHaveClass('bbg-btn--dirty');

    fireEvent.change(uwOverrideInput('Commissions'), { target: { value: '26.00%' } });
    expect(saveBtn).toHaveClass('bbg-btn--dirty');

    fireEvent.click(saveBtn);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(saveBtn).not.toHaveClass('bbg-btn--dirty');

    expect(apiMock.savePricingComposite).toHaveBeenCalledTimes(1);
    const [payload, opts] = apiMock.savePricingComposite.mock.calls[0];
    expect(payload.components.find((c) => c.component_name === 'Commissions').uw_value).toBe('26.00%');
    // The optimistic-lock token is the contract bundle's updated_at.
    expect(opts).toEqual({ ifUnmodifiedSince: '2026-05-01T10:00:00.000Z' });

    // A second save must ride the rotated token from the first save's response.
    fireEvent.click(saveBtn);
    await waitFor(() => expect(apiMock.savePricingComposite).toHaveBeenCalledTimes(2));
    expect(apiMock.savePricingComposite.mock.calls[1][1]).toEqual({ ifUnmodifiedSince: '2026-05-02T08:00:00.000Z' });
    expect(apiMock.savePricingComposite.mock.calls[1][0].components.find((c) => c.component_name === 'Commissions').uw_value).toBe('26.00%');
  });

  it('412 STALE_WRITE: surfaces the concurrent-edit modal; refresh abandons without a blind retry', async () => {
    apiMock.savePricingComposite.mockRejectedValueOnce(makeHttpError({
      status: 412,
      code: 'STALE_WRITE',
      message: 'Stale write',
      body: { current: '2026-05-01T12:00:00.000Z', expected: '2026-05-01T10:00:00.000Z' },
    }));
    const { container } = renderScreen();

    await screen.findByText(/Component Pricing Comparison/i);
    await waitFor(() => expect(readEditableRow('Attritional Loss Ratio').actuarial).toBe('55.00%'));
    fireEvent.click(container.querySelector('.bbg-btn--save'));

    const dialog = await screen.findByRole('dialog', { name: /concurrent edit detected/i });
    expect(dialog).toHaveTextContent(/Your colleague saved this pricing at/i);
    const refreshBtn = within(dialog).getByRole('button', { name: /refresh and lose my changes/i });
    expect(within(dialog).getByRole('button', { name: /save anyway, overwriting theirs/i })).toBeInTheDocument();

    // The failed attempt still carried the original optimistic-lock token.
    expect(apiMock.savePricingComposite).toHaveBeenCalledTimes(1);
    expect(apiMock.savePricingComposite.mock.calls[0][1]).toEqual({ ifUnmodifiedSince: '2026-05-01T10:00:00.000Z' });

    fireEvent.click(refreshBtn);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /concurrent edit detected/i })).not.toBeInTheDocument());

    // Refresh must NOT replay the save (no silent overwrite) and must not
    // report a phantom success.
    expect(apiMock.savePricingComposite).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('422 PRICING_DRIFT: surfaces the formatted drift message and keeps the screen dirty', async () => {
    apiMock.savePricingComposite.mockRejectedValueOnce(makeHttpError({
      status: 422,
      code: 'PRICING_DRIFT',
      message: 'Pricing outputs failed server-side spot check',
      body: {
        requestId: 'req-prop-pricing-drift',
        drifts: [
          { layer_number: 1, section: 'RISK', fieldName: 'total_price', clientValue: 3.66, expectedValue: 3.7, reason: 'recompute mismatch' },
          { layer_number: 2, section: 'CAT', fieldName: 'total_price', clientValue: 1.14, expectedValue: 1.2, reason: 'recompute mismatch' },
        ],
      },
    }));
    const { container } = renderScreen();

    await screen.findByText(/Component Pricing Comparison/i);
    await waitFor(() => expect(readEditableRow('Attritional Loss Ratio').actuarial).toBe('55.00%'));

    const saveBtn = container.querySelector('.bbg-btn--save');
    fireEvent.change(uwOverrideInput('Taxes'), { target: { value: '3.00%' } });
    expect(saveBtn).toHaveClass('bbg-btn--dirty');
    fireEvent.click(saveBtn);

    // formatPricingDriftMessage: "<error>: <n> drifts found. Request <id>."
    const msg = await screen.findByText(
      'Pricing outputs failed server-side spot check: 2 drifts found. Request req-prop-pricing-drift.',
    );
    expect(msg).toHaveClass('bbg-msg--err');

    // A drift rejection is a failed save: exactly one attempt, edits stay dirty.
    expect(apiMock.savePricingComposite).toHaveBeenCalledTimes(1);
    expect(saveBtn).toHaveClass('bbg-btn--dirty');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
