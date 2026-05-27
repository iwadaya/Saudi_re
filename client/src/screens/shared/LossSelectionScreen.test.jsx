import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
