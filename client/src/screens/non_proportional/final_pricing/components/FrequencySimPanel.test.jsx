// FrequencySimPanel.test.jsx
//
// Frequency / aggregate Monte-Carlo panel. recharts is stubbed and the worker
// client is mocked to run the real engine synchronously, so the tests exercise
// the wiring: λ prefill, sims/seed/risk-load controls, the debounced run, the
// results table, the Pareto-ROL write into the blend, and config persistence
// (including the seed) for reproducible reloads.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState, useCallback } from 'react';

vi.mock('recharts', () => {
  const Stub = ({ children }) => <div data-recharts-stub>{children}</div>;
  return {
    __esModule: true,
    ResponsiveContainer: Stub, ComposedChart: Stub, Bar: Stub, Line: Stub,
    XAxis: Stub, YAxis: Stub, CartesianGrid: Stub, Tooltip: Stub,
  };
});

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
const sevFit = { family: 'GPD', threshold: 1_000_000, severities: SEVERITIES, years: 10, n: SEVERITIES.length, params: { xm: 1_000_000, xi: 0.3, sigma: 1_500_000 } };
const structure = {
  layers: [{ id: 0, risk: true, cat: false, limit: '3000000', attachment: '2000000', riskUwPrice: '10', reinstatements: '1', pctReinst: '100' }],
};

function renderPanel(over = {}) {
  const updateClientStructureLayer = vi.fn();
  const updateClientStructure = vi.fn();
  const props = {
    scopeKey: 'risk', structure, sIdx: 0, sevFit, savedConfig: undefined,
    updateClientStructure, updateClientStructureLayer, ...over,
  };
  return { ...render(<FrequencySimPanel {...props} />), updateClientStructure, updateClientStructureLayer };
}

describe('FrequencySimPanel', () => {
  it('shows a pending hint until a severity fit is published', () => {
    renderPanel({ sevFit: null });
    expect(screen.getByTestId('fq-frequency-pending-risk')).toBeInTheDocument();
  });

  it('defaults sims to 10000, seed to 12345, and a θ·SD risk load', () => {
    renderPanel();
    expect(screen.getByTestId('fq-frequency-sims-risk')).toHaveValue('10000');
    expect(screen.getByTestId('fq-frequency-seed-risk')).toHaveValue('12345');
    expect(screen.getByTestId('fq-frequency-loadmethod-risk')).toHaveValue('SD');
    expect(screen.getByTestId('fq-frequency-loadfactor-risk')).toHaveValue('0.15');
  });

  it('prefills λ from the historical frequency (count / years)', () => {
    renderPanel(); // n=12, years=10 → λ = 1.2
    expect(screen.getByTestId('fq-frequency-lambda-risk')).toHaveValue('1.2');
  });

  it('runs the worker (debounced) and renders the aggregate results + distribution', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('fq-frequency-row-risk-0')).toBeInTheDocument(), { timeout: 2000 });
    const row = within(screen.getByTestId('fq-frequency-row-risk-0'));
    expect(row.getAllByText(/\d/).length).toBeGreaterThan(0);
    // Tail metrics + reconciliation render; the distribution chart block is present.
    expect(screen.getByText('VaR 1:100')).toBeInTheDocument();
    expect(screen.getByText('TVaR 1:100')).toBeInTheDocument();
    expect(screen.getByText(/Aggregate loss distribution/i)).toBeInTheDocument();
  });

  it('writes the technical Pareto ROL into riskPareto and persists the config (with seed)', async () => {
    const { updateClientStructure, updateClientStructureLayer } = renderPanel();
    await waitFor(() => {
      const call = updateClientStructureLayer.mock.calls.find((c) => c[2] === 'riskPareto');
      expect(call).toBeTruthy();
      expect(call[0]).toBe(0);          // sIdx
      expect(call[1]).toBe(0);          // layer index
      expect(typeof call[3]).toBe('string');
    }, { timeout: 2000 });
    const cfgCall = updateClientStructure.mock.calls.find((c) => c[1] === 'riskParetoSim');
    expect(cfgCall).toBeTruthy();
    const cfg = cfgCall[2];
    expect(cfg.seed).toBe(12345);       // seed MUST persist for a reproducible reload
    expect(cfg.family).toBe('GPD');
    expect(cfg.nSims).toBe(10000);
    expect(cfg.loadMethod).toBe('SD');
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

  it('hydrates controls from a saved config for a reproducible reload', async () => {
    const savedConfig = {
      family: 'GPD', params: sevFit.params, threshold: 1_000_000,
      freqType: 'NEGBIN', lambda: 3.5, dispersion: 0.8,
      loadMethod: 'TVAR', loadFactor: 0.25, nSims: 5000, seed: 4242, resampleParams: true,
    };
    renderPanel({ savedConfig });
    expect(screen.getByTestId('fq-frequency-seed-risk')).toHaveValue('4242');
    expect(screen.getByTestId('fq-frequency-sims-risk')).toHaveValue('5000');
    expect(screen.getByTestId('fq-frequency-lambda-risk')).toHaveValue('3.5');
    expect(screen.getByTestId('fq-frequency-model-risk')).toHaveValue('NEGBIN');
    expect(screen.getByTestId('fq-frequency-loadmethod-risk')).toHaveValue('TVAR');
    expect(screen.getByTestId('fq-frequency-estrisk-risk')).toBeChecked();
  });

  // Regression for React #185 (max update depth): the real hook's
  // updateClientStructureLayer changes identity whenever clientStructures
  // change (it closes over quoteCurve). Writing the priced Pareto ROL back
  // mutates a structure, so an effect that lists the setter in its deps would
  // re-fire forever. This harness reproduces that instability.
  it('does not infinite-loop when the layer setter identity changes per write (React #185)', async () => {
    const writes = vi.fn();
    function LoopHarness() {
      const [structures, setStructures] = useState([{
        id: 's0',
        layers: [{ id: 0, risk: true, cat: false, limit: '3000000', attachment: '2000000', riskUwPrice: '10', reinstatements: '1', pctReinst: '100' }],
      }]);
      // Unstable on purpose — reads `structures` directly so its identity
      // changes whenever they do (mirrors the real hook closing over quoteCurve).
      const updateClientStructureLayer = useCallback((si, li, field, val) => {
        writes(field);
        setStructures(structures.map((s, i) => (i !== si ? s : { ...s, layers: s.layers.map((l, j) => (j !== li ? l : { ...l, [field]: val })) })));
      }, [structures]);
      const updateClientStructure = useCallback((si, field, val) => {
        setStructures((prev) => prev.map((s, i) => (i !== si ? s : { ...s, [field]: val })));
      }, []);
      return (
        <FrequencySimPanel
          scopeKey="risk" structure={structures[0]} sIdx={0} sevFit={sevFit}
          updateClientStructure={updateClientStructure} updateClientStructureLayer={updateClientStructureLayer}
        />
      );
    }
    render(<LoopHarness />);
    await waitFor(() => expect(screen.getByTestId('fq-frequency-row-risk-0')).toBeInTheDocument(), { timeout: 2000 });
    const settled = writes.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    // After the initial price the writes must STOP (no runaway re-pricing).
    expect(writes.mock.calls.length - settled).toBeLessThanOrEqual(1);
  });
});
