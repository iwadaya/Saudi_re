// NpInsightModal.test.jsx — the "GEM" insight opens the EQ damage-ratio panel
// and wires its apply callback to the cat burning-cost setter.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import NpInsightModal from './NpInsightModal.jsx';

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
// The modal statically imports several heavy embed screens; only the GEM
// branch is exercised here, so stub the rest to keep the test light.
vi.mock('../../../shared/LossSelectionScreen', () => ({ default: () => null }));
vi.mock('../../../shared/ProfileScreen', () => ({ default: () => null }));
vi.mock('../../cresta_zones/NpCrestaAggregates', () => ({ default: () => null }));
vi.mock('../NpMarketAnalysis', () => ({ default: () => null }));
vi.mock('./NpChecklistPanel.jsx', () => ({ default: () => null }));
vi.mock('../../../../components/cedant/CedantSummaryTabs', () => ({ default: () => null }));
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return { ResponsiveContainer: Pass, BarChart: Pass, Bar: Pass, XAxis: Pass, YAxis: Pass, CartesianGrid: Pass, Tooltip: Pass };
});

function makePricing(over = {}) {
  return {
    insightKey: 'GEM',
    setInsightOpen: vi.fn(),
    layers: [{ layer: 1, risk: true }, { layer: 2, cat: true, catPureBurn: '0.00%' }],
    updateLayer: vi.fn(),
    treatyMetrics: {}, quotePricing: {}, portfolioTreaties: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getGemScenario.mockResolvedValue({
    countryName: 'South Africa',
    zones: [{ zone_id: 'ZA-01', zone_name: 'Cape Town', eq_agg: 1000000, commercial_bldg_pct: 100 }],
    scenario: null,
  });
  getGemCurves.mockResolvedValue({
    curves: [{ id: 7, taxonomy: 'CR/LDUAL/COM', loss_category: 'structural', occupancy: 'COM', imt: 'PGA', n_points: 20 }],
  });
  computeGemEqLoss.mockResolvedValue({
    groundUpEqLoss: 250000, totalEqAgg: 1000000, effectiveMdr: 0.25,
    byZone: [{ zoneId: 'ZA-01', zoneName: 'Cape Town', eqAgg: 1000000, zoneLoss: 250000, byBucket: [] }],
    warnings: [],
  });
});

describe('NpInsightModal — GEM insight', () => {
  it('renders the EQ damage-ratio panel under a GEM title', async () => {
    render(<NpInsightModal pricing={makePricing()} open contractId="c-1" isQuote={false} currency="SAR" npDetail={{}} />);
    expect(screen.getByText('GEM EQ Damage Ratios')).toBeInTheDocument();
    expect(await screen.findByText('EQ Damage Ratios')).toBeInTheDocument();
    await waitFor(() => expect(getGemScenario).toHaveBeenCalledWith('c-1'));
  });

  it('applies the ground-up EQ loss to the first cat layer burning cost', async () => {
    const updateLayer = vi.fn();
    render(<NpInsightModal pricing={makePricing({ updateLayer })} open contractId="c-1" isQuote={false} currency="SAR" npDetail={{}} />);

    const pga = await screen.findByLabelText('PGA');
    fireEvent.change(pga, { target: { value: '0.18' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate/i }));

    const applyBtn = await screen.findByRole('button', { name: /Apply to cat burning cost/i });
    fireEvent.click(applyBtn);

    // Cat layer is the 2nd entry (index 1); value is the ground-up EQ loss.
    await waitFor(() => expect(updateLayer).toHaveBeenCalledWith(1, 'catPureBurn', 250000));
  });
});
