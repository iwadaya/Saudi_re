// EqDamageRatioPanel.test.jsx
//
// The GEM EQ exposure panel loads the contract's CRESTA zones + curve
// catalogue, computes a ground-up EQ loss server-side, and applies the
// effective mean damage ratio (as a ROL%) into a chosen cat layer cell.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import EqDamageRatioPanel from './EqDamageRatioPanel.jsx';

const getGemScenario = vi.fn();
const getGemCurves = vi.fn();
const computeGemEqLoss = vi.fn();

vi.mock('../../../../api', () => ({
  api: {
    getGemScenario: (...a) => getGemScenario(...a),
    getGemCurves: (...a) => getGemCurves(...a),
    computeGemEqLoss: (...a) => computeGemEqLoss(...a),
  },
}));

// recharts' ResponsiveContainer needs a measured box in jsdom; stub the chart
// surface so the panel renders without a layout engine.
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass, BarChart: Pass, Bar: Pass,
    XAxis: Pass, YAxis: Pass, CartesianGrid: Pass, Tooltip: Pass,
  };
});

const catLayer = { layer: 1, cat: true, limit: '1000000', catExposure: '0.00%' };

function renderPanel(over = {}) {
  const updateLayer = vi.fn();
  const layers = [catLayer];
  const props = {
    contractId: 'c-1',
    layers,
    catLayers: layers.filter((l) => l.cat),
    updateLayer,
    currency: 'SAR',
    disabled: false,
    ...over,
  };
  return { updateLayer, ...render(<EqDamageRatioPanel {...props} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getGemScenario.mockResolvedValue({
    countryName: 'Saudi Arabia',
    zones: [{ zone_id: 'SA-01', zone_name: 'Riyadh', eq_agg: 1000000, commercial_bldg_pct: 100 }],
    scenario: null,
  });
  getGemCurves.mockResolvedValue({
    curves: [{ id: 7, taxonomy: 'CR/LDUAL/COM', loss_category: 'structural', occupancy: 'COM', imt: 'PGA', n_points: 20 }],
  });
  computeGemEqLoss.mockResolvedValue({
    groundUpEqLoss: 250000,
    totalEqAgg: 1000000,
    effectiveMdr: 0.25,
    byZone: [{ zoneId: 'SA-01', zoneName: 'Riyadh', eqAgg: 1000000, zoneLoss: 250000, byBucket: [] }],
    warnings: [],
  });
});

describe('EqDamageRatioPanel', () => {
  it('shows the empty-state when the contract has no CRESTA EQ exposure', async () => {
    getGemScenario.mockResolvedValueOnce({ countryName: 'Saudi Arabia', zones: [], scenario: null });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/No CRESTA earthquake exposure/i)).toBeInTheDocument());
  });

  it('computes and applies the effective damage ratio into the cat layer cell', async () => {
    const { updateLayer } = renderPanel();

    // Curve catalogue is scoped to the contract's country.
    await waitFor(() => expect(getGemCurves).toHaveBeenCalledWith({ country: 'Saudi Arabia' }));

    // Assign a curve to the commercial-building slot, then set its PGA intensity.
    const slotSelect = await screen.findByLabelText('Commercial — building');
    fireEvent.change(slotSelect, { target: { value: '7' } });
    const pga = await screen.findByLabelText('PGA');
    fireEvent.change(pga, { target: { value: '0.18' } });

    fireEvent.click(screen.getByRole('button', { name: /Compute EQ Loss/i }));

    // The Apply button (labelled with the effective ratio) appears once the
    // compute resolves and the result renders.
    const applyBtn = await screen.findByRole('button', { name: /Apply 25\.00%/i });
    expect(computeGemEqLoss).toHaveBeenCalledWith('c-1', {
      curveAssignments: { commercialBldg: '7' },
      intensities: { PGA: 0.18 },
      persist: false,
    });
    expect(screen.getByText('Ground-up EQ loss')).toBeInTheDocument();

    // Apply writes effectiveMdr as a ROL% into the selected cat layer cell.
    fireEvent.click(applyBtn);
    expect(updateLayer).toHaveBeenCalledWith(0, 'catExposure', '25.00%');
  });
});
