// FQPricingAnalysisModal.rows.test.jsx
//
// Regression guard for the "headers render but no data rows" report: with a
// resolved structure that has layers, every layer must appear as a row under
// BOTH peril sections (active or not), and the Total Section must show the
// Risk / Cat / Total rows. Rows are read from clientStructures[sIdx].layers.

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FQPricingAnalysisModal from './FQPricingAnalysisModal.jsx';

vi.mock('../../../../api', () => ({
  api: { getPeerStructures: vi.fn(async () => ({ peers: [] })) },
}));

// Structure 1: two layers — L1 covers risk+cat, L2 risk-only — with saved
// limits/attachments/egnpi and some component pricing so Wtd ROL is non-zero.
const structureWithLayers = {
  id: 'str-0',
  layers: [
    { id: 0, risk: true, cat: true, limit: '1000000', attachment: '500000', egnpi: '50000000', riskPureBurn: '4.00%', riskExposure: '5.00%', catPureBurn: '1.00%', catExposure: '0.80%' },
    { id: 1, risk: true, cat: false, limit: '2000000', attachment: '1500000', egnpi: '50000000', riskPureBurn: '3.00%', riskExposure: '6.00%' },
  ],
};

function renderModal(over = {}) {
  const props = {
    pricingAnalysisModal: { open: true, structureIndex: 0 },
    clientStructures: [structureWithLayers],
    currency: 'USD',
    isQuote: true,
    riskDisabled: false,
    catDisabled: false,
    quoteCurve: {},
    contractId: 'quote-1',
    cobIds: [],
    runQuoteCalcEngine: vi.fn(),
    calcEngineRunning: false,
    runningStructures: {},
    calcEngineError: '',
    updateClientStructureLayer: vi.fn(),
    updateClientStructure: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  return render(<FQPricingAnalysisModal {...props} />);
}

describe('FQPricingAnalysisModal — row rendering', () => {
  it('renders one row per layer under the Risk section', () => {
    renderModal();
    expect(screen.getByLabelText('Risk Pricing Structure 1 Layer 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Risk Pricing Structure 1 Layer 2')).toBeInTheDocument();
  });

  it('renders one row per layer under the Cat section (including cat-inactive layers)', () => {
    renderModal();
    // L2 is cat-inactive but its row must still render (unchecked checkbox).
    const catL1 = screen.getByLabelText('Cat Pricing Structure 1 Layer 1');
    const catL2 = screen.getByLabelText('Cat Pricing Structure 1 Layer 2');
    expect(catL1).toBeChecked();
    expect(catL2).not.toBeChecked();
  });

  it('populates Limit / Deductible / EGNPI from the layer', () => {
    renderModal();
    // Money formatting → "USD 1,000,000" etc. appears in both sections.
    expect(screen.getAllByText('USD 1,000,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('USD 500,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('USD 2,000,000').length).toBeGreaterThan(0);
  });

  it('renders the Total Section with Risk / Cat / Total rows when both perils are active', () => {
    renderModal();
    const totalHeading = screen.getByText('Total Section');
    const section = totalHeading.closest('section');
    expect(section).toBeTruthy();
    const scoped = within(section);
    expect(scoped.getByText('Risk')).toBeInTheDocument();
    expect(scoped.getByText('Cat')).toBeInTheDocument();
    expect(scoped.getByText('Total')).toBeInTheDocument();
  });

  it('shows a "no layers" note instead of a blank table when the structure has no layers', () => {
    renderModal({ clientStructures: [{ id: 'str-0', layers: [] }] });
    expect(screen.getByTestId('fq-analysis-no-layers')).toBeInTheDocument();
    // No per-layer rows when there are no layers.
    expect(screen.queryByLabelText('Risk Pricing Structure 1 Layer 1')).toBeNull();
  });

  it('shows a "No structure selected" note when the index resolves to nothing', () => {
    renderModal({ pricingAnalysisModal: { open: true, structureIndex: 9 } });
    expect(screen.getByTestId('fq-analysis-no-structure')).toBeInTheDocument();
  });
});
