// FrequencySimPanel.test.jsx
//
// Frequency / aggregate Monte-Carlo panel. The worker client is mocked to run
// the real engine synchronously (jsdom has no Worker), so the tests exercise
// the panel's wiring: λ prefill, sims/seed defaults, Poisson↔NegBin, the
// estimation-risk toggle, the debounced run and the results table.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Run the genuine engine on the main thread in tests instead of a Worker.
vi.mock('../paretoMonteCarloClient.js', async () => {
  const { runParetoMonteCarlo } = await import('../paretoMonteCarlo.js');
  return {
    createMonteCarloRunner: () => ({
      run: (params) => Promise.resolve(runParetoMonteCarlo(params)),
      terminate: () => {},
    }),
  };
});

import FrequencySimPanel from './FrequencySimPanel.jsx';

const SEVERITIES = [1.2e6, 1.5e6, 2.0e6, 2.5e6, 3.0e6, 3.5e6, 4.0e6, 5.0e6, 6.0e6, 7.0e6, 8.0e6, 10.0e6];
const sevFit = { family: 'GPD', threshold: 1_000_000, severities: SEVERITIES, years: 10, n: SEVERITIES.length };
const structure = {
  layers: [{ id: 0, risk: true, cat: false, limit: '3000000', attachment: '2000000', riskUwPrice: '10', reinstatements: '1', pctReinst: '100' }],
};

function renderPanel(over = {}) {
  return render(<FrequencySimPanel scopeKey="risk" structure={structure} sevFit={sevFit} {...over} />);
}

describe('FrequencySimPanel', () => {
  it('shows a pending hint until a severity fit is published', () => {
    renderPanel({ sevFit: null });
    expect(screen.getByTestId('fq-frequency-pending-risk')).toBeInTheDocument();
  });

  it('defaults sims to 10000 and exposes a settable seed', () => {
    renderPanel();
    expect(screen.getByTestId('fq-frequency-sims-risk')).toHaveValue('10000');
    expect(screen.getByTestId('fq-frequency-seed-risk')).toHaveValue('12345');
  });

  it('prefills λ from the historical frequency (count / years)', () => {
    renderPanel(); // n=12, years=10 → λ = 1.2
    expect(screen.getByTestId('fq-frequency-lambda-risk')).toHaveValue('1.2');
  });

  it('runs the worker (debounced) and renders per-layer aggregate results', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('fq-frequency-row-risk-0')).toBeInTheDocument(), { timeout: 2000 });
    const row = within(screen.getByTestId('fq-frequency-row-risk-0'));
    // Pure premium and the tail metrics render as numbers.
    expect(screen.getByTestId('fq-frequency-row-risk-0').textContent).toMatch(/\d/);
    expect(row.getAllByText(/\d/).length).toBeGreaterThan(0);
  });

  it('estimation-risk toggle defaults OFF and carries the explanatory caption', () => {
    renderPanel();
    expect(screen.getByTestId('fq-frequency-estrisk-risk')).not.toBeChecked();
    expect(screen.getByText(/widens the tail/i)).toBeInTheDocument();
  });

  it('Negative Binomial exposes a dispersion field', async () => {
    renderPanel();
    expect(screen.queryByTestId('fq-frequency-dispersion-risk')).toBeNull();
    fireEvent.change(screen.getByTestId('fq-frequency-model-risk'), { target: { value: 'NEGBIN' } });
    expect(await screen.findByTestId('fq-frequency-dispersion-risk')).toBeInTheDocument();
  });

  it('re-runs when the seed changes (deterministic, still produces results)', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('fq-frequency-row-risk-0')).toBeInTheDocument(), { timeout: 2000 });
    fireEvent.change(screen.getByTestId('fq-frequency-seed-risk'), { target: { value: '999' } });
    // Still renders results after the debounced re-run.
    await waitFor(() => expect(screen.getByTestId('fq-frequency-row-risk-0')).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByTestId('fq-frequency-seed-risk')).toHaveValue('999');
  });
});
