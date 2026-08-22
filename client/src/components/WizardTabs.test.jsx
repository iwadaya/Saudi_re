// Sidebar step navigation must save on the way out.
//
// It did not. WizardTabs called a bare navigate(), so jumping to another step
// from the sidebar silently discarded every unsaved edit on the current screen
// — while the Back/Next dock, which does save, is `wizard-dock--autohide` and
// usually not on screen. The sidebar is nine always-visible buttons, so it is
// the path users actually take, and the symptom was "nothing saves".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WizardTabs from './WizardTabs.jsx';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));
vi.mock('../context/AppContext', () => ({ useAppState: () => ({ state: {} }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const FIRST_FAC_STEP = 'FAC_RISK_DETAIL';

describe('WizardTabs', () => {
  it('routes a step click through onNavigate instead of navigating itself', async () => {
    const onNavigate = vi.fn();
    render(<WizardTabs activeKey={FIRST_FAC_STEP} onNavigate={onNavigate} />);

    const target = screen.getByRole('button', { name: 'Locations & SI' });
    fireEvent.click(target);

    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect(onNavigate.mock.calls[0][0]).toMatch(/\/fac\/risk\/locations/);
    // The save-aware handler owns navigation now; the tab must not jump on its own.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('still navigates directly when no handler is supplied', () => {
    // Keeps the component usable standalone rather than silently inert.
    render(<WizardTabs activeKey={FIRST_FAC_STEP} />);
    fireEvent.click(screen.getByRole('button', { name: 'Locations & SI' }));
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  it('marks the active step for assistive tech', () => {
    render(<WizardTabs activeKey={FIRST_FAC_STEP} onNavigate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Risk Detail' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'Locations & SI' })).not.toHaveAttribute('aria-current');
  });
});
