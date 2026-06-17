// SeverityFitPanel.test.jsx
//
// The Pareto-Simulation severity panel: it fetches the scope's losses,
// develops + trends them, seeds the threshold from the loss-selection
// snapshot, fits the chosen family (showing params + bootstrap CI + a K-S
// stat), and re-prices the scope's Pareto column when the fit is edited.
// recharts is stubbed (jsdom has no layout) and the API is mocked.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('recharts', () => {
  const Stub = ({ children }) => <div data-recharts-stub>{children}</div>;
  return {
    __esModule: true,
    ResponsiveContainer: Stub, ComposedChart: Stub, ScatterChart: Stub, LineChart: Stub,
    Line: Stub, Scatter: Stub, XAxis: Stub, YAxis: Stub, CartesianGrid: Stub, Tooltip: Stub, ReferenceLine: Stub,
  };
});

vi.mock('../../../../api', () => ({
  api: {
    getLargeLosses: vi.fn(),
    getCatLosses: vi.fn(),
    getLossSelectionLatest: vi.fn(),
  },
}));

import { api } from '../../../../api';
import SeverityFitPanel from './SeverityFitPanel.jsx';

// 7 losses clear a 1,000,000 threshold once developed (paid+OS) and trended.
const LOSSES = [
  { paid: 800000, os: 400000, inflation_factor: 1.1, uw_year: 2018, is_selected: true },
  { paid: 1000000, os: 500000, inflation_factor: 1.1, uw_year: 2019, is_selected: true },
  { paid: 2000000, os: 0, inflation_factor: 1.2, uw_year: 2020, is_selected: true },
  { paid: 3000000, os: 1000000, inflation_factor: 1.0, uw_year: 2021, is_selected: true },
  { paid: 500000, os: 100000, inflation_factor: 1.0, uw_year: 2021, is_selected: true }, // below threshold
  { paid: 5000000, os: 0, inflation_factor: 1.0, uw_year: 2022, is_selected: true },
  { paid: 1500000, os: 500000, inflation_factor: 1.0, uw_year: 2022, is_selected: true },
  { paid: 2500000, os: 500000, inflation_factor: 1.0, uw_year: 2023, is_selected: true },
];

const structure = {
  layers: [{ id: 0, risk: true, cat: false, limit: '3000000', attachment: '2000000', egnpi: '50000000' }],
};

function renderPanel(over = {}) {
  const onFitChange = vi.fn();
  const props = {
    scopeKey: 'risk',
    structure,
    contractId: 'c1',
    isQuote: true,
    onFitChange,
    ...over,
  };
  return { ...render(<SeverityFitPanel {...props} />), onFitChange };
}

beforeEach(() => {
  api.getLargeLosses.mockResolvedValue({ losses: LOSSES });
  api.getCatLosses.mockResolvedValue({ losses: [] });
  api.getLossSelectionLatest.mockResolvedValue({ snapshot: { threshold: 1000000, observation_years: 10 } });
});

describe('SeverityFitPanel', () => {
  it('seeds the threshold from the snapshot and shows GPD params with CI + K-S', async () => {
    renderPanel();
    const thr = await screen.findByTestId('fq-severity-threshold-risk');
    expect(thr).toHaveValue('1000000');
    // GPD (default) → ξ and σ editable, both seeded from the fit (post-render effect).
    await waitFor(() => expect(screen.getByTestId('fq-severity-param-risk-xi').value).toMatch(/-?\d/));
    expect(screen.getByTestId('fq-severity-param-risk-sigma').value).toMatch(/\d/);
    expect(screen.getByTestId('fq-severity-ci-risk-xi')).toHaveTextContent('95% CI');
    // A K-S goodness-of-fit number is shown.
    await waitFor(() => expect(screen.getByTestId('fq-severity-ks-risk').textContent).toMatch(/\d/));
  });

  it('switching family to Pareto exposes the α parameter', async () => {
    renderPanel();
    const family = await screen.findByTestId('fq-severity-family-risk');
    expect(screen.queryByTestId('fq-severity-param-risk-alpha')).toBeNull();
    fireEvent.change(family, { target: { value: 'PARETO' } });
    expect(await screen.findByTestId('fq-severity-param-risk-alpha')).toBeInTheDocument();
  });

  it('publishes the fit (family/threshold/params) upward for the simulation', async () => {
    const { onFitChange } = renderPanel();
    await screen.findByTestId('fq-severity-threshold-risk');
    await waitFor(() => {
      const last = onFitChange.mock.calls.at(-1)?.[0];
      expect(last).toBeTruthy();
      expect(last.family).toBe('GPD');
      expect(last.threshold).toBe(1000000);
      expect(last.params).toBeTruthy();
      expect(Number.isFinite(last.params.sigma)).toBe(true);
    });
  });

  it('hydrates family/threshold from a saved sim config (reproducible reload)', async () => {
    renderPanel({ savedConfig: { family: 'PARETO', threshold: 2000000, params: { alpha: 1.8 } } });
    const thr = await screen.findByTestId('fq-severity-threshold-risk');
    expect(thr).toHaveValue('2000000');
    expect(screen.getByTestId('fq-severity-family-risk')).toHaveValue('PARETO');
    await waitFor(() => expect(screen.getByTestId('fq-severity-param-risk-alpha').value).toBe('1.8'));
  });

  it('shows an empty state when the scope has no losses', async () => {
    api.getLargeLosses.mockResolvedValue({ losses: [] });
    renderPanel();
    expect(await screen.findByTestId('fq-severity-empty-risk')).toBeInTheDocument();
  });

  it('cat scope reads cat losses and renders its own panel', async () => {
    api.getCatLosses.mockResolvedValue({ losses: LOSSES });
    renderPanel({ scopeKey: 'cat' });
    expect(await screen.findByTestId('fq-severity-panel-cat')).toBeInTheDocument();
    await waitFor(() => expect(api.getCatLosses).toHaveBeenCalled());
    const panel = within(screen.getByTestId('fq-severity-panel-cat'));
    expect(panel.getByTestId('fq-severity-threshold-cat')).toHaveValue('1000000');
  });
});
