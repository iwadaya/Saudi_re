// ClaimsHomeScreen — the claims register plus the New Claim wizard. The
// wizard's per-tab validation is the important surface: it is what stops a
// claim being booked without a treaty or a loss date, so it is asserted
// here rather than left to the server's 4xx.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getClaimsSummary: vi.fn(),
  listClaims: vi.fn(),
  getClaimsEligibleContracts: vi.fn(),
  createClaim: vi.fn(),
  submitClaim: vi.fn(),
  uploadClaimDocument: vi.fn(),
}));
vi.mock('../../api', () => ({ api: apiMock }));

vi.mock('../../components/Topbar', () => ({
  __esModule: true,
  default: ({ title, actions }) => <div data-testid="topbar">{title}{actions}</div>,
}));

vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

// Stub the router outright (the FacDocuments/SsoCallback convention). A real
// MemoryRouter is not an option here: react-router resolves to the client's
// own React copy, so its internal state never propagates under the root-React
// alias this config forces — navigate() silently no-ops. Link still renders a
// real <a href> so the "claim ref is keyboard-reachable" assertion is honest.
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({
  __esModule: true,
  useNavigate: () => navigateMock,
  Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a>,
}));

import ClaimsHomeScreen from './ClaimsHomeScreen.jsx';

const SUMMARY = {
  total_claims: 5, open_claims: 3, cat_claims: 1, draft_claims: 1,
  waiting_approval_claims: 2, rejected_claims: 0, finalised_claims: 2,
  total_paid_our_share: 900000, open_incurred_our_share: 400000, open_os_our_share: 100000,
};

const CLAIM = {
  claim_id: 'c1', claim_ref: 'CLM-2026-0001', cedant_name: 'Gulf Insurance',
  treaty_type: 'XOL', uw_year: 2026, insured_name: 'Acme Petrochem',
  loss_date: '2026-02-11', loss_type: 'LARGE', approval_status: 'WAITING_APPROVAL',
  status: 'OPEN', gross_incurred_100: 8000000, incurred_our_share: 2000000,
  os_our_share: 500000, currency_code: 'USD',
};

const CONTRACT = {
  contract_id: 'k1', cedant_id: 'ced1', cedant_name: 'Gulf Insurance', country_id: 'sa',
  country_name: 'Saudi Arabia', treaty_type: 'XOL', uw_year: 2026, signed_line_pct: 25,
  currency_code: 'USD', contract_description: 'Property XOL 2026',
};

const renderScreen = () => render(<ClaimsHomeScreen />);

/** Scope queries to the register so filter <option>s don't collide. */
const register = () => within(screen.getByRole('table'));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getClaimsSummary.mockResolvedValue(SUMMARY);
  apiMock.listClaims.mockResolvedValue([CLAIM]);
  apiMock.getClaimsEligibleContracts.mockResolvedValue([CONTRACT]);
  apiMock.createClaim.mockResolvedValue({ claim_id: 'new1', claim_ref: 'CLM-2026-0002' });
  apiMock.submitClaim.mockResolvedValue({ ok: true });
});

describe('ClaimsHomeScreen register', () => {
  it('renders KPIs and a claim row', async () => {
    renderScreen();
    expect(await screen.findByText('Gulf Insurance')).toBeInTheDocument();
    expect(register().getByText('Acme Petrochem')).toBeInTheDocument();
    expect(register().getByText('WAITING APPROVAL')).toBeInTheDocument();
    expect(register().getByText('OPEN')).toBeInTheDocument();
    // Our share of the incurred position, thousands-separated.
    expect(register().getByText('2,000,000')).toBeInTheDocument();
  });

  it('exposes the claim as a real link so it is keyboard-reachable', async () => {
    renderScreen();
    const link = await screen.findByRole('link', { name: 'CLM-2026-0001' });
    expect(link).toHaveAttribute('href', '/claims/c1');
  });

  it('refetches when a filter changes', async () => {
    renderScreen();
    await screen.findByText('Gulf Insurance');
    fireEvent.change(screen.getByLabelText('Filter by loss type'), { target: { value: 'CAT' } });
    await waitFor(() => expect(apiMock.listClaims).toHaveBeenLastCalledWith(
      expect.objectContaining({ lossType: 'CAT' }),
    ));
  });

  it('surfaces a load failure as an alert', async () => {
    apiMock.listClaims.mockRejectedValue(new Error('boom'));
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load claims');
  });
});

describe('New Claim wizard', () => {
  const openWizard = async () => {
    renderScreen();
    await screen.findByText('Gulf Insurance');
    fireEvent.click(screen.getByRole('button', { name: '+ New Claim' }));
    return screen.findByRole('dialog');
  };

  it('blocks Next while no treaty is selected', async () => {
    const dialog = await openWizard();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next →' }));
    expect(await within(dialog).findByRole('alert'))
      .toHaveTextContent('Select the treaty the claim attaches to.');
    // Still on step 1.
    expect(within(dialog).getByRole('tab', { name: '1 · Details' })).toHaveAttribute('aria-selected', 'true');
  });

  it('blocks Next when a treaty is chosen but the loss date is missing', async () => {
    const dialog = await openWizard();
    await waitFor(() => expect(apiMock.getClaimsEligibleContracts).toHaveBeenCalled());
    fireEvent.change(within(dialog).getByLabelText(/^Treaty \(SIGNED \/ BOUND only/), { target: { value: 'k1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next →' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Loss date is required.');
  });

  it('advances to the amounts step once details are valid', async () => {
    const dialog = await openWizard();
    await waitFor(() => expect(apiMock.getClaimsEligibleContracts).toHaveBeenCalled());
    fireEvent.change(within(dialog).getByLabelText(/^Treaty \(SIGNED \/ BOUND only/), { target: { value: 'k1' } });
    fireEvent.change(within(dialog).getByLabelText(/^Loss date/), { target: { value: '2026-04-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next →' }));

    expect(await within(dialog).findByRole('tab', { name: '2 · Claim Amounts' }))
      .toHaveAttribute('aria-selected', 'true');
    // The preview applies our signed line to the 100% position.
    expect(within(dialog).getByText(/Our line \(25%\)/)).toBeInTheDocument();
  });

  it('creates the claim and navigates to it, without submitting for approval', async () => {
    const dialog = await openWizard();
    await waitFor(() => expect(apiMock.getClaimsEligibleContracts).toHaveBeenCalled());
    fireEvent.change(within(dialog).getByLabelText(/^Treaty \(SIGNED \/ BOUND only/), { target: { value: 'k1' } });
    fireEvent.change(within(dialog).getByLabelText(/^Loss date/), { target: { value: '2026-04-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next →' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Next →' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Create Draft' }));

    await waitFor(() => expect(apiMock.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ contract_id: 'k1', loss_date: '2026-04-01' }),
    ));
    expect(apiMock.submitClaim).not.toHaveBeenCalled();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/claims/new1'));
  });

  it('submits for approval when that action is chosen', async () => {
    const dialog = await openWizard();
    await waitFor(() => expect(apiMock.getClaimsEligibleContracts).toHaveBeenCalled());
    fireEvent.change(within(dialog).getByLabelText(/^Treaty \(SIGNED \/ BOUND only/), { target: { value: 'k1' } });
    fireEvent.change(within(dialog).getByLabelText(/^Loss date/), { target: { value: '2026-04-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next →' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Next →' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Create & Send for Approval' }));

    await waitFor(() => expect(apiMock.submitClaim).toHaveBeenCalledWith('new1'));
  });
});
