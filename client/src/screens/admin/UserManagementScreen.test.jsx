// UserManagementScreen — admin user + mandate management. Covers the CE/CU access
// guard, the role-grouped user list, search filtering, the Add-User flow, and the
// Mandate editor. api + auth + Topbar are mocked so the test is hermetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    getUsers: vi.fn(),
    getRoles: vi.fn(),
    createUser: vi.fn(),
    setUserMandate: vi.fn(),
  },
  authMock: { isAtLeast: vi.fn(), ROLE_LABELS: { CU: 'Chief Underwriter', TUW: 'Treaty Underwriter' } },
}));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../utils/auth', () => authMock);
vi.mock('../../components/Topbar', () => ({ default: ({ title }) => <div data-testid="topbar">{title}</div> }));

const { default: UserManagementScreen } = await import('./UserManagementScreen.jsx');

const ROLES = [
  { role_id: 'r-cu', role_code: 'CU', role_name: 'Chief Underwriter', hierarchy_level: 2, authority_limit_usd: null },
  { role_id: 'r-uw', role_code: 'TUW', role_name: 'Treaty Underwriter', hierarchy_level: 5, authority_limit_usd: 10000000 },
];
const USERS = [
  { user_id: 'u-ada', display_name: 'Ada Lovelace', email: 'ada@x.com', role_code: 'TUW', role_name: 'Treaty Underwriter', is_active: true, treaty_limit_usd: 10000000, treaty_type_scope: 'BOTH' },
  { user_id: 'u-grace', display_name: 'Grace Hopper', email: 'grace@x.com', role_code: 'CU', role_name: 'Chief Underwriter', is_active: true, treaty_limit_usd: null, treaty_type_scope: 'BOTH' },
];

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  authMock.isAtLeast.mockReturnValue(true); // CE/CU by default
  apiMock.getUsers.mockResolvedValue(USERS);
  apiMock.getRoles.mockResolvedValue(ROLES);
  apiMock.createUser.mockResolvedValue({ user_id: 'u-new' });
  apiMock.setUserMandate.mockResolvedValue({ ok: true });
});

describe('UserManagementScreen', () => {
  it('blocks access for users below Chief Underwriter (level > 2)', () => {
    authMock.isAtLeast.mockReturnValue(false);
    render(<UserManagementScreen />);
    expect(screen.getByText(/Access restricted to Chief Underwriter and Chief Executive/i)).toBeInTheDocument();
    // The role-grouped list is not rendered for a restricted user.
    expect(screen.queryByText('Platform Users')).toBeNull();
  });

  it('loads and renders users grouped by role', async () => {
    render(<UserManagementScreen />);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(apiMock.getUsers).toHaveBeenCalled();
    expect(apiMock.getRoles).toHaveBeenCalled();
  });

  it('filters the list by the search box', async () => {
    render(<UserManagementScreen />);
    await screen.findByText('Ada Lovelace');
    fireEvent.change(screen.getByPlaceholderText(/Search users/i), { target: { value: 'grace' } });
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
  });

  it('opens Add User and creates a user via the API', async () => {
    render(<UserManagementScreen />);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: /\+ Add User/i }));

    const dialog = await screen.findByRole('dialog');
    const d = within(dialog);
    fireEvent.change(d.getByPlaceholderText('Full name'), { target: { value: 'Alan Turing' } });
    fireEvent.change(d.getByPlaceholderText('username'), { target: { value: 'aturing' } });
    fireEvent.change(d.getByPlaceholderText('email@example.com'), { target: { value: 'alan@x.com' } });
    fireEvent.change(d.getByRole('combobox'), { target: { value: 'r-uw' } });
    fireEvent.click(d.getByRole('button', { name: /Create User/i }));

    await waitFor(() => expect(apiMock.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'aturing', display_name: 'Alan Turing', email: 'alan@x.com', role_id: 'r-uw' }),
    ));
  });

  it('Add User validates required fields before calling the API', async () => {
    render(<UserManagementScreen />);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: /\+ Add User/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Create User/i }));
    expect(within(dialog).getByText(/All fields except phone are required/i)).toBeInTheDocument();
    expect(apiMock.createUser).not.toHaveBeenCalled();
  });

  it('opens the Mandate editor for a user and saves it via the API', async () => {
    render(<UserManagementScreen />);
    await screen.findByText('Ada Lovelace');
    // Ada's row → her Mandate button. The name sits two divs deep in the row.
    const adaRow = screen.getByText('Ada Lovelace').parentElement.parentElement;
    fireEvent.click(within(adaRow).getByRole('button', { name: 'Mandate' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Mandate — Ada Lovelace/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Save Mandate/i }));
    await waitFor(() => expect(apiMock.setUserMandate).toHaveBeenCalledWith('u-ada', expect.any(Object)));
  });
});
