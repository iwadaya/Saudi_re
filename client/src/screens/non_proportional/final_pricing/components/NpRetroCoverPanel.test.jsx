// NpRetroCoverPanel.test.jsx
//
// The retro cover analysis in the offer modal: the suggested line, the line
// currently written and the retro-optimal line, each priced through the outward
// programme, plus the apply actions that push a line back onto the layers.
//
// Reference tower (100%): 10,000,000 @ 10% ROL / 6% technical and
// 20,000,000 @ 8% ROL / 5% technical — 30,000,000 of limit, 2,600,000 of
// premium, 1,600,000 of expected loss. Programme: 4,000,000 xs 1,000,000 at
// 3% ROL. See retroCover.test.js for the arithmetic behind the numbers below.

import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import NpRetroCoverPanel from './NpRetroCoverPanel.jsx';

const PROGRAMME = {
  cessionPct: 0, commissionPct: 25, retentionAmt: 1000000,
  limitAmt: 4000000, rolPct: 3, usedLimitAmt: 0, maxLinePct: 25,
};

const LAYER_DATA = [
  { layer: 'L1', limit: 10000000, ep100: 1000000, rolPct: 10 },
  { layer: 'L2', limit: 20000000, ep100: 1600000, rolPct: 8 },
];
const RAW_LAYERS = [{ technicalRatio: '6' }, { technicalRatio: '5' }];

function renderPanel(over = {}, programme = PROGRAMME) {
  window.localStorage.setItem('u3.retroProgramme.v1', JSON.stringify(programme));
  const onApplyLine = vi.fn();
  render(
    <NpRetroCoverPanel
      layerData={LAYER_DATA} rawLayers={RAW_LAYERS} techRatioAvgPct={5.5}
      suggestedLinePct={10} currentLines={[10, 5]} currency="USD"
      onApplyLine={onApplyLine} {...over}
    />,
  );
  return { onApplyLine };
}

beforeEach(() => window.localStorage.clear());

describe('NpRetroCoverPanel', () => {
  it('summarises the outward programme in the header', () => {
    renderPanel();
    expect(screen.getByText(/USD 4,000,000 xs USD 1,000,000 @ 3% ROL/)).toBeInTheDocument();
    expect(screen.getByText(/no retro QS/)).toBeInTheDocument();
  });

  it('prices the suggested line through the programme', () => {
    renderPanel();
    const row = within(screen.getByTestId('retro-scenario-suggested'));
    expect(row.getByText('10%')).toBeInTheDocument();            // line
    expect(row.getByText('USD 3,000,000')).toBeInTheDocument();  // gross exposure
    expect(row.getByText('USD 2,000,000')).toBeInTheDocument();  // retro recovery
    expect(row.getByText('USD 1,000,000')).toBeInTheDocument();  // net retained
    expect(row.getByText('USD 60,000')).toBeInTheDocument();     // cost of cover
    expect(row.getByText('USD 200,000')).toBeInTheDocument();    // net premium
    expect(row.getByText('USD 40,000')).toBeInTheDocument();     // net margin
    expect(row.getByText('50%')).toBeInTheDocument();            // retro limit used
    expect(row.getByText('23.1% of premium')).toBeInTheDocument();
  });

  it('shows the line currently written across the layers, limit-weighted', () => {
    renderPanel();
    const row = within(screen.getByTestId('retro-scenario-current'));
    expect(row.getByText('6.67%')).toBeInTheDocument();          // (1m + 1m) / 30m
    expect(row.getByText('USD 2,000,000')).toBeInTheDocument();  // gross exposure
  });

  it('offers the retro-optimal line and applies it to every layer', () => {
    const { onApplyLine } = renderPanel();
    const row = within(screen.getByTestId('retro-scenario-optimal'));
    expect(row.getByText('16.5%')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('retro-apply-optimal'));
    expect(onApplyLine).toHaveBeenCalledWith(16.5);
    fireEvent.click(screen.getByTestId('retro-apply-suggested'));
    expect(onApplyLine).toHaveBeenCalledWith(10);
  });

  it('reads out the headroom between the suggested and the optimal line', () => {
    renderPanel();
    const verdict = within(screen.getByTestId('retro-verdict'));
    expect(verdict.getByText('Retro headroom to 16.5%')).toBeInTheDocument();
    expect(verdict.getByText(/50\.0% of the retro limit at USD 60,000 of cover/)).toBeInTheDocument();
  });

  it('flags the unprotected excess when the line outruns the programme', () => {
    renderPanel({ suggestedLinePct: 20 });
    const verdict = within(screen.getByTestId('retro-verdict'));
    expect(verdict.getByText('20% breaches the retro programme')).toBeInTheDocument();
    const row = within(screen.getByTestId('retro-scenario-suggested'));
    expect(row.getByText('USD 1,000,000 unprotected')).toBeInTheDocument();
  });

  it('re-runs the analysis when a programme assumption is edited, and remembers it', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Programme assumptions/i }));
    // Doubling the retention lifts the top of the programme from 5,000,000 to
    // 6,000,000, so the largest fully-protected line moves from 16.5% to
    // 30,000,000 × 20% = 6,000,000, i.e. 20%.
    fireEvent.change(screen.getByLabelText(/Retention \(USD\)/i), { target: { value: '2,000,000' } });
    expect(within(screen.getByTestId('retro-scenario-optimal')).getByText('20%')).toBeInTheDocument();
    expect(screen.getByText(/USD 4,000,000 xs USD 2,000,000/)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('u3.retroProgramme.v1')).retentionAmt).toBe('2,000,000');
  });

  it('accounts for a retro quota share sitting above the XL', () => {
    renderPanel({}, { ...PROGRAMME, cessionPct: 25, commissionPct: 20 });
    expect(screen.getByText(/25% retro QS/)).toBeInTheDocument();
    const row = within(screen.getByTestId('retro-scenario-suggested'));
    expect(row.getByText('USD 1,250,000')).toBeInTheDocument();  // retro recovery, net of the cession
    expect(row.getByText('USD 37,500')).toBeInTheDocument();     // cost of cover
    expect(row.getByText('USD 50,500')).toBeInTheDocument();     // net margin
  });

  it('hides the apply actions once the offer is read-only', () => {
    renderPanel({ readOnly: true });
    expect(screen.queryByTestId('retro-apply-optimal')).toBeNull();
    expect(screen.getByTestId('retro-scenario-optimal')).toBeInTheDocument();
  });

  it('asks for limits before it can say anything', () => {
    renderPanel({ layerData: [], rawLayers: [], currentLines: [] });
    expect(screen.getByText('No layer limits yet')).toBeInTheDocument();
    expect(screen.queryByTestId('retro-curve')).toBeNull();
  });

  it('draws the optimisation curve with the suggested and optimal markers', () => {
    renderPanel();
    const curve = within(screen.getByTestId('retro-curve'));
    expect(curve.getByRole('img', { name: /Net margin and net retained exposure by written line/i })).toBeInTheDocument();
    expect(curve.getByText('✦ 10%')).toBeInTheDocument();
    expect(curve.getByText('◎ 16.5%')).toBeInTheDocument();
    expect(curve.getByText(/retro limit exhausted at 16.5%/)).toBeInTheDocument();
  });
});
