// FQPricingAnalysisModal.rows.test.jsx
//
// Regression guard for the "headers render but no data rows" report: with a
// resolved structure that has layers, every layer must appear as a row under
// BOTH peril sections (active or not), and the Total Section must show the
// Risk / Cat / Total rows. Rows are read from clientStructures[sIdx].layers.

import { render, screen, within, fireEvent } from '@testing-library/react';
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

  it('renders a per-section total strip under each peril table (matching the header Wtd ROL)', () => {
    renderModal();
    const riskStrip = screen.getByTestId('fq-section-total-risk');
    expect(screen.getByTestId('fq-section-total-cat')).toBeInTheDocument();

    const riskSection = screen.getByText('Risk Pricing Analysis').closest('section');
    // Inside the section card, but OUTSIDE the table's horizontal-scroll wrapper.
    expect(riskSection.contains(riskStrip)).toBe(true);
    const riskTableWrapper = within(riskSection).getAllByRole('table')[0].parentElement;
    expect(riskTableWrapper.contains(riskStrip)).toBe(false);

    // Risk-only summary: Active / Limit / Premium / Wtd ROL.
    expect(riskStrip.textContent).toMatch(/Risk Total/);
    expect(riskStrip.textContent).toMatch(/Active/);
    expect(riskStrip.textContent).toMatch(/Limit/);
    expect(riskStrip.textContent).toMatch(/Premium/);
    const m = riskStrip.textContent.match(/Wtd ROL (\d+\.\d{2}%)/);
    expect(m).toBeTruthy();
    // The strip's Wtd ROL equals the section header's (same value appears in the
    // section at least twice: the header line + the strip).
    expect(riskSection.textContent.split(m[1]).length - 1).toBeGreaterThanOrEqual(2);

    // The combined reconciliation Total Section is still rendered at the bottom.
    expect(screen.getByText('Total Section')).toBeInTheDocument();
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

  it('pulls the structure at the opened index, not Structure 1', () => {
    const twoStructures = [
      structureWithLayers, // index 0 — limit 1,000,000
      { id: 'str-1', layers: [{ id: 0, risk: true, cat: true, limit: '7777777', attachment: '3000000', egnpi: '99000000', riskPureBurn: '2.00%', riskExposure: '3.00%' }] },
    ];
    renderModal({ clientStructures: twoStructures, pricingAnalysisModal: { open: true, structureIndex: 1 } });
    expect(screen.getByText('Pricing Analysis · Structure 2')).toBeInTheDocument();
    expect(screen.getAllByText('USD 7,777,777').length).toBeGreaterThan(0);
    expect(screen.queryByText('USD 1,000,000')).toBeNull(); // Structure 1's limit must not appear
  });

  it('uses a fixed full-viewport shell that fills the screen (caps defeated), body scrolls', () => {
    const { container } = renderModal();
    // Backdrop drops its safe-area padding; shell gets the fullscreen class that
    // overrides the centered-dialog max-width/max-height/margin caps with !important.
    expect(container.querySelector('.bm-modal-backdrop').classList.contains('bm-modal-backdrop--fullscreen')).toBe(true);
    const shell = container.querySelector('.bm-modal');
    expect(shell.classList.contains('bm-modal--fullscreen')).toBe(true);
    expect(shell.style.overflow).toBe('hidden');                // the shell itself never scrolls
    expect(shell.style.gridTemplateRows).toBe('auto auto 1fr'); // title / tabs / body
    const body = container.querySelector('.bm-modal-body');
    expect(body.style.height).toBe('100%');                     // fills the 1fr track
    expect(body.style.maxHeight).toBe('none');                  // defeats shared .bm-modal-body 55vh cap
    expect(body.style.overflowY).toBe('auto');                  // the ONLY vertical scroller
    expect(body.style.overflowX).toBe('hidden');                // blender bar can't slide sideways
    expect(parseInt(body.style.minHeight, 10)).toBe(0);         // required to scroll inside the grid
  });

  it('lets sections size to content (no per-section overflow)', () => {
    renderModal();
    const riskSection = screen.getByText('Risk Pricing Analysis').closest('section');
    expect(riskSection).toBeTruthy();
    // No overflow / flexShrink on the section — it flows with the body's scroll.
    expect(riskSection.style.overflow).toBe('');
    expect(riskSection.style.flexShrink).toBe('');
  });

  it('gives each peril table its own horizontal-only scroll (fixed layout + minWidth)', () => {
    renderModal();
    const riskSection = screen.getByText('Risk Pricing Analysis').closest('section');
    const table = within(riskSection).getAllByRole('table')[0];
    expect(table.style.tableLayout).toBe('fixed');
    expect(parseInt(table.style.minWidth, 10)).toBeGreaterThanOrEqual(1500);
    const wrapper = table.parentElement;
    expect(wrapper.style.overflowX).toBe('auto');
    expect(wrapper.style.overflowY).toBe('visible'); // no stray inner vertical scrollbar
    expect(wrapper.style.width).toBe('100%');
  });

  it('adds P(Attach) / P(Exhaust) / Note columns and shows engine probabilities', () => {
    const withProbs = {
      id: 'str-0',
      layers: [{ id: 0, risk: true, cat: false, limit: '1000000', attachment: '500000', egnpi: '50000000', riskPureBurn: '4.00%', riskExposure: '5.00%', riskPrAttach: '12.5', riskPrExhaust: '3.2' }],
    };
    renderModal({ clientStructures: [withProbs], catDisabled: true });
    expect(screen.getByText('P(Attach)')).toBeInTheDocument();
    expect(screen.getByText('P(Exhaust)')).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
    // riskPrAttach "12.5" → "12.50%", riskPrExhaust "3.2" → "3.20%"
    expect(screen.getByText('12.50%')).toBeInTheDocument();
    expect(screen.getByText('3.20%')).toBeInTheDocument();
  });

  it('edits the per-layer Note via updateClientStructureLayer(`${scope}LayerNote`)', () => {
    const updateClientStructureLayer = vi.fn();
    renderModal({ updateClientStructureLayer });
    const noteInput = screen.getByLabelText('Risk Structure 1 Layer 1 note');
    fireEvent.change(noteInput, { target: { value: 'cap at 2x' } });
    expect(updateClientStructureLayer).toHaveBeenCalledWith(0, 0, 'riskLayerNote', 'cap at 2x');
  });
});
