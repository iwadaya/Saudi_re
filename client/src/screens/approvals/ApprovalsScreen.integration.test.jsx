import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import ApprovalsScreen from './ApprovalsScreen.jsx';
import { renderBindScreen } from '../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock } from '../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function renderScreen() {
  return renderBindScreen(<ApprovalsScreen />, {
    route: '/approvals',
    contractId: bindIds.contract,
    appState: { wizardMode: 'PROP' },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetApi();
});

describe('ApprovalsScreen integration', () => {
  it('approves an offer and moves it to the decided list', async () => {
    renderScreen();

    expect(await screen.findByText('Audit Cedant')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    await waitFor(() => expect(apiMock.markOfferApproved).toHaveBeenCalledWith(
      bindIds.contract,
      expect.objectContaining({ _actor: 'Chief Underwriter' }),
      undefined,
    ));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
  });

  it('declines an offer and captures the decline reason', async () => {
    renderScreen();

    expect(await screen.findByText('Audit Cedant')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.change(screen.getByLabelText(/decline reason/i), { target: { value: 'Capacity exhausted' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm decline/i }));

    await waitFor(() => expect(apiMock.declineContract).toHaveBeenCalledWith(
      bindIds.contract,
      'Capacity exhausted',
      expect.objectContaining({ body: expect.objectContaining({ reason: 'Capacity exhausted' }) }),
    ));
    expect(await screen.findByText('Declined')).toBeInTheDocument();
    expect(screen.getByText(/capacity exhausted/i)).toBeInTheDocument();
  });

  it('shows a toast when approval fails', async () => {
    apiMock.markOfferApproved.mockRejectedValueOnce(new Error('approval network failure'));
    renderScreen();

    expect(await screen.findByText('Audit Cedant')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    expect(await screen.findByText(/approval failed: approval network failure/i)).toBeInTheDocument();
  });
});
