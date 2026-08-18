// FinanceHomeScreen — the signed-treaty ledger. Covers the load/render path,
// the status filter refetch, and the acknowledge action (PENDING_SETUP →
// ACTIVE), which is the module's only mutation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getFinanceSummary: vi.fn(),
  listFinanceTreaties: vi.fn(),
  acknowledgeFinanceEntry: vi.fn(),
}));
vi.mock('../../api', () => ({ api: apiMock }));

// Topbar drags in session/auth/theme state that this screen doesn't own.
vi.mock('../../components/Topbar', () => ({
  __esModule: true,
  default: ({ title }) => <div data-testid="topbar">{title}</div>,
}));

vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import FinanceHomeScreen from './FinanceHomeScreen.jsx';

const SUMMARY = { pending_setup: 2, active: 7, epi_our_share_total: 1234567, total_entries: 9 };

const ENTRY = {
  entry_id: 'e1', cedant_name: 'Gulf Insurance', treaty_type: 'QS', country_name: 'Saudi Arabia',
  uw_year: 2026, pushed_at: '2026-03-04T00:00:00Z', source: 'SIGNED', signed_line_pct: 25,
  epi_100: 4000000, epi_our_share: 1000000, paid_our_share: 50000, os_our_share: 25000,
  currency_code: 'USD', status: 'PENDING_SETUP',
};

/** Scope queries to the ledger so the filter <option>s don't collide. */
const ledger = () => within(screen.getByRole('table'));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getFinanceSummary.mockResolvedValue(SUMMARY);
  apiMock.listFinanceTreaties.mockResolvedValue([ENTRY]);
  apiMock.acknowledgeFinanceEntry.mockResolvedValue({ ok: true });
});

describe('FinanceHomeScreen', () => {
  it('renders the KPI tiles and a ledger row', async () => {
    render(<FinanceHomeScreen />);
    expect(await screen.findByText('Gulf Insurance')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Setup')).toBeInTheDocument();
    // EPI our share is formatted with thousands separators.
    expect(screen.getByText('1,234,567')).toBeInTheDocument();
    expect(ledger().getByText('PENDING SETUP')).toBeInTheDocument();
  });

  it('refetches with the status filter applied', async () => {
    render(<FinanceHomeScreen />);
    await screen.findByText('Gulf Insurance');
    expect(apiMock.listFinanceTreaties).toHaveBeenLastCalledWith(undefined);

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'ACTIVE' } });
    await waitFor(() => expect(apiMock.listFinanceTreaties).toHaveBeenLastCalledWith('ACTIVE'));
  });

  it('acknowledges a pending entry and reloads the ledger', async () => {
    render(<FinanceHomeScreen />);
    const btn = await screen.findByRole('button', { name: 'Acknowledge' });
    fireEvent.click(btn);
    await waitFor(() => expect(apiMock.acknowledgeFinanceEntry).toHaveBeenCalledWith('e1'));
    // A reload follows the mutation so the row's status reflects the change.
    await waitFor(() => expect(apiMock.listFinanceTreaties).toHaveBeenCalledTimes(2));
  });

  it('offers no acknowledge action once an entry is ACTIVE', async () => {
    apiMock.listFinanceTreaties.mockResolvedValue([{ ...ENTRY, status: 'ACTIVE' }]);
    render(<FinanceHomeScreen />);
    await screen.findByText('Gulf Insurance');
    expect(ledger().getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });

  it('surfaces a load failure as an alert instead of an empty table', async () => {
    apiMock.getFinanceSummary.mockRejectedValue(new Error('boom'));
    render(<FinanceHomeScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load the finance ledger');
  });
});
