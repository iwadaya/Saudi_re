// NpRetroCoverPanel.test.jsx
//
// The retro cover analysis in the offer modal: the admin-captured retro
// contract for the treaty's underwriting year and currency, the suggested /
// written / retro-optimal scenarios priced through it, the apply actions that
// push a line onto every layer, and the what-if overlay that never persists.
//
// Reference tower (100%): 10,000,000 @ 10% ROL / 6% technical and
// 20,000,000 @ 8% ROL / 5% technical — 30,000,000 of limit, 2,600,000 of
// premium, 1,600,000 of expected loss. Contract: 4,000,000 xs 1,000,000 at
// 3% ROL. See retroCover.test.js for the arithmetic behind the numbers below.

import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const lookupRetroProgramme = vi.fn();
vi.mock('../../../../api', () => ({ api: { lookupRetroProgramme: (...a) => lookupRetroProgramme(...a) } }));

const { default: NpRetroCoverPanel } = await import('./NpRetroCoverPanel.jsx');

const RECORD = {
  retro_programme_id: 'r1', uw_year: 2026, currency: 'USD',
  label: '2026 Cat XL Retro', reinsurer: 'Retro Re', updated_by: 'Ada Admin',
  retention_amt: 1000000, limit_amt: 4000000, rol_pct: 3,
  used_limit_amt: 0, cession_pct: 0, commission_pct: 25, max_line_pct: 25,
  is_active: true,
};

const LAYER_DATA = [
  { layer: 'L1', limit: 10000000, ep100: 1000000, rolPct: 10 },
  { layer: 'L2', limit: 20000000, ep100: 1600000, rolPct: 8 },
];
const RAW_LAYERS = [{ technicalRatio: '6' }, { technicalRatio: '5' }];

function renderPanel(over = {}) {
  const onApplyLine = vi.fn();
  const view = render(
    <NpRetroCoverPanel
      layerData={LAYER_DATA} rawLayers={RAW_LAYERS} techRatioAvgPct={5.5}
      suggestedLinePct={10} currentLines={[10, 5]} currency="USD" uwYear={2026}
      onApplyLine={onApplyLine} {...over}
    />,
  );
  return { ...view, onApplyLine };
}

/** Wait for the lookup to resolve and the scenarios to render. */
const settled = () => screen.findByTestId('retro-scenario-suggested');

beforeEach(() => {
  lookupRetroProgramme.mockReset();
  lookupRetroProgramme.mockResolvedValue({ programme: RECORD, year: 2026, currency: 'USD', availableCurrencies: ['USD'] });
});

