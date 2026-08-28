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
  it('a finalized approval moves the item to decided with the SERVER status and the real actor', async () => {
    // The server finalizes the decision: recordPeerDecision reports
    // AWAITING_SIGNED_LINE + complete. The decided row must show that status
    // (not a hardcoded APPROVED) and the authenticated user's name (from the
    // session — 'Chief Underwriter' here), not a fabricated label.
    apiMock.markOfferApproved.mockResolvedValueOnce({
      ok: true, nextStatus: 'AWAITING_SIGNED_LINE', finalDecision: 'APPROVED', complete: true,
    });
    renderScreen();

    expect(await screen.findByText('Audit Cedant')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    await waitFor(() => expect(apiMock.markOfferApproved).toHaveBeenCalledWith(
      bindIds.contract,
      expect.objectContaining({ _actor: 'Chief Underwriter' }),
      undefined,
    ));
    expect(await screen.findByText('Awaiting Signed Line')).toBeInTheDocument();
    expect(await screen.findByText(/PROP · Chief Underwriter/)).toBeInTheDocument();
  });

  it('a NON-final peer approval keeps the item pending instead of fabricating a decision', async () => {
    // recordPeerDecision on a two-approver offer: the first approval is
    // recorded but the offer still awaits a second approver. The row must NOT
    // move to decided (the old screen hardcoded APPROVED / 'Chief Underwriter'
    // for every actor).
    apiMock.markOfferApproved.mockResolvedValueOnce({
      ok: true, nextStatus: 'AWAITING_APPROVAL', finalDecision: null, complete: false,
    });
    renderScreen();

    expect(await screen.findByText('Audit Cedant')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    expect(await screen.findByText(/awaiting a second approval/i)).toBeInTheDocument();
    expect(screen.queryByText('Awaiting Signed Line')).not.toBeInTheDocument();
    // Still pending: the row re-fetches from the server and keeps its Approve control.
    expect(await screen.findByRole('button', { name: /^approve$/i })).toBeInTheDocument();
  });

  it('a split decision resolved against approval lands in decided as DECLINED', async () => {
    // approve() can finalize as DECLINED (a CU/CE split resolves the other
    // way) — the screen must show what the server decided, not APPROVED.
    apiMock.markOfferApproved.mockResolvedValueOnce({
      ok: true, nextStatus: 'DECLINED', finalDecision: 'DECLINED', complete: true,
    });
    renderScreen();

    expect(await screen.findByText('Audit Cedant')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    expect(await screen.findByText('Declined')).toBeInTheDocument();
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
