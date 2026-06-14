import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LoginScreen from './LoginScreen.jsx';
import { getSession } from '../../utils/auth';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getUsers: vi.fn(),
    getRoles: vi.fn(),
    createUser: vi.fn(),
    loginUser: vi.fn(),
  },
}));

vi.mock('../../api', () => ({ api: apiMock }));

const ADA = { user_id: 'u-ada', username: 'ada.lovelace', display_name: 'Ada Lovelace', email: 'ada.lovelace@universe3.app', role_code: 'UW', treaty_limit_usd: 25000000, approvals_required: 1 };
const GRACE = { user_id: 'u-grace', username: 'grace.hopper', display_name: 'Grace Hopper', email: 'grace.hopper@universe3.app', role_code: 'CU', treaty_limit_usd: null, approvals_required: 1 };
const TURING = { user_id: 'u-turing', username: 'alan.turing', display_name: 'Alan Turing', email: 'alan.turing@universe3.app', role_code: 'UW', treaty_limit_usd: 25000000, approvals_required: 1 };

// The "Add user" panel has its own Password / Confirm fields that share label
// text with the login Password field, so scope add-user queries to the panel.
async function openAddUserPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Add user \(test\)/i }));
  const title = await screen.findByText('Add User — Test Utility');
  return within(title.parentElement);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  localStorage.clear();
  apiMock.getUsers.mockResolvedValue([GRACE, ADA]);
  apiMock.getRoles.mockResolvedValue([{ role_id: 'r-uw', role_name: 'Underwriter' }, { role_id: 'r-cu', role_name: 'Chief Underwriter' }]);
  apiMock.createUser.mockResolvedValue(TURING);
  apiMock.loginUser.mockResolvedValue({ session: { userId: ADA.user_id, roleCode: 'UW', displayName: 'role-title-not-name' } });
});

describe('LoginScreen people dropdown', () => {
  it('lists every active user by name+surname from the DB', async () => {
    render(<LoginScreen />);
    const select = await screen.findByLabelText('Underwriter');
    expect(within(select).getByRole('option', { name: 'Grace Hopper' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Ada Lovelace' })).toBeInTheDocument();
    // No title / limit / badge anywhere on the screen — people by name only.
    expect(screen.queryByText('Treaty Limit')).toBeNull();
    expect(screen.queryByText('Chief Underwriter')).toBeNull();
  });

  it('renders the underwriter select and password input with an identical box model', async () => {
    render(<LoginScreen />);
    const select = await screen.findByLabelText('Underwriter');
    const input = screen.getByPlaceholderText('Enter your password');
    // The shared FIELD_STYLE is applied to both, so the box model can't drift.
    for (const prop of ['height', 'boxSizing', 'borderRadius', 'padding', 'borderTopWidth']) {
      expect(select.style[prop]).toBe(input.style[prop]);
    }
    expect(select.style.height).toBe('42px');
    expect(select.style.boxSizing).toBe('border-box');
    expect(input.style.height).toBe('42px');
    // Native select chrome is reset so its height matches the input.
    expect(select.style.appearance).toBe('none');
  });

  it('defaults to a blank placeholder (no user pre-selected) and keeps Sign In disabled until one is picked', async () => {
    render(<LoginScreen />);
    const select = await screen.findByLabelText('Underwriter');
    // Nothing pre-selected — the disabled placeholder is shown.
    expect(select.value).toBe('');
    expect(within(select).getByRole('option', { name: /Select underwriter/i })).toBeDisabled();
    // A password alone is not enough while no underwriter is chosen.
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'secret1' } });
    expect(screen.getByRole('button', { name: /Sign In/i })).toBeDisabled();
    // Picking a real user enables Sign In.
    fireEvent.change(select, { target: { value: ADA.user_id } });
    expect(screen.getByRole('button', { name: /Sign In/i })).toBeEnabled();
  });

  it('logs in as the selected user and stores their real name (not the role title)', async () => {
    render(<LoginScreen />);
    const select = await screen.findByLabelText('Underwriter');
    fireEvent.change(select, { target: { value: ADA.user_id } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'secret1' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));

    await waitFor(() => expect(apiMock.loginUser).toHaveBeenCalledWith({ username: 'ada.lovelace', password: 'secret1' }));
    await waitFor(() => expect(getSession()?.displayName).toBe('Ada Lovelace'));
  });
});

describe('LoginScreen Add user form', () => {
  it('creates a user with matching passwords and selects them in the dropdown', async () => {
    apiMock.getUsers
      .mockResolvedValueOnce([GRACE, ADA])            // mount
      .mockResolvedValueOnce([GRACE, ADA, TURING]);   // after create
    render(<LoginScreen />);
    await screen.findByLabelText('Underwriter');

    const panel = await openAddUserPanel();
    fireEvent.change(panel.getByLabelText('First name'), { target: { value: 'Alan' } });
    fireEvent.change(panel.getByLabelText('Surname'), { target: { value: 'Turing' } });
    fireEvent.change(panel.getByLabelText('Title'), { target: { value: 'r-uw' } });
    fireEvent.change(panel.getByLabelText('Password'), { target: { value: 'secret1' } });
    fireEvent.change(panel.getByLabelText('Confirm password'), { target: { value: 'secret1' } });

    fireEvent.click(panel.getByRole('button', { name: /Save user/i }));

    await waitFor(() => expect(apiMock.createUser).toHaveBeenCalledWith({
      first_name: 'Alan', surname: 'Turing', role_id: 'r-uw', password: 'secret1', confirm_password: 'secret1',
    }));
    // New user appears in the dropdown, selected, with a success line.
    const select = await screen.findByLabelText('Underwriter');
    await waitFor(() => expect(select.value).toBe(TURING.user_id));
    expect(within(select).getByRole('option', { name: 'Alan Turing' })).toBeInTheDocument();
    expect(screen.getByText(/Added Alan Turing/i)).toBeInTheDocument();
  });

  it('blocks Save with an inline message when passwords do not match', async () => {
    render(<LoginScreen />);
    await screen.findByLabelText('Underwriter');

    const panel = await openAddUserPanel();
    fireEvent.change(panel.getByLabelText('First name'), { target: { value: 'Alan' } });
    fireEvent.change(panel.getByLabelText('Surname'), { target: { value: 'Turing' } });
    fireEvent.change(panel.getByLabelText('Password'), { target: { value: 'secret1' } });
    fireEvent.change(panel.getByLabelText('Confirm password'), { target: { value: 'secret2' } });

    expect(panel.getByText('Passwords do not match')).toBeInTheDocument();
    expect(panel.getByRole('button', { name: /Save user/i })).toBeDisabled();
    expect(apiMock.createUser).not.toHaveBeenCalled();
  });

  it('surfaces a 4xx server error message from createUser', async () => {
    apiMock.createUser.mockRejectedValueOnce(new Error('Username already taken'));
    render(<LoginScreen />);
    await screen.findByLabelText('Underwriter');

    const panel = await openAddUserPanel();
    fireEvent.change(panel.getByLabelText('First name'), { target: { value: 'Alan' } });
    fireEvent.change(panel.getByLabelText('Surname'), { target: { value: 'Turing' } });
    fireEvent.change(panel.getByLabelText('Password'), { target: { value: 'secret1' } });
    fireEvent.change(panel.getByLabelText('Confirm password'), { target: { value: 'secret1' } });
    fireEvent.click(panel.getByRole('button', { name: /Save user/i }));

    expect(await screen.findByText('Username already taken')).toBeInTheDocument();
  });
});
