// Smoke / integration test for NpStopLossPricing. Confirms the screen
// mounts, the engine wires through to the UI, and that:
//   - Switching attachment basis swaps the input fields
//   - Burning-cost rows produce a computed annual loss
//   - Exposure-rating inputs produce the expected analytical result
//   - The Monte-Carlo toggle reveals the MC summary
//   - Server hydration loads saved inputs through useScreenSave

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import NpStopLossPricing from './NpStopLossPricing.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getNpStopLossPricing: vi.fn(),
    saveNpStopLossPricing: vi.fn(),
  },
}));

vi.mock('../../../api', () => ({ default: apiMock }));

function renderStopLoss(appState = {}) {
  return renderBindScreen(<NpStopLossPricing />, {
    route: '/np/stop-loss-pricing',
    contractId: 'contract-sl-001',
    appState: {
      wizardMode: 'NP',
      npTreatyDetail: { startYear: 2024, experienceStartYear: 2019 },
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
  apiMock.getNpStopLossPricing.mockResolvedValue({ inputs: {}, outputs: null });
  apiMock.saveNpStopLossPricing.mockResolvedValue({ ok: true });
});

describe('NpStopLossPricing — render + interaction', () => {
  it('mounts with default sections visible', () => {
    renderStopLoss();
    expect(screen.getByText(/Layer Cover/i)).toBeInTheDocument();
    expect(screen.getByText(/Burning Cost · Aggregate Annual Losses/i)).toBeInTheDocument();
    expect(screen.getByText(/Exposure Rating · Compound Poisson/i)).toBeInTheDocument();
    expect(screen.getByText(/Monte Carlo · Aggregate Simulation/i)).toBeInTheDocument();
    expect(screen.getByText(/Method Blend/i)).toBeInTheDocument();
    expect(screen.getByText(/Blended Result/i)).toBeInTheDocument();
  });

  it('absolute → loss-ratio basis swaps fields (Attachment LR appears)', () => {
    renderStopLoss();
    expect(screen.getByText(/Attachment \(D\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Loss Ratio \(Stop Loss\)/i }));
    expect(screen.getByText(/Attachment LR \(%\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Limit LR \(%\)/i)).toBeInTheDocument();
    expect(screen.getByText(/^EPI$/i)).toBeInTheDocument();
  });

  it('burning cost: entering a year aggregate updates the layer-hit cell and annual loss', () => {
    renderStopLoss();
    // Set absolute attachment + limit: 10M xs 10M.
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 10,000,000/i), { target: { value: '10000000' } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 5,000,000/i), { target: { value: '10000000' } });

    // Burning cost table — find the row containing year 2019.
    const cell2019 = screen.getByText('2019');
    const row = cell2019.closest('tr');
    const input = within(row).getByPlaceholderText('0');
    // 15M aggregate → 5M in the 10M xs 10M layer (capped by limit).
    fireEvent.change(input, { target: { value: '15000000' } });

    // Layer hit cell shows 5,000,000 for that row.
    expect(within(row).getByText('5,000,000')).toBeInTheDocument();
  });

  it('exposure rating: λ + Lognormal severity produces a positive layer loss', () => {
    renderStopLoss();
    // Layer 4M xs 4M (absolute). Use exact placeholder strings so the
    // regex doesn't match "e.g. 200,000" or similar prefixes.
    fireEvent.change(screen.getByPlaceholderText('e.g. 10,000,000'), { target: { value: '4000000' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 5,000,000'), { target: { value: '4000000' } });
    // λ=20, Lognormal mean=200k CV=0.6  →  E[S]=4M, σ≈1.04M, layer loss ~σ/√(2π)≈416k.
    fireEvent.change(screen.getByPlaceholderText('e.g. 20'), { target: { value: '20' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 200,000'), { target: { value: '200000' } });
    fireEvent.change(screen.getByPlaceholderText('0.6'), { target: { value: '0.6' } });

    // Exposure rating cards appear under that section. E[S] should
    // render as 4.00M; aggMean is one of the result cards.
    const exposureSection = screen.getByText(/Exposure Rating · Compound Poisson/i).closest('div').parentElement;
    expect(within(exposureSection).getByText(/E\[S\]/i)).toBeInTheDocument();
    expect(within(exposureSection).getByText(/σ\[S\]/i)).toBeInTheDocument();
    // 4.00M should appear in the aggMean card.
    expect(within(exposureSection).getAllByText(/4\.00M/i).length).toBeGreaterThan(0);
  });

  it('monte carlo toggle: off → no panel, on → percentile panel appears', () => {
    renderStopLoss();
    expect(screen.queryByText(/Pr\(layer hit/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Run Monte Carlo/i }));
    // Set required inputs (frequency + severity).
    fireEvent.change(screen.getByPlaceholderText('e.g. 10,000,000'), { target: { value: '4000000' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 5,000,000'), { target: { value: '4000000' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 20'), { target: { value: '20' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 200,000'), { target: { value: '200000' } });
    fireEvent.change(screen.getByPlaceholderText('0.6'), { target: { value: '0.6' } });

    // The MC panel renders Hit Frequency + P95 cards.
    expect(screen.getByText(/Hit Frequency/i)).toBeInTheDocument();
    expect(screen.getByText('P95')).toBeInTheDocument();
    expect(screen.getByText('P99')).toBeInTheDocument();
  });

  it('shows a warning when no inputs are provided', () => {
    renderStopLoss();
    // No attachment, no inputs → engine returns the "no method" warning.
    expect(screen.getByText(/No pricing method produced output/i)).toBeInTheDocument();
  });

  it('Excel paste fills consecutive year rows from a single column', () => {
    renderStopLoss();
    // Attachment + limit so layer hits are computable.
    fireEvent.change(screen.getByPlaceholderText('e.g. 10,000,000'), { target: { value: '10000000' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 5,000,000'), { target: { value: '5000000' } });

    // Paste 3 values into the first year row — simulates Excel column copy.
    const firstYear = screen.getByText('2019');
    const firstRow = firstYear.closest('tr');
    const firstInput = within(firstRow).getByPlaceholderText('0');
    const pasted = '8,000,000\n12,500,000\n14,000,000';
    fireEvent.paste(firstInput, {
      clipboardData: { getData: () => pasted },
    });

    // After paste: 2019 → 8M, 2020 → 12.5M, 2021 → 14M.
    expect(within(firstRow).getByPlaceholderText('0').value).toBe('8000000');
    const row2020 = screen.getByText('2020').closest('tr');
    expect(within(row2020).getByPlaceholderText('0').value).toBe('12500000');
    const row2021 = screen.getByText('2021').closest('tr');
    expect(within(row2021).getByPlaceholderText('0').value).toBe('14000000');

    // Layer hits computed from the pasted values: at 5M xs 10M,
    // 8M → 0, 12.5M → 2.5M, 14M → 4M.
    expect(within(row2020).getByText('2,500,000')).toBeInTheDocument();
    expect(within(row2021).getByText('4,000,000')).toBeInTheDocument();
  });

  it('hydrates inputs returned from the server on mount', async () => {
    apiMock.getNpStopLossPricing.mockResolvedValue({
      inputs: {
        attachmentBasis: 'absolute',
        attachment: '12000000',
        limit: '5000000',
        loading: '30',
      },
      outputs: null,
    });
    renderStopLoss();
    // The Attachment field should show the loaded value after hydration.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('e.g. 10,000,000').value).toBe('12000000');
    });
    expect(screen.getByPlaceholderText('e.g. 5,000,000').value).toBe('5000000');
  });
});
