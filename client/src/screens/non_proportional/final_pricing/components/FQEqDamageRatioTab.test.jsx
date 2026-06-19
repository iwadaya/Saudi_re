// FQEqDamageRatioTab.test.jsx — the "EQ Damage Ratios" tab adapter gates on cat
// relevance and wires the panel's onApplyToCat to updateClientStructureLayer.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import FQEqDamageRatioTab from './FQEqDamageRatioTab.jsx';

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
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass, BarChart: Pass, Bar: Pass,
    XAxis: Pass, YAxis: Pass, CartesianGrid: Pass, Tooltip: Pass,
  };
});

// A structure whose 2nd layer is the cat-covering one.
const structure = {
  layers: [
    { layer: 1, risk: true, cat: false },
    { layer: 2, cat: true, catExposure: '0.00%' },
  ],
};

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
    groundUpEqLoss: 250000, totalEqAgg: 1000000, effectiveMdr: 0.25,
    byZone: [{ zoneId: 'SA-01', zoneName: 'Riyadh', eqAgg: 1000000, zoneLoss: 250000, byBucket: [] }],
    warnings: [],
  });
});

describe('FQEqDamageRatioTab', () => {
  it('shows a one-line hint when the structure has no cat cover', () => {
    render(<FQEqDamageRatioTab structure={{ layers: [{ layer: 1, risk: true }] }} sIdx={0} contractId="c-1" currency="SAR" catDisabled updateClientStructureLayer={vi.fn()} />);
    expect(screen.getByText(/Add a cat-covering layer/i)).toBeInTheDocument();
    expect(getGemScenario).not.toHaveBeenCalled();
  });

  it('writes the ground-up EQ loss into the structure cat layer burning cost', async () => {
    const updateClientStructureLayer = vi.fn();
    render(<FQEqDamageRatioTab structure={structure} sIdx={3} contractId="c-1" currency="SAR" catDisabled={false} updateClientStructureLayer={updateClientStructureLayer} />);

    const pga = await screen.findByLabelText('PGA');
    fireEvent.change(pga, { target: { value: '0.18' } });
    // Calculate is disabled until the per-slot curve lists finish loading.
    const calc = screen.getByRole('button', { name: /Calculate/i });
    await waitFor(() => expect(calc).toBeEnabled());
    fireEvent.click(calc);

    const applyBtn = await screen.findByRole('button', { name: /Apply to cat burning cost/i });
    fireEvent.click(applyBtn);

    // First cat layer → the 2nd structure layer (lIdx 1); sIdx is threaded through,
    // value is the ground-up EQ loss written to catPureBurn.
    await waitFor(() => expect(updateClientStructureLayer).toHaveBeenCalledWith(3, 1, 'catPureBurn', 250000));
  });
});
