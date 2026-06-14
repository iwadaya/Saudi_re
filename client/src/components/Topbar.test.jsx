// Topbar Settings: the "View treaties" tickbox writes the per-user preference.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Topbar from './Topbar.jsx';
import { setSession, clearSession } from '../utils/auth';
import { getViewAllTreaties } from '../utils/prefs';

const { apiMock } = vi.hoisted(() => ({ apiMock: { getViewableUsers: vi.fn().mockResolvedValue([]) } }));
vi.mock('../api', () => ({ api: apiMock }));

afterEach(() => { cleanup(); localStorage.clear(); clearSession(); vi.clearAllMocks(); });
beforeEach(() => { setSession({ userId: 'me', roleCode: 'CU', hierarchyLevel: 2, displayName: 'Me' }); });

describe('Topbar — View treaties preference', () => {
  it('shows a working tickbox in Settings (default off → on, persisted)', () => {
    render(<Topbar title="X" />);
    fireEvent.click(screen.getByRole('button', { name: /SETTINGS/i }));

    expect(screen.getByText('View treaties')).toBeInTheDocument();
    const box = screen.getByRole('checkbox');
    expect(box).not.toBeChecked();

    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(getViewAllTreaties('me')).toBe(true);
  });
});
