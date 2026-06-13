// HomeScreen ownership UX: Mine/Everyone toggle, per-row lock + allocate
// actions, and the ownership-trail modal. The api + Topbar + AppContext are
// mocked so the screen renders without a backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import HomeScreen from './HomeScreen.jsx';
import { setSession } from '../../utils/auth';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getHomeSummary: vi.fn(),
    getHomeSummaryFor: vi.fn(),
    getContractsAll: vi.fn(),
    getViewableUsers: vi.fn(),
    allocateContract: vi.fn(),
    reassignContract: vi.fn(),
    getAssignmentHistory: vi.fn(),
  },
}));

vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../components/Topbar', () => ({
  default: () => null,
  useViewingUser: () => null,
  setViewingUser: vi.fn(),
}));
vi.mock('../../context/AppContext', () => ({ useAppState: () => ({ resetFlow: vi.fn() }) }));

// scope='all' roster: my own (editable), a peer's (locked), and an unassigned one.
const ALL_ROWS = [
  { id: 'c-mine', cedantName: 'My Cedant', country: 'SA', uwYear: 2026, treatyType: 'XL', assignedToUserId: 'me', assignedToName: 'Me', canEdit: true, isOwner: true },
  { id: 'c-peer', cedantName: 'Peer Cedant', country: 'AE', uwYear: 2026, treatyType: 'QS', assignedToUserId: 'other', assignedToName: 'Grace Hopper', canEdit: false, isOwner: false },
  { id: 'c-free', cedantName: 'Unclaimed Cedant', country: 'KW', uwYear: 2026, treatyType: 'XL', assignedToUserId: null, assignedToName: null, canEdit: true, isOwner: false },
];

function login(level) {
  setSession({ userId: 'me', roleCode: level <= 2 ? 'CU' : level <= 3 ? 'TD' : 'TUW', hierarchyLevel: level, displayName: 'Me' });
}

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

beforeEach(() => {
  apiMock.getHomeSummary.mockResolvedValue({ drafts: [], submitted: [], renewals: [], quotes: [], region_premiums: [], stats: {} });
  apiMock.getHomeSummaryFor.mockResolvedValue({ drafts: [], submitted: [], renewals: [], quotes: [], region_premiums: [], stats: {} });
  apiMock.getContractsAll.mockResolvedValue(ALL_ROWS);
  apiMock.getViewableUsers.mockResolvedValue([{ user_id: 'u-uw', display_name: 'Ada Lovelace', role_code: 'UW' }]);
  apiMock.allocateContract.mockResolvedValue({ allocated: true });
  apiMock.reassignContract.mockResolvedValue({ assigned: true });
  apiMock.getAssignmentHistory.mockResolvedValue([
    { history_id: 'h1', action: 'ASSIGNED', to_name: 'Me', to_role: 'TUW', by_name: 'Me', assigned_at: '2026-06-01T00:00:00Z' },
  ]);
});

describe('HomeScreen — Mine/Everyone scope', () => {
  it('defaults an Underwriter (level 5) to Mine; switching to Everyone lists all with locked rows', async () => {
    login(5);
    render(<HomeScreen />);
    // Default 'Mine' for an underwriter — the all-treaties list is not shown yet.
    expect(screen.getByRole('tab', { name: 'Mine' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('ALL TREATIES')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Everyone' }));
    expect(await screen.findByText('ALL TREATIES')).toBeInTheDocument();
    await waitFor(() => expect(apiMock.getContractsAll).toHaveBeenCalledWith({ scope: 'all' }));
    expect(await screen.findByText('Peer Cedant')).toBeInTheDocument();
    // Peer's row is locked read-only.
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
  });

  it('defaults a senior (level 3) to Everyone', async () => {
    login(3);
    render(<HomeScreen />);
    expect(screen.getByRole('tab', { name: 'Everyone' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('ALL TREATIES')).toBeInTheDocument();
  });
});

describe('HomeScreen — allocation actions', () => {
  it('allocates an unassigned treaty to me', async () => {
    login(5);
    render(<HomeScreen />);
    fireEvent.click(screen.getByRole('tab', { name: 'Everyone' }));
    await screen.findByText('Unclaimed Cedant');
    fireEvent.click(screen.getByRole('button', { name: 'Allocate to me' }));
    await waitFor(() => expect(apiMock.allocateContract).toHaveBeenCalledWith('c-free', expect.any(String)));
  });

  it('allocates an owned treaty to a chosen underwriter via the picker → reassign', async () => {
    login(2); // CU — can edit my own row and reassign it
    render(<HomeScreen />);
    await screen.findByText('My Cedant');
    fireEvent.click(screen.getByRole('button', { name: 'Allocate to underwriter' }));
    // Picker lists viewable users
    const pick = await screen.findByRole('button', { name: /Ada Lovelace/ });
    fireEvent.click(pick);
    await waitFor(() => expect(apiMock.reassignContract).toHaveBeenCalledWith('c-mine', expect.objectContaining({ new_owner_id: 'u-uw' })));
  });

  it('opens the ownership trail modal for a treaty', async () => {
    login(2);
    render(<HomeScreen />);
    await screen.findByText('My Cedant');
    fireEvent.click(within(screen.getByText('My Cedant').closest('.own-row')).getByRole('button', { name: 'Ownership trail' }));
    await waitFor(() => expect(apiMock.getAssignmentHistory).toHaveBeenCalledWith('c-mine'));
    expect(await screen.findByText(/Ownership trail —/)).toBeInTheDocument();
    expect(await screen.findByText(/Assigned/)).toBeInTheDocument();
  });
});
