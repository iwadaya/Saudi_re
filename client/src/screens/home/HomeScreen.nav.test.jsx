// Treaty home → module picker navigation.
//
// The treaty home is a landing screen, so it needs a way back out to the
// Treaty / Facultative / Claims / Finance picker at /select — the Facultative
// home has had one ("← Switch Product") for a while and this is its counterpart.
//
// Topbar is mocked to render its `actions` slot (the main HomeScreen spec stubs
// it out entirely), and react-router-dom is mocked locally so the navigate spy
// is reachable from the assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HomeScreen from './HomeScreen.jsx';
import { setSession } from '../../utils/auth';

const { apiMock, navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
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
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));
vi.mock('../../components/Topbar', () => ({
  default: ({ actions }) => actions ?? null,
  useViewingUser: () => null,
  setViewingUser: vi.fn(),
}));
vi.mock('../../context/AppContext', () => ({ useAppState: () => ({ resetFlow: vi.fn() }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

beforeEach(() => {
  const empty = { drafts: [], submitted: [], renewals: [], quotes: [], region_premiums: [], stats: {} };
  apiMock.getHomeSummary.mockResolvedValue(empty);
  apiMock.getHomeSummaryFor.mockResolvedValue(empty);
  apiMock.getContractsAll.mockResolvedValue([]);
  apiMock.getViewableUsers.mockResolvedValue([]);
  apiMock.getAssignmentHistory.mockResolvedValue([]);
  setSession({ userId: 'me', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'Me' });
});

describe('HomeScreen — leaving the treaty module', () => {
  it('offers a control back to the module picker', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: /switch product/i })).toBeInTheDocument());
  });

  it('navigates to /select when it is clicked', async () => {
    render(<HomeScreen />);
    const btn = await screen.findByRole('button', { name: /switch product/i });
    fireEvent.click(btn);
    expect(navigateMock).toHaveBeenCalledWith('/select');
  });
});
