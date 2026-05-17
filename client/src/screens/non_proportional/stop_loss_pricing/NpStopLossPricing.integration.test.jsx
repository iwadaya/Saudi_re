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

  it('layer cover always shows LR fields (no basis toggle)', () => {
    renderStopLoss();
    expect(screen.getByText(/Attachment LR \(%\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Limit LR \(%\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Attachment LR')).toBeInTheDocument();
    expect(screen.getByLabelText('Limit LR')).toBeInTheDocument();
    expect(screen.getByLabelText('EPI')).toBeInTheDocument();
    // Old absolute pill buttons should be gone.
    expect(screen.queryByRole('button', { name: /Absolute \(Agg XL\)/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Loss Ratio \(Stop Loss\)/i })).not.toBeInTheDocument();
  });

  it('burning cost table has Premium / Loss Ratio columns', () => {
    renderStopLoss();
    expect(screen.getByText('Premium (Adjusted)')).toBeInTheDocument();
    expect(screen.getByText('Aggregate Loss')).toBeInTheDocument();
    expect(screen.getByText('Loss Ratio')).toBeInTheDocument();
    expect(screen.getByText('Layer Hit')).toBeInTheDocument();
  });

  it('on-level adjusted premium drives the loss ratio cell', async () => {
    // Server returns egnpi rows. Year 2020: 8M premium with +5% applied in
    // 2021 and +3% in 2022 → on-level factor for 2020 = 1.05 × 1.03 ≈ 1.0815
    // Year 2023 (last in window): factor = 1.0
    apiMock.getNpEgnpiYear.mockResolvedValue([
      { uw_year: 2019, egnpi: '7000000', rate_change_pct: null },
      { uw_year: 2020, egnpi: '8000000', rate_change_pct: null },
      { uw_year: 2021, egnpi: '9000000', rate_change_pct: '5' },
      { uw_year: 2022, egnpi: '10000000', rate_change_pct: '3' },
      { uw_year: 2023, egnpi: '11000000', rate_change_pct: null },
    ]);
    renderStopLoss();

    // Set LR layer + EPI for the engine to be runnable.
    fireEvent.change(screen.getByLabelText('Attachment LR'), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('Limit LR'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('EPI'), { target: { value: '11000000' } });

    // Enter 9M aggregate loss against the 2020 row (adjusted prem ≈ 8.652M
    // → LR ≈ 104.0%).
    await waitFor(() => {
      const row = screen.getByText('2020').closest('tr');
      expect(within(row).queryByText(/— \(set EGNPI\)/)).not.toBeInTheDocument();
    });
    const row2020 = screen.getByText('2020').closest('tr');
    const input2020 = within(row2020).getByPlaceholderText('0');
    fireEvent.change(input2020, { target: { value: '9000000' } });

    // Loss ratio cell should now show ~104%.
    await waitFor(() => {
      expect(within(row2020).getByText(/104\.\d%/)).toBeInTheDocument();
    });
  });

  it('Excel paste fills consecutive year rows from a single column', () => {
    renderStopLoss();
    // Set attachment + limit so the engine runs.
    fireEvent.change(screen.getByLabelText('Attachment LR'), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('Limit LR'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('EPI'), { target: { value: '10000000' } });

    // Paste 3 values into the first year row.
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
    renderStopLoss();
    expect(screen.queryByText(/Pr\(layer hit/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Run Monte Carlo/i }));
    fireEvent.change(screen.getByLabelText('Attachment LR'), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('Limit LR'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('EPI'), { target: { value: '10000000' } });
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

  it('hydrates inputs returned from the server on mount', async () => {
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
      expect(screen.getByLabelText('Attachment LR').value).toBe('85');
    });
    expect(screen.getByLabelText('Limit LR').value).toBe('15');
    expect(screen.getByLabelText('EPI').value).toBe('12000000');
  });
});
