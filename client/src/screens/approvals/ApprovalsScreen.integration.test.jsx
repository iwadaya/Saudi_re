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

// ── F77 — disputed offers (DISPUTE_PENDING) are visible and arbitrable ───────
// A split peer decision parks the offer in DISPUTE_PENDING, a status in
// neither dashboard query before this fix — the dispute dead-ended unless
// someone hit the API by hand. The screen now lists disputed items in their
// own section and wires the arbitrate action to the existing server machinery
// (POST /treaties/:id/offer/arbiter-decision → recordArbiterSlot, which
// enforces TD/CU/CE authority and the peer/submitter exclusions).
describe('ApprovalsScreen — disputed offers and arbitration (F77)', () => {
  const disputedRow = {
    contract_id: 'contract-dispute-001',
    cedant_name: 'Disputed Cedant',
    treaty_type_name: 'Quota Share',
    treaty_category: 'PROPORTIONAL',
    status: 'DISPUTE_PENDING',
    written_line_pct: 20,
    updated_at: '2026-05-02T09:00:00.000Z',
  };

  function resetWithDispute({ canArbitrate = true } = {}) {
    resetApi({
      listContracts: vi.fn((params = {}) => {
        const status = String(params.status || '');
        if (status.includes('DISPUTE_PENDING')) return Promise.resolve([disputedRow]);
        if (status.includes('AWAITING_APPROVAL')) return Promise.resolve([]);
        return Promise.resolve([]);
      }),
      getOfferPermissions: vi.fn().mockResolvedValue({
        can_sign: false, can_ntu: false, can_return: false, can_recall: false,
        can_arbitrate: canArbitrate, is_owner: false, is_submitter: false,
      }),
      arbiterDecision: vi.fn().mockResolvedValue({ ok: true, nextStatus: 'AWAITING_SIGNED_LINE', decision: 'APPROVED', complete: true }),
    });
  }

  it('lists a DISPUTE_PENDING treaty in the Disputed section with the arbitrate control', async () => {
    resetWithDispute();
    renderScreen();

    expect(await screen.findByText(/disputed — arbitration required/i)).toBeInTheDocument();
    expect(await screen.findByText('Disputed Cedant')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^arbitrate$/i })).toBeInTheDocument();
    // Queried with the dedicated status so the server actually returns them.
    await waitFor(() => expect(apiMock.listContracts).toHaveBeenCalledWith({ status: 'DISPUTE_PENDING' }));
  });

  it('arbitrating APPROVED sends decision + comment and moves the row to decided with the server status', async () => {
    resetWithDispute();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /^arbitrate$/i }));
    fireEvent.change(screen.getByLabelText(/arbitration comment/i), { target: { value: 'Terms are within appetite' } });
    fireEvent.click(screen.getByRole('button', { name: /approve offer/i }));

    await waitFor(() => expect(apiMock.arbiterDecision).toHaveBeenCalledWith(
      'contract-dispute-001',
      expect.objectContaining({ decision: 'APPROVED', comment: 'Terms are within appetite' }),
    ));
    // Server-reported landing status, not a fabricated one.
    expect(await screen.findByText('Awaiting Signed Line')).toBeInTheDocument();
    expect(screen.queryByText(/disputed — arbitration required/i)).not.toBeInTheDocument();
  });

  it('arbitrating DECLINED lands the row in decided as DECLINED', async () => {
    resetWithDispute();
    apiMock.arbiterDecision.mockResolvedValueOnce({ ok: true, nextStatus: 'DECLINED', decision: 'DECLINED', complete: true });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /^arbitrate$/i }));
    fireEvent.change(screen.getByLabelText(/arbitration comment/i), { target: { value: 'Split resolved against the offer' } });
    fireEvent.click(screen.getByRole('button', { name: /decline offer/i }));

    await waitFor(() => expect(apiMock.arbiterDecision).toHaveBeenCalledWith(
      'contract-dispute-001',
      expect.objectContaining({ decision: 'DECLINED', comment: 'Split resolved against the offer' }),
    ));
    expect(await screen.findByText('Declined')).toBeInTheDocument();
  });

  it('requires a comment before an arbitration decision is sent', async () => {
    resetWithDispute();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /^arbitrate$/i }));
    fireEvent.click(screen.getByRole('button', { name: /approve offer/i }));

    expect(await screen.findByText(/enter an arbitration comment/i)).toBeInTheDocument();
    expect(apiMock.arbiterDecision).not.toHaveBeenCalled();
  });

  it('hides the arbitrate control when the server says the viewer cannot arbitrate', async () => {
    // e.g. a disputing peer or a Treaty Manager — getTerminalPermissions
    // mirrors recordArbiterSlot, and the server still enforces on POST.
    resetWithDispute({ canArbitrate: false });
    renderScreen();

    expect(await screen.findByText(/disputed — arbitration required/i)).toBeInTheDocument();
    expect(await screen.findByText('Disputed Cedant')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^arbitrate$/i })).not.toBeInTheDocument();
  });

  it('surfaces the server error when arbitration is rejected (e.g. a disputing peer)', async () => {
    resetWithDispute();
    apiMock.arbiterDecision.mockRejectedValueOnce(new Error('A disputing approver cannot arbitrate their own split decision'));
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /^arbitrate$/i }));
    fireEvent.change(screen.getByLabelText(/arbitration comment/i), { target: { value: 'trying anyway' } });
    fireEvent.click(screen.getByRole('button', { name: /approve offer/i }));

    expect(await screen.findByText(/arbitration failed: a disputing approver cannot arbitrate/i)).toBeInTheDocument();
    // The row stays in the disputed section for a legitimate arbiter.
    expect(screen.getByText('Disputed Cedant')).toBeInTheDocument();
  });
});