describe('NpRetroCoverPanel', () => {
  it('looks the contract up by the treaty\'s underwriting year and currency', async () => {
    renderPanel();
    await settled();
    expect(lookupRetroProgramme).toHaveBeenCalledWith(2026, 'USD', expect.anything());
    expect(screen.getByTestId('retro-programme-line'))
      .toHaveTextContent('2026 Cat XL Retro · USD 4,000,000 xs USD 1,000,000 @ 3% ROL · no retro QS');
    expect(screen.getByText(/Contract of record for 2026 USD · Retro Re · maintained by Ada Admin/)).toBeInTheDocument();
  });

  it('prices the suggested line through the contract', async () => {
    renderPanel();
    const row = within(await settled());
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

  it('shows the line currently written across the layers, limit-weighted', async () => {
    renderPanel();
    await settled();
    const row = within(screen.getByTestId('retro-scenario-current'));
    expect(row.getByText('6.67%')).toBeInTheDocument();          // (1m + 1m) / 30m
    expect(row.getByText('USD 2,000,000')).toBeInTheDocument();  // gross exposure
  });

  it('offers the retro-optimal line and applies it to every layer', async () => {
    const { onApplyLine } = renderPanel();
    await settled();
    const row = within(screen.getByTestId('retro-scenario-optimal'));
    expect(row.getByText('16.5%')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('retro-apply-optimal'));
    expect(onApplyLine).toHaveBeenCalledWith(16.5);
    fireEvent.click(screen.getByTestId('retro-apply-suggested'));
    expect(onApplyLine).toHaveBeenCalledWith(10);
  });

  it('reads out the headroom between the suggested and the optimal line', async () => {
    renderPanel();
    await settled();
    const verdict = within(screen.getByTestId('retro-verdict'));
    expect(verdict.getByText('Retro headroom to 16.5%')).toBeInTheDocument();
    expect(verdict.getByText(/50\.0% of the retro limit at USD 60,000 of cover/)).toBeInTheDocument();
  });

  it('flags the unprotected excess when the line outruns the contract', async () => {
    renderPanel({ suggestedLinePct: 20 });
    await settled();
    const verdict = within(screen.getByTestId('retro-verdict'));
    expect(verdict.getByText('20% breaches the retro programme')).toBeInTheDocument();
    expect(within(screen.getByTestId('retro-scenario-suggested')).getByText('USD 1,000,000 unprotected')).toBeInTheDocument();
  });

  it('accounts for a retro quota share sitting above the XL', async () => {
    lookupRetroProgramme.mockResolvedValue({
      programme: { ...RECORD, cession_pct: 25, commission_pct: 20 },
      year: 2026, currency: 'USD', availableCurrencies: ['USD'],
    });
    renderPanel();
    const row = within(await settled());
    expect(screen.getByTestId('retro-programme-line')).toHaveTextContent('25% retro QS');
    expect(row.getByText('USD 1,250,000')).toBeInTheDocument();  // recovery, net of the cession
    expect(row.getByText('USD 37,500')).toBeInTheDocument();     // cost of cover
    expect(row.getByText('USD 50,500')).toBeInTheDocument();     // net margin
  });

  it('says nothing was captured for the year, and shows no numbers', async () => {
    lookupRetroProgramme.mockResolvedValue({ programme: null, year: 2026, currency: 'EUR', availableCurrencies: ['SAR', 'USD'] });
    renderPanel({ currency: 'EUR' });
    await waitFor(() => expect(screen.getByTestId('retro-verdict')).toHaveTextContent('No retro contract captured'));
    expect(screen.getByTestId('retro-programme-line'))
      .toHaveTextContent('No retro contract captured for 2026 EUR · placed in SAR, USD');
    expect(screen.queryByTestId('retro-scenario-suggested')).toBeNull();
    expect(screen.queryByTestId('retro-curve')).toBeNull();
    expect(screen.queryByTestId('retro-whatif')).toBeNull();     // nothing to vary
  });

  it('does not call the server without a usable year and currency', async () => {
    renderPanel({ uwYear: 0 });
    expect(lookupRetroProgramme).not.toHaveBeenCalled();
    expect(screen.getByTestId('retro-programme-line'))
      .toHaveTextContent(/Set the treaty’s inception year and currency/);
  });

  it('runs what-if assumptions over the contract without saving them', async () => {
    renderPanel();
    await settled();
    fireEvent.click(screen.getByTestId('retro-whatif'));
    // Doubling the retention lifts the top of the programme from 5,000,000 to
    // 6,000,000, so the largest fully-protected line moves from 16.5% to
    // 30,000,000 × 20% = 6,000,000, i.e. 20%.
    fireEvent.change(screen.getByLabelText(/Retention \(USD\)/i), { target: { value: '2,000,000' } });
    expect(within(screen.getByTestId('retro-scenario-optimal')).getByText('20%')).toBeInTheDocument();
    expect(screen.getByText(/showing what-if assumptions/)).toBeInTheDocument();
    expect(screen.getByTestId('retro-assumptions')).toHaveTextContent(/the retro contract of record is unchanged/i);
    // The contract itself is untouched — no write call, and reset restores it.
    expect(Object.keys(lookupRetroProgramme.mock.results)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('retro-reset'));
    expect(within(screen.getByTestId('retro-scenario-optimal')).getByText('16.5%')).toBeInTheDocument();
  });

  it('hides the apply actions once the offer is read-only', async () => {
    renderPanel({ readOnly: true });
    await settled();
    expect(screen.queryByTestId('retro-apply-optimal')).toBeNull();
    expect(screen.getByTestId('retro-scenario-optimal')).toBeInTheDocument();
  });

  it('asks for limits before it can say anything', async () => {
    renderPanel({ layerData: [], rawLayers: [], currentLines: [] });
    await waitFor(() => expect(screen.getByTestId('retro-verdict')).toHaveTextContent('No layer limits yet'));
    expect(screen.queryByTestId('retro-curve')).toBeNull();
  });

  it('draws the optimisation curve with the suggested and optimal markers', async () => {
    renderPanel();
    await settled();
    const curve = within(screen.getByTestId('retro-curve'));
    expect(curve.getByRole('img', { name: /Net margin and net retained exposure by written line/i })).toBeInTheDocument();
    expect(curve.getByText('✦ 10%')).toBeInTheDocument();
    expect(curve.getByText('◎ 16.5%')).toBeInTheDocument();
    expect(curve.getByText(/retro limit exhausted at 16.5%/)).toBeInTheDocument();
  });
});
