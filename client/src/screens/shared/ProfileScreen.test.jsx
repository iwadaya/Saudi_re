// Phase-2.2 migration test: ProfileScreen's primary bands+profile fetch now
// rides useResource with an AsyncBoundary, so the loading→loaded and
// loading→error transitions are part of the screen's contract.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getContractCobs: vi.fn(),
  getSwissReCurves: vi.fn(),
  getRiskProfile: vi.fn(),
  saveRiskProfile: vi.fn(),
  getClaimsProfile: vi.fn(),
  saveClaimsProfile: vi.fn(),
}));
vi.mock('../../api', () => ({ __esModule: true, default: apiMock, api: apiMock }));
vi.mock('../../hooks/useContractId', () => ({
  __esModule: true,
  default: () => 'C-1',
  useContractId: () => 'C-1',
}));
vi.mock('../../components/WizardLayout', () => ({
  __esModule: true,
  default: function FakeWizardLayout({ children }) {
    return <div>{typeof children === 'function' ? children() : children}</div>;
  },
}));

import ProfileScreen from './ProfileScreen';

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getContractCobs.mockResolvedValue([{ class_of_business_id: 'COB-1', name: 'Fire' }]);
  apiMock.getSwissReCurves.mockResolvedValue([]);
});

describe('ProfileScreen', () => {
  it('transitions loading → loaded and hydrates the band table', async () => {
    let resolveLoad;
    apiMock.getRiskProfile.mockReturnValue(
      new Promise((resolve) => { resolveLoad = resolve; }),
    );

    render(<ProfileScreen routeKey="RISK_PROFILE" title="Risk Profile" />);

    // COB resolution selects the first class, which kicks off the profile
    // fetch → boundary shows while it is in flight.
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/loading profile/i);

    resolveLoad({
      bands: [{ from_amt: 0, to_amt: 100000, no_of_risks: 10, total_sum_insured: 5000000, gross_premium: 250000 }],
      profile: { c_value: 0.035, pml_percentage: 80 },
    });

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    // hydrated band cell (comma-formatted) + computed rate (250k / 5m = 5.000%)
    expect(screen.getByDisplayValue('5,000,000')).toBeInTheDocument();
    expect(screen.getAllByText('5.000%').length).toBeGreaterThan(0);
    // primary fetch carries the abort signal so deps changes cancel in flight
    expect(apiMock.getRiskProfile).toHaveBeenCalledWith(
      'C-1', 'COB-1', expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('transitions loading → error and recovers via Retry', async () => {
    apiMock.getRiskProfile
      .mockRejectedValueOnce(Object.assign(new Error('API GET → 500: down'), { status: 500 }))
      .mockResolvedValueOnce({ bands: [], profile: null });

    render(<ProfileScreen routeKey="RISK_PROFILE" title="Risk Profile" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(apiMock.getRiskProfile).toHaveBeenCalledTimes(2);
    // band table is back (empty default rows)
    expect(screen.getByText('Min Sum Insured')).toBeInTheDocument();
  });
});
