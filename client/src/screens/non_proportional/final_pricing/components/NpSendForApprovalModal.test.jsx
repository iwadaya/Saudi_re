// NpSendForApprovalModal.test.jsx
//
// Read-only per-structure approval review: the combined per-layer pricing table,
// the LEAD/INDICATIVE participation toggle (lead vs follow line), and the
// "Add to Submission" flow that marks the structure approved then saves + closes
// once the approval commits.

import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NpSendForApprovalModal from './NpSendForApprovalModal.jsx';

const baseStructure = {
  id: 'str-0',
  quoteType: 'LEAD',
  leadLinePct: '25',
  followLinePct: '',
  layers: [
    { id: 0, risk: true, cat: true, limit: '1000000', attachment: '500000', egnpi: '50000000', riskUwPrice: '10', catUwPrice: '5', reinstatements: '1', pctReinst: '100' },
    { id: 1, risk: true, cat: false, limit: '2000000', attachment: '1500000', egnpi: '50000000', riskUwPrice: '8' },
  ],
};

function renderModal(over = {}) {
  const props = {
    open: true,
    sIdx: 0,
    structure: baseStructure,
    currency: 'USD',
    selectedCobs: [{ id: 'cob-1', name: 'Motor' }],
    getCobFlags: () => [true, false],
    getCobUwLimit: () => '1000000',
    approvedStructures: [false],
    setApprovedQuoteStructure: vi.fn(),
    updateClientStructure: vi.fn(),
    updateClientStructureLayer: vi.fn(),
    save: vi.fn(async () => true),
    onClose: vi.fn(),
    ...over,
  };
  return { ...render(<NpSendForApprovalModal {...props} />), props };
}

describe('NpSendForApprovalModal', () => {
  it('renders the read-only combined per-layer pricing table with a total', () => {
    const { container } = renderModal();
    expect(screen.getByTestId('np-send-approval-title')).toBeInTheDocument();
    ['Layer', 'Limit', 'Deductible', 'Reinstatements', 'EGNPI', 'Rate', 'Earned Premium', 'MDP %', 'MDP Amount', 'UW ROL'].forEach((h) => {
      expect(screen.getByText(h)).toBeInTheDocument();
    });
    // Both layers have an active component → 2 body rows + TOTAL.
    const total = screen.getByTestId('np-send-approval-total');
    expect(total.closest('table').querySelectorAll('tbody tr').length).toBe(2);
    expect(within(total).getByText('TOTAL')).toBeInTheDocument();
    // COB participation is rendered read-only: the limit input + ticks are locked.
    const cobLimit = container.querySelector('.bm-cob-section input.bm-np-limit-input');
    expect(cobLimit).toHaveAttribute('readonly');
    container.querySelectorAll('.bm-cob-section input[type="checkbox"]').forEach((cb) => expect(cb).toBeDisabled());
  });

  it('MDP %: defaults to 85 and editing writes mdp_pct + mdp to the layer', () => {
    const updateClientStructureLayer = vi.fn();
    renderModal({ updateClientStructureLayer });
    const firstRow = screen.getByTestId('np-send-approval-total').closest('table').querySelectorAll('tbody tr')[0];
    const mdpInput = firstRow.querySelector('input');   // the one editable cell in the row
    expect(mdpInput.value).toBe('85%');                 // default 85 when layer.mdpPct is empty
    fireEvent.change(mdpInput, { target: { value: '90' } });
    expect(updateClientStructureLayer).toHaveBeenCalledWith(0, 0, 'mdpPct', '90');
    // mdp is kept in sync (mdp = EP x mdp_pct / 100).
    expect(updateClientStructureLayer.mock.calls.some((call) => call[2] === 'mdp')).toBe(true);
  });

  it('renders fullscreen (bm-modal--fullscreen) with a pinned footer', () => {
    const { container } = renderModal();
    expect(container.querySelector('.bm-modal.bm-modal--fullscreen')).toBeInTheDocument();
    expect(container.querySelector('.bm-modal-backdrop--fullscreen')).toBeInTheDocument();
    // Footer action stays present (pinned outside the scrollable body).
    expect(screen.getByTestId('np-send-approval-add')).toBeInTheDocument();
  });

  it('LEAD (default): Lead Line enabled, Follow Line hidden', () => {
    renderModal();
    expect(screen.getByTestId('np-send-approval-indicative')).not.toBeChecked();
    expect(screen.getByText('Lead Line')).toBeInTheDocument();
    expect(screen.queryByText('Follow Line')).toBeNull();
  });

  it('ticking "Indicative quote" sets quoteType INDICATIVE → Follow Line shows', () => {
    const updateClientStructure = vi.fn();
    const { rerender, props } = renderModal({ updateClientStructure });
    fireEvent.click(screen.getByTestId('np-send-approval-indicative'));
    expect(updateClientStructure).toHaveBeenCalledWith(0, 'quoteType', 'INDICATIVE');
    // Parent re-renders with the committed quoteType.
    rerender(<NpSendForApprovalModal {...props} structure={{ ...baseStructure, quoteType: 'INDICATIVE' }} />);
    expect(screen.getByTestId('np-send-approval-indicative')).toBeChecked();
    expect(screen.getByText('Follow Line')).toBeInTheDocument();
  });

  it('"Add to Submission" marks approved, then saves + closes once approval commits', async () => {
    const setApprovedQuoteStructure = vi.fn();
    const save = vi.fn(async () => true);
    const onClose = vi.fn();
    const { rerender, props } = renderModal({ setApprovedQuoteStructure, save, onClose });
    fireEvent.click(screen.getByTestId('np-send-approval-add'));
    expect(setApprovedQuoteStructure).toHaveBeenCalledWith(0, true);
    expect(save).not.toHaveBeenCalled();           // waits for approval to commit
    // Reducer commits approval (fresh array reference) → effect saves + closes.
    rerender(<NpSendForApprovalModal {...props} approvedStructures={[true]} />);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
