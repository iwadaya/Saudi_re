import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LossSelectionScreen from './LossSelectionScreen.jsx';

const { apiMock, appStateMock, contractIdRef } = vi.hoisted(() => ({
  apiMock: {
    getLossSelectionStaleness: vi.fn(),
    getContract: vi.fn(),
    getLargeLosses: vi.fn(),
    getCatLosses: vi.fn(),
    getLossSelectionLatest: vi.fn(),
    getRefInflation: vi.fn(),
    getStraightStats: vi.fn(),
    getTriangle: vi.fn(),
    getNpEgnpiYear: vi.fn(),
    saveLossSelectionSnapshot: vi.fn(),
    saveLargeLosses: vi.fn(),
    saveCatLosses: vi.fn(),
  },
  appStateMock: { quoteMode: false },
  contractIdRef: { current: 'contract-1' },
}));

vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../hooks/useContractId', () => ({ useContractId: () => contractIdRef.current }));
vi.mock('../../context/AppContext', () => ({ useAppState: () => ({ state: appStateMock }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  contractIdRef.current = 'contract-1';
  appStateMock.quoteMode = false;
  apiMock.getContract.mockResolvedValue({ header: {}, detail: {} });
  apiMock.getLargeLosses.mockResolvedValue({ losses: [] });
  apiMock.getCatLosses.mockResolvedValue({ losses: [] });
  apiMock.getLossSelectionLatest.mockResolvedValue({ snapshot: null, items: [] });
  apiMock.getRefInflation.mockResolvedValue([]);
  apiMock.getStraightStats.mockResolvedValue({ stats: [] });
  apiMock.getTriangle.mockResolvedValue({ cells: [] });
  apiMock.getNpEgnpiYear.mockResolvedValue([]);
  apiMock.getLossSelectionStaleness.mockResolvedValue({ stale: false });
});

describe('LossSelectionScreen loss-selection staleness banner', () => {
  it('shows the amber banner when the selection is stale', async () => {
    apiMock.getLossSelectionStaleness.mockResolvedValue({ stale: true });
    render(<LossSelectionScreen routeKey="X" title="T" headerPill="P" lossType="large" embedded />);
    expect(
      await screen.findByText(/Losses have been added or edited since the last selection was saved/i),
    ).toBeInTheDocument();
  });

  it('hides the banner when the selection is not stale', async () => {
    apiMock.getLossSelectionStaleness.mockResolvedValue({ stale: false });
    render(<LossSelectionScreen routeKey="X" title="T" headerPill="P" lossType="large" embedded />);
    // Wait for the staleness fetch to resolve (component renders the KPI label).
    expect(await screen.findByText('Selected')).toBeInTheDocument();
    expect(screen.queryByText(/Losses have been added or edited/i)).toBeNull();
  });
});

// Phase-2 migration: the primary load (losses + latest snapshot) rides
// useResource with an AsyncBoundary, so the loading→loaded and
// loading→error transitions are part of the screen's contract.
describe('LossSelectionScreen primary load (useResource + AsyncBoundary)', () => {
  it('transitions loading → loaded and hydrates the merged loss table', async () => {
    let resolveLosses;
    apiMock.getLargeLosses.mockReturnValue(
      new Promise((resolve) => { resolveLosses = resolve; }),
    );

    render(<LossSelectionScreen routeKey="X" title="T" headerPill="P" lossType="large" embedded />);

    // boundary shows while losses + snapshot are in flight…
    expect(screen.getByRole('status')).toHaveTextContent(/loading loss selection/i);
    // …and the hydrated content is not rendered yet.
    expect(screen.queryByText('Selected')).toBeNull();

    resolveLosses({
      losses: [{
        loss_id: 'L-1', insured_name: 'Acme Factory', loss_name: 'Fire',
        date_of_loss: '2019-05-01', paid: 600000, os: 400000,
        incurred: 1000000, inflation_factor: 1.1,
      }],
    });

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    // hydrated row: uw_year parsed from date_of_loss, factor editable,
    // inflated incurred derived (1,000,000 × 1.1 — also in the KPI strip)
    expect(screen.getByText('Acme Factory')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1.1')).toBeInTheDocument();
    expect(screen.getAllByText('1,100,000').length).toBeGreaterThan(0);
  });

  it('transitions loading → error and recovers via Retry', async () => {
    apiMock.getLargeLosses
      .mockRejectedValueOnce(Object.assign(new Error('API GET → 500: down'), { status: 500 }))
      .mockResolvedValueOnce({ losses: [] });

    render(<LossSelectionScreen routeKey="X" title="T" headerPill="P" lossType="large" embedded />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);
    expect(screen.queryByText('Selected')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(apiMock.getLargeLosses).toHaveBeenCalledTimes(2);
    // recovered: hydrated content (KPI strip + empty-table row) is back.
    // findBy* (awaited) — the recovery re-render lands async, so a sync getBy*
    // here raced the hydration under CI load (intermittent failures).
    expect(await screen.findByText('Selected')).toBeInTheDocument();
    expect(screen.getByText(/No losses found/i)).toBeInTheDocument();
  });
});
