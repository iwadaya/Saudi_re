// ReinsurerAnalysisModal: closed renders nothing and never fetches; open
// fetches the pool once, renders the reinsurer/COB/type filters and at least
// one fitted power-law equation; the empty pool shows its message; Close fires
// onClose. The api module is mocked so the modal renders without a backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReinsurerAnalysisModal from './ReinsurerAnalysisModal.jsx';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { getReinsurerAnalysis: vi.fn() },
}));
vi.mock('../../api', () => ({ api: apiMock, HttpError: class HttpError extends Error {} }));

// Two reinsurers — Swiss Re leads two treaties (3 layers), Munich Re one
// (2 layers) — with enough points for a calibrated power-law fit.
const DATA = {
  points: [
    { id: 'c1:l1', contractId: 'c1', layerId: 'l1', layerNumber: 1, reinsurer: 'Swiss Re', cedant: 'Alpha', country: 'Saudi Arabia', region: 'Middle East', uwYear: 2025, treatyType: 'Per Risk XL', perilScope: 'RISK', cob: 'Property', cobs: ['Property', 'Marine'], attachment: 1000000, limit: 5000000, egnpi: 20000000, rolPct: 5 },
    { id: 'c1:l2', contractId: 'c1', layerId: 'l2', layerNumber: 2, reinsurer: 'Swiss Re', cedant: 'Alpha', country: 'Saudi Arabia', region: 'Middle East', uwYear: 2025, treatyType: 'Per Risk XL', perilScope: 'RISK', cob: 'Property', cobs: ['Property', 'Marine'], attachment: 6000000, limit: 10000000, egnpi: 20000000, rolPct: 2.5 },
    { id: 'c2:l1', contractId: 'c2', layerId: 'l1', layerNumber: 1, reinsurer: 'Swiss Re', cedant: 'Beta', country: 'UAE', region: 'Middle East', uwYear: 2024, treatyType: 'Per Risk XL', perilScope: 'RISK', cob: 'Property', cobs: ['Property'], attachment: 2000000, limit: 8000000, egnpi: 15000000, rolPct: 4 },
    { id: 'c3:l1', contractId: 'c3', layerId: 'l1', layerNumber: 1, reinsurer: 'Munich Re', cedant: 'Gamma', country: 'Qatar', region: 'Middle East', uwYear: 2025, treatyType: 'Cat XL', perilScope: 'CAT', cob: 'Aviation', cobs: ['Aviation', 'Energy'], attachment: 3000000, limit: 12000000, egnpi: 30000000, rolPct: 10 },
    { id: 'c3:l2', contractId: 'c3', layerId: 'l2', layerNumber: 2, reinsurer: 'Munich Re', cedant: 'Gamma', country: 'Qatar', region: 'Middle East', uwYear: 2025, treatyType: 'Cat XL', perilScope: 'CAT', cob: 'Aviation', cobs: ['Aviation', 'Energy'], attachment: 15000000, limit: 20000000, egnpi: 30000000, rolPct: 6 },
  ],
  reinsurers: [
    { name: 'Swiss Re', treatyCount: 2, layerCount: 3 },
    { name: 'Munich Re', treatyCount: 1, layerCount: 2 },
  ],
  cobs: ['Aviation', 'Energy', 'Marine', 'Property'],
  treatyTypes: ['Cat XL', 'Per Risk XL'],
  pointCount: 5,
  treatyCount: 3,
  truncated: false,
  generatedAt: '2026-06-18T00:00:00.000Z',
};

const EMPTY = { points: [], reinsurers: [], cobs: [], treatyTypes: [], pointCount: 0, treatyCount: 0, truncated: false, generatedAt: '2026-06-18T00:00:00.000Z' };

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { apiMock.getReinsurerAnalysis.mockResolvedValue(DATA); });

describe('ReinsurerAnalysisModal', () => {
  it('renders nothing and never fetches when closed', () => {
    const { container } = render(<ReinsurerAnalysisModal open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    expect(apiMock.getReinsurerAnalysis).not.toHaveBeenCalled();
  });

  it('fetches once on open and shows the filters and a fitted equation', async () => {
    render(<ReinsurerAnalysisModal open onClose={vi.fn()} />);
    await waitFor(() => expect(apiMock.getReinsurerAnalysis).toHaveBeenCalledTimes(1));

    // Reinsurer panel + COB / type filters render from the fetched pool.
    // Default-selects the top 3 reinsurers → the reinsurer dropdown trigger
    // reads "3 selected"; the COB / treaty-type dropdowns show their defaults.
    expect(await screen.findByRole('button', { name: /\d+ selected/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All COBs/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All Types/ })).toBeInTheDocument();

    // Opening the reinsurer dropdown reveals the multi-select list controls.
    fireEvent.click(screen.getByRole('button', { name: /\d+ selected/ }));
    expect(await screen.findByRole('button', { name: 'Select all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search reinsurers/)).toBeInTheDocument();

    // At least one fitted power-law equation (y = a · x^b) is shown.
    const eqs = await screen.findAllByText((t) => t.startsWith('y =') && t.includes('x^'));
    expect(eqs.length).toBeGreaterThan(0);
  });

  it('shows the empty state when no treaty carries a lead reinsurer', async () => {
    apiMock.getReinsurerAnalysis.mockResolvedValue(EMPTY);
    render(<ReinsurerAnalysisModal open onClose={vi.fn()} />);
    expect(await screen.findByText(/No NP treaties carry a lead reinsurer yet/)).toBeInTheDocument();
  });

  it('calls onClose when the Close button is clicked', async () => {
    const onClose = vi.fn();
    render(<ReinsurerAnalysisModal open onClose={onClose} />);
    await screen.findByRole('button', { name: /\d+ selected/ });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
