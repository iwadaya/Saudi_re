// CedantSummaryTabs.test.jsx — the Overview portfolio totals blend margins
// across PROP and NP rows. lookups.js cedant-summary now serves every margin
// as a FRACTION (NP whole-percent columns are divided by 100 server-side),
// and pctCell is a plain fraction formatter with no magnitude heuristic —
// so a PROP 0.09 @ 1M premium and an NP 0.15 @ 1M premium must blend to
// exactly 12.00%, and a thin NP margin must never render as 120.00%.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CedantSummaryTabs from './CedantSummaryTabs';

const getContract = vi.fn();
const getCedantSummary = vi.fn();
const getHomeSummary = vi.fn();
const getCedantNpLayers = vi.fn();

vi.mock('../../api', () => ({
  api: {
    getContract: (...a) => getContract(...a),
    getCedantSummary: (...a) => getCedantSummary(...a),
    getHomeSummary: (...a) => getHomeSummary(...a),
    getCedantNpLayers: (...a) => getCedantNpLayers(...a),
  },
  HttpError: class HttpError extends Error {},
}));
vi.mock('../../context/AppContext', () => ({
  useAppState: () => ({ state: {} }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getContract.mockResolvedValue({ header: { cedant_id: 'ced-1' } });
  getHomeSummary.mockResolvedValue({});
  getCedantNpLayers.mockResolvedValue({ layers: [] });
  getCedantSummary.mockResolvedValue([
    {
      contract_id: 'c-1', uw_year: 2025, status: 'SIGNED', entity_type: 'PROP',
      treaty_type: 'Quota Share', premium: 1000000, limit: 5000000,
      actuarial_margin: 0.09, actual_margin: 0.09,
    },
    {
      contract_id: 'c-2', uw_year: 2025, status: 'SIGNED', entity_type: 'NP',
      treaty_type: 'Cat XL', premium: 1000000, limit: 2000000,
      // Served as fractions by lookups.js (15% modelled, thin 1.2% actual).
      actuarial_margin: 0.15, actual_margin: 0.012,
    },
  ]);
});

describe('CedantSummaryTabs — Overview margins', () => {
  it('blends PROP and NP fraction margins premium-weighted (0.09@1M + 0.15@1M → 12.00%)', async () => {
    render(<CedantSummaryTabs contractId="c-1" currency="USD" mode="PROP" />);
    // Portfolio totals row: (0.09×1M + 0.15×1M) / 2M = 12.00%.
    expect(await screen.findByText('12.00%')).toBeInTheDocument();
    // Per-row margins render as plain fractions.
    expect(screen.getAllByText('9.00%').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('15.00%').length).toBeGreaterThanOrEqual(1);
  });

  it('renders a thin NP margin as-is — no magnitude heuristic blow-up', async () => {
    render(<CedantSummaryTabs contractId="c-1" currency="USD" mode="PROP" />);
    expect(await screen.findByText('1.20%')).toBeInTheDocument();
    expect(screen.queryByText('120.00%')).not.toBeInTheDocument();
  });
});
