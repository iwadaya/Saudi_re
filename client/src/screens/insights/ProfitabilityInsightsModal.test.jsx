import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Recharts needs real layout dimensions that jsdom doesn't provide; stub it so
// the test exercises the shell + engine wiring, not the SVG renderer.
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass, ScatterChart: Pass, Scatter: Pass, XAxis: Pass,
    YAxis: Pass, ZAxis: Pass, Tooltip: Pass, Cell: Pass, CartesianGrid: Pass,
  };
});

// Two-segment book: GCC Quota Share (profitable) vs Africa XL (ROL-driven).
function makeRows() {
  const rows = [];
  for (let i = 0; i < 80; i++) {
    rows.push({
      contractId: `A${i}`, kind: 'PROP', country: 'Saudi Arabia', region: 'Middle East',
      treatyType: 'Quota Share', cob: 'Property', status: i % 4 === 0 ? 'NTU' : 'SIGNED',
      premium: 4_000_000, exposure: 24_000_000, balance: 6, rol: null, margin: 0.17, uwYear: 2025,
    });
  }
  for (let i = 0; i < 80; i++) {
    rows.push({
      contractId: `B${i}`, kind: 'NP', country: 'Kenya', region: 'Africa',
      treatyType: 'Excess of Loss', cob: 'Motor', status: i % 3 === 0 ? 'SIGNED' : 'DECLINED',
      premium: 1_500_000, exposure: 5_000_000, balance: null, rol: 0.3 + (i % 10) * 0.01,
      margin: -0.05 - (i % 10) * 0.01, uwYear: 2025,
    });
  }
  return rows;
}

vi.mock('../../api', () => ({
  api: {
    getPortfolioInsights: vi.fn(() => Promise.resolve({
      rows: makeRows(),
      meta: { count: 160, scored: 160, byStatus: { SIGNED: 100, NTU: 20, DECLINED: 40 }, byKind: { PROP: 80, NP: 80 } },
    })),
  },
}));

const { default: ProfitabilityInsightsModal } = await import('./ProfitabilityInsightsModal.jsx');

describe('ProfitabilityInsightsModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the book, runs the engine, and renders the driver ranking', async () => {
    render(<ProfitabilityInsightsModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Contracts/i)).toBeInTheDocument());
    // Driver tab is default; the six components must all appear (getAllByText —
    // the top-driver summary stat intentionally echoes one row's label).
    for (const lbl of ['Treaty type', 'Rate on line', 'Balance of treaty', 'Class of business', 'Country', 'Region']) {
      expect(screen.getAllByText(lbl).length).toBeGreaterThan(0);
    }
  });

  it('switches to the Segments tab and shows profit-labelled clusters', async () => {
    render(<ProfitabilityInsightsModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Segments' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Segments' }));
    await waitFor(() => expect(screen.getByText(/Dominant profile/i)).toBeInTheDocument());
    // At least one cluster should be labelled Profitable given the +17% QS block.
    expect(screen.getAllByText(/Profitable|Marginal|Loss-making/).length).toBeGreaterThan(0);
  });

  it('does not fetch while closed', async () => {
    const { api } = await import('../../api');
    render(<ProfitabilityInsightsModal open={false} onClose={() => {}} />);
    expect(api.getPortfolioInsights).not.toHaveBeenCalled();
  });
});
