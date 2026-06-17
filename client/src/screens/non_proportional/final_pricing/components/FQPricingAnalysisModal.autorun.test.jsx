// FQPricingAnalysisModal.autorun.test.jsx
//
// Part 3 of the quote-mode pure-burn / exposure task: the modal SEEDS the
// risk/cat component cells from the shared actuarial engine ON OPEN — they are
// model values, so opening re-runs the engine to reflect the latest selected
// losses / saved params (manual overrides are protected in the merge, not by
// skipping the run). Guards: don't re-run when a calc is already in flight;
// show "Calculating…" while it runs; show an inline hint when there are no
// saved inputs to price from.

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import FQPricingAnalysisModal from './FQPricingAnalysisModal.jsx';

// The modal fetches peer pools on open; stub it so nothing hits the network.
vi.mock('../../../../api', () => ({
  api: { getPeerStructures: vi.fn(async () => ({ peers: [] })) },
}));

const baseLayer = (over = {}) => ({
  id: 0, risk: true, cat: false,
  limit: '1000000', attachment: '500000', egnpi: '50000000',
  ...over,
});

function renderModal(over = {}) {
  const props = {
    pricingAnalysisModal: { open: true, structureIndex: 0 },
    clientStructures: [{ id: 'str-0', layers: [baseLayer()] }],
    currency: 'USD',
    isQuote: true,
    riskDisabled: false,
    catDisabled: true,
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
  return { props, ...render(<FQPricingAnalysisModal {...props} />) };
}

describe('FQPricingAnalysisModal — auto-run engine on open', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the calc engine once for the open structure when no results exist yet', async () => {
    const runQuoteCalcEngine = vi.fn();
    renderModal({ runQuoteCalcEngine });
    await waitFor(() => expect(runQuoteCalcEngine).toHaveBeenCalledWith(0));
    expect(runQuoteCalcEngine).toHaveBeenCalledTimes(1);
  });

  it('re-seeds on open even when prior results exist (recompute from latest losses/params)', async () => {
    const runQuoteCalcEngine = vi.fn();
    renderModal({
      runQuoteCalcEngine,
      clientStructures: [{ id: 'str-0', layers: [baseLayer({ riskPureBurn: '4.00%', riskExposure: '5.00%' })] }],
    });
    // The component cells are MODEL values — opening re-runs the engine so they
    // track the latest selected losses / saved params. (Manual overrides are
    // protected in mergeQuoteEngineResult, not by skipping the run.)
    await waitFor(() => expect(runQuoteCalcEngine).toHaveBeenCalledWith(0));
    expect(runQuoteCalcEngine).toHaveBeenCalledTimes(1);
  });

  it('does NOT run when a calc for this structure is already in flight, and shows Calculating…', async () => {
    const runQuoteCalcEngine = vi.fn();
    renderModal({ runQuoteCalcEngine, runningStructures: { 0: true } });
    await new Promise((r) => setTimeout(r, 0));
    expect(runQuoteCalcEngine).not.toHaveBeenCalled();
    expect(screen.getByTestId('fq-analysis-calculating')).toBeInTheDocument();
  });

  it('shows the stale-input hint once an auto-run comes back with no priced inputs', async () => {
    // The injected runQuoteCalcEngine is a no-op (no results merged, never marks
    // the structure running) — i.e. exactly the "no saved losses/profile" case.
    renderModal();
    await waitFor(() => expect(screen.getByTestId('fq-analysis-stale-hint')).toBeInTheDocument());
    expect(screen.getByTestId('fq-analysis-stale-hint').textContent)
      .toMatch(/large\/cat losses and risk profile/i);
  });

  it('does not auto-run in contract (non-quote) mode', async () => {
    const runQuoteCalcEngine = vi.fn();
    renderModal({ runQuoteCalcEngine, isQuote: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(runQuoteCalcEngine).not.toHaveBeenCalled();
  });
});
