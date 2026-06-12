// Phase-2 migration test: the screen's primary data fetch now rides
// useScreenSave→useResource with an AsyncBoundary, so the loading→loaded
// and loading→error transitions are part of the screen's contract.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getNpHistoricalPerformance: vi.fn(),
  saveNpHistoricalPerformance: vi.fn(),
}));
vi.mock('../../../api', () => ({ __esModule: true, default: apiMock, api: apiMock }));
vi.mock('../../../hooks/useContractId', () => ({ useContractId: () => 'C-1' }));
vi.mock('../../../components/WizardLayout', () => ({
  __esModule: true,
  default: function FakeWizardLayout({ children }) {
    return <div>{typeof children === 'function' ? children() : children}</div>;
  },
}));
vi.mock('../../../context/AppContext', () => ({
  useAppState: () => ({
    state: {
      quoteMode: false,
      npTreatyDetail: { startYear: '2020', experienceStartYear: '2018' },
    },
    setSlice: vi.fn(),
    replaceSlice: vi.fn(),
  }),
}));

import NpHistoricalPerformance from './NpHistoricalPerformance';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NpHistoricalPerformance', () => {
  it('transitions loading → loaded and hydrates the table', async () => {
    let resolveLoad;
    apiMock.getNpHistoricalPerformance.mockReturnValue(
      new Promise((resolve) => { resolveLoad = resolve; }),
    );

    render(<NpHistoricalPerformance />);

    // boundary shows while the fetch is in flight
    expect(screen.getByRole('status')).toHaveTextContent(/loading historical performance/i);

    resolveLoad([{ uw_year: 2019, premiums: 1000000, claims: 250000, egnpi: 900000, expense_ratio: 12 }]);

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    // hydrated editable cell (comma-formatted) + computed loss ratio
    expect(screen.getByDisplayValue('1,000,000')).toBeInTheDocument();
    expect(screen.getAllByText('25.0%').length).toBeGreaterThan(0);
  });

  it('transitions loading → error and recovers via Retry', async () => {
    apiMock.getNpHistoricalPerformance
      .mockRejectedValueOnce(Object.assign(new Error('API GET → 500: down'), { status: 500 }))
      .mockResolvedValueOnce([]);

    render(<NpHistoricalPerformance />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(apiMock.getNpHistoricalPerformance).toHaveBeenCalledTimes(2);
    expect(screen.getByText('UW Year')).toBeInTheDocument();
  });
});
