// NpOfferModal.test.jsx
//
// Quote-mode "Submit Quotes" summary: lists each queued structure (label, total
// limit, COBs covered, quote type, lead/follow line) and gates the Submit button
// on an approver + at least one queued structure, then calls doSubmitForApproval.

import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NpOfferModal from './NpOfferModal.jsx';

function makePricing(over = {}) {
  return {
    layers: [],
    offerStatus: 'DRAFT',
    snap: { cedant: 'Audit Cedant', treatyType: 'Risk XL', cob: 'Motor', xlType: 'RISK' },
    techRatioAvg: 0,
    approvedStructures: [true],
    clientStructures: [
      {
        id: 'str-0', label: 'Structure 1', quoteType: 'LEAD', leadLinePct: '25', followLinePct: '',
        layers: [{ id: 0, risk: true, cat: false, limit: '1000000', attachment: '500000', egnpi: '50000000', riskUwPrice: '10' }],
      },
    ],
    selectedCobs: [{ id: 'cob-1', name: 'Motor' }],
    getCobFlags: () => [true],
    layerWrittenLines: {}, signedLinePcts: {}, setLayerWrittenLines: vi.fn(), setSignedLinePcts: vi.fn(),
    offerApprover: '', setOfferApprover: vi.fn(), eligibleApprovers: [{ user_id: 'u1', role_name: 'Chief Underwriter' }],
    offerComment: '', setOfferComment: vi.fn(), returnReason: '', setReturnReason: vi.fn(),
    approvalTrail: [], setShowOfferModal: vi.fn(), setOfferStatus: vi.fn(),
    ...over,
  };
}

function renderModal(over = {}, pricingOver = {}) {
  const doSubmitForApproval = vi.fn();
  const props = {
    pricing: makePricing(pricingOver),
    open: true, isCU: false, actorName: 'Tester', isTerminal: false,
    isQuote: true, quoteMode: true, contractId: 'q1', currency: 'USD',
    npDetail: { estGnpi: 50000000 }, showToast: vi.fn(),
    doSubmitForApproval, doMarkApproved: vi.fn(), doMarkSigned: vi.fn(),
    doMarkNTU: vi.fn(), doReturnToUW: vi.fn(), doDecline: vi.fn(),
    ...over,
  };
  return { ...render(<NpOfferModal {...props} />), props, doSubmitForApproval };
}

describe('NpOfferModal — quote submission summary', () => {
  it('lists each queued structure with total limit, COBs, quote type and line', () => {
    renderModal();
    expect(screen.getByText('Quotes for Submission')).toBeInTheDocument();
    const row = within(screen.getByTestId('np-submit-summary-row-0'));
    expect(row.getByText('Structure 1')).toBeInTheDocument();
    expect(row.getByText('1,000,000')).toBeInTheDocument();   // combined total limit
    expect(row.getByText('Motor')).toBeInTheDocument();        // COBs covered
    expect(row.getByText('Lead')).toBeInTheDocument();         // quote type
    expect(row.getByText(/25% lead/)).toBeInTheDocument();     // single structure line
  });

  it('shows an empty-state row when nothing is queued', () => {
    renderModal({}, { approvedStructures: [false] });
    expect(screen.getByText(/No structures queued/i)).toBeInTheDocument();
  });

  it('reflects INDICATIVE quote type with the follow line', () => {
    renderModal({}, {
      clientStructures: [
        { id: 'str-0', label: 'Structure 1', quoteType: 'INDICATIVE', leadLinePct: '', followLinePct: '12.5',
          layers: [{ id: 0, risk: true, cat: false, limit: '1000000', attachment: '500000', egnpi: '50000000', riskUwPrice: '10' }] },
      ],
    });
    const row = within(screen.getByTestId('np-submit-summary-row-0'));
    expect(row.getByText('Indicative')).toBeInTheDocument();
    expect(row.getByText(/12\.5% follow/)).toBeInTheDocument();
  });

  it('gates Submit on an approver + queued structure, then calls doSubmitForApproval', () => {
    const { rerender, props, doSubmitForApproval } = renderModal();
    expect(screen.getByRole('button', { name: /Submit Quotes →/i })).toBeDisabled();
    // Approver chosen → enabled.
    rerender(<NpOfferModal {...props} pricing={{ ...props.pricing, offerApprover: 'u1' }} />);
    const submit = screen.getByRole('button', { name: /Submit Quotes →/i });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    expect(doSubmitForApproval).toHaveBeenCalled();
  });
});
