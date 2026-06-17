// NpOfferModal.test.jsx
//
// Quote-mode "Submit Quotes" summary: one GROUP per queued structure — a header
// row with the structure-level attributes (label, quote type, lead/follow line)
// and totals, then a per-layer row beneath (limit, deductible, reinstatements,
// UW ROL, the COBs covered on that layer). Gates the Submit button on an approver
// + at least one queued structure, then calls doSubmitForApproval.

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
  it('renders a per-structure group header (totals, quote type, line) with layer rows beneath', () => {
    renderModal();
    expect(screen.getByText('Quotes for Submission')).toBeInTheDocument();
    // Group header: structure-level attributes + totals (one per structure).
    const header = within(screen.getByTestId('np-submit-group-0'));
    expect(header.getByText('Structure 1')).toBeInTheDocument();
    expect(header.getByText('Lead')).toBeInTheDocument();        // quote type
    expect(header.getByText(/25% lead/)).toBeInTheDocument();    // single line across the structure
    expect(header.getByText('1,000,000')).toBeInTheDocument();   // Σ limit
    // Layer row: 1-based pill, fused per-layer pricing, COBs covered on that layer.
    const layer = within(screen.getByTestId('np-submit-layer-0-0'));
    expect(layer.getByText('1')).toBeInTheDocument();            // layer index pill
    expect(layer.getByText('1,000,000')).toBeInTheDocument();    // layer limit
    expect(layer.getByText('500,000')).toBeInTheDocument();      // deductible
    expect(layer.getByText('10.00%')).toBeInTheDocument();       // UW ROL (risk 10 + cat 0)
    expect(layer.getByText('Motor')).toBeInTheDocument();        // COBs covered (this layer)
  });

  it('renders one row per active layer with per-layer COBs, reinstatements and fused pricing', () => {
    renderModal({}, {
      selectedCobs: [{ id: 'cob-1', name: 'Motor' }, { id: 'cob-2', name: 'Property' }],
      getCobFlags: (_scope, cobId) => (cobId === 'cob-1' ? [true, false] : [false, true]),
      clientStructures: [
        {
          id: 'str-0', label: 'Structure 1', quoteType: 'LEAD', leadLinePct: '25', followLinePct: '',
          layers: [
            { id: 0, risk: true, cat: false, limit: '1000000', attachment: '500000', egnpi: '50000000', riskUwPrice: '10', reinstatements: '1', pctReinst: '100' },
            { id: 1, risk: true, cat: false, limit: '2000000', attachment: '1500000', egnpi: '50000000', riskUwPrice: '8' },
          ],
        },
      ],
    });
    // L1: Motor only, 1@100% reinstatements, its own limit.
    const l1 = within(screen.getByTestId('np-submit-layer-0-0'));
    expect(l1.getByText('Motor')).toBeInTheDocument();
    expect(l1.queryByText('Property')).toBeNull();
    expect(l1.getByText('1@100%')).toBeInTheDocument();
    expect(l1.getByText('1,000,000')).toBeInTheDocument();
    // L2: Property only, no reinstatements, its own limit.
    const l2 = within(screen.getByTestId('np-submit-layer-0-1'));
    expect(l2.getByText('Property')).toBeInTheDocument();
    expect(l2.queryByText('Motor')).toBeNull();
    expect(l2.getByText('2,000,000')).toBeInTheDocument();
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
    const header = within(screen.getByTestId('np-submit-group-0'));
    expect(header.getByText('Indicative')).toBeInTheDocument();
    expect(header.getByText(/12\.5% follow/)).toBeInTheDocument();
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
