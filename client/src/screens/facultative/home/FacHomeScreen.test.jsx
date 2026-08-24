// FacHomeScreen — the facultative home page, rebuilt as the treaty home's
// twin. Covers the summary load feeding the stat grid + panels, the hero
// actions creating fac risks (prop / XL / quote), opening a risk from a
// panel row, and the renew picker listing bound risks. api + Topbar + the
// insights modal are mocked for a hermetic render; the global router mock
// (test/setup.js) supplies navigation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { apiMock, setActiveFacRiskIdMock } = vi.hoisted(() => ({
  apiMock: { facHomeSummary: vi.fn(), facCreateRisk: vi.fn(), facDeleteRisk: vi.fn() },
  setActiveFacRiskIdMock: vi.fn(),
}));
vi.mock('../../../api', () => ({ api: apiMock }));
vi.mock('../../../components/Topbar', () => ({ default: ({ title, actions }) => <div data-testid="topbar">{title}{actions}</div> }));
vi.mock('../../../hooks/useContractId', () => ({ setActiveFacRiskId: setActiveFacRiskIdMock }));
vi.mock('../../insights/ProfitabilityInsightsModal', () => ({ default: () => null }));

const { default: FacHomeScreen } = await import('./FacHomeScreen.jsx');

const SUMMARY = {
  stats: { total: 7, drafts: 2, quoted: 1, referred: 1, bound: 2, ntu: 0, declined: 1, bound_premium: 2_500_000 },
  drafts: [
    { id: 'r-d1', fac_ref: 'FAC-2026-0001', insured_name: 'Acme Refinery', status: 'DRAFT', placement_type: 'PROPORTIONAL', uw_year: 2026, cedant_name: 'Gulf Cedant', country: 'Saudi Arabia', cob: 'Property All Risks', updated_at: '2026-08-01T00:00:00Z' },
  ],
  quotes: [
    { id: 'r-q1', fac_ref: 'FAC-2026-0002', insured_name: 'Delta Towers', status: 'QUOTED', placement_type: 'NON_PROPORTIONAL', uw_year: 2026, cedant_name: 'Gulf Cedant', country: 'UAE', cob: 'Industrial All Risks', updated_at: '2026-08-02T00:00:00Z' },
  ],
  renewals: [
    { id: 'r-r1', fac_ref: 'FAC-2025-0009', insured_name: 'Expiring Plant', status: 'BOUND', placement_type: 'PROPORTIONAL', uw_year: 2025, cedant_name: 'Levant Cedant', country: 'Jordan', cob: 'Property All Risks', expiry_date: '2026-09-15', updated_at: '2026-07-01T00:00:00Z' },
  ],
  submitted: [
    { id: 'r-s1', fac_ref: 'FAC-2026-0003', insured_name: 'Bound Mall', status: 'BOUND', placement_type: 'PROPORTIONAL', uw_year: 2026, cedant_name: 'Gulf Cedant', country: 'Qatar', cob: 'Property All Risks', updated_at: '2026-08-03T00:00:00Z' },
  ],
  region_premiums: [{ region_bucket: 'Middle East', total_epi: 2_000_000 }],
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  apiMock.facHomeSummary.mockResolvedValue(SUMMARY);
  apiMock.facCreateRisk.mockResolvedValue({ fac_risk_id: 'r-new' });
});

describe('FacHomeScreen (treaty-home twin)', () => {
  it('loads the summary and renders the stat grid, region bars and panels', async () => {
    render(<FacHomeScreen />);
    expect(apiMock.facHomeSummary).toHaveBeenCalled();
    await screen.findByText('RISKS MODELLED');
    // 3×3 overview reflects the fac stats payload
    expect(screen.getByText('BOUND PREMIUM')).toBeInTheDocument();
    expect(await screen.findByText('$2.5M')).toBeInTheDocument();
    expect(screen.getByText('PREMIUM BY REGION')).toBeInTheDocument();
    // one row in each panel
    expect(await screen.findByText('Acme Refinery')).toBeInTheDocument();
    expect(screen.getByText('Delta Towers')).toBeInTheDocument();
    expect(screen.getByText('Expiring Plant')).toBeInTheDocument();
    expect(screen.getByText('Bound Mall')).toBeInTheDocument();
    // fac panels, not treaty ones
    expect(screen.getByText('DRAFT FAC RISKS')).toBeInTheDocument();
    // stat card + panel title both carry this label (same as the treaty home)
    expect(screen.getAllByText('UPCOMING RENEWALS').length).toBe(2);
  });

  it('hero actions create a fac risk with the chosen placement (quote flag for Quote)', async () => {
    render(<FacHomeScreen />);
    await screen.findByText('RISKS MODELLED');

    fireEvent.click(screen.getByRole('button', { name: /Assess XL Fac Risk/ }));
    await waitFor(() => expect(apiMock.facCreateRisk).toHaveBeenCalledWith(
      expect.objectContaining({ placement_type: 'NON_PROPORTIONAL', status: 'DRAFT' })));
    await waitFor(() => expect(setActiveFacRiskIdMock).toHaveBeenCalledWith('r-new', { quote: false }));

    apiMock.facCreateRisk.mockClear(); setActiveFacRiskIdMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Quote Fac Risk/ }));
    await waitFor(() => expect(apiMock.facCreateRisk).toHaveBeenCalledWith(
      expect.objectContaining({ placement_type: 'PROPORTIONAL' })));
    await waitFor(() => expect(setActiveFacRiskIdMock).toHaveBeenCalledWith('r-new', { quote: true }));
  });

  it('opening a panel row selects that risk', async () => {
    render(<FacHomeScreen />);
    await screen.findByText('Acme Refinery');
    fireEvent.click(screen.getByText('Acme Refinery'));
    expect(setActiveFacRiskIdMock).toHaveBeenCalledWith('r-d1');
  });

  it('the renew picker lists bound risks and opens the chosen one in quote mode', async () => {
    render(<FacHomeScreen />);
    await screen.findByText('RISKS MODELLED');
    fireEvent.click(screen.getByRole('button', { name: /Renew Fac Risk/ }));
    const dialog = within(await screen.findByRole('dialog'));
    // bound risks from renewals + history, de-duplicated
    expect(dialog.getByText('Expiring Plant')).toBeInTheDocument();
    fireEvent.click(dialog.getByText('Bound Mall'));
    expect(setActiveFacRiskIdMock).toHaveBeenCalledWith('r-s1', { quote: true });
  });

  it('clicking an upcoming renewal asks for confirmation, then renews', async () => {
    render(<FacHomeScreen />);
    await screen.findByText('Expiring Plant');
    fireEvent.click(screen.getByText('Expiring Plant'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Yes, Renew' }));
    expect(setActiveFacRiskIdMock).toHaveBeenCalledWith('r-r1', { quote: true });
  });
});
