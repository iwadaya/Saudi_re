// Editor read-only lock: useEditLock + EditLockBanner + ReadOnlyWrap. A tiny
// harness mirrors how the pricing screens wire them. The api is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EditLockBanner, { ReadOnlyWrap } from './EditLockBanner.jsx';
import { useEditLock } from '../hooks/useEditLock';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { getEditPermission: vi.fn(), allocateContract: vi.fn() },
}));
vi.mock('../api', () => ({ api: apiMock, default: apiMock }));

function Harness({ contractId = 'c1' }) {
  const { readOnly, assignedToName, refresh } = useEditLock({ contractId });
  return (
    <div>
      {readOnly && <EditLockBanner contractId={contractId} assignedToName={assignedToName} onAllocated={refresh} />}
      <ReadOnlyWrap readOnly={readOnly}>
        <input aria-label="field" />
      </ReadOnlyWrap>
    </div>
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { apiMock.allocateContract.mockResolvedValue({ allocated: true }); });

describe('editor read-only lock', () => {
  it('locks the editor and shows the banner when the user is not the assignee', async () => {
    apiMock.getEditPermission.mockResolvedValue({ canEdit: false, isOwner: false, assignedToName: 'Grace Hopper' });
    const { container } = render(<Harness />);
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(screen.getByText(/Grace Hopper/)).toBeInTheDocument();
    // The field is wrapped in an inert (non-interactive) container.
    expect(container.querySelector('[inert] input[aria-label="field"]')).toBeTruthy();
  });

  it('stays editable (no banner, no inert) when the user is the assignee', async () => {
    apiMock.getEditPermission.mockResolvedValue({ canEdit: true, isOwner: true, assignedToName: 'Me' });
    const { container } = render(<Harness />);
    await waitFor(() => expect(apiMock.getEditPermission).toHaveBeenCalled());
    expect(screen.queryByText(/Read-only/)).toBeNull();
    expect(container.querySelector('[inert]')).toBeNull();
    expect(screen.getByLabelText('field')).toBeInTheDocument();
  });

  it('fails closed (locks the editor) when the permission lookup errors', async () => {
    apiMock.getEditPermission.mockRejectedValue(new Error('network'));
    const { container } = render(<Harness />);
    await waitFor(() => expect(apiMock.getEditPermission).toHaveBeenCalled());
    // A failed lookup must NOT hand out edit access — the editor locks.
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(container.querySelector('[inert] input[aria-label="field"]')).toBeTruthy();
  });

  it('markReadOnly flips an editable lock closed on demand (server 403 path)', async () => {
    apiMock.getEditPermission.mockResolvedValue({ canEdit: true, isOwner: true, assignedToName: 'Me' });
    function Flip() {
      const { readOnly, markReadOnly } = useEditLock({ contractId: 'c1' });
      return (
        <div>
          <span>{readOnly ? 'LOCKED' : 'EDITABLE'}</span>
          <button type="button" onClick={() => markReadOnly('Grace Hopper')}>flip</button>
        </div>
      );
    }
    render(<Flip />);
    await waitFor(() => expect(screen.getByText('EDITABLE')).toBeInTheDocument());
    fireEvent.click(screen.getByText('flip'));
    await waitFor(() => expect(screen.getByText('LOCKED')).toBeInTheDocument());
  });

  it('Allocate to me claims the treaty, then re-checks and unlocks', async () => {
    apiMock.getEditPermission
      .mockResolvedValueOnce({ canEdit: false, assignedToName: null })  // initial: locked (unassigned)
      .mockResolvedValueOnce({ canEdit: true, isOwner: true });          // after allocate: mine
    render(<Harness />);
    const btn = await screen.findByRole('button', { name: /Allocate to me/ });
    fireEvent.click(btn);
    await waitFor(() => expect(apiMock.allocateContract).toHaveBeenCalledWith('c1', expect.any(String)));
    await waitFor(() => expect(screen.queryByText(/Read-only/)).toBeNull());
  });
});
