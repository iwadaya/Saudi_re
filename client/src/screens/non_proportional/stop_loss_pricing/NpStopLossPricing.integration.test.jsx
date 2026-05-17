// Smoke / integration test for NpStopLossPricing — Stop-Loss-only
// after the Aggregate XL split. Confirms:
//   - All sections render with the new LR-only layer cover
//   - Burning-cost table has the new 5-column layout
//   - Premiums + rate changes loaded from egnpi-year drive on-level
//     adjusted premium + loss-ratio cells
//   - Excel paste fills consecutive years
//   - Server hydration round-trips inputs
//   - Monte Carlo toggle reveals the percentile panel

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import NpStopLossPricing from './NpStopLossPricing.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getNpStopLossPricing: vi.fn(),
    saveNpStopLossPricing: vi.fn(),
    getNpEgnpiYear: vi.fn(),
  },
}));

vi.mock('../../../api', () => ({ default: apiMock }));

function renderStopLoss(appState = {}) {
  return renderBindScreen(<NpStopLossPricing />, {
    route: '/np/stop-loss-pricing',
    contractId: 'contract-sl-001',
    appState: {
      wizardMode: 'NP',
      npTreatyDetail: { startYear: 2024, experienceStartYear: 2019, treatyTypeName: 'Stop Loss' },
      ...appState,
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
  apiMock.getNpStopLossPricing.mockReset();
  apiMock.saveNpStopLossPricing.mockReset();
  apiMock.getNpEgnpiYear.mockReset();
  apiMock.getNpStopLossPricing.mockResolvedValue({ inputs: {}, outputs: null });
  apiMock.saveNpStopLossPricing.mockResolvedValue({ ok: true });
  apiMock.getNpEgnpiYear.mockResolvedValue([]);
});

describe('NpStopLossPricing — render + interaction', () => {
  it('mounts with default sections visible', () => {
    renderStopLoss();
    expect(screen.getByText(/Layer Cover · Loss-Ratio Basis/i)).toBeInTheDocument();
    expect(screen.getByText(/Burning Cost · Loss Ratios by UW Year/i)).toBeInTheDocument();
    expect(screen.getByText(/Exposure Rating · Compound Poisson/i)).toBeInTheDocument();
    expect(screen.getByText(/Monte Carlo · Aggregate Simulation/i)).toBeInTheDocument();
    expect(screen.getByText(/Method Blend/i)).toBeInTheDocument();
    expect(screen.getByText(/Blended Result/i)).toBeInTheDocument();
  });

  it('layer cover is a read-only display (edits happen on Structure)', () => {
    renderStopLoss({
      npStopLossInputs: {
        layers: [{ attachmentLossRatio: '80', limitLossRatio: '20', epi: '10000000' }],
        attachmentLossRatio: '80', limitLossRatio: '20', epi: '10000000',
      },
    });
    expect(screen.getByText(/Read-only — edit on the/i)).toBeInTheDocument();
    expect(screen.getByText('Attach LR %')).toBeInTheDocument();
    expect(screen.getByText('Limit LR %')).toBeInTheDocument();
    // Layer 1 row shows the values as plain text.
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
    // No inputs in the Layer Cover section anymore.
    expect(screen.queryByLabelText('Attachment LR')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Limit LR')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('EPI')).not.toBeInTheDocument();
    // Old absolute pill buttons should be gone.
    expect(screen.queryByRole('button', { name: /Absolute \(Agg XL\)/i })).not.toBeInTheDocument();
  });

  it('renders one Layer Cover row per layer from Treaty Detail', () => {
    renderStopLoss({
      npTreatyDetail: { startYear: 2024, experienceStartYear: 2019, treatyTypeName: 'Stop Loss', numberOfLayers: 3 },
      npStopLossInputs: {
        layers: [
          { attachmentLossRatio: '80', limitLossRatio: '20', epi: '10000000' },
          { attachmentLossRatio: '100', limitLossRatio: '20', epi: '10000000' },
          { attachmentLossRatio: '120', limitLossRatio: '30', epi: '10000000' },
        ],
      },
    });
    // L1, L2, L3 labels appear in the Layer Cover table.
    expect(screen.getAllByText('L1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('L2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('L3').length).toBeGreaterThan(0);
  });

  it('per-layer calculations propagate to the Blended Result table', async () => {
    apiMock.getNpEgnpiYear.mockResolvedValue([
      { uw_year: 2020, egnpi: '10000000' },
      { uw_year: 2021, egnpi: '10000000' },
      { uw_year: 2022, egnpi: '10000000' },
      { uw_year: 2023, egnpi: '10000000' },
    ]);
    renderStopLoss({
      npTreatyDetail: { startYear: 2024, experienceStartYear: 2019, treatyTypeName: 'Stop Loss', numberOfLayers: 2 },
      npStopLossInputs: {
        layers: [
          { attachmentLossRatio: '80', limitLossRatio: '20', epi: '10000000' },
          { attachmentLossRatio: '100', limitLossRatio: '20', epi: '10000000' },
        ],
        attachmentLossRatio: '80', limitLossRatio: '20', epi: '10000000',
      },
    });
    // Both layers should appear in multiple places (Layer Cover,
    // Burning Cost columns, Blended Result rows).
    await waitFor(() => {
      expect(screen.getAllByText('L1').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('L2').length).toBeGreaterThan(0);
    // TOTAL row is only rendered when there's more than one layer.
    expect(screen.getByText('TOTAL')).toBeInTheDocument();
    // Per-layer burning-cost column headers appear for >1 layer.
    expect(screen.getByText('L1 Hit')).toBeInTheDocument();
    expect(screen.getByText('L2 Hit')).toBeInTheDocument();
  });

  it('burning cost table has Premium / Loss Ratio columns', () => {
    renderStopLoss();
    expect(screen.getByText('Premium (Adjusted)')).toBeInTheDocument();
    expect(screen.getByText('Aggregate Loss')).toBeInTheDocument();
    expect(screen.getByText('Loss Ratio')).toBeInTheDocument();
    // Single-layer default → "Layer Hit" (without the L-number prefix).
    expect(screen.getByText('Layer Hit')).toBeInTheDocument();
  });

  it('on-level adjusted premium drives the loss ratio cell', async () => {
    // Server returns egnpi rows. Year 2020: 8M premium with +5% applied in
    // 2021 and +3% in 2022 → on-level factor for 2020 = 1.05 × 1.03 ≈ 1.0815
    apiMock.getNpEgnpiYear.mockResolvedValue([
      { uw_year: 2019, egnpi: '7000000', rate_change_pct: null },
      { uw_year: 2020, egnpi: '8000000', rate_change_pct: null },
      { uw_year: 2021, egnpi: '9000000', rate_change_pct: '5' },
      { uw_year: 2022, egnpi: '10000000', rate_change_pct: '3' },
      { uw_year: 2023, egnpi: '11000000', rate_change_pct: null },
    ]);
    // Layer cover comes from AppContext (Structure page is the source).
    renderStopLoss({
      npStopLossInputs: {
        layers: [{ attachmentLossRatio: '80', limitLossRatio: '20', epi: '11000000' }],
        attachmentLossRatio: '80', limitLossRatio: '20', epi: '11000000',
      },
    });

    await waitFor(() => {
      const row = screen.getByText('2020').closest('tr');
      expect(within(row).queryByText(/— \(set premium\)/)).not.toBeInTheDocument();
    });
    const row2020 = screen.getByText('2020').closest('tr');
    const input2020 = within(row2020).getByPlaceholderText('0');
    fireEvent.change(input2020, { target: { value: '9000000' } });

    await waitFor(() => {
      expect(within(row2020).getByText(/104\.\d%/)).toBeInTheDocument();
    });
  });

  it('Excel paste fills consecutive year rows from a single column', () => {
    renderStopLoss({
      npStopLossInputs: {
        layers: [{ attachmentLossRatio: '80', limitLossRatio: '20', epi: '10000000' }],
        attachmentLossRatio: '80', limitLossRatio: '20', epi: '10000000',
      },
    });

    const firstYear = screen.getByText('2019');
    const firstRow = firstYear.closest('tr');
    const firstInput = within(firstRow).getByPlaceholderText('0');
    const pasted = '8,000,000\n12,500,000\n14,000,000';
    fireEvent.paste(firstInput, {
      clipboardData: { getData: () => pasted },
    });

    expect(within(firstRow).getByPlaceholderText('0').value).toBe('8000000');
    const row2020 = screen.getByText('2020').closest('tr');
    expect(within(row2020).getByPlaceholderText('0').value).toBe('12500000');
    const row2021 = screen.getByText('2021').closest('tr');
    expect(within(row2021).getByPlaceholderText('0').value).toBe('14000000');
  });

  it('monte carlo toggle: off → no panel, on → percentile panel appears', () => {
    renderStopLoss({
      npStopLossInputs: {
        layers: [{ attachmentLossRatio: '80', limitLossRatio: '20', epi: '10000000' }],
        attachmentLossRatio: '80', limitLossRatio: '20', epi: '10000000',
      },
    });
    expect(screen.queryByText(/Pr\(layer hit/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Run Monte Carlo/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g. 20'), { target: { value: '20' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 200,000'), { target: { value: '200000' } });
    fireEvent.change(screen.getByPlaceholderText('0.6'), { target: { value: '0.6' } });

    expect(screen.getByText(/Hit Frequency/i)).toBeInTheDocument();
    expect(screen.getByText('P95')).toBeInTheDocument();
    expect(screen.getByText('P99')).toBeInTheDocument();
  });

  it('shows a warning when no inputs are provided', () => {
    renderStopLoss();
    expect(screen.getByText(/No pricing method produced output/i)).toBeInTheDocument();
  });

  it('hydrates layer cover from the server snapshot', async () => {
    apiMock.getNpStopLossPricing.mockResolvedValue({
      inputs: {
        attachmentLossRatio: '85',
        limitLossRatio: '15',
        epi: '12000000',
        loading: '30',
      },
      outputs: null,
    });
    renderStopLoss();
    await waitFor(() => {
      // Read-only display shows the loaded values as plain text.
      expect(screen.getByText('85%')).toBeInTheDocument();
    });
    expect(screen.getByText('15%')).toBeInTheDocument();
    expect(screen.getByText('12,000,000')).toBeInTheDocument();
  });

  it('Structure-page values in AppContext beat a stale server snapshot', async () => {
    // The previous save on the server had different LR / EPI values.
    apiMock.getNpStopLossPricing.mockResolvedValue({
      inputs: {
        attachmentLossRatio: '70',  // stale — server-saved
        limitLossRatio: '30',
        epi: '5000000',
        loading: '25',              // unique to server — should survive
        freqLambda: '12',           // unique to server — should survive
      },
      outputs: null,
    });
    // Structure page has just written newer values into the shared slice.
    renderStopLoss({
      npStopLossInputs: {
        attachmentLossRatio: '85',
        limitLossRatio: '15',
        epi: '12000000',
        layers: [{ attachmentLossRatio: '85', limitLossRatio: '15', epi: '12000000' }],
      },
    });
    // After hydration: read-only layer display shows Structure's values…
    await waitFor(() => {
      expect(screen.getByText('85%')).toBeInTheDocument();
    });
    expect(screen.getByText('15%')).toBeInTheDocument();
    expect(screen.getByText('12,000,000')).toBeInTheDocument();
    // …and the engine-only fields the Structure page doesn't own get
    // hydrated from the server snapshot.
    expect(screen.getByPlaceholderText('e.g. 20').value).toBe('12');     // freqLambda
  });
});
