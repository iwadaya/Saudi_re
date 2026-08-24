// A sidebar step jump has to obey the same save contract as Back/Next:
// run the screen's save, and block the navigation if it fails.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WizardLayout from './WizardLayout.jsx';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  // useWizard → useContractId reads router state for the active-entity id.
  useLocation: () => ({ state: null }),
}));
vi.mock('../context/AppContext', () => ({
  useAppState: () => ({ state: {}, setState: vi.fn(), appState: { settings: {} }, setApp: vi.fn() }),
}));
vi.mock('./FacPendingRecsBanner', () => ({ default: () => null }));
vi.mock('./ThemeSwitcher', () => ({ default: () => null }));
vi.mock('../utils/logout', () => ({ performLogout: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderLayout = (save) => render(
  <WizardLayout routeKey="FAC_RISK_DETAIL" title="Risk Detail" onBeforeNext={save} onBeforeBack={save}>
    <div>body</div>
  </WizardLayout>,
);

describe('WizardLayout — sidebar step navigation', () => {
  it('saves before jumping to another step', async () => {
    const save = vi.fn().mockResolvedValue(true);
    renderLayout(save);

    fireEvent.click(screen.getByRole('button', { name: 'Locations & SI' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(expect.stringMatching(/\/fac\/risk\/locations/)));
  });

  it('blocks the jump when the save fails, so edits are not stranded', async () => {
    const save = vi.fn().mockResolvedValue(false);
    renderLayout(save);

    fireEvent.click(screen.getByRole('button', { name: 'Locations & SI' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('blocks the jump when the save throws', async () => {
    const save = vi.fn().mockRejectedValue(new Error('server down'));
    renderLayout(save);

    fireEvent.click(screen.getByRole('button', { name: 'Locations & SI' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
