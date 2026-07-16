// goldenMaster.test.jsx — Golden master for DevFactorsScreen.
//
// Captures the EXACT computed output of the development-factor selection
// math (LDF/CDF chains under weighted / simple / last-N averages, link-ratio
// exclusions, chosen-factor editing, Bornhuetter-Ferguson loss + premium
// projections, Munich chain ladder, stripped-basis conservative reference,
// benchmark comparison axes, and both save payloads) as literal values
// BEFORE the Phase 4.2 decomposition. Every expectation below was verified
// against the pre-refactor screen; the refactor must keep them
// byte-identical.
//
// Fixture note: the triangle deliberately has VARIED link ratios per origin
// year (unlike DevFactorsScreen.test.jsx's uniform-1.2 triangle) so that
// weighted, simple and last-3 averages all produce DIFFERENT pinned numbers
// and a single excluded ratio visibly moves the weighted factor.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DevFactorsScreen from './DevFactorsScreen.jsx';

const { apiMock, appStateMock, contractIdRef } = vi.hoisted(() => ({
  apiMock: {
    getTriangle: vi.fn(),
    getTriangleWithExclusions: vi.fn(),
    getDevFactors: vi.fn(),
    getDevFactorStaleness: vi.fn(),
    getPricingPattern: vi.fn(),
    getBenchmarks: vi.fn(),
    saveDevFactors: vi.fn(),
    savePricingPattern: vi.fn(),
    setStripLargeCat: vi.fn(),
  },
  appStateMock: {
    quoteMode: false,
    propTreatyDetail: {},
    triangleMeta: { startYear: 2021, renewalYear: 2026 },
  },
  contractIdRef: { current: 'contract-1' },
}));

vi.mock('../../../api', () => ({ __esModule: true, default: apiMock, api: apiMock }));
vi.mock('../../../hooks/useContractId', () => ({ useContractId: () => contractIdRef.current }));
vi.mock('../../../context/AppContext', () => ({ useAppState: () => ({ state: appStateMock, setSlice: vi.fn(), replaceSlice: vi.fn() }) }));
vi.mock('../../../components/WizardLayout', () => ({
  default: ({ children }) => (
    <section>
      {typeof children === 'function' ? children({ showToast: () => {} }) : children}
    </section>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ZERO_EXCLUSIONS = { largeLossCount: 0, catLossCount: 0, applies: false, proxyPlaced: 0 };

beforeEach(() => {
  contractIdRef.current = 'contract-1';
  appStateMock.quoteMode = false;
  appStateMock.propTreatyDetail = {};
  appStateMock.triangleMeta = { startYear: 2021, renewalYear: 2026 }; // numDevYears = 5
  apiMock.getTriangle.mockResolvedValue({ cells: [] });
  apiMock.getTriangleWithExclusions.mockResolvedValue({
    full: { cells: [] }, stripped: { cells: [] }, exclusions: ZERO_EXCLUSIONS,
  });
  apiMock.getDevFactors.mockResolvedValue([]);
  apiMock.getDevFactorStaleness.mockResolvedValue({
    triangleUpdatedAt: '2026-01-01T00:00:00Z', factorsSavedAt: '2026-01-02T00:00:00Z', stale: false,
  });
  apiMock.getPricingPattern.mockResolvedValue(null);
  apiMock.getBenchmarks.mockResolvedValue(null);
  apiMock.saveDevFactors.mockResolvedValue({ ok: true });
  apiMock.savePricingPattern.mockResolvedValue({ ok: true });
  apiMock.setStripLargeCat.mockResolvedValue({ ok: true });
});

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const cellsOf = (rows) => rows.flatMap(([yr, vals]) =>
  vals.map((v, i) => ({ origin_year: yr, dev_months: (i + 1) * 12, cum_value: v })));

// Varied-ratio 2021–2025 cumulative triangle. 12–24 ratios per year:
// 1.6, 1.5, 1.4, 1.5 → weighted 7010/4700 = 1.4915, simple 1.5000,
// last-3 1.4667; excluding the 2021 cell ("0:0") → 5410/3700 = 1.4622.
const VARIED_ROWS = [
  [2021, [1000, 1600, 1840, 1932, 1990]],
  [2022, [1200, 1800, 2000, 2120]],
  [2023, [1400, 1960, 2240]],
  [2024, [1100, 1650]],
  [2025, [1300]],
];
const VARIED_CELLS = cellsOf(VARIED_ROWS);

// "Full" variant with a 600 large-loss spike folded into 2023 — the
// stripped variant is VARIED_CELLS. Full weighted 12–24 = 7730/5300 = 1.4585.
const FULL_WITH_LARGE_ROWS = [
  [2021, [1000, 1600, 1840, 1932, 1990]],
  [2022, [1200, 1800, 2000, 2120]],
  [2023, [2000, 2680, 3040]],
  [2024, [1100, 1650]],
  [2025, [1300]],
];
const FULL_WITH_LARGE_CELLS = cellsOf(FULL_WITH_LARGE_ROWS);

// Munich chain ladder legs (full only). The incurred triangle served by the
// with-exclusions endpoint is the cellwise paid + OS sum.
const PAID_ROWS = [
  [2021, [500, 900, 1080, 1150, 1190]],
  [2022, [600, 1020, 1200, 1280]],
  [2023, [700, 1120, 1300]],
  [2024, [550, 935]],
  [2025, [650]],
];
const OS_ROWS = [
  [2021, [600, 550, 450, 300, 120]],
  [2022, [700, 600, 500, 350]],
  [2023, [800, 700, 550]],
  [2024, [650, 580]],
  [2025, [750]],
];
const INCURRED_ROWS = PAID_ROWS.map(([yr, vals], r) => [yr, vals.map((v, i) => v + OS_ROWS[r][1][i])]);
const PAID_CELLS = cellsOf(PAID_ROWS);
const OS_CELLS = cellsOf(OS_ROWS);
const INCURRED_CELLS = cellsOf(INCURRED_ROWS);

// Latest earned premium per origin year for the loss-BF a priori.
const PREMIUM_LATEST_CELLS = [
  { origin_year: 2021, dev_months: 12, cum_value: 5000 },
  { origin_year: 2022, dev_months: 12, cum_value: 5500 },
  { origin_year: 2023, dev_months: 12, cum_value: 6000 },
  { origin_year: 2024, dev_months: 12, cum_value: 6500 },
  { origin_year: 2025, dev_months: 12, cum_value: 7000 },
];

const BENCHMARKS = {
  country: [{ ldf: 1.45 }, { ldf: 1.12 }, { ldf: 1.05 }, { ldf: 1.02 }],
  region: [{ ldf: 1.5 }, { ldf: 1.15 }, { ldf: 1.06 }, { ldf: 1.03 }],
  all: [{ ldf: 1.55 }, { ldf: 1.18 }, { ldf: 1.08 }, { ldf: 1.04 }],
};

function mockTriangleWithExclusions(cells, { stripped = cells, exclusions = ZERO_EXCLUSIONS } = {}) {
  apiMock.getTriangleWithExclusions.mockResolvedValue({
    full: { cells }, stripped: { cells: stripped }, exclusions,
  });
}

function renderScreen(routeKey = 'PROP_PAID_CLAIMS_DEV_FACTORS') {
  return render(
    <DevFactorsScreen routeKey={routeKey} title="Development Factors" headerPill="DEV FACTORS" />,
  );
}

/* ── DOM readers ──────────────────────────────────────────────────────── */

/** All rows of the .df-table inside the section titled `title`, each row as
 *  the array of cell strings (read-only .df-val text or editable input value),
 *  excluding the sticky row-header cell. */
function factorRows(title) {
  const section = screen.getByText(title).closest('.df-section');
  return [...section.querySelectorAll('.df-table tbody tr')].map(tr =>
    [...tr.querySelectorAll('td')].slice(1).map(td => {
      const input = td.querySelector('input');
      return input ? input.value : (td.querySelector('.df-val')?.textContent ?? '');
    }));
}

const triRowValues = (rowEl) => [...rowEl.querySelectorAll('.tri-inp')].map(d => d.textContent);

const flush = () => act(async () => {});

/* ═══════════════════════════════════════════════════════════════════════ */

describe('DevFactorsScreen golden master', () => {
  it('pins LDF/CDF chains for weighted, simple and last-3 averages, the parametrized fit, chosen seeding/reseeding and the dirty save-gate', async () => {
    mockTriangleWithExclusions(VARIED_CELLS);
    renderScreen();

    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await screen.findAllByDisplayValue('1.4915'); // chosen seeded from ACTUAL

    // Meta bar derives the 2021..2025 window from triangleMeta.
    expect(screen.getByText('Dev Years').closest('.df-mini').querySelector('.df-mini-value').textContent).toBe('5');
    expect(screen.getByText('Start Year').closest('.df-mini').querySelector('.df-mini-value').textContent).toBe('2021');

    // Weighted (default) actual factors + parametrized exponential fit.
    expect(factorRows('Actual Development Factors')).toEqual([
      ['1.4915', '1.1343', '1.0552', '1.0300'],
      ['1.8388', '1.2329', '1.0869', '1.0300'],
    ]);
    expect(factorRows('Parametrized Development Factors')).toEqual([
      ['1.4122', '1.1595', '1.0562', '1.0290'],
      ['1.7795', '1.2601', '1.0868', '1.0290'],
    ]);
    // Underwriter chosen seeds from the ACTUAL weighted factors.
    expect(factorRows('Underwriter Chosen Factors')).toEqual([
      ['1.4915', '1.1343', '1.0552', '1.0300'],
      ['1.8388', '1.2329', '1.0869', '1.0300'],
    ]);

    // Claims screen with zero identified large/cat losses → nudge banner,
    // dismissible.
    expect(screen.getByText(/No large losses or cat losses have been identified/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss warning' }));
    expect(screen.queryByText(/No large losses or cat losses have been identified/)).toBeNull();

    // Dirty gate: factors were saved before (factorsSavedAt set) and nothing
    // was edited, so Save is a no-op — no server round-trip.
    fireEvent.click(screen.getByText(/Save Factors/));
    await flush();
    expect(apiMock.saveDevFactors).not.toHaveBeenCalled();
    expect(apiMock.savePricingPattern).not.toHaveBeenCalled();

    // Simple average: actual factors move, chosen factors DO NOT reseed.
    fireEvent.click(screen.getByText('Simple'));
    expect(factorRows('Actual Development Factors')).toEqual([
      ['1.5000', '1.1347', '1.0550', '1.0300'],
      ['1.8495', '1.2330', '1.0867', '1.0300'],
    ]);
    expect(factorRows('Underwriter Chosen Factors')[0]).toEqual(['1.4915', '1.1343', '1.0552', '1.0300']);

    // Last-3 average.
    fireEvent.click(screen.getByText('Last 3'));
    expect(screen.getByText('Derived from triangle data (last3)')).toBeInTheDocument();
    expect(factorRows('Actual Development Factors')).toEqual([
      ['1.4667', '1.1347', '1.0550', '1.0300'],
      ['1.8084', '1.2330', '1.0867', '1.0300'],
    ]);

    // Explicit base re-pick DOES reseed chosen from the current (last3) calc.
    fireEvent.click(screen.getByText('ACTUAL'));
    expect(factorRows('Underwriter Chosen Factors')).toEqual([
      ['1.4667', '1.1347', '1.0550', '1.0300'],
      ['1.8084', '1.2330', '1.0867', '1.0300'],
    ]);

    // Save now goes through (dirty) and carries the last3 chosen set.
    fireEvent.click(screen.getByText(/Save Factors/));
    await waitFor(() => expect(apiMock.saveDevFactors).toHaveBeenCalledTimes(1));
    const payload = apiMock.saveDevFactors.mock.calls[0][2];
    expect(payload.method).toBe('last3');
    expect(payload.basis).toBe('full');
    expect(payload.tail_factor).toBe(1.0);
    expect(payload.factors.map(f => f.chosen_ldf)).toEqual(
      [1.4666666666666668, 1.1346560846560847, 1.0550000000000002, 1.0300207039337475],
    );
    expect(payload.factors.map(f => f.chosen_cdf)).toEqual(
      [1.80839826682149, 1.2329988182873794, 1.0866718426501036, 1.0300207039337475],
    );
    expect(payload.factors.every(f => f.chosen_source === 'ACTUAL')).toBe(true);
  });

  it('pins chosen-factor editing (LDF and CDF cells) and the exact byte-level save payloads', async () => {
    mockTriangleWithExclusions(VARIED_CELLS);
    renderScreen();

    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await screen.findAllByDisplayValue('1.4915');

    const chosenSection = screen.getByText('Underwriter Chosen Factors').closest('.df-section');
    const inputsOf = (rowIdx) =>
      [...chosenSection.querySelectorAll('.df-table tbody tr')[rowIdx].querySelectorAll('input')];

    // Edit chosen LDF[0] → display reformats to 4dp; the CDF row is NOT
    // recomputed from the edited LDF (cells are independent).
    fireEvent.change(inputsOf(0)[0], { target: { value: '1.75' } });
    expect(inputsOf(0).map(i => i.value)).toEqual(['1.7500', '1.1343', '1.0552', '1.0300']);
    expect(inputsOf(1).map(i => i.value)).toEqual(['1.8388', '1.2329', '1.0869', '1.0300']);

    // Edit chosen CDF[1] directly.
    fireEvent.change(inputsOf(1)[1], { target: { value: '1.25' } });
    expect(inputsOf(1).map(i => i.value)).toEqual(['1.8388', '1.2500', '1.0869', '1.0300']);

    fireEvent.click(screen.getByText(/Save Factors/));
    await waitFor(() => expect(apiMock.saveDevFactors).toHaveBeenCalledTimes(1));

    // saveDevFactors payload — full byte-identical pin.
    expect(apiMock.saveDevFactors.mock.calls[0][0]).toBe('contract-1');
    expect(apiMock.saveDevFactors.mock.calls[0][1]).toBe('CLAIMS_PAID');
    expect(apiMock.saveDevFactors.mock.calls[0][2]).toEqual({
      method: 'weighted',
      tail_factor: 1.0,
      basis: 'full',
      factors: [
        {
          dev_month: 12,
          actual_ldf: 1.4914893617021276, actual_cdf: 1.8388365023972688,
          parametrized_ldf: 1.4122230788319396, parametrized_cdf: 1.7795474817972874,
          chosen_source: 'ACTUAL',
          chosen_ldf: 1.75, chosen_cdf: 1.8388365023972688,
          selected_ldf: 1.75, selected_cdf: 1.8388365023972688,
        },
        {
          dev_month: 24,
          actual_ldf: 1.1343283582089552, actual_cdf: 1.2328861000381117,
          parametrized_ldf: 1.15947712234622, parametrized_cdf: 1.2601036680898634,
          chosen_source: 'ACTUAL',
          chosen_ldf: 1.1343283582089552, chosen_cdf: 1.25,
          selected_ldf: 1.1343283582089552, selected_cdf: 1.25,
        },
        {
          dev_month: 36,
          actual_ldf: 1.0552083333333333, actual_cdf: 1.0868864302967565,
          parametrized_ldf: 1.0562016595656707, parametrized_cdf: 1.0867861416187532,
          chosen_source: 'ACTUAL',
          chosen_ldf: 1.0552083333333333, chosen_cdf: 1.0868864302967565,
          selected_ldf: 1.0552083333333333, selected_cdf: 1.0868864302967565,
        },
        {
          dev_month: 48,
          actual_ldf: 1.0300207039337475, actual_cdf: 1.0300207039337475,
          parametrized_ldf: 1.028957047904715, parametrized_cdf: 1.028957047904715,
          chosen_source: 'ACTUAL',
          chosen_ldf: 1.0300207039337475, chosen_cdf: 1.0300207039337475,
          selected_ldf: 1.0300207039337475, selected_cdf: 1.0300207039337475,
        },
      ],
    });
    expect(apiMock.saveDevFactors.mock.calls[0][3]).toBeUndefined(); // contract mode — no quote opts

    // savePricingPattern payload — full byte-identical pin.
    await waitFor(() => expect(apiMock.savePricingPattern).toHaveBeenCalledTimes(1));
    expect(apiMock.savePricingPattern.mock.calls[0][2]).toEqual({
      selection_method: 'WEIGHTED',
      tail_factor: 1.0,
      bf_ielr: 0.65,
      selected_factors: {
        chosen_ldfs: [1.75, 1.1343283582089552, 1.0552083333333333, 1.0300207039337475],
        chosen_cdfs: [1.8388365023972688, 1.25, 1.0868864302967565, 1.0300207039337475],
        chosen_base: 'ACTUAL',
        proj_method: 'CHAIN',
        excluded_ratios: [],
        use_munich: false,
        excluded_for_year_window: '2021:5',
      },
    });
  });

  it('pins the link-ratio exclusion flow: cell toggle moves the weighted factor and overrides the chosen set', async () => {
    mockTriangleWithExclusions(VARIED_CELLS);
    renderScreen();

    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await screen.findAllByDisplayValue('1.4915');

    fireEvent.click(screen.getByText('🔗 Link Ratios'));
    expect(await screen.findByText(/^Weighted$/)).toBeInTheDocument();

    // Pre-exclusion recalculated rows (same math as the Dev Factors view).
    expect(triRowValues(screen.getByText(/^Weighted$/).closest('tr')))
      .toEqual(['1.4915', '1.1343', '1.0552', '1.0300']);
    expect(triRowValues(screen.getByText('CDF').closest('tr')))
      .toEqual(['1.8388', '1.2329', '1.0869', '1.0300']);

    // Exclude the 2021 12–24 ratio (1.6000 — the only cell with that value).
    const cell = screen.getByText('1.6000');
    fireEvent.click(cell);
    expect(cell).toHaveStyle('text-decoration: line-through');
    expect(screen.getByText('1 ratio(s) excluded')).toBeInTheDocument();
    expect(triRowValues(screen.getByText(/^Weighted$/).closest('tr')))
      .toEqual(['1.4622', '1.1343', '1.0552', '1.0300']);
    expect(triRowValues(screen.getByText('CDF').closest('tr')))
      .toEqual(['1.8027', '1.2329', '1.0869', '1.0300']);

    // Back on the Dev Factors view the chosen set was overridden with the
    // filtered averages and the base flipped to LINK RATIOS.
    fireEvent.click(screen.getByText('📊 Development Factors'));
    expect(factorRows('Underwriter Chosen Factors')).toEqual([
      ['1.4622', '1.1343', '1.0552', '1.0300'],
      ['1.8027', '1.2329', '1.0869', '1.0300'],
    ]);
    expect(screen.getByText('LINK RATIOS').className).toContain('active');

    fireEvent.click(screen.getByText(/Save Factors/));
    await waitFor(() => expect(apiMock.saveDevFactors).toHaveBeenCalledTimes(1));
    const payload = apiMock.saveDevFactors.mock.calls[0][2];
    expect(payload.factors.every(f => f.chosen_source === 'SELECTED')).toBe(true);
    expect(payload.factors.map(f => f.chosen_ldf)).toEqual(
      [1.462162162162162, 1.1343283582089552, 1.0552083333333333, 1.0300207039337475],
    );
    expect(payload.factors.map(f => f.chosen_cdf)).toEqual(
      [1.802679405731401, 1.2328861000381117, 1.0868864302967565, 1.0300207039337475],
    );
    const pricing = apiMock.savePricingPattern.mock.calls[0][2];
    expect(pricing.selected_factors.chosen_base).toBe('LINK_RATIO');
    expect(pricing.selected_factors.excluded_ratios).toEqual(['0:0']);
    expect(pricing.selected_factors.excluded_for_year_window).toBe('2021:5');
  });

  it('pins the loss Bornhuetter-Ferguson projections and the IELR input flow', async () => {
    mockTriangleWithExclusions(VARIED_CELLS);
    apiMock.getTriangle.mockImplementation((id, type) =>
      Promise.resolve({ cells: type === 'PREMIUM' ? PREMIUM_LATEST_CELLS : [] }));
    renderScreen('PROP_PAID_CLAIMS_DEV_FACTORS');

    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await screen.findAllByDisplayValue('1.4915');

    fireEvent.click(screen.getByText('Bornhuetter-Ferguson'));
    expect(await screen.findByText('Bornhuetter-Ferguson Projections')).toBeInTheDocument();

    // Default IELR 0.65. Rows: latest | CDF | premium | IELR | a priori |
    // % unreported | BF IBNR | BF ultimate | loss ratio.
    let rows = factorRows('Bornhuetter-Ferguson Projections');
    expect(rows[0]).toEqual(['1,990', '1.0000', '5,000', '65.0%', '3,250', '0.0%', '0', '1,990', '39.8%']);
    expect(rows[2]).toEqual(['2,240', '1.0869', '6,000', '65.0%', '3,900', '8.0%', '312', '2,552', '42.5%']);
    expect(rows[4]).toEqual(['1,300', '1.8388', '7,000', '65.0%', '4,550', '45.6%', '2,076', '3,376', '48.2%']);

    // Raising the IELR flows straight through the a priori → IBNR → ultimate.
    fireEvent.change(screen.getByLabelText('Initial Expected Loss Ratio (IELR)'), { target: { value: '0.8' } });
    rows = factorRows('Bornhuetter-Ferguson Projections');
    expect(rows[4]).toEqual(['1,300', '1.8388', '7,000', '80.0%', '5,600', '45.6%', '2,555', '3,855', '55.1%']);

    // The edited IELR rides the pricing-pattern save.
    fireEvent.click(screen.getByText(/Save Factors/));
    await waitFor(() => expect(apiMock.savePricingPattern).toHaveBeenCalledTimes(1));
    const pricing = apiMock.savePricingPattern.mock.calls[0][2];
    expect(pricing.bf_ielr).toBe(0.8);
    expect(pricing.selected_factors.proj_method).toBe('BF');
  });

  it('pins the premium Bornhuetter-Ferguson projections: EPI inputs, suggested % achieved and the premium save payload', async () => {
    mockTriangleWithExclusions(VARIED_CELLS);
    apiMock.getTriangle.mockImplementation((id, type) =>
      Promise.resolve({ cells: type === 'PREMIUM' ? VARIED_CELLS : [] }));
    renderScreen('PROP_PREMIUM_DEV_FACTORS');

    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await screen.findAllByDisplayValue('1.4915');

    fireEvent.click(screen.getByText('Bornhuetter-Ferguson'));
    expect(await screen.findByText('Bornhuetter-Ferguson Projections (Premium)')).toBeInTheDocument();

    // Before any EPI is entered the a priori is 0 → ultimate = current.
    // Rows: current | CDF | EPI input | % achieved | a priori | % unachieved |
    // BF unearned | BF ultimate premium | achieved ratio.
    expect(factorRows('Bornhuetter-Ferguson Projections (Premium)')[4])
      .toEqual(['1,300', '1.8388', '', '100.0%', '0', '45.6%', '0', '1,300', '0.0%']);

    const section = screen.getByText('Bornhuetter-Ferguson Projections (Premium)').closest('.df-section');
    const epiInputs = [...section.querySelectorAll('tbody input')];
    expect(epiInputs).toHaveLength(5);
    const epis = ['2000', '2200', '2400', '1800', '2100'];
    epis.forEach((v, i) => fireEvent.change(epiInputs[i], { target: { value: v } }));

    let rows = factorRows('Bornhuetter-Ferguson Projections (Premium)');
    expect(rows[0]).toEqual(['1,990', '1.0000', '2,000', '100.0%', '2,000', '0.0%', '0', '1,990', '99.5%']);
    expect(rows[3]).toEqual(['1,650', '1.2329', '1,800', '100.0%', '1,800', '18.9%', '340', '1,990', '110.6%']);
    expect(rows[4]).toEqual(['1,300', '1.8388', '2,100', '100.0%', '2,100', '45.6%', '958', '2,258', '107.5%']);

    // Observed % achieved = mean(current premium ÷ EPI) = 0.8855 → 88.6%.
    const suggestBtn = await screen.findByText('Use observed avg (88.6%)');
    fireEvent.click(suggestBtn);
    expect(screen.getByLabelText('% Achieved Premium').value).toBe('0.8855');
    // Applied value is the ROUNDED 0.8855 → 88.5% in the table (the button
    // label shows the unrounded mean, 88.6%).
    rows = factorRows('Bornhuetter-Ferguson Projections (Premium)');
    expect(rows[4]).toEqual(['1,300', '1.8388', '2,100', '88.5%', '1,860', '45.6%', '848', '2,148', '102.3%']);

    fireEvent.click(screen.getByText(/Save Factors/));
    await waitFor(() => expect(apiMock.savePricingPattern).toHaveBeenCalledTimes(1));
    expect(apiMock.savePricingPattern.mock.calls[0][2]).toEqual({
      selection_method: 'WEIGHTED',
      tail_factor: 1.0,
      bf_ielr: 0.65,
      selected_factors: {
        chosen_ldfs: [1.4914893617021276, 1.1343283582089552, 1.0552083333333333, 1.0300207039337475],
        chosen_cdfs: [1.8388365023972688, 1.2328861000381117, 1.0868864302967565, 1.0300207039337475],
        chosen_base: 'ACTUAL',
        proj_method: 'BF',
        excluded_ratios: [],
        use_munich: false,
        excluded_for_year_window: '2021:5',
        bf_percent_achieved: 0.8855,
        bf_epi_per_year: [2000, 2200, 2400, 1800, 2100],
      },
    });
  });

  it('pins the stripped basis: attritional factors, conservative full-triangle reference rows, over-full flags and basis in the save payload', async () => {
    appStateMock.propTreatyDetail = { stripLargeCat: true };
    mockTriangleWithExclusions(FULL_WITH_LARGE_CELLS, {
      stripped: VARIED_CELLS,
      exclusions: { largeLossCount: 1, catLossCount: 0, applies: true, proxyPlaced: 0 },
    });
    renderScreen('PROP_OS_CLAIMS_DEV_FACTORS');

    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await screen.findAllByDisplayValue('1.4915');

    // Stripped-mode banner counts.
    expect(screen.getByText(/1 large loss and 0 cat losses have been excluded from this triangle/)).toBeInTheDocument();

    // Actual factors run on the STRIPPED (attritional) cells.
    expect(factorRows('Actual Development Factors')).toEqual([
      ['1.4915', '1.1343', '1.0552', '1.0300'],
      ['1.8388', '1.2329', '1.0869', '1.0300'],
    ]);

    // The chosen table grows the greyed full-basis reference rows
    // (Incl. L/C) computed from the UNSTRIPPED cells.
    expect(factorRows('Underwriter Chosen Factors')).toEqual([
      ['1.4915', '1.1343', '1.0552', '1.0300'],
      ['1.8388', '1.2329', '1.0869', '1.0300'],
      ['1.4585', '1.1316', '1.0552', '1.0300'],
      ['1.7938', '1.2299', '1.0869', '1.0300'],
    ]);
    expect(screen.getByText('Incl. L/C — LDF (ref)')).toBeInTheDocument();
    expect(screen.getByText('Incl. L/C — CDF (ref)')).toBeInTheDocument();

    // Selected stripped factors 1 and 2 exceed their full-basis counterparts
    // → amber verification flag on exactly those cells.
    const chosenSection = screen.getByText('Underwriter Chosen Factors').closest('.df-section');
    const ldfCells = [...chosenSection.querySelectorAll('.df-table tbody tr')[0].querySelectorAll('td')].slice(1);
    const flagTitle = 'Selected factor exceeds the full-triangle factor — please verify.';
    expect(ldfCells.map(td => td.getAttribute('title'))).toEqual([flagTitle, flagTitle, null, null]);

    // Saving from the stripped basis stamps basis: 'stripped'.
    fireEvent.click(screen.getByText('Simple')); // mark dirty without touching chosen
    fireEvent.click(screen.getByText(/Save Factors/));
    await waitFor(() => expect(apiMock.saveDevFactors).toHaveBeenCalledTimes(1));
    const payload = apiMock.saveDevFactors.mock.calls[0][2];
    expect(payload.basis).toBe('stripped');
    expect(payload.method).toBe('simple');
    expect(payload.factors.map(f => f.chosen_ldf)).toEqual(
      [1.4914893617021276, 1.1343283582089552, 1.0552083333333333, 1.0300207039337475],
    );
  });

  it('pins the Munich chain ladder projections and the stripped-incurred modal on the incurred screen', async () => {
    mockTriangleWithExclusions(INCURRED_CELLS);
    apiMock.getTriangle.mockImplementation((id, type) => Promise.resolve({
      cells: type === 'CLAIMS_PAID' ? PAID_CELLS : type === 'CLAIMS_OS' ? OS_CELLS : [],
    }));
    renderScreen('PROP_INCURRED_DEV_FACTORS');

    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await screen.findAllByDisplayValue('1.2559');

    // Combined (paid + OS) incurred triangle — OS run-off drives sub-1 LDFs.
    expect(factorRows('Actual Development Factors')).toEqual([
      ['1.2559', '1.0389', '0.9536', '0.9034'],
      ['1.1240', '0.8950', '0.8615', '0.9034'],
    ]);

    // MCL is available here (both legs fetched) and off by default.
    const munichBox = screen.getByRole('checkbox');
    expect(munichBox.disabled).toBe(false);
    expect(munichBox.checked).toBe(false);
    expect(screen.queryByText('Munich Chain Ladder Projections')).toBeNull();

    fireEvent.click(munichBox);
    expect(await screen.findByText('Munich Chain Ladder Projections')).toBeInTheDocument();

    // Correlation parameters estimated from the paid/OS legs.
    const mclSection = screen.getByText('Munich Chain Ladder Projections').closest('.df-section');
    const sub = mclSection.querySelector('.df-section-sub').textContent;
    expect(sub).toContain('λ_P = 0.3421');
    expect(sub).toContain('λ_I = -0.2111');

    // Rows: latest paid | latest incurred | MCL ult paid | MCL ult incurred |
    // IBNR paid | IBNR incurred | gap.
    const rows = factorRows('Munich Chain Ladder Projections');
    expect(rows[0]).toEqual(['1,190', '1,310', '1,190', '1,310', '0', '0', '120']);
    expect(rows[1]).toEqual(['1,280', '1,630', '1,325', '1,473', '45', '-157', '148']);
    expect(rows[4]).toEqual(['650', '1,400', '1,413', '1,565', '763', '165', '153']);

    // use_munich rides the pricing-pattern save.
    fireEvent.click(screen.getByText(/Save Factors/));
    await waitFor(() => expect(apiMock.savePricingPattern).toHaveBeenCalledTimes(1));
    expect(apiMock.savePricingPattern.mock.calls[0][2].selected_factors.use_munich).toBe(true);

    // Stripped-incurred comparison modal (full vs attritional grids).
    fireEvent.click(screen.getByText('▦ Stripped Incurred Triangle'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Incurred Triangle — Stripped of Large/CAT')).toBeInTheDocument();
    expect(screen.getByText(/Stripping is OFF — development factors are calculated on the full triangle/)).toBeInTheDocument();
    const grids = [...dialog.querySelectorAll('table.tri-table')];
    expect(grids).toHaveLength(2);
    expect(triRowValues(grids[0].querySelector('tbody tr')))
      .toEqual(['1,100', '1,450', '1,530', '1,450', '1,310']);
    expect(triRowValues(grids[1].querySelector('tbody tr')))
      .toEqual(['1,100', '1,450', '1,530', '1,450', '1,310']);

    // Backdrop click (role="presentation") dismisses.
    fireEvent.click(screen.getByRole('presentation'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pins the benchmark comparison graph: series legend and value axis from actual + parametrized + benchmark curves', async () => {
    appStateMock.propTreatyDetail = { countryId: 'country-1' };
    mockTriangleWithExclusions(VARIED_CELLS);
    apiMock.getBenchmarks.mockResolvedValue(BENCHMARKS);
    renderScreen('PROP_PAID_CLAIMS_DEV_FACTORS');

    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await waitFor(() => expect(apiMock.getBenchmarks).toHaveBeenCalledWith('country-1', 'CLAIMS_PAID'));

    fireEvent.click(screen.getByText('📈 Comparison Graph'));
    expect(await screen.findByText('Development Factor Comparison')).toBeInTheDocument();
    await screen.findByText('Country Average');

    for (const name of ['Actual (Weighted)', 'Parametrized', 'Country Average', 'Region Average', 'All Countries']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // Y axis spans min(1.02) × 0.98 → max(1.55) × 1.02 over 8 grid steps.
    for (const label of ['1.000', '1.072', '1.145', '1.218', '1.290', '1.363', '1.436', '1.508', '1.581']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Dev-period x labels.
    expect(screen.getByText('1–2')).toBeInTheDocument();
    expect(screen.getByText('4–5')).toBeInTheDocument();
  });

  it('pins the first-save exception: never-saved factors persist on Save even with no edits', async () => {
    mockTriangleWithExclusions(VARIED_CELLS);
    apiMock.getDevFactorStaleness.mockResolvedValue({
      triangleUpdatedAt: '2026-01-01T00:00:00Z', factorsSavedAt: null, stale: false,
    });
    renderScreen();

    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await screen.findAllByDisplayValue('1.4915');
    await flush(); // staleness hydration → factorsNeverSaved

    fireEvent.click(screen.getByText(/Save Factors/));
    await waitFor(() => expect(apiMock.saveDevFactors).toHaveBeenCalledTimes(1));
    const payload = apiMock.saveDevFactors.mock.calls[0][2];
    expect(payload.factors.map(f => f.chosen_ldf)).toEqual(
      [1.4914893617021276, 1.1343283582089552, 1.0552083333333333, 1.0300207039337475],
    );
  });

  it('pins quote mode: dev factors save with quote opts, pricing pattern skipped, 404 pattern load tolerated', async () => {
    appStateMock.quoteMode = true;
    mockTriangleWithExclusions(VARIED_CELLS);
    apiMock.getPricingPattern.mockRejectedValue(
      Object.assign(new Error('API GET → 404: not found'), { status: 404 }),
    );
    renderScreen();

    // The 404 on the contract-only pricing-pattern endpoint must not block
    // the screen — factor tables still render from triangle data.
    expect(await screen.findByText('Actual Development Factors')).toBeInTheDocument();
    await screen.findAllByDisplayValue('1.4915');

    fireEvent.click(screen.getByText('Simple')); // mark dirty
    fireEvent.click(screen.getByText(/Save Factors/));
    await waitFor(() => expect(apiMock.saveDevFactors).toHaveBeenCalledTimes(1));
    expect(apiMock.saveDevFactors.mock.calls[0][3]).toEqual({ quote: true });
    await flush();
    expect(apiMock.savePricingPattern).not.toHaveBeenCalled();
  });
});
